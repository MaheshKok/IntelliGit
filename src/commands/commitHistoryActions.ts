import * as vscode from "vscode";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress, showTimedInformationMessage } from "../utils/notifications";
import {
    getCommitParentHashes,
    getUndoCommitCount,
    isCommitUnpushed,
    isHashMatch,
    isMergeCommitHash,
} from "../services/gitHelpers";
import { isLowerCaseFullObjectId } from "../git/interactiveRebase/objectId";
import { evaluateInteractiveRebaseGuards } from "../git/interactiveRebase/guards";
import {
    loadInteractiveRebaseRange,
    MAX_INTERACTIVE_REBASE_RANGE_COMMITS,
} from "../git/interactiveRebase/range";
import type {
    InteractiveRebaseGuardRejectionReason,
    InteractiveRebaseRangeRejectionReason,
} from "../git/interactiveRebase/types";
import type { CommitActionContext } from "./commitActionContext";

/**
 * Soft-resets unpushed commits through the selected commit back into the index.
 *
 * The command is allowed only for non-merge commits reachable from the current branch. It leaves the
 * working tree intact, moves `HEAD` to the selected commit's parent, keeps the undone changes staged,
 * shows Git failures in VS Code, and refreshes views after the reset attempt.
 */
export async function undoCommit(ctx: CommitActionContext): Promise<void> {
    if (
        !(await ensureUnpushed(
            ctx,
            vscode.l10n.t("Undo Commit is available only for unpushed commits."),
        ))
    ) {
        return;
    }
    if (
        await rejectMergeCommit(
            ctx,
            vscode.l10n.t("Undo Commit is not available for merge commits."),
        )
    )
        return;
    if (!(await ensureInCurrentBranchHistory(ctx))) return;

    const undoParents = await getCommitParentHashes(ctx.validatedHash, ctx.executor);
    if (undoParents.length === 0) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Cannot undo the initial commit of the repository."),
        );
        return;
    }
    const undoCount = await getUndoCommitCount(ctx.validatedHash, ctx.executor);
    const undoLabel = vscode.l10n.t("Undo");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Undo {count} commit(s) up to {short} (soft reset)?", {
            count: undoCount,
            short: ctx.short,
        }),
        { modal: true },
        undoLabel,
    );
    if (confirm !== undoLabel) return;
    try {
        await ctx.executor.run(["reset", "--soft", `${ctx.validatedHash}^`]);
        showTimedInformationMessage(
            vscode.l10n.t("Undid {count} commit(s) up to {short}.", {
                count: undoCount,
                short: ctx.short,
            }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(vscode.l10n.t("Undo Commit failed: {message}", { message }));
    } finally {
        await ctx.refreshAll();
    }
}

/**
 * Edits the message for an unpushed non-merge commit from the commit graph menu.
 *
 * When the selected commit is `HEAD`, the handler amends it after a VS Code input prompt and refreshes
 * views. Older commits open an interactive rebase terminal and leave refresh/recovery to the user-run
 * rebase process; guard failures are shown as VS Code errors.
 */
export async function editCommitMessage(ctx: CommitActionContext): Promise<void> {
    if (
        !(await ensureUnpushed(
            ctx,
            vscode.l10n.t("Edit Commit Message is available only for unpushed commits."),
        ))
    ) {
        return;
    }
    if (
        await rejectMergeCommit(
            ctx,
            vscode.l10n.t("Edit Commit Message is not available for merge commits."),
        )
    )
        return;

    const headHash = (await ctx.executor.run(["rev-parse", "HEAD"])).trim();
    if (isHashMatch(ctx.validatedHash, headHash)) {
        await amendHeadCommitMessage(ctx);
        return;
    }

    if (!(await ensureInCurrentBranchHistory(ctx))) return;
    const rewordParents = await getCommitParentHashes(ctx.validatedHash, ctx.executor);
    if (rewordParents.length === 0) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Edit Commit Message is not available for the initial commit."),
        );
        return;
    }
    openInteractiveRebaseTerminal(
        ctx,
        "IntelliGit Reword Commit",
        vscode.l10n.t("Interactive rebase opened. Mark the commit as 'reword' in the todo list."),
    );
}

