// Extension entry point. Registers three coordinated views: sidebar branch tree,
// bottom-panel commit graph (webview), and bottom-panel changed files + commit details (webview).
// The extension host is the sole data coordinator -- views never talk directly.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
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
    let commitDetailRequestSeq = 0;

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
            const requestId = ++commitDetailRequestSeq;
            try {
                const detail = await gitOps.getCommitDetail(hash);
                if (requestId !== commitDetailRequestSeq) return;
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

    const getCurrentBranchName = () => currentBranches.find((b) => b.isCurrent)?.name;

    const getLocalNameFromRemote = (remoteBranchName: string) =>
        remoteBranchName.split("/").slice(1).join("/");

    const checkoutBranch = async (branch: Branch): Promise<string> => {
        if (!branch.isRemote) {
            await executor.run(["checkout", branch.name]);
            return branch.name;
        }

        const localName = getLocalNameFromRemote(branch.name);
        const existingLocal = currentBranches.find(
            (b) => !b.isRemote && b.name === localName,
        );
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
                const branch = item.branch;
                if (!branch) return;
                try {
                    const checkedOut = await checkoutBranch(branch);
                    vscode.window.showInformationMessage(`Checked out ${checkedOut}`);
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
                const branch = item.branch;
                if (!branch || branch.isRemote) return;
                try {
                    const remote = await resolveRemoteName(branch);
                    if (branch.isCurrent) {
                        if (branch.remote) {
                            await executor.run(["push", branch.remote, branch.name]);
                        } else {
                            await executor.run(["push"]);
                        }
                    } else {
                        if (!remote) {
                            vscode.window.showErrorMessage(
                                `No remote configured for branch ${branch.name}.`,
                            );
                            return;
                        }
                        await executor.run(["push", "-u", remote, branch.name]);
                    }
                    vscode.window.showInformationMessage(`Pushed ${branch.name}`);
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
                await gitOps.rollbackFiles([ctx.filePath]);
                vscode.window.showInformationMessage("Changes rolled back.");
                await commitPanel.refresh();
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileJumpToSource",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const uri = vscode.Uri.joinPath(
                    vscode.workspace.workspaceFolders![0].uri,
                    ctx.filePath,
                );
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
                try {
                    await gitOps.deleteFile(ctx.filePath);
                } catch {
                    const uri = vscode.Uri.joinPath(
                        vscode.workspace.workspaceFolders![0].uri,
                        ctx.filePath,
                    );
                    await vscode.workspace.fs.delete(uri);
                }
                vscode.window.showInformationMessage(`Deleted ${ctx.filePath}`);
                await commitPanel.refresh();
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShelve",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const name = await vscode.window.showInputBox({
                    prompt: "Shelf name",
                    value: "Shelved changes",
                });
                if (name === undefined) return;
                await gitOps.stashSave(name || "Shelved changes", [ctx.filePath]);
                vscode.window.showInformationMessage("Changes shelved.");
                await commitPanel.refresh();
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShowHistory",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const history = await gitOps.getFileHistory(ctx.filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: history || "No history found.",
                    language: "git-commit",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            },
        ),
        vscode.commands.registerCommand("intelligit.fileRefresh", async () => {
            await commitPanel.refresh();
        }),
    );

    // --- Initial load ---

    currentBranches = await gitOps.getBranches();
    branchTree.refresh(currentBranches);
    commitGraph.setBranches(currentBranches);

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
            branchTree.refresh(currentBranches);
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

    context.subscriptions.push(branchTree, commitGraph, commitInfo, commitPanel);
}

export function deactivate(): void {}
