// Manages a vscode.WebviewPanel (editor tab) that combines the commit graph
// and commit panel into a single unified view. Used when the user enables
// intelligit.undockableWindow to allow dragging to a second monitor.
import * as vscode from "vscode";
import type { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import {
    type CommitMessageGenerationHost,
    CommitMessageGenerationCoordinator,
} from "../ai/commitMessageGenerationCoordinator";
import { showCommitMessageGenerationNotification } from "../ai/commitMessageGenerationNotifications";
import type { ShelfService } from "../services/shelfService";
import type { ShelfEntry, ShelfHealthWarning } from "../webviews/protocol/commitPanelMessages";
import { IconThemeService } from "./shared/IconThemeService";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import { buildWebviewShellHtml } from "./webviewHtml";
import { decorateShelfFiles, shelfFilePaths } from "./shelfIconDecoration";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { assertValidBranchName } from "../utils/gitRefs";
import {
    isBranchAction,
    isCommitAction,
    isWorktreeAction,
} from "../webviews/protocol/commitGraphTypes";
import type {
    Branch,
    Commit,
    CommitDetail,
    GitWorktree,
    StashEntry,
    ThemeFolderIconMap,
    WorkingFile,
} from "../types";
import type {
    BranchAction,
    CommitAction,
    WorktreeAction,
} from "../webviews/protocol/commitGraphTypes";
import type {
    RepositoryViewIdentity,
    UnifiedOutbound,
    UnifiedInbound,
} from "../webviews/protocol/undockedMessages";
import {
    CommitChecksCoordinator,
    DEFAULT_COMMIT_CHECKS_TTL_MS,
} from "../services/commitChecks/coordinator";
import { summaryForState } from "../services/commitChecks/normalize";
import {
    commitChecksSettingsFingerprint,
    type CommitChecksSettings,
} from "../services/commitChecks/settingsConfig";
import type { CommitChecksService } from "../services/commitChecks/service";
import { GitHubProvider } from "../services/commitChecks/githubProvider";
import { GitLabProvider } from "../services/commitChecks/gitlabProvider";
import { BitbucketCloudProvider } from "../services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../services/commitChecks/bitbucketServerProvider";
import { httpGetJson } from "../services/commitChecks/http";
import type { CredentialStore } from "../services/commitChecks/credentialStore";
import type { CommitChecksProvider, HostMap } from "../services/commitChecks/types";
import {
    assertGitHash,
    assertNullableString,
    assertNumber,
    assertRepoPathArray,
    assertShelfId,
    assertString,
} from "./messageValidation";
import {
    commitAndPushFromPanel,
    commitOnlyFromPanel,
    commitSelectedFromPanel,
    executeShelfMutationRequest,
    executeStashFileMutationRequest,
    executeStashMutationRequest,
    openShelfConflictEditorFromMessage,
    rollbackFromPanel,
    runGitOperationFromPanel,
    stashMutationFromPanel,
    stashMutationFromUnstashMessage,
    stashSaveFromPanel,
    shelfReadFromMessage,
    type StashMutation,
} from "./commitPanelActions";
import {
    deleteFileFromPanel,
    openFileFromPanel,
    publishBranchFromPanel,
    selectStashFromPanel,
    showDiffFromPanel,
    showStashDiffFromPanel,
    stageFilesFromPanel,
    unstageFilesFromPanel,
} from "./panelFileActions";
import { abortMergeWithConfirmation } from "./mergeAbort";
import { ShelfConflictEditorPanel } from "./ShelfConflictEditorPanel";
interface PersistedColumnWidths {
    repositoryWidth: number;
    branchWidth: number;
    graphWidth: number;
    infoWidth: number;
    commitPanelWidth: number;
}

const DEFAULT_REPOSITORY_COLUMN_WIDTH = 168;

interface UndockedRepositoryData {
    branches: Branch[];
    worktrees?: GitWorktree[];
}

interface UndockedViewProviderOptions {
    executor?: Pick<GitExecutor, "setRoot">;
    repositories?: RepositoryViewIdentity[];
    selectedRepositoryRoot?: string;
    loadRepositoryData?: (root: string) => Promise<UndockedRepositoryData>;
    onSelectedRepositoryRootChanged?: (root: string) => Promise<void> | void;
    shelfServiceForRepository?: (root: string) => ShelfService | undefined;
    /** Activation-time default for removing successfully applied entries after unshelve. */
    shelfRemoveOnUnshelve?: boolean;
    commitChecksService?: CommitChecksService;
    commitChecksProviders?: readonly CommitChecksProvider[];
    /** Shared activation-owned coordinator; undocked providers never construct their own. */
    commitMessageGenerationCoordinator?: CommitMessageGenerationCoordinator;
}

/**
 * Reads persisted undocked column widths while tolerating older payload shapes.
 *
 * Older workspaces may not contain `graphWidth` or `repositoryWidth`; compatible
 * fallbacks preserve the former four widths without rejecting the whole layout.
 * Non-finite or incomplete payloads are rejected so stale memento data cannot
 * push invalid layout sizes into the webview.
 */
function migratePersistedColumnWidths(value: unknown): PersistedColumnWidths | undefined {
    if (!value || typeof value !== "object") return undefined;
    const saved = value as Record<string, unknown>;
    const repositoryWidth = saved.repositoryWidth;
    const branchWidth = saved.branchWidth;
    const graphWidth = saved.graphWidth;
    const infoWidth = saved.infoWidth;
    const commitPanelWidth = saved.commitPanelWidth;
    if (
        typeof branchWidth !== "number" ||
        !Number.isFinite(branchWidth) ||
        typeof infoWidth !== "number" ||
        !Number.isFinite(infoWidth) ||
        typeof commitPanelWidth !== "number" ||
        !Number.isFinite(commitPanelWidth)
    ) {
        return undefined;
    }
    return {
        repositoryWidth:
            typeof repositoryWidth === "number" && Number.isFinite(repositoryWidth)
                ? repositoryWidth
                : DEFAULT_REPOSITORY_COLUMN_WIDTH,
        branchWidth,
        graphWidth:
            typeof graphWidth === "number" && Number.isFinite(graphWidth) ? graphWidth : infoWidth,
        infoWidth,
        commitPanelWidth,
    };
}

/**
 * Owns the undocked IntelliGit webview panel that combines graph, commit info, and Changes UI.
 *
 * The provider mirrors sidebar commit graph and commit-panel behavior for one active repository,
 * including pagination, branch filters, commit details, stashes, drafts, and persisted column
 * widths. Webview messages are validated before Git operations or file actions run, and all
 * script/resources are loaded from the extension `dist` directory.
 */
export class UndockedViewProvider {
    public static readonly viewType = "intelligit.undocked";
    private static readonly MAX_VISIBLE_COMMIT_CHECKS = 200;
    private panel?: vscode.WebviewPanel;
    private readonly gitOps: GitOps;
    private readonly executor?: Pick<GitExecutor, "setRoot">;
    private readonly loadRepositoryData?: (root: string) => Promise<UndockedRepositoryData>;
    private readonly onSelectedRepositoryRootChanged?: (root: string) => Promise<void> | void;
    private readonly shelfServiceForRepository?: (root: string) => ShelfService | undefined;
    private readonly shelfRemoveOnUnshelve: boolean;
    private readonly commitMessageGenerationCoordinator?: CommitMessageGenerationCoordinator;
    private shelfService?: ShelfService;
    private readonly iconTheme: IconThemeService;
    private repoRootUri: vscode.Uri;
    private repositoryLabel = "";
    private repositories: RepositoryViewIdentity[] = [];
    private selectedRepositoryRoot: string;
    // Graph-side state
    private currentBranch: string | null = null;
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private requestSeq = 0;
    private repositorySwitchSeq = 0;
    private readonly PAGE_SIZE = 500;
    private branches: Branch[] = [];
    private worktrees: GitWorktree[] = [];
    private selectedCommitDetail: CommitDetail | null = null;
    private commitDetailLoading = false;
    private readonly commitChecks: CommitChecksCoordinator;
    private commitChecksGeneration = 0;
    private commitCheckDemandSeq = 0;
    private loadedCommitHashes = new Set<string>();
    private checkableCommitHashes = new Set<string>();
    private constrainCommitCheckHashes = false;
    private folderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    // Commit-panel state
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedStashIndex: number | null = null;
    private stashFiles: WorkingFile[] = [];
    private shelves: ShelfEntry[] = [];
    private catalogGeneration = 0;
    private selectedShelfId: string | null = null;
    private lastFileCount = 0;
    private showIgnoredFiles = false;
    // Event emitters
    private readonly _onCommitSelected = new vscode.EventEmitter<string>();
    readonly onCommitSelected = this._onCommitSelected.event;
    private readonly _onBranchAction = new vscode.EventEmitter<{
        action: BranchAction;
        branchName: string;
    }>();
    readonly onBranchAction = this._onBranchAction.event;

    private readonly _onDeleteBranches = new vscode.EventEmitter<Branch[]>();
    readonly onDeleteBranches = this._onDeleteBranches.event;
    private readonly _onWorktreeAction = new vscode.EventEmitter<{
        action: WorktreeAction;
        path: string;
    }>();
    readonly onWorktreeAction = this._onWorktreeAction.event;
    private readonly _onCommitAction = new vscode.EventEmitter<{
        action: CommitAction;
        hash: string;
    }>();
    readonly onCommitAction = this._onCommitAction.event;
    private readonly _onOpenCommitFileDiff = new vscode.EventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    readonly onOpenCommitFileDiff = this._onOpenCommitFileDiff.event;
    private readonly _onDidChangeFileCount = new vscode.EventEmitter<number>();
    readonly onDidChangeFileCount = this._onDidChangeFileCount.event;
    private readonly _onDidChangeWorkingTree = new vscode.EventEmitter<void>();
    readonly onDidChangeWorkingTree = this._onDidChangeWorkingTree.event;
    private readonly _onDockRequested = new vscode.EventEmitter<void>();
    readonly onDockRequested = this._onDockRequested.event;
    private readonly _onDidDispose = new vscode.EventEmitter<void>();
    readonly onDidDispose = this._onDidDispose.event;
    /** Stable host identity scopes shared-generation cancellation to this provider lifetime. */
    private readonly commitMessageGenerationHost: CommitMessageGenerationHost = {
        emit: (event) => {
            this.postToWebview({ type: "commitMessageGeneration", ...event });
            if (event.kind === "error" && event.errorKind) {
                void showCommitMessageGenerationNotification(event.errorKind).catch(
                    (error: unknown) => {
                        console.error(
                            "[IntelliGit] Commit-message generation notification failed:",
                            error,
                        );
                    },
                );
            }
        },
    };
    private static readonly COMMIT_DRAFT_KEY_PREFIX = "commitDraft:";
    private static readonly COLUMN_WIDTHS_KEY = "intelligit.undockedColumnWidths";
    /**
     * Creates the retained undocked panel controller for one active repository.
     *
     * The repository URI scopes file actions, commit drafts, and refresh assumptions, while the
     * optional memento stores layout and draft state that outlives individual webview panels.
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        gitOps: GitOps,
        repoRootUri: vscode.Uri,
        credentialStore: CredentialStore,
        private readonly workspaceState?: vscode.Memento,
        hostMap: HostMap = {},
        private readonly commitChecksSettings?: CommitChecksSettings,
        options: UndockedViewProviderOptions = {},
    ) {
        this.gitOps = gitOps;
        this.executor = options.executor;
        this.loadRepositoryData = options.loadRepositoryData;
        this.onSelectedRepositoryRootChanged = options.onSelectedRepositoryRootChanged;
        this.shelfServiceForRepository = options.shelfServiceForRepository;
        this.shelfRemoveOnUnshelve = options.shelfRemoveOnUnshelve ?? true;
        this.commitMessageGenerationCoordinator = options.commitMessageGenerationCoordinator;
        this.repositories =
            options.repositories && options.repositories.length > 0
                ? options.repositories
                : [this.repositoryFromRoot(repoRootUri.fsPath)];
        this.selectedRepositoryRoot =
            this.findRepository(options.selectedRepositoryRoot ?? repoRootUri.fsPath)?.root ??
            this.findRepository(repoRootUri.fsPath)?.root ??
            this.repositories[0]?.root ??
            repoRootUri.fsPath;
        this.repoRootUri = vscode.Uri.file(this.selectedRepositoryRoot);
        this.shelfService = this.shelfServiceForRepository?.(this.selectedRepositoryRoot);
        this.executor?.setRoot(this.selectedRepositoryRoot);
        this.iconTheme = new IconThemeService(this.extensionUri);
        this.commitChecks = new CommitChecksCoordinator(
            this.gitOps,
            options.commitChecksProviders ?? [
                new GitHubProvider(httpGetJson, commitChecksSettings?.ciCdPattern),
                new GitLabProvider(httpGetJson, credentialStore, commitChecksSettings?.ciCdPattern),
                new BitbucketCloudProvider(httpGetJson, credentialStore),
                new BitbucketServerProvider(httpGetJson, credentialStore),
            ],
            hostMap,
            {
                enabled: commitChecksSettings?.enabled,
                providerEnabled: commitChecksSettings?.providers,
                ttlMs: DEFAULT_COMMIT_CHECKS_TTL_MS,
                service: options.commitChecksService,
                settingsFingerprint: commitChecksSettingsFingerprint(commitChecksSettings),
            },
        );
    }

    /**
     * Drops cached commit-check snapshots so the next request re-fetches.
     *
     * Called after a credential change (sign-in or sign-out) because a stored
     * "unavailable" snapshot is a terminal state the coordinator would otherwise
     * never re-fetch, leaving the badge stuck after the user signs in.
     */
    clearChecksCache(): void {
        this.commitChecksGeneration += 1;
        this.commitChecks.clear();
    }
    /**
     * Updates the panel title fragment used when the active repository label changes.
     */
    setRepositoryLabel(label: string): void {
        this.repositoryLabel = label;
        if (this.panel) this.panel.title = `IntelliGit — ${label}`;
    }

    /**
     * Replaces known repositories while preserving the selected undocked root when possible.
     *
     * If no known root remains, active generation work and async repository operations for the
     * previous selection are cancelled without inventing a replacement root.
     */
    setRepositories(
        repositories: RepositoryViewIdentity[],
        selectedRepositoryRoot = this.selectedRepositoryRoot,
    ): void {
        this.repositories = repositories;
        const selected =
            this.findRepository(selectedRepositoryRoot) ??
            this.findRepository(this.selectedRepositoryRoot) ??
            this.repositories[0];
        if (!selected) {
            this.beginRepositorySwitch();
            this.commitMessageGenerationCoordinator?.dropHostRoot(
                this.commitMessageGenerationHost,
                this.selectedRepositoryRoot,
            );
            this.sendRepositories();
            return;
        }
        const changed = selected.root !== this.selectedRepositoryRoot;
        const shouldContinue = changed ? this.beginRepositorySwitch() : undefined;
        if (changed) {
            this.commitMessageGenerationCoordinator?.dropHostRoot(
                this.commitMessageGenerationHost,
                this.selectedRepositoryRoot,
            );
        }
        this.applyRepositoryRoot(selected, { reset: changed, updateExecutor: changed });
        if (shouldContinue) {
            this.sendRepositories();
            void this.reloadSelectedRepository(shouldContinue).catch((err) => {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
                this.postToWebview({ type: "error", message });
            });
            return;
        }
        this.sendRepositories();
    }

    /**
     * Switches the undocked panel to a new active repository and clears repository-scoped caches.
     *
     * The panel keeps its VS Code window alive, but graph, working-tree, stash, and detail caches
     * are reset so subsequent refreshes cannot display rows from the previous repository.
     */
    setRepositoryRootUri(repoRootUri: vscode.Uri): void {
        const repository =
            this.findRepository(repoRootUri.fsPath) ?? this.repositoryFromRoot(repoRootUri.fsPath);
        if (repository.root !== this.selectedRepositoryRoot) {
            this.beginRepositorySwitch();
            this.commitMessageGenerationCoordinator?.dropHostRoot(
                this.commitMessageGenerationHost,
                this.selectedRepositoryRoot,
            );
        }
        this.applyRepositoryRoot(repository, { reset: true, updateExecutor: false });
    }

    /**
     * Switches the dedicated undocked runtime to a known repository root.
     *
     * Unknown roots are rejected before the executor moves. Successful switches reset repository
     * caches, persist selection through the caller callback, reload branches, reload the first graph
     * page, refresh the commit-panel snapshot, and restore the selected repository draft.
     */
    async setActiveRepositoryRoot(root: string): Promise<void> {
        const repository = this.findRepository(root);
        if (!repository) {
            throw new Error("Unknown repository root received from webview.");
        }
        if (repository.root !== this.selectedRepositoryRoot) {
            this.commitMessageGenerationCoordinator?.dropHostRoot(
                this.commitMessageGenerationHost,
                this.selectedRepositoryRoot,
            );
        }
        const shouldContinue = this.beginRepositorySwitch();
        this.applyRepositoryRoot(repository, { reset: true, updateExecutor: true });
        if (!shouldContinue()) return;
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.onSelectedRepositoryRootChanged?.(repository.root);
        if (!shouldContinue()) return;
        this.sendRepositories();
        await this.reloadSelectedRepository(shouldContinue);
    }

    /**
     * Starts a repository switch and returns a guard for async continuations spawned by it.
     */
    private beginRepositorySwitch(): () => boolean {
        const requestId = ++this.repositorySwitchSeq;
        return () => requestId === this.repositorySwitchSeq;
    }

    /**
     * Reloads all repository-scoped panels after the selected root changes.
     */
    private async reloadSelectedRepository(shouldContinue: () => boolean): Promise<void> {
        if (!shouldContinue()) return;
        const repositoryRoot = this.selectedRepositoryRoot;
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.iconTheme.initIconThemeData();
        if (!shouldContinue()) return;
        if (!(await this.reloadBranches(shouldContinue))) return;
        if (!shouldContinue()) return;
        // The post-await guard prevents a superseded repository switch from updating the panel.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.loadInitial();
        if (!shouldContinue()) return;
        this.postCommitDetailState();
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.refreshCommitPanelData(false, shouldContinue);
        if (!shouldContinue()) return;
        this.postToWebview({
            type: "restoreCommitDraft",
            repositoryRoot,
            message: this.getStoredCommitDraft(repositoryRoot),
        });
    }

    private applyRepositoryRoot(
        repository: RepositoryViewIdentity,
        options: { reset: boolean; updateExecutor: boolean },
    ): void {
        this.selectedRepositoryRoot = repository.root;
        this.repoRootUri = vscode.Uri.file(repository.root);
        this.repositoryLabel = repository.label;
        this.shelfService = this.shelfServiceForRepository?.(repository.root);
        if (this.panel) this.panel.title = `IntelliGit — ${repository.label}`;
        if (options.updateExecutor) this.executor?.setRoot(repository.root);
        if (options.reset) this.resetRepositoryScopedState();
    }

    private resetRepositoryScopedState(): void {
        this.requestSeq += 1;
        this.commitDetailSeq += 1;
        this.files = [];
        this.stashes = [];
        this.selectedStashIndex = null;
        this.stashFiles = [];
        this.shelves = [];
        this.catalogGeneration = 0;
        this.selectedShelfId = null;
        this.branches = [];
        this.worktrees = [];
        this.currentBranch = null;
        this.lastFileCount = 0;
        this.selectedCommitDetail = null;
        this.folderIconsByName = {};
        this.branchFolderIconsByName = {};
        this.commitChecksGeneration += 1;
        this.commitChecks.clearProviderResolution();
        this.clearCommitCheckHashScope();
        this.filterText = "";
        this.offset = 0;
        this.loadingMore = false;
    }
    /**
     * Replaces the graph branch cache and posts decorated branch metadata when a panel exists.
     */
    setBranches(branches: Branch[], worktrees: GitWorktree[] = []): void {
        this.branches = branches;
        this.worktrees = worktrees;
        this.sendBranches().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Branch update error: {message}", { message }),
            );
        });
    }

    private async reloadBranches(shouldContinue: () => boolean = () => true): Promise<boolean> {
        if (!shouldContinue()) return false;
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const data = this.loadRepositoryData
            ? await this.loadRepositoryData(this.selectedRepositoryRoot)
            : { branches: await this.gitOps.getBranches(), worktrees: [] };
        if (!shouldContinue()) return false;
        this.branches = data.branches;
        this.worktrees = data.worktrees ?? [];
        await this.sendBranches(shouldContinue);
        return shouldContinue();
    }

    private repositoryFromRoot(root: string): RepositoryViewIdentity {
        const parts = root.split(/[\\/]/).filter(Boolean);
        return {
            root,
            label: parts[parts.length - 1] ?? root,
        };
    }

    private findRepository(root: string | undefined): RepositoryViewIdentity | undefined {
        if (!root) return undefined;
        return this.repositories.find((repository) => repository.root === root);
    }

    private sendRepositories(): void {
        this.postToWebview({
            type: "repositories",
            repositories: this.repositories,
            selectedRepositoryRoot: this.selectedRepositoryRoot,
        });
    }

    /**
     * Caches the selected commit detail and decorates it with icon metadata asynchronously.
     *
     * A sequence token prevents slower decoration work from overwriting a newer selected commit or
     * a clear operation.
     */
    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
        this.commitDetailLoading = false;
        this.folderIconsByName = {};
        this.postCommitDetailState();
        this.decorateAndStoreCommitDetail(detail, requestId).catch((err) => {
            if (requestId !== this.commitDetailSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Commit detail error: {message}", { message }),
            );
        });
    }
    /**
     * Clears the selected commit detail and invalidates pending decoration requests.
     */
    clearCommitDetail(options?: { loading?: boolean }): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.commitDetailLoading = options?.loading ?? false;
        this.folderIconsByName = {};
        this.postToWebview(
            this.commitDetailLoading
                ? { type: "clearCommitDetail", loading: true }
                : { type: "clearCommitDetail" },
        );
    }
    /**
     * Refreshes graph branches/commits and commit-panel data for the current repository.
     */
    async refresh(shouldContinue: () => boolean = () => true): Promise<void> {
        if (!shouldContinue()) return;
        // Theme data must be current before branch and commit payloads are decorated.
        // react-doctor-disable-next-line react-doctor/async-parallel, react-doctor/async-defer-await
        await this.iconTheme.initIconThemeData();
        if (!shouldContinue()) return;
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.sendBranches(shouldContinue);
        if (!shouldContinue()) return;
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.loadInitial(shouldContinue);
        if (!shouldContinue()) return;
        await this.refreshCommitPanelData(false, shouldContinue);
    }

    /** Refreshes graph and commit-panel data without showing commit-panel refresh feedback. */
    async refreshSilent(): Promise<void> {
        // Silent refresh keeps the same theme -> branches -> log ordering as visible refresh.
        // react-doctor-disable-next-line react-doctor/async-parallel
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        await this.loadInitial();
        await this.refreshCommitPanelData(true);
    }

    /**
     * Reveals the retained panel when it exists and otherwise leaves state untouched.
     *
     * Callers can use this for optional focus commands without accidentally creating a new webview
     * or resurrecting a disposed panel.
     */
    reveal(): void {
        if (this.panel) {
            this.panel.reveal();
        }
    }
    /**
     * Creates or reveals the retained undocked webview panel.
     *
     * A new panel attaches icon-theme resources, registers theme/configuration listeners, and
     * installs the unified message bridge. Reopening an existing panel only reveals it so webview
     * state retained by VS Code is preserved. Fresh creation and teardown invalidate viewport
     * demand owned by the previous panel lifecycle.
     */
    open(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        this.commitCheckDemandSeq += 1;
        this.panel = vscode.window.createWebviewPanel(
            UndockedViewProvider.viewType,
            `IntelliGit — ${this.repositoryLabel}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
            },
        );
        this.iconTheme.attachWebview(this.panel.webview);
        this.registerThemeChangeListeners();
        this.panel.webview.html = this.getHtml(this.panel.webview);
        this.panel.onDidDispose(() => {
            this.commitCheckDemandSeq += 1;
            this.commitMessageGenerationCoordinator?.dropHost(this.commitMessageGenerationHost);
            this.panel = undefined;
            this.iconTheme.dispose();
            this.disposeThemeChangeDisposables();
            this._onDidDispose.fire();
        });
        this.panel.webview.onDidReceiveMessage(async (msg: UnifiedOutbound) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
                this.postToWebview({ type: "error", message });
            }
        });
        // Forward real panel visibility; the retained webview cannot trust
        // document.visibilityState, so demand must be gated by the host signal.
        this.panel.onDidChangeViewState(() => {
            this.postToWebview({
                type: "setViewVisibility",
                visible: this.panel?.visible ?? false,
            });
        });
    }
    /**
     * Invalidates commit-check demand and disposes the panel, theme resources, and host emitters.
     */
    dispose(): void {
        this.commitCheckDemandSeq += 1;
        this.commitMessageGenerationCoordinator?.dropHost(this.commitMessageGenerationHost);
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onCommitSelected.dispose();
        this._onBranchAction.dispose();
        this._onDeleteBranches.dispose();
        this._onWorktreeAction.dispose();
        this._onCommitAction.dispose();
        this._onOpenCommitFileDiff.dispose();
        this._onDidChangeFileCount.dispose();
        this._onDidChangeWorkingTree.dispose();
        this._onDockRequested.dispose();
        this._onDidDispose.dispose();
        this.panel?.dispose();
    }
    // --- Message handling --------------------------------------------------
    /**
     * Dispatches the unified graph, commit-panel, layout, and dock messages from the webview.
     *
     * Readiness restores layout settings before expensive Git refreshes so persisted widths are not
     * overwritten by default webview measurements. Path arrays, stash indexes, commit hashes, and
     * branch action names are validated before any Git or VS Code command boundary is crossed.
     */
    /** Runs a correlated stash mutation and posts a rootless completion for the active pane. */
    private runStashMutationRequest(
        mutation: StashMutation,
        requestIdValue: unknown,
    ): Promise<void> {
        return executeStashMutationRequest(
            {
                gitOps: this.gitOps,
                refreshData: () => this.refreshCommitPanelData(),
                fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
            },
            mutation,
            requestIdValue,
            (requestId) => this.postToWebview({ type: "stashMutationCompleted", requestId }),
        );
    }

    /** Selects a shelf from the service bound to the current undocked repository root. */
    private async selectShelf(shelfIdValue: unknown): Promise<void> {
        const shelfId = assertShelfId(shelfIdValue, "shelfId");
        const service = this.requireShelfService();
        const listed = await service.listShelves();
        if (!listed.shelves.some((shelf) => shelf.id === shelfId)) {
            throw new Error("Shelf does not exist.");
        }
        this.shelves = await decorateShelfFiles(this.iconTheme, listed.shelves);
        this.catalogGeneration = listed.catalogGeneration;
        this.selectedShelfId = shelfId;
        await this.refreshCommitPanelData(true);
    }

    /** Runs a correlated shelf mutation against this panel's selected repository only. */
    private async runShelfMutationRequest(message: Record<string, unknown>): Promise<void> {
        assertString(message.requestId, "requestId");
        const shelfService = this.requireShelfService();
        try {
            await executeShelfMutationRequest(
                {
                    shelfService,
                    refreshData: () => this.refreshCommitPanelData(false),
                    fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
                    selectExportDestination: async () =>
                        (await vscode.window.showSaveDialog())?.fsPath,
                    selectImportSources: async () =>
                        (
                            await vscode.window.showOpenDialog({
                                canSelectFiles: true,
                                canSelectFolders: false,
                                canSelectMany: true,
                                filters: { "Patch files": ["patch", "diff"] },
                            })
                        )?.map((uri) => uri.fsPath),
                },
                message,
                (completion) => this.postToWebview(completion),
            );
        } catch {
            // A valid correlated request already posted shelfMutationCompleted.
        }
    }

    private requireShelfService(): ShelfService {
        if (!this.shelfService)
            throw new Error("Shelf service is unavailable for this repository.");
        return this.shelfService;
    }

    /** Validates and opens a non-mutating shelf conflict editor for the selected repository. */
    private async openShelfConflictEditor(message: Record<string, unknown>): Promise<void> {
        const shelfService = this.requireShelfService();
        await openShelfConflictEditorFromMessage(
            {
                shelfService,
                openShelfConflictEditor: (shelfId, changeId) =>
                    ShelfConflictEditorPanel.open({
                        extensionUri: this.extensionUri,
                        repositoryRoot: this.selectedRepositoryRoot,
                        shelfService,
                        shelfId,
                        changeId,
                        onApplied: async () => {
                            await this.refreshCommitPanelData(false);
                            this._onDidChangeWorkingTree.fire();
                        },
                    }),
            },
            message,
        );
    }

    private async shelfSnapshot(): Promise<{
        shelves: ShelfEntry[];
        catalogGeneration: number;
        selectedShelfId: string | null;
        shelfRemoveOnUnshelve: boolean;
        shelfHealth: ShelfHealthWarning[];
    }> {
        if (!this.shelfService) {
            return {
                shelves: [],
                catalogGeneration: 0,
                selectedShelfId: null,
                shelfRemoveOnUnshelve: this.shelfRemoveOnUnshelve,
                shelfHealth: [],
            };
        }
        const listed = await this.shelfService.listShelves();
        const selectedShelfId = listed.shelves.some((shelf) => shelf.id === this.selectedShelfId)
            ? this.selectedShelfId
            : (listed.shelves[0]?.id ?? null);
        return {
            shelves: await decorateShelfFiles(this.iconTheme, listed.shelves),
            catalogGeneration: listed.catalogGeneration,
            selectedShelfId,
            shelfRemoveOnUnshelve: this.shelfRemoveOnUnshelve,
            shelfHealth: this.shelfService.getHealthWarnings().map((warning) => ({ ...warning })),
        };
    }

    /** Runs a correlated single-file stash request for the active undocked repository. */
    private runStashFileMutationRequest(message: Record<string, unknown>): Promise<void> {
        return executeStashFileMutationRequest(
            {
                gitOps: this.gitOps,
                refreshData: () => this.refreshCommitPanelData(),
                fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
            },
            message,
            (requestId) => this.postToWebview({ type: "stashMutationCompleted", requestId }),
        );
    }

    private async handleMessage(msg: UnifiedOutbound): Promise<void> {
        const commitRepositoryRoot = this.repoRootUri.fsPath;
        const commitDraftStorageKey = this.getCommitDraftStorageKey();
        const actionDeps = {
            gitOps: this.gitOps,
            refreshData: () => this.refreshCommitPanelData(),
            refreshGraphData: async () => {
                await this.sendBranches();
                await this.loadInitial();
                this.postCommitDetailState();
            },
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
            postCommitted: async () => {
                let clearCommitMessage =
                    vscode.workspace
                        .getConfiguration("intelligit")
                        .get<boolean>("clearLastCommit", true) !== false;
                if (clearCommitMessage && this.workspaceState) {
                    try {
                        await this.workspaceState.update(commitDraftStorageKey, undefined);
                    } catch {
                        clearCommitMessage = false;
                    }
                }
                if (this.repoRootUri.fsPath !== commitRepositoryRoot) return;
                this.postToWebview({
                    type: "committed",
                    repositoryRoot: commitRepositoryRoot,
                    clearCommitMessage,
                });
            },
            maybeOfferPublishBranch: () => Promise.resolve(),
        };
        const fileActionDeps = {
            gitOps: this.gitOps,
            getWorkspaceRoot: () => this.repoRootUri,
            refreshData: () => this.refreshCommitPanelData(),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
        };
        switch (msg.type) {
            case "generateCommitMessage":
                this.handleGenerateCommitMessage(msg);
                break;
            case "cancelCommitMessageGeneration":
                this.handleCancelCommitMessageGeneration(msg);
                break;
            // Graph-side
            case "ready":
                this.postToWebview({
                    type: "setViewVisibility",
                    visible: this.panel?.visible ?? false,
                });
                // Restore column widths first, before the slow git operations
                // below, so the webview applies saved widths immediately and
                // never overwrites them with its pre-restore equal widths.
                this.sendPersistedColumnWidths();
                this.sendSettings();
                this.sendRepositories();
                await this.iconTheme.initIconThemeData();
                await this.sendBranches();
                await this.loadInitial();
                this.postCommitDetailState();
                await this.refreshCommitPanelData();
                this.postToWebview({
                    type: "restoreCommitDraft",
                    repositoryRoot: commitRepositoryRoot,
                    message: this.getStoredCommitDraft(commitRepositoryRoot),
                });
                break;
            case "selectRepository":
                await this.setActiveRepositoryRoot(
                    assertString(msg.repositoryRoot, "repositoryRoot"),
                );
                break;
            case "selectCommit":
                this._onCommitSelected.fire(assertGitHash(msg.hash, "hash"));
                break;
            case "loadMore":
                await this.loadMore();
                break;
            case "filterText":
                await this.filterByText(assertString(msg.text, "text"));
                break;
            case "filterBranch":
                this.currentBranch = assertNullableString(msg.branch, "branch");
                this.commitCheckDemandSeq += 1;
                this.filterText = "";
                this.postToWebview({
                    type: "setSelectedBranch",
                    branch: this.currentBranch,
                });
                await this.loadInitial();
                break;
            case "branchAction":
                if (!isBranchAction(assertString(msg.action, "action"))) {
                    throw new Error("Invalid branch action received from webview.");
                }
                this._onBranchAction.fire({
                    action: msg.action,
                    branchName: assertString(msg.branchName, "branchName"),
                });
                break;
            case "deleteBranches":
                this._onDeleteBranches.fire(this.assertBranchSelection(msg));
                break;
            case "worktreeAction":
                if (!isWorktreeAction(assertString(msg.action, "action"))) {
                    throw new Error("Invalid worktree action received from webview.");
                }
                this._onWorktreeAction.fire({
                    action: msg.action,
                    path: assertString(msg.path, "path"),
                });
                break;
            case "commitAction":
                if (!isCommitAction(assertString(msg.action, "action"))) {
                    throw new Error("Invalid commit action received from webview.");
                }
                this._onCommitAction.fire({
                    action: msg.action,
                    hash: assertGitHash(msg.hash, "hash"),
                });
                break;
            case "openCommitFileDiff":
                this._onOpenCommitFileDiff.fire({
                    commitHash: assertGitHash(msg.commitHash, "commitHash"),
                    filePath: assertRepoRelativePath(assertString(msg.filePath, "filePath")),
                });
                break;
            case "requestVisibleCommitChecks":
                await this.sendVisibleCommitChecksRequest(msg);
                break;
            case "openCommitCheckUrl":
                await this.openExternalHttpUrl(assertString(msg.url, "url"));
                break;
            case "signInForCommitChecks":
                await vscode.commands.executeCommand(
                    "intelligit.commitChecks.signIn",
                    assertString(msg.host, "host"),
                );
                break;
            case "dock":
                this._onDockRequested.fire();
                break;
            case "columnWidths":
                await this.workspaceState?.update(UndockedViewProvider.COLUMN_WIDTHS_KEY, {
                    repositoryWidth: assertNumber(msg.repositoryWidth, "repositoryWidth"),
                    branchWidth: assertNumber(msg.branchWidth, "branchWidth"),
                    graphWidth: assertNumber(msg.graphWidth, "graphWidth"),
                    infoWidth: assertNumber(msg.infoWidth, "infoWidth"),
                    commitPanelWidth: assertNumber(msg.commitPanelWidth, "commitPanelWidth"),
                });
                break;
            // Commit-panel-side
            case "refresh":
                await this.refreshCommitPanelData(false);
                break;
            case "shelfSelect":
                await this.selectShelf(msg.shelfId);
                break;
            case "shelfOpenConflictEditor":
                await this.openShelfConflictEditor(msg);
                break;
            case "shelfDiff":
            case "shelfCompareWithLocal":
                await shelfReadFromMessage(this.requireShelfService(), msg, () => this.repoRootUri);
                break;
            case "shelveSave":
            case "unshelve":
            case "shelfDelete":
            case "shelfRename":
            case "shelfExportPatch":
            case "shelfCopyPatchToClipboard":
            case "shelfImportPatch":
            case "shelfRestoreGhost":
            case "shelfCleanUp":
            case "shelfResolveStructural":
            case "shelfPurgeRecovery":
                await this.runShelfMutationRequest(msg);
                break;
            case "abortMerge":
                await abortMergeWithConfirmation({
                    gitOps: this.gitOps,
                    onConflictStateChanged: async () => {
                        await Promise.all([
                            this.refreshCommitPanelData(false),
                            this.sendBranches(),
                            this.loadInitial(),
                        ]);
                        this.postCommitDetailState();
                        this._onDidChangeWorkingTree.fire();
                        await vscode.commands.executeCommand("intelligit.mergeConflictsRefresh");
                    },
                });
                break;
            case "setShowIgnoredFiles":
                this.showIgnoredFiles = msg.showIgnoredFiles === true;
                await this.refreshCommitPanelData(true);
                break;
            case "saveCommitDraft": {
                const message = assertString(msg.message, "message");
                const repository = this.findRepository(msg.repositoryRoot);
                if (!repository) {
                    throw new Error("Unknown repository root received from webview.");
                }
                await this.workspaceState?.update(
                    this.getCommitDraftStorageKey(repository.root),
                    message || undefined,
                );
                break;
            }
            case "stageFiles":
                await stageFilesFromPanel(fileActionDeps, msg.paths);
                break;
            case "unstageFiles":
                await unstageFilesFromPanel(fileActionDeps, msg.paths);
                break;
            case "commitSelected": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                await this.runCommitActionWithLease(commitRepositoryRoot, (rootGitOps) =>
                    commitSelectedFromPanel(
                        { ...actionDeps, gitOps: rootGitOps },
                        {
                            message,
                            amend: msg.amend === true,
                            push: msg.push === true,
                            paths: assertRepoPathArray(msg.paths, "paths"),
                        },
                    ),
                );
                break;
            }
            case "commit": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                await this.runCommitActionWithLease(commitRepositoryRoot, (rootGitOps) =>
                    commitOnlyFromPanel(
                        { ...actionDeps, gitOps: rootGitOps },
                        message,
                        msg.amend === true,
                    ),
                );
                break;
            }
            case "commitAndPush": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                await this.runCommitActionWithLease(commitRepositoryRoot, (rootGitOps) =>
                    commitAndPushFromPanel(
                        { ...actionDeps, gitOps: rootGitOps },
                        message,
                        msg.amend === true,
                    ),
                );
                break;
            }
            case "fetch":
            case "pull":
            case "push":
            case "sync":
                await runGitOperationFromPanel(actionDeps, msg.type);
                break;
            case "publishBranch":
                await publishBranchFromPanel(fileActionDeps);
                break;
            case "getLastCommitMessage": {
                const lastMsg = await this.gitOps
                    .deriveFor(commitRepositoryRoot)
                    .getLastCommitMessage();
                this.postToWebview({
                    type: "lastCommitMessage",
                    repositoryRoot: commitRepositoryRoot,
                    message: lastMsg,
                });
                break;
            }
            case "getAmendBranchCommits": {
                const commits = await this.gitOps
                    .deriveFor(commitRepositoryRoot)
                    .getAmendBranchCommits();
                this.postToWebview({
                    type: "amendBranchCommits",
                    repositoryRoot: commitRepositoryRoot,
                    commits,
                });
                break;
            }
            case "rollback": {
                await rollbackFromPanel(actionDeps, assertRepoPathArray(msg.paths, "paths"));
                break;
            }
            case "showDiff":
                await showDiffFromPanel(fileActionDeps, msg.path);
                break;
            case "stashSave": {
                await stashSaveFromPanel(actionDeps, {
                    name: typeof msg.name === "string" ? msg.name : "Stashed changes",
                    paths:
                        msg.paths !== undefined
                            ? assertRepoPathArray(msg.paths, "paths")
                            : undefined,
                });
                break;
            }
            case "stashPop":
                await stashMutationFromPanel(actionDeps, {
                    action: "pop",
                    index: assertNumber(msg.index, "index"),
                    reinstateIndex: false,
                });
                break;
            case "stashApply":
                await stashMutationFromPanel(actionDeps, {
                    action: "apply",
                    index: assertNumber(msg.index, "index"),
                    reinstateIndex: false,
                });
                break;
            case "cherryPickStashFile":
                await this.runStashFileMutationRequest(msg);
                break;
            case "stashDelete":
                await this.runStashMutationRequest(
                    { action: "delete", index: assertNumber(msg.index, "index") },
                    msg.requestId,
                );
                break;
            case "stashUnstash": {
                await this.runStashMutationRequest(
                    stashMutationFromUnstashMessage(msg),
                    msg.requestId,
                );
                break;
            }
            case "stashClear":
                await this.runStashMutationRequest({ action: "clear" }, msg.requestId);
                break;
            case "stashSelect": {
                const stashRepositoryRoot = this.selectedRepositoryRoot;
                const stashSwitchSeq = this.repositorySwitchSeq;
                const stashGitOps = this.gitOps.deriveFor(stashRepositoryRoot);
                await selectStashFromPanel(
                    {
                        ...fileActionDeps,
                        gitOps: stashGitOps,
                        iconTheme: this.iconTheme,
                        getFiles: () => this.files,
                        getStashes: () => this.stashes,
                        getShelfFilePaths: () => shelfFilePaths(this.shelves),
                        currentBranchHasUpstream: async () => {
                            const branches = await stashGitOps.getBranches();
                            const currentBranch = branches.find((branch) => branch.isCurrent);
                            return (
                                currentBranch?.upstream !== undefined &&
                                currentBranch.upstream.length > 0
                            );
                        },
                        setStashState: (state) => {
                            this.selectedStashIndex = state.selectedStashIndex;
                            this.stashFiles = state.stashFiles;
                        },
                        postUpdate: async (message) => {
                            // The selected-root check after this await prevents stale updates.
                            // react-doctor-disable-next-line react-doctor/async-defer-await
                            const [hasCommits, wholeIndexOperationInProgress] = await Promise.all([
                                stashGitOps.hasAnyCommits(),
                                stashGitOps.hasWholeIndexOperationInProgress(),
                            ]);
                            if (
                                this.selectedRepositoryRoot !== stashRepositoryRoot ||
                                this.repositorySwitchSeq !== stashSwitchSeq
                            ) {
                                return;
                            }
                            this.postToWebview({
                                ...message,
                                repositoryRoot: stashRepositoryRoot,
                                shelves: this.shelves,
                                catalogGeneration: this.catalogGeneration,
                                selectedShelfId: this.selectedShelfId,
                                hasCommits,
                                wholeIndexOperationInProgress,
                            });
                        },
                    },
                    msg.index,
                );
                break;
            }
            case "showStashDiff":
                await showStashDiffFromPanel(
                    fileActionDeps,
                    msg.index,
                    msg.path,
                    msg.preview !== false,
                );
                break;
            case "openFile":
                await openFileFromPanel(fileActionDeps, msg.path);
                break;
            case "deleteFile":
                await deleteFileFromPanel(fileActionDeps, msg.path);
                break;
        }
    }

    /** Runs one root-bound commit action while holding the shared commit lease until it settles. */
    private async runCommitActionWithLease(
        commitRepositoryRoot: string,
        operation: (rootGitOps: GitOps) => Promise<void>,
    ): Promise<void> {
        const rootGitOps = this.gitOps.deriveFor(commitRepositoryRoot);
        const release =
            this.commitMessageGenerationCoordinator?.acquireCommitLease(commitRepositoryRoot);
        try {
            await operation(rootGitOps);
        } finally {
            release?.();
        }
    }

    /** Registers an undocked request before root-bound asynchronous status validation. */
    private handleGenerateCommitMessage(message: { [key: string]: unknown }): void {
        const repositoryRoot = message.repositoryRoot;
        const requestId = message.requestId;
        if (typeof repositoryRoot !== "string" || typeof requestId !== "string") return;
        const reject = () => this.postInvalidCommitMessageGeneration(repositoryRoot, requestId);
        if (!repositoryRoot || !requestId || typeof message.amend !== "boolean") {
            reject();
            return;
        }
        const coordinator = this.commitMessageGenerationCoordinator;
        if (
            !coordinator ||
            !this.findRepository(repositoryRoot) ||
            repositoryRoot !== this.selectedRepositoryRoot
        ) {
            reject();
            return;
        }
        if (
            !Array.isArray(message.paths) ||
            message.paths.length > UndockedViewProvider.MAX_VISIBLE_COMMIT_CHECKS
        ) {
            reject();
            return;
        }
        let paths: string[];
        try {
            paths = Array.from(new Set(assertRepoPathArray(message.paths, "paths")));
        } catch {
            reject();
            return;
        }
        const amend = message.amend;
        const gitOps = this.gitOps.deriveFor(repositoryRoot);
        coordinator.submit({
            repositoryRoot,
            requestId,
            host: this.commitMessageGenerationHost,
            validate: async (control) => {
                // The post-await active check is the generation cancellation fence.
                // react-doctor-disable-next-line react-doctor/async-defer-await
                const validatedStatusSnapshot = await gitOps.getStatus({ withStats: false });
                if (!control.isActive()) return undefined;
                const selectablePaths = new Set<string>();
                const renameSources = new Set<string>();
                for (const file of validatedStatusSnapshot) {
                    if (file.status !== "!") selectablePaths.add(file.path);
                    if (file.status === "R" && file.sourcePath) renameSources.add(file.sourcePath);
                }
                if (
                    paths.some(
                        (filePath) => !selectablePaths.has(filePath) || renameSources.has(filePath),
                    )
                ) {
                    return undefined;
                }
                if (paths.length === 0 && !amend) return undefined;
                if (amend) {
                    const hasAnyCommits = await gitOps.hasAnyCommits();
                    if (!control.isActive() || !hasAnyCommits) return undefined;
                }
                return { paths, amend, validatedStatusSnapshot };
            },
        });
    }

    /** Cancels only this provider's current correlated attempt for its selected root. */
    private handleCancelCommitMessageGeneration(message: { [key: string]: unknown }): void {
        const repositoryRoot = message.repositoryRoot;
        const requestId = message.requestId;
        if (typeof repositoryRoot !== "string" || typeof requestId !== "string") return;
        const coordinator = this.commitMessageGenerationCoordinator;
        if (
            !repositoryRoot ||
            !requestId ||
            !coordinator ||
            !this.findRepository(repositoryRoot) ||
            repositoryRoot !== this.selectedRepositoryRoot
        ) {
            this.postInvalidCommitMessageGeneration(repositoryRoot, requestId);
            return;
        }
        coordinator.cancel({
            repositoryRoot,
            requestId,
            host: this.commitMessageGenerationHost,
        });
    }

    /** Emits a correlated invalid-request error without routing it through generic webview failures. */
    private postInvalidCommitMessageGeneration(repositoryRoot: string, requestId: string): void {
        this.commitMessageGenerationHost.emit({
            repositoryRoot,
            requestId,
            kind: "error",
            errorKind: "invalidRequest",
        });
    }
    // --- Graph data fetching ------------------------------------------------
    /**
     * Loads the first graph page and ignores stale results from superseded requests.
     */
    private async loadInitial(shouldContinue: () => boolean = () => true): Promise<void> {
        const requestId = ++this.requestSeq;
        this.offset = 0;
        this.loadingMore = false;
        if (this.currentBranch && !this.branches.some((b) => b.name === this.currentBranch)) {
            this.currentBranch = null;
            this.postToWebview({ type: "setSelectedBranch", branch: null });
        }
        try {
            // Stale-request guard must run after both async reads settle.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const [commits, unpushedHashes] = await Promise.all([
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    0,
                ),
                this.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId !== this.requestSeq || !shouldContinue()) return;
            this.offset = commits.length;
            this.replaceCommitCheckHashScope(commits, unpushedHashes);
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: false,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq || !shouldContinue()) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(vscode.l10n.t("Git log error: {message}", { message }));
            this.postToWebview({ type: "loadError", message });
        }
    }
    /**
     * Appends the next graph page while preventing duplicate pagination against one offset.
     */
    private async loadMore(): Promise<void> {
        if (this.loadingMore) return;
        this.loadingMore = true;
        const requestId = ++this.requestSeq;
        try {
            // Pagination guard must compare the captured request after async reads settle.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const [commits, unpushedHashes] = await Promise.all([
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    this.offset,
                ),
                this.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            this.offset += commits.length;
            this.addCommitCheckHashScope(commits, unpushedHashes);
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: true,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(vscode.l10n.t("Git log error: {message}", { message }));
            this.postToWebview({ type: "loadError", message });
        } finally {
            if (requestId === this.requestSeq) {
                this.loadingMore = false;
            }
        }
    }
    /** Stores the current text filter, invalidates viewport demand, and reloads page one. */
    private async filterByText(text: string): Promise<void> {
        this.commitCheckDemandSeq += 1;
        this.filterText = text;
        await this.loadInitial();
    }

    /**
     * Fetches one permitted snapshot and posts it only if cache and viewport generations still match.
     *
     * @param hash - Checked commit hash within the selected repository graph.
     * @param demandGeneration - Viewport demand generation that owns the reply.
     * @param force - Whether this webview request must bypass fresh cache layers.
     */
    private async sendCommitChecks(
        hash: string,
        demandGeneration: number,
        force: boolean,
    ): Promise<void> {
        const cacheGeneration = this.commitChecksGeneration;
        // Generation guard must run after the provider returns its snapshot.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const snapshot = await this.commitChecks.getChecks(hash, { force });
        if (cacheGeneration !== this.commitChecksGeneration) {
            this.commitChecks.clearProviderResolution();
            return;
        }
        if (demandGeneration !== this.commitCheckDemandSeq) return;
        this.postToWebview({ type: "setCommitChecks", snapshot });
    }

    /**
     * Replaces prior viewport demand and processes its validated hashes sequentially.
     *
     * Sequential processing lets a later viewport stop hashes that have not started while the
     * shared coordinator gate continues to coalesce work across independent view surfaces.
     */
    private async sendVisibleCommitChecksRequest(
        msg: Extract<UnifiedOutbound, { type: "requestVisibleCommitChecks" }>,
    ): Promise<void> {
        const generation = ++this.commitCheckDemandSeq;
        const hashes = this.assertVisibleCommitCheckHashes(msg);
        for (const hash of hashes) {
            if (generation !== this.commitCheckDemandSeq) return;
            // Sequential work lets a newer viewport cancel hashes that have not started.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await this.sendCommitChecksIfCheckable(hash, generation, msg.force === true);
        }
    }

    /**
     * Enforces loaded and pushed-commit scope before fetching or posting a visible badge.
     * Synthetic `none` snapshots obey the same demand generation as provider-backed snapshots.
     */
    private async sendCommitChecksIfCheckable(
        hash: string,
        generation: number,
        force: boolean,
    ): Promise<void> {
        if (!this.constrainCommitCheckHashes) {
            await this.sendCommitChecks(hash, generation, force);
            return;
        }
        if (!this.loadedCommitHashes.has(hash)) return;
        if (!this.checkableCommitHashes.has(hash)) {
            if (generation !== this.commitCheckDemandSeq) return;
            this.postToWebview({
                type: "setCommitChecks",
                snapshot: { hash, state: "none", summary: summaryForState("none"), items: [] },
            });
            return;
        }
        await this.sendCommitChecks(hash, generation, force);
    }

    /** Replaces first-page hash scope and invalidates demand tied to the previous graph result. */
    private replaceCommitCheckHashScope(commits: Commit[], unpushedHashes: string[]): void {
        this.commitCheckDemandSeq += 1;
        this.loadedCommitHashes = new Set();
        this.checkableCommitHashes = new Set();
        this.constrainCommitCheckHashes = true;
        this.addCommitCheckHashScope(commits, unpushedHashes);
    }

    /**
     * Extends pagination scope without invalidating active viewport demand.
     * Commits newly identified as unpushed become non-checkable.
     */
    private addCommitCheckHashScope(commits: Commit[], unpushedHashes: string[]): void {
        const unpushed = new Set(unpushedHashes);
        this.constrainCommitCheckHashes = true;
        for (const commit of commits) {
            this.loadedCommitHashes.add(commit.hash);
            if (unpushed.has(commit.hash)) {
                this.checkableCommitHashes.delete(commit.hash);
            } else {
                this.checkableCommitHashes.add(commit.hash);
            }
        }
    }

    /** Clears repository hash scope and invalidates any in-flight viewport demand. */
    private clearCommitCheckHashScope(): void {
        this.commitCheckDemandSeq += 1;
        this.loadedCommitHashes.clear();
        this.checkableCommitHashes.clear();
        this.constrainCommitCheckHashes = true;
    }

    /** Validates, bounds, and deduplicates untrusted visible hashes from the webview boundary. */
    private assertVisibleCommitCheckHashes(
        msg: Extract<UnifiedOutbound, { type: "requestVisibleCommitChecks" }>,
    ): string[] {
        if (!Array.isArray(msg.hashes)) throw new Error("Expected commit-check hashes array.");
        if (msg.hashes.length > UndockedViewProvider.MAX_VISIBLE_COMMIT_CHECKS) {
            throw new Error("Too many visible commit-check hashes.");
        }
        return Array.from(new Set(msg.hashes.map((hash) => assertGitHash(hash, "hashes"))));
    }

    private async openExternalHttpUrl(rawUrl: string): Promise<void> {
        const uri = vscode.Uri.parse(rawUrl);
        if (uri.scheme !== "https" && uri.scheme !== "http") {
            throw new Error("Unsupported commit check URL.");
        }
        await vscode.env.openExternal(uri);
    }
    // --- Commit panel data fetching -----------------------------------------
    /**
     * Validates bulk branch-delete selections from the undocked webview before host dispatch.
     *
     * Branch names are resolved through the latest host-owned snapshot so forged webview
     * payloads cannot alter local/remote metadata before command dispatch.
     */
    private assertBranchSelection(msg: { branches?: unknown; branchNames?: unknown }): Branch[] {
        const field = Array.isArray(msg.branches) ? "branches" : "branchNames";
        const names = Array.isArray(msg.branches)
            ? msg.branches.map((item, index) =>
                  this.assertBranchObjectName(item, `branches[${index}]`),
              )
            : this.assertBranchNames(msg.branchNames, "branchNames");
        return this.resolveBranchSelection(names, field);
    }

    /** Resolves validated branch names to the provider's latest trusted branch rows. */
    private resolveBranchSelection(names: string[], field: string): Branch[] {
        if (names.length === 0) {
            throw new Error(`Expected at least one branch for '${field}'.`);
        }
        const branchesByName = new Map(this.branches.map((branch) => [branch.name, branch]));
        const selected = names
            .map((name) => branchesByName.get(name))
            .filter((branch): branch is Branch => Boolean(branch));
        if (selected.length !== names.length) {
            const found = new Set(selected.map((branch) => branch.name));
            const missing = names.filter((name) => !found.has(name));
            throw new Error(`Unknown branch name(s) for '${field}': ${missing.join(", ")}`);
        }
        return selected;
    }

    /** Reads and validates only the selector name from an untrusted webview branch row. */
    private assertBranchObjectName(value: unknown, field: string): string {
        if (!value || typeof value !== "object") {
            throw new Error(`Expected branch object for '${field}'.`);
        }
        const name = assertString((value as { name?: unknown }).name, `${field}.name`);
        assertValidBranchName(name);
        return name;
    }

    private assertBranchNames(value: unknown, field: string): string[] {
        if (!Array.isArray(value)) {
            throw new Error(`Expected string array for '${field}'.`);
        }
        if (!value.every((item): item is string => typeof item === "string")) {
            throw new Error(`Expected string array for '${field}'.`);
        }
        if (value.length === 0) {
            throw new Error(`Expected at least one branch name for '${field}'.`);
        }
        for (const name of value) {
            assertValidBranchName(name);
        }
        return value;
    }

    /**
     * Reloads working-tree files, stashes, selected stash contents, and upstream status through one
     * root-bound GitOps facade.
     *
     * The selected stash is preserved when still present; otherwise the first stash is selected.
     * Non-silent calls emit `refreshing` messages so the undocked UI can show action feedback.
     * The captured root and repository-switch sequence fence every asynchronous continuation so a
     * superseded or ABA repository selection cannot mutate cached state or post a stale snapshot.
     */
    private async refreshCommitPanelData(
        silent = false,
        shouldContinue: () => boolean = () => true,
    ): Promise<void> {
        const repositoryRoot = this.selectedRepositoryRoot;
        const repositorySwitchSeq = this.repositorySwitchSeq;
        const rootGitOps = this.gitOps.deriveFor(repositoryRoot);
        const canUpdate = () =>
            shouldContinue() &&
            repositorySwitchSeq === this.repositorySwitchSeq &&
            repositoryRoot === this.selectedRepositoryRoot;
        if (!silent) this.postToWebview({ type: "refreshing", active: true });
        try {
            // Theme initialization must finish before decorated working-tree files are built.
            // react-doctor-disable-next-line react-doctor/async-parallel, react-doctor/async-defer-await
            await this.iconTheme.initIconThemeData();
            if (!canUpdate()) return;
            // The post-await root guard prevents stale refresh data from being published.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const status = await rootGitOps.getStatus({ includeIgnored: this.showIgnoredFiles });
            if (!canUpdate()) return;
            // The post-await root guard prevents stale refresh data from being published.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const files = await this.iconTheme.decorateWorkingFiles(status);
            if (!canUpdate()) return;
            // The post-await root guard prevents stale refresh data from being published.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const [stashes, currentBranchStatus, shelfState] = await Promise.all([
                rootGitOps.listStashes(),
                this.currentBranchStatus(rootGitOps),
                this.shelfSnapshot().catch(() => ({
                    shelves: this.shelves,
                    catalogGeneration: this.catalogGeneration,
                    selectedShelfId: this.selectedShelfId,
                })),
            ]);
            if (!canUpdate()) return;
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            const hasSelected =
                this.selectedStashIndex !== null &&
                stashes.some((entry) => entry.index === this.selectedStashIndex);
            const selectedStashIndex = hasSelected
                ? this.selectedStashIndex
                : stashes.length > 0
                  ? stashes[0].index
                  : null;
            // The post-await root guard prevents stale refresh data from being published.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const stashFiles =
                selectedStashIndex !== null
                    ? await this.iconTheme.decorateWorkingFiles(
                          await rootGitOps.getStashFiles(selectedStashIndex),
                      )
                    : [];
            if (!canUpdate()) return;
            // The post-await root guard prevents stale refresh data from being published.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const cpFolderIconsByName = await this.iconTheme.getFolderIconsByPaths([
                ...files.map((file) => file.path),
                ...stashFiles.map((file) => file.path),
                ...shelfFilePaths(shelfState.shelves),
            ]);
            if (!canUpdate()) return;
            // The post-await root guard prevents stale refresh data from being published.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const [hasCommits, wholeIndexOperationInProgress] = await Promise.all([
                rootGitOps.hasAnyCommits(),
                rootGitOps.hasWholeIndexOperationInProgress(),
            ]);
            if (!canUpdate()) return;
            this.files = files;
            this.stashes = stashes;
            this.selectedStashIndex = selectedStashIndex;
            this.stashFiles = stashFiles;
            this.shelves = shelfState.shelves;
            this.catalogGeneration = shelfState.catalogGeneration;
            this.selectedShelfId = shelfState.selectedShelfId;
            const uniquePaths = new Set<string>();
            for (const file of files) {
                if (file.status !== "!") uniquePaths.add(file.path);
            }
            const count = uniquePaths.size;
            this._onDidChangeFileCount.fire(count);
            this.lastFileCount = count;
            this.postToWebview({
                type: "update",
                repositoryRoot,
                files,
                stashes,
                stashFiles,
                selectedStashIndex,
                shelves: this.shelves,
                catalogGeneration: this.catalogGeneration,
                selectedShelfId: this.selectedShelfId,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: cpFolderIconsByName,
                iconFonts,
                currentBranchHasUpstream: currentBranchStatus.hasUpstream,
                hasRemotes: currentBranchStatus.hasRemotes,
                currentBranchAhead: currentBranchStatus.ahead,
                currentBranchBehind: currentBranchStatus.behind,
                currentBranchName: currentBranchStatus.name,
                currentBranchUpstream: currentBranchStatus.upstream,
                hasCommits,
                wholeIndexOperationInProgress,
            });
        } finally {
            if (!silent && canUpdate()) this.postToWebview({ type: "refreshing", active: false });
        }
    }
    // --- Branch sending -----------------------------------------------------
    /**
     * Sends cached branches with folder icons derived from branch path segments.
     */
    private async sendBranches(shouldContinue: () => boolean = () => true): Promise<void> {
        if (!shouldContinue()) return;
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const [folderIconsByName, currentBranchStatus] = await Promise.all([
            this.iconTheme.getFolderIconsByBranches(this.branches),
            this.currentBranchStatus(),
        ]);
        if (!shouldContinue()) return;
        this.branchFolderIconsByName = folderIconsByName;
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setBranches",
            branches: this.branches,
            worktrees: this.worktrees,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName,
            iconFonts,
            currentBranchHasUpstream: currentBranchStatus.hasUpstream,
            hasRemotes: currentBranchStatus.hasRemotes,
            currentBranchAhead: currentBranchStatus.ahead,
            currentBranchBehind: currentBranchStatus.behind,
            currentBranchName: currentBranchStatus.name,
            currentBranchUpstream: currentBranchStatus.upstream,
            commitChecksEnabled: this.commitChecksSettings?.enabled ?? true,
        });
    }

    /**
     * Resolves branch and remote state through the supplied repository facade.
     *
     * Refresh callers pass their captured facade so branch metadata cannot come from a later root.
     */
    private async currentBranchStatus(
        gitOps: Pick<GitOps, "getBranches" | "getRemotes"> = this.gitOps,
    ): Promise<{
        hasUpstream: boolean;
        hasRemotes: boolean;
        ahead: number;
        behind: number;
        name: string | null;
        upstream: string | null;
    }> {
        const [branches, remotes] = await Promise.all([gitOps.getBranches(), gitOps.getRemotes()]);
        const currentBranch = branches.find((branch) => branch.isCurrent && !branch.isRemote);
        const upstream = currentBranch?.upstream?.trim() || null;
        return {
            hasUpstream: upstream !== null,
            hasRemotes: remotes.length > 0,
            ahead: currentBranch?.ahead ?? 0,
            behind: currentBranch?.behind ?? 0,
            name: currentBranch?.name ?? null,
            upstream,
        };
    }

    // --- Commit detail ------------------------------------------------------
    /**
     * Posts cached commit detail state, or an explicit clear message when no commit is selected.
     */
    private postCommitDetailState(): void {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        if (this.selectedCommitDetail) {
            this.postToWebview({
                type: "setCommitDetail",
                detail: this.selectedCommitDetail,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.folderIconsByName,
                iconFonts,
            });
            return;
        }
        this.postToWebview(
            this.commitDetailLoading
                ? { type: "clearCommitDetail", loading: true }
                : { type: "clearCommitDetail" },
        );
    }
    /**
     * Decorates commit detail rows and stores them only if the request is still current.
     */
    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        // Decoration can become stale while awaiting; requestId is checked immediately after.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId !== this.commitDetailSeq) return;
        this.selectedCommitDetail = decorated.detail;
        this.folderIconsByName = decorated.folderIconsByName;
        this.postCommitDetailState();
    }
    // --- HTML generation ----------------------------------------------------
    /**
     * Builds the undocked shell HTML with webview-scoped script and resource URIs.
     */
    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-undocked.js",
            title: vscode.l10n.t("IntelliGit"),
            backgroundVar: "var(--vscode-editor-background)",
        });
    }
    // --- Commit draft persistence -------------------------------------------
    /**
     * Builds the repository-scoped workspace-state key for the undocked commit draft.
     */
    private getCommitDraftStorageKey(repositoryRoot = this.repoRootUri.fsPath): string {
        return `${UndockedViewProvider.COMMIT_DRAFT_KEY_PREFIX}${repositoryRoot}`;
    }
    private getStoredCommitDraft(repositoryRoot = this.repoRootUri.fsPath): string {
        return (
            this.workspaceState?.get<string>(this.getCommitDraftStorageKey(repositoryRoot)) ?? ""
        );
    }
    /**
     * Sends validated persisted column widths before the webview performs layout writes.
     */
    private sendPersistedColumnWidths(): void {
        const saved = migratePersistedColumnWidths(
            this.workspaceState?.get(UndockedViewProvider.COLUMN_WIDTHS_KEY),
        );
        if (
            saved &&
            Number.isFinite(saved.repositoryWidth) &&
            Number.isFinite(saved.branchWidth) &&
            Number.isFinite(saved.graphWidth) &&
            Number.isFinite(saved.infoWidth) &&
            Number.isFinite(saved.commitPanelWidth)
        ) {
            this.postToWebview({
                type: "columnWidths",
                repositoryWidth: saved.repositoryWidth,
                branchWidth: saved.branchWidth,
                graphWidth: saved.graphWidth,
                infoWidth: saved.infoWidth,
                commitPanelWidth: saved.commitPanelWidth,
            });
        }
    }
    /**
     * Posts layout settings that depend on IntelliGit and VS Code workbench configuration.
     */
    private sendSettings(): void {
        this.postToWebview({
            type: "settings",
            commitWindowPosition: this.resolveCommitWindowPosition(),
        });
    }
    /**
     * Resolves the commit-panel side, falling back to the VS Code sidebar location for `auto`.
     */
    private resolveCommitWindowPosition(): "left" | "right" {
        const config = vscode.workspace.getConfiguration();
        const rawPosition = config.get<string>("intelligit.commitWindowPosition") ?? "auto";
        if (rawPosition === "left" || rawPosition === "right") return rawPosition;
        return config.get<string>("workbench.sideBar.location") === "right" ? "right" : "left";
    }
    // --- Theme change listeners ---------------------------------------------
    /**
     * Refreshes theme data from listeners without leaking rejected promises into VS Code callbacks.
     */
    private refreshThemeDataWithErrorHandling(): void {
        this.refreshThemeData().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("IntelliGit error: {message}", { message }),
            );
            this.postToWebview({ type: "error", message });
        });
    }
    /**
     * Reloads icon theme metadata and re-sends branch/detail decoration to the webview.
     */
    private async refreshThemeData(): Promise<void> {
        // Theme refresh must complete before branch/detail decorations are recalculated.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        if (!this.selectedCommitDetail) {
            this.postCommitDetailState();
            return;
        }
        const requestId = ++this.commitDetailSeq;
        await this.decorateAndStoreCommitDetail(this.selectedCommitDetail, requestId);
    }
    private registerThemeChangeListeners(): void {
        this.themeChangeDisposables.push(
            ...registerThemeChangeListeners(() => this.refreshThemeDataWithErrorHandling()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration("intelligit.commitWindowPosition") ||
                    event.affectsConfiguration("workbench.sideBar.location")
                ) {
                    this.sendSettings();
                }
            }),
        );
    }
    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }
    // --- Webview helpers ----------------------------------------------------
    private postToWebview(msg: UnifiedInbound): void {
        this.panel?.webview.postMessage(msg);
    }
}