/**
 * Squashes an unpushed commit range from the selected commit through `HEAD` into one commit.
 *
 * The handler requires a non-merge selected commit, a non-merge range, and all commits in range to be
 * unpushed. After the message and confirmation prompts, it automatically preserves a dirty working
 * tree, performs a soft reset plus commit, restores preserved changes, and refreshes views.
 */
export async function squashCommits(ctx: CommitActionContext): Promise<void> {
    if (
        !(await ensureUnpushed(
            ctx,
            vscode.l10n.t("Squash Commits is available only for unpushed commits."),
        ))
    ) {
        return;
    }
    if (
        await rejectMergeCommit(
            ctx,
            vscode.l10n.t("Squash Commits is not available for merge commits."),
        )
    )
        return;
    if (!(await ensureInCurrentBranchHistory(ctx))) return;

    const squashParents = await getCommitParentHashes(ctx.validatedHash, ctx.executor);
    if (squashParents.length === 0) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Squash Commits is not available for the initial commit."),
        );
        return;
    }

    let expectedHead: string;
    try {
        expectedHead = (await ctx.executor.run(["rev-parse", "HEAD"])).trim();
    } catch {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Squash Commits could not resolve the current HEAD."),
        );
        return;
    }
    if (!isLowerCaseFullObjectId(expectedHead)) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Squash Commits received an invalid HEAD object ID."),
        );
        return;
    }

    const range = `${ctx.validatedHash}^..${expectedHead}`;
    const rangeLines = await getCommitRangeLines(ctx, range);
    const rangeHashes = rangeLines.map((line) => line.split(/\s+/)[0]);
    if (!validateSquashRange(rangeLines, rangeHashes)) return;
    if (!(await ensureRangeCommitsUnpushed(ctx, rangeHashes))) return;

    const squashMessage = await promptSquashMessage(ctx, range, rangeHashes.length);
    if (!squashMessage) return;

    const squashLabel = vscode.l10n.t("Squash");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Squash {count} commits from {short} through HEAD into one commit?", {
            count: rangeHashes.length,
            short: ctx.short,
        }),
        { modal: true },
        squashLabel,
    );
    if (confirm !== squashLabel) return;

    await performSquash(ctx, rangeHashes.length, squashMessage, expectedHead);
}

/**
 * Removes an unpushed non-merge commit from the current branch history with rebase.
 *
 * The selected commit must be reachable from `HEAD` and cannot be the initial commit. A confirmed drop
 * rewrites branch history with `git rebase --onto`; failures are surfaced with recovery guidance and
 * views refresh after the rebase attempt.
 */
export async function dropCommit(ctx: CommitActionContext): Promise<void> {
    if (
        !(await ensureUnpushed(
            ctx,
            vscode.l10n.t("Drop Commit is available only for unpushed commits."),
        ))
    )
        return;
    if (
        await rejectMergeCommit(
            ctx,
            vscode.l10n.t("Drop Commit is not available for merge commits."),
        )
    )
        return;
    if (!(await ensureInCurrentBranchHistory(ctx))) return;

    const dropParents = await getCommitParentHashes(ctx.validatedHash, ctx.executor);
    if (dropParents.length === 0) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Cannot drop the initial commit of the repository."),
        );
        return;
    }
    const dropLabel = vscode.l10n.t("Drop");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Drop commit {short} from current branch history?", { short: ctx.short }),
        { modal: true },
        dropLabel,
    );
    if (confirm !== dropLabel) return;
    try {
        await ctx.executor.run([
            "rebase",
            "--onto",
            `${ctx.validatedHash}^`,
            ctx.validatedHash,
            "HEAD",
        ]);
        showTimedInformationMessage(
            vscode.l10n.t("Dropped {short} from history.", { short: ctx.short }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t(
                "Failed to drop commit: {message}. Run 'git rebase --abort' to recover.",
                { message },
            ),
        );
    } finally {
        await ctx.refreshAll();
    }
}

/**
 * Opens an origin-bound dialog for an interactive rebase starting at the selected commit.
 *
 * Guards and bounded range loading run before a frozen, one-shot host request is registered. Pushed
 * commits remain eligible because the dialog receives explicit per-commit pushedness for its warning.
 */
