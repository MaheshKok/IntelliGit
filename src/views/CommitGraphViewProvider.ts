// WebviewViewProvider for the bottom panel commit graph.
// Loads the CommitGraphApp React app, handles pagination, branch filtering,
// and posts selected commit hashes back to the extension host.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, CommitDetail, GitWorktree, ThemeFolderIconMap } from "../types";
import type {
    BranchAction,
    CommitAction,
    CommitGraphOutbound,
    CommitGraphInbound,
    WorktreeAction,
} from "../webviews/protocol/commitGraphTypes";
import {
    isBranchAction,
    isCommitAction,
    isWorktreeAction,
} from "../webviews/protocol/commitGraphTypes";
import { getErrorMessage } from "../utils/errors";
import { IconThemeService } from "./shared/IconThemeService";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import { buildWebviewShellHtml } from "./webviewHtml";
import { assertRepoRelativePath } from "../utils/fileOps";
import { assertValidBranchName } from "../utils/gitRefs";
import { isValidGitHash } from "../services/gitHelpers";
import {
    CommitChecksCoordinator,
    DEFAULT_COMMIT_CHECKS_TTL_MS,
} from "../services/commitChecks/coordinator";
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
import { runGitOperationFromPanel, type CommitPanelGitOperation } from "./commitPanelActions";

/**
 * Hosts the commit graph webview used by the bottom panel and sidebar graph views.
 *
 * The provider owns graph pagination, branch/text filters, branch icon decoration,
 * and the currently selected commit detail snapshot. Messages from the webview are
 * treated as untrusted: branch and commit actions are checked against protocol
 * allow-lists, commit hashes are validated before firing extension events, and
 * repository-relative file paths are validated before diff commands can consume them.
 */
