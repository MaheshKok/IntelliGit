// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and stash management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, CommitDetail, ThemeFolderIconMap } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { abortMergeWithConfirmation } from "./mergeAbort";
import type { InboundMessage } from "../webviews/protocol/commitPanelMessages";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { CommitPanelRepositoryRuntime } from "./commitPanelRepositoryRuntime";
import { runPublishBranchFlow } from "../services/publishService";
import { showTimedWarningMessage } from "../utils/notifications";
import type {
    BranchAction,
    CommitAction,
    CommitGraphInbound,
} from "../webviews/protocol/commitGraphTypes";
import { isBranchAction, isCommitAction } from "../webviews/protocol/commitGraphTypes";
import { IconThemeService } from "./shared/IconThemeService";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import {
    assertGitHash,
    assertMessage,
    assertNullableString,
    assertNumber,
    assertRepoPathArray,
    assertString,
} from "./messageValidation";
import {
    commitAndPushFromPanel,
    commitOnlyFromPanel,
    commitSelectedFromPanel,
    rollbackFromPanel,
    runGitOperationFromPanel,
    stashMutationFromPanel,
    stashSaveFromPanel,
} from "./commitPanelActions";
import {
    deleteFileFromPanel,
    openFileFromPanel,
    publishBranchFromPanel,
    selectStashFromPanel,
    showDiffFromPanel,
    showStashDiffFromPanel,
    stageFilesFromPanel,
    trackUnversionedFilesFromPanel,
    unstageFilesFromPanel,
} from "./panelFileActions";
const MIN_VISIBLE_REFRESH_MS = 600;

/**
 * Hosts the sidebar Changes webview and its embedded commit graph protocol.
 *
 * The provider owns working-tree, stash, commit-draft, branch-filter, pagination, and commit
 * detail caches for one active repository. All webview messages pass through a validation layer
 * before reaching Git operations, VS Code commands, or path-sensitive file actions.
 */
