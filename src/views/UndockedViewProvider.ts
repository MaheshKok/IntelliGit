// Manages a vscode.WebviewPanel (editor tab) that combines the commit graph
// and commit panel into a single unified view. Used when the user enables
// intelligit.undockableWindow to allow dragging to a second monitor.
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { IconThemeService } from "./shared/IconThemeService";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import { buildWebviewShellHtml } from "./webviewHtml";
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
import type { UnifiedOutbound, UnifiedInbound } from "../webviews/protocol/undockedMessages";
import {
    CommitChecksCoordinator,
    DEFAULT_COMMIT_CHECKS_TTL_MS,
} from "../services/commitChecks/coordinator";
import type { CommitChecksSettings } from "../services/commitChecks/settingsConfig";
import { GitHubProvider } from "../services/commitChecks/githubProvider";
import { GitLabProvider } from "../services/commitChecks/gitlabProvider";
import { BitbucketCloudProvider } from "../services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../services/commitChecks/bitbucketServerProvider";
import { httpGetJson } from "../services/commitChecks/http";
import type { CredentialStore } from "../services/commitChecks/credentialStore";
import type { HostMap } from "../services/commitChecks/types";
import {
    assertGitHash,
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
    unstageFilesFromPanel,
} from "./panelFileActions";
interface PersistedColumnWidths {
    branchWidth: number;
    graphWidth: number;
    infoWidth: number;
    commitPanelWidth: number;
}

/**
 * Reads persisted undocked column widths while tolerating older payload shapes.
 *
 * Older workspaces may not contain `graphWidth`; in that case the previous `infoWidth` value is
 * used as a compatible fallback. Non-finite or incomplete payloads are rejected so stale memento
 * data cannot push invalid layout sizes into the webview.
 */
