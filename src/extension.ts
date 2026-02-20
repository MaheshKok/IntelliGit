// Extension entry point. Registers coordinated IntelliGit webviews:
// commit graph (with integrated branch column/details) and commit panel.
// The extension host is the sole data coordinator -- views never talk directly.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { GitExecutor } from "./git/executor";
import { GitOps } from "./git/operations";
import { CommitGraphViewProvider } from "./views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "./views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "./views/CommitPanelViewProvider";
import type { Branch } from "./types";
import type { CommitAction } from "./webviews/react/commitGraphTypes";
import { getErrorMessage, isBranchNotFullyMergedError } from "./utils/errors";
import { deleteFileWithFallback } from "./utils/fileOps";
import { runWithStatusBar } from "./utils/statusBar";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const repoRoot = workspaceFolder.uri.fsPath;
    const executor = new GitExecutor(repoRoot);
    const gitOps = new GitOps(executor);

    try {
        const isRepo = await gitOps.isRepository();
        if (!isRepo) return;
    } catch {
        return;
    }

    // Cached branch list for webview context menu lookups
    let currentBranches: Branch[] = [];
    let commitDetailRequestSeq = 0;

    // --- Providers ---

    const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps);
    const commitInfo = new CommitInfoViewProvider(context.extensionUri);
    const commitPanel = new CommitPanelViewProvider(context.extensionUri, gitOps);

    // --- Register views ---

    const emptyTreeProvider: vscode.TreeDataProvider<never> = {
        getTreeItem: () => {
            throw new Error("unreachable");
        },
        getChildren: () => [],
    };
    const badgeView = vscode.window.createTreeView("intelligit.fileCountBadge", {
        treeDataProvider: emptyTreeProvider,
    });

    const updateBadge = (count: number) => {
        badgeView.badge =
            count > 0
                ? { tooltip: `${count} changed file${count !== 1 ? "s" : ""}`, value: count }
                : undefined;
    };

    context.subscriptions.push(
        badgeView,
        commitPanel.onDidChangeFileCount(updateBadge),
        vscode.window.registerWebviewViewProvider(CommitGraphViewProvider.viewType, commitGraph),
        vscode.window.registerWebviewViewProvider(CommitInfoViewProvider.viewType, commitInfo),
        vscode.window.registerWebviewViewProvider(CommitPanelViewProvider.viewType, commitPanel),
    );

    // --- Wire data flow ---

    context.subscriptions.push(
        commitGraph.onCommitSelected(async (hash) => {
            const requestId = ++commitDetailRequestSeq;
            try {
                const detail = await gitOps.getCommitDetail(hash);
                if (requestId !== commitDetailRequestSeq) return;
                (
                    commitGraph as {
                        setCommitDetail?: (commitDetail: import("./types").CommitDetail) => void;
                    }
                ).setCommitDetail?.(detail);
                commitInfo.setCommitDetail(detail);
            } catch (err) {
                const msg = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to load commit: ${msg}`);
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onBranchFilterChanged(() => {
            (commitGraph as { clearCommitDetail?: () => void }).clearCommitDetail?.();
            commitInfo.clear();
        }),
    );

    // Forward branch actions from webview context menu to VS Code commands
    context.subscriptions.push(
        commitGraph.onBranchAction(({ action, branchName }) => {
            const branch = currentBranches.find((b) => b.name === branchName);
            if (!branch) return;
            const item: { branch: Branch } = { branch };
            vscode.commands.executeCommand(`intelligit.${action}`, item);
        }),
    );

    context.subscriptions.push(
        commitGraph.onCommitAction(async ({ action, hash }) => {
            try {
                await handleCommitContextAction({ action, hash });
            } catch (error) {
                const message = getErrorMessage(error);
                console.error(`Commit action '${action}' failed:`, error);
                vscode.window.showErrorMessage(`Commit action failed: ${message}`);
            }
        }),
    );

    // --- Helper ---

    const clearSelection = () => {
        (commitGraph as { clearCommitDetail?: () => void }).clearCommitDetail?.();
        commitInfo.clear();
    };

    const getCheckedOutBranchName = async (): Promise<string | null> => {
        try {
            const head = (await executor.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
            if (head && head !== "HEAD") return head;
        } catch {
            // Fall back to cached branch metadata.
        }
        return getCurrentBranchName() ?? null;
    };

    const getLocalBranchMergeStatusForDelete = async (
        branchName: string,
        currentBranchName: string | null,
    ): Promise<{ merged: boolean; target: string }> => {
        const target = currentBranchName?.trim() || "HEAD";
        try {
            await executor.run(["merge-base", "--is-ancestor", branchName, target]);
            return { merged: true, target };
        } catch {
            return { merged: false, target };
        }
    };

    const getCurrentBranchName = () => currentBranches.find((b) => b.isCurrent)?.name;

    const getLocalNameFromRemote = (remoteBranchName: string) =>
        remoteBranchName.split("/").slice(1).join("/");

    const checkoutBranch = async (branch: Branch): Promise<string> => {
        if (!branch.isRemote) {
            await executor.run(["checkout", branch.name]);
            return branch.name;
        }

        const localName = getLocalNameFromRemote(branch.name);
        const existingLocal = currentBranches.find((b) => !b.isRemote && b.name === localName);
        if (existingLocal) {
            await executor.run(["checkout", existingLocal.name]);
            return existingLocal.name;
        }

        await executor.run(["checkout", "--track", branch.name]);
        return localName;
    };

    const resolveRemoteName = async (branch: Branch): Promise<string | null> => {
        if (branch.remote) return branch.remote;
        try {
            const raw = await executor.run(["remote"]);
            const remotes = raw
                .split("\n")
                .map((r) => r.trim())
                .filter(Boolean);
            return remotes[0] ?? null;
        } catch {
            return null;
        }
    };

    const resolveTrackedRemoteBranch = (
        branch: Branch,
    ): { remote: string; remoteBranch: string } | null => {
        if (branch.upstream && branch.upstream.includes("/")) {
            const [remote, ...rest] = branch.upstream.split("/");
            const remoteBranch = rest.join("/");
            if (remote && remoteBranch) {
                return { remote, remoteBranch };
            }
        }

        if (branch.remote) {
            const expected = `${branch.remote}/${branch.name}`;
            if (currentBranches.some((b) => b.isRemote && b.name === expected)) {
                return { remote: branch.remote, remoteBranch: branch.name };
            }
        }

        // Fallback: match remote branches whose name ends with the local branch name.
        // Only used when there is exactly one match to avoid ambiguity (e.g. both
        // "origin/feat" and "upstream/feat" would produce two matches and be skipped).
        const suffixMatches = currentBranches.filter(
            (b) => b.isRemote && b.name.endsWith(`/${branch.name}`),
        );
        if (suffixMatches.length === 1) {
            const [remote, ...rest] = suffixMatches[0].name.split("/");
            const remoteBranch = rest.join("/");
            if (remote && remoteBranch) {
                return { remote, remoteBranch };
            }
        }

        return null;
    };

    const resolveRemoteDeleteTarget = (
        branch: Branch,
    ): { remote: string; remoteBranch: string } | null => {
        if (!branch.isRemote) return null;
        const parts = branch.name.split("/");
        if (parts.length < 2) return null;

        const remote = branch.remote ?? parts[0];
        const remoteBranch = parts.slice(1).join("/");
        if (!remote || !remoteBranch) return null;

        return { remote, remoteBranch };
    };

    const showDeletedBranchActions = async (branch: Branch): Promise<void> => {
        const restoreLabel = "Restore";
        const deleteTrackedLabel = "Delete Tracked Branch";
        const tracked = resolveTrackedRemoteBranch(branch);
        const buttons = tracked ? [restoreLabel, deleteTrackedLabel] : [restoreLabel];
        const action = await vscode.window.showInformationMessage(
            `Deleted: ${branch.name}`,
            ...buttons,
        );

        if (action === restoreLabel) {
            if (!isValidGitHash(branch.hash)) {
                vscode.window.showErrorMessage(
                    `Cannot restore '${branch.name}': missing or invalid commit hash.`,
                );
                return;
            }
            try {
                await executor.run(["branch", branch.name, branch.hash]);
                vscode.window.showInformationMessage(`Restored ${branch.name}`);
                await vscode.commands.executeCommand("intelligit.refresh");
            } catch (error) {
                const msg = getErrorMessage(error);
                vscode.window.showErrorMessage(`Restore failed: ${msg}`);
            }
            return;
        }

        if (action === deleteTrackedLabel && tracked) {
            const confirm = await vscode.window.showWarningMessage(
                `Delete tracked branch '${tracked.remote}/${tracked.remoteBranch}'?`,
                { modal: true },
                deleteTrackedLabel,
            );
            if (confirm !== deleteTrackedLabel) return;

            try {
                await runWithStatusBar(
                    `Deleting tracked branch ${tracked.remote}/${tracked.remoteBranch}...`,
                    async () => {
                        await executor.run([
                            "push",
                            tracked.remote,
                            "--delete",
                            tracked.remoteBranch,
                        ]);
                    },
                );
                vscode.window.showInformationMessage(
                    `Deleted tracked branch ${tracked.remote}/${tracked.remoteBranch}`,
                );
                await vscode.commands.executeCommand("intelligit.refresh");
            } catch (error) {
                const msg = getErrorMessage(error);
                vscode.window.showErrorMessage(`Delete tracked branch failed: ${msg}`);
            }
        }
    };

    const isHashMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
    const isValidGitHash = (value: string): boolean => /^[0-9a-fA-F]{7,40}$/.test(value);
    const isValidBranchName = (value: string): boolean =>
        value.length > 0 && !value.startsWith("-") && /^[A-Za-z0-9._/-]+$/.test(value);
    const assertNever = (value: never): never => {
        throw new Error(`Unhandled commit action: ${String(value)}`);
    };

    const isCommitUnpushed = async (hash: string): Promise<boolean> => {
        const unpushed = await gitOps.getUnpushedCommitHashes();
        return unpushed.some((h) => isHashMatch(h, hash));
    };

    const getCommitParentHashes = async (hash: string): Promise<string[]> => {
        const raw = (await executor.run(["rev-list", "--parents", "-n", "1", hash])).trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        return parts.slice(1);
    };

    const isMergeCommitHash = async (hash: string): Promise<boolean> =>
        (await getCommitParentHashes(hash)).length > 1;

    type MainlineParentPickResult =
        | { kind: "notMerge" }
        | { kind: "cancelled" }
        | { kind: "selected"; parentNumber: number };

    const pickMainlineParent = async (
        hash: string,
        actionLabel: string,
    ): Promise<MainlineParentPickResult> => {
        const parents = await getCommitParentHashes(hash);
        if (parents.length <= 1) return { kind: "notMerge" };

        const pick = await vscode.window.showQuickPick(
            parents.map((parent, idx) => ({
                label: `Parent ${idx + 1} (${parent.slice(0, 8)})`,
                detail:
                    idx === 0
                        ? "Usually the target branch side of the merge."
                        : "Alternate merge parent.",
                parentNumber: idx + 1,
            })),
            {
                title: `${actionLabel}: select mainline parent`,
                placeHolder: "Pick the parent number to use with -m",
            },
        );

        if (!pick) return { kind: "cancelled" };
        return { kind: "selected", parentNumber: pick.parentNumber };
    };

    const getUndoCommitCount = async (hash: string): Promise<number> => {
        const raw = (await executor.run(["rev-list", "--count", `${hash}^..HEAD`])).trim();
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    };

    const refreshAll = async (): Promise<void> => {
        await vscode.commands.executeCommand("intelligit.refresh");
    };

    const handleCommitContextAction = async (params: {
        action: CommitAction;
        hash: string;
    }): Promise<void> => {
        const { action, hash } = params;
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
                return;
            }
            case "cherryPick": {
                const confirm = await vscode.window.showWarningMessage(
                    `Cherry-pick commit ${short}?`,
                    { modal: true },
                    "Cherry-pick",
                );
                if (confirm !== "Cherry-pick") return;

                const mainlineParent = await pickMainlineParent(validatedHash, "Cherry-pick");
                if (mainlineParent.kind === "cancelled") return;
                const args =
                    mainlineParent.kind === "notMerge"
                        ? ["cherry-pick", validatedHash]
                        : ["cherry-pick", "-m", String(mainlineParent.parentNumber), validatedHash];
                await executor.run(args);
                vscode.window.showInformationMessage(`Cherry-picked ${short}.`);
                await refreshAll();
                return;
            }
            case "checkoutRevision": {
                const confirm = await vscode.window.showWarningMessage(
                    `Checkout commit ${short}? This creates a detached HEAD state.`,
                    { modal: true },
                    "Checkout",
                );
                if (confirm !== "Checkout") return;
                await executor.run(["checkout", validatedHash]);
                vscode.window.showInformationMessage(`Checked out revision ${short}.`);
                await refreshAll();
                return;
            }
            case "resetCurrentToHere": {
                const confirm = await vscode.window.showWarningMessage(
                    `Hard reset current branch to ${short}? This will reset the index and working tree and permanently discard any uncommitted changes.`,
                    { modal: true },
                    "Reset",
                );
                if (confirm !== "Reset") return;
                await executor.run(["reset", "--hard", validatedHash]);
                vscode.window.showInformationMessage(`Reset current branch to ${short}.`);
                await refreshAll();
                return;
            }
            case "revertCommit": {
                const confirm = await vscode.window.showWarningMessage(
                    `Revert commit ${short}?`,
                    { modal: true },
                    "Revert",
                );
                if (confirm !== "Revert") return;
                const mainlineParent = await pickMainlineParent(validatedHash, "Revert");
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
                await executor.run(args);
                vscode.window.showInformationMessage(`Reverted ${short}.`);
                await refreshAll();
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
                await executor.run(["branch", branchName, validatedHash]);
                vscode.window.showInformationMessage(`Created branch ${branchName} at ${short}.`);
                await refreshAll();
                return;
            }
            case "newTag": {
                const tagName = await vscode.window.showInputBox({
                    prompt: `New tag at ${short}`,
                    placeHolder: "v1.0.0",
                });
                if (!tagName) return;
                if (!isValidBranchName(tagName)) {
                    vscode.window.showErrorMessage(
                        `Invalid tag name '${tagName}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
                    );
                    return;
                }
                await executor.run(["tag", tagName, validatedHash]);
                vscode.window.showInformationMessage(`Created tag ${tagName}.`);
                await refreshAll();
                return;
            }
            case "undoCommit": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Undo Commit is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Undo Commit is not available for merge commits.",
                    );
                    return;
                }
                const undoCount = await getUndoCommitCount(validatedHash);
                const confirm = await vscode.window.showWarningMessage(
                    `Undo ${undoCount} commit(s) up to ${short} (soft reset)?`,
                    { modal: true },
                    "Undo",
                );
                if (confirm !== "Undo") return;
                await executor.run(["reset", "--soft", `${validatedHash}^`]);
                vscode.window.showInformationMessage(
                    `Undid ${undoCount} commit(s) up to ${short}.`,
                );
                await refreshAll();
                return;
            }
            case "editCommitMessage": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Edit Commit Message is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Edit Commit Message is not available for merge commits.",
                    );
                    return;
                }

                const headHash = (await executor.run(["rev-parse", "HEAD"])).trim();
                if (isHashMatch(validatedHash, headHash)) {
                    const currentMessage = (
                        await executor.run(["log", "-1", "--format=%B"])
                    ).trim();
                    const nextMessage = await vscode.window.showInputBox({
                        prompt: "Edit commit message",
                        value: currentMessage,
                    });
                    if (!nextMessage) return;
                    await executor.run(["commit", "--amend", "-m", nextMessage]);
                    vscode.window.showInformationMessage("Commit message updated.");
                    await refreshAll();
                    return;
                }

                const terminal = vscode.window.createTerminal({
                    name: "IntelliGit Reword Commit",
                    cwd: repoRoot,
                });
                terminal.show();
                terminal.sendText(`git rebase -i ${validatedHash}^`);
                vscode.window.showInformationMessage(
                    "Interactive rebase opened. Mark the commit as 'reword' in the todo list.",
                );
                return;
            }
            case "dropCommit": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Drop Commit is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Drop Commit is not available for merge commits.",
                    );
                    return;
                }
                const confirm = await vscode.window.showWarningMessage(
                    `Drop commit ${short} from current branch history?`,
                    { modal: true },
                    "Drop",
                );
                if (confirm !== "Drop") return;
                await executor.run([
                    "rebase",
                    "--onto",
                    `${validatedHash}^`,
                    validatedHash,
                    "HEAD",
                ]);
                vscode.window.showInformationMessage(`Dropped ${short} from history.`);
                await refreshAll();
                return;
            }
            case "interactiveRebaseFromHere": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Interactive Rebase from Here is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Interactive Rebase from Here is not available for merge commits.",
                    );
                    return;
                }
                const terminal = vscode.window.createTerminal({
                    name: "IntelliGit Interactive Rebase",
                    cwd: repoRoot,
                });
                terminal.show();
                terminal.sendText(`git rebase -i ${validatedHash}^`);
                vscode.window.showInformationMessage(`Opened interactive rebase from ${short}.`);
                return;
            }
            default:
                return assertNever(action);
        }
    };

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.refresh", async () => {
            currentBranches = await gitOps.getBranches();
            commitGraph.setBranches(currentBranches);
            await commitGraph.refresh();
            await commitPanel.refresh();
            await clearSelection();
        }),

        vscode.commands.registerCommand(
            "intelligit.filterByBranch",
            async (branchName?: string) => {
                await commitGraph.filterByBranch(branchName ?? null);
                await clearSelection();
            },
        ),

        vscode.commands.registerCommand("intelligit.showGitLog", async () => {
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
        }),
    );

    // --- Branch action commands ---

    const branchActionCommands: Array<{
        id: string;
        handler: (item: { branch?: Branch }) => Promise<void>;
    }> = [
        {
            id: "intelligit.checkout",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                try {
                    const checkedOut = await checkoutBranch(branch);
                    vscode.window.showInformationMessage(`Checked out ${checkedOut}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Checkout failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.newBranchFrom",
            handler: async (item) => {
                const base = item.branch?.name;
                if (!base) return;
                const newName = await vscode.window.showInputBox({
                    prompt: `New branch from ${base}`,
                    placeHolder: "branch-name",
                });
                if (!newName) return;
                try {
                    await executor.run(["checkout", "-b", newName, base]);
                    vscode.window.showInformationMessage(`Created and checked out ${newName}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Failed to create branch: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.checkoutAndRebase",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                const onto = getCurrentBranchName();
                if (!onto) {
                    vscode.window.showErrorMessage("No current branch found.");
                    return;
                }
                try {
                    const checkedOut = await checkoutBranch(branch);
                    if (checkedOut === onto) {
                        vscode.window.showInformationMessage(
                            `${checkedOut} is already the current branch.`,
                        );
                        return;
                    }
                    await executor.run(["rebase", onto]);
                    vscode.window.showInformationMessage(
                        `Checked out ${checkedOut} and rebased onto ${onto}`,
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Checkout and rebase failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.rebaseCurrentOnto",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Rebase current branch onto ${name}?`,
                    { modal: true },
                    "Rebase",
                );
                if (confirm !== "Rebase") return;
                try {
                    await executor.run(["rebase", name]);
                    vscode.window.showInformationMessage(`Rebased onto ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Rebase failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.mergeIntoCurrent",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Merge ${name} into current branch?`,
                    { modal: true },
                    "Merge",
                );
                if (confirm !== "Merge") return;
                try {
                    await executor.run(["merge", name]);
                    vscode.window.showInformationMessage(`Merged ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Merge failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.updateBranch",
            handler: async (item) => {
                const branch = item.branch;
                const name = branch?.name;
                if (!name || branch?.isRemote) return;
                try {
                    await runWithStatusBar(`Updating ${name}...`, async () => {
                        const remote = await resolveRemoteName(branch);
                        if (branch.isCurrent) {
                            if (remote) {
                                await executor.run(["pull", "--ff-only", remote, name]);
                            } else {
                                await executor.run(["pull", "--ff-only"]);
                            }
                            return;
                        }

                        if (!remote) {
                            throw new Error(`No remote configured for branch ${name}.`);
                        }

                        await executor.run([
                            "fetch",
                            remote,
                            `${name}:${name}`,
                            "--recurse-submodules=no",
                            "--progress",
                            "--prune",
                        ]);
                    });
                    vscode.window.showInformationMessage(`Updated ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Update failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.pushBranch",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch || branch.isRemote) return;
                try {
                    await runWithStatusBar(`Pushing ${branch.name}...`, async () => {
                        const remote = await resolveRemoteName(branch);
                        if (branch.isCurrent) {
                            if (branch.remote) {
                                await executor.run(["push", branch.remote, branch.name]);
                            } else {
                                await gitOps.push();
                            }
                        } else {
                            if (!remote) {
                                throw new Error(`No remote configured for branch ${branch.name}.`);
                            }
                            await executor.run(["push", "-u", remote, branch.name]);
                        }
                    });
                    vscode.window.showInformationMessage(`Pushed ${branch.name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Push failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.renameBranch",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const newName = await vscode.window.showInputBox({
                    prompt: `Rename ${name} to`,
                    value: name,
                });
                if (!newName || newName === name) return;
                try {
                    await executor.run(["branch", "-m", name, newName]);
                    vscode.window.showInformationMessage(`Renamed ${name} to ${newName}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Rename failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.deleteBranch",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                const name = branch.name;
                if (!name) return;
                const isRemote = !!branch.isRemote;
                const checkedOutBranch = isRemote ? null : await getCheckedOutBranchName();

                if (!isRemote && checkedOutBranch && checkedOutBranch === name) {
                    await vscode.window.showWarningMessage(
                        `Cannot delete '${name}' because it is currently checked out. Switch to another branch and try again.`,
                        { modal: true },
                        "OK",
                    );
                    return;
                }

                let confirmLabel = "Delete";
                let confirmMessage = `Delete branch ${name}?`;
                if (!isRemote) {
                    const mergeStatus = await getLocalBranchMergeStatusForDelete(
                        name,
                        checkedOutBranch,
                    );
                    if (!mergeStatus.merged) {
                        const targetLabel =
                            mergeStatus.target === "HEAD"
                                ? "the current branch"
                                : `'${mergeStatus.target}'`;
                        confirmLabel = "Delete Anyway";
                        confirmMessage =
                            `Branch ${name} has unmerged commits relative to ${targetLabel}. Delete anyway?\n` +
                            `This may permanently lose commits not reachable from ${targetLabel}.`;
                    }
                }

                const confirm = await vscode.window.showWarningMessage(
                    confirmMessage,
                    { modal: true },
                    confirmLabel,
                );
                if (confirm !== confirmLabel) return;
                try {
                    if (isRemote) {
                        const target = resolveRemoteDeleteTarget(branch);
                        if (!target) {
                            vscode.window.showErrorMessage(
                                `Delete failed: unable to determine remote target for '${name}'.`,
                            );
                            return;
                        }
                        await runWithStatusBar(
                            `Deleting remote branch ${target.remote}/${target.remoteBranch}...`,
                            async () => {
                                await executor.run([
                                    "push",
                                    target.remote,
                                    "--delete",
                                    target.remoteBranch,
                                ]);
                            },
                        );
                        vscode.window.showInformationMessage(
                            `Deleted ${target.remote}/${target.remoteBranch}`,
                        );
                        await vscode.commands.executeCommand("intelligit.refresh");
                    } else {
                        const forceDelete = confirmLabel === "Delete Anyway";
                        await executor.run(["branch", forceDelete ? "-D" : "-d", name]);
                        await vscode.commands.executeCommand("intelligit.refresh");
                        await showDeletedBranchActions(branch);
                    }
                } catch (err) {
                    if (!isRemote && isBranchNotFullyMergedError(err)) {
                        const forceConfirm = await vscode.window.showWarningMessage(
                            `Branch '${name}' has unmerged commits. Do you still want to delete it?\nThis may permanently lose commits not reachable from the current branch.`,
                            { modal: true },
                            "Delete Anyway",
                        );
                        if (forceConfirm !== "Delete Anyway") return;
                        try {
                            await executor.run(["branch", "-D", name]);
                            await vscode.commands.executeCommand("intelligit.refresh");
                            await showDeletedBranchActions(branch);
                        } catch (forceErr) {
                            const msg = getErrorMessage(forceErr);
                            vscode.window.showErrorMessage(`Delete failed: ${msg}`);
                        }
                        return;
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Delete failed: ${msg}`);
                }
            },
        },
    ];

    for (const cmd of branchActionCommands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, (item: unknown) => {
                const validated =
                    item && typeof item === "object" && "branch" in item
                        ? (item as { branch?: Branch })
                        : { branch: undefined };
                return cmd.handler(validated);
            }),
        );
    }

    // --- Commit panel file context menu commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "intelligit.fileRollback",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Rollback ${ctx.filePath}?`,
                    { modal: true },
                    "Rollback",
                );
                if (confirm !== "Rollback") return;
                try {
                    await gitOps.rollbackFiles([ctx.filePath]);
                    vscode.window.showInformationMessage("Changes rolled back.");
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to rollback file:", error);
                    vscode.window.showErrorMessage(`Rollback failed: ${message}`);
                } finally {
                    await commitPanel.refresh();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileJumpToSource",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const uri = vscode.Uri.joinPath(workspaceFolder.uri, ctx.filePath);
                await vscode.window.showTextDocument(uri);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileDelete",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${ctx.filePath}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;

                const deleted = await deleteFileWithFallback(
                    gitOps,
                    workspaceFolder.uri,
                    ctx.filePath,
                );
                if (!deleted) return;

                vscode.window.showInformationMessage(`Deleted ${ctx.filePath}`);
                await commitPanel.refresh();
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShelve",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    await gitOps.shelveSave([ctx.filePath]);
                    vscode.window.showInformationMessage(`Shelved ${ctx.filePath}.`);
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to shelve file:", error);
                    vscode.window.showErrorMessage(`Shelve failed: ${message}`);
                } finally {
                    await commitPanel.refresh();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShowHistory",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const history = await gitOps.getFileHistory(ctx.filePath);
                    const doc = await vscode.workspace.openTextDocument({
                        content: history || "No history found.",
                        language: "git-commit",
                    });
                    await vscode.window.showTextDocument(doc, { preview: true });
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to load file history:", error);
                    vscode.window.showErrorMessage(`Show history failed: ${message}`);
                }
            },
        ),
        vscode.commands.registerCommand("intelligit.fileRefresh", async () => {
            await commitPanel.refresh();
        }),
        vscode.commands.registerCommand("intelligit.fileRefreshing", () => {
            // No-op: visual-only command shown while refreshing (disabled via enablement).
        }),
    );

    // --- Initial load ---

    currentBranches = await gitOps.getBranches();
    commitGraph.setBranches(currentBranches);

    // Eagerly fetch file count so the activity bar badge shows immediately.
    // commitPanel.refresh() runs getStatus() and fires onDidChangeFileCount,
    // which updateBadge() picks up to set the tree view badge.
    commitPanel.refresh().catch((err) => {
        console.error("Initial commit panel refresh failed:", err);
    });

    // --- Auto-refresh on file changes ---

    // Light refresh: working tree changes -> commit panel only
    let lightTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedLightRefresh = () => {
        if (lightTimer) clearTimeout(lightTimer);
        lightTimer = setTimeout(async () => {
            await commitPanel.refresh();
        }, 300);
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(debouncedLightRefresh),
        vscode.workspace.onDidSaveTextDocument(debouncedLightRefresh),
        vscode.workspace.onDidCreateFiles(debouncedLightRefresh),
        vscode.workspace.onDidDeleteFiles(debouncedLightRefresh),
        vscode.workspace.onDidRenameFiles(debouncedLightRefresh),
    );

    // Full refresh: git state changes -> branches + commit graph + commit panel
    let fullTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedFullRefresh = () => {
        if (fullTimer) clearTimeout(fullTimer);
        fullTimer = setTimeout(async () => {
            currentBranches = await gitOps.getBranches();
            commitGraph.setBranches(currentBranches);
            await commitGraph.refresh();
            await commitPanel.refresh();
        }, 500);
    };

    // VS Code's file watcher excludes .git/ by default, so use Node's fs.watch
    // to detect git state changes (new commits, branch changes, fetches)
    const gitDir = path.join(repoRoot, ".git");
    const gitStateFiles = new Set([
        "HEAD",
        "FETCH_HEAD",
        "packed-refs",
        "MERGE_HEAD",
        "REBASE_HEAD",
    ]);
    const fsWatchers: fs.FSWatcher[] = [];

    try {
        const dirWatcher = fs.watch(gitDir, (_event, filename) => {
            if (filename && gitStateFiles.has(filename)) {
                debouncedFullRefresh();
            }
        });
        fsWatchers.push(dirWatcher);
    } catch {
        /* .git dir may not be watchable */
    }

    try {
        const refsWatcher = fs.watch(path.join(gitDir, "refs"), { recursive: true }, () =>
            debouncedFullRefresh(),
        );
        fsWatchers.push(refsWatcher);
    } catch {
        /* refs dir may not exist yet */
    }

    context.subscriptions.push(new vscode.Disposable(() => fsWatchers.forEach((w) => w.close())));

    // --- Disposables ---

    context.subscriptions.push(commitGraph, commitInfo, commitPanel);
}

export function deactivate(): void {}
