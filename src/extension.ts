// Extension entry point. Registers three coordinated views: sidebar branch tree,
// bottom-panel commit graph (webview), and bottom-panel changed files + commit details (webview).
// The extension host is the sole data coordinator -- views never talk directly.

import * as vscode from "vscode";
import { GitExecutor } from "./git/executor";
import { GitOps } from "./git/operations";
import { BranchTreeProvider, BranchItem } from "./views/BranchTreeProvider";
import { CommitGraphViewProvider } from "./views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "./views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "./views/CommitPanelViewProvider";
import type { Branch } from "./types";

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

    // --- Providers ---

    const branchTree = new BranchTreeProvider();
    const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps);
    const commitInfo = new CommitInfoViewProvider();
    const commitPanel = new CommitPanelViewProvider(context.extensionUri, gitOps);

    // --- Register views ---

    const branchTreeView = vscode.window.createTreeView("intelligit.branches", {
        treeDataProvider: branchTree,
    });

    context.subscriptions.push(
        branchTreeView,
        vscode.window.registerWebviewViewProvider(CommitGraphViewProvider.viewType, commitGraph),
        vscode.window.registerWebviewViewProvider(CommitInfoViewProvider.viewType, commitInfo),
        vscode.window.registerWebviewViewProvider(CommitPanelViewProvider.viewType, commitPanel),
    );

    // --- Activity bar badge (file count) ---

    context.subscriptions.push(
        commitPanel.onDidChangeFileCount((count) => {
            branchTreeView.badge =
                count > 0
                    ? { value: count, tooltip: `${count} file${count !== 1 ? "s" : ""} changed` }
                    : undefined;
        }),
    );

    // --- Wire data flow ---

    context.subscriptions.push(
        commitGraph.onCommitSelected(async (hash) => {
            try {
                const detail = await gitOps.getCommitDetail(hash);
                commitInfo.setCommitDetail(detail);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to load commit: ${message}`);
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onBranchFilterChanged(() => {
            commitInfo.clear();
        }),
    );

    // Forward branch actions from webview context menu to VS Code commands
    context.subscriptions.push(
        commitGraph.onBranchAction(({ action, branchName }) => {
            const branch = currentBranches.find((b) => b.name === branchName);
            if (!branch) return;
            const item = new BranchItem(branch.name, "branch", branch);
            vscode.commands.executeCommand(`intelligit.${action}`, item);
        }),
    );

    // --- Helper ---

    const clearSelection = () => {
        commitInfo.clear();
    };

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.refresh", async () => {
            currentBranches = await gitOps.getBranches();
            branchTree.refresh(currentBranches);
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
            await vscode.commands.executeCommand("intelligit.branches.focus");
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
        }),
    );

    // --- Branch action commands ---

    const branchActionCommands: Array<{
        id: string;
        handler: (item: BranchItem) => Promise<void>;
    }> = [
        {
            id: "intelligit.checkout",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                try {
                    await executor.run(["checkout", name]);
                    vscode.window.showInformationMessage(`Checked out ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
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
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Failed to create branch: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.checkoutAndRebase",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                try {
                    await executor.run(["rebase", "HEAD", name]);
                    await executor.run(["checkout", name]);
                    vscode.window.showInformationMessage(`Checked out and rebased ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Checkout and rebase failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.compareWithCurrent",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                try {
                    const diff = await executor.run(["diff", "--stat", `HEAD...${name}`]);
                    const doc = await vscode.workspace.openTextDocument({
                        content: diff || "No differences.",
                        language: "diff",
                    });
                    await vscode.window.showTextDocument(doc);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Compare failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.showDiffWithWorkingTree",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                try {
                    const diff = await executor.run(["diff", name]);
                    const doc = await vscode.workspace.openTextDocument({
                        content: diff || "No differences.",
                        language: "diff",
                    });
                    await vscode.window.showTextDocument(doc);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Diff failed: ${msg}`);
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
                    const msg = err instanceof Error ? err.message : String(err);
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
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Merge failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.updateBranch",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                try {
                    await executor.run(["fetch", "--all"]);
                    if (item.branch?.isCurrent) {
                        await executor.run(["pull", "--ff-only"]);
                    }
                    vscode.window.showInformationMessage(`Updated ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Update failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.pushBranch",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                try {
                    await executor.run(["push", "-u", "origin", name]);
                    vscode.window.showInformationMessage(`Pushed ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
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
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Rename failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.deleteBranch",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Delete branch ${name}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                try {
                    if (item.branch?.isRemote && item.branch?.remote) {
                        const remoteBranch = name.split("/").slice(1).join("/");
                        await executor.run(["push", item.branch.remote, "--delete", remoteBranch]);
                    } else {
                        await executor.run(["branch", "-d", name]);
                    }
                    vscode.window.showInformationMessage(`Deleted ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Delete failed: ${msg}`);
                }
            },
        },
    ];

    for (const cmd of branchActionCommands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, (item: BranchItem) => cmd.handler(item)),
        );
    }

    // --- Initial load ---

    currentBranches = await gitOps.getBranches();
    branchTree.refresh(currentBranches);
    commitGraph.setBranches(currentBranches);

    // --- Auto-refresh on file changes ---

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedRefresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
            await commitPanel.refresh();
        }, 300);
    };

    const gitWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    context.subscriptions.push(
        gitWatcher,
        gitWatcher.onDidChange(debouncedRefresh),
        gitWatcher.onDidCreate(debouncedRefresh),
        gitWatcher.onDidDelete(debouncedRefresh),
        vscode.workspace.onDidSaveTextDocument(debouncedRefresh),
    );

    // --- Disposables ---

    context.subscriptions.push(branchTree, commitGraph, commitInfo, commitPanel);
}

export function deactivate(): void {}