function migratePersistedColumnWidths(value: unknown): PersistedColumnWidths | undefined {
    if (!value || typeof value !== "object") return undefined;
    const saved = value as Record<string, unknown>;
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
 * including pagination, branch filters, commit details, shelves, drafts, and persisted column
 * widths. Webview messages are validated before Git operations or file actions run, and all
 * script/resources are loaded from the extension `dist` directory.
 */
export class UndockedViewProvider {
    public static readonly viewType = "intelligit.undocked";
    private panel?: vscode.WebviewPanel;
    private readonly gitOps: GitOps;
    private readonly iconTheme: IconThemeService;
    private repoRootUri: vscode.Uri;
    private repositoryLabel = "";
    // Graph-side state
    private currentBranch: string | null = null;
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private requestSeq = 0;
    private readonly PAGE_SIZE = 500;
    private branches: Branch[] = [];
    private worktrees: GitWorktree[] = [];
    private selectedCommitDetail: CommitDetail | null = null;
    private readonly commitChecks: CommitChecksCoordinator;
    private folderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    // Commit-panel state
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedShelfIndex: number | null = null;
    private shelfFiles: WorkingFile[] = [];
    private lastFileCount = 0;
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
    ) {
        this.gitOps = gitOps;
        this.repoRootUri = repoRootUri;
        this.iconTheme = new IconThemeService(this.extensionUri);
        this.commitChecks = new CommitChecksCoordinator(
            this.gitOps,
            [
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
     * Switches the undocked panel to a new active repository and clears repository-scoped caches.
     *
     * The panel keeps its VS Code window alive, but graph, working-tree, shelf, and detail caches
     * are reset so subsequent refreshes cannot display rows from the previous repository.
     */
    setRepositoryRootUri(repoRootUri: vscode.Uri): void {
        this.repoRootUri = repoRootUri;
        this.files = [];
        this.stashes = [];
        this.selectedShelfIndex = null;
        this.shelfFiles = [];
        this.branches = [];
        this.worktrees = [];
        this.currentBranch = null;
        this.lastFileCount = 0;
        this.selectedCommitDetail = null;
        this.folderIconsByName = {};
        this.branchFolderIconsByName = {};
        this.commitChecks.clear();
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
    /**
     * Caches the selected commit detail and decorates it with icon metadata asynchronously.
     *
     * A sequence token prevents slower decoration work from overwriting a newer selected commit or
     * a clear operation.
     */
    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
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
    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.folderIconsByName = {};
        this.postToWebview({ type: "clearCommitDetail" });
    }
    /**
     * Refreshes graph branches/commits and commit-panel data for the current repository.
     */
    async refresh(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        await this.loadInitial();
        await this.refreshCommitPanelData(false);
    }

    /** Refreshes graph and commit-panel data without showing commit-panel refresh feedback. */
    async refreshSilent(): Promise<void> {
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
     * state retained by VS Code is preserved.
     */
    open(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
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
    }
    /**
     * Disposes the undocked panel, theme listeners, icon resolver, and all host event emitters.
     */
    dispose(): void {
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
     * overwritten by default webview measurements. Path arrays, shelf indexes, commit hashes, and
     * branch action names are validated before any Git or VS Code command boundary is crossed.
     */
    private async handleMessage(msg: UnifiedOutbound): Promise<void> {
        const actionDeps = {
            gitOps: this.gitOps,
            refreshData: () => this.refreshCommitPanelData(),
            refreshGraphData: async () => {
                await this.sendBranches();
                await this.loadInitial();
                this.postCommitDetailState();
            },
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
            postCommitted: () => this.postToWebview({ type: "committed" }),
            maybeOfferPublishBranch: () => Promise.resolve(),
        };
        const fileActionDeps = {
            gitOps: this.gitOps,
            getWorkspaceRoot: () => this.repoRootUri,
            refreshData: () => this.refreshCommitPanelData(),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
        };
        switch (msg.type) {
            // Graph-side
            case "ready":
                // Restore column widths first, before the slow git operations
                // below, so the webview applies saved widths immediately and
                // never overwrites them with its pre-restore equal widths.
                this.sendPersistedColumnWidths();
                this.sendSettings();
                await this.iconTheme.initIconThemeData();
                await this.sendBranches();
                await this.loadInitial();
                this.postCommitDetailState();
                await this.refreshCommitPanelData();
                this.postToWebview({
                    type: "restoreCommitDraft",
                    message: this.getStoredCommitDraft(),
                });
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
            case "requestCommitChecks":
                await this.sendCommitChecks(assertGitHash(msg.hash, "hash"));
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
            case "shelfSelect": {
                await selectShelfFromPanel(
                    {
                        ...fileActionDeps,
                        iconTheme: this.iconTheme,
                        getFiles: () => this.files,
                        getStashes: () => this.stashes,
                        currentBranchHasUpstream: () => this.currentBranchHasUpstream(),
                        setShelfState: (state) => {
                            this.selectedShelfIndex = state.selectedShelfIndex;
                            this.shelfFiles = state.shelfFiles;
                        },
                        postUpdate: (message) => this.postToWebview(message),
                    },
                    msg.index,
                );
                break;
            }
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
    // --- Graph data fetching ------------------------------------------------
    /**
     * Loads the first graph page and ignores stale results from superseded requests.
     */
    private async loadInitial(): Promise<void> {
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
            if (requestId === this.requestSeq) {
                this.offset = commits.length;
                this.postToWebview({
                    type: "loadCommits",
                    commits,
                    hasMore: commits.length >= this.PAGE_SIZE,
                    append: false,
                    unpushedHashes,
                });
            }
        } catch (err) {
            if (requestId === this.requestSeq) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Git log error: {message}", { message }),
                );
                this.postToWebview({ type: "loadError", message });
            }
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
            const [commits, unpushedHashes] = await Promise.all([
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    this.offset,
                ),
                this.gitOps.getUnpushedCommitHashes(),
            ]);
            if (requestId === this.requestSeq) {
                this.offset += commits.length;
                this.postToWebview({
                    type: "loadCommits",
                    commits,
                    hasMore: commits.length >= this.PAGE_SIZE,
                    append: true,
                    unpushedHashes,
                });
            }
        } catch (err) {
            if (requestId === this.requestSeq) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(
                    vscode.l10n.t("Git log error: {message}", { message }),
                );
                this.postToWebview({ type: "loadError", message });
            }
        } finally {
            if (requestId === this.requestSeq) {
                this.loadingMore = false;
            }
        }
    }
    private async filterByText(text: string): Promise<void> {
        this.filterText = text;
        await this.loadInitial();
    }

    private async sendCommitChecks(hash: string): Promise<void> {
        const snapshot = await this.commitChecks.getChecks(hash);
        this.postToWebview({ type: "setCommitChecks", snapshot });
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
     * Reloads working-tree files, shelves, selected shelf contents, and upstream status.
     *
     * The selected shelf is preserved when still present; otherwise the first shelf is selected.
     * Non-silent calls emit `refreshing` messages so the undocked UI can show action feedback.
     */
    private async refreshCommitPanelData(silent = false): Promise<void> {
        if (!silent) this.postToWebview({ type: "refreshing", active: true });
        try {
            const [status, stashes, currentBranchStatus] = await Promise.all([
                this.gitOps.getStatus(),
                this.gitOps.listShelved(),
                this.currentBranchStatus(),
                this.iconTheme.initIconThemeData(),
            ]);
            const files = await this.iconTheme.decorateWorkingFiles(status);
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            const hasSelected =
                this.selectedShelfIndex !== null &&
                stashes.some((entry) => entry.index === this.selectedShelfIndex);
            const selectedShelfIndex = hasSelected
                ? this.selectedShelfIndex
                : stashes.length > 0
                  ? stashes[0].index
                  : null;
            const shelfFiles =
                selectedShelfIndex !== null
                    ? await this.iconTheme.decorateWorkingFiles(
                          await this.gitOps.getShelvedFiles(selectedShelfIndex),
                      )
                    : [];
            const cpFolderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                ...files,
                ...shelfFiles,
            ]);
            this.files = files;
            this.stashes = stashes;
            this.selectedShelfIndex = selectedShelfIndex;
            this.shelfFiles = shelfFiles;
            const uniquePaths = new Set(files.map((f) => f.path));
            const count = uniquePaths.size;
            this._onDidChangeFileCount.fire(count);
            this.lastFileCount = count;
            this.postToWebview({
                type: "update",
                files,
                stashes,
                shelfFiles,
                selectedShelfIndex,
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
            });
        } finally {
            if (!silent) this.postToWebview({ type: "refreshing", active: false });
        }
    }
    // --- Branch sending -----------------------------------------------------
    /**
     * Sends cached branches with folder icons derived from branch path segments.
     */
    private async sendBranches(): Promise<void> {
        this.branchFolderIconsByName = await this.iconTheme.getFolderIconsByBranches(this.branches);
        const currentBranchStatus = await this.currentBranchStatus();
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setBranches",
            branches: this.branches,
            worktrees: this.worktrees,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.branchFolderIconsByName,
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

    private async currentBranchStatus(): Promise<{
        hasUpstream: boolean;
        hasRemotes: boolean;
        ahead: number;
        behind: number;
        name: string | null;
        upstream: string | null;
    }> {
        const [branches, remotes] = await Promise.all([
            this.gitOps.getBranches(),
            this.gitOps.getRemotes(),
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

    private async currentBranchHasUpstream(): Promise<boolean> {
        const branches = await this.gitOps.getBranches();
        const currentBranch = branches.find((branch) => branch.isCurrent);
        return currentBranch?.upstream !== undefined && currentBranch.upstream.length > 0;
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
        this.postToWebview({ type: "clearCommitDetail" });
    }
    /**
     * Decorates commit detail rows and stores them only if the request is still current.
     */
    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        if (requestId !== this.commitDetailSeq) return;
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId === this.commitDetailSeq) {
            this.selectedCommitDetail = decorated.detail;
            this.folderIconsByName = decorated.folderIconsByName;
            this.postCommitDetailState();
        }
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
    private getCommitDraftStorageKey(): string {
        return `${UndockedViewProvider.COMMIT_DRAFT_KEY_PREFIX}${this.repoRootUri.fsPath}`;
    }
    private getStoredCommitDraft(): string {
        return this.workspaceState?.get<string>(this.getCommitDraftStorageKey()) ?? "";
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
            Number.isFinite(saved.branchWidth) &&
            Number.isFinite(saved.graphWidth) &&
            Number.isFinite(saved.infoWidth) &&
            Number.isFinite(saved.commitPanelWidth)
        ) {
            this.postToWebview({
                type: "columnWidths",
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
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        const selectedCommitDetail = this.selectedCommitDetail;
        if (selectedCommitDetail) {
            const requestId = ++this.commitDetailSeq;
            await this.decorateAndStoreCommitDetail(selectedCommitDetail, requestId);
        } else {
            this.postCommitDetailState();
        }
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
