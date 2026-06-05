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
const MIN_VISIBLE_REFRESH_MS = 600;
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
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private requestSeq = 0;
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
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private repoRootUri?: vscode.Uri,
        private readonly workspaceState?: vscode.Memento,
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }
    setRepositoryRootUri(repoRootUri: vscode.Uri): void {
        this.repoRootUri = repoRootUri;
        this.selectedShelfIndex = null;
        this.files = [];
        this.stashes = [];
        this.shelfFiles = [];
        this.currentBranch = null;
        this.filterText = "";
        this.offset = 0;
        this.loadingMore = false;
        this.selectedCommitDetail = null;
        this.commitDetailFolderIconsByName = {};
        this.branchFolderIconsByName = {};
        // Bump request sequences so in-flight async responses from the old repo are ignored.
        this.requestSeq += 1;
        this.commitDetailSeq += 1;
        this.updateViewCount(0);
        this.postToWebview({
            type: "restoreCommitDraft",
            message: this.getStoredCommitDraft(),
        });
    }
    setRepositoryLabel(_label: string): void {
        this.updateViewCount(this.lastFileCount);
    }
    setBranches(branches: Branch[]): void {
        this.branches = branches;
        this.sendGraphBranches().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Branch update error: {message}", { message }),
            );
        });
    }
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
    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.commitDetailFolderIconsByName = {};
        this.postToWebview({ type: "clearCommitDetail" });
    }
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
        this.updateViewCount(this.lastFileCount);
        this.refreshDataWithErrorHandling();
    }
    async refresh(): Promise<void> {
        await this.refreshData(false);
        await this.refreshGraphData();
    }
    private async refreshFromUserAction(): Promise<void> {
        await vscode.window.withProgress(
            { location: { viewId: CommitPanelViewProvider.viewType } },
            async () => {
                await this.refreshData(false);
                await this.refreshGraphData();
            },
        );
    }
    private async refreshData(silent = false): Promise<void> {
        const refreshStartedAt = Date.now();
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
            const currentBranchHasUpstream = await this.currentBranchHasUpstream();
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
            this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
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
                currentBranchHasUpstream,
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
    private async refreshGraphData(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendGraphBranches();
        await this.loadInitialGraphCommits();
        this.postGraphCommitDetailState();
    }
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
    private async handleMessage(raw: unknown): Promise<void> {
        const msg = assertMessage(raw);
        const actionDeps = {
            gitOps: this.gitOps,
            refreshData: () => this.refreshData(),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
            postCommitted: () => this.postToWebview({ type: "committed" }),
            maybeOfferPublishBranch: () => this.maybeOfferPublishBranch(),
        };
        const fileActionDeps = {
            gitOps: this.gitOps,
            getWorkspaceRoot: () => this.getWorkspaceRoot(),
            refreshData: () => this.refreshData(),
            fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
        };
        switch (msg.type) {
            case "ready":
                await this.refreshData();
                await this.refreshGraphData();
                this.postToWebview({
                    type: "restoreCommitDraft",
                    message: this.getStoredCommitDraft(),
                });
                break;
            case "refresh":
                await this.refreshFromUserAction();
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
                        currentBranchHasUpstream: () => this.currentBranchHasUpstream(),
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
    private updateViewCount(count: number): void {
        this.lastFileCount = count;
        if (!this.view) return;
        this.view.description = count > 0 ? String(count) : "";
        this.view.badge = undefined;
    }
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
    private getWorkspaceRoot(): vscode.Uri {
        if (this.repoRootUri) return this.repoRootUri;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
            throw new Error("No workspace folder is open.");
        }
        return workspaceRoot;
    }
    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-commitpanel.js",
            title: vscode.l10n.t("Changes"),
            backgroundVar: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
        });
    }
    private getCommitDraftStorageKey(): string {
        const storageRoot =
            this.repoRootUri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!storageRoot) {
            throw new Error("No workspace folder is open.");
        }
        return `${CommitPanelViewProvider.COMMIT_DRAFT_KEY_PREFIX}${storageRoot}`;
    }
    private getStoredCommitDraft(): string {
        return this.workspaceState?.get<string>(this.getCommitDraftStorageKey()) ?? "";
    }
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
    private async currentBranchHasUpstream(): Promise<boolean> {
        const branches = await this.gitOps.getBranches();
        const currentBranch = branches.find((branch) => branch.isCurrent);
        return currentBranch?.upstream !== undefined && currentBranch.upstream.length > 0;
    }
    private refreshDataWithErrorHandling(): void {
        this.refreshData().catch((err) => {
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
