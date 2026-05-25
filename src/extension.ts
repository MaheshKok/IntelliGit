// Extension entry point. Registers coordinated IntelliGit webviews:
// commit graph (with integrated branch column/details) and commit panel.
// The extension host is the sole data coordinator -- views never talk directly.

import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "./git/executor";
import { GitOps } from "./git/operations";
import { CommitGraphViewProvider } from "./views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "./views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "./views/CommitPanelViewProvider";
import { MergeConflictSessionPanel } from "./views/MergeConflictSessionPanel";
import { MergeConflictsTreeProvider } from "./views/MergeConflictsTreeProvider";
import { UndockedViewProvider } from "./views/UndockedViewProvider";
import type { Branch } from "./types";
import { getErrorMessage } from "./utils/errors";
import { assertRepoRelativePath, deleteFileWithFallback } from "./utils/fileOps";
import { handleCommitContextAction } from "./commands/commitCommands";
import { createBranchCommands } from "./commands/branchCommands";
import { RefreshService } from "./services/refreshService";
import {
    openJetBrainsMergeToolForFile,
    getJetBrainsMergeToolPath,
    getPreferExternalMergeTool,
    detectAndPickJetBrainsMergeToolPath,
} from "./services/jetbrainsMergeService";
import {
    compareEditorFileWithBranch,
    compareEditorFileWithRevision,
    compareCommitInfoFileWithLocal,
    applySelectedCommitFileChange,
    openCommitFileDiff,
} from "./services/diffService";
import { runWithNotificationProgress } from "./utils/notifications";
import { discoverGitRepositories, type DiscoveredRepository } from "./services/repositoryDiscovery";

const SELECTED_REPOSITORY_KEY = "intelligit.selectedRepositoryRoot";
const NO_REPOSITORY_MESSAGE = "No Git repositories found in this workspace.";

class EmptyIntelliGitWebviewProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly title: string,
        private readonly message: string,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        webviewView.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.title}</title>
    <style>
        body {
            margin: 0;
            padding: 12px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
    </style>
</head>
<body>${this.message}</body>
</html>`;
    }
}

function workspaceRoots(): string[] {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

function selectInitialRepository(
    repositories: DiscoveredRepository[],
    storedRoot: string | undefined,
): DiscoveredRepository {
    return repositories.find((repo) => repo.root === storedRoot) ?? repositories[0];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) return;

    let repositories = await discoverGitRepositories(workspaceRoots());
    if (repositories.length === 0) {
        const emptyTreeProvider: vscode.TreeDataProvider<never> = {
            getTreeItem: () => {
                throw new Error("unreachable");
            },
            getChildren: () => [],
        };
        context.subscriptions.push(
            vscode.window.createTreeView("intelligit.fileCountBadge", {
                treeDataProvider: emptyTreeProvider,
            }),
            vscode.window.createTreeView("intelligit.mergeConflicts", {
                treeDataProvider: emptyTreeProvider,
            }),
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.viewType,
                new EmptyIntelliGitWebviewProvider("IntelliGit", NO_REPOSITORY_MESSAGE),
            ),
            vscode.window.registerWebviewViewProvider(
                CommitPanelViewProvider.viewType,
                new EmptyIntelliGitWebviewProvider("Commit", NO_REPOSITORY_MESSAGE),
            ),
            vscode.commands.registerCommand("intelligit.selectRepository", async () => {
                repositories = await discoverGitRepositories(workspaceRoots());
                if (repositories.length === 0) {
                    vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
                    return;
                }
                vscode.window.showInformationMessage(
                    "Git repositories found. Reload the window to activate IntelliGit for them.",
                );
            }),
            vscode.commands.registerCommand("intelligit.showGitLog", async () => {
                await vscode.commands.executeCommand("intelligit.commitGraph.focus");
            }),
        );
        void vscode.commands.executeCommand("setContext", "intelligit.hasMergeConflicts", false);
        return;
    }

    let activeRepository = selectInitialRepository(
        repositories,
        context.workspaceState?.get<string>(SELECTED_REPOSITORY_KEY),
    );
    let repoRoot = activeRepository.root;
    const executor = new GitExecutor(repoRoot);
    const gitOps = new GitOps(executor);

    // Cached branch list for webview context menu lookups
    let currentBranches: Branch[] = [];
    let commitDetailRequestSeq = 0;

    // --- Providers ---

    let repoRootUri = vscode.Uri.file(repoRoot);
    const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps);
    const commitInfo = new CommitInfoViewProvider(context.extensionUri);
    const commitPanel = new CommitPanelViewProvider(
        context.extensionUri,
        gitOps,
        repoRootUri,
        context.workspaceState,
    );
    const mergeConflicts = new MergeConflictsTreeProvider(gitOps, repoRootUri);
    commitGraph.setRepositoryLabel(activeRepository.label);
    commitPanel.setRepositoryLabel(activeRepository.label);

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
    const mergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
        treeDataProvider: mergeConflicts,
    });

    const updateBadge = (count: number) => {
        badgeView.badge =
            count > 0
                ? { tooltip: `${count} changed file${count !== 1 ? "s" : ""}`, value: count }
                : undefined;
    };

    // --- Refresh service ---

    const createRefreshService = (root: string): RefreshService =>
        new RefreshService(
            {
                gitOps,
                commitGraph,
                commitPanel,
                mergeConflicts,
                mergeConflictsView,
                onBranchesUpdated: (branches) => {
                    currentBranches = branches;
                },
            },
            root,
        );

    let refreshService = createRefreshService(repoRoot);

    const clearSelection = () => {
        commitGraph.clearCommitDetail();
        commitInfo.clear();
    };

    const refreshActiveRepository = async (): Promise<void> => {
        currentBranches = await gitOps.getBranches();
        commitGraph.setBranches(currentBranches);
        await commitGraph.refresh();
        await commitPanel.refresh();
        await refreshService.refreshMergeConflicts();
        await clearSelection();
    };

    const setActiveRepository = async (repository: DiscoveredRepository): Promise<void> => {
        activeRepository = repository;
        repoRoot = repository.root;
        repoRootUri = vscode.Uri.file(repoRoot);

        executor.setRoot(repoRoot);
        commitGraph.setRepositoryLabel(repository.label);
        commitPanel.setRepositoryRootUri(repoRootUri);
        commitPanel.setRepositoryLabel(repository.label);
        mergeConflicts.setWorkspaceRoot(repoRootUri);
        refreshService.dispose();
        refreshService = createRefreshService(repoRoot);
        refreshService.registerFileWatchers();
        await context.workspaceState?.update(SELECTED_REPOSITORY_KEY, repoRoot);
        await refreshActiveRepository();
        if (undocked) {
            undocked.setRepositoryRootUri(repoRootUri);
            undocked.setRepositoryLabel(repository.label);
            undocked.setBranches(currentBranches);
            await undocked.refresh();
        }
    };

    // --- Merge conflict helpers ---

    const openBuiltInMergeEditorForFile = async (filePath: string): Promise<void> => {
        const fileUri = vscode.Uri.file(path.join(repoRoot, assertRepoRelativePath(filePath)));
        try {
            await vscode.commands.executeCommand("git.openMergeEditor", fileUri);
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showWarningMessage(
                `VS Code merge editor command failed (${message}). Opening the file instead.`,
            );
            await vscode.commands.executeCommand("vscode.open", fileUri);
        }
    };

    const openMergeConflictForFile = async (filePath: string): Promise<void> => {
        const preferExternal = getPreferExternalMergeTool();

        if (preferExternal && getJetBrainsMergeToolPath()) {
            const opened = await openJetBrainsMergeToolForFile(
                filePath,
                repoRoot,
                gitOps,
                () => refreshService.refreshConflictUi(),
                openBuiltInMergeEditorForFile,
            );
            if (opened) return;
        }
        await openBuiltInMergeEditorForFile(filePath);
    };

    const openConflictSession = async (labels?: {
        sourceBranch?: string;
        targetBranch?: string;
    }): Promise<void> => {
        await MergeConflictSessionPanel.open(context.extensionUri, gitOps, labels ?? {}, {
            onOpenMergeConflict: async (filePath) => {
                await openMergeConflictForFile(filePath);
            },
            onConflictStateChanged: async () => {
                await refreshService.refreshConflictUi();
            },
        });
    };

    let undocked: UndockedViewProvider | undefined;

    const showUndockedGitLog = async (): Promise<void> => {
        if (undocked) {
            undocked.reveal();
            return;
        }

        undocked = new UndockedViewProvider(
            context.extensionUri,
            gitOps,
            repoRootUri,
            context.workspaceState,
        );
        undocked.setRepositoryLabel(activeRepository.label);
        context.subscriptions.push(undocked);

        context.subscriptions.push(
            undocked.onDidDispose(async () => {
                undocked = undefined;
            }),
            undocked.onDockRequested(async () => {
                await dockIntelliGit();
            }),
            undocked.onCommitSelected(async (hash) => {
                const requestId = ++commitDetailRequestSeq;
                try {
                    const detail = await gitOps.getCommitDetail(hash);
                    if (requestId !== commitDetailRequestSeq) return;
                    undocked?.setCommitDetail(detail);
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Failed to load commit: ${msg}`);
                }
            }),
            undocked.onBranchAction(({ action, branchName }) => {
                const branch = currentBranches.find((b) => b.name === branchName);
                if (!branch) return;
                vscode.commands.executeCommand(`intelligit.${action}`, { branch });
            }),
            undocked.onCommitAction(async ({ action, hash }) => {
                try {
                    await handleCommitContextAction({
                        action,
                        hash,
                        executor,
                        gitOps,
                        repoRoot,
                        currentBranches,
                        refreshAll: () => undocked?.refresh() ?? Promise.resolve(),
                    });
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error(`Commit action '${action}' failed:`, error);
                    vscode.window.showErrorMessage(`Commit action failed: ${message}`);
                }
            }),
            undocked.onOpenCommitFileDiff(async (params) => {
                try {
                    await openCommitFileDiff(
                        params.commitHash,
                        params.filePath,
                        repoRoot,
                        gitOps,
                        executor,
                    );
                } catch (error) {
                    const message = getErrorMessage(error);
                    vscode.window.showErrorMessage(`Failed to open commit diff: ${message}`);
                }
            }),
            undocked.onDidChangeFileCount(updateBadge),
        );

        const panel = undocked;
        await panel.open();
        if (undocked !== panel) return;
        currentBranches = await gitOps.getBranches();
        if (undocked !== panel) return;
        panel.setBranches(currentBranches);
        await panel.refresh();
    };

    async function dockIntelliGit(): Promise<void> {
        await vscode.workspace
            .getConfiguration("intelligit")
            .update("undockableWindow", false, true);
        undocked?.dispose();
        undocked = undefined;
        await vscode.commands.executeCommand("intelligit.commitPanel.focus");
        await vscode.commands.executeCommand("intelligit.commitGraph.focus");
    }

    // --- Register view providers ---

    context.subscriptions.push(
        badgeView,
        mergeConflictsView,
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
                commitGraph.setCommitDetail(detail);
                commitInfo.setCommitDetail(detail);
            } catch (err) {
                const msg = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to load commit: ${msg}`);
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onBranchFilterChanged(() => {
            commitGraph.clearCommitDetail();
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
                await handleCommitContextAction({
                    action,
                    hash,
                    executor,
                    gitOps,
                    repoRoot,
                    currentBranches,
                    refreshAll: () => refreshService.refreshAll(),
                });
            } catch (error) {
                const message = getErrorMessage(error);
                console.error(`Commit action '${action}' failed:`, error);
                vscode.window.showErrorMessage(`Commit action failed: ${message}`);
            }
        }),
    );

    const handleOpenCommitFileDiff = async (params: {
        commitHash: string;
        filePath: string;
    }): Promise<void> => {
        try {
            await openCommitFileDiff(
                params.commitHash,
                params.filePath,
                repoRoot,
                gitOps,
                executor,
            );
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to open commit diff: ${message}`);
        }
    };

    context.subscriptions.push(
        commitGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitInfo.onOpenCommitFileDiff(handleOpenCommitFileDiff),
    );

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.refresh", async () => {
            await refreshActiveRepository();
        }),

        vscode.commands.registerCommand("intelligit.selectRepository", async () => {
            repositories = await discoverGitRepositories(workspaceRoots());
            if (repositories.length === 0) {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
                return;
            }
            const picked = await vscode.window.showQuickPick(
                repositories.map((repo) => ({
                    label: repo.label,
                    description: repo.root === repoRoot ? "Active" : repo.root,
                    repository: repo,
                })),
                { placeHolder: "Select IntelliGit repository" },
            );
            if (!picked) return;
            await setActiveRepository(picked.repository);
        }),

        vscode.commands.registerCommand(
            "intelligit.filterByBranch",
            async (branchName?: string) => {
                await commitGraph.filterByBranch(branchName ?? null);
                await clearSelection();
            },
        ),

        vscode.commands.registerCommand("intelligit.showGitLog", async () => {
            const useUndockedWindow = vscode.workspace
                .getConfiguration("intelligit")
                .get<boolean>("undockableWindow", false);
            if (useUndockedWindow) {
                await showUndockedGitLog();
                return;
            }
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
        }),

        vscode.commands.registerCommand("intelligit.openUndocked", async () => {
            await vscode.workspace
                .getConfiguration("intelligit")
                .update("undockableWindow", true, true);
            await showUndockedGitLog();
        }),

        vscode.commands.registerCommand("intelligit.dockWindow", dockIntelliGit),

        vscode.commands.registerCommand("intelligit.mergeConflictsRefresh", async () => {
            await refreshService.refreshMergeConflicts();
        }),

        vscode.commands.registerCommand("intelligit.toggleUndocked", async () => {
            const config = vscode.workspace.getConfiguration("intelligit");
            const nextValue = !config.get<boolean>("undockableWindow", false);
            if (nextValue) {
                await config.update("undockableWindow", true, true);
                await showUndockedGitLog();
            } else {
                await dockIntelliGit();
            }
        }),
    );

    const isFilePathContext = (value: unknown): value is { filePath: string } => {
        return (
            !!value &&
            typeof value === "object" &&
            "filePath" in value &&
            typeof value.filePath === "string"
        );
    };

    const resolveConflictPath = (ctx: unknown): string | null =>
        isFilePathContext(ctx) ? ctx.filePath : null;

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openMergeConflict", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            await openMergeConflictForFile(filePath);
        }),
        vscode.commands.registerCommand("intelligit.compareWithRevision", async (ctx?: unknown) => {
            await compareEditorFileWithRevision(ctx, repoRoot, gitOps);
        }),
        vscode.commands.registerCommand("intelligit.compareWithBranch", async (ctx?: unknown) => {
            await compareEditorFileWithBranch(ctx, repoRoot, gitOps);
        }),
        vscode.commands.registerCommand("intelligit.openConflictSession", async () => {
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) {
                vscode.window.showInformationMessage("No unresolved merge conflicts found.");
                return;
            }
            await openConflictSession();
        }),
        vscode.commands.registerCommand("intelligit.detectJetBrainsMergeTool", async () => {
            await detectAndPickJetBrainsMergeToolPath();
        }),
        vscode.commands.registerCommand(
            "intelligit.openMergeConflictInJetBrains",
            async (ctx: unknown) => {
                const filePath = resolveConflictPath(ctx);
                if (!filePath) return;
                await openJetBrainsMergeToolForFile(
                    filePath,
                    repoRoot,
                    gitOps,
                    () => refreshService.refreshConflictUi(),
                    openBuiltInMergeEditorForFile,
                );
            },
        ),
        vscode.commands.registerCommand("intelligit.conflictAcceptYours", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            try {
                await runWithNotificationProgress(
                    `Accepting yours for ${filePath}...`,
                    async () => {
                        await gitOps.acceptConflictSide(filePath, "ours");
                    },
                );
                vscode.window.showInformationMessage(`Accepted yours for ${filePath}`);
                await refreshService.refreshConflictUi();
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Accept yours failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand("intelligit.conflictAcceptTheirs", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            try {
                await runWithNotificationProgress(
                    `Accepting theirs for ${filePath}...`,
                    async () => {
                        await gitOps.acceptConflictSide(filePath, "theirs");
                    },
                );
                vscode.window.showInformationMessage(`Accepted theirs for ${filePath}`);
                await refreshService.refreshConflictUi();
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Accept theirs failed: ${message}`);
            }
        }),
    );

    // --- Branch action commands ---

    const branchCommands = createBranchCommands({
        executor,
        gitOps,
        getCurrentBranchName: () => currentBranches.find((b) => b.isCurrent)?.name,
        getCurrentBranches: () => currentBranches,
        openConflictSession,
        refreshConflictUi: () => refreshService.refreshConflictUi(),
    });

    for (const cmd of branchCommands) {
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
            "intelligit.commitFileCompareWithLocal",
            async (ctx: unknown) => {
                await compareCommitInfoFileWithLocal(ctx, repoRoot, gitOps);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileCherryPickChange",
            async (ctx: unknown) => {
                await applySelectedCommitFileChange(ctx, "cherry-pick", executor, () =>
                    refreshService.refreshConflictUi(),
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileRevertChange",
            async (ctx: unknown) => {
                await applySelectedCommitFileChange(ctx, "revert", executor, () =>
                    refreshService.refreshConflictUi(),
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileRollback",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    const confirm = await vscode.window.showWarningMessage(
                        `Rollback ${safePath}?`,
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await gitOps.rollbackFiles([safePath]);
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
                const uri = vscode.Uri.file(
                    path.join(repoRoot, assertRepoRelativePath(ctx.filePath)),
                );
                await vscode.window.showTextDocument(uri);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileDelete",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    const confirm = await vscode.window.showWarningMessage(
                        `Delete ${safePath}?`,
                        { modal: true },
                        "Delete",
                    );
                    if (confirm !== "Delete") return;

                    const deleted = await deleteFileWithFallback(
                        gitOps,
                        vscode.Uri.file(repoRoot),
                        safePath,
                    );
                    if (deleted) {
                        vscode.window.showInformationMessage(`Deleted ${safePath}`);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(
                        `Delete failed for '${ctx.filePath}': ${message}`,
                    );
                } finally {
                    await commitPanel.refresh();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShelve",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    await gitOps.shelveSave([safePath]);
                    vscode.window.showInformationMessage(`Shelved ${safePath}.`);
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
                    const safePath = assertRepoRelativePath(ctx.filePath);
                    const history = await gitOps.getFileHistory(safePath);
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
    commitPanel.refresh().catch((err) => {
        console.error("Initial commit panel refresh failed:", err);
    });
    refreshService.refreshMergeConflicts().catch((err) => {
        console.error("Initial merge conflicts refresh failed:", err);
    });

    // --- Auto-refresh on file changes ---

    refreshService.registerFileWatchers();

    // --- Disposables ---

    context.subscriptions.push(
        { dispose: () => refreshService.dispose() },
        commitGraph,
        commitInfo,
        commitPanel,
        mergeConflicts,
    );
}

export function deactivate(): void {}