export async function interactiveRebaseFromHere(ctx: CommitActionContext): Promise<void> {
    const guardResult = await evaluateInteractiveRebaseGuards({
        executor: ctx.executor,
        selectedHash: ctx.validatedHash,
        hasWholeIndexOperationInProgress: () => ctx.gitOps.hasWholeIndexOperationInProgress(),
    });
    if (guardResult.status === "rejected") {
        showInteractiveRebaseGuardRejection(guardResult.reason);
        return;
    }

    let baseHash: string;
    try {
        const parentHash = (
            await ctx.executor.run([
                "rev-parse",
                "--verify",
                "--end-of-options",
                `${ctx.validatedHash}^`,
            ])
        ).trim();
        if (!isLowerCaseFullObjectId(parentHash)) throw new Error("invalid parent object ID");
        baseHash = parentHash;
    } catch {
        showInteractiveRebaseGuardRejection("git-error");
        return;
    }

    const tip = await resolveInteractiveRebaseTip(ctx);
    if (!tip) return;
    const { expectedHead, expectedBranch } = tip;

    const rangeResult = await loadInteractiveRebaseRange(
        ctx.executor,
        ctx.validatedHash,
        expectedHead,
    );
    if (rangeResult.status === "rejected") {
        showInteractiveRebaseRangeRejection(rangeResult.reason);
        return;
    }

    // The range is pinned to `expectedHead`, so a branch that moved during the load would leave the
    // dialog offering commits that are no longer the tip while `expectedHead` still satisfied the
    // submission-time equality re-check. Re-reading both is what turns that into a visible refusal.
    const confirmedTip = await resolveInteractiveRebaseTip(ctx);
    if (!confirmedTip) return;
    if (
        confirmedTip.expectedHead !== expectedHead ||
        confirmedTip.expectedBranch !== expectedBranch
    ) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("The branch moved while the rebase range was loading. Try again."),
        );
        return;
    }

    const requestId = ctx.pendingRebaseDialogRequests.register({
        originProvider: ctx.originProvider,
        repoRoot: ctx.repoRoot,
        baseHash,
        rangeHashes: rangeResult.commits.map((commit) => commit.hash),
        hasPushedCommit: rangeResult.commits.some((commit) => commit.isPushed),
        expectedHead,
        expectedBranch,
    });
    const delivered = await ctx.postRebaseDialog({
        type: "showRebaseDialog",
        requestId,
        commits: rangeResult.commits,
        branch: expectedBranch,
        hasPushed: rangeResult.commits.some((commit) => commit.isPushed),
    });
    if (!delivered) {
        // The originating view was closed while the range loaded. Retract the request instead of
        // leaving it to occupy this origin's single slot until it times out.
        ctx.pendingRebaseDialogRequests.cancel(requestId);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Interactive Rebase from Here could not open its dialog."),
        );
    }
}

/**
 * Reads the branch tip the request will be pinned to, reporting its own failures.
 *
 * Returning `undefined` means the caller has already shown an error and must stop. Both reads are
 * taken together so the pair is always from the same observation of the repository.
 */
async function resolveInteractiveRebaseTip(
    ctx: CommitActionContext,
): Promise<{ expectedHead: string; expectedBranch: string } | undefined> {
    let expectedBranch: string;
    try {
        expectedBranch = (await ctx.executor.run(["symbolic-ref", "--quiet", "HEAD"])).trim();
    } catch {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Interactive Rebase from Here could not resolve the current branch."),
        );
        return undefined;
    }
    try {
        const expectedHead = (await ctx.executor.run(["rev-parse", "HEAD"])).trim();
        return { expectedHead, expectedBranch };
    } catch {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Interactive Rebase from Here could not resolve the current HEAD."),
        );
        return undefined;
    }
}

/**
 * Maps each host-side eligibility guard rejection to the message carrying its remediation.
 *
 * Keying a `Record` by the reason union makes a newly added reason a compile-time error at this
 * table, which is what the previous `switch` bought at runtime through an `assertNever` default.
 * Both reason unions are produced host-side (`guards.ts`, `range.ts`) and never crossed a webview
 * boundary, so there is no unvalidated value left for a runtime default to catch.
 *
 * The messages are thunks because `vscode.l10n.t` resolves against the active bundle when it is
 * called, and this table is built at module load.
 */
const INTERACTIVE_REBASE_GUARD_REJECTION_MESSAGES: Record<
    InteractiveRebaseGuardRejectionReason,
    () => string
