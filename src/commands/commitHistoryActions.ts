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
 * The handler requires a clean working tree, a non-merge selected commit, a non-merge range, and all
 * commits in range to be unpushed. It prompts for the resulting message and confirmation, performs a
 * soft reset plus commit, attempts a hard-reset rollback on failure after the soft reset, and refreshes
 * views after the squash attempt.
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

    const status = (await ctx.executor.run(["status", "--porcelain"])).trim();
    if (status) {
        vscode.window.showErrorMessage(
            vscode.l10n.t(
                "Squash Commits requires a clean working tree. Commit, stash, or rollback local changes first.",
            ),
        );
        return;
    }

    const range = `${ctx.validatedHash}^..HEAD`;
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

    await performSquash(ctx, rangeHashes.length, squashMessage);
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
        baseHash: ctx.validatedHash,
        rangeHashes: rangeResult.commits.map((commit) => commit.hash),
        hasPushedCommit: rangeResult.commits.some((commit) => commit.isPushed),
        expectedHead,
        expectedBranch,
    });
    const delivered = ctx.postRebaseDialog({
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
 * Subject lines are joined oldest-to-newest so the suggested message reflects the history that will
 * be replaced by the new squashed commit.
 */
async function promptSquashMessage(
    ctx: CommitActionContext,
    range: string,
    count: number,
): Promise<string | undefined> {
    // Squash subjects are prompt defaults, not a hot collection transform.
    // react-doctor-disable-next-line react-doctor/js-flatmap-filter
    const defaultMessage = (await ctx.executor.run(["log", "--reverse", "--format=%s", range]))
        .trim()
        .split("\n")
        .map((line) => line.trim())
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
 * The function records `HEAD`, soft-resets to the selected commit's parent, commits the staged
 * result, and refreshes views afterward. If commit creation fails after the soft reset, error
 * handling attempts to hard-reset back to the recorded `HEAD`.
 */
async function performSquash(
    ctx: CommitActionContext,
    count: number,
    squashMessage: string,
): Promise<void> {
    let originalHead = "";
    let softResetApplied = false;
    try {
        originalHead = (await ctx.executor.run(["rev-parse", "HEAD"])).trim();
        await runWithNotificationProgress(
            vscode.l10n.t("Squashing {count} commits...", { count }),
            async () => {
                await ctx.executor.run(["reset", "--soft", `${ctx.validatedHash}^`]);
                softResetApplied = true;
                await ctx.executor.run(["commit", "-m", squashMessage]);
            },
        );
        showTimedInformationMessage(
            vscode.l10n.t("Squashed {count} commits into one commit.", { count }),
        );
    } catch (err) {
        await showSquashError(ctx, err, softResetApplied, originalHead);
    } finally {
        await ctx.refreshAll();
    }
}

/**
 * Reports squash failures and attempts rollback when the soft reset already changed state.
 *
 * Rollback failures are appended to the user-facing error so maintainers do not lose the original
 * Git failure while still warning that branch/index/working-tree recovery did not complete.
 */
async function showSquashError(
    ctx: CommitActionContext,
    err: unknown,
    softResetApplied: boolean,
    originalHead: string,
): Promise<void> {
    let message = getErrorMessage(err);
    if (softResetApplied && originalHead) {
        try {
            await ctx.executor.run(["reset", "--hard", originalHead]);
        } catch (rollbackErr) {
            message = vscode.l10n.t("{message}; rollback to {head} failed: {rollbackMessage}", {
                message,
                head: originalHead.slice(0, 8),
                rollbackMessage: getErrorMessage(rollbackErr),
            });
        }
    }
    vscode.window.showErrorMessage(vscode.l10n.t("Squash Commits failed: {message}", { message }));
}
