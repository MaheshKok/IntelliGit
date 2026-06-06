import * as path from "path";
import * as vscode from "vscode";
import { handleCommitContextAction } from "../commands/commitCommands";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { Branch } from "../types";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import {
    getJetBrainsMergeToolPath,
    getPreferExternalMergeTool,
    openJetBrainsMergeToolForFile,
} from "../services/jetbrainsMergeService";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "../views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { MergeConflictSessionPanel } from "../views/MergeConflictSessionPanel";
import { MergeConflictsTreeProvider } from "../views/MergeConflictsTreeProvider";
import { RefreshService } from "../views/RefreshService";
import { UndockedViewProvider } from "../views/UndockedViewProvider";
import {
    type RepositoryViewProviders,
    SELECTED_REPOSITORY_KEY,
    selectInitialRepository,
} from "./common";
import { registerRepositoryCommands } from "./repositoryCommands";
import {
    createOpenCommitFileDiffHandler,
    registerRepositoryViewEvents,
} from "./repositoryViewEvents";

export async function activateRepositoryMode(
    context: vscode.ExtensionContext,
    repositoriesForActivation: DiscoveredRepository[],
    viewProviders: RepositoryViewProviders = {},
): Promise<void> {
    let repositories = repositoriesForActivation;
    let activeRepository = selectInitialRepository(
        repositories,
        context.workspaceState?.get<string>(SELECTED_REPOSITORY_KEY),
    );
    let repoRoot = activeRepository.root;
    const executor = new GitExecutor(repoRoot);
    const gitOps = new GitOps(executor);

    let currentBranches: Branch[] = [];
    let undockedCommitDetailRequestSeq = 0;
    let repoRootUri = vscode.Uri.file(repoRoot);
    let undocked: UndockedViewProvider | undefined;

    const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps);
    const sidebarGraph = new CommitGraphViewProvider(context.extensionUri, gitOps, {
        scriptFile: "webview-compactcommitgraph.js",
        title: vscode.l10n.t("Graph"),
    });
    const commitInfo = new CommitInfoViewProvider(context.extensionUri);
    const commitPanel = new CommitPanelViewProvider(
        context.extensionUri,
        gitOps,
        repoRootUri,
        context.workspaceState,
    );
    const mergeConflicts = new MergeConflictsTreeProvider(gitOps, repoRootUri);

    commitGraph.setRepositoryLabel(activeRepository.label);
    sidebarGraph.setRepositoryLabel(activeRepository.label);
    commitPanel.setRepositoryLabel(activeRepository.label);

    const mergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
        treeDataProvider: mergeConflicts,
    });
    const fileCountBadgeView = createFileCountBadgeView();
    const updateFileCountBadge = (count: number): void => {
        fileCountBadgeView.badge =
            count > 0
                ? {
                      tooltip:
                          count === 1
                              ? vscode.l10n.t("{count} changed file", { count })
                              : vscode.l10n.t("{count} changed files", { count }),
                      value: count,
                  }
                : undefined;
    };
    const resetFileCountBadge = (): void => updateFileCountBadge(0);
    resetFileCountBadge();
    const fileCountBadgeSubscription = commitPanel.onDidChangeFileCount(updateFileCountBadge);

    const createRefreshService = (root: string): RefreshService =>
        new RefreshService(
            {
                gitOps,
                commitGraph,
                additionalCommitGraphs: [sidebarGraph],
                commitPanel,
                mergeConflicts,
                mergeConflictsView,
                onBranchesUpdated: (branches) => {
                    currentBranches = branches;
                },
                getUndocked: () => undocked,
            },
            root,
        );

    let refreshService = createRefreshService(repoRoot);
    const getRefreshService = (): RefreshService => refreshService;
    const getRepoRoot = (): string => repoRoot;
    const getCurrentBranches = (): Branch[] => currentBranches;
    const getCurrentBranchName = (): string | undefined =>
        currentBranches.find((b) => b.isCurrent)?.name;

    const clearSelection = (): void => {
        commitGraph.clearCommitDetail();
        sidebarGraph.clearCommitDetail();
        commitInfo.clear();
    };

    const refreshActiveRepository = async (): Promise<void> => {
        currentBranches = await gitOps.getBranches();
        commitGraph.setBranches(currentBranches);
        sidebarGraph.setBranches(currentBranches);
        commitPanel.setBranches(currentBranches);
        await Promise.all([commitGraph.refresh(), sidebarGraph.refresh()]);
        await commitPanel.refresh();
        if (undocked) {
            undocked.setBranches(currentBranches);
            await undocked.refresh();
        }
        await refreshService.refreshMergeConflicts();
        clearSelection();
    };

    const setActiveRepository = async (repository: DiscoveredRepository): Promise<void> => {
        activeRepository = repository;
        repoRoot = repository.root;
        repoRootUri = vscode.Uri.file(repoRoot);

        executor.setRoot(repoRoot);
        commitGraph.setRepositoryLabel(repository.label);
        sidebarGraph.setRepositoryLabel(repository.label);
        commitPanel.setRepositoryRootUri(repoRootUri);
        commitPanel.setRepositoryLabel(repository.label);
        if (undocked) {
            undocked.setRepositoryRootUri(repoRootUri);
            undocked.setRepositoryLabel(repository.label);
        }
        mergeConflicts.setWorkspaceRoot(repoRootUri);
        resetFileCountBadge();
        refreshService.dispose();
        refreshService = createRefreshService(repoRoot);
        refreshService.registerFileWatchers();
        await context.workspaceState?.update(SELECTED_REPOSITORY_KEY, repoRoot);
        await refreshActiveRepository();
    };

    const openBuiltInMergeEditorForFile = async (filePath: string): Promise<void> => {
        const fileUri = vscode.Uri.file(path.join(repoRoot, assertRepoRelativePath(filePath)));
        try {
            await vscode.commands.executeCommand("git.openMergeEditor", fileUri);
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "VS Code merge editor command failed ({message}). Opening the file instead.",
                    { message },
                ),
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

    type UndockTarget = "editorTab" | "newWindow";
    const handleOpenCommitFileDiff = createOpenCommitFileDiffHandler({
        executor,
        gitOps,
        getRepoRoot,
    });

    const ensureUndockedPanel = (): UndockedViewProvider => {
        if (undocked) return undocked;

        undocked = new UndockedViewProvider(
            context.extensionUri,
            gitOps,
            repoRootUri,
            context.workspaceState,
        );
        undocked.setRepositoryLabel(activeRepository.label);
        context.subscriptions.push(undocked);

        context.subscriptions.push(
            undocked.onDidDispose(() => {
                undocked = undefined;
            }),
            undocked.onDockRequested(async () => {
                await dockIntelliGit();
            }),
            undocked.onCommitSelected(async (hash) => {
                const requestId = ++undockedCommitDetailRequestSeq;
                try {
                    const detail = await gitOps.getCommitDetail(hash);
                    if (requestId !== undockedCommitDetailRequestSeq) return;
                    undocked?.setCommitDetail(detail);
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Failed to load commit: {message}", { message: msg }),
                    );
                }
            }),
            undocked.onBranchAction(({ action, branchName }) => {
                const branch = currentBranches.find((b) => b.name === branchName);
                if (!branch) return;
                void vscode.commands.executeCommand(`intelligit.${action}`, { branch });
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
                        refreshAll: () => refreshService.refreshAll(),
                    });
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error(`Commit action '${action}' failed:`, error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Commit action failed: {message}", { message }),
                    );
                }
            }),
            undocked.onOpenCommitFileDiff(handleOpenCommitFileDiff),
            undocked.onDidChangeWorkingTree(() => {
                commitPanel.refresh().catch((err) => {
                    console.error("[IntelliGit] Docked commit panel refresh failed:", err);
                });
                commitGraph.refresh().catch((err) => {
                    console.error("[IntelliGit] Docked commit graph refresh failed:", err);
                });
            }),
            undocked.onDidChangeFileCount(updateFileCountBadge),
        );

        return undocked;
    };

    const loadUndockedData = async (): Promise<void> => {
        if (!undocked) return;
        currentBranches = await gitOps.getBranches();
        if (!undocked) return;
        undocked.setBranches(currentBranches);
        await undocked.refresh();
    };

    const showUndockedGitLog = async (options?: { deferDataLoad?: boolean }): Promise<void> => {
        if (undocked) {
            undocked.reveal();
            return;
        }

        const panel = ensureUndockedPanel();
        panel.open();
        if (undocked !== panel) return;

        if (!options?.deferDataLoad) {
            await loadUndockedData();
        }
    };

    const openUndockedIntelliGit = async (target: UndockTarget): Promise<void> => {
        if (undocked) {
            undocked.reveal();
            return;
        }

        await vscode.workspace
            .getConfiguration("intelligit")
            .update("undockableWindow", true, true);

        const deferDataLoad = target === "newWindow";
        await showUndockedGitLog({ deferDataLoad });

        if (target === "newWindow") {
            await moveUndockedEditorToNewWindow();
            await loadUndockedData();
        }
    };

    const pickUndockTargetAndOpen = async (): Promise<void> => {
        const picked = await vscode.window.showQuickPick(
            [
                {
                    label: vscode.l10n.t("Undock in Editor Tab"),
                    description: vscode.l10n.t("Open the unified IntelliGit view as an editor tab"),
                    target: "editorTab" as const,
                },
                {
                    label: vscode.l10n.t("Undock in New Window"),
                    description: vscode.l10n.t(
                        "Open the unified IntelliGit view and move it to a floating window",
                    ),
                    target: "newWindow" as const,
                },
            ],
            { placeHolder: vscode.l10n.t("Choose how to undock IntelliGit") },
        );
        if (!picked) return;
        await openUndockedIntelliGit(picked.target);
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

    context.subscriptions.push(
        mergeConflictsView,
        commitPanel.onDidChangeWorkingTree(() => {
            undocked?.refresh().catch((err) => {
                console.error("[IntelliGit] Undocked commit panel refresh failed:", err);
            });
        }),
        vscode.window.registerWebviewViewProvider(CommitInfoViewProvider.viewType, commitInfo),
    );
    if (viewProviders.commitGraph) {
        viewProviders.commitGraph.setProvider(commitGraph);
    } else {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.viewType,
                commitGraph,
            ),
        );
    }
    if (viewProviders.sidebarGraph) {
        viewProviders.sidebarGraph.setProvider(sidebarGraph);
    } else {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.sidebarViewType,
                sidebarGraph,
            ),
        );
    }
    if (viewProviders.commitPanel) {
        viewProviders.commitPanel.setProvider(commitPanel);
    } else {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                CommitPanelViewProvider.viewType,
                commitPanel,
            ),
        );
    }

    registerRepositoryViewEvents(
        {
            context,
            executor,
            gitOps,
            commitGraph,
            sidebarGraph,
            commitPanel,
            commitInfo,
            getRepoRoot,
            getCurrentBranches,
            refreshService: getRefreshService,
        },
        handleOpenCommitFileDiff,
    );

    registerRepositoryCommands({
        context,
        executor,
        gitOps,
        getRepoRoot,
        setRepositories: (nextRepositories) => {
            repositories = nextRepositories;
        },
        getCurrentBranches,
        getCurrentBranchName,
        commitGraphFilterByBranch: (branchName) => commitGraph.filterByBranch(branchName),
        sidebarGraphFilterByBranch: (branchName) => sidebarGraph.filterByBranch(branchName),
        setActiveRepository,
        clearSelection,
        refreshActiveRepository,
        refreshService: getRefreshService,
        showUndockedGitLog,
        pickUndockTargetAndOpen,
        dockIntelliGit,
        openMergeConflictForFile,
        openConflictSession,
        openBuiltInMergeEditorForFile,
    });

    currentBranches = await gitOps.getBranches();
    commitGraph.setBranches(currentBranches);
    commitPanel.setBranches(currentBranches);

    commitPanel.refresh().catch((err) => {
        console.error("Initial commit panel refresh failed:", err);
    });
    refreshService.refreshMergeConflicts().catch((err) => {
        console.error("Initial merge conflicts refresh failed:", err);
    });
    refreshService.registerFileWatchers();

    context.subscriptions.push(
        fileCountBadgeSubscription,
        { dispose: () => refreshService.dispose() },
        commitGraph,
        commitInfo,
        commitPanel,
        mergeConflicts,
        fileCountBadgeView,
    );

    void repositories;
}

function createFileCountBadgeView(): vscode.TreeView<never> {
    return vscode.window.createTreeView("intelligit.fileCountBadge", {
        treeDataProvider: {
            getChildren: () => [],
            getTreeItem: () => new vscode.TreeItem(""),
        } satisfies vscode.TreeDataProvider<never>,
    });
}

async function moveUndockedEditorToNewWindow(): Promise<void> {
    try {
        await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showWarningMessage(
            vscode.l10n.t("Unable to move IntelliGit to a new window automatically: {message}", {
                message,
            }),
        );
    }
}