> = {
    "invalid-selected-hash": () =>
        vscode.l10n.t("Interactive Rebase from Here received an invalid selected commit."),
    "operation-in-progress": () =>
        vscode.l10n.t(
            "Interactive Rebase from Here cannot start while another Git operation is in progress.",
        ),
    "detached-head": () =>
        vscode.l10n.t("Interactive Rebase from Here requires a checked-out branch."),
    "selected-merge-commit": () =>
        vscode.l10n.t("Interactive Rebase from Here is not available for merge commits."),
    "commit-not-ancestor": () =>
        vscode.l10n.t("The selected commit is not in the current branch history."),
    "initial-commit": () =>
        vscode.l10n.t("Interactive Rebase from Here is not available for the initial commit."),
    "working-tree-dirty": () =>
        vscode.l10n.t("Interactive Rebase from Here requires a clean working tree."),
    "range-contains-merge-commit": () =>
        vscode.l10n.t(
            "Interactive Rebase from Here is not available for ranges containing merge commits.",
        ),
    "git-error": () =>
        vscode.l10n.t("Interactive Rebase from Here could not inspect the repository."),
};

/** Shows the specific failed host-side eligibility guard without losing its remediation. */
function showInteractiveRebaseGuardRejection(reason: InteractiveRebaseGuardRejectionReason): void {
    vscode.window.showErrorMessage(INTERACTIVE_REBASE_GUARD_REJECTION_MESSAGES[reason]());
}

/** Maps each bounded-range load rejection to its message. Thunked for the reason above. */
const INTERACTIVE_REBASE_RANGE_REJECTION_MESSAGES: Record<
    InteractiveRebaseRangeRejectionReason,
    () => string
> = {
    "invalid-base-hash": () =>
        vscode.l10n.t("Interactive Rebase from Here received an invalid selected commit."),
    "invalid-head-hash": () =>
        vscode.l10n.t("Interactive Rebase from Here could not resolve the current HEAD."),
    "range-too-large": () =>
        vscode.l10n.t("Interactive Rebase from Here supports at most {count} commits at once.", {
            count: MAX_INTERACTIVE_REBASE_RANGE_COMMITS,
        }),
    "invalid-range-count": () =>
        vscode.l10n.t("Interactive Rebase from Here could not count the selected range."),
    "empty-range": () => vscode.l10n.t("Interactive Rebase from Here found no commits to rebase."),
    "output-truncated": () =>
        vscode.l10n.t("Interactive Rebase from Here could not safely load the selected range."),
    "missing-trailing-sentinel": () =>
        vscode.l10n.t("Interactive Rebase from Here received incomplete range output."),
    "malformed-arity": () =>
        vscode.l10n.t("Interactive Rebase from Here received malformed range output."),
    "count-mismatch": () =>
        vscode.l10n.t("Interactive Rebase from Here received an inconsistent commit range."),
    "git-error": () =>
        vscode.l10n.t("Interactive Rebase from Here could not load the selected range."),
};

/** Shows the specific bounded-range failure before any dialog request is registered. */
function showInteractiveRebaseRangeRejection(reason: InteractiveRebaseRangeRejectionReason): void {
    vscode.window.showErrorMessage(INTERACTIVE_REBASE_RANGE_REJECTION_MESSAGES[reason]());
}

/**
 * Gates history-rewriting actions to commits IntelliGit still considers unpublished.
 *
 * Published commits are rejected with the caller-provided VS Code message instead of throwing, so
 * command handlers can stop before rewriting shared history.
 */
async function ensureUnpushed(ctx: CommitActionContext, message: string): Promise<boolean> {
    if (await isCommitUnpushed(ctx.validatedHash, ctx.gitOps)) return true;
    vscode.window.showErrorMessage(message);
    return false;
}

/**
 * Rejects merge commits for actions implemented with single-parent history rewriting.
 *
 * The `true` return value means the command has already displayed the supplied error and should
 * abort without running Git.
 */
async function rejectMergeCommit(ctx: CommitActionContext, message: string): Promise<boolean> {
    if (!(await isMergeCommitHash(ctx.validatedHash, ctx.executor))) return false;
    vscode.window.showErrorMessage(message);
    return true;
}

/**
 * Verifies the selected commit is an ancestor of `HEAD` before rewriting current branch history.
 *
 * The Git exit status is converted to a user-facing error rather than propagated, keeping menu
 * handlers no-op safe for stale or cross-branch commit graph selections.
 */
