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
    registerReadonlyDiffContentProvider,
} from "./services/diffService";
import { runWithNotificationProgress } from "./utils/notifications";
import { discoverGitRepositories, type DiscoveredRepository } from "./services/repositoryDiscovery";
import { OnboardingViewProvider } from "./views/OnboardingViewProvider";
import { runCloneFlow } from "./services/cloneService";
import { runPublishBranchFlow } from "./services/publishService";

const SELECTED_REPOSITORY_KEY = "intelligit.selectedRepositoryRoot";
const NO_REPOSITORY_MESSAGE = "No Git repositories found in this workspace.";

class SwitchableWebviewViewProvider implements vscode.WebviewViewProvider {
    private resolved:
        | {
              view: vscode.WebviewView;
              context: vscode.WebviewViewResolveContext;
              token: vscode.CancellationToken;
          }
        | undefined;

    constructor(private currentProvider: vscode.WebviewViewProvider) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken,
    ): void | Thenable<void> {
        this.resolved = { view: webviewView, context, token };
        return this.currentProvider.resolveWebviewView(webviewView, context, token);
    }

    setProvider(provider: vscode.WebviewViewProvider): void {
        this.currentProvider = provider;
        if (!this.resolved) return;
        void provider.resolveWebviewView(
            this.resolved.view,
            this.resolved.context,
            this.resolved.token,
        );
    }
}

interface RepositoryViewProviders {
    commitGraph?: SwitchableWebviewViewProvider;
    sidebarGraph?: SwitchableWebviewViewProvider;
    commitPanel?: SwitchableWebviewViewProvider;
}

function registerOnboardingCommands(context: vscode.ExtensionContext): void {
    const showUnavailableMessage = (): void => {
        vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.cloneRepository", () =>
            runCloneFlow(context.secrets),
        ),
        vscode.commands.registerCommand("intelligit.openFolder", async () => {
            await vscode.commands.executeCommand("vscode.openFolder");
        }),
        vscode.commands.registerCommand("intelligit.initializeRepository", initializeRepository),
        vscode.commands.registerCommand("intelligit.selectRepository", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.showGitLog", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.openUndocked", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.dockWindow", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.toggleUndocked", showUnavailableMessage),
        vscode.commands.registerCommand("intelligit.publishBranch", showUnavailableMessage),
    );
}

function workspaceRoots(): string[] {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

async function initializeRepository(
    options: {
        onInitialized?: (repositories: DiscoveredRepository[]) => Promise<void>;
    } = {},
): Promise<void> {
    const roots = workspaceRoots();
    if (roots.length === 0) {
        vscode.window.showErrorMessage("Open a folder first to initialize a repository.");
        return;
    }

    let targetPath: string;
    if (roots.length === 1) {
        targetPath = roots[0];
    } else {
        const picked = await vscode.window.showQuickPick(
            roots.map((root) => ({
                label: root.split("/").pop() || root,
                description: root,
                path: root,
            })),
            { placeHolder: "Select a folder to initialize a Git repository" },
        );
        if (!picked) return;
        targetPath = picked.path;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Initializing Git repository...",
                cancellable: false,
            },
            async () => {
                const gitOps = new GitOps(new GitExecutor(targetPath));
                await gitOps.init(targetPath);
            },
        );

        const newRepos = await discoverGitRepositories(workspaceRoots());
        if (newRepos.length > 0) {
            if (options.onInitialized) {
                await options.onInitialized(newRepos);
            }
            vscode.window.showInformationMessage("Repository initialized.");
        } else {
            vscode.window.showErrorMessage(
                "Failed to initialize repository. Check folder permissions.",
            );
        }
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(`Failed to initialize repository: ${message}`);
    }
}

function selectInitialRepository(
    repositories: DiscoveredRepository[],
    storedRoot: string | undefined,
): DiscoveredRepository {
    return repositories.find((repo) => repo.root === storedRoot) ?? repositories[0];
}