export class CommitGraphViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitGraph";
    public static readonly sidebarViewType = "intelligit.sidebarGraph";

    private view?: vscode.WebviewView;
    private currentBranch: string | null = null;
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private requestSeq = 0;
    private readonly PAGE_SIZE = 500;

    private branches: Branch[] = [];
    private worktrees: GitWorktree[] = [];
    private selectedCommitDetail: CommitDetail | null = null;
    private commitDetailLoading = false;
    private readonly commitChecks: CommitChecksCoordinator;
    private folderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    private repositoryLabel: string | null = null;
    private readonly iconTheme: IconThemeService;
    private readonly _onCommitSelected = new vscode.EventEmitter<string>();
    readonly onCommitSelected = this._onCommitSelected.event;

    private readonly _onBranchFilterChanged = new vscode.EventEmitter<string | null>();
    readonly onBranchFilterChanged = this._onBranchFilterChanged.event;

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

    /**
     * Creates the graph provider for one active repository view contribution.
     *
     * The optional bundle/title settings let the sidebar and bottom-panel registrations share the
     * same protocol code while still owning separate VS Code view instances and icon-theme caches.
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        credentialStore: CredentialStore,
        private readonly options: {
            scriptFile?: string;
            title?: string;
            showRepositoryLabel?: boolean;
            hostMap?: HostMap;
            settings?: CommitChecksSettings;
            commitChecksService?: CommitChecksService;
            commitChecksProviders?: readonly CommitChecksProvider[];
        } = {},
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
        const settings = options.settings;
        this.commitChecks = new CommitChecksCoordinator(
            this.gitOps,
            options.commitChecksProviders ?? [
                new GitHubProvider(httpGetJson, settings?.ciCdPattern),
                new GitLabProvider(httpGetJson, credentialStore, settings?.ciCdPattern),
                new BitbucketCloudProvider(httpGetJson, credentialStore),
                new BitbucketServerProvider(httpGetJson, credentialStore),
            ],
            options.hostMap ?? {},
            {
                enabled: settings?.enabled,
                providerEnabled: settings?.providers,
                ttlMs: DEFAULT_COMMIT_CHECKS_TTL_MS,
                service: options.commitChecksService,
                settingsFingerprint: commitChecksSettingsFingerprint(settings),
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
     * Stores the active repository label for compact multi-repository graph chrome.
     */
    setRepositoryLabel(label: string): void {
        this.repositoryLabel = label.trim() || null;
        this.applyRepositoryDescription();
    }

    /**
     * Toggles whether the compact graph view should show the active repository label.
     */
    setShowRepositoryLabel(showRepositoryLabel: boolean): void {
        this.options.showRepositoryLabel = showRepositoryLabel;
        this.applyRepositoryDescription();
    }

    /**
     * Attaches a freshly resolved VS Code webview view to the commit graph protocol.
     *
     * Each resolution replaces the previous webview, re-registers theme listeners,
     * limits local resources to the bundled `dist` directory, and installs the
     * message bridge. The webview may send readiness, pagination, filtering,
     * branch/commit action, and commit-file diff requests; invalid payloads are
     * surfaced to the user and echoed back as webview errors.
     */
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.disposeThemeChangeDisposables();
        this.iconTheme.dispose();
        this.view = webviewView;
        this.applyRepositoryDescription();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);
        this.registerThemeChangeListeners();

        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
                this.iconTheme.dispose();
                this.disposeThemeChangeDisposables();
            }
        });

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg: CommitGraphOutbound) => {
            try {
                switch (msg.type) {
                    case "ready":
                        await this.iconTheme.initIconThemeData();
                        await this.sendBranches();
                        await this.loadInitial();
                        this.postCommitDetailState();
                        break;
                    case "selectCommit":
                        this._onCommitSelected.fire(this.assertGitHash(msg.hash, "hash"));
                        break;
                    case "loadMore":
                        await this.loadMore();
                        break;
                    case "filterText":
                        await this.filterByText(this.assertString(msg.text, "text"));
                        break;
                    case "filterBranch":
                        this.currentBranch = this.assertNullableString(msg.branch, "branch");
                        this.filterText = "";
                        this._onBranchFilterChanged.fire(this.currentBranch);
                        this.postToWebview({
                            type: "setSelectedBranch",
                            branch: this.currentBranch,
                        });
                        this.postToWebview({ type: "setFilterText", text: "" });
                        await this.loadInitial();
                        break;
                    case "branchAction":
                        if (!isBranchAction(this.assertString(msg.action, "action"))) {
                            throw new Error("Invalid branch action received from webview.");
                        }
                        this._onBranchAction.fire({
                            action: msg.action,
                            branchName: this.assertString(msg.branchName, "branchName"),
                        });
                        break;
                    case "deleteBranches":
                        this._onDeleteBranches.fire(this.assertBranchSelection(msg));
                        break;
                    case "worktreeAction":
                        if (!isWorktreeAction(this.assertString(msg.action, "action"))) {
                            throw new Error("Invalid worktree action received from webview.");
                        }
                        this._onWorktreeAction.fire({
                            action: msg.action,
                            path: this.assertString(msg.path, "path"),
                        });
                        break;
                    case "commitAction":
                        if (!isCommitAction(this.assertString(msg.action, "action"))) {
                            throw new Error("Invalid commit action received from webview.");
                        }
                        this._onCommitAction.fire({
                            action: msg.action,
                            hash: this.assertGitHash(msg.hash, "hash"),
                        });
                        break;
                    case "openCommitFileDiff":
                        this._onOpenCommitFileDiff.fire({
                            commitHash: this.assertGitHash(msg.commitHash, "commitHash"),
                            filePath: assertRepoRelativePath(
                                this.assertString(msg.filePath, "filePath"),
                            ),
                        });
                        break;
                    case "requestCommitChecks":
                        await this.sendCommitChecksRequest(msg);
                        break;
                    case "openCommitCheckUrl":
                        await this.openExternalHttpUrl(this.assertString(msg.url, "url"));
                        break;
                    case "signInForCommitChecks":
                        await vscode.commands.executeCommand(
                            "intelligit.commitChecks.signIn",
                            this.assertString(msg.host, "host"),
                        );
                        break;
                    case "fetch":
                    case "pull":
                    case "push":
                    case "sync":
                        await this.runGitOperation(msg.type);
                        break;
                }
            } catch (err) {
                const message = getErrorMessage(err);
                const label =
                    msg.type === "branchAction" ||
                    msg.type === "deleteBranches" ||
                    msg.type === "worktreeAction"
                        ? "Branch action error: {message}"
                        : "Commit graph error: {message}";
                vscode.window.showErrorMessage(vscode.l10n.t(label, { message }));
                this.postToWebview({ type: "error", message });
            }
        });
    }

    /**
     * Replaces the cached branch list and sends decorated branch metadata if a view is alive.
     *
     * Folder-icon lookup is asynchronous and can fail independently of branch discovery, so
     * failures are reported without mutating the already cached branch array.
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
     * Applies a host-driven branch filter and resets text search before reloading page one.
     *
     * This mirrors webview-originated branch filtering so external branch-tree selections and
     * in-graph selections share the same selected-branch state.
     */
    async filterByBranch(branch: string | null): Promise<void> {
        this.currentBranch = branch;
        this.filterText = "";
        this.postToWebview({ type: "setSelectedBranch", branch });
        this.postToWebview({ type: "setFilterText", text: "" });
        await this.loadInitial();
    }

    /**
     * Clears repository-scoped filters before a different repository root is loaded.
     */
    resetFilters(): void {
        this.currentBranch = null;
        this.filterText = "";
        this.commitChecks.clearProviderResolution();
        this.postToWebview({ type: "setSelectedBranch", branch: null });
        this.postToWebview({ type: "setFilterText", text: "" });
    }

    /**
     * Refreshes theme, branch, and first-page commit data for the currently selected filters.
     *
     * The selected commit detail remains cached separately; graph refreshes intentionally avoid
     * clearing it so detail panels can survive branch or working-tree updates until the host
     * publishes a new selection.
     */
    async refresh(): Promise<void> {
        // Theme data must be current before branch/log payloads are decorated.
        // react-doctor-disable-next-line react-doctor/async-parallel
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        await this.loadInitial();
    }

    /**
     * Caches and posts a selected commit detail, then decorates it with folder icon metadata.
     *
     * The undecorated detail is sent immediately for responsiveness. A sequence token prevents
     * slower icon decoration from overwriting a newer commit selection or a cleared detail state.
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
     * Clears the selected commit detail and invalidates any in-flight decoration request.
     */
    clearCommitDetail(options?: { loading?: boolean }): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.commitDetailLoading = options?.loading ?? false;
        this.folderIconsByName = {};
        this.postCommitDetailState();
    }

    /**
     * Sends cached branches with folder icon data derived from branch path segments.
     *
     * Theme data is read from the attached {@link IconThemeService}; callers should initialize
     * or refresh the service first when responding to webview readiness or theme changes.
     */
    private async sendBranches(): Promise<void> {
        this.branchFolderIconsByName = await this.iconTheme.getFolderIconsByBranches(this.branches);
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setBranches",
            branches: this.branches,
            worktrees: this.worktrees,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.branchFolderIconsByName,
            iconFonts,
            commitChecksEnabled: this.options.settings?.enabled ?? true,
        });
    }

    private async runGitOperation(operation: CommitPanelGitOperation): Promise<void> {
        await runGitOperationFromPanel(
            {
                gitOps: this.gitOps,
                refreshData: () => this.refresh(),
                fireWorkingTreeChanged: () => undefined,
            },
            operation,
        );
    }

    /**
     * Loads the first commit page for the active filters and drops stale async results.
     *
     * Branch filters are cleared when the cached branch list no longer contains the selected
     * branch. `requestSeq` coalesces overlapping filter, refresh, and pagination operations so
     * only the latest Git log response can update the offset or webview state.
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
     * Appends the next commit page unless a pagination request is already running.
     *
     * The loading guard prevents duplicate webview `loadMore` messages from racing the same
     * offset, while `requestSeq` still discards results that lose to a full reload or filter
     * change before they complete.
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

    /**
     * Stores the current text filter and reloads the graph from the first page.
     */
    private async filterByText(text: string): Promise<void> {
        this.filterText = text;
        await this.loadInitial();
    }

    private postToWebview(msg: CommitGraphInbound): void {
        this.view?.webview.postMessage(msg);
    }

    private async sendCommitChecks(hash: string): Promise<void> {
        const snapshot = await this.commitChecks.getChecks(hash);
        this.postToWebview({ type: "setCommitChecks", snapshot });
    }

    private async sendCommitChecksRequest(
        msg: Extract<CommitGraphOutbound, { type: "requestCommitChecks" }>,
    ): Promise<void> {
        const hashes = this.assertCommitCheckHashes(msg);
        await Promise.all(hashes.map((hash) => this.sendCommitChecks(hash)));
    }

    private assertCommitCheckHashes(
        msg: Extract<CommitGraphOutbound, { type: "requestCommitChecks" }>,
    ): string[] {
        if (Array.isArray(msg.hashes)) {
            if (msg.hashes.length === 0) throw new Error("No commit hashes received.");
            return msg.hashes.map((hash, index) => this.assertGitHash(hash, `hashes[${index}]`));
        }
        return [this.assertGitHash(msg.hash, "hash")];
    }

    private async openExternalHttpUrl(rawUrl: string): Promise<void> {
        const uri = vscode.Uri.parse(rawUrl);
        if (uri.scheme !== "https" && uri.scheme !== "http") {
            throw new Error("Unsupported commit check URL.");
        }
        await vscode.env.openExternal(uri);
    }

    /**
     * Validates branch selections received from bulk webview actions before command dispatch.
     *
     * Names are resolved through the latest host-owned branch snapshot so webviews cannot
     * forge remote metadata or smuggle path traversal/options into repository commands.
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
        const name = this.assertString((value as { name?: unknown }).name, `${field}.name`);
        assertValidBranchName(name);
        return name;
    }

    private assertBranchNames(value: unknown, field: string): string[] {
        if (!Array.isArray(value)) {
            throw new Error(`Expected string array for '${field}'.`);
        }
        const names = value.map((item, index) => this.assertString(item, `${field}[${index}]`));
        if (names.length === 0) {
            throw new Error(`Expected at least one branch name for '${field}'.`);
        }
        for (const name of names) {
            assertValidBranchName(name);
        }
        return names;
    }

    /**
     * Validates a scalar webview field before it is used by Git or VS Code commands.
     */
    private assertString(value: unknown, field: string): string {
        if (typeof value !== "string") {
            throw new Error(`Expected string for '${field}', got ${typeof value}`);
        }
        return value;
    }

    private assertNullableString(value: unknown, field: string): string | null {
        if (value === null) return null;
        return this.assertString(value, field);
    }

    /**
     * Normalizes and validates a webview-provided commit hash before firing host events.
     */
    private assertGitHash(value: unknown, field: string): string {
        const hash = this.assertString(value, field).trim();
        if (!isValidGitHash(hash)) {
            throw new Error(`Invalid git hash for '${field}'.`);
        }
        return hash;
    }

    /**
     * Publishes the current commit detail cache, including the latest available theme metadata.
     *
     * A missing selection is represented by a `clearCommitDetail` message so the webview never
     * has to infer cleared state from absent payloads.
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
     * Decorates commit files with icon theme data and stores the result if still current.
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

    /**
     * Builds the commit graph shell HTML with script/resource URIs scoped to this webview.
     */
    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: this.options.scriptFile ?? "webview-commitgraph.js",
            title: this.options.title ?? "Commit Graph",
            backgroundVar: "var(--vscode-editor-background)",
        });
    }

    /**
     * Mirrors the active repository name into the VS Code-owned view header suffix.
     */
    private applyRepositoryDescription(): void {
        if (!this.view) return;
        this.view.description =
            this.options.showRepositoryLabel && this.repositoryLabel
                ? `(${this.repositoryLabel})`
                : undefined;
    }

    /**
     * Releases theme resources and event emitters owned by the graph provider.
     */
    dispose(): void {
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
        this._onDeleteBranches.dispose();
        this._onWorktreeAction.dispose();
        this._onCommitAction.dispose();
        this._onOpenCommitFileDiff.dispose();
    }

    /**
     * Runs a theme refresh without letting listener-triggered failures escape VS Code callbacks.
     */
    private refreshThemeDataWithErrorHandling(): void {
        this.refreshThemeData().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Commit graph error: {message}", { message }),
            );
            this.postToWebview({ type: "error", message });
        });
    }

    /**
     * Refreshes icon theme data and re-sends branch and commit detail decorations.
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
        );
    }

    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }
}
