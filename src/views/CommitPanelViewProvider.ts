// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, CommitDetail, ThemeFolderIconMap, WorkingFile, StashEntry } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import type { InboundMessage } from "../webviews/protocol/commitPanelMessages";
import type {
    BranchAction,
    CommitAction,
    CommitGraphInbound,
} from "../webviews/protocol/commitGraphTypes";
import { isBranchAction, isCommitAction } from "../webviews/protocol/commitGraphTypes";
import { IconThemeService } from "./shared";
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
    shelfMutationFromPanel,
    shelveSaveFromPanel,
} from "./commitPanelActions";
import {
    deleteFileFromPanel,
    openFileFromPanel,
    publishBranchFromPanel,
    selectShelfFromPanel,
    showDiffFromPanel,
    showHistoryFromPanel,
    showShelfDiffFromPanel,
    stageFilesFromPanel,
    trackUnversionedFilesFromPanel,
    unstageFilesFromPanel,
} from "./panelFileActions";
const MIN_VISIBLE_REFRESH_MS = 600;

/**
 * Hosts the sidebar Changes webview and its embedded commit graph protocol.
 *
 * The provider owns working-tree, shelf, commit-draft, branch-filter, pagination, and commit
 * detail caches for one active repository. All webview messages pass through a validation layer
 * before reaching Git operations, VS Code commands, or path-sensitive file actions.
 */