async function ensureInCurrentBranchHistory(ctx: CommitActionContext): Promise<boolean> {
    try {
        await ctx.executor.run(["merge-base", "--is-ancestor", ctx.validatedHash, "HEAD"]);
        return true;
    } catch {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Commit {short} is not in the current branch history.", {
                short: ctx.short,
            }),
        );
        return false;
    }
}

/**
 * Prompts for a replacement `HEAD` commit message and amends the current commit.
 *
 * This path rewrites only the tip commit, catches amend failures for VS Code UI, and refreshes views
 * after the amend attempt.
 */
async function amendHeadCommitMessage(ctx: CommitActionContext): Promise<void> {
    const currentMessage = (await ctx.executor.run(["log", "-1", "--format=%B"])).trim();
    const nextMessage = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Edit commit message"),
        value: currentMessage,
    });
    if (!nextMessage) return;
    try {
        await ctx.executor.run(["commit", "--amend", "-m", nextMessage]);
        showTimedInformationMessage(vscode.l10n.t("Commit message updated."));
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Commit message update failed: {message}", { message }),
        );
    } finally {
        await ctx.refreshAll();
    }
}

/**
 * Opens a repository-scoped integrated terminal for an interactive rebase session.
 *
 * The terminal starts with the configured `shellPath` and `shellArgs`; IntelliGit does not send
 * rebase text, observe completion, or refresh views after the user-controlled session finishes.
 * The rebase command must be run by the user in that terminal.
 */
function openInteractiveRebaseTerminal(
    ctx: CommitActionContext,
    name: string,
    successMessage: string,
): void {
    const terminal = vscode.window.createTerminal({
        name,
        cwd: ctx.repoRoot,
        shellPath: "git",
        shellArgs: ["rebase", "-i", `${ctx.validatedHash}^`],
    });
    terminal.show();
    showTimedInformationMessage(successMessage);
}

/**
 * Reads the selected squash range in oldest-to-newest order with parent metadata preserved.
 *
 * Callers depend on the parent count in each line to reject merge commits before rewriting history.
 */
async function getCommitRangeLines(ctx: CommitActionContext, range: string): Promise<string[]> {
    // Commit range output is small command text; map/filter preserves parsing clarity.
    // react-doctor-disable-next-line react-doctor/js-flatmap-filter
    return (await ctx.executor.run(["rev-list", "--reverse", "--parents", range]))
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Validates that a squash range is large enough and contains only single-parent commits.
 *
 * Failures are shown through VS Code UI and returned as `false`, preventing a destructive reset from
 * starting on unsupported history shapes.
 */
function validateSquashRange(rangeLines: string[], rangeHashes: string[]): boolean {
    if (rangeHashes.length < 2) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Squash Commits requires at least two commits in the selected range."),
        );
        return false;
    }
    if (rangeLines.some((line) => line.split(/\s+/).length > 2)) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Squash Commits is not available for ranges containing merge commits."),
        );
        return false;
    }
    return true;
}

/**
 * Ensures every commit that would be squashed is still unpublished.
 *
 * The check compares abbreviated or full hashes with `isHashMatch`; a single published commit stops
 * the rewrite and shows a VS Code error.
 */
async function ensureRangeCommitsUnpushed(
    ctx: CommitActionContext,
    rangeHashes: string[],
): Promise<boolean> {
    const unpushed = await ctx.gitOps.getUnpushedCommitHashes();
    const allRangeCommitsUnpushed = rangeHashes.every((rangeHash) =>
        unpushed.some((unpushedHash) => isHashMatch(unpushedHash, rangeHash)),
    );
    if (allRangeCommitsUnpushed) return true;
    vscode.window.showErrorMessage(
        vscode.l10n.t(
            "Squash Commits is available only when every commit in the selected range is unpushed.",
        ),
    );
    return false;
}

/**
 * Builds the default squash message from the selected range and prompts for the final message.
 *
 * Subject lines are joined oldest-to-newest so the single-line input preserves an editable summary
 * of every commit that will be replaced by the squash.
 */
async function promptSquashMessage(
    ctx: CommitActionContext,
    range: string,
    count: number,
): Promise<string | undefined> {
    const defaultMessage = (await ctx.executor.run(["log", "--reverse", "--format=%s", range]))
        .trim()
        .split("\n")
        .map((subject) => subject.trim())
        .filter(Boolean)
        .join("; ");
    return vscode.window.showInputBox({
        prompt: vscode.l10n.t("Squashed commit message for {count} commits", { count }),
        value: defaultMessage || vscode.l10n.t("Squash {count} commits", { count }),
    });
}