export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";
    private static readonly COMMIT_DRAFT_KEY_PREFIX = "commitDraft:";
    private view?: vscode.WebviewView;
    private lastFileCount = 0;
    private repositories: DiscoveredRepository[] = [];
    private readonly runtimes = new Map<string, CommitPanelRepositoryRuntime>();
    private activeRepositoryRoot: string | null = null;
    private themeChangeDisposables: vscode.Disposable[] = [];
    private readonly iconTheme: IconThemeService;
    private readonly PAGE_SIZE = 500;
    private branches: Branch[] = [];
    private selectedCommitDetail: CommitDetail | null = null;
    private commitDetailLoading = false;
    private commitDetailFolderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;
    private readonly _onDidChangeFileCount = new vscode.EventEmitter<number>();
    readonly onDidChangeFileCount = this._onDidChangeFileCount.event;
    private readonly _onDidChangeWorkingTree = new vscode.EventEmitter<void>();
    readonly onDidChangeWorkingTree = this._onDidChangeWorkingTree.event;
    private readonly _onCommitSelected = new vscode.EventEmitter<string>();
    readonly onCommitSelected = this._onCommitSelected.event;
    private readonly _onBranchFilterChanged = new vscode.EventEmitter<string | null>();
    readonly onBranchFilterChanged = this._onBranchFilterChanged.event;
    private readonly _onBranchAction = new vscode.EventEmitter<{
        action: BranchAction;
        branchName: string;
    }>();
    readonly onBranchAction = this._onBranchAction.event;
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
    /**
     * Creates the Changes provider for the active repository activation path.
     *
     * `repoRootUri` scopes file actions and draft persistence when known at construction time;
     * activation may inject it later, so helpers retain a workspace-root fallback for early view
     * restoration. `secrets` is forwarded to publish flows that need secure token storage.
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private repoRootUri?: vscode.Uri,
        private readonly workspaceState?: vscode.Memento,
        private readonly secrets?: vscode.SecretStorage,
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
        if (repoRootUri) {
            this.setRepositoriesInternal(
                [this.repositoryFromUri(repoRootUri)],
                repoRootUri.fsPath,
                this.gitOps,
            );
        }
    }

    /**
     * Replaces the repository set known to the commit panel while preserving unchanged runtimes.
     *
     * Roots are matched exactly against host-discovered absolute paths. Removed runtimes are
     * invalidated so late async refreshes cannot post stale state after the repository list changes.
     */
    setRepositories(repositories: DiscoveredRepository[], activeRoot?: string): void {
        this.setRepositoriesInternal(repositories, activeRoot);
    }

    /**
     * Switches the panel to a new active repository and invalidates repository-scoped caches.
     *
     * Request sequences are bumped so pending status, graph, or decoration work from the previous
     * root cannot overwrite the new repository's state. The commit draft key is repository-specific,
     * so the webview receives a fresh draft restore message after the root changes.
     */
    setRepositoryRootUri(repoRootUri: vscode.Uri): void {
        if (this.repositories.some((repository) => repository.root === repoRootUri.fsPath)) {
            this.setRepositoriesInternal(this.repositories, repoRootUri.fsPath, undefined, {
                resetActiveState: true,
            });
            return;
        }
        for (const runtime of this.runtimes.values()) {
            this.invalidateRuntime(runtime);
        }
        this.runtimes.clear();
        this.setRepositoriesInternal(
            [this.repositoryFromUri(repoRootUri)],
            repoRootUri.fsPath,
            this.gitOps,
            { resetActiveState: true },
        );
    }

    private repositoryFromUri(repoRootUri: vscode.Uri): DiscoveredRepository {
        const root = repoRootUri.fsPath;
        const parts = root.split(/[\\/]/).filter(Boolean);
        return {
            root,
            label: parts[parts.length - 1] ?? root,
        };
    }

    private setRepositoriesInternal(
        repositories: DiscoveredRepository[],
        activeRoot?: string,
        activeGitOps?: GitOps,
        options: { resetActiveState?: boolean } = {},
    ): void {
        const previousActiveRoot = this.activeRepositoryRoot;
        const previousActiveRuntime =
            previousActiveRoot !== null ? this.runtimes.get(previousActiveRoot) : undefined;
        const nextRoots = new Set(repositories.map((repository) => repository.root));

        for (const [root, runtime] of this.runtimes) {
            if (nextRoots.has(root)) continue;
            this.invalidateRuntime(runtime);
            this.runtimes.delete(root);
        }

        for (const repository of repositories) {
            const existing = this.runtimes.get(repository.root);
            if (existing) {
                existing.repository = repository;
                continue;
            }
            const gitOps = repository.root === activeRoot ? activeGitOps : undefined;
            this.runtimes.set(
                repository.root,
                new CommitPanelRepositoryRuntime(repository, gitOps),
            );
        }

        this.repositories = repositories;
        const requestedActiveRoot =
            activeRoot !== undefined && this.runtimes.has(activeRoot) ? activeRoot : null;
        this.activeRepositoryRoot =
            requestedActiveRoot ??
            (this.activeRepositoryRoot !== null && this.runtimes.has(this.activeRepositoryRoot)
                ? this.activeRepositoryRoot
                : (repositories[0]?.root ?? null));
        const activeChanged = previousActiveRoot !== this.activeRepositoryRoot;
        if (activeChanged && previousActiveRuntime) this.invalidateRuntime(previousActiveRuntime);

        const activeRuntime = this.getActiveRuntime();
        this.repoRootUri = activeRuntime?.repoRootUri;
        if (activeChanged || options.resetActiveState) {
            this.selectedCommitDetail = null;
            this.commitDetailFolderIconsByName = {};
            this.branchFolderIconsByName = {};
            this.commitDetailSeq += 1;
            this.updateViewCount(activeRuntime ? this.countChangedFiles(activeRuntime) : 0);
            if (activeRuntime) {
                this.postToWebview({
                    type: "restoreCommitDraft",
                    repositoryRoot: activeRuntime.repository.root,
                    message: this.getStoredCommitDraft(activeRuntime),
                });
            }
        }
        this.postRepositoryListHydration();
    }

    private postRepositoryListHydration(): void {
        this.postToWebview({
            type: "setRepositories",
            repositories: this.repositories,
            activeRepositoryRoot: this.activeRepositoryRoot,
        });
    }

    private getActiveRuntime(): CommitPanelRepositoryRuntime | undefined {
        return this.activeRepositoryRoot !== null
            ? this.runtimes.get(this.activeRepositoryRoot)
            : undefined;
    }

    private requireActiveRuntime(): CommitPanelRepositoryRuntime {
        const runtime = this.getActiveRuntime();
        if (!runtime) throw new Error("No active repository selected.");
        return runtime;
    }

    private runtimeForMessage(msg: {
        [key: string]: unknown;
    }): CommitPanelRepositoryRuntime | undefined {
        if (msg.repositoryRoot !== undefined) {
            const repositoryRoot = assertString(msg.repositoryRoot, "repositoryRoot");
            const runtime = this.runtimes.get(repositoryRoot);
            if (!runtime) {
                throw new Error("Unknown repository root received from webview.");
            }
            return runtime;
        }
        return this.getActiveRuntime();
    }

    private validateKnownRepositoryRoot(msg: { [key: string]: unknown }): void {
        if (msg.repositoryRoot === undefined) return;
        const repositoryRoot = assertString(msg.repositoryRoot, "repositoryRoot");
        if (!this.runtimes.has(repositoryRoot)) {
            throw new Error("Unknown repository root received from webview.");
        }
    }

    private invalidateRuntime(runtime: CommitPanelRepositoryRuntime): void {
        runtime.requestSeq += 1;
        runtime.dataRefreshSeq += 1;
    }

    private countChangedFiles(runtime: CommitPanelRepositoryRuntime): number {
        const uniquePaths = new Set<string>();
        for (const file of runtime.files) {
            if (file.status !== "!") uniquePaths.add(file.path);
        }
        return uniquePaths.size;
    }

    private actionDepsForRuntime(runtime?: CommitPanelRepositoryRuntime) {
        return {
            gitOps: runtime?.gitOps ?? this.gitOps,
            refreshData: () => (runtime ? this.refreshData(false, runtime) : Promise.resolve()),
            refreshGraphData: () =>
                runtime && runtime === this.getActiveRuntime()
                    ? this.refreshGraphData(runtime)
                    : Promise.resolve(),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
            postCommitted: () =>
                this.postToWebview({
                    type: "committed",
                    ...(runtime ? { repositoryRoot: runtime.repository.root } : {}),
                }),
            maybeOfferPublishBranch: () =>
                runtime ? this.maybeOfferPublishBranch(runtime) : Promise.resolve(),
            publishBranch: runtime ? () => this.publishBranch(runtime) : undefined,
        };
    }

    private fileActionDepsForRuntime(runtime?: CommitPanelRepositoryRuntime) {
        return {
            gitOps: runtime?.gitOps ?? this.gitOps,
            getWorkspaceRoot: () => this.getWorkspaceRoot(runtime),
            refreshData: (silent = false) =>
                runtime ? this.refreshData(silent, runtime) : Promise.resolve(),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
        };
    }

    /** Handles repository label changes while keeping native view descriptions empty. */
    setRepositoryLabel(_label: string): void {
        this.updateViewCount(this.lastFileCount);
    }
    /**
     * Replaces the embedded graph branch cache and posts decorated branch metadata when possible.
     */
    setBranches(branches: Branch[]): void {
        this.branches = branches;
        const runtime = this.getActiveRuntime();
        if (!runtime) return;
        this.sendGraphBranches(runtime).catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Branch update error: {message}", { message }),
            );
        });
    }
    /**
     * Stores the embedded graph's selected commit detail and decorates it asynchronously.
     *
     * A request sequence prevents late folder-icon decoration from restoring an older selection
     * after another commit has been selected or the detail has been cleared.
     */
    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
        this.commitDetailLoading = false;
        this.commitDetailFolderIconsByName = {};
        this.postGraphCommitDetailState();
        this.decorateAndStoreCommitDetail(detail, requestId).catch((err) => {
            if (requestId !== this.commitDetailSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Commit detail error: {message}", { message }),
            );
        });
    }
    /**
     * Clears the embedded graph detail pane and invalidates pending decoration work.
     */
    clearCommitDetail(options?: { loading?: boolean }): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.commitDetailLoading = options?.loading ?? false;
        this.commitDetailFolderIconsByName = {};
        this.postToWebview(
            this.commitDetailLoading
                ? { type: "clearCommitDetail", loading: true }
                : { type: "clearCommitDetail" },
        );
    }
    /**
     * Resolves the Changes webview, binds message handling, and replays cached file state.
     *
     * The webview is restricted to bundled `dist` resources, theme listeners are rebound for the
     * newly attached webview, and all inbound messages are routed through {@link handleMessage} so
     * malformed payloads are rejected before command handlers receive them.
     */
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.disposeThemeChangeDisposables();
        this.iconTheme.dispose();
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);
        this.registerThemeChangeListeners();
        const thisView = webviewView;
        webviewView.onDidDispose(() => {
            if (this.view === thisView) {
                this.view = undefined;
                this.iconTheme.dispose();
                this.disposeThemeChangeDisposables();
            }
        });
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            const message: unknown = msg;
            try {
                await this.handleMessage(message);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
                this.postToWebview({ type: "error", message });
            }
        });
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) return;
            const runtime = this.requireActiveRuntime();
            this.postWorkingTreeSnapshot(runtime);
            this.refreshDataWithErrorHandling(true, runtime);
        });
        this.postRepositoryListHydration();
        this.updateViewCount(this.lastFileCount);
    }
    /**
     * Refreshes working-tree/stash data and then reloads embedded graph state.
     */
    async refresh(): Promise<void> {
        const runtime = this.requireActiveRuntime();
        await this.refreshData(false, runtime);
        await this.refreshGraphData(runtime);
    }
    /** Refreshes working-tree data without showing webview or context-key spinner state. */
    async refreshSilent(): Promise<void> {
        await this.refreshData(true, this.requireActiveRuntime());
    }
    /**
     * Runs a visible refresh for explicit user requests in the Changes view.
     *
     * The progress location is scoped to the view so refresh feedback appears where the user
     * initiated it instead of as a global notification.
     */
    private async refreshFromUserAction(runtime?: CommitPanelRepositoryRuntime): Promise<void> {
        if (!runtime) return;
        await vscode.window.withProgress(
            { location: { viewId: CommitPanelViewProvider.viewType } },
            async () => {
                await this.refreshData(false, runtime);
                if (runtime === this.getActiveRuntime()) {
                    await this.refreshGraphData(runtime);
                }
            },
        );
    }
    /**
     * Posts the cached working-tree snapshot without performing Git I/O.
     *
     * This is used when a newly-ready webview reconnects so it can render the most recent file list
     * immediately, before the follow-up silent refresh reconciles any changes that happened while
     * the webview was hidden or loading.
     */
    private postWorkingTreeSnapshot(runtime: CommitPanelRepositoryRuntime): void {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "update",
            repositoryRoot: runtime.repository.root,
            files: runtime.files,
            stashes: runtime.stashes,
            selectedStashIndex: runtime.selectedStashIndex,
            stashFiles: runtime.stashFiles,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: runtime.folderIconsByName,
            iconFonts,
            currentBranchHasUpstream: runtime.currentBranchHasUpstreamCache,
            hasRemotes: runtime.hasRemotesCache,
            currentBranchAhead: runtime.currentBranchAheadCache,
            currentBranchBehind: runtime.currentBranchBehindCache,
            currentBranchName: runtime.currentBranchNameCache,
            currentBranchUpstream: runtime.currentBranchUpstreamCache,
        });
    }

    /**
     * Reloads working-tree files, stashes, selected stash contents, and upstream state.
     *
     * Non-silent refreshes set both a webview `refreshing` message and a VS Code context key, then
     * keep the spinner visible for a short minimum duration to avoid flicker. The selected stash is
     * preserved when it still exists, otherwise the first available stash becomes selected.
     */
    private async refreshData(
        silent = false,
        runtime: CommitPanelRepositoryRuntime = this.requireActiveRuntime(),
    ): Promise<void> {
        const refreshStartedAt = Date.now();
        const refreshRequestId = ++runtime.dataRefreshSeq;
        if (!silent) {
            this.postToWebview({
                type: "refreshing",
                repositoryRoot: runtime.repository.root,
                active: true,
            });
        }
        if (!silent) {
            void Promise.resolve(
                vscode.commands.executeCommand(
                    "setContext",
                    "intelligit.commitPanel.refreshing",
                    true,
                ),
            ).catch(() => {});
        }
        try {
            const status = await runtime.gitOps.getStatus({
                includeIgnored: runtime.showIgnoredFiles,
            });
            await this.iconTheme.initIconThemeData().catch(() => {});
            const [stashes, currentBranchStatus] = await Promise.all([
                runtime.gitOps.listStashes().catch(() => runtime.stashes),
                this.currentBranchStatus(runtime).catch(() => ({
                    hasUpstream: runtime.currentBranchHasUpstreamCache,
                    hasRemotes: runtime.hasRemotesCache,
                    ahead: runtime.currentBranchAheadCache,
                    behind: runtime.currentBranchBehindCache,
                    name: runtime.currentBranchNameCache,
                    upstream: runtime.currentBranchUpstreamCache,
                })),
            ]);
            const files = await this.iconTheme.decorateWorkingFiles(status).catch(() => status);
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            const hasSelected =
                runtime.selectedStashIndex !== null &&
                stashes.some((entry) => entry.index === runtime.selectedStashIndex);
            let selectedStashIndex: number | null;
            if (hasSelected) {
                selectedStashIndex = runtime.selectedStashIndex;
            } else {
                selectedStashIndex = stashes.length > 0 ? stashes[0].index : null;
            }
            const selectedStashIndexUnchanged = selectedStashIndex === runtime.selectedStashIndex;
            const stashFiles =
                selectedStashIndex !== null
                    ? await runtime.gitOps
                          .getStashFiles(selectedStashIndex)
                          .then((files) => this.iconTheme.decorateWorkingFiles(files))
                          .catch(() => (selectedStashIndexUnchanged ? runtime.stashFiles : []))
                    : [];
            const folderIconsByName = await this.iconTheme
                .getFolderIconsByWorkingFiles([...files, ...stashFiles])
                .catch(() => runtime.folderIconsByName);
            if (refreshRequestId === runtime.dataRefreshSeq) {
                runtime.folderIconsByName = folderIconsByName;
                runtime.files = files;
                runtime.stashes = stashes;
                runtime.selectedStashIndex = selectedStashIndex;
                runtime.stashFiles = stashFiles;
                runtime.currentBranchHasUpstreamCache = currentBranchStatus.hasUpstream;
                runtime.hasRemotesCache = currentBranchStatus.hasRemotes;
                runtime.currentBranchAheadCache = currentBranchStatus.ahead;
                runtime.currentBranchBehindCache = currentBranchStatus.behind;
                runtime.currentBranchNameCache = currentBranchStatus.name;
                runtime.currentBranchUpstreamCache = currentBranchStatus.upstream;
                const count = this.countChangedFiles(runtime);
                if (runtime === this.getActiveRuntime()) {
                    this._onDidChangeFileCount.fire(count);
                    this.updateViewCount(count);
                }
                this.postToWebview({
                    type: "update",
                    repositoryRoot: runtime.repository.root,
                    files,
                    stashes,
                    stashFiles,
                    selectedStashIndex,
                    folderIcon: folderIcons.folderIcon,
                    folderExpandedIcon: folderIcons.folderExpandedIcon,
                    folderIconsByName: runtime.folderIconsByName,
                    iconFonts,
                    currentBranchHasUpstream: currentBranchStatus.hasUpstream,
                    hasRemotes: currentBranchStatus.hasRemotes,
                    currentBranchAhead: currentBranchStatus.ahead,
                    currentBranchBehind: currentBranchStatus.behind,
                    currentBranchName: currentBranchStatus.name,
                    currentBranchUpstream: currentBranchStatus.upstream,
                });
            }
        } finally {
            if (!silent) {
                const remainingMs = MIN_VISIBLE_REFRESH_MS - (Date.now() - refreshStartedAt);
                if (remainingMs > 0) {
                    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
                }
                this.postToWebview({
                    type: "refreshing",
                    repositoryRoot: runtime.repository.root,
                    active: false,
                });
                void Promise.resolve(
                    vscode.commands.executeCommand(
                        "setContext",
                        "intelligit.commitPanel.refreshing",
                        false,
                    ),
                ).catch(() => {});
            }
        }
    }
    /**
     * Refreshes embedded graph theme data, branch metadata, first-page commits, and detail state.
     */
    private async refreshGraphData(
        runtime: CommitPanelRepositoryRuntime = this.requireActiveRuntime(),
    ): Promise<void> {
        // Embedded graph refresh relies on current theme data before branch/log decoration.
        // react-doctor-disable-next-line react-doctor/async-parallel
        await this.iconTheme.initIconThemeData();
        await this.sendGraphBranches(runtime);
        await this.loadInitialGraphCommits(runtime);
        this.postGraphCommitDetailState();
    }
    /**
     * Sends embedded graph branch data with folder icons derived from branch path segments.
     */
    private async sendGraphBranches(runtime: CommitPanelRepositoryRuntime): Promise<void> {
        this.branchFolderIconsByName = await this.iconTheme.getFolderIconsByBranches(this.branches);
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setBranches",
            branches: this.branches,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.branchFolderIconsByName,
            iconFonts,
            currentBranchHasUpstream: runtime.currentBranchHasUpstreamCache,
            hasRemotes: runtime.hasRemotesCache,
            currentBranchAhead: runtime.currentBranchAheadCache,
            currentBranchBehind: runtime.currentBranchBehindCache,
            currentBranchName: runtime.currentBranchNameCache,
            currentBranchUpstream: runtime.currentBranchUpstreamCache,
        });
    }
    /**
     * Loads the first embedded graph page and drops responses superseded by newer requests.
     *
     * If the active branch filter disappears from the cached branch list, the selection is cleared
     * before loading so the webview and Git query stay in sync.
     */
    private async loadInitialGraphCommits(runtime: CommitPanelRepositoryRuntime): Promise<void> {
        const requestId = ++runtime.requestSeq;
        runtime.offset = 0;
        runtime.loadingMore = false;
        if (runtime.currentBranch && !this.branches.some((b) => b.name === runtime.currentBranch)) {
            runtime.currentBranch = null;
            this.postToWebview({ type: "setSelectedBranch", branch: null });
        }
        try {
            const [commits, unpushedHashes] = await Promise.all([
                runtime.gitOps.getLog(
                    this.PAGE_SIZE,
                    runtime.currentBranch ?? undefined,
                    runtime.filterText || undefined,
                    0,
                ),
                runtime.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId === runtime.requestSeq) {
                runtime.offset = commits.length;
                this.postToWebview({
                    type: "loadCommits",
                    commits,
                    hasMore: commits.length >= this.PAGE_SIZE,
                    append: false,
                    unpushedHashes,
                });
            }
        } catch (err) {
            if (requestId === runtime.requestSeq) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Git log error: {message}", { message }),
                );
                this.postToWebview({ type: "loadError", message });
            }
        }
    }
    /**
     * Appends embedded graph commits while coalescing duplicate pagination requests.
     */
    private async loadMoreGraphCommits(runtime: CommitPanelRepositoryRuntime): Promise<void> {
        if (runtime.loadingMore) return;
        runtime.loadingMore = true;
        const requestId = ++runtime.requestSeq;
        try {
            const [commits, unpushedHashes] = await Promise.all([
                runtime.gitOps.getLog(
                    this.PAGE_SIZE,
                    runtime.currentBranch ?? undefined,
                    runtime.filterText || undefined,
                    runtime.offset,
                ),
                runtime.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId === runtime.requestSeq) {
                runtime.offset += commits.length;
                this.postToWebview({
                    type: "loadCommits",
                    commits,
                    hasMore: commits.length >= this.PAGE_SIZE,
                    append: true,
                    unpushedHashes,
                });
            }
        } catch (err) {
            if (requestId === runtime.requestSeq) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Git log error: {message}", { message }),
                );
                this.postToWebview({ type: "loadError", message });
            }
        } finally {
            if (requestId === runtime.requestSeq) {
                runtime.loadingMore = false;
            }
        }
    }
    private async filterGraphByText(
        runtime: CommitPanelRepositoryRuntime,
        text: string,
    ): Promise<void> {
        runtime.filterText = text;
        await this.loadInitialGraphCommits(runtime);
    }
    /**
     * Validates and dispatches every message accepted by the Changes webview.
     *
     * Accepted messages cover graph readiness/pagination/filtering, branch and commit actions,
     * commit-file diffs, draft persistence, staging, committing, rollback, stash mutations, and
     * file actions. Paths and commit hashes are validated before Git or VS Code APIs are called;
     * unrecognized message types are ignored by the switch exhaustively falling through.
     */
    private async handleMessage(raw: unknown): Promise<void> {
        const msg = assertMessage(raw);
        this.validateKnownRepositoryRoot(msg);
        const activeRuntime = () => this.requireActiveRuntime();
        const scopedRuntime = () => this.runtimeForMessage(msg);
        switch (msg.type) {
            case "ready": {
                const runtime = this.getActiveRuntime();
                this.postRepositoryListHydration();
                if (runtime) {
                    this.postWorkingTreeSnapshot(runtime);
                    await this.refreshData(true, runtime);
                    await this.refreshGraphData(runtime);
                }
                this.postToWebview({
                    type: "restoreCommitDraft",
                    ...(runtime ? { repositoryRoot: runtime.repository.root } : {}),
                    message: this.getStoredCommitDraft(runtime),
                });
                break;
            }
            case "refresh":
                await this.refreshFromUserAction(scopedRuntime());
                break;
            case "abortMerge":
                await this.abortMerge(scopedRuntime());
                break;
            case "setShowIgnoredFiles": {
                const runtime = scopedRuntime();
                if (runtime) {
                    runtime.showIgnoredFiles = msg.showIgnoredFiles === true;
                    await this.refreshData(true, runtime);
                }
                break;
            }
            case "fetch":
                await runGitOperationFromPanel(this.actionDepsForRuntime(scopedRuntime()), "fetch");
                break;
            case "pull":
                await runGitOperationFromPanel(this.actionDepsForRuntime(scopedRuntime()), "pull");
                break;
            case "push":
                await runGitOperationFromPanel(this.actionDepsForRuntime(scopedRuntime()), "push");
                break;
            case "sync":
                await runGitOperationFromPanel(this.actionDepsForRuntime(scopedRuntime()), "sync");
                break;
            case "selectCommit":
                this._onCommitSelected.fire(assertGitHash(msg.hash, "hash"));
                break;
            case "loadMore":
                await this.loadMoreGraphCommits(activeRuntime());
                break;
            case "filterText":
                await this.filterGraphByText(activeRuntime(), assertString(msg.text, "text"));
                break;
            case "filterBranch": {
                const runtime = activeRuntime();
                runtime.currentBranch = assertNullableString(msg.branch, "branch");
                runtime.filterText = "";
                this._onBranchFilterChanged.fire(runtime.currentBranch);
                this.postToWebview({
                    type: "setSelectedBranch",
                    branch: runtime.currentBranch,
                });
                await this.loadInitialGraphCommits(runtime);
                break;
            }
            case "branchAction": {
                const branchAction = assertString(msg.action, "action");
                if (!isBranchAction(branchAction)) {
                    throw new Error("Invalid branch action received from webview.");
                }
                this._onBranchAction.fire({
                    action: branchAction,
                    branchName: assertString(msg.branchName, "branchName"),
                });
                break;
            }
            case "commitAction": {
                const commitAction = assertString(msg.action, "action");
                if (!isCommitAction(commitAction)) {
                    throw new Error("Invalid commit action received from webview.");
                }
                this._onCommitAction.fire({
                    action: commitAction,
                    hash: assertGitHash(msg.hash, "hash"),
                });
                break;
            }
            case "openCommitFileDiff":
                this._onOpenCommitFileDiff.fire({
                    commitHash: assertGitHash(msg.commitHash, "commitHash"),
                    filePath: assertRepoRelativePath(assertString(msg.filePath, "filePath")),
                });
                break;
            case "saveCommitDraft": {
                const runtime = scopedRuntime();
                const message = assertString(msg.message, "message");
                await this.workspaceState?.update(
                    this.getCommitDraftStorageKey(runtime),
                    message || undefined,
                );
                break;
            }
            case "stageFiles":
                await stageFilesFromPanel(
                    this.fileActionDepsForRuntime(scopedRuntime()),
                    msg.paths,
                );
                break;
            case "unstageFiles":
                await unstageFilesFromPanel(
                    this.fileActionDepsForRuntime(scopedRuntime()),
                    msg.paths,
                );
                break;
            case "trackUnversionedFiles":
                await trackUnversionedFilesFromPanel(
                    this.fileActionDepsForRuntime(scopedRuntime()),
                    msg.paths,
                );
                break;
            case "commitSelected": {
                const actionDeps = this.actionDepsForRuntime(scopedRuntime());
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                await commitSelectedFromPanel(actionDeps, {
                    message,
                    amend: msg.amend === true,
                    push: msg.push === true,
                    paths: assertRepoPathArray(msg.paths, "paths"),
                });
                break;
            }
            case "commit": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                await commitOnlyFromPanel(
                    this.actionDepsForRuntime(scopedRuntime()),
                    message,
                    msg.amend === true,
                );
                break;
            }
            case "commitAndPush": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                await commitAndPushFromPanel(
                    this.actionDepsForRuntime(scopedRuntime()),
                    message,
                    msg.amend === true,
                );
                break;
            }
            case "getLastCommitMessage": {
                const runtime = scopedRuntime();
                const lastMsg = await (runtime?.gitOps ?? this.gitOps).getLastCommitMessage();
                this.postToWebview({
                    type: "lastCommitMessage",
                    ...(runtime ? { repositoryRoot: runtime.repository.root } : {}),
                    message: lastMsg,
                });
                break;
            }
            case "getAmendBranchCommits": {
                const runtime = scopedRuntime();
                const commits = await (runtime?.gitOps ?? this.gitOps).getAmendBranchCommits();
                this.postToWebview({
                    type: "amendBranchCommits",
                    ...(runtime ? { repositoryRoot: runtime.repository.root } : {}),
                    commits,
                });
                break;
            }
            case "rollback": {
                await rollbackFromPanel(
                    this.actionDepsForRuntime(scopedRuntime()),
                    assertRepoPathArray(msg.paths, "paths"),
                );
                break;
            }
            case "showDiff":
                await showDiffFromPanel(this.fileActionDepsForRuntime(scopedRuntime()), msg.path);
                break;
            case "stashSave": {
                await stashSaveFromPanel(this.actionDepsForRuntime(scopedRuntime()), {
                    name: typeof msg.name === "string" ? msg.name : "Stashed changes",
                    paths:
                        msg.paths !== undefined
                            ? assertRepoPathArray(msg.paths, "paths")
                            : undefined,
                });
                break;
            }
            case "stashPop":
                await stashMutationFromPanel(
                    this.actionDepsForRuntime(scopedRuntime()),
                    "pop",
                    assertNumber(msg.index, "index"),
                );
                break;
            case "stashApply":
                await stashMutationFromPanel(
                    this.actionDepsForRuntime(scopedRuntime()),
                    "apply",
                    assertNumber(msg.index, "index"),
                );
                break;
            case "stashDelete":
                await stashMutationFromPanel(
                    this.actionDepsForRuntime(scopedRuntime()),
                    "delete",
                    assertNumber(msg.index, "index"),
                );
                break;
            case "stashSelect": {
                const runtime = scopedRuntime();
                if (!runtime) throw new Error("No active repository selected.");
                await selectStashFromPanel(
                    {
                        ...this.fileActionDepsForRuntime(runtime),
                        iconTheme: this.iconTheme,
                        getFiles: () => runtime.files,
                        getStashes: () => runtime.stashes,
                        currentBranchHasUpstream: async () =>
                            (await this.currentBranchStatus(runtime)).hasUpstream,
                        setStashState: (state) => {
                            runtime.selectedStashIndex = state.selectedStashIndex;
                            runtime.stashFiles = state.stashFiles;
                            runtime.folderIconsByName = state.folderIconsByName;
                        },
                        postUpdate: (message) =>
                            this.postToWebview({
                                ...message,
                                repositoryRoot: runtime.repository.root,
                            }),
                    },
                    msg.index,
                );
                break;
            }
            case "publishBranch":
                {
                    const runtime = scopedRuntime();
                    if (runtime) {
                        await this.publishBranch(runtime);
                    } else {
                        await publishBranchFromPanel(this.fileActionDepsForRuntime());
                    }
                }
                break;
            case "showStashDiff":
                await showStashDiffFromPanel(
                    this.fileActionDepsForRuntime(scopedRuntime()),
                    msg.index,
                    msg.path,
                );
                break;
            case "openFile":
                await openFileFromPanel(this.fileActionDepsForRuntime(scopedRuntime()), msg.path);
                break;
            case "deleteFile":
                await deleteFileFromPanel(this.fileActionDepsForRuntime(scopedRuntime()), msg.path);
                break;
        }
    }

    /** Confirms and aborts an active merge, then refreshes all conflict and working-tree surfaces. */
    private async abortMerge(runtime?: CommitPanelRepositoryRuntime): Promise<void> {
        await abortMergeWithConfirmation({
            gitOps: runtime?.gitOps ?? this.gitOps,
            onConflictStateChanged: async () => {
                if (runtime) {
                    await this.refreshData(false, runtime);
                    await this.refreshGraphData(runtime);
                }
                this._onDidChangeWorkingTree.fire();
                await vscode.commands.executeCommand("intelligit.mergeConflictsRefresh");
            },
        });
    }

    /** Updates cached file count while branch info remains owned by the webview header. */
    private updateViewCount(count: number): void {
        this.lastFileCount = count;
        if (!this.view) return;
        this.view.description = "";
        this.view.badge = undefined;
    }
    /**
     * Posts the embedded graph detail cache, or an explicit clear message when no detail exists.
     */
    private postGraphCommitDetailState(): void {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        if (this.selectedCommitDetail) {
            this.postToWebview({
                type: "setCommitDetail",
                detail: this.selectedCommitDetail,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.commitDetailFolderIconsByName,
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
     * Decorates commit detail file rows and stores them only if the request is still current.
     */
    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        if (requestId !== this.commitDetailSeq) return;
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId === this.commitDetailSeq) {
            this.selectedCommitDetail = decorated.detail;
            this.commitDetailFolderIconsByName = decorated.folderIconsByName;
            this.postGraphCommitDetailState();
        }
    }
    private postToWebview(msg: InboundMessage | CommitGraphInbound): void {
        this.view?.webview.postMessage(msg);
    }
    /**
     * Resolves the repository root used by file actions in the active panel.
     *
     * Prefer the explicit active repository URI. The workspace-folder fallback is retained for
     * activation paths that construct the provider before a repository root has been injected.
     *
     * @throws When no active repository or workspace folder can back a file action.
     */
    private getWorkspaceRoot(runtime?: CommitPanelRepositoryRuntime): vscode.Uri {
        if (runtime) return runtime.repoRootUri;
        if (this.repoRootUri) return this.repoRootUri;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
            throw new Error("No workspace folder is open.");
        }
        return workspaceRoot;
    }
    /**
     * Builds the Changes shell HTML with CSP/resource URI handling delegated to the shared helper.
     */
    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-commitpanel.js",
            title: vscode.l10n.t("Changes"),
            backgroundVar: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
        });
    }
    /**
     * Builds the repository-scoped workspace-state key for the commit message draft.
     *
     * @throws When no repository or workspace folder is available to scope the persisted draft.
     */
    private getCommitDraftStorageKey(runtime?: CommitPanelRepositoryRuntime): string {
        const storageRoot =
            runtime?.repository.root ??
            this.repoRootUri?.fsPath ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!storageRoot) {
            throw new Error("No workspace folder is open.");
        }
        return `${CommitPanelViewProvider.COMMIT_DRAFT_KEY_PREFIX}${storageRoot}`;
    }
    /**
     * Reads the persisted commit draft for the active repository, defaulting to an empty input.
     */
    private getStoredCommitDraft(runtime?: CommitPanelRepositoryRuntime): string {
        return this.workspaceState?.get<string>(this.getCommitDraftStorageKey(runtime)) ?? "";
    }
    /**
     * Releases theme listeners, icon resources, and event emitters owned by the Changes provider.
     */
    dispose(): void {
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onDidChangeFileCount.dispose();
        this._onDidChangeWorkingTree.dispose();
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
        this._onCommitAction.dispose();
        this._onOpenCommitFileDiff.dispose();
    }
    /**
     * Offers to publish the current branch after a successful local-only commit.
     *
     * The prompt is best-effort and intentionally swallowed on failure so commit completion is not
     * blocked by optional upstream detection or command-palette wiring.
     */
    private async maybeOfferPublishBranch(runtime: CommitPanelRepositoryRuntime): Promise<void> {
        try {
            const hasCommits = await runtime.gitOps.hasAnyCommits();
            if (!hasCommits) return;
            const branches = await runtime.gitOps.getBranches();
            const currentBranch = branches.find((b) => b.isCurrent);
            if (!currentBranch) return;
            // Already published — nothing to do
            if (currentBranch.upstream) return;
            const publishBranchAction = vscode.l10n.t("Publish Branch...");
            const publish = await vscode.window.showInformationMessage(
                vscode.l10n.t('Branch "{branch}" has not been published.', {
                    branch: currentBranch.name,
                }),
                publishBranchAction,
            );
            if (publish === publishBranchAction) {
                await this.publishBranch(runtime);
            }
        } catch {
            // Silently ignore — publish is optional, don't block the user
        }
    }

    private async publishBranch(runtime: CommitPanelRepositoryRuntime): Promise<void> {
        const hasCommits = await runtime.gitOps.hasAnyCommits();
        if (!hasCommits) {
            showTimedWarningMessage(
                vscode.l10n.t("Create a commit before publishing this branch."),
            );
            return;
        }
        const branches = await runtime.gitOps.getBranches();
        const currentBranch = branches.find((branch) => branch.isCurrent && !branch.isRemote);
        if (!currentBranch) {
            vscode.window.showErrorMessage(vscode.l10n.t("No current branch found."));
            return;
        }
        await runPublishBranchFlow(
            runtime.gitOps,
            currentBranch.name,
            runtime.repository.root,
            this.secrets,
        );
    }
    /**
     * Reads current-branch upstream, ahead/behind, and remote availability for toolbar state.
     */
    private async currentBranchStatus(runtime: CommitPanelRepositoryRuntime): Promise<{
        hasUpstream: boolean;
        hasRemotes: boolean;
        ahead: number;
        behind: number;
        name: string | null;
        upstream: string | null;
    }> {
        const [branches, remotes] = await Promise.all([
            runtime.gitOps.getBranches(),
            runtime.gitOps.getRemotes(),
        ]);
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
    /**
     * Runs a panel data refresh from listeners without leaking rejected promises into VS Code.
     */
    private refreshDataWithErrorHandling(
        silent = false,
        runtime: CommitPanelRepositoryRuntime | undefined = this.getActiveRuntime(),
    ): void {
        if (!runtime) return;
        this.refreshData(silent, runtime).catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(message);
            this.postToWebview({ type: "error", message });
        });
    }
    private registerThemeChangeListeners(): void {
        this.themeChangeDisposables.push(
            ...registerThemeChangeListeners(() =>
                this.refreshDataWithErrorHandling(false, this.getActiveRuntime()),
            ),
        );
    }
    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }
}
