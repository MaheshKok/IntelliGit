import * as path from "path";
import * as vscode from "vscode";
import { handleCommitContextAction } from "../commands/commitCommands";
import { GitExecutor } from "../git/executor";
import { RepositoryMutationCoordinator } from "../git/mutationCoordinator";
import { GitOps } from "../git/operations";
import { createPendingRebaseDialogRequests } from "../git/interactiveRebase/pendingRequests";
import { createInteractiveRebaseSubmissionHandler } from "../git/interactiveRebase/submission";
import { runInteractiveRebaseSubmission } from "../git/interactiveRebase/run";
import { dismissRebasePushOffer, forcePushRebasedHead } from "../git/interactiveRebase/push";
import {
    abortInteractiveRebase,
    continueInteractiveRebase,
} from "../git/interactiveRebase/control";
import { watchWholeIndexOperation } from "../git/wholeIndexOperationWatcher";
import { CommitMessageGenerationCoordinator } from "../ai/commitMessageGenerationCoordinator";
import { RepositoryLock } from "../git/repositoryLock";
import { RepositoryMutationGate } from "../git/repositoryMutationGate";
import type { Branch, GitWorktree } from "../types";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { WorktreeService } from "../services/worktreeService";
import { ShelfService } from "../services/shelfService";
import { logShelfOperation, logShelfWarning } from "../services/shelfObservability";
import { ShelfStore } from "../shelf/store";
import { resolveShelfPaths } from "../shelf/paths";
import { readShelfSettings } from "./shelfSettings";
import { reconcileRebaseSessionsOnActivation } from "./rebaseReconciliation";
import {
    discoverGitRepositories,
    type DiscoveredRepository,
} from "../services/repositoryDiscovery";
import { CredentialStore } from "../services/commitChecks/credentialStore";
import { normalizeHostMap } from "../services/commitChecks/hostConfig";
import { normalizeCommitChecksSettings } from "../services/commitChecks/settingsConfig";
import { GitHubProvider } from "../services/commitChecks/githubProvider";
import { GitLabProvider } from "../services/commitChecks/gitlabProvider";
import { BitbucketCloudProvider } from "../services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../services/commitChecks/bitbucketServerProvider";
import { createHttpGetJson, type FetchJson } from "../services/commitChecks/http";
import { CommitChecksRequestGateRegistry } from "../services/commitChecks/requestGate";
import { CommitChecksService } from "../services/commitChecks/service";
import { CommitChecksPersistentCache } from "../services/commitChecks/persistentCache";
import type { CommitChecksProvider, ProviderId } from "../services/commitChecks/types";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "../views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { MergeConflictSessionPanel } from "../views/MergeConflictSessionPanel";
import { MergeConflictsTreeProvider } from "../views/MergeConflictsTreeProvider";
import { MergeEditorPanel } from "../views/MergeEditorPanel";
import { RefreshService } from "../views/RefreshService";
import { UndockedViewProvider } from "../views/UndockedViewProvider";
import {
    HAS_MULTIPLE_REPOSITORIES_CONTEXT,
    type RepositoryViewProviders,
    SELECTED_REPOSITORY_KEY,
    selectInitialRepository,
    setViewContext,
    workspaceRoots,
} from "./common";
import { registerRepositoryCommands } from "./repositoryCommands";
import { registerShelfCommands } from "./shelfCommands";
import {
    createOpenCommitFileDiffHandler,
    registerRepositoryViewEvents,
    showInteractiveRebaseControlResult,
    showInteractiveRebaseSubmissionRejection,
    showInteractiveRebaseSubmissionRunResult,
} from "./repositoryViewEvents";
import { runWithNotificationProgress, showTimedWarningMessage } from "../utils/notifications";

type BranchDeleteSelection = Array<Branch | string>;
const UNDOCKED_SELECTED_REPOSITORY_KEY = "intelligit.undockedSelectedRepositoryRoot";

/** Extracts a branch name from current and legacy bulk-delete event payloads. */
function getBranchSelectionName(branch: Branch | string): string {
    return typeof branch === "string" ? branch : branch.name;
}

/**
 * Returns the deepest discovered repository that contains a file URI.
 *
 * Non-file editors and files outside known repositories are ignored so
 * transient editor switches do not disturb the active IntelliGit root.
 */