/**
 * Performs the destructive squash sequence after all guards and confirmations have passed.
 *
 * The function rechecks dirty state after confirmation, stashes tracked and untracked changes when
 * needed, verifies the pinned `HEAD`, soft-resets to the selected commit's parent, and commits the
 * staged result. A successful squash is reported only after the exact automatic stash is restored.
 */
async function performSquash(
    ctx: CommitActionContext,
    count: number,
    squashMessage: string,
    expectedHead: string,
): Promise<void> {
    try {
        const rawCommonDir = await runSquashGit(ctx, ["rev-parse", "--git-common-dir"]);
        const commonDir = ctx.mutationGate.resolveCommonDir(ctx.repoRoot, rawCommonDir);
        await ctx.mutationGate.run(ctx.repoRoot, commonDir, async () => {
            let automaticStashOid: string | undefined;
            let softResetApplied = false;
            let squashSucceeded = false;
            try {
                const status = (await runSquashGit(ctx, ["status", "--porcelain"])).trim();
                if (status) {
                    automaticStashOid = await createAutomaticSquashStash(ctx);
                    if ((await runSquashGit(ctx, ["status", "--porcelain"])).trim()) {
                        throw new Error(
                            vscode.l10n.t(
                                "Automatic stash {stashOid} did not leave a clean working tree.",
                                { stashOid: automaticStashOid },
                            ),
                        );
                    }
                }

                await runWithNotificationProgress(
                    vscode.l10n.t("Squashing {count} commits...", { count }),
                    async () => {
                        const currentHead = (await runSquashGit(ctx, ["rev-parse", "HEAD"])).trim();
                        if (currentHead !== expectedHead) {
                            throw new Error(
                                vscode.l10n.t("HEAD moved before Squash Commits could reset it."),
                            );
                        }
                        await runSquashGit(ctx, ["reset", "--soft", `${ctx.validatedHash}^`]);
                        softResetApplied = true;
                        await runSquashGit(ctx, ["commit", "-m", squashMessage]);
                    },
                );
                squashSucceeded = true;
                if (automaticStashOid) {
                    const cleanupError = await restoreAutomaticSquashStash(ctx, automaticStashOid);
                    if (cleanupError) {
                        vscode.window.showErrorMessage(
                            vscode.l10n.t(
                                "Squash succeeded and local changes were restored, but automatic stash cleanup failed ({message}); the {stashOid} backup was retained.",
                                { message: cleanupError, stashOid: automaticStashOid },
                            ),
                        );
                        return;
                    }
                }
                showTimedInformationMessage(
                    vscode.l10n.t("Squashed {count} commits into one commit.", { count }),
                );
            } catch (err) {
                if (squashSucceeded && automaticStashOid) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t(
                            "Squash succeeded, but local changes could not be restored ({message}). Automatic stash {stashOid} was retained for recovery.",
                            { message: getErrorMessage(err), stashOid: automaticStashOid },
                        ),
                    );
                } else {
                    await showSquashError(
                        ctx,
                        err,
                        softResetApplied,
                        expectedHead,
                        automaticStashOid,
                    );
                }
            }
        });
    } catch (err) {
        await showSquashError(ctx, err, false, expectedHead);
    } finally {
        await ctx.refreshAll();
    }
}

/** Runs one Git command without re-entering the executor's per-command mutation gate. */
async function runSquashGit(ctx: CommitActionContext, args: string[]): Promise<string> {
    return (await ctx.executor.runBinary(args)).stdout.toString("utf8");
}

/**
 * Preserves all tracked and untracked local changes in a newly verified stash entry.
 *
 * The previous stash tip prevents a no-op `stash push` from being mistaken for a new recovery point.
 * The caller assigns the returned OID before checking cleanliness so that failure can still restore it.
 */
async function createAutomaticSquashStash(ctx: CommitActionContext): Promise<string> {
    const previousOid = await readCurrentStashOid(ctx);
    await runSquashGit(ctx, [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        vscode.l10n.t("IntelliGit automatic squash stash"),
    ]);
    const oid = await readCurrentStashOid(ctx);
    if (!oid || oid === previousOid) {
        throw new Error(vscode.l10n.t("The automatic stash could not be verified."));
    }
    return oid;
}

