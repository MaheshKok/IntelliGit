// Commit context menu action handlers extracted from extension.ts.
// Each action handles a right-click operation on a commit in the
// commit graph: cherry-pick, revert, reset, rebase, tag, etc.

import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { CommitAction } from "../webviews/protocol/commitGraphTypes";
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
        vscode.window.showErrorMessage(
            vscode.l10n.t("Invalid commit hash received for commit action."),
        );
        return;
    }
    const short = validatedHash.slice(0, 8);

    switch (action) {
        case "copyRevision": {
            await vscode.env.clipboard.writeText(validatedHash);
            vscode.window.showInformationMessage(
                vscode.l10n.t("Copied revision {short}.", { short }),
            );
            return;
        }
        case "createPatch": {
            const defaultUri = vscode.Uri.file(path.join(repoRoot, `${short}.patch`));
            const targetUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { [vscode.l10n.t("Patch")]: ["patch", "diff"] },
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
                    vscode.l10n.t("Patch created: {fileName}", {
                        fileName: path.basename(targetUri.fsPath),
                    }),
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Failed to create patch: {message}", { message }),
                );
            }
            return;
        }
        case "cherryPick": {
            const cherryPickLabel = vscode.l10n.t("Cherry-pick");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Cherry-pick commit {short}?", { short }),
                { modal: true },
                cherryPickLabel,
            );
            if (confirm !== cherryPickLabel) return;

            const mainlineParent = await pickMainlineParent(
                validatedHash,
                cherryPickLabel,
                executor,
            );
            if (mainlineParent.kind === "cancelled") return;
            const args =
                mainlineParent.kind === "notMerge"
                    ? ["cherry-pick", validatedHash]
                    : ["cherry-pick", "-m", String(mainlineParent.parentNumber), validatedHash];
            try {
                await executor.run(args);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Cherry-picked {short}.", { short }),
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Cherry-pick failed: {message}", { message }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "checkoutRevision": {
            const checkoutLabel = vscode.l10n.t("Checkout");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Checkout commit {short}? This creates a detached HEAD state.", {
                    short,
                }),
                { modal: true },
                checkoutLabel,
            );
            if (confirm !== checkoutLabel) return;
            try {
                await executor.run(["checkout", validatedHash]);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Checked out revision {short}.", { short }),
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Checkout failed: {message}", { message }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "resetCurrentToHere": {
            const resetLabel = vscode.l10n.t("Reset");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Hard reset current branch to {short}? This will reset the index and working tree and permanently discard any uncommitted changes.",
                    { short },
                ),
                { modal: true },
                resetLabel,
            );
            if (confirm !== resetLabel) return;
            try {
                await executor.run(["reset", "--hard", validatedHash]);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Reset current branch to {short}.", { short }),
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Reset failed: {message}", { message }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "revertCommit": {
            const revertLabel = vscode.l10n.t("Revert");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Revert commit {short}?", { short }),
                { modal: true },
                revertLabel,
            );
            if (confirm !== revertLabel) return;
            const mainlineParent = await pickMainlineParent(validatedHash, revertLabel, executor);
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
                vscode.window.showInformationMessage(vscode.l10n.t("Reverted {short}.", { short }));
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Revert failed: {message}", { message }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "pushAllUpToHere": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Push All up to Here is available only for unpushed commits."),
                );
                return;
            }

            const checkedOutBranchName = await getCheckedOutBranchName(executor, currentBranches);
            if (!checkedOutBranchName) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Push All up to Here is only available when a local branch is checked out.",
                    ),
                );
                return;
            }

            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Commit {short} is not in the current branch history.", {
                        short,
                    }),
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
                    vscode.l10n.t("Could not resolve branch metadata for '{branch}'.", {
                        branch: checkedOutBranchName,
                    }),
                );
                return;
            }

            let target = resolveTrackedRemoteBranch(currentBranch, branchesSnapshot);
            let setUpstream = false;
            if (!target) {
                const remote = await resolveRemoteName(currentBranch, executor);
                if (!remote) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("No remote configured for branch {branch}.", {
                            branch: currentBranch.name,
                        }),
                    );
                    return;
                }

                const setUpstreamLabel = vscode.l10n.t("Set Upstream and Push");
                const setUpstreamConfirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t(
                        "Branch '{branch}' has no upstream. Set upstream to '{remote}/{remoteBranch}' and push commits up to {short}?",
                        {
                            branch: currentBranch.name,
                            remote,
                            remoteBranch: currentBranch.name,
                            short,
                        },
                    ),
                    { modal: true },
                    setUpstreamLabel,
                );
                if (setUpstreamConfirm !== setUpstreamLabel) return;

                target = { remote, remoteBranch: currentBranch.name };
                setUpstream = true;
            }

            const pushLabel = vscode.l10n.t("Push");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Push all commits up to {short} to {remote}/{remoteBranch}?", {
                    short,
                    remote: target.remote,
                    remoteBranch: target.remoteBranch,
                }),
                { modal: true },
                pushLabel,
            );
            if (confirm !== pushLabel) return;

            try {
                await runWithNotificationProgress(
                    vscode.l10n.t("Pushing commits up to {short}...", { short }),
                    async () => {
                        const destinationRef = `refs/heads/${target.remoteBranch}`;
                        const refspec = `${validatedHash}:${destinationRef}`;
                        await executor.run([
                            "push",
                            ...(setUpstream ? ["-u"] : []),
                            target.remote,
                            refspec,
                        ]);
                    },
                );

                vscode.window.showInformationMessage(
                    vscode.l10n.t("Pushed commits up to {short}.", { short }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "newBranch": {
            const branchName = await vscode.window.showInputBox({
                prompt: vscode.l10n.t("New branch from {short}", { short }),
                placeHolder: "branch-name",
            });
            if (!branchName) return;
            if (!isValidBranchName(branchName)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Invalid branch name '{branch}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.",
                        { branch: branchName },
                    ),
                );
                return;
            }
            try {
                await executor.run(["branch", branchName, validatedHash]);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Created branch {branch} at {short}.", {
                        branch: branchName,
                        short,
                    }),
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Failed to create branch: {message}", { message }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "newTag": {
            const tagName = await vscode.window.showInputBox({
                prompt: vscode.l10n.t("New tag at {short}", { short }),
                placeHolder: "v1.0.0",
            });
            if (!tagName) return;
            if (!isValidTagName(tagName)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Invalid tag name '{tag}'. Tag names must be valid git ref names.",
                        {
                            tag: tagName,
                        },
                    ),
                );
                return;
            }
            try {
                await executor.run(["tag", tagName, validatedHash]);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Created tag {tag}.", { tag: tagName }),
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Failed to create tag: {message}", { message }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "undoCommit": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Undo Commit is available only for unpushed commits."),
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Undo Commit is not available for merge commits."),
                );
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Commit {short} is not in the current branch history.", {
                        short,
                    }),
                );
                return;
            }
            const undoParents = await getCommitParentHashes(validatedHash, executor);
            if (undoParents.length === 0) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Cannot undo the initial commit of the repository."),
                );
                return;
            }
            const undoCount = await getUndoCommitCount(validatedHash, executor);
            const undoLabel = vscode.l10n.t("Undo");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Undo {count} commit(s) up to {short} (soft reset)?", {
                    count: undoCount,
                    short,
                }),
                { modal: true },
                undoLabel,
            );
            if (confirm !== undoLabel) return;
            try {
                await executor.run(["reset", "--soft", `${validatedHash}^`]);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Undid {count} commit(s) up to {short}.", {
                        count: undoCount,
                        short,
                    }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "editCommitMessage": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Edit Commit Message is available only for unpushed commits."),
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Edit Commit Message is not available for merge commits."),
                );
                return;
            }

            const headHash = (await executor.run(["rev-parse", "HEAD"])).trim();
            if (isHashMatch(validatedHash, headHash)) {
                const currentMessage = (await executor.run(["log", "-1", "--format=%B"])).trim();
                const nextMessage = await vscode.window.showInputBox({
                    prompt: vscode.l10n.t("Edit commit message"),
                    value: currentMessage,
                });
                if (!nextMessage) return;
                try {
                    await executor.run(["commit", "--amend", "-m", nextMessage]);
                    vscode.window.showInformationMessage(vscode.l10n.t("Commit message updated."));
                } finally {
                    await refreshAll();
                }
                return;
            }

            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Commit {short} is not in the current branch history.", {
                        short,
                    }),
                );
                return;
            }
            const rewordParents = await getCommitParentHashes(validatedHash, executor);
            if (rewordParents.length === 0) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Edit Commit Message is not available for the initial commit."),
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
                vscode.l10n.t(
                    "Interactive rebase opened. Mark the commit as 'reword' in the todo list.",
                ),
            );
            return;
        }
        case "squashCommits": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Squash Commits is available only for unpushed commits."),
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Squash Commits is not available for merge commits."),
                );
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Commit {short} is not in the current branch history.", {
                        short,
                    }),
                );
                return;
            }

            const squashParents = await getCommitParentHashes(validatedHash, executor);
            if (squashParents.length === 0) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Squash Commits is not available for the initial commit."),
                );
                return;
            }

            const status = (await executor.run(["status", "--porcelain"])).trim();
            if (status) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Squash Commits requires a clean working tree. Commit, shelve, or rollback local changes first.",
                    ),
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
                    vscode.l10n.t(
                        "Squash Commits requires at least two commits in the selected range.",
                    ),
                );
                return;
            }
            if (rangeLines.some((line) => line.split(/\s+/).length > 2)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Squash Commits is not available for ranges containing merge commits.",
                    ),
                );
                return;
            }

            const unpushed = await gitOps.getUnpushedCommitHashes();
            const allRangeCommitsUnpushed = rangeHashes.every((rangeHash) =>
                unpushed.some((unpushedHash) => isHashMatch(unpushedHash, rangeHash)),
            );
            if (!allRangeCommitsUnpushed) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Squash Commits is available only when every commit in the selected range is unpushed.",
                    ),
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
                prompt: vscode.l10n.t("Squashed commit message for {count} commits", {
                    count: rangeHashes.length,
                }),
                value:
                    defaultMessage ||
                    vscode.l10n.t("Squash {count} commits", { count: rangeHashes.length }),
            });
            if (!squashMessage) return;

            const squashLabel = vscode.l10n.t("Squash");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Squash {count} commits from {short} through HEAD into one commit?", {
                    count: rangeHashes.length,
                    short,
                }),
                { modal: true },
                squashLabel,
            );
            if (confirm !== squashLabel) return;

            let originalHead = "";
            let softResetApplied = false;
            try {
                originalHead = (await executor.run(["rev-parse", "HEAD"])).trim();
                await runWithNotificationProgress(
                    vscode.l10n.t("Squashing {count} commits...", {
                        count: rangeHashes.length,
                    }),
                    async () => {
                        await executor.run(["reset", "--soft", `${validatedHash}^`]);
                        softResetApplied = true;
                        await executor.run(["commit", "-m", squashMessage]);
                    },
                );
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Squashed {count} commits into one commit.", {
                        count: rangeHashes.length,
                    }),
                );
            } catch (err) {
                let message = getErrorMessage(err);
                if (softResetApplied && originalHead) {
                    try {
                        await executor.run(["reset", "--hard", originalHead]);
                    } catch (rollbackErr) {
                        message = vscode.l10n.t(
                            "{message}; rollback to {head} failed: {rollbackMessage}",
                            {
                                message,
                                head: originalHead.slice(0, 8),
                                rollbackMessage: getErrorMessage(rollbackErr),
                            },
                        );
                    }
                }
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Squash Commits failed: {message}", { message }),
                );
            } finally {
                await refreshAll();
            }
            return;
        }
        case "dropCommit": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Drop Commit is available only for unpushed commits."),
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Drop Commit is not available for merge commits."),
                );
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Commit {short} is not in the current branch history.", {
                        short,
                    }),
                );
                return;
            }
            const dropParents = await getCommitParentHashes(validatedHash, executor);
            if (dropParents.length === 0) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Cannot drop the initial commit of the repository."),
                );
                return;
            }
            const dropLabel = vscode.l10n.t("Drop");
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t("Drop commit {short} from current branch history?", { short }),
                { modal: true },
                dropLabel,
            );
            if (confirm !== dropLabel) return;
            try {
                await executor.run([
                    "rebase",
                    "--onto",
                    `${validatedHash}^`,
                    validatedHash,
                    "HEAD",
                ]);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("Dropped {short} from history.", { short }),
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
                await refreshAll();
            }
            return;
        }
        case "interactiveRebaseFromHere": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Interactive Rebase from Here is available only for unpushed commits.",
                    ),
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Interactive Rebase from Here is not available for merge commits.",
                    ),
                );
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Commit {short} is not in the current branch history.", {
                        short,
                    }),
                );
                return;
            }
            const rebaseParents = await getCommitParentHashes(validatedHash, executor);
            if (rebaseParents.length === 0) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "Interactive Rebase from Here is not available for the initial commit.",
                    ),
                );
                return;
            }
            const terminal = vscode.window.createTerminal({
                name: "IntelliGit Interactive Rebase",
                cwd: repoRoot,
            });
            terminal.show();
            terminal.sendText(`git rebase -i "${validatedHash}^"`, true);
            vscode.window.showInformationMessage(
                vscode.l10n.t("Opened interactive rebase from {short}.", { short }),
            );
            return;
        }
        default:
            return assertNever(action);
    }
}