export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";
    private static readonly COMMIT_DRAFT_KEY_PREFIX = "commitDraft:";
    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedShelfIndex: number | null = null;
    private shelfFiles: WorkingFile[] = [];
    private folderIconsByName: ThemeFolderIconMap = {};
    private lastFileCount = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    private readonly iconTheme: IconThemeService;
    // Embedded commit graph state
    private currentBranch: string | null = null;
    private currentBranchHasUpstreamCache = false;
    private hasRemotesCache = false;
    private currentBranchAheadCache = 0;
    private currentBranchBehindCache = 0;
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private requestSeq = 0;
    private dataRefreshSeq = 0;
    private readonly PAGE_SIZE = 500;
    private branches: Branch[] = [];
    private selectedCommitDetail: CommitDetail | null = null;
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
     * restoration.
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private repoRootUri?: vscode.Uri,
        private readonly workspaceState?: vscode.Memento,
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }
    /**
     * Switches the panel to a new active repository and invalidates repository-scoped caches.
     *
     * Request sequences are bumped so pending status, graph, or decoration work from the previous
     * root cannot overwrite the new repository's state. The commit draft key is repository-specific,
     * so the webview receives a fresh draft restore message after the root changes.
     */
    setRepositoryRootUri(repoRootUri: vscode.Uri): void {
        this.repoRootUri = repoRootUri;
        this.selectedShelfIndex = null;
        this.files = [];
        this.stashes = [];
        this.shelfFiles = [];
        this.currentBranch = null;
        this.currentBranchHasUpstreamCache = false;
        this.hasRemotesCache = false;
        this.currentBranchAheadCache = 0;
        this.currentBranchBehindCache = 0;
        this.filterText = "";
        this.offset = 0;
        this.loadingMore = false;
        this.selectedCommitDetail = null;
        this.commitDetailFolderIconsByName = {};
        this.branchFolderIconsByName = {};
        // Bump request sequences so in-flight async responses from the old repo are ignored.
        this.requestSeq += 1;
        this.dataRefreshSeq += 1;
        this.commitDetailSeq += 1;
        this.updateViewCount(0);
        this.postToWebview({
            type: "restoreCommitDraft",
            message: this.getStoredCommitDraft(),
        });
    }
    /**
     * Handles repository label changes without replacing the Changes count description.
     *
     * The sidebar title already identifies the view; its description is reserved for the cached
     * working-file count, so a label change replays the last count instead of showing the label.
     */
    setRepositoryLabel(_label: string): void {
        this.updateViewCount(this.lastFileCount);
    }
    /**
     * Replaces the embedded graph branch cache and posts decorated branch metadata when possible.
     */
    setBranches(branches: Branch[]): void {
        this.branches = branches;
        this.sendGraphBranches().catch((err) => {
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
    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.commitDetailFolderIconsByName = {};
        this.postToWebview({ type: "clearCommitDetail" });
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
            this.postWorkingTreeSnapshot();
            this.refreshDataWithErrorHandling(true);
        });
        this.updateViewCount(this.lastFileCount);
    }
    /**
     * Refreshes working-tree/shelf data and then reloads embedded graph state.
     */
    async refresh(): Promise<void> {
        await this.refreshData(false);
        await this.refreshGraphData();
    }
    /** Refreshes working-tree data without showing webview or context-key spinner state. */
    async refreshSilent(): Promise<void> {
        await this.refreshData(true);
    }
    /**
     * Runs a visible refresh for explicit user requests in the Changes view.
     *
     * The progress location is scoped to the view so refresh feedback appears where the user
     * initiated it instead of as a global notification.
     */
    private async refreshFromUserAction(): Promise<void> {
        await vscode.window.withProgress(
            { location: { viewId: CommitPanelViewProvider.viewType } },
            async () => {
                await this.refreshData(false);
                await this.refreshGraphData();
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
    private postWorkingTreeSnapshot(
        currentBranchHasUpstream = this.currentBranchHasUpstreamCache,
        hasRemotes = this.hasRemotesCache,
    ): void {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "update",
            files: this.files,
            stashes: this.stashes,
            selectedShelfIndex: this.selectedShelfIndex,
            shelfFiles: this.shelfFiles,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.folderIconsByName,
            iconFonts,
            currentBranchHasUpstream,
            hasRemotes,
            currentBranchAhead: this.currentBranchAheadCache,
            currentBranchBehind: this.currentBranchBehindCache,
        });
    }

    /**
     * Reloads working-tree files, shelves, selected shelf contents, and upstream state.
     *
     * Non-silent refreshes set both a webview `refreshing` message and a VS Code context key, then
     * keep the spinner visible for a short minimum duration to avoid flicker. The selected shelf is
     * preserved when it still exists, otherwise the first available shelf becomes selected.
     */
    private async refreshData(silent = false): Promise<void> {
        const refreshStartedAt = Date.now();
        const refreshRequestId = ++this.dataRefreshSeq;
        if (!silent) this.postToWebview({ type: "refreshing", active: true });
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
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateWorkingFiles(await this.gitOps.getStatus());
            const stashes = await this.gitOps.listShelved();
            const currentBranchStatus = await this.currentBranchStatus();
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            const hasSelected =
                this.selectedShelfIndex !== null &&
                stashes.some((entry) => entry.index === this.selectedShelfIndex);
            let selectedShelfIndex: number | null;
            if (hasSelected) {
                selectedShelfIndex = this.selectedShelfIndex;
            } else {
                selectedShelfIndex = stashes.length > 0 ? stashes[0].index : null;
            }
            const shelfFiles =
                selectedShelfIndex !== null
                    ? await this.iconTheme.decorateWorkingFiles(
                          await this.gitOps.getShelvedFiles(selectedShelfIndex),
                      )
                    : [];
            const folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                ...files,
                ...shelfFiles,
            ]);
            if (refreshRequestId !== this.dataRefreshSeq) return;
            this.folderIconsByName = folderIconsByName;
            this.files = files;
            this.stashes = stashes;
            this.selectedShelfIndex = selectedShelfIndex;
            this.shelfFiles = shelfFiles;
            this.currentBranchHasUpstreamCache = currentBranchStatus.hasUpstream;
            this.hasRemotesCache = currentBranchStatus.hasRemotes;
            this.currentBranchAheadCache = currentBranchStatus.ahead;
            this.currentBranchBehindCache = currentBranchStatus.behind;
            const uniquePaths = new Set(files.map((f) => f.path));
            const count = uniquePaths.size;
            this._onDidChangeFileCount.fire(count);
            this.updateViewCount(count);
            this.postToWebview({
                type: "update",
                files,
                stashes,
                shelfFiles,
                selectedShelfIndex,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.folderIconsByName,
                iconFonts,
                currentBranchHasUpstream: currentBranchStatus.hasUpstream,
                hasRemotes: currentBranchStatus.hasRemotes,
                currentBranchAhead: currentBranchStatus.ahead,
                currentBranchBehind: currentBranchStatus.behind,
            });
        } finally {
            if (!silent) {
                const remainingMs = MIN_VISIBLE_REFRESH_MS - (Date.now() - refreshStartedAt);
                if (remainingMs > 0) {
                    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
                }
                this.postToWebview({ type: "refreshing", active: false });
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
    private async refreshGraphData(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendGraphBranches();
        await this.loadInitialGraphCommits();
        this.postGraphCommitDetailState();
    }
    /**
     * Sends embedded graph branch data with folder icons derived from branch path segments.
     */
    private async sendGraphBranches(): Promise<void> {
        this.branchFolderIconsByName = await this.iconTheme.getFolderIconsByBranches(this.branches);
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setBranches",
            branches: this.branches,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.branchFolderIconsByName,
            iconFonts,
        });
    }
    /**
     * Loads the first embedded graph page and drops responses superseded by newer requests.
     *
     * If the active branch filter disappears from the cached branch list, the selection is cleared
     * before loading so the webview and Git query stay in sync.
     */
    private async loadInitialGraphCommits(): Promise<void> {
        const requestId = ++this.requestSeq;
        this.offset = 0;
        this.loadingMore = false;
        if (this.currentBranch && !this.branches.some((b) => b.name === this.currentBranch)) {
            this.currentBranch = null;
            this.postToWebview({ type: "setSelectedBranch", branch: null });
        }
        try {
            const [commits, unpushedHashes] = await Promise.all([
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    0,
                ),
                this.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            this.offset = commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: false,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(vscode.l10n.t("Git log error: {message}", { message }));
            this.postToWebview({ type: "loadError", message });
        }
    }
    /**
     * Appends embedded graph commits while coalescing duplicate pagination requests.
     */
    private async loadMoreGraphCommits(): Promise<void> {
        if (this.loadingMore) return;
        this.loadingMore = true;
        const requestId = ++this.requestSeq;
        try {
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
    private async filterGraphByText(text: string): Promise<void> {
        this.filterText = text;
        await this.loadInitialGraphCommits();
    }
    /**
     * Validates and dispatches every message accepted by the Changes webview.
     *
     * Accepted messages cover graph readiness/pagination/filtering, branch and commit actions,
     * commit-file diffs, draft persistence, staging, committing, rollback, shelf mutations, and
     * file actions. Paths and commit hashes are validated before Git or VS Code APIs are called;
     * unrecognized message types are ignored by the switch exhaustively falling through.
     */
    private async handleMessage(raw: unknown): Promise<void> {
        const msg = assertMessage(raw);
        const actionDeps = {
            gitOps: this.gitOps,
            refreshData: () => this.refreshData(),
            refreshGraphData: () => this.refreshGraphData(),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
            postCommitted: () => this.postToWebview({ type: "committed" }),
            maybeOfferPublishBranch: () => this.maybeOfferPublishBranch(),
        };
        const fileActionDeps = {
            gitOps: this.gitOps,
            getWorkspaceRoot: () => this.getWorkspaceRoot(),
            refreshData: (silent = false) => this.refreshData(silent),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
        };
        switch (msg.type) {
            case "ready":
                this.postWorkingTreeSnapshot();
                await this.refreshSilent();
                await this.refreshGraphData();
                this.postToWebview({
                    type: "restoreCommitDraft",
                    message: this.getStoredCommitDraft(),
                });
                break;
            case "refresh":
                await this.refreshFromUserAction();
                break;
            case "fetch":
                await runGitOperationFromPanel(actionDeps, "fetch");
                break;
            case "pull":
                await runGitOperationFromPanel(actionDeps, "pull");
                break;
            case "push":
                await runGitOperationFromPanel(actionDeps, "push");
                break;
            case "sync":
                await runGitOperationFromPanel(actionDeps, "sync");
                break;
            case "selectCommit":
                this._onCommitSelected.fire(assertGitHash(msg.hash, "hash"));
                break;
            case "loadMore":
                await this.loadMoreGraphCommits();
                break;
            case "filterText":
                await this.filterGraphByText(assertString(msg.text, "text"));
                break;
            case "filterBranch":
                this.currentBranch = assertNullableString(msg.branch, "branch");
                this.filterText = "";
                this._onBranchFilterChanged.fire(this.currentBranch);
                this.postToWebview({
                    type: "setSelectedBranch",
                    branch: this.currentBranch,
                });
                await this.loadInitialGraphCommits();
                break;
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
                const message = assertString(msg.message, "message");
                await this.workspaceState?.update(
                    this.getCommitDraftStorageKey(),
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
            case "trackUnversionedFiles":
                await trackUnversionedFilesFromPanel(fileActionDeps, msg.paths);
                break;
            case "commitSelected": {
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
                await commitOnlyFromPanel(actionDeps, message, msg.amend === true);
                break;
            }
            case "commitAndPush": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                await commitAndPushFromPanel(actionDeps, message, msg.amend === true);
                break;
            }
            case "getLastCommitMessage": {
                const lastMsg = await this.gitOps.getLastCommitMessage();
                this.postToWebview({ type: "lastCommitMessage", message: lastMsg });
                break;
            }
            case "getAmendBranchCommits": {
                const commits = await this.gitOps.getAmendBranchCommits();
                this.postToWebview({ type: "amendBranchCommits", commits });
                break;
            }
            case "rollback": {
                await rollbackFromPanel(actionDeps, assertRepoPathArray(msg.paths, "paths"));
                break;
            }
            case "showDiff":
                await showDiffFromPanel(fileActionDeps, msg.path);
                break;
            case "shelveSave": {
                await shelveSaveFromPanel(actionDeps, {
                    name: typeof msg.name === "string" ? msg.name : "Shelved changes",
                    paths:
                        msg.paths !== undefined
                            ? assertRepoPathArray(msg.paths, "paths")
                            : undefined,
                });
                break;
            }
            case "shelfPop":
                await shelfMutationFromPanel(actionDeps, "pop", assertNumber(msg.index, "index"));
                break;
            case "shelfApply":
                await shelfMutationFromPanel(actionDeps, "apply", assertNumber(msg.index, "index"));
                break;
            case "shelfDelete":
                await shelfMutationFromPanel(
                    actionDeps,
                    "delete",
                    assertNumber(msg.index, "index"),
                );
                break;
            case "shelfSelect":
                await selectShelfFromPanel(
                    {
                        ...fileActionDeps,
                        iconTheme: this.iconTheme,
                        getFiles: () => this.files,
                        getStashes: () => this.stashes,
                        currentBranchHasUpstream: async () =>
                            (await this.currentBranchStatus()).hasUpstream,
                        setShelfState: (state) => {
                            this.selectedShelfIndex = state.selectedShelfIndex;
                            this.shelfFiles = state.shelfFiles;
                            this.folderIconsByName = state.folderIconsByName;
                        },
                        postUpdate: (message) => this.postToWebview(message),
                    },
                    msg.index,
                );
                break;
            case "publishBranch":
                await publishBranchFromPanel(fileActionDeps);
                break;
            case "showShelfDiff":
                await showShelfDiffFromPanel(fileActionDeps, msg.index, msg.path);
                break;
            case "openFile":
                await openFileFromPanel(fileActionDeps, msg.path);
                break;
            case "deleteFile":
                await deleteFileFromPanel(fileActionDeps, msg.path);
                break;
            case "showHistory":
                await showHistoryFromPanel(fileActionDeps, msg.path);
                break;
        }
    }
    /**
     * Updates the cached file count and sidebar description for the active Changes view.
     */
    private updateViewCount(count: number): void {
        this.lastFileCount = count;
        if (!this.view) return;
        this.view.description = count > 0 ? String(count) : "";
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
        this.postToWebview({ type: "clearCommitDetail" });
    }
    /**
     * Decorates commit detail file rows and stores them only if the request is still current.
     */
    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId !== this.commitDetailSeq) return;
        this.selectedCommitDetail = decorated.detail;
        this.commitDetailFolderIconsByName = decorated.folderIconsByName;
        this.postGraphCommitDetailState();
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
    private getWorkspaceRoot(): vscode.Uri {
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
    private getCommitDraftStorageKey(): string {
        const storageRoot =
            this.repoRootUri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!storageRoot) {
            throw new Error("No workspace folder is open.");
        }
        return `${CommitPanelViewProvider.COMMIT_DRAFT_KEY_PREFIX}${storageRoot}`;
    }
    /**
     * Reads the persisted commit draft for the active repository, defaulting to an empty input.
     */
    private getStoredCommitDraft(): string {
        return this.workspaceState?.get<string>(this.getCommitDraftStorageKey()) ?? "";
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
    private async maybeOfferPublishBranch(): Promise<void> {
        try {
            const hasCommits = await this.gitOps.hasAnyCommits();
            if (!hasCommits) return;
            const branches = await this.gitOps.getBranches();
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
                await vscode.commands.executeCommand("intelligit.publishBranch");
            }
        } catch {
            // Silently ignore — publish is optional, don't block the user
        }
    }
    /**
     * Reads current-branch upstream, ahead/behind, and remote availability for toolbar state.
     */
    private async currentBranchStatus(): Promise<{
        hasUpstream: boolean;
        hasRemotes: boolean;
        ahead: number;
        behind: number;
    }> {
        const [branches, remotes] = await Promise.all([
            this.gitOps.getBranches(),
            this.gitOps.getRemotes(),
        ]);
        const currentBranch = branches.find((branch) => branch.isCurrent);
        return {
            hasUpstream: currentBranch?.upstream !== undefined && currentBranch.upstream.length > 0,
            hasRemotes: remotes.length > 0,
            ahead: currentBranch?.ahead ?? 0,
            behind: currentBranch?.behind ?? 0,
        };
    }
    /**
     * Runs a panel data refresh from listeners without leaking rejected promises into VS Code.
     */
    private refreshDataWithErrorHandling(silent = false): void {
        this.refreshData(silent).catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(message);
            this.postToWebview({ type: "error", message });
        });
    }
    private registerThemeChangeListeners(): void {
        this.themeChangeDisposables.push(
            ...registerThemeChangeListeners(() => this.refreshDataWithErrorHandling()),
        );
    }
    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }
}