/** Reads and validates the immutable object ID currently at `refs/stash`, if that ref exists. */
async function readCurrentStashOid(ctx: CommitActionContext): Promise<string | undefined> {
    let oid: string;
    try {
        oid = (
            await runSquashGit(ctx, ["rev-parse", "--verify", "--quiet", "refs/stash^{commit}"])
        ).trim();
    } catch {
        return undefined;
    }
    if (!isLowerCaseFullObjectId(oid)) {
        throw new Error(vscode.l10n.t("Git returned an invalid stash object ID."));
    }
    return oid;
}

/**
 * Applies the immutable stash object with its index, then drops its reverified current reflog entry.
 *
 * Apply failures throw without cleanup. Cleanup failures are returned after a successful apply so
 * callers can report that local changes are restored and must not attempt to apply them again.
 */
async function restoreAutomaticSquashStash(
    ctx: CommitActionContext,
    stashOid: string,
): Promise<string | undefined> {
    await runSquashGit(ctx, ["stash", "apply", "--index", stashOid]);
    try {
        const stashList = await runSquashGit(ctx, ["stash", "list", "--format=%H%x09%gd"]);
        const matchingLine = stashList.split("\n").find((line) => line.startsWith(`${stashOid}\t`));
        const stashRef = matchingLine?.slice(stashOid.length + 1);
        if (!stashRef || !/^stash@\{\d+\}$/.test(stashRef)) {
            throw new Error(
                vscode.l10n.t("Automatic stash {stashOid} was not found in the stash list.", {
                    stashOid,
                }),
            );
        }
        const verifiedOid = (
            await runSquashGit(ctx, ["rev-parse", "--verify", "--quiet", `${stashRef}^{commit}`])
        ).trim();
        if (verifiedOid !== stashOid) {
            throw new Error(
                vscode.l10n.t("Automatic stash reference {stashRef} moved before cleanup.", {
                    stashRef,
                }),
            );
        }
        await runSquashGit(ctx, ["stash", "drop", stashRef]);
        return undefined;
    } catch (err) {
        return getErrorMessage(err);
    }
}

/**
 * Reports squash failures and attempts rollback when the soft reset already changed state.
 *
 * Rollback failures are appended to the user-facing error so maintainers do not lose the original
 * Git failure. An automatic stash is restored only after a successful rollback; otherwise its stable
 * object ID is shown for manual recovery without applying changes onto an unknown repository state.
 */
async function showSquashError(
    ctx: CommitActionContext,
    err: unknown,
    softResetApplied: boolean,
    originalHead: string,
    automaticStashOid?: string,
): Promise<void> {
    let message = getErrorMessage(err);
    let rollbackSucceeded = !softResetApplied;
    if (softResetApplied && originalHead) {
        try {
            await runSquashGit(ctx, ["reset", "--hard", originalHead]);
            rollbackSucceeded = true;
        } catch (rollbackErr) {
            message = vscode.l10n.t("{message}; rollback to {head} failed: {rollbackMessage}", {
                message,
                head: originalHead.slice(0, 8),
                rollbackMessage: getErrorMessage(rollbackErr),
            });
        }
    }
    if (automaticStashOid) {
        if (rollbackSucceeded) {
            try {
                const cleanupError = await restoreAutomaticSquashStash(ctx, automaticStashOid);
                if (cleanupError) {
                    message = vscode.l10n.t(
                        "{message}; local changes were restored, but automatic stash cleanup failed: {cleanupMessage}. The {stashOid} backup was retained.",
                        { message, cleanupMessage: cleanupError, stashOid: automaticStashOid },
                    );
                }
            } catch (restoreErr) {
                message = vscode.l10n.t(
                    "{message}; local changes could not be restored: {restoreMessage}. Automatic stash {stashOid} was retained for recovery.",
                    {
                        message,
                        restoreMessage: getErrorMessage(restoreErr),
                        stashOid: automaticStashOid,
                    },
                );
            }
        } else {
            message = vscode.l10n.t(
                "{message}. Automatic stash {stashOid} was retained for recovery and was not restored onto the unknown repository state.",
                { message, stashOid: automaticStashOid },
            );
        }
    }
    vscode.window.showErrorMessage(vscode.l10n.t("Squash Commits failed: {message}", { message }));
}
