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

export async function undoCommit(ctx: CommitActionContext): Promise<void> {
    if (!(await ensureUnpushed(ctx, "Undo Commit is available only for unpushed commits."))) return;
    if (await rejectMergeCommit(ctx, "Undo Commit is not available for merge commits.")) return;
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
    } finally {
        await ctx.refreshAll();
    }
}

export async function editCommitMessage(ctx: CommitActionContext): Promise<void> {
    if (
        !(await ensureUnpushed(ctx, "Edit Commit Message is available only for unpushed commits."))
    ) {
        return;
    }
    if (await rejectMergeCommit(ctx, "Edit Commit Message is not available for merge commits."))
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

export async function squashCommits(ctx: CommitActionContext): Promise<void> {
    if (!(await ensureUnpushed(ctx, "Squash Commits is available only for unpushed commits."))) {
        return;
    }
    if (await rejectMergeCommit(ctx, "Squash Commits is not available for merge commits.")) return;
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

export async function dropCommit(ctx: CommitActionContext): Promise<void> {
    if (!(await ensureUnpushed(ctx, "Drop Commit is available only for unpushed commits."))) return;
    if (await rejectMergeCommit(ctx, "Drop Commit is not available for merge commits.")) return;
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

export async function interactiveRebaseFromHere(ctx: CommitActionContext): Promise<void> {
    if (
        !(await ensureUnpushed(
            ctx,
            "Interactive Rebase from Here is available only for unpushed commits.",
        ))
    ) {
        return;
    }
    if (
        await rejectMergeCommit(
            ctx,
            "Interactive Rebase from Here is not available for merge commits.",
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

async function ensureUnpushed(ctx: CommitActionContext, message: string): Promise<boolean> {
    if (await isCommitUnpushed(ctx.validatedHash, ctx.gitOps)) return true;
    vscode.window.showErrorMessage(vscode.l10n.t(message));
    return false;
}

async function rejectMergeCommit(ctx: CommitActionContext, message: string): Promise<boolean> {
    if (!(await isMergeCommitHash(ctx.validatedHash, ctx.executor))) return false;
    vscode.window.showErrorMessage(vscode.l10n.t(message));
    return true;
}

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
    } finally {
        await ctx.refreshAll();
    }
}

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

async function getCommitRangeLines(ctx: CommitActionContext, range: string): Promise<string[]> {
    return (await ctx.executor.run(["rev-list", "--reverse", "--parents", range]))
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

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