function registerStaleUndockedPanelSerializer(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(UndockedViewProvider.viewType, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
                panel.dispose();
            },
        }),
    );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    registerStaleUndockedPanelSerializer(context);
    registerReadonlyDiffContentProvider(context);

    if (!vscode.workspace.workspaceFolders?.length) {
        registerOnboardingCommands(context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.viewType,
                new OnboardingViewProvider(context.extensionUri, "no-workspace", "IntelliGit"),
            ),
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.sidebarViewType,
                new OnboardingViewProvider(context.extensionUri, "no-workspace", "Graph", false),
            ),
            vscode.window.registerWebviewViewProvider(
                CommitPanelViewProvider.viewType,
                new OnboardingViewProvider(context.extensionUri, "no-workspace", "Commit"),
            ),
        );
        return;
    }

    let repositories = await discoverGitRepositories(workspaceRoots());
    if (repositories.length === 0) {
        const noRepositoryDisposables: vscode.Disposable[] = [];
        let repositoryModeActivated = false;
        const emptyTreeProvider: vscode.TreeDataProvider<never> = {
            getTreeItem: () => {
                throw new Error("unreachable");
            },
            getChildren: () => [],
        };
        const emptyMergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
            treeDataProvider: emptyTreeProvider,
        });
        const commitGraphProvider = new SwitchableWebviewViewProvider(
            new OnboardingViewProvider(context.extensionUri, "no-git-repo", "IntelliGit"),
        );
        const sidebarGraphProvider = new SwitchableWebviewViewProvider(
            new OnboardingViewProvider(context.extensionUri, "no-git-repo", "Graph", false),
        );
        const commitPanelProvider = new SwitchableWebviewViewProvider(
            new OnboardingViewProvider(context.extensionUri, "no-git-repo", "Commit"),
        );

        const registerNoRepositoryDisposable = (disposable: vscode.Disposable): void => {
            noRepositoryDisposables.push(disposable);
            context.subscriptions.push(disposable);
        };
        const activateDiscoveredRepositories = async (
            discoveredRepositories: DiscoveredRepository[],
        ): Promise<void> => {
            if (repositoryModeActivated) return;
            repositoryModeActivated = true;
            for (const disposable of noRepositoryDisposables) {
                disposable.dispose();
            }
            await activateRepositoryMode(discoveredRepositories, {
                commitGraph: commitGraphProvider,
                sidebarGraph: sidebarGraphProvider,
                commitPanel: commitPanelProvider,
            });
        };

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.viewType,
                commitGraphProvider,
            ),
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.sidebarViewType,
                sidebarGraphProvider,
            ),
            vscode.window.registerWebviewViewProvider(
                CommitPanelViewProvider.viewType,
                commitPanelProvider,
            ),
        );
        registerNoRepositoryDisposable(emptyMergeConflictsView);
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.selectRepository", async () => {
                repositories = await discoverGitRepositories(workspaceRoots());
                if (repositories.length === 0) {
                    vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
                    return;
                }
                await activateDiscoveredRepositories(repositories);
                vscode.window.showInformationMessage("Git repositories found.");
            }),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.cloneRepository", () =>
                runCloneFlow(context.secrets),
            ),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.openFolder", async () => {
                await vscode.commands.executeCommand("vscode.openFolder");
            }),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.initializeRepository", async () =>
                initializeRepository({
                    onInitialized: async (initializedRepositories) => {
                        await activateDiscoveredRepositories(initializedRepositories);
                    },
                }),
            ),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.showGitLog", async () => {
                await vscode.commands.executeCommand("intelligit.commitGraph.focus");
            }),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.openUndocked", () => {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
            }),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.dockWindow", () => {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
            }),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.toggleUndocked", () => {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
            }),
        );
        registerNoRepositoryDisposable(
            vscode.commands.registerCommand("intelligit.publishBranch", () => {
                vscode.window.showInformationMessage(NO_REPOSITORY_MESSAGE);
            }),
        );
        void vscode.commands.executeCommand("setContext", "intelligit.hasMergeConflicts", false);
        return;
    }

    await activateRepositoryMode(repositories);

    async function activateRepositoryMode(
        repositoriesForActivation: DiscoveredRepository[],
        viewProviders: RepositoryViewProviders = {},
    ): Promise<void> {
        repositories = repositoriesForActivation;
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
        let undockedCommitDetailRequestSeq = 0;

        // --- Providers ---

        let repoRootUri = vscode.Uri.file(repoRoot);
        const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps);
        const sidebarGraph = new CommitGraphViewProvider(context.extensionUri, gitOps, {
            scriptFile: "webview-compactcommitgraph.js",
            title: "Graph",
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

        // --- Register views ---

        const mergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
            treeDataProvider: mergeConflicts,
        });

        // Hidden tree view that carries the changed-file-count badge on the activity bar icon.
        const badgeProvider: vscode.TreeDataProvider<never> = {
            getTreeItem: () => {
                throw new Error("unreachable");
            },
            getChildren: () => [],
        };
        const badgeView = vscode.window.createTreeView("intelligit.fileCountBadge", {
            treeDataProvider: badgeProvider,
        });

        const updateBadge = (count: number) => {
            badgeView.badge =
                count > 0
                    ? { tooltip: `${count} changed file${count !== 1 ? "s" : ""}`, value: count }
                    : undefined;
        };

        let undocked: UndockedViewProvider | undefined;

        // --- Refresh service ---

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

        const clearSelection = () => {
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
            await clearSelection();
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
            refreshService.dispose();
            refreshService = createRefreshService(repoRoot);
            refreshService.registerFileWatchers();
            await context.workspaceState?.update(SELECTED_REPOSITORY_KEY, repoRoot);
            await refreshActiveRepository();
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

        type UndockTarget = "editorTab" | "newWindow";

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
                undocked.onDidDispose(async () => {
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
                            refreshAll: () => refreshService.refreshAll(),
                        });
                    } catch (error) {
                        const message = getErrorMessage(error);
                        console.error(`Commit action '${action}' failed:`, error);
                        vscode.window.showErrorMessage(`Commit action failed: ${message}`);
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
            await panel.open();
            if (undocked !== panel) return;

            if (!options?.deferDataLoad) {
                await loadUndockedData();
            }
        };

        const moveUndockedEditorToNewWindow = async (): Promise<void> => {
            try {
                await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showWarningMessage(
                    `Unable to move IntelliGit to a new window automatically: ${message}`,
                );
            }
        };

        const openUndockedIntelliGit = async (target: UndockTarget): Promise<void> => {
            await vscode.workspace
                .getConfiguration("intelligit")
                .update("undockableWindow", true, true);

            const deferDataLoad = target === "newWindow";
            await showUndockedGitLog({ deferDataLoad });

            if (target === "newWindow") {
                // Move to new window immediately — before data loading — so the user
                // never sees a tab flicker.
                await moveUndockedEditorToNewWindow();
                // Load data into the already-opened window.
                await loadUndockedData();
            }
        };

        const pickUndockTargetAndOpen = async (): Promise<void> => {
            const picked = await vscode.window.showQuickPick(
                [
                    {
                        label: "Undock in Editor Tab",
                        description: "Open the unified IntelliGit view as an editor tab",
                        target: "editorTab" as const,
                    },
                    {
                        label: "Undock in New Window",
                        description:
                            "Open the unified IntelliGit view and move it to a floating window",
                        target: "newWindow" as const,
                    },
                ],
                { placeHolder: "Choose how to undock IntelliGit" },
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

        // --- Register view providers ---

        context.subscriptions.push(
            badgeView,
            mergeConflictsView,
            commitPanel.onDidChangeFileCount(updateBadge),
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

        // --- Wire data flow ---

        context.subscriptions.push(
            commitGraph.onCommitSelected(async (hash) => {
                const requestId = ++commitDetailRequestSeq;
                try {
                    const detail = await gitOps.getCommitDetail(hash);
                    if (requestId !== commitDetailRequestSeq) return;
                    commitGraph.setCommitDetail(detail);
                    sidebarGraph.setCommitDetail(detail);
                    commitPanel.setCommitDetail(detail);
                    commitInfo.setCommitDetail(detail);
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Failed to load commit: ${msg}`);
                }
            }),
            sidebarGraph.onCommitSelected(async (hash) => {
                const requestId = ++commitDetailRequestSeq;
                try {
                    const detail = await gitOps.getCommitDetail(hash);
                    if (requestId !== commitDetailRequestSeq) return;
                    commitGraph.setCommitDetail(detail);
                    sidebarGraph.setCommitDetail(detail);
                    commitPanel.setCommitDetail(detail);
                    commitInfo.setCommitDetail(detail);
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Failed to load commit: ${msg}`);
                }
            }),
            commitPanel.onCommitSelected(async (hash) => {
                const requestId = ++commitDetailRequestSeq;
                try {
                    const detail = await gitOps.getCommitDetail(hash);
                    if (requestId !== commitDetailRequestSeq) return;
                    commitGraph.setCommitDetail(detail);
                    sidebarGraph.setCommitDetail(detail);
                    commitPanel.setCommitDetail(detail);
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
                sidebarGraph.clearCommitDetail();
                commitPanel.clearCommitDetail();
                commitInfo.clear();
            }),
            sidebarGraph.onBranchFilterChanged(() => {
                commitGraph.clearCommitDetail();
                sidebarGraph.clearCommitDetail();
                commitPanel.clearCommitDetail();
                commitInfo.clear();
            }),
            commitPanel.onBranchFilterChanged(() => {
                commitGraph.clearCommitDetail();
                sidebarGraph.clearCommitDetail();
                commitPanel.clearCommitDetail();
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
            sidebarGraph.onBranchAction(({ action, branchName }) => {
                const branch = currentBranches.find((b) => b.name === branchName);
                if (!branch) return;
                const item: { branch: Branch } = { branch };
                vscode.commands.executeCommand(`intelligit.${action}`, item);
            }),
            commitPanel.onBranchAction(({ action, branchName }) => {
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
            sidebarGraph.onCommitAction(async ({ action, hash }) => {
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
            commitPanel.onCommitAction(async ({ action, hash }) => {
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
            sidebarGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
            commitPanel.onOpenCommitFileDiff(handleOpenCommitFileDiff),
            commitInfo.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        );

        // --- Commands ---

        context.subscriptions.push(
            vscode.commands.registerCommand("intelligit.refresh", async () => {
                await refreshActiveRepository();
            }),

            vscode.commands.registerCommand("intelligit.publishBranch", async () => {
                const hasCommits = await gitOps.hasAnyCommits();
                if (!hasCommits) {
                    vscode.window.showWarningMessage(
                        "Create a commit before publishing this branch.",
                    );
                    return;
                }
                const branches = await gitOps.getBranches();
                const currentBranch = branches.find((b) => b.isCurrent);
                if (!currentBranch) {
                    vscode.window.showErrorMessage("No current branch found.");
                    return;
                }
                await runPublishBranchFlow(gitOps, currentBranch.name, repoRoot, context.secrets);
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
                    await Promise.all([
                        commitGraph.filterByBranch(branchName ?? null),
                        sidebarGraph.filterByBranch(branchName ?? null),
                    ]);
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

            vscode.commands.registerCommand("intelligit.openUndocked", pickUndockTargetAndOpen),

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
            vscode.commands.registerCommand(
                "intelligit.openMergeConflict",
                async (ctx: unknown) => {
                    const filePath = resolveConflictPath(ctx);
                    if (!filePath) return;
                    await openMergeConflictForFile(filePath);
                },
            ),
            vscode.commands.registerCommand(
                "intelligit.compareWithRevision",
                async (ctx?: unknown) => {
                    await compareEditorFileWithRevision(ctx, repoRoot, gitOps);
                },
            ),
            vscode.commands.registerCommand(
                "intelligit.compareWithBranch",
                async (ctx?: unknown) => {
                    await compareEditorFileWithBranch(ctx, repoRoot, gitOps);
                },
            ),
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
            vscode.commands.registerCommand(
                "intelligit.conflictAcceptYours",
                async (ctx: unknown) => {
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
                },
            ),
            vscode.commands.registerCommand(
                "intelligit.conflictAcceptTheirs",
                async (ctx: unknown) => {
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
                },
            ),
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
                        await refreshService.refreshCommitPanels();
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
                        await refreshService.refreshCommitPanels();
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
                        await refreshService.refreshCommitPanels();
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
                await refreshService.refreshCommitPanels();
            }),
            vscode.commands.registerCommand("intelligit.fileRefreshing", () => {
                // No-op: visual-only command shown while refreshing (disabled via enablement).
            }),
        );

        // --- Initial load ---

        currentBranches = await gitOps.getBranches();
        commitGraph.setBranches(currentBranches);
        commitPanel.setBranches(currentBranches);

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
}

export function deactivate(): void {}
