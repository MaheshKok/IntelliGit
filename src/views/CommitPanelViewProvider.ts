// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and stash management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.
import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, CommitDetail, ThemeFolderIconMap } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { mapWithConcurrency } from "../utils/concurrency";
import { assertRepoRelativePath } from "../utils/fileOps";
import { abortMergeWithConfirmation } from "./mergeAbort";
import type {
    CommitPanelRepositorySnapshot,
    InboundMessage,
} from "../webviews/protocol/commitPanelMessages";
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

// Bound on concurrent collapsed-row count scans at activation. Each scan spawns one
// `git status`; with many repositories, firing them all at once starved the active
// repository's first render. ponytail: fixed cap, revisit only if a profiler asks.
const COLLAPSED_COUNT_SCAN_CONCURRENCY = 6;

interface StoredChangedFileCount {
    root: string;
    includeIgnored: boolean;
    count: number;
    updatedAt: number;
}

interface StoredChangedFileCountsPayload {
    schemaVersion: number;
    entries: StoredChangedFileCount[];
}

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
    private static readonly CHANGED_FILE_COUNTS_KEY = "intelligit.changedFileCounts.v1";
    private static readonly CHANGED_FILE_COUNTS_SCHEMA_VERSION = 1;
    private static readonly MAX_STORED_CHANGED_FILE_COUNTS = 100;
    private static readonly MAX_STORED_CHANGED_FILE_COUNT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
    private static readonly ignoredWatcherDirs = new Set([".git", "dist", "build", "out"]);
    private view?: vscode.WebviewView;
    private lastFileCount = 0;
    private repositories: DiscoveredRepository[] = [];
    private readonly runtimes = new Map<string, CommitPanelRepositoryRuntime>();
    private readonly expandedRepositoryRoots = new Set<string>();
    private readonly runtimeWatchers = new Map<string, vscode.Disposable>();
    private readonly storedChangedFileCounts = new Map<string, StoredChangedFileCount>();
    private changedFileCountsWrite = Promise.resolve();
    private activeRepositoryRoot: string | null = null;
    private visibleRefreshCount = 0;
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
        this.loadStoredChangedFileCounts();
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
        this.disposeAllRuntimeWatchers();
        this.expandedRepositoryRoots.clear();
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
            this.expandedRepositoryRoots.delete(root);
            this.disposeRuntimeWatcher(root);
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
            const runtime = new CommitPanelRepositoryRuntime(repository, gitOps);
            runtime.lastKnownChangedFileCount = this.getStoredChangedFileCount(runtime);
            this.runtimes.set(repository.root, runtime);
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

        this.updateAggregateChangedFileCount();

        const activeRuntime = this.getActiveRuntime();
        this.repoRootUri = activeRuntime?.repoRootUri;
        if (activeChanged || options.resetActiveState) {
            this.selectedCommitDetail = null;
            this.commitDetailFolderIconsByName = {};
            this.branchFolderIconsByName = {};
            this.commitDetailSeq += 1;
            if (activeRuntime) {
                this.postToWebview({
                    type: "restoreCommitDraft",
                    repositoryRoot: activeRuntime.repository.root,
                    message: this.getStoredCommitDraft(activeRuntime),
                });
            }
        }
        this.postRepositoryListHydration();
        this.syncRuntimeWatchers();
        this.scanInitialCollapsedCounts();
        if (activeChanged && previousActiveRoot !== null && activeRuntime) {
            void this.scanRepositoryFileCount(activeRuntime);
        }
    }

    private postRepositoryListHydration(): void {
        this.postToWebview({
            type: "setRepositories",
            repositories: this.repositories.map((repository) => ({
                ...repository,
                changedFileCount: this.countChangedFiles(this.runtimes.get(repository.root)),
            })),
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
        runtime.countRefreshSeq += 1;
    }

    private countChangedFiles(runtime: CommitPanelRepositoryRuntime | undefined): number {
        if (!runtime) return 0;
        if (!runtime.hasScannedFileCount && runtime.lastKnownChangedFileCount !== null) {
            return runtime.lastKnownChangedFileCount;
        }
        const uniquePaths = new Set<string>();
        for (const file of runtime.files) {
            if (file.status !== "!") uniquePaths.add(file.path);
        }
        return uniquePaths.size;
    }

    /** Loads validated workspace-state counts once so startup rendering does not await Git. */
    private loadStoredChangedFileCounts(): void {
        const payload = this.workspaceState?.get<unknown>(
            CommitPanelViewProvider.CHANGED_FILE_COUNTS_KEY,
        );
        if (!this.isStoredChangedFileCountsPayload(payload)) return;
        for (const entry of payload.entries) {
            if (!this.isStoredChangedFileCount(entry)) continue;
            if (this.isStoredChangedFileCountStale(entry)) continue;
            this.storedChangedFileCounts.set(this.storedChangedFileCountKey(entry), entry);
        }
        this.pruneStoredChangedFileCounts();
    }

    /** Returns the persisted count for this runtime's root and ignored-files mode. */
    private getStoredChangedFileCount(runtime: CommitPanelRepositoryRuntime): number | null {
        return (
            this.storedChangedFileCounts.get(
                this.storedChangedFileCountKey({
                    root: runtime.repository.root,
                    includeIgnored: runtime.showIgnoredFiles,
                }),
            )?.count ?? null
        );
    }

    /** Updates the in-memory cache immediately, then serializes its workspace-state write. */
    private storeChangedFileCount(runtime: CommitPanelRepositoryRuntime): void {
        const entry: StoredChangedFileCount = {
            root: runtime.repository.root,
            includeIgnored: runtime.showIgnoredFiles,
            count: this.countChangedFiles(runtime),
            updatedAt: Date.now(),
        };
        const key = this.storedChangedFileCountKey(entry);
        const existing = this.storedChangedFileCounts.get(key);
        if (existing?.count === entry.count) {
            this.storedChangedFileCounts.set(key, entry);
            this.pruneStoredChangedFileCounts();
            return;
        }
        this.storedChangedFileCounts.set(key, entry);
        this.pruneStoredChangedFileCounts();
        const payload: StoredChangedFileCountsPayload = {
            schemaVersion: CommitPanelViewProvider.CHANGED_FILE_COUNTS_SCHEMA_VERSION,
            entries: Array.from(this.storedChangedFileCounts.values()),
        };
        this.changedFileCountsWrite = this.changedFileCountsWrite
            .catch(() => undefined)
            .then(() =>
                this.workspaceState?.update(
                    CommitPanelViewProvider.CHANGED_FILE_COUNTS_KEY,
                    payload,
                ),
            )
            .catch(() => undefined);
    }

    /** Drops expired entries and retains the newest bounded set before serialization. */
    private pruneStoredChangedFileCounts(): void {
        const entries = Array.from(this.storedChangedFileCounts.values())
            .filter((entry) => !this.isStoredChangedFileCountStale(entry))
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, CommitPanelViewProvider.MAX_STORED_CHANGED_FILE_COUNTS);
        this.storedChangedFileCounts.clear();
        for (const entry of entries) {
            this.storedChangedFileCounts.set(this.storedChangedFileCountKey(entry), entry);
        }
    }

    /** Validates the outer workspace-state envelope before accepting individual entries. */
    private isStoredChangedFileCountsPayload(
        value: unknown,
    ): value is StoredChangedFileCountsPayload {
        if (!value || typeof value !== "object") return false;
        const payload = value as { schemaVersion?: unknown; entries?: unknown };
        return (
            payload.schemaVersion === CommitPanelViewProvider.CHANGED_FILE_COUNTS_SCHEMA_VERSION &&
            Array.isArray(payload.entries)
        );
    }

    /** Validates one untrusted persisted entry without accepting path or count coercions. */
    private isStoredChangedFileCount(value: unknown): value is StoredChangedFileCount {
        if (!value || typeof value !== "object") return false;
        const entry = value as Partial<StoredChangedFileCount>;
        return (
            typeof entry.root === "string" &&
            entry.root.length > 0 &&
            typeof entry.includeIgnored === "boolean" &&
            typeof entry.count === "number" &&
            Number.isFinite(entry.count) &&
            Number.isInteger(entry.count) &&
            entry.count >= 0 &&
            typeof entry.updatedAt === "number" &&
            Number.isFinite(entry.updatedAt)
        );
    }

    /** Limits accepted cache entries to the current 30-day lifetime and rejects future clocks. */
    private isStoredChangedFileCountStale(entry: StoredChangedFileCount): boolean {
        const now = Date.now();
        return (
            entry.updatedAt > now ||
            now - entry.updatedAt > CommitPanelViewProvider.MAX_STORED_CHANGED_FILE_COUNT_AGE_MS
        );
    }

    /** Keeps ignored and tracked counts distinct for a repository root. */
    private storedChangedFileCountKey(
        entry: Pick<StoredChangedFileCount, "root" | "includeIgnored">,
    ): string {
        return `${entry.root}\u0000${entry.includeIgnored ? "ignored" : "tracked"}`;
    }

    /** Returns current workspace aggregate without waiting for a Git refresh. */
    getLastKnownFileCount(): number {
        return this.aggregateChangedFileCount();
    }

    /** Sums non-ignored unique changed paths per repository from cached runtime snapshots. */
    private aggregateChangedFileCount(): number {
        let count = 0;
        for (const runtime of this.runtimes.values()) {
            count += this.countChangedFiles(runtime);
        }
        return count;
    }

    /** Emits the native badge count using every repository runtime's last-known file snapshot. */
    private updateAggregateChangedFileCount(): void {
        const count = this.aggregateChangedFileCount();
        this._onDidChangeFileCount.fire(count);
        this.updateViewCount(count);
    }

    /**
     * Builds the host-owned snapshot for one repository runtime.
     *
     * The active single-repository UI still consumes this as an `update` message; Task 4 can reuse
     * the same payload for per-row accordion state without re-querying Git.
     */
    private snapshotForRuntime(
        runtime: CommitPanelRepositoryRuntime,
    ): CommitPanelRepositorySnapshot {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        return {
            repositoryRoot: runtime.repository.root,
            repositoryLabel: runtime.repository.label,
            changedFileCount: this.countChangedFiles(runtime),
            files: runtime.files,
            stashes: runtime.stashes,
            stashFiles: runtime.stashFiles,
            selectedStashIndex: runtime.selectedStashIndex,
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
            refreshing: false,
            error: null,
        };
    }

    /**
     * Applies webview-expanded repository roots after validating them against host runtimes.
     *
     * Newly expanded rows become watched immediately and receive a full runtime refresh; collapsed
     * rows retain their last scanned count until they are active or expanded again.
     */
    private async setExpandedRepositories(value: unknown): Promise<void> {
        if (!Array.isArray(value)) {
            throw new Error(`Expected string[] for 'repositoryRoots', got ${typeof value}`);
        }
        const nextRoots = new Set<string>();
        for (const item of value) {
            const root = assertString(item, "repositoryRoots");
            if (!this.runtimes.has(root)) {
                throw new Error("Unknown repository root received from webview.");
            }
            nextRoots.add(root);
        }

        const newlyExpanded = Array.from(nextRoots).filter(
            (root) => !this.expandedRepositoryRoots.has(root),
        );
        this.expandedRepositoryRoots.clear();
        for (const root of nextRoots) this.expandedRepositoryRoots.add(root);
        this.syncRuntimeWatchers();
        await Promise.all(
            newlyExpanded
                .map((root) => this.runtimes.get(root))
                .filter((runtime): runtime is CommitPanelRepositoryRuntime => runtime !== undefined)
                .map((runtime) => this.refreshRepositoryData(runtime, true)),
        );
        this.postRepositoryListHydration();
    }

    /** Starts one-time status scans for collapsed rows whose count has not been hydrated yet. */
    private scanInitialCollapsedCounts(): void {
        const pending: CommitPanelRepositoryRuntime[] = [];
        for (const runtime of this.runtimes.values()) {
            if (runtime.hasScannedFileCount) continue;
            if (runtime.repository.root === this.activeRepositoryRoot) continue;
            if (this.expandedRepositoryRoots.has(runtime.repository.root)) continue;
            pending.push(runtime);
        }
        // Bounded so opening a workspace with many repositories does not launch one
        // `git status` per repository simultaneously and stall the active row's render.
        void mapWithConcurrency(pending, COLLAPSED_COUNT_SCAN_CONCURRENCY, (runtime) =>
            this.scanRepositoryFileCount(runtime),
        );
    }

    /**
     * Refreshes only the lightweight changed-file count for a collapsed or newly active row.
     *
     * Uses a status-only Git call (no numstat) since the count needs paths and statuses
     * only; full stats arrive later when the row is activated or expanded. The scan is
     * discarded if a full runtime refresh starts before the status result resolves. The
     * returned promise resolves when the scan settles so callers can bound concurrency.
     */
    private scanRepositoryFileCount(runtime: CommitPanelRepositoryRuntime): Promise<void> {
        const dataSeq = runtime.dataRefreshSeq;
        const countRequestId = ++runtime.countRefreshSeq;
        return runtime.gitOps
            .getStatus({ includeIgnored: runtime.showIgnoredFiles, withStats: false })
            .then((files) => {
                if (
                    dataSeq !== runtime.dataRefreshSeq ||
                    countRequestId !== runtime.countRefreshSeq
                ) {
                    return;
                }
                runtime.files = files;
                runtime.hasScannedFileCount = true;
                runtime.lastKnownChangedFileCount = this.countChangedFiles(runtime);
                this.storeChangedFileCount(runtime);
                this.updateAggregateChangedFileCount();
                this.postRepositoryListHydration();
            })
            .catch(() => {});
    }

    /** Keeps provider-owned file watchers aligned with expanded non-active rows. */
    private syncRuntimeWatchers(): void {
        const desiredRoots = new Set(
            Array.from(this.expandedRepositoryRoots).filter(
                (root) => root !== this.activeRepositoryRoot,
            ),
        );

        for (const root of Array.from(this.runtimeWatchers.keys())) {
            if (desiredRoots.has(root)) continue;
            this.disposeRuntimeWatcher(root);
        }

        for (const root of desiredRoots) {
            const runtime = this.runtimes.get(root);
            if (!runtime || this.runtimeWatchers.has(root)) continue;
            this.registerRuntimeWatcher(runtime);
        }
    }

    /** Registers a repository-scoped filesystem watcher that refreshes only its owning runtime. */
    private registerRuntimeWatcher(runtime: CommitPanelRepositoryRuntime): void {
        try {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(runtime.repoRootUri, "**/*"),
            );
            const refresh = (uri: vscode.Uri) => {
                if (!this.shouldRefreshForWatcherUri(runtime, uri)) return;
                this.refreshDataWithErrorHandling(true, runtime);
            };
            const disposables = [
                watcher.onDidChange(refresh),
                watcher.onDidCreate(refresh),
                watcher.onDidDelete(refresh),
                watcher,
            ];
            this.runtimeWatchers.set(runtime.repository.root, {
                dispose: () => {
                    for (const disposable of disposables) {
                        disposable.dispose();
                    }
                },
            });
        } catch {
            /* File watching may be unavailable for virtual or test roots. */
        }
    }

    /** Filters watcher events to real working-tree paths and skips noisy generated/Git folders. */
    private shouldRefreshForWatcherUri(
        runtime: CommitPanelRepositoryRuntime,
        uri: vscode.Uri,
    ): boolean {
        const relativePath = path.relative(runtime.repository.root, uri.fsPath);
        if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            return false;
        }
        const [topLevelDir] = relativePath.split(/[\\/]/);
        return !CommitPanelViewProvider.ignoredWatcherDirs.has(topLevelDir ?? "");
    }

    /** Disposes the provider-owned watcher for one repository root if it is currently registered. */
    private disposeRuntimeWatcher(root: string): void {
        const watcher = this.runtimeWatchers.get(root);
        if (!watcher) return;
        watcher.dispose();
        this.runtimeWatchers.delete(root);
    }

    /** Disposes every provider-owned repository watcher during root resets and provider teardown. */
    private disposeAllRuntimeWatchers(): void {
        for (const root of Array.from(this.runtimeWatchers.keys())) {
            this.disposeRuntimeWatcher(root);
        }
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
                const errorMessage = getErrorMessage(err);
                vscode.window.showErrorMessage(errorMessage);
                this.postToWebview({
                    type: "error",
                    ...this.repositoryScopeForError(message),
                    message: errorMessage,
                });
            }
        });
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) return;
            const runtime = this.getActiveRuntime();
            if (!runtime) return;
            this.postWorkingTreeSnapshot(runtime);
            this.refreshAllRepositoriesWithErrorHandling(true);
        });
        this.postRepositoryListHydration();
        this.updateViewCount(this.lastFileCount);
    }
    /**
     * Refreshes working-tree/stash data and then reloads embedded graph state.
     */
    async refresh(shouldContinue: () => boolean = () => true): Promise<void> {
        if (!shouldContinue()) return;
        const runtime = this.requireActiveRuntime();
        // The switch guard after the refresh prevents stale graph publication.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        await this.refreshAllRepositories(false);
        if (!shouldContinue() || runtime !== this.getActiveRuntime()) return;
        await this.refreshGraphData(runtime);
    }
    /** Refreshes working-tree data without showing webview or context-key spinner state. */
    async refreshSilent(): Promise<void> {
        await this.refreshAllRepositories(true);
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
        this.postToWebview({
            type: "update",
            ...this.snapshotForRuntime(runtime),
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
        await this.refreshRepositoryData(runtime, silent);
    }

    /** Refreshes the active runtime plus any expanded rows in parallel. */
    private async refreshAllRepositories(silent: boolean): Promise<void> {
        const runtimes = this.watchedRuntimes();
        await Promise.all(runtimes.map((runtime) => this.refreshRepositoryData(runtime, silent)));
    }

    /** Returns the unique runtime set that should stay fresh in the docked commit panel. */
    private watchedRuntimes(): CommitPanelRepositoryRuntime[] {
        const roots = new Set<string>();
        if (this.activeRepositoryRoot !== null) roots.add(this.activeRepositoryRoot);
        for (const root of this.expandedRepositoryRoots) roots.add(root);
        return Array.from(roots)
            .map((root) => this.runtimes.get(root))
            .filter((runtime): runtime is CommitPanelRepositoryRuntime => runtime !== undefined);
    }

    /**
     * Reloads full working-tree, stash, icon, and branch metadata for exactly one runtime.
     *
     * Request sequencing prevents stale async responses from overwriting a later refresh for the
     * same repository while leaving other repository rows untouched.
     */
    private async refreshRepositoryData(
        runtime: CommitPanelRepositoryRuntime,
        silent: boolean,
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
                ++this.visibleRefreshCount === 1
                    ? vscode.commands.executeCommand(
                          "setContext",
                          "intelligit.commitPanel.refreshing",
                          true,
                      )
                    : undefined,
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
                runtime.hasScannedFileCount = true;
                runtime.lastKnownChangedFileCount = this.countChangedFiles(runtime);
                this.storeChangedFileCount(runtime);
                this.updateAggregateChangedFileCount();
                this.postToWebview({
                    type: "update",
                    ...this.snapshotForRuntime(runtime),
                });
                this.postRepositoryListHydration();
            }
        } finally {
            if (!silent) {
                const remainingMs = MIN_VISIBLE_REFRESH_MS - (Date.now() - refreshStartedAt);
                if (remainingMs > 0) {
                    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
                }
                if (refreshRequestId === runtime.dataRefreshSeq) {
                    this.postToWebview({
                        type: "refreshing",
                        repositoryRoot: runtime.repository.root,
                        active: false,
                    });
                }
                this.visibleRefreshCount = Math.max(0, this.visibleRefreshCount - 1);
                void Promise.resolve(
                    this.visibleRefreshCount === 0
                        ? vscode.commands.executeCommand(
                              "setContext",
                              "intelligit.commitPanel.refreshing",
                              false,
                          )
                        : undefined,
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
            repositoryLabel: runtime.repository.label,
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
        this.postToWebview({ type: "setFilterText", text });
        await this.loadInitialGraphCommits(runtime);
    }
    /** Hydrates the active repository and restores its persisted commit draft after webview readiness. */
    private async handleReadyMessage(): Promise<void> {
        const runtime = this.getActiveRuntime();
        this.postRepositoryListHydration();
        if (runtime) {
            this.postWorkingTreeSnapshot(runtime);
            await this.refreshAllRepositories(true);
            await this.refreshGraphData(runtime);
        }
        this.postToWebview({
            type: "restoreCommitDraft",
            ...(runtime ? { repositoryRoot: runtime.repository.root } : {}),
            message: this.getStoredCommitDraft(runtime),
        });
    }
    /** Updates ignored-file visibility for the addressed runtime and refreshes that runtime's data. */
    private async handleSetShowIgnoredFilesMessage(
        showIgnoredFiles: unknown,
        runtime: CommitPanelRepositoryRuntime | undefined,
    ): Promise<void> {
        if (!runtime) return;
        runtime.showIgnoredFiles = showIgnoredFiles === true;
        await this.refreshData(true, runtime);
    }
    /** Validates and forwards a branch context-menu action emitted by the Changes webview. */
    private handleBranchActionMessage(action: unknown, branchName: unknown): void {
        const branchAction = assertString(action, "action");
        if (!isBranchAction(branchAction)) {
            throw new Error("Invalid branch action received from webview.");
        }
        this._onBranchAction.fire({
            action: branchAction,
            branchName: assertString(branchName, "branchName"),
        });
    }
    /** Validates and forwards a commit context-menu action emitted by the Changes webview. */
    private handleCommitActionMessage(action: unknown, hash: unknown): void {
        const commitAction = assertString(action, "action");
        if (!isCommitAction(commitAction)) {
            throw new Error("Invalid commit action received from webview.");
        }
        this._onCommitAction.fire({ action: commitAction, hash: assertGitHash(hash, "hash") });
    }
    /** Loads a selected stash into the addressed runtime and publishes the resulting file state. */
    private async handleStashSelectMessage(
        runtime: CommitPanelRepositoryRuntime | undefined,
        index: unknown,
    ): Promise<void> {
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
            index,
        );
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
            case "ready":
                await this.handleReadyMessage();
                break;
            case "refresh":
                await this.refreshFromUserAction(scopedRuntime());
                break;
            case "setExpandedRepositories":
                await this.setExpandedRepositories(msg.repositoryRoots);
                break;
            case "abortMerge":
                await this.abortMerge(scopedRuntime());
                break;
            case "setShowIgnoredFiles":
                await this.handleSetShowIgnoredFilesMessage(msg.showIgnoredFiles, scopedRuntime());
                break;
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
                this.postToWebview({ type: "setFilterText", text: "" });
                await this.loadInitialGraphCommits(runtime);
                break;
            }
            case "branchAction":
                this.handleBranchActionMessage(msg.action, msg.branchName);
                break;
            case "commitAction":
                this.handleCommitActionMessage(msg.action, msg.hash);
                break;
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
            case "stashSelect":
                await this.handleStashSelectMessage(scopedRuntime(), msg.index);
                break;
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
                    if (runtime === this.getActiveRuntime()) {
                        await this.refreshGraphData(runtime);
                    }
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
        this.disposeAllRuntimeWatchers();
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
            this.postToWebview({ type: "error", repositoryRoot: runtime.repository.root, message });
        });
    }
    /** Runs aggregate docked-row refreshes from listeners without leaking rejected promises. */
    private refreshAllRepositoriesWithErrorHandling(silent = false): void {
        this.refreshAllRepositories(silent).catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(message);
            this.postToWebview({ type: "error", message });
        });
    }
    private registerThemeChangeListeners(): void {
        this.themeChangeDisposables.push(
            ...registerThemeChangeListeners(() =>
                this.refreshAllRepositoriesWithErrorHandling(false),
            ),
        );
    }
    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }

    /**
     * Returns repository identity for trusted repository-scoped error payloads.
     */
    private repositoryScopeForError(raw: unknown): { repositoryRoot?: string } {
        if (!raw || typeof raw !== "object") return {};
        const repositoryRoot = (raw as { repositoryRoot?: unknown }).repositoryRoot;
        if (typeof repositoryRoot !== "string") return {};
        return this.runtimes.has(repositoryRoot) ? { repositoryRoot } : {};
    }
}
