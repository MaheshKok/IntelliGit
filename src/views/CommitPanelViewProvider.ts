// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and stash management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import {
    CommitMessageGenerationCoordinator,
    type CommitMessageGenerationHost,
} from "../ai/commitMessageGenerationCoordinator";
import { showCommitMessageGenerationNotification } from "../ai/commitMessageGenerationNotifications";
import type { Branch, CommitDetail, ThemeFolderIconMap } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";
import { decorateShelfFiles, shelfFilePaths } from "./shelfIconDecoration";
import { getErrorMessage } from "../utils/errors";
import { postWebviewMessage } from "./webviewDelivery";
import { mapWithConcurrency } from "../utils/concurrency";
import { assertRepoRelativePath } from "../utils/fileOps";
import { abortMergeWithConfirmation } from "./mergeAbort";
import type {
    CommitPanelRepositorySnapshot,
    InboundMessage,
} from "../webviews/protocol/commitPanelMessages";
import type { ShelfService } from "../services/shelfService";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { CommitPanelRepositoryRuntime } from "./commitPanelRepositoryRuntime";
import { operationSnapshotForRepository } from "./commitPanelOperationSnapshot";
import { ShelfConflictEditorPanel } from "./ShelfConflictEditorPanel";
import { runPublishBranchFlow } from "../services/publishService";
import { showTimedWarningMessage } from "../utils/notifications";
import type {
    BranchAction,
    CommitAction,
    CommitGraphInbound,
} from "../webviews/protocol/commitGraphTypes";
import type { RebaseSubmissionEntry } from "../git/interactiveRebase/types";
import { isBranchAction, isCommitAction } from "../webviews/protocol/commitGraphTypes";
import { IconThemeService } from "./shared/IconThemeService";
import { isRedundantPost, serializeWebviewPayload } from "./shared/postedPayload";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import {
    subscribeToRepositoryWorkingTreeChanges,
    type RepositoryWorkingTreeChange,
} from "../services/repositoryChangeEvents";
import {
    assertGitHash,
    assertMessage,
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
 * Whether a `ready` message is a panel re-asking rather than a webview announcing itself.
 *
 * The count is untrusted webview input, so anything that is not a number above 1 -- a missing
 * field from a producer that predates it, a string, a hand-crafted payload -- is read as a first
 * announcement. Failing that way round is the safe one: it costs a redundant refresh, where the
 * opposite would withhold the startup read from a panel that genuinely needs it.
 */
function isHydrationReAsk(attempt: unknown): boolean {
    return typeof attempt === "number" && attempt > 1;
}

/**
 * Whether a root event can change what an expanded repository row shows.
 *
 * The row watcher this replaced was a `createFileSystemWatcher`, so it only ever saw disk
 * writes; routing it through the shared event stream also handed it Git-metadata events and
 * one buffer edit per keystroke. Both are filtered here rather than at the publisher, because
 * the diff viewer subscribes to the same stream and does need the keystroke -- it renders an
 * open document's unsaved text. What this row renders is `git status`, which cannot change
 * until the write lands, so refreshing on an unsaved edit re-runs it for an answer that cannot
 * differ.
 */
export function affectsExpandedRow(event: RepositoryWorkingTreeChange): boolean {
    return event.source === "workspace-file" && event.unsaved !== true;
}

/**
 * Reads `WebviewView.visible`, reporting "could not be read" as `undefined` rather than as a
 * boolean.
 *
 * Every getter on a disposed `WebviewView` raises instead of returning, so this is a three-answer
 * question wearing a two-answer type. Answering it with a per-call fallback boolean was enough to
 * stop the raise but not to decide ownership: an unreadable view and a hidden one then arrive at
 * {@link retainsOwnership} as the same value, and they do not mean remotely the same thing.
 */
function readVisible(view: vscode.WebviewView): boolean | undefined {
    try {
        return view.visible;
    } catch {
        return undefined;
    }
}

/**
 * Whether the recorded view keeps ownership against a sender that has just delivered a message.
 *
 * The rule reads down the three states of the RECORD, because only the record can be stale:
 *
 * - unreadable -- it can no longer render anything it is handed, so it yields to any live sender,
 *   a hidden one included. A hidden view is not a quiet one; VS Code reloads a hidden view's
 *   document without re-running {@link CommitPanelViewProvider.resolveWebviewView}, so a `ready`
 *   from one is a view that will paint the moment its pane is shown.
 * - visible -- it is on screen and wins outright.
 * - hidden -- it yields only to a sender that is readable and visible, so a hidden sender never
 *   displaces it and an unreadable sender is still answered where it stands.
 *
 * Stated as one function because the previous form asked the two questions independently, and
 * `!senderVisible` could then return ownership to a record that had already lost it.
 */
function retainsOwnership(current: vscode.WebviewView, sender: vscode.WebviewView): boolean {
    const recorded = readVisible(current);
    if (recorded === undefined) return false;
    return recorded || readVisible(sender) === false;
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
    private view?: vscode.WebviewView;
    private lastFileCount = 0;
    private repositories: DiscoveredRepository[] = [];
    private readonly runtimes = new Map<string, CommitPanelRepositoryRuntime>();
    private readonly expandedRepositoryRoots = new Set<string>();
    private readonly runtimeWatchers = new Map<string, vscode.Disposable>();
    private readonly runtimeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    /** Serialized form of the last `setCommitDetail` payload actually posted to the CURRENT
     * webview -- see `shared/postedPayload.ts`. Reset to `undefined` whenever a fresh webview is
     * resolved, an actually adopted live sender replaces a hidden cached view, or the commit-detail
     * cache is cleared, so a redundant-looking repost after any ownership change is never wrongly
     * suppressed. */
    private lastPostedPayload: string | undefined;
    /** Whether `handleReadyMessage` has ever completed its full Git read, which is what fills the
     * runtime caches a re-ask is answered from. Never reset: a later mount that re-asks is served
     * from those same caches, so what matters is that SOME attempt filled them, not which one. */
    private startupReadCompleted = false;
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
    private readonly _onRebaseDialogSubmit = new vscode.EventEmitter<{
        requestId: string;
        entries: RebaseSubmissionEntry[];
    }>();
    readonly onRebaseDialogSubmit = this._onRebaseDialogSubmit.event;
    private readonly _onRebaseDialogCancel = new vscode.EventEmitter<{ requestId: string }>();
    readonly onRebaseDialogCancel = this._onRebaseDialogCancel.event;
    private readonly _onRebaseControl = new vscode.EventEmitter<{
        action: "continue" | "abort";
        repositoryRoot?: string;
    }>();
    readonly onRebaseControl = this._onRebaseControl.event;
    private readonly _onOpenCommitFileDiff = new vscode.EventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    readonly onOpenCommitFileDiff = this._onOpenCommitFileDiff.event;
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
        private readonly shelfServiceForRepository?: (
            repositoryRoot: string,
        ) => ShelfService | undefined,
        private readonly shelfRemoveOnUnshelve: boolean = true,
        private readonly commitMessageGenerationCoordinator?: CommitMessageGenerationCoordinator,
        private readonly interactiveRebaseStorageRoot?: string,
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
            this.commitMessageGenerationCoordinator?.dropHostRoot(
                this.commitMessageGenerationHost,
                runtime.repository.root,
            );
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
            kind: "repository",
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
            this.commitMessageGenerationCoordinator?.dropHostRoot(
                this.commitMessageGenerationHost,
                root,
            );
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
            const gitOps =
                repository.root === activeRoot && activeGitOps
                    ? activeGitOps
                    : this.gitOps.deriveFor(repository.root);
            const runtime = new CommitPanelRepositoryRuntime(
                repository,
                gitOps,
                this.shelfServiceForRepository?.(repository.root),
                this.shelfRemoveOnUnshelve,
            );
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
        if (activeChanged && previousActiveRuntime) {
            this.dropCommitMessageGenerationForRetainedRoot(previousActiveRoot, nextRoots);
            this.invalidateRuntime(previousActiveRuntime);
        }

        this.updateAggregateChangedFileCount();

        const activeRuntime = this.getActiveRuntime();
        this.repoRootUri = activeRuntime?.repoRootUri;
        this.resetActiveRepositoryState(activeRuntime, activeChanged || options.resetActiveState);
        this.postRepositoryListHydration();
        this.syncRuntimeWatchers();
        this.scanInitialCollapsedCounts();
        if (activeChanged && previousActiveRoot !== null && activeRuntime) {
            void this.scanRepositoryFileCount(activeRuntime);
        }
    }

    /** Cancels a generation owned by this host when the previous active runtime remains registered. */
    private dropCommitMessageGenerationForRetainedRoot(
        previousActiveRoot: string | null,
        nextRoots: ReadonlySet<string>,
    ): void {
        if (previousActiveRoot === null || !nextRoots.has(previousActiveRoot)) return;
        this.commitMessageGenerationCoordinator?.dropHostRoot(
            this.commitMessageGenerationHost,
            previousActiveRoot,
        );
    }

    /** Clears active-repository state and restores its persisted draft after a repository change. */
    private resetActiveRepositoryState(
        activeRuntime: CommitPanelRepositoryRuntime | undefined,
        shouldReset: boolean | undefined,
    ): void {
        if (!shouldReset) return;
        this.selectedCommitDetail = null;
        this.commitDetailFolderIconsByName = {};
        this.branchFolderIconsByName = {};
        this.commitDetailSeq += 1;
        if (!activeRuntime) return;
        this.postToWebview({
            type: "restoreCommitDraft",
            repositoryRoot: activeRuntime.repository.root,
            message: this.getStoredCommitDraft(activeRuntime),
        });
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
    private async snapshotForRuntime(
        runtime: CommitPanelRepositoryRuntime,
    ): Promise<CommitPanelRepositorySnapshot> {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        const [hasCommits, operation] = await Promise.all([
            runtime.gitOps.hasAnyCommits(),
            this.operationSnapshotForRuntime(runtime),
        ]);
        return {
            repositoryRoot: runtime.repository.root,
            repositoryLabel: runtime.repository.label,
            changedFileCount: this.countChangedFiles(runtime),
            files: runtime.files,
            hasCommits,
            wholeIndexOperationInProgress: operation.activeOperation !== "none",
            ...operation,
            stashes: runtime.stashes,
            stashFiles: runtime.stashFiles,
            selectedStashIndex: runtime.selectedStashIndex,
            shelves: runtime.shelves,
            catalogGeneration: runtime.catalogGeneration,
            selectedShelfId: runtime.selectedShelfId,
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

    /** Derives the operation protocol from one filesystem marker snapshot without another Git process. */
    private async operationSnapshotForRuntime(runtime: CommitPanelRepositoryRuntime) {
        return operationSnapshotForRepository({
            gitOps: runtime.gitOps,
            repositoryRoot: runtime.repository.root,
            interactiveRebaseStorageRoot: this.interactiveRebaseStorageRoot,
        });
    }

    /** Reads shelf state from the runtime-scoped service without crossing repository boundaries. */
    private async shelfSnapshotForRuntime(runtime: CommitPanelRepositoryRuntime): Promise<{
        shelves: CommitPanelRepositorySnapshot["shelves"];
        catalogGeneration: number;
        selectedShelfId: string | null;
        shelfRemoveOnUnshelve: boolean;
        shelfHealth: CommitPanelRepositorySnapshot["shelfHealth"];
    }> {
        if (!runtime.shelfService) {
            return {
                shelves: [],
                catalogGeneration: 0,
                selectedShelfId: null,
                shelfRemoveOnUnshelve: runtime.shelfRemoveOnUnshelve,
                shelfHealth: [],
            };
        }
        const listed = await runtime.shelfService.listShelves();
        const selectedShelfId = listed.shelves.some((shelf) => shelf.id === runtime.selectedShelfId)
            ? runtime.selectedShelfId
            : (listed.shelves[0]?.id ?? null);
        return {
            shelves: await decorateShelfFiles(this.iconTheme, listed.shelves),
            catalogGeneration: listed.catalogGeneration,
            selectedShelfId,
            shelfRemoveOnUnshelve: runtime.shelfRemoveOnUnshelve,
            shelfHealth: runtime.shelfService
                .getHealthWarnings()
                .map((warning) => ({ ...warning })),
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

    /** Retains the shared root watcher while this non-active repository row stays expanded. */
    private registerRuntimeWatcher(runtime: CommitPanelRepositoryRuntime): void {
        try {
            this.runtimeWatchers.set(
                runtime.repository.root,
                subscribeToRepositoryWorkingTreeChanges(runtime.repository.root, (event) => {
                    if (!affectsExpandedRow(event)) return;
                    this.scheduleRuntimeWatcherRefresh(runtime);
                }),
            );
        } catch (error) {
            console.error("[IntelliGit] Commit-panel runtime watcher registration failed:", error);
        }
    }

    /** Coalesces row-local file changes at the active service's light-refresh cadence. */
    private scheduleRuntimeWatcherRefresh(runtime: CommitPanelRepositoryRuntime): void {
        const root = runtime.repository.root;
        const existing = this.runtimeRefreshTimers.get(root);
        if (existing) clearTimeout(existing);
        this.runtimeRefreshTimers.set(
            root,
            setTimeout(() => {
                this.runtimeRefreshTimers.delete(root);
                if (!this.runtimeWatchers.has(root)) return;
                this.refreshDataWithErrorHandling(true, runtime);
            }, 300),
        );
    }

    /** Disposes the provider-owned watcher for one repository root if it is currently registered. */
    private disposeRuntimeWatcher(root: string): void {
        const timer = this.runtimeRefreshTimers.get(root);
        if (timer) clearTimeout(timer);
        this.runtimeRefreshTimers.delete(root);
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

    /** Holds the shared commit lease for a runtime-scoped commit so generation cannot race it. */
    private acquireCommitLeaseForRuntime(
        runtime: CommitPanelRepositoryRuntime | undefined,
    ): (() => void) | undefined {
        return runtime
            ? this.commitMessageGenerationCoordinator?.acquireCommitLease(runtime.repository.root)
            : undefined;
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
            postCommitted: async () => {
                let clearCommitMessage =
                    vscode.workspace
                        .getConfiguration("intelligit")
                        .get<boolean>("clearLastCommit", true) !== false;
                if (clearCommitMessage && this.workspaceState) {
                    try {
                        await this.workspaceState.update(
                            this.getCommitDraftStorageKey(runtime),
                            undefined,
                        );
                    } catch {
                        clearCommitMessage = false;
                    }
                }
                this.postToWebview({
                    type: "committed",
                    clearCommitMessage,
                    ...(runtime ? { repositoryRoot: runtime.repository.root } : {}),
                });
            },
            maybeOfferPublishBranch: () =>
                runtime ? this.maybeOfferPublishBranch(runtime) : Promise.resolve(),
            publishBranch: runtime ? () => this.publishBranch(runtime) : undefined,
        };
    }

    /** Runs a correlated stash mutation and posts completion for the repository captured at dispatch. */
    private runStashMutationRequest(
        runtime: CommitPanelRepositoryRuntime | undefined,
        mutation: StashMutation,
        requestIdValue: unknown,
    ): Promise<void> {
        return executeStashMutationRequest(
            this.actionDepsForRuntime(runtime),
            mutation,
            requestIdValue,
            (requestId) => {
                const repositoryRoot = (runtime ?? this.requireActiveRuntime()).repository.root;
                this.postToWebview({
                    type: "stashMutationCompleted",
                    repositoryRoot,
                    requestId,
                });
            },
        );
    }

    /** Returns the shelf service bound to exactly one repository runtime. */
    private requireShelfService(runtime: CommitPanelRepositoryRuntime | undefined): ShelfService {
        if (!runtime?.shelfService)
            throw new Error("Shelf service is unavailable for this repository.");
        return runtime.shelfService;
    }

    /** Selects an existing shelf after validating it against the current repository catalog. */
    private async selectShelf(
        runtime: CommitPanelRepositoryRuntime | undefined,
        shelfIdValue: unknown,
    ): Promise<void> {
        if (!runtime) throw new Error("No active repository selected.");
        const shelfId = assertShelfId(shelfIdValue, "shelfId");
        const service = this.requireShelfService(runtime);
        const listed = await service.listShelves();
        if (!listed.shelves.some((shelf) => shelf.id === shelfId)) {
            throw new Error("Shelf does not exist.");
        }
        runtime.shelves = await decorateShelfFiles(this.iconTheme, listed.shelves);
        runtime.catalogGeneration = listed.catalogGeneration;
        runtime.selectedShelfId = shelfId;
        await this.postWorkingTreeSnapshot(runtime);
    }

    /** Runs one correlated shelf mutation and scopes its completion to the addressed runtime. */
    private async runShelfMutationRequest(
        runtime: CommitPanelRepositoryRuntime | undefined,
        message: Record<string, unknown>,
    ): Promise<void> {
        const service = this.requireShelfService(runtime);
        if (!runtime) throw new Error("No active repository selected.");
        assertString(message.requestId, "requestId");
        try {
            await executeShelfMutationRequest(
                {
                    shelfService: service,
                    refreshData: () => this.refreshData(false, runtime),
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
                (completion) => {
                    this.postToWebview({
                        ...completion,
                        repositoryRoot: runtime.repository.root,
                    });
                },
            );
        } catch {
            // A valid correlated request already posted shelfMutationCompleted.
        }
    }

    /** Validates and opens a non-mutating shelf conflict editor for one repository runtime. */
    private async openShelfConflictEditor(
        runtime: CommitPanelRepositoryRuntime | undefined,
        message: Record<string, unknown>,
    ): Promise<void> {
        if (!runtime) throw new Error("No active repository selected.");
        const shelfService = this.requireShelfService(runtime);
        await openShelfConflictEditorFromMessage(
            {
                shelfService,
                openShelfConflictEditor: (shelfId, changeId) =>
                    ShelfConflictEditorPanel.open({
                        extensionUri: this.extensionUri,
                        repositoryRoot: runtime.repository.root,
                        shelfService,
                        shelfId,
                        changeId,
                        onApplied: async () => {
                            await this.refreshData(false, runtime);
                            this._onDidChangeWorkingTree.fire();
                        },
                    }),
            },
            message,
        );
    }

    /** Runs a correlated single-file stash request against the repository captured at dispatch. */
    private runStashFileMutationRequest(
        runtime: CommitPanelRepositoryRuntime | undefined,
        message: Record<string, unknown>,
    ): Promise<void> {
        return executeStashFileMutationRequest(
            this.actionDepsForRuntime(runtime),
            message,
            (requestId) => {
                const repositoryRoot = (runtime ?? this.requireActiveRuntime()).repository.root;
                this.postToWebview({
                    type: "stashMutationCompleted",
                    repositoryRoot,
                    requestId,
                });
            },
        );
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
        // Cache-only until a view exists -- see `CommitGraphViewProvider.setBranches` for why an
        // unawaited asynchronous send still reaches a view that attaches in the meantime, and why
        // the webview cannot have received such a post.
        if (!this.view) return;
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
        this.lastPostedPayload = undefined;
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
        this.lastPostedPayload = undefined;
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
                // Inside the try, not before it. Adoption reads state owned by VS Code rather than
                // by this provider, so it can raise; raising ahead of the try rejected this async
                // listener before `handleMessage` ran, which posted nothing, showed nothing and
                // logged nothing. Every retry then died at the same line, so a panel waiting on
                // hydration stayed blank while looking, from every angle, like a host that had
                // simply gone quiet.
                this.adoptLiveSender(thisView);
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
            void this.postWorkingTreeSnapshot(runtime).catch(() => {});
            this.refreshAllRepositoriesWithErrorHandling(true);
        });
        // Deliberately NOT hydrating the repository list here. `handleReadyMessage` calls
        // `postRepositoryListHydration()` unconditionally, and `ready` always follows a resolve --
        // it is sent by the very webview this method creates. Hydrating here posted a byte-identical
        // `setRepositories` an instant earlier, to a webview whose script had not yet attached its
        // message listener.
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
     * Posts a working-tree snapshot after awaiting snapshotForRuntime's Git I/O.
     *
     * This is used when a newly-ready webview reconnects so it can render the most recent file list
     * immediately, before the follow-up silent refresh reconciles any changes that happened while
     * the webview was hidden or loading.
     */
    private async postWorkingTreeSnapshot(runtime: CommitPanelRepositoryRuntime): Promise<void> {
        this.postToWebview({
            type: "update",
            ...(await this.snapshotForRuntime(runtime)),
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

    /** Tells the webview whether a visible refresh is running for this repository. */
    private postRefreshing(runtime: CommitPanelRepositoryRuntime, active: boolean): void {
        this.postToWebview({ type: "refreshing", repositoryRoot: runtime.repository.root, active });
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
            this.postRefreshing(runtime, true);
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
            const [stashes, currentBranchStatus, shelfState] = await Promise.all([
                runtime.gitOps.listStashes().catch(() => runtime.stashes),
                this.currentBranchStatus(runtime).catch(() => ({
                    hasUpstream: runtime.currentBranchHasUpstreamCache,
                    hasRemotes: runtime.hasRemotesCache,
                    ahead: runtime.currentBranchAheadCache,
                    behind: runtime.currentBranchBehindCache,
                    name: runtime.currentBranchNameCache,
                    upstream: runtime.currentBranchUpstreamCache,
                })),
                this.shelfSnapshotForRuntime(runtime).catch(() => ({
                    shelves: runtime.shelves,
                    catalogGeneration: runtime.catalogGeneration,
                    selectedShelfId: runtime.selectedShelfId,
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
                .getFolderIconsByPaths([
                    ...files.map((file) => file.path),
                    ...stashFiles.map((file) => file.path),
                    ...shelfFilePaths(shelfState.shelves),
                ])
                .catch(() => runtime.folderIconsByName);
            if (refreshRequestId === runtime.dataRefreshSeq) {
                runtime.folderIconsByName = folderIconsByName;
                runtime.files = files;
                runtime.stashes = stashes;
                runtime.selectedStashIndex = selectedStashIndex;
                runtime.stashFiles = stashFiles;
                runtime.shelves = shelfState.shelves;
                runtime.catalogGeneration = shelfState.catalogGeneration;
                runtime.selectedShelfId = shelfState.selectedShelfId;
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
                    ...(await this.snapshotForRuntime(runtime)),
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
                    this.postRefreshing(runtime, false);
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
    /**
     * Hydrates the active repository and restores its persisted commit draft after webview readiness.
     *
     * `attempt` is the webview's own count of how many times it has asked (see
     * `useExtensionMessages.ts`). Anything above 1 is a panel re-asking because it never received
     * the previous answer -- it is still mounted, still empty, and still waiting. Such a panel needs
     * everything this host already holds, so the repository list, the cached working-tree snapshot
     * and the stored draft are all posted for every attempt. What a re-ask does NOT need is the
     * startup Git read repeated: nothing about the host's data went stale, only the delivery
     * failed. That distinction is load-bearing rather than an optimization -- the webview re-asks
     * on a timer, and paying full price per attempt is exactly the cost that used to force it to
     * stop asking after fifteen tries and leave the panel blank for the rest of the session.
     */
    private async handleReadyMessage(attempt?: unknown): Promise<void> {
        // A fresh webview context has received nothing, so any commit-detail post made during
        // this handler must never be suppressed as a duplicate of what the PREVIOUS context was
        // sent. `ready` fires again whenever VS Code tears this view down while it is hidden and
        // reloads it on show -- `resolveWebviewView` does NOT re-run then, so its reset alone
        // would leave the restored changed-files pane empty.
        this.lastPostedPayload = undefined;
        const runtime = this.getActiveRuntime();
        this.postRepositoryListHydration();
        if (runtime) {
            await this.postWorkingTreeSnapshot(runtime);
            // The snapshot above comes from an empty cache on a cold start, so the first
            // load announces itself: the panel would otherwise sit on "No shelves." with
            // no sign that Git is still being read. The refresh itself stays silent and
            // the flag is posted around it — the toolbar already holds the spin long
            // enough to be seen, so this path skips the minimum-visible padding, which
            // would delay the restored commit draft by more than half a second.
            //
            // Skipped for a re-ask, but only once this read has actually completed: then the
            // caches above hold the same working tree the refresh would re-read, and its
            // results reach the panel through the ordinary post path.
            //
            // The attempt number alone is not enough, because a `ready` can be lost on the way
            // IN. The host then never ran this read, `runtime.files` is still empty, and
            // answering the re-ask from cache would post a confident "no changes" over a dirty
            // tree -- a wrong panel in place of a blank one.
            if (!isHydrationReAsk(attempt) || !this.startupReadCompleted) {
                this.postRefreshing(runtime, true);
                try {
                    await this.refreshAllRepositories(true);
                } finally {
                    this.postRefreshing(runtime, false);
                }
                await this.refreshGraphData(runtime);
                this.startupReadCompleted = true;
            }
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
    /** Validates only the rebase-dialog transport shape before forwarding raw entries. */
    private handleRebaseDialogSubmitMessage(requestId: unknown, entries: unknown): void {
        const id = assertString(requestId, "requestId");
        if (id.length === 0) throw new Error("Expected non-empty string for 'requestId'.");
        if (!Array.isArray(entries)) throw new Error("Expected array for 'entries'.");
        this._onRebaseDialogSubmit.fire({
            requestId: id,
            entries: entries as RebaseSubmissionEntry[],
        });
    }
    /** Validates only the rebase-dialog cancellation transport shape before forwarding it. */
    private handleRebaseDialogCancelMessage(requestId: unknown): void {
        const id = assertString(requestId, "requestId");
        if (id.length === 0) throw new Error("Expected non-empty string for 'requestId'.");
        this._onRebaseDialogCancel.fire({ requestId: id });
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
                getShelfFilePaths: () => shelfFilePaths(runtime.shelves),
                currentBranchHasUpstream: async () =>
                    (await this.currentBranchStatus(runtime)).hasUpstream,
                setStashState: (state) => {
                    runtime.selectedStashIndex = state.selectedStashIndex;
                    runtime.stashFiles = state.stashFiles;
                    runtime.folderIconsByName = state.folderIconsByName;
                },
                postUpdate: async (message) => {
                    const [hasCommits, operation] = await Promise.all([
                        runtime.gitOps.hasAnyCommits(),
                        this.operationSnapshotForRuntime(runtime),
                    ]);
                    this.postToWebview({
                        ...message,
                        repositoryRoot: runtime.repository.root,
                        shelves: runtime.shelves,
                        catalogGeneration: runtime.catalogGeneration,
                        selectedShelfId: runtime.selectedShelfId,
                        hasCommits,
                        wholeIndexOperationInProgress: operation.activeOperation !== "none",
                        ...operation,
                    });
                },
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
        if (msg.type === "generateCommitMessage") {
            this.handleGenerateCommitMessage(msg);
            return;
        }
        if (msg.type === "cancelCommitMessageGeneration") {
            this.handleCancelCommitMessageGeneration(msg);
            return;
        }
        this.validateKnownRepositoryRoot(msg);
        const activeRuntime = () => this.requireActiveRuntime();
        const scopedRuntime = () => this.runtimeForMessage(msg);
        switch (msg.type) {
            case "ready":
                await this.handleReadyMessage(msg.attempt);
                break;
            case "refresh":
                await this.refreshFromUserAction(scopedRuntime());
                break;
            case "shelfSelect":
                await this.selectShelf(scopedRuntime(), msg.shelfId);
                break;
            case "shelfOpenConflictEditor":
                await this.openShelfConflictEditor(scopedRuntime(), msg);
                break;
            case "shelfDiff":
            case "shelfCompareWithLocal": {
                const runtime = scopedRuntime();
                if (!runtime) throw new Error("No active repository selected.");
                await shelfReadFromMessage(
                    this.requireShelfService(runtime),
                    msg,
                    () => runtime.repoRootUri,
                );
                break;
            }
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
                await this.runShelfMutationRequest(scopedRuntime(), msg);
                break;
            case "setExpandedRepositories":
                await this.setExpandedRepositories(msg.repositoryRoots);
                break;
            case "abortMerge":
                await this.abortMerge(scopedRuntime());
                break;
            case "continueRebase":
                this._onRebaseControl.fire({
                    action: "continue",
                    repositoryRoot: scopedRuntime()?.repository.root,
                });
                break;
            case "abortRebase":
                this._onRebaseControl.fire({
                    action: "abort",
                    repositoryRoot: scopedRuntime()?.repository.root,
                });
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
            case "openRepository":
                await vscode.commands.executeCommand(
                    "intelligit.openRepository",
                    scopedRuntime()?.repository.root,
                );
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
            case "startInteractiveRebase":
                this.handleRebaseDialogSubmitMessage(msg.requestId, msg.entries);
                break;
            case "cancelRebaseDialog":
                this.handleRebaseDialogCancelMessage(msg.requestId);
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
                const runtime = scopedRuntime();
                const actionDeps = this.actionDepsForRuntime(runtime);
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const release = this.acquireCommitLeaseForRuntime(runtime);
                try {
                    await commitSelectedFromPanel(actionDeps, {
                        message,
                        amend: msg.amend === true,
                        push: msg.push === true,
                        paths: assertRepoPathArray(msg.paths, "paths"),
                    });
                } finally {
                    release?.();
                }
                break;
            }
            case "commit": {
                const runtime = scopedRuntime();
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const release = this.acquireCommitLeaseForRuntime(runtime);
                try {
                    await commitOnlyFromPanel(
                        this.actionDepsForRuntime(runtime),
                        message,
                        msg.amend === true,
                    );
                } finally {
                    release?.();
                }
                break;
            }
            case "commitAndPush": {
                const runtime = scopedRuntime();
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const release = this.acquireCommitLeaseForRuntime(runtime);
                try {
                    await commitAndPushFromPanel(
                        this.actionDepsForRuntime(runtime),
                        message,
                        msg.amend === true,
                    );
                } finally {
                    release?.();
                }
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
                await stashMutationFromPanel(this.actionDepsForRuntime(scopedRuntime()), {
                    action: "pop",
                    index: assertNumber(msg.index, "index"),
                    reinstateIndex: false,
                });
                break;
            case "stashApply":
                await stashMutationFromPanel(this.actionDepsForRuntime(scopedRuntime()), {
                    action: "apply",
                    index: assertNumber(msg.index, "index"),
                    reinstateIndex: false,
                });
                break;
            case "cherryPickStashFile":
                await this.runStashFileMutationRequest(scopedRuntime(), msg);
                break;
            case "stashDelete":
                await this.runStashMutationRequest(
                    scopedRuntime(),
                    { action: "delete", index: assertNumber(msg.index, "index") },
                    msg.requestId,
                );
                break;
            case "stashUnstash": {
                await this.runStashMutationRequest(
                    scopedRuntime(),
                    stashMutationFromUnstashMessage(msg),
                    msg.requestId,
                );
                break;
            }
            case "stashClear":
                await this.runStashMutationRequest(
                    scopedRuntime(),
                    { action: "clear" },
                    msg.requestId,
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
                    msg.preview !== false,
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

    /** Registers a docked generation before the coordinator serializes its one fresh status validation. */
    private handleGenerateCommitMessage(message: { [key: string]: unknown }): void {
        const repositoryRoot = message.repositoryRoot;
        const requestId = message.requestId;
        if (typeof repositoryRoot !== "string" || typeof requestId !== "string") return;
        const reject = () => this.postInvalidCommitMessageGeneration(repositoryRoot, requestId);
        const amend = message.amend;
        if (typeof amend !== "boolean") {
            reject();
            return;
        }
        const runtime = this.runtimes.get(repositoryRoot);
        const coordinator = this.commitMessageGenerationCoordinator;
        if (!runtime || !coordinator) {
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
        coordinator.submit({
            repositoryRoot,
            requestId,
            host: this.commitMessageGenerationHost,
            validate: async (control) => {
                // The post-await active check is the generation cancellation fence.
                // react-doctor-disable-next-line react-doctor/async-defer-await
                const validatedStatusSnapshot = await runtime.gitOps.getStatus({
                    withStats: false,
                });
                if (!control.isActive()) return undefined;
                const selectablePaths = new Set<string>();
                for (const file of validatedStatusSnapshot) {
                    if (file.status !== "!") selectablePaths.add(file.path);
                }
                if (paths.some((filePath) => !selectablePaths.has(filePath))) return undefined;
                if (paths.length === 0 && !amend) return undefined;
                if (amend) {
                    const hasAnyCommits = await runtime.gitOps.hasAnyCommits();
                    if (!control.isActive() || !hasAnyCommits) return undefined;
                }
                return { paths, amend, validatedStatusSnapshot };
            },
        });
    }

    /** Cancels only the current provider host's exact correlated generation request. */
    private handleCancelCommitMessageGeneration(message: { [key: string]: unknown }): void {
        const repositoryRoot = message.repositoryRoot;
        const requestId = message.requestId;
        if (typeof repositoryRoot !== "string" || typeof requestId !== "string") return;
        if (!this.runtimes.has(repositoryRoot) || !this.commitMessageGenerationCoordinator) {
            this.postInvalidCommitMessageGeneration(repositoryRoot, requestId);
            return;
        }
        this.commitMessageGenerationCoordinator.cancel({
            repositoryRoot,
            requestId,
            host: this.commitMessageGenerationHost,
        });
    }

    /** Emits a correlated rejection without routing a generation boundary failure through generic webview errors. */
    private postInvalidCommitMessageGeneration(repositoryRoot: string, requestId: string): void {
        this.commitMessageGenerationHost.emit({
            repositoryRoot,
            requestId,
            kind: "error",
            errorKind: "invalidRequest",
        });
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
            const payload: CommitGraphInbound = {
                type: "setCommitDetail",
                detail: this.selectedCommitDetail,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.commitDetailFolderIconsByName,
                iconFonts,
            };
            const serialized = serializeWebviewPayload(payload);
            if (isRedundantPost(serialized, this.lastPostedPayload)) return;
            // Recorded only after the post is handed over, so a payload that was never sent
            // cannot suppress the next identical one.
            this.postToWebview(payload);
            this.lastPostedPayload = serialized;
            return;
        }
        this.lastPostedPayload = undefined;
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

    /**
     * Posts a validated rebase-dialog request only to this commit-panel webview instance.
     *
     * Returns whether a live webview existed to receive it, so a caller that already registered a
     * one-shot request can retract it instead of leaving the user with neither a dialog nor an error.
     */
    showRebaseDialog(message: Extract<CommitGraphInbound, { type: "showRebaseDialog" }>): boolean {
        if (!this.view) return false;
        this.postToWebview(message);
        return true;
    }

    /**
     * Re-adopts a webview that is provably live, because it just posted a message.
     *
     * `onDidDispose` clears `this.view`, and VS Code can reload a hidden view's document without
     * re-running `resolveWebviewView` -- the case {@link handleReadyMessage}'s own comment already
     * describes. A `ready` arriving while the record is empty is therefore answered to nothing:
     * every reply hits {@link postToWebview}'s `!view` early return, which is the single path in
     * this whole delivery layer that reports nothing at all, so the panel stays on
     * `commit-panel-awaiting-hydration` for the rest of the session -- however many times the
     * webview re-asks, because every re-ask is answered exactly as silently as the first.
     *
     * The visibility ownership invariant is: a recorded visible view always wins; a hidden sender
     * never displaces a recorded view; and a visible sender may replace only a recorded hidden
     * view. A different visible view recorded there is therefore the correct target, while a
     * hidden cached view cannot strand a visible pane. When replacing a defined hidden view, theme
     * listeners are disposed before they are registered again; `attachWebview` rebinds its own
     * state. Actual adoption also resets the webview-scoped `lastPostedPayload` dedupe cursor before
     * the sender becomes the owner, so its unchanged cached detail is eligible for reposting.
     *
     * This rests on VS Code not delivering messages from a webview it has already torn down. If
     * it ever did, the record would name a dead view until the next resolve, and
     * {@link showRebaseDialog} would report a dialog it could not raise. That failure is loud --
     * every post to a dead webview is reported by {@link postWebviewMessage} -- whereas the one
     * this method exists to prevent is completely silent, which is why it went undiagnosed across
     * four investigations. Trading a reported failure for an unreported one is the point.
     *
     * That "loud" only ever covered a dead view being POSTED to. Reading one is the other half,
     * and it used to be silent: the visibility checks dereference a view whose getters raise once
     * VS Code has disposed it, and this method ran ahead of its caller's `try`. See
     * {@link retainsOwnership} for how an unreadable view is kept distinct from a hidden one --
     * and note that a dead record could only ever be replaced here, since nothing else clears one
     * that {@link resolveWebviewView}'s own dispose handler did not record.
     */
    private adoptLiveSender(sender: vscode.WebviewView): void {
        const current = this.view;
        if (current !== undefined && (current === sender || retainsOwnership(current, sender))) {
            return;
        }
        if (current !== undefined) {
            this.disposeThemeChangeDisposables();
        }
        this.lastPostedPayload = undefined;
        this.view = sender;
        this.iconTheme.attachWebview(sender.webview);
        this.registerThemeChangeListeners();
    }

    /**
     * A missing view is deliberately silent -- a closed panel is an ordinary state, not a fault.
     * A message the view refuses or rejects is not; see {@link postWebviewMessage}.
     */
    private postToWebview(msg: InboundMessage | CommitGraphInbound): void {
        const view = this.view;
        if (!view) return;
        postWebviewMessage(view.webview, msg, "Commit panel");
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
        this.commitMessageGenerationCoordinator?.dropHost(this.commitMessageGenerationHost);
        this.disposeAllRuntimeWatchers();
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onDidChangeFileCount.dispose();
        this._onDidChangeWorkingTree.dispose();
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
        this._onCommitAction.dispose();
        this._onRebaseDialogSubmit.dispose();
        this._onRebaseDialogCancel.dispose();
        this._onRebaseControl.dispose();
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
