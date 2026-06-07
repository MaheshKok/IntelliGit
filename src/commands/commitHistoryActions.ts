import * as vscode from "vscode";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import {
    getCommitParentHashes,
    getUndoCommitCount,
    isCommitUnpushed,
    isHashMatch,
    isMergeCommitHash,
} from "../services/gitHelpers";
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
        vscode.window.showInformationMessage(
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
                "Squash Commits requires a clean working tree. Commit, shelve, or rollback local changes first.",
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
        vscode.window.showInformationMessage(
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
 * Opens an integrated terminal for an interactive rebase starting before the selected commit.
 *
 * The action is guarded to unpushed, non-merge commits in the current branch history and excludes the
 * initial commit. IntelliGit sends the `git rebase -i` command but does not await the external rebase
 * or refresh automatically after the user edits history in the terminal.
 */
export async function interactiveRebaseFromHere(ctx: CommitActionContext): Promise<void> {
    if (
        !(await ensureUnpushed(
            ctx,
            vscode.l10n.t("Interactive Rebase from Here is available only for unpushed commits."),
        ))
    ) {
        return;
    }
    if (
        await rejectMergeCommit(
            ctx,
            vscode.l10n.t("Interactive Rebase from Here is not available for merge commits."),
        )
    ) {
        return;
    }
    if (!(await ensureInCurrentBranchHistory(ctx))) return;

    const rebaseParents = await getCommitParentHashes(ctx.validatedHash, ctx.executor);
    if (rebaseParents.length === 0) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Interactive Rebase from Here is not available for the initial commit."),
        );
        return;
    }
    openInteractiveRebaseTerminal(
        ctx,
        "IntelliGit Interactive Rebase",
        vscode.l10n.t("Opened interactive rebase from {short}.", { short: ctx.short }),
    );
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
        vscode.window.showInformationMessage(vscode.l10n.t("Commit message updated."));
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
 * Opens a repository-scoped integrated terminal and sends the interactive rebase command.
 *
 * The command text is handed to the user-controlled terminal session; IntelliGit does not observe
 * completion or refresh views after the external rebase finishes.
 */
function openInteractiveRebaseTerminal(
    ctx: CommitActionContext,
    name: string,
    successMessage: string,
): void {
    const terminal = vscode.window.createTerminal({
        name,
        cwd: ctx.repoRoot,
    });
    terminal.show();
    terminal.sendText(`git rebase -i "${ctx.validatedHash}^"`, true);
    vscode.window.showInformationMessage(successMessage);
}

/**
 * Reads the selected squash range in oldest-to-newest order with parent metadata preserved.
 *
 * Callers depend on the parent count in each line to reject merge commits before rewriting history.
 */
async function getCommitRangeLines(ctx: CommitActionContext, range: string): Promise<string[]> {
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
        vscode.window.showInformationMessage(
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
