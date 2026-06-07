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

/**
 * Activates IntelliGit's repository-backed mode for discovered Git roots.
 *
 * This path runs after startup discovery finds repositories or after
 * no-repository mode initializes/selects one. It selects the initial root from
 * workspace state when possible, creates Git services and repository view
 * providers, registers command/event subscriptions, and starts initial provider
 * refreshes and file watchers. The VS Code extension context owns every
 * disposable created here.
 *
 * If `viewProviders` contains switchable wrappers from no-repository mode, they
 * are reused so existing onboarding view registrations render repository content
 * instead of registering duplicate view IDs.
 */
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

    /**
     * Creates the refresh coordinator for the currently active repository root.
     *
     * The service keeps provider refreshes, file watchers, and merge-conflict
     * state tied to the active root. A repository switch must dispose the previous
     * service before registering watchers on the replacement.
     */
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
        commitPanel.clearCommitDetail();
        commitInfo.clear();
    };

    /**
     * Refreshes branch-dependent providers and clears stale selection state.
     *
     * Used by explicit refreshes and repository switches. Failures propagate to
     * the caller; background initial refreshes attach their own logging handlers.
     */
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

    /**
     * Switches all repository-scoped services and providers to a newly selected root.
     *
     * Updates the shared executor, provider labels/root URIs, merge-conflict tree,
     * badge state, persisted workspace selection, and refresh service watchers
     * before loading fresh data for the selected repository.
     */
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

    /**
     * Opens VS Code's built-in merge editor for a repository-relative conflict file.
     *
     * The path is validated before constructing the file URI. If the Git extension
     * command is unavailable or fails, the file opens normally and the user sees a
     * warning instead of a hard failure.
     */
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

    /**
     * Opens a conflict file using the preferred merge tool for the active repository.
     *
     * A configured JetBrains tool gets the first chance when external tools are
     * preferred; unresolved or failed external opens fall back to VS Code's
     * built-in merge editor path.
     */
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

    /**
     * Opens the multi-file merge conflict session panel for the active repository.
     *
     * The panel callbacks route file opens through the same merge-tool preference
     * as tree commands and refresh conflict UI after webview-side state changes.
     */
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

    /**
     * Creates the undocked IntelliGit provider once and wires its event subscriptions.
     *
     * The provider and listener disposables are owned by `context.subscriptions`.
     * Disposal clears the cached provider, commit-detail loads use a sequence guard
     * to ignore stale responses, and working-tree events keep docked views in sync.
     */
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
            undocked.onDeleteBranches?.((branchNames) => {
                const requestedNames = Array.from(new Set(branchNames));
                const branches = requestedNames
                    .map((name) => getCurrentBranches().find((branch) => branch.name === name))
                    .filter((branch): branch is Branch => Boolean(branch));
                if (branches.length !== requestedNames.length) {
                    const found = new Set(branches.map((branch) => branch.name));
                    const missing = requestedNames.filter((name) => !found.has(name));
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Cannot delete missing branch(es): {branches}", {
                            branches: missing.join(", "),
                        }),
                    );
                    return;
                }
                void vscode.commands.executeCommand("intelligit.deleteBranches", { branches });
            }) ?? new vscode.Disposable(() => undefined),
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
                commitPanel.refreshSilent().catch((err) => {
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

    /**
     * Loads branch and graph data into an already-created undocked provider.
     *
     * Guards after awaits because the undocked panel can be disposed while Git
     * work is pending, especially while a new-window open is being completed.
     */
    const loadUndockedData = async (): Promise<void> => {
        if (!undocked) return;
        currentBranches = await gitOps.getBranches();
        if (!undocked) return;
        undocked.setBranches(currentBranches);
        await undocked.refresh();
    };

    /**
     * Reveals or opens the unified undocked IntelliGit panel.
     *
     * Editor-tab opens load data immediately; new-window opens may defer loading
     * until after VS Code moves the editor so the panel does not refresh while
     * being reparented.
     */
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

    /**
     * Enables undocked mode and opens the panel in the selected VS Code surface.
     *
     * Opening in a new window persists the setting first, moves the editor
     * best-effort, then loads data after the move to avoid refreshing a transient
     * editor.
     */
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

    /**
     * Prompts for an undock target and starts the matching undocked open flow.
     *
     * Canceling the quick pick leaves configuration and existing panels unchanged.
     */
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

    /**
     * Returns IntelliGit to docked sidebar views and disables the undock preference.
     *
     * The undocked provider is disposed if present, then the docked panel and graph
     * are focused so VS Code restores the repository-backed view locations.
     */
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
            undocked?.refreshSilent().catch((err) => {
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
                { webviewOptions: { retainContextWhenHidden: true } },
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

    commitPanel.refreshSilent().catch((err) => {
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

/**
 * Creates the empty tree view used only to expose the commit panel file-count badge.
 *
 * The view has no children; callers own the returned disposable and update its
 * badge as the commit panel reports working-tree file counts.
 */
function createFileCountBadgeView(): vscode.TreeView<never> {
    return vscode.window.createTreeView("intelligit.fileCountBadge", {
        treeDataProvider: {
            getChildren: () => [],
            getTreeItem: () => new vscode.TreeItem(""),
        } satisfies vscode.TreeDataProvider<never>,
    });
}

/**
 * Moves the active undocked editor into a floating VS Code window when supported.
 *
 * This is a best-effort UI side effect. Failures are converted into a warning so
 * the panel remains usable in its original editor tab.
 */
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
