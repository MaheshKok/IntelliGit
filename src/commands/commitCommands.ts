// Commit context menu action handlers extracted from extension.ts.
// Each action handles a right-click operation on a commit in the
// commit graph: cherry-pick, revert, reset, rebase, tag, etc.

import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { CommitAction } from "../webviews/react/commitGraphTypes";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import {
    isValidGitHash,
    isValidBranchName,
    isValidTagName,
    isHashMatch,
    isCommitUnpushed,
    isMergeCommitHash,
    getCommitParentHashes,
    getUndoCommitCount,
    getCheckedOutBranchName,
    pickMainlineParent,
    resolveTrackedRemoteBranch,
    resolveRemoteName,
} from "../services/gitHelpers";
import type { Branch } from "../types";

function assertNever(value: never): never {
    throw new Error(`Unhandled commit action: ${String(value)}`);
}

export async function handleCommitContextAction(params: {
    action: CommitAction;
    hash: string;
    executor: GitExecutor;
    gitOps: GitOps;
    repoRoot: string;
    currentBranches: Branch[];
    refreshAll: () => Promise<void>;
}): Promise<void> {
    const { action, hash, executor, gitOps, repoRoot, currentBranches, refreshAll } = params;
    const validatedHash = hash.trim();
    if (!isValidGitHash(validatedHash)) {
        console.error("Blocked commit action due to invalid hash:", { action, hash });
        vscode.window.showErrorMessage("Invalid commit hash received for commit action.");
        return;
    }
    const short = validatedHash.slice(0, 8);

    switch (action) {
        case "copyRevision": {
            await vscode.env.clipboard.writeText(validatedHash);
            vscode.window.showInformationMessage(`Copied revision ${short}.`);
            return;
        }
        case "createPatch": {
            const defaultUri = vscode.Uri.file(path.join(repoRoot, `${short}.patch`));
            const targetUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { Patch: ["patch", "diff"] },
            });
            if (!targetUri) return;
            try {
                const patchText = await executor.run([
                    "format-patch",
                    "-1",
                    "--stdout",
                    validatedHash,
                ]);
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(patchText, "utf8"));
                vscode.window.showInformationMessage(
                    `Patch created: ${path.basename(targetUri.fsPath)}`,
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to create patch: ${message}`);
            }
            return;
        }
        case "cherryPick": {
            const confirm = await vscode.window.showWarningMessage(
                `Cherry-pick commit ${short}?`,
                { modal: true },
                "Cherry-pick",
            );
            if (confirm !== "Cherry-pick") return;

            const mainlineParent = await pickMainlineParent(validatedHash, "Cherry-pick", executor);
            if (mainlineParent.kind === "cancelled") return;
            const args =
                mainlineParent.kind === "notMerge"
                    ? ["cherry-pick", validatedHash]
                    : ["cherry-pick", "-m", String(mainlineParent.parentNumber), validatedHash];
            try {
                await executor.run(args);
                vscode.window.showInformationMessage(`Cherry-picked ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Cherry-pick failed: ${message}`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "checkoutRevision": {
            const confirm = await vscode.window.showWarningMessage(
                `Checkout commit ${short}? This creates a detached HEAD state.`,
                { modal: true },
                "Checkout",
            );
            if (confirm !== "Checkout") return;
            try {
                await executor.run(["checkout", validatedHash]);
                vscode.window.showInformationMessage(`Checked out revision ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Checkout failed: ${message}`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "resetCurrentToHere": {
            const confirm = await vscode.window.showWarningMessage(
                `Hard reset current branch to ${short}? This will reset the index and working tree and permanently discard any uncommitted changes.`,
                { modal: true },
                "Reset",
            );
            if (confirm !== "Reset") return;
            try {
                await executor.run(["reset", "--hard", validatedHash]);
                vscode.window.showInformationMessage(`Reset current branch to ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Reset failed: ${message}`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "revertCommit": {
            const confirm = await vscode.window.showWarningMessage(
                `Revert commit ${short}?`,
                { modal: true },
                "Revert",
            );
            if (confirm !== "Revert") return;
            const mainlineParent = await pickMainlineParent(validatedHash, "Revert", executor);
            if (mainlineParent.kind === "cancelled") return;
            const args =
                mainlineParent.kind === "notMerge"
                    ? ["revert", "--no-edit", validatedHash]
                    : [
                          "revert",
                          "-m",
                          String(mainlineParent.parentNumber),
                          "--no-edit",
                          validatedHash,
                      ];
            try {
                await executor.run(args);
                vscode.window.showInformationMessage(`Reverted ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Revert failed: ${message}`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "pushAllUpToHere": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Push All up to Here is available only for unpushed commits.",
                );
                return;
            }

            const checkedOutBranchName = await getCheckedOutBranchName(executor, currentBranches);
            if (!checkedOutBranchName) {
                vscode.window.showErrorMessage(
                    "Push All up to Here is only available when a local branch is checked out.",
                );
                return;
            }

            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }

            let currentBranch = currentBranches.find(
                (branch) => !branch.isRemote && branch.name === checkedOutBranchName,
            );
            let branchesSnapshot = currentBranches;
            if (!currentBranch) {
                // Stale cache — refresh branch metadata and retry
                const freshBranches = await gitOps.getBranches();
                currentBranch = freshBranches.find(
                    (branch) => !branch.isRemote && branch.name === checkedOutBranchName,
                );
                branchesSnapshot = freshBranches;
            }
            if (!currentBranch) {
                vscode.window.showErrorMessage(
                    `Could not resolve branch metadata for '${checkedOutBranchName}'.`,
                );
                return;
            }

            let target = resolveTrackedRemoteBranch(currentBranch, branchesSnapshot);
            let setUpstream = false;
            if (!target) {
                const remote = await resolveRemoteName(currentBranch, executor);
                if (!remote) {
                    vscode.window.showErrorMessage(
                        `No remote configured for branch ${currentBranch.name}.`,
                    );
                    return;
                }

                const setUpstreamConfirm = await vscode.window.showWarningMessage(
                    `Branch '${currentBranch.name}' has no upstream. Set upstream to '${remote}/${currentBranch.name}' and push commits up to ${short}?`,
                    { modal: true },
                    "Set Upstream and Push",
                );
                if (setUpstreamConfirm !== "Set Upstream and Push") return;

                target = { remote, remoteBranch: currentBranch.name };
                setUpstream = true;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Push all commits up to ${short} to ${target.remote}/${target.remoteBranch}?`,
                { modal: true },
                "Push",
            );
            if (confirm !== "Push") return;

            try {
                await runWithNotificationProgress(`Pushing commits up to ${short}...`, async () => {
                    const destinationRef = `refs/heads/${target.remoteBranch}`;
                    const refspec = `${validatedHash}:${destinationRef}`;
                    await executor.run([
                        "push",
                        ...(setUpstream ? ["-u"] : []),
                        target.remote,
                        refspec,
                    ]);
                });

                vscode.window.showInformationMessage(`Pushed commits up to ${short}.`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "newBranch": {
            const branchName = await vscode.window.showInputBox({
                prompt: `New branch from ${short}`,
                placeHolder: "branch-name",
            });
            if (!branchName) return;
            if (!isValidBranchName(branchName)) {
                vscode.window.showErrorMessage(
                    `Invalid branch name '${branchName}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
                );
                return;
            }
            try {
                await executor.run(["branch", branchName, validatedHash]);
                vscode.window.showInformationMessage(`Created branch ${branchName} at ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to create branch: ${message}`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "newTag": {
            const tagName = await vscode.window.showInputBox({
                prompt: `New tag at ${short}`,
                placeHolder: "v1.0.0",
            });
            if (!tagName) return;
            if (!isValidTagName(tagName)) {
                vscode.window.showErrorMessage(
                    `Invalid tag name '${tagName}'. Tag names must be valid git ref names.`,
                );
                return;
            }
            try {
                await executor.run(["tag", tagName, validatedHash]);
                vscode.window.showInformationMessage(`Created tag ${tagName}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to create tag: ${message}`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "undoCommit": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Undo Commit is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage("Undo Commit is not available for merge commits.");
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }
            const undoParents = await getCommitParentHashes(validatedHash, executor);
            if (undoParents.length === 0) {
                vscode.window.showErrorMessage("Cannot undo the initial commit of the repository.");
                return;
            }
            const undoCount = await getUndoCommitCount(validatedHash, executor);
            const confirm = await vscode.window.showWarningMessage(
                `Undo ${undoCount} commit(s) up to ${short} (soft reset)?`,
                { modal: true },
                "Undo",
            );
            if (confirm !== "Undo") return;
            try {
                await executor.run(["reset", "--soft", `${validatedHash}^`]);
                vscode.window.showInformationMessage(`Undid ${undoCount} commit(s) up to ${short}.`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "editCommitMessage": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Edit Commit Message is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    "Edit Commit Message is not available for merge commits.",
                );
                return;
            }

            const headHash = (await executor.run(["rev-parse", "HEAD"])).trim();
            if (isHashMatch(validatedHash, headHash)) {
                const currentMessage = (await executor.run(["log", "-1", "--format=%B"])).trim();
                const nextMessage = await vscode.window.showInputBox({
                    prompt: "Edit commit message",
                    value: currentMessage,
                });
                if (!nextMessage) return;
                try {
                    await executor.run(["commit", "--amend", "-m", nextMessage]);
                    vscode.window.showInformationMessage("Commit message updated.");
                } finally {
                    await refreshAll();
                }
                return;
            }

            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }
            const rewordParents = await getCommitParentHashes(validatedHash, executor);
            if (rewordParents.length === 0) {
                vscode.window.showErrorMessage(
                    "Edit Commit Message is not available for the initial commit.",
                );
                return;
            }
            const terminal = vscode.window.createTerminal({
                name: "IntelliGit Reword Commit",
                cwd: repoRoot,
            });
            terminal.show();
            terminal.sendText(`git rebase -i "${validatedHash}^"`, true);
            vscode.window.showInformationMessage(
                "Interactive rebase opened. Mark the commit as 'reword' in the todo list.",
            );
            return;
        }
        case "squashCommits": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Squash Commits is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    "Squash Commits is not available for merge commits.",
                );
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }

            const squashParents = await getCommitParentHashes(validatedHash, executor);
            if (squashParents.length === 0) {
                vscode.window.showErrorMessage(
                    "Squash Commits is not available for the initial commit.",
                );
                return;
            }

            const status = (await executor.run(["status", "--porcelain"])).trim();
            if (status) {
                vscode.window.showErrorMessage(
                    "Squash Commits requires a clean working tree. Commit, shelve, or rollback local changes first.",
                );
                return;
            }

            const range = `${validatedHash}^..HEAD`;
            const rangeLines = (await executor.run(["rev-list", "--reverse", "--parents", range]))
                .trim()
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            const rangeHashes = rangeLines.map((line) => line.split(/\s+/)[0]);
            if (rangeHashes.length < 2) {
                vscode.window.showErrorMessage(
                    "Squash Commits requires at least two commits in the selected range.",
                );
                return;
            }
            if (rangeLines.some((line) => line.split(/\s+/).length > 2)) {
                vscode.window.showErrorMessage(
                    "Squash Commits is not available for ranges containing merge commits.",
                );
                return;
            }

            const unpushed = await gitOps.getUnpushedCommitHashes();
            const allRangeCommitsUnpushed = rangeHashes.every((rangeHash) =>
                unpushed.some((unpushedHash) => isHashMatch(unpushedHash, rangeHash)),
            );
            if (!allRangeCommitsUnpushed) {
                vscode.window.showErrorMessage(
                    "Squash Commits is available only when every commit in the selected range is unpushed.",
                );
                return;
            }

            const defaultMessage = (await executor.run(["log", "--reverse", "--format=%s", range]))
                .trim()
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .join("; ");
            const squashMessage = await vscode.window.showInputBox({
                prompt: `Squashed commit message for ${rangeHashes.length} commits`,
                value: defaultMessage || `Squash ${rangeHashes.length} commits`,
            });
            if (!squashMessage) return;

            const confirm = await vscode.window.showWarningMessage(
                `Squash ${rangeHashes.length} commits from ${short} through HEAD into one commit?`,
                { modal: true },
                "Squash",
            );
            if (confirm !== "Squash") return;

            let originalHead = "";
            let softResetApplied = false;
            try {
                originalHead = (await executor.run(["rev-parse", "HEAD"])).trim();
                await runWithNotificationProgress(
                    `Squashing ${rangeHashes.length} commits...`,
                    async () => {
                        await executor.run(["reset", "--soft", `${validatedHash}^`]);
                        softResetApplied = true;
                        await executor.run(["commit", "-m", squashMessage]);
                    },
                );
                vscode.window.showInformationMessage(
                    `Squashed ${rangeHashes.length} commits into one commit.`,
                );
            } catch (err) {
                let message = getErrorMessage(err);
                if (softResetApplied && originalHead) {
                    try {
                        await executor.run(["reset", "--hard", originalHead]);
                    } catch (rollbackErr) {
                        message = `${message}; rollback to ${originalHead.slice(0, 8)} failed: ${getErrorMessage(rollbackErr)}`;
                    }
                }
                vscode.window.showErrorMessage(`Squash Commits failed: ${message}`);
            } finally {
                await refreshAll();
            }
            return;
        }
        case "dropCommit": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Drop Commit is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage("Drop Commit is not available for merge commits.");
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }
            const dropParents = await getCommitParentHashes(validatedHash, executor);
            if (dropParents.length === 0) {
                vscode.window.showErrorMessage("Cannot drop the initial commit of the repository.");
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Drop commit ${short} from current branch history?`,
                { modal: true },
                "Drop",
            );
            if (confirm !== "Drop") return;
            try {
                await executor.run([
                    "rebase",
                    "--onto",
                    `${validatedHash}^`,
                    validatedHash,
                    "HEAD",
                ]);
                vscode.window.showInformationMessage(`Dropped ${short} from history.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    `Failed to drop commit: ${message}. Run 'git rebase --abort' to recover.`,
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "interactiveRebaseFromHere": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Interactive Rebase from Here is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    "Interactive Rebase from Here is not available for merge commits.",
                );
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }
            const rebaseParents = await getCommitParentHashes(validatedHash, executor);
            if (rebaseParents.length === 0) {
                vscode.window.showErrorMessage(
                    "Interactive Rebase from Here is not available for the initial commit.",
                );
                return;
            }
            const terminal = vscode.window.createTerminal({
                name: "IntelliGit Interactive Rebase",
                cwd: repoRoot,
            });
            terminal.show();
            terminal.sendText(`git rebase -i "${validatedHash}^"`, true);
            vscode.window.showInformationMessage(`Opened interactive rebase from ${short}.`);
            return;
        }
        default:
            return assertNever(action);
    }
}