function repositoryForFileUri(
    uri: vscode.Uri | undefined,
    knownRepositories: DiscoveredRepository[],
): DiscoveredRepository | undefined {
    if (!uri || uri.scheme !== "file") return undefined;
    const filePath = path.resolve(uri.fsPath);
    return knownRepositories.reduce<DiscoveredRepository | undefined>((best, repo) => {
        const root = path.resolve(repo.root);
        if (
            (filePath === root || filePath.startsWith(root + path.sep)) &&
            (!best || root.length > best.root.length)
        ) {
            return repo;
        }
        return best;
    }, undefined);
}

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
    void setViewContext(HAS_MULTIPLE_REPOSITORIES_CONTEXT, repositories.length > 1);
    let activeRepository = selectInitialRepository(
        repositories,
        context.workspaceState?.get<string>(SELECTED_REPOSITORY_KEY),
    );
    let repoRoot = activeRepository.root;
    const mutationGate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const pendingRebaseDialogRequests = createPendingRebaseDialogRequests();
    const shelfSettings = readShelfSettings(vscode.workspace.getConfiguration("intelligit"));
    const shelfServices = new Map<string, ShelfService>();
    const globalStoragePath = context.globalStorageUri?.fsPath;
    if (globalStoragePath) {
        await Promise.all(
            repositories.map(async (repository) => {
                const shelfPaths = await resolveShelfPaths({
                    repositoryRoot: repository.root,
                    globalStoragePath,
                    overridePath: shelfSettings.pathOverride,
                });
                shelfServices.set(
                    repository.root,
                    new ShelfService({
                        repositoryRoot: repository.root,
                        executor: new GitExecutor(repository.root, mutationGate),
                        store: new ShelfStore(shelfPaths),
                        gate: mutationGate,
                        recordBaseRevisions: shelfSettings.recordBaseRevisions,
                        recoveryMinimumRetentionMs: shelfSettings.recoveryRetentionMs,
                    }),
                );
            }),
        );
    }
    const shelfServiceForRepository = (repositoryRoot: string): ShelfService | undefined =>
        shelfServices.get(repositoryRoot);
    for (const [repositoryRoot, shelfService] of shelfServices) {
        void (async () => {
            await shelfService.resumePendingRecovery();
            logShelfOperation(
                { operation: "resumePendingRecovery", repositoryRoot },
                { status: "ok" },
            );
            const cleaned = await shelfService.cleanUpExpiredGhosts(shelfSettings.cleanupAfterDays);
            logShelfOperation({ operation: "cleanUpExpiredGhosts", repositoryRoot }, cleaned);
        })().catch((error: unknown) => {
            const message = getErrorMessage(error);
            logShelfWarning(`startup recovery for ${repositoryRoot}`, error);
            console.error(`[IntelliGit] Shelf recovery failed for ${repositoryRoot}:`, error);
            const localizedMessage = vscode.l10n.t("Shelf recovery failed: {message}", {
                message,
            });
            void vscode.window.showErrorMessage(
                localizedMessage === "Shelf recovery failed: {message}"
                    ? message
                    : localizedMessage,
            );
        });
    }
    const executor = new GitExecutor(repoRoot, mutationGate);
    const gitOps = new GitOps(executor);
    /**
     * Binds every accepted generation request to a currently discovered root, never to webview input
     * or either provider's mutable executor. Repositories outside VS Code workspace folders retain a
     * minimal root-folder fallback so the generation API still receives a stable workspace context.
     */
    const commitMessageGenerationCoordinator = new CommitMessageGenerationCoordinator({
        resolveRoot: (repositoryRoot) => {
            const repository = repositories.find((candidate) => candidate.root === repositoryRoot);
            if (!repository)
                throw new Error("Unknown repository root for commit-message generation.");
            const repositoryUri = vscode.Uri.file(repository.root);
            const workspaceFolder =
                vscode.workspace.getWorkspaceFolder(repositoryUri) ??
                ({
                    uri: repositoryUri,
                    name: path.basename(repository.root) || repository.root,
                    index: 0,
                } satisfies vscode.WorkspaceFolder);
            return {
                workspaceFolder,
                gitOps: gitOps.deriveFor(repository.root),
                watchWholeIndexOperation: (onDidChange, onDidError) =>
                    watchWholeIndexOperation(repository.root, onDidChange, onDidError),
            };
        },
    });
    // Shared per-host token store for non-GitHub commit-check providers (e.g. GitLab).
    const credentialStore = new CredentialStore(context.secrets);
    // Self-hosted commit-check host → provider mappings from user config. Read once at
    // activation; changing the setting requires a window reload to take effect.
    const commitCheckHostMap = normalizeHostMap(
        vscode.workspace.getConfiguration("intelligit").get("commitChecks.hosts"),
    );
    // Feature/provider toggles and CI/CD name filter. Read once at activation (reload to
    // change), like the host map. A malformed user regex falls back to the built-in filter
    // and surfaces a one-time warning so the silent fallback is visible.
    const commitCheckSettings = normalizeCommitChecksSettings(
        vscode.workspace.getConfiguration("intelligit").get("commitChecks"),
    );
    if (commitCheckSettings.ciCdFilterInvalid) {
        void vscode.window.showWarningMessage(
            vscode.l10n.t(
                "Invalid intelligit.commitChecks.ciCdFilter pattern; using the default filter.",
            ),
        );
    }
    const commitChecksService = new CommitChecksService({
        ttlMs: 30_000,
        noneTtlMs: 60 * 60 * 1000,
        unavailableTtlMs: 15 * 60 * 1000,
        maxEntries: 1_000,
        persistentCache: new CommitChecksPersistentCache(context.globalState, {
            noneMaxAgeMs: 60 * 60 * 1000,
        }),
    });
    const requestGateRegistry = new CommitChecksRequestGateRegistry(
        vscode.l10n.t("Commit-check requests are temporarily paused due to rate limiting."),
    );
    const fetchFor =
        (providerId: ProviderId): FetchJson =>
        (url, headers) =>
            requestGateRegistry.run(providerId, url, (generation) => {
                const fetchJson = createHttpGetJson((response) => {
                    requestGateRegistry.observeResponse(providerId, response, generation);
                });
                return fetchJson(url, headers);
            });
    const commitChecksProviders: readonly CommitChecksProvider[] = [
        new GitHubProvider(fetchFor("github"), commitCheckSettings.ciCdPattern),
        new GitLabProvider(fetchFor("gitlab"), credentialStore, commitCheckSettings.ciCdPattern),
        new BitbucketCloudProvider(fetchFor("bitbucket-cloud"), credentialStore),
        new BitbucketServerProvider(fetchFor("bitbucket-server"), credentialStore),
    ];

    let currentBranches: Branch[] = [];
    let currentWorktrees: GitWorktree[] = [];
    let undockedCommitDetailRequestSeq = 0;
    let repoRootUri = vscode.Uri.file(repoRoot);
    let undocked: UndockedViewProvider | undefined;
    let undockedSelectedRepositoryRoot =
        repositories.find(
            (repository) =>
                repository.root ===
                context.workspaceState?.get<string>(UNDOCKED_SELECTED_REPOSITORY_KEY),
        )?.root ?? activeRepository.root;
    let undockedBranches: Branch[] = [];
    let undockedWorktrees: GitWorktree[] = [];
    let undockedSelectionWrite = Promise.resolve();
    let undockedRuntime:
        | {
              executor: GitExecutor;
              gitOps: GitOps;
              worktreeService: WorktreeService;
          }
        | undefined;

    const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps, credentialStore, {
        hostMap: commitCheckHostMap,
        settings: commitCheckSettings,
        commitChecksService,
        commitChecksProviders,
    });
    const sidebarGraph = new CommitGraphViewProvider(
        context.extensionUri,
        gitOps,
        credentialStore,
        {
            scriptFile: "webview-compactcommitgraph.js",
            title: vscode.l10n.t("Graph"),
            showRepositoryLabel: repositories.length > 1,
            hostMap: commitCheckHostMap,
            settings: commitCheckSettings,
            commitChecksService,
            commitChecksProviders,
        },
    );
    const commitInfo = new CommitInfoViewProvider(context.extensionUri);
    const commitPanel = new CommitPanelViewProvider(
        context.extensionUri,
        gitOps,
        repoRootUri,
        context.workspaceState,
        context.secrets,
        shelfServiceForRepository,
        shelfSettings.removeOnUnshelve,
        commitMessageGenerationCoordinator,
        context.globalStorageUri?.fsPath,
    );
    const mergeConflicts = new MergeConflictsTreeProvider(gitOps, repoRootUri);
    const worktreeService = new WorktreeService(executor, () => repoRoot);

    commitGraph.setRepositoryLabel(activeRepository.label);
    sidebarGraph.setRepositoryLabel(activeRepository.label);
    commitPanel.setRepositoryLabel(activeRepository.label);
    commitPanel.setRepositories(repositories, activeRepository.root);
    sidebarGraph.setShowRepositoryLabel(repositories.length > 1);

    const setKnownRepositories = (
        nextRepositories: DiscoveredRepository[],
        activeRoot: string | null = activeRepository.root,
    ): void => {
        repositories = nextRepositories;
        void setViewContext(HAS_MULTIPLE_REPOSITORIES_CONTEXT, repositories.length > 1);
        sidebarGraph.setShowRepositoryLabel(repositories.length > 1);
        commitPanel.setRepositories(nextRepositories, activeRoot ?? undefined);
        if (
            !repositories.some((repository) => repository.root === undockedSelectedRepositoryRoot)
        ) {
            undockedSelectedRepositoryRoot = resolveUndockedRepository(
                activeRoot ?? undefined,
            ).root;
            void context.workspaceState?.update(
                UNDOCKED_SELECTED_REPOSITORY_KEY,
                undockedSelectedRepositoryRoot,
            );
        }
        undocked?.setRepositories(repositories, undockedSelectedRepositoryRoot);
    };

    const mergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
        treeDataProvider: mergeConflicts,
    });
    const fileCountBadgeView = createFileCountBadgeView();
    /** Keeps the native view badge in sync with the commit panel's working-tree count. */
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
    const fileCountBadgeSubscription = commitPanel.onDidChangeFileCount(updateFileCountBadge);
    updateFileCountBadge(commitPanel.getLastKnownFileCount());

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
                worktrees: worktreeService,
                onBranchesUpdated: (branches) => {
                    currentBranches = branches;
                },
                onWorktreesUpdated: (worktrees) => {
                    currentWorktrees = worktrees;
                },
                getUndocked: () => undocked,
            },
            root,
        );

    let refreshService = createRefreshService(repoRoot);
    let refreshServiceWatchersRegistered = false;
    /** Returns the currently active refresh coordinator after repository switches replace it. */
    const getRefreshService = (): RefreshService => refreshService;
    if (globalStoragePath) {
        void Promise.all(
            repositories.map((repository) =>
                reconcileRebaseSessionsOnActivation(repository.root, {
                    storageRoot: globalStoragePath,
                    executor: new GitExecutor(repository.root, mutationGate),
                    refresh: () => getRefreshService().refreshCommitPanels(),
                }),
            ),
        );
    }
    const registerRefreshServiceWatchers = (): void => {
        if (refreshServiceWatchersRegistered) return;
        refreshService.registerFileWatchers();
        refreshServiceWatchersRegistered = true;
    };
    /** Returns the repository root currently bound to command handlers. */
    const getRepoRoot = (): string => repoRoot;
    /** Returns the latest decorated branch snapshot shared by host command handlers. */
    const getCurrentBranches = (): Branch[] => currentBranches;
    /** Returns the latest worktree snapshot shared by graph worktree-row handlers. */
    const getCurrentWorktrees = (): GitWorktree[] => currentWorktrees;
    /** Returns the active branch name from the latest refreshed branch snapshot. */
    const getCurrentBranchName = (): string | undefined =>
        currentBranches.find((b) => b.isCurrent)?.name;
    /** Returns the repository root currently selected by the independent undocked runtime. */
    const getUndockedSelectedRepositoryRoot = (): string => undockedSelectedRepositoryRoot;

    const resolveUndockedRepository = (root: string | undefined): DiscoveredRepository =>
        repositories.find((repository) => repository.root === root) ??
        repositories.find((repository) => repository.root === activeRepository.root) ??
        activeRepository;

    const loadCurrentUndockedRepositoryData = async (): Promise<{
        branches: Branch[];
        worktrees: GitWorktree[];
    }> => {
        const runtime = undockedRuntime;
        if (!runtime) {
            return { branches: [], worktrees: [] };
        }
        const [branches, refreshedWorktrees] = await Promise.all([
            runtime.gitOps.getBranches(),
            runtime.worktreeService.refresh().catch((err) => {
                console.error("[IntelliGit] Undocked worktrees refresh failed:", err);
                return [] as GitWorktree[];
            }),
        ]);
        return {
            branches: runtime.worktreeService.decorateBranches(branches),
            worktrees: refreshedWorktrees,
        };
    };

    /** Stores undocked branch data only while the requesting panel and selected root still match. */
    const commitUndockedRepositoryData = (
        panel: UndockedViewProvider,
        capturedRoot: string,
        data: { branches: Branch[]; worktrees: GitWorktree[] },
    ): boolean => {
        if (undocked !== panel || getUndockedSelectedRepositoryRoot() !== capturedRoot)
            return false;
        undockedBranches = data.branches;
        undockedWorktrees = data.worktrees;
        return true;
    };

    /** Clears selected commit state from every visible IntelliGit surface at once. */
    const clearSelection = (options?: { loading?: boolean }): void => {
        commitGraph.clearCommitDetail(options);
        sidebarGraph.clearCommitDetail(options);
        commitPanel.clearCommitDetail(options);
        commitInfo.clear(options);
    };

    /**
     * Refreshes branch-dependent providers while preserving current commit selection.
     *
     * Repository switches clear selection before calling this. Failures propagate to
     * the caller; background initial refreshes attach their own logging handlers.
     */
    const refreshActiveRepositoryWithGuard = async (
        shouldContinue: () => boolean = () => true,
        afterBranchDataApplied?: () => Promise<void>,
    ): Promise<boolean> => {
        if (!shouldContinue()) return false;
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const [branches, refreshedWorktrees] = await Promise.all([
            gitOps.getBranches(),
            worktreeService.refresh().catch((err) => {
                console.error("[IntelliGit] Worktrees refresh failed:", err);
                return [] as GitWorktree[];
            }),
        ]);
        if (!shouldContinue()) return false;
        currentWorktrees = refreshedWorktrees;
        currentBranches = worktreeService.decorateBranches(branches);
        commitGraph.setBranches(currentBranches, currentWorktrees);
        sidebarGraph.setBranches(currentBranches, currentWorktrees);
        commitPanel.setBranches(currentBranches);
        if (afterBranchDataApplied) {
            if (!shouldContinue()) return false;
            // react-doctor-disable-next-line react-doctor/async-defer-await
            await afterBranchDataApplied();
            if (!shouldContinue()) return false;
        }
        const refreshes: Array<Promise<void>> = [
            commitGraph.refresh(shouldContinue),
            sidebarGraph.refresh(shouldContinue),
            commitPanel.refresh(shouldContinue),
            refreshService.refreshMergeConflicts(shouldContinue),
        ];
        if (undocked && undockedSelectedRepositoryRoot === repoRoot) {
            const panel = undocked;
            undockedBranches = currentBranches;
            undockedWorktrees = currentWorktrees;
            panel.setBranches(currentBranches, currentWorktrees);
            refreshes.push(panel.refresh(() => shouldContinue() && undocked === panel));
        }
        await Promise.all(refreshes);
        return shouldContinue();
    };

    const refreshActiveRepository = async (): Promise<void> => {
        await refreshActiveRepositoryWithGuard();
    };

    let activeEditorSwitchSeq = 0;
    let repositorySwitchSeq = 0;
    let activeEditorSelectionWrite = Promise.resolve();
    type ActiveRepositorySwitchOptions = {
        fromActiveEditor?: boolean;
        persistSelectionAfterBranchData?: boolean;
        shouldContinue?: () => boolean;
    };
    const persistActiveEditorSelection = async (
        root: string,
        shouldContinue: () => boolean,
    ): Promise<void> => {
        const write = activeEditorSelectionWrite
            .catch(() => undefined)
            .then(async () => {
                if (!shouldContinue()) return;
                await context.workspaceState?.update(SELECTED_REPOSITORY_KEY, root);
                if (!shouldContinue()) {
                    await context.workspaceState?.update(
                        SELECTED_REPOSITORY_KEY,
                        activeRepository.root,
                    );
                }
            });
        activeEditorSelectionWrite = write;
        await write;
    };

    /**
     * Switches all repository-scoped services and providers to a newly selected root.
     *
     * Updates the shared executor, provider labels/root URIs, merge-conflict tree,
     * persisted workspace selection, and refresh service watchers
     * before loading fresh data for the selected repository.
     */
    const setActiveRepository = async (
        repository: DiscoveredRepository,
        options: ActiveRepositorySwitchOptions = {},
    ): Promise<void> => {
        const switchSeq = ++repositorySwitchSeq;
        if (!options.fromActiveEditor) activeEditorSwitchSeq++;
        const callerShouldContinue = options.shouldContinue ?? (() => true);
        const shouldContinue = (): boolean =>
            switchSeq === repositorySwitchSeq && callerShouldContinue();
        if (!shouldContinue()) return;

        if (repoRoot !== repository.root) {
            pendingRebaseDialogRequests.cancelForOrigins(
                [commitGraph, sidebarGraph, commitPanel],
                repoRoot,
            );
        }
        activeRepository = repository;
        repoRoot = repository.root;
        repoRootUri = vscode.Uri.file(repoRoot);

        executor.setRoot(repoRoot);
        commitGraph.setRepositoryLabel(repository.label);
        sidebarGraph.setRepositoryLabel(repository.label);
        commitGraph.resetFilters();
        sidebarGraph.resetFilters();
        commitPanel.setRepositoryRootUri(repoRootUri);
        commitPanel.setRepositoryLabel(repository.label);
        undocked?.setRepositories(repositories, undockedSelectedRepositoryRoot);
        mergeConflicts.setWorkspaceRoot(repoRootUri);
        refreshService.dispose();
        refreshService = createRefreshService(repoRoot);
        refreshServiceWatchersRegistered = false;
        registerRefreshServiceWatchers();
        if (!options.persistSelectionAfterBranchData) {
            if (!shouldContinue()) return;
            // react-doctor-disable-next-line react-doctor/async-defer-await
            await context.workspaceState?.update(SELECTED_REPOSITORY_KEY, repoRoot);
            if (!shouldContinue()) return;
        }
        clearSelection();
        const persistSelectionAfterBranchDataApplied = options.persistSelectionAfterBranchData
            ? async (): Promise<void> => {
                  await persistActiveEditorSelection(repoRoot, shouldContinue);
              }
            : undefined;
        if (
            !(await refreshActiveRepositoryWithGuard(
                shouldContinue,
                persistSelectionAfterBranchDataApplied,
            ))
        ) {
            return;
        }
    };

    const updateActiveRepositoryFromEditor = async (editor?: vscode.TextEditor): Promise<void> => {
        const repository = repositoryForFileUri(editor?.document.uri, repositories);
        if (!repository || repository.root === activeRepository.root) return;
        const switchSeq = ++activeEditorSwitchSeq;
        const isLatestEditorSwitch = (): boolean => switchSeq === activeEditorSwitchSeq;
        await setActiveRepository(repository, {
            fromActiveEditor: true,
            persistSelectionAfterBranchData: true,
            shouldContinue: isLatestEditorSwitch,
        });
    };

    const refreshDiscoveredRepositories = async (): Promise<void> => {
        const nextRepositories = await discoverGitRepositories(workspaceRoots());
        const currentActive = nextRepositories.find(
            (repository) => repository.root === activeRepository.root,
        );
        if (currentActive || nextRepositories.length === 0) {
            setKnownRepositories(nextRepositories, currentActive?.root ?? activeRepository.root);
            return;
        }
        const fallbackRepository = nextRepositories[0];
        setKnownRepositories(nextRepositories, fallbackRepository.root);
        await setActiveRepository(fallbackRepository);
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            void updateActiveRepositoryFromEditor(editor).catch((err) => {
                console.error("[IntelliGit] Failed to update active repository from editor:", err);
            });
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await refreshDiscoveredRepositories().catch((err) => {
                console.error("[IntelliGit] Failed to refresh repositories:", err);
            });
        }),
    );
    await updateActiveRepositoryFromEditor(vscode.window.activeTextEditor);

    /**
     * Opens IntelliGit's native three-way merge editor for a repository-relative conflict file.
     *
     * The path is validated before the panel opens. If the native editor fails to
     * open, the file opens normally and the user sees a warning instead of a hard
     * failure, so the conflict stays reachable.
     */
    const openBuiltInMergeEditorForFile = async (filePath: string): Promise<void> => {
        const fileUri = vscode.Uri.file(path.join(repoRoot, assertRepoRelativePath(filePath)));
        try {
            await MergeEditorPanel.open({
                extensionUri: context.extensionUri,
                gitOps,
                getRepoRoot,
                filePath,
                onConflictStateChanged: async () => {
                    await refreshService.refreshConflictUi();
                },
            });
        } catch (error) {
            const message = getErrorMessage(error);
            showTimedWarningMessage(
                vscode.l10n.t(
                    "IntelliGit merge editor failed ({message}). Opening the file instead.",
                    { message },
                ),
            );
            await vscode.commands.executeCommand("vscode.open", fileUri);
        }
    };

    /** Opens a conflict file using IntelliGit's merge editor for the active repository. */
    const openMergeConflictForFile = async (filePath: string): Promise<void> => {
        await openBuiltInMergeEditorForFile(filePath);
    };

    /** Opens a conflict file with VS Code's native Git merge editor. */
    const openVsCodeMergeEditorForFile = async (filePath: string): Promise<void> => {
        const fileUri = vscode.Uri.file(path.join(repoRoot, assertRepoRelativePath(filePath)));
        try {
            await vscode.commands.executeCommand("git.openMergeEditor", fileUri);
        } catch (error) {
            const message = getErrorMessage(error);
            showTimedWarningMessage(
                vscode.l10n.t(
                    "VS Code merge editor command failed ({message}). Opening the file instead.",
                    {
                        message,
                    },
                ),
            );
            await vscode.commands.executeCommand("vscode.open", fileUri);
            return;
        }
        await refreshService.refreshConflictUi();
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

    /** Target location for moving the unified IntelliGit webview out of the sidebar. */
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

        const initialUndockedRepository = resolveUndockedRepository(undockedSelectedRepositoryRoot);
        undockedSelectedRepositoryRoot = initialUndockedRepository.root;
        const undockedExecutor = new GitExecutor(initialUndockedRepository.root, mutationGate);
        const undockedGitOps = new GitOps(undockedExecutor);
        const undockedWorktreeService = new WorktreeService(
            undockedExecutor,
            getUndockedSelectedRepositoryRoot,
        );
        undockedRuntime = {
            executor: undockedExecutor,
            gitOps: undockedGitOps,
            worktreeService: undockedWorktreeService,
        };
        const handleOpenUndockedCommitFileDiff = createOpenCommitFileDiffHandler({
            executor: undockedExecutor,
            gitOps: undockedGitOps,
            getRepoRoot: getUndockedSelectedRepositoryRoot,
        });
        const rebaseSubmissionHandler = createInteractiveRebaseSubmissionHandler({
            executor: undockedExecutor,
            pendingRebaseDialogRequests,
            getRepoRoot: getUndockedSelectedRepositoryRoot,
            hasWholeIndexOperationInProgress: () =>
                undockedGitOps.hasWholeIndexOperationInProgress(),
        });

        undocked = new UndockedViewProvider(
            context.extensionUri,
            undockedGitOps,
            vscode.Uri.file(initialUndockedRepository.root),
            credentialStore,
            context.workspaceState,
            commitCheckHostMap,
            commitCheckSettings,
            {
                executor: undockedExecutor,
                repositories,
                selectedRepositoryRoot: initialUndockedRepository.root,
                loadRepositoryData: async (capturedRoot) => {
                    const panel = undocked;
                    const data = await loadCurrentUndockedRepositoryData();
                    if (panel) commitUndockedRepositoryData(panel, capturedRoot, data);
                    return data;
                },
                commitChecksService,
                commitChecksProviders,
                commitMessageGenerationCoordinator,
                onSelectedRepositoryRootChanged: async (root) => {
                    const panel = undocked;
                    if (panel && undockedSelectedRepositoryRoot !== root) {
                        pendingRebaseDialogRequests.cancelForOrigins(
                            [panel],
                            undockedSelectedRepositoryRoot,
                        );
                    }
                    undockedSelectedRepositoryRoot = root;
                    undockedSelectionWrite = undockedSelectionWrite
                        .catch(() => undefined)
                        .then(async () => {
                            if (undockedSelectedRepositoryRoot !== root) return;
                            await context.workspaceState?.update(
                                UNDOCKED_SELECTED_REPOSITORY_KEY,
                                root,
                            );
                        });
                    await undockedSelectionWrite;
                },
                shelfServiceForRepository,
                shelfRemoveOnUnshelve: shelfSettings.removeOnUnshelve,
            },
            context.globalStorageUri?.fsPath,
        );
        undocked.setRepositoryLabel(initialUndockedRepository.label);
        undocked.setRepositories(repositories, initialUndockedRepository.root);
        context.subscriptions.push(undocked);

        // Bound to the instance just constructed rather than to the mutable `undocked`, so a panel
        // disposed after a replacement was created cancels its own requests and not the new one's.
        const disposingPanel = undocked;
        const rebaseDialogOriginProvider = undocked;
        context.subscriptions.push(
            undocked.onDidDispose(() => {
                pendingRebaseDialogRequests.cancelAllForOrigin(disposingPanel);
                undocked = undefined;
                undockedRuntime?.worktreeService.dispose();
                undockedRuntime = undefined;
                undockedBranches = [];
                undockedWorktrees = [];
            }),
            undocked.onDockRequested(async () => {
                await dockIntelliGit();
            }),
            undocked.onCommitSelected(async (hash) => {
                const requestId = ++undockedCommitDetailRequestSeq;
                try {
                    const detail = await undockedGitOps.getCommitDetail(hash);
                    if (requestId === undockedCommitDetailRequestSeq) {
                        undocked?.setCommitDetail(detail);
                    }
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Failed to load commit: {message}", { message: msg }),
                    );
                }
            }),
            undocked.onBranchAction(({ action, branchName }) => {
                const branch = undockedBranches.find((b) => b.name === branchName);
                if (!branch) return;
                void vscode.commands.executeCommand(`intelligit.${action}`, { branch });
            }),
            undocked.onWorktreeAction?.(({ action, path: worktreePath }) => {
                const worktree = undockedWorktrees.find(
                    (candidate) => candidate.path === worktreePath,
                );
                if (!worktree) return;
                if (action === "open") {
                    void vscode.commands.executeCommand("intelligit.openWorktree", {
                        branch: {
                            name: worktree.branch ?? worktree.path,
                            worktreePath: worktree.path,
                        },
                    });
                    return;
                }
                void vscode.commands.executeCommand(`intelligit.worktree.${action}`, worktree);
            }) ?? new vscode.Disposable(() => undefined),
            undocked.onDeleteBranches?.((branchSelection: BranchDeleteSelection) => {
                const requestedNames = Array.from(
                    new Set(branchSelection.map(getBranchSelectionName)),
                );
                const branches = requestedNames
                    .map((name) => undockedBranches.find((branch) => branch.name === name))
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
                const originProvider = undocked;
                if (!originProvider) return;
                try {
                    await handleCommitContextAction({
                        action,
                        hash,
                        executor: undockedExecutor,
                        gitOps: undockedGitOps,
                        repoRoot: getUndockedSelectedRepositoryRoot(),
                        currentBranches: undockedBranches,
                        refreshAll: async () => {
                            if (getUndockedSelectedRepositoryRoot() === repoRoot) {
                                await refreshService.refreshAll();
                                return;
                            }
                            await loadUndockedData();
                        },
                        originProvider,
                        postRebaseDialog: (message) => originProvider.showRebaseDialog(message),
                        pendingRebaseDialogRequests,
                    });
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error(`Commit action '${action}' failed:`, error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Commit action failed: {message}", { message }),
                    );
                }
            }),
            undocked.onRebaseDialogSubmit(async ({ requestId, entries }) => {
                const submissionRoot = getUndockedSelectedRepositoryRoot();
                const submissionPanel = undocked;
                const submissionShouldContinue = (): boolean =>
                    submissionPanel === undocked &&
                    getUndockedSelectedRepositoryRoot() === submissionRoot;
                const submissionExecutor = new GitExecutor(submissionRoot, mutationGate);
                const submissionGitOps = new GitOps(submissionExecutor);
                const submissionHandler = createInteractiveRebaseSubmissionHandler({
                    executor: submissionExecutor,
                    pendingRebaseDialogRequests,
                    getRepoRoot: () => submissionRoot,
                    hasWholeIndexOperationInProgress: () =>
                        submissionGitOps.hasWholeIndexOperationInProgress(),
                });
                try {
                    const result = await submissionHandler.submit(
                        { requestId, entries },
                        rebaseDialogOriginProvider,
                    );
                    if (result.status === "rejected") {
                        showInteractiveRebaseSubmissionRejection(result.reason);
                        return;
                    }
                    const directories = await submissionGitOps.getGitDirectories();
                    const runResult = await runWithNotificationProgress(
                        vscode.l10n.t("Running interactive rebase..."),
                        async () =>
                            runInteractiveRebaseSubmission(
                                {
                                    executor: submissionExecutor,
                                    mutationGate,
                                    storageRoot: context.globalStorageUri?.fsPath,
                                    gitDir: directories.gitDir,
                                    commonDir: directories.commonDir,
                                    hasWholeIndexOperationInProgress: () =>
                                        submissionGitOps.hasWholeIndexOperationInProgress(),
                                    helperScriptPath: context.asAbsolutePath(
                                        "dist/interactive-rebase-editor-helper.cjs",
                                    ),
                                },
                                result,
                            ),
                    );
                    await showInteractiveRebaseSubmissionRunResult(
                        runResult,
                        async () => {
                            if (!submissionShouldContinue()) return;
                            if (submissionRoot === repoRoot) {
                                await refreshActiveRepositoryWithGuard(submissionShouldContinue);
                                return;
                            }
                            await loadUndockedData(submissionShouldContinue);
                        },
                        {
                            forcePush: (manifest) =>
                                forcePushRebasedHead(
                                    {
                                        executor: submissionExecutor,
                                        mutationGate,
                                        storageRoot: context.globalStorageUri?.fsPath ?? "",
                                        commonDir: directories.commonDir,
                                    },
                                    manifest,
                                ),
                            dismiss: (manifest) =>
                                dismissRebasePushOffer(
                                    context.globalStorageUri?.fsPath ?? "",
                                    manifest,
                                ),
                        },
                    );
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Interactive rebase submission failed:", error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Interactive rebase failed: {message}", { message }),
                    );
                }
            }),
            undocked.onRebaseDialogCancel(({ requestId }) => {
                // An already-consumed request is a benign no-op, so its boolean result is intentionally ignored.
                rebaseSubmissionHandler.cancel({ requestId }, rebaseDialogOriginProvider);
            }),
            undocked.onRebaseControl(async ({ action, repositoryRoot }) => {
                // Capture a root-stable executor and GitOps before the first await; repository
                // selection can change while Git control or notification refresh is pending.
                const controlRoot = repositoryRoot;
                try {
                    const controlExecutor = new GitExecutor(controlRoot, mutationGate);
                    const controlGitOps = new GitOps(controlExecutor);
                    const directories = await controlGitOps.getGitDirectories();
                    const dependencies = {
                        executor: controlExecutor,
                        mutationGate,
                        storageRoot: context.globalStorageUri?.fsPath,
                        gitDir: directories.gitDir,
                        commonDir: directories.commonDir,
                        helperScriptPath: context.asAbsolutePath(
                            "dist/interactive-rebase-editor-helper.cjs",
                        ),
                    };
                    const result = await (action === "continue"
                        ? continueInteractiveRebase(dependencies, controlRoot)
                        : abortInteractiveRebase(dependencies, controlRoot));
                    await showInteractiveRebaseControlResult(
                        result,
                        async () => {
                            if (getRepoRoot() === controlRoot) {
                                await refreshService.refreshAll();
                            }
                            const panel = undocked;
                            if (panel && getUndockedSelectedRepositoryRoot() === controlRoot) {
                                await loadUndockedData(
                                    () =>
                                        undocked === panel &&
                                        getUndockedSelectedRepositoryRoot() === controlRoot,
                                );
                            }
                        },
                        {
                            forcePush: (manifest) =>
                                forcePushRebasedHead(
                                    {
                                        executor: controlExecutor,
                                        mutationGate,
                                        storageRoot: context.globalStorageUri?.fsPath ?? "",
                                        commonDir: directories.commonDir,
                                    },
                                    manifest,
                                ),
                            dismiss: (manifest) =>
                                dismissRebasePushOffer(
                                    context.globalStorageUri?.fsPath ?? "",
                                    manifest,
                                ),
                        },
                    );
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error(`Interactive rebase ${action} failed:`, error);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Interactive rebase failed: {message}", { message }),
                    );
                }
            }),
            undocked.onOpenCommitFileDiff(handleOpenUndockedCommitFileDiff),
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
    const loadUndockedData = async (shouldContinue: () => boolean = () => true): Promise<void> => {
        const panel = undocked;
        const capturedRoot = getUndockedSelectedRepositoryRoot();
        if (!panel || !shouldContinue()) return;
        // The panel can be replaced while loading; commit only to the requesting instance.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const data = await loadCurrentUndockedRepositoryData();
        if (!shouldContinue() || !commitUndockedRepositoryData(panel, capturedRoot, data)) return;
        panel.setBranches(data.branches, data.worktrees);
        if (
            !shouldContinue() ||
            undocked !== panel ||
            getUndockedSelectedRepositoryRoot() !== capturedRoot
        )
            return;
        await panel.refresh(
            () =>
                shouldContinue() &&
                undocked === panel &&
                getUndockedSelectedRepositoryRoot() === capturedRoot,
        );
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

    /**
     * Clears commit-check request state, drops cached snapshots, and re-renders every graph surface.
     *
     * Fired by the sign-in/sign-out commands after a credential change. A stored
     * "unavailable" snapshot is a terminal state the coordinator never re-fetches,
     * and GitHub's silent session lookup returns "none" when signed out. Badges would
     * stay stuck after auth changes unless the cache is cleared and the graphs
     * re-render, which makes the webview re-request checks.
     */
    const refreshCommitCheckBadges = async (): Promise<void> => {
        requestGateRegistry.reset();
        commitGraph.clearChecksCache();
        sidebarGraph.clearChecksCache();
        undocked?.clearChecksCache();
        await Promise.all([commitGraph.refresh(), sidebarGraph.refresh()]);
        if (undocked) await undocked.refresh();
    };

    context.subscriptions.push(
        mergeConflictsView,
        vscode.commands.registerCommand("intelligit.sidebarRepositoryIndicator", () => undefined),
        vscode.commands.registerCommand(
            "intelligit.sidebarRepositoryIndicator.color",
            () => undefined,
        ),
        vscode.commands.registerCommand(
            "intelligit.commitChecks.refreshBadges",
            refreshCommitCheckBadges,
        ),
        vscode.authentication.onDidChangeSessions((event) => {
            if (event.provider.id !== "github") return;
            refreshCommitCheckBadges().catch((err) => {
                console.error("[IntelliGit] GitHub commit-check refresh failed:", err);
            });
        }),
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
            getCurrentWorktrees,
            refreshService: getRefreshService,
            pendingRebaseDialogRequests,
            mutationGate,
        },
        handleOpenCommitFileDiff,
    );

    registerRepositoryCommands({
        context,
        executor,
        gitOps,
        worktreeService,
        getRepoRoot,
        setRepositories: (nextRepositories) => {
            setKnownRepositories(nextRepositories);
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
        openVsCodeMergeEditorForFile,
    });
    registerShelfCommands({
        context,
        getRepositories: () => repositories,
        shelfServiceForRepository,
        refreshAfterMutation: () => getRefreshService().refreshCommitPanels(),
    });

    try {
        currentWorktrees = await worktreeService.refresh();
    } catch (err) {
        console.error("Initial worktrees refresh failed:", err);
    }
    currentBranches = worktreeService.decorateBranches(await gitOps.getBranches());
    commitGraph.setBranches(currentBranches, currentWorktrees);
    sidebarGraph.setBranches(currentBranches, currentWorktrees);
    commitPanel.setBranches(currentBranches);

    commitPanel.refreshSilent().catch((err) => {
        console.error("Initial commit panel refresh failed:", err);
    });
    refreshService.refreshMergeConflicts().catch((err) => {
        console.error("Initial merge conflicts refresh failed:", err);
    });
    registerRefreshServiceWatchers();

    context.subscriptions.push(
        fileCountBadgeSubscription,
        commitMessageGenerationCoordinator,
        { dispose: () => refreshService.dispose() },
        commitGraph,
        commitInfo,
        commitPanel,
        mergeConflicts,
        worktreeService,
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
        showTimedWarningMessage(
            vscode.l10n.t("Unable to move IntelliGit to a new window automatically: {message}", {
                message,
            }),
        );
    }
}
