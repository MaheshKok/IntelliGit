// Manages a vscode.WebviewPanel (editor tab) that combines the commit graph
// and commit panel into a single unified view. Used when the user enables
// intelligit.undockableWindow to allow dragging to a second monitor.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { IconThemeService } from "./shared";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath, deleteFileWithFallback } from "../utils/fileOps";
import { runWithNotificationProgress } from "../utils/notifications";
import { promptRebaseAfterPushRejection, isValidGitHash } from "../services/gitHelpers";
import { isBranchAction, isCommitAction } from "../webviews/react/commitGraphTypes";
import type { Branch, CommitDetail, ThemeFolderIconMap, WorkingFile } from "../types";
import type { BranchAction, CommitAction } from "../webviews/react/commitGraphTypes";
import type { UnifiedOutbound, UnifiedInbound } from "../webviews/react/undocked/types";

interface PersistedColumnWidths {
    branchWidth: number;
    graphWidth: number;
    infoWidth: number;
    commitPanelWidth: number;
}

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
    private selectedCommitDetail: CommitDetail | null = null;
    private folderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];

    // Commit-panel state
    private files: WorkingFile[] = [];
    private lastFileCount = 0;

    // Event emitters
    private readonly _onCommitSelected = new vscode.EventEmitter<string>();
    readonly onCommitSelected = this._onCommitSelected.event;

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

    constructor(
        private readonly extensionUri: vscode.Uri,
        gitOps: GitOps,
        repoRootUri: vscode.Uri,
        private readonly workspaceState?: vscode.Memento,
    ) {
        this.gitOps = gitOps;
        this.repoRootUri = repoRootUri;
        this.iconTheme = new IconThemeService(this.extensionUri);
    }

    setRepositoryLabel(label: string): void {
        this.repositoryLabel = label;
        if (this.panel) this.panel.title = `IntelliGit — ${label}`;
    }

    setRepositoryRootUri(repoRootUri: vscode.Uri): void {
        this.repoRootUri = repoRootUri;
        this.files = [];
        this.lastFileCount = 0;
        this.selectedCommitDetail = null;
        this.folderIconsByName = {};
        this.branchFolderIconsByName = {};
        this.currentBranch = null;
        this.filterText = "";
        this.offset = 0;
        this.loadingMore = false;
    }

    setBranches(branches: Branch[]): void {
        this.branches = branches;
        this.sendBranches().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Branch update error: ${message}`);
        });
    }

    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
        this.folderIconsByName = {};
        this.postCommitDetailState();
        this.decorateAndStoreCommitDetail(detail, requestId).catch((err) => {
            if (requestId !== this.commitDetailSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Commit detail error: ${message}`);
        });
    }

    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.folderIconsByName = {};
        this.postToWebview({ type: "clearCommitDetail" });
    }

    async refresh(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        await this.loadInitial();
        await this.refreshCommitPanelData(false);
    }

    reveal(): void {
        if (this.panel) {
            this.panel.reveal();
        }
    }

    async open(): Promise<void> {
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

    dispose(): void {
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onCommitSelected.dispose();
        this._onBranchAction.dispose();
        this._onCommitAction.dispose();
        this._onOpenCommitFileDiff.dispose();
        this._onDidChangeFileCount.dispose();
        this._onDidChangeWorkingTree.dispose();
        this._onDockRequested.dispose();
        this._onDidDispose.dispose();
        this.panel?.dispose();
    }

    // --- Message handling --------------------------------------------------

    private async handleMessage(msg: UnifiedOutbound): Promise<void> {
        switch (msg.type) {
            // Graph-side
            case "ready":
                // Restore column widths first, before the slow git operations
                // below, so the webview applies saved widths immediately and
                // never overwrites them with its pre-restore equal widths.
                this.sendPersistedColumnWidths();
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
                this.postToWebview({
                    type: "setSelectedBranch",
                    branch: this.currentBranch,
                });
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
                    filePath: assertRepoRelativePath(this.assertString(msg.filePath, "filePath")),
                });
                break;

            case "dock":
                this._onDockRequested.fire();
                break;

            case "columnWidths":
                await this.workspaceState?.update(UndockedViewProvider.COLUMN_WIDTHS_KEY, {
                    branchWidth: this.assertNumber(msg.branchWidth, "branchWidth"),
                    graphWidth: this.assertNumber(msg.graphWidth, "graphWidth"),
                    infoWidth: this.assertNumber(msg.infoWidth, "infoWidth"),
                    commitPanelWidth: this.assertNumber(msg.commitPanelWidth, "commitPanelWidth"),
                });
                break;

            // Commit-panel-side
            case "refresh":
                await this.refreshCommitPanelData(false);
                break;

            case "saveCommitDraft": {
                const message = this.assertString(msg.message, "message");
                await this.workspaceState?.update(
                    this.getCommitDraftStorageKey(),
                    message || undefined,
                );
                break;
            }

            case "stageFiles": {
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                await this.gitOps.stageFiles(paths);
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "unstageFiles": {
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                await this.gitOps.unstageFiles(paths);
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "commitSelected": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                const push = msg.push === true;
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                if (paths.length === 0 && !amend) {
                    vscode.window.showWarningMessage("Select files to commit.");
                    return;
                }
                if (paths.length > 0) {
                    await this.gitOps.stageFiles(paths);
                }
                try {
                    await runWithNotificationProgress(
                        push ? "Committing and pushing..." : "Committing...",
                        async () => {
                            if (push) {
                                await this.gitOps.commitAndPush(message, amend);
                            } else {
                                await this.gitOps.commit(message, amend);
                            }
                        },
                    );
                } catch (err) {
                    if (
                        push &&
                        (await promptRebaseAfterPushRejection(err, this.gitOps, async () => {
                            await this.gitOps.push();
                        }))
                    ) {
                        this.postToWebview({ type: "committed" });
                        await this.refreshCommitPanelData();
                        this._onDidChangeWorkingTree.fire();
                        return;
                    }
                    throw err;
                }
                vscode.window.showInformationMessage(
                    push ? "Committed and pushed successfully." : "Committed successfully.",
                );
                this.postToWebview({ type: "committed" });
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "commit": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                await runWithNotificationProgress("Committing...", async () => {
                    await this.gitOps.commit(message, amend);
                });
                vscode.window.showInformationMessage("Committed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "commitAndPush": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                try {
                    await runWithNotificationProgress("Committing and pushing...", async () => {
                        await this.gitOps.commitAndPush(message, amend);
                    });
                } catch (err) {
                    if (
                        await promptRebaseAfterPushRejection(err, this.gitOps, async () => {
                            await this.gitOps.push();
                        })
                    ) {
                        this.postToWebview({ type: "committed" });
                        await this.refreshCommitPanelData();
                        this._onDidChangeWorkingTree.fire();
                        return;
                    }
                    throw err;
                }
                vscode.window.showInformationMessage("Committed and pushed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "publishBranch":
                await vscode.commands.executeCommand("intelligit.publishBranch");
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
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
                const paths = this.assertRepoPathArray(msg.paths, "paths");
                if (paths.length === 0) {
                    const confirm = await vscode.window.showWarningMessage(
                        "Rollback all changes?",
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.gitOps.rollbackAll();
                } else {
                    const confirm = await vscode.window.showWarningMessage(
                        `Rollback ${paths.length} file(s)?`,
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.gitOps.rollbackFiles(paths);
                }
                vscode.window.showInformationMessage("Changes rolled back.");
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "showDiff": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const uri = vscode.Uri.joinPath(this.repoRootUri, filePath);
                await vscode.commands.executeCommand("git.openChange", uri);
                break;
            }

            case "shelveSave": {
                const name = typeof msg.name === "string" ? msg.name : "Shelved changes";
                let paths: string[] | undefined;
                if (msg.paths !== undefined) {
                    paths = this.assertRepoPathArray(msg.paths, "paths");
                }
                await this.gitOps.shelveSave(paths, name);
                vscode.window.showInformationMessage("Changes shelved.");
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfPop": {
                const index = this.assertNumber(msg.index, "index");
                await this.gitOps.shelvePop(index);
                vscode.window.showInformationMessage("Unshelved changes.");
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfApply": {
                const index = this.assertNumber(msg.index, "index");
                await this.gitOps.shelveApply(index);
                vscode.window.showInformationMessage("Applied shelved changes.");
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfDelete": {
                const index = this.assertNumber(msg.index, "index");
                const confirm = await vscode.window.showWarningMessage(
                    "Delete this shelved change?",
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                await this.gitOps.shelveDelete(index);
                vscode.window.showInformationMessage("Shelved change deleted.");
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "shelfSelect": {
                // The commit-panel side handles shelf selection visually;
                // we just need to refresh with the new index.
                // The webview sends the index, but the actual shelfFiles are
                // fetched when we refresh.
                break;
            }

            case "showShelfDiff": {
                const index = this.assertNumber(msg.index, "index");
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const patch = await this.gitOps.getShelvedFilePatch(index, filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: patch || `No shelved diff found for ${filePath}.`,
                    language: "diff",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }

            case "openFile": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const uri = vscode.Uri.joinPath(this.repoRootUri, filePath);
                await vscode.window.showTextDocument(uri);
                break;
            }

            case "deleteFile": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${filePath}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                const deleted = await deleteFileWithFallback(
                    this.gitOps,
                    this.repoRootUri,
                    filePath,
                );
                if (!deleted) return;
                vscode.window.showInformationMessage(`Deleted ${filePath}`);
                await this.refreshCommitPanelData();
                this._onDidChangeWorkingTree.fire();
                break;
            }

            case "showHistory": {
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const history = await this.gitOps.getFileHistory(filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: history || "No history found.",
                    language: "git-commit",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }
        }
    }

    // --- Graph data fetching ------------------------------------------------

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
            vscode.window.showErrorMessage(`Git log error: ${message}`);
            this.postToWebview({ type: "loadError", message });
        }
    }

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
            vscode.window.showErrorMessage(`Git log error: ${message}`);
            this.postToWebview({ type: "loadError", message });
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

    // --- Commit panel data fetching -----------------------------------------

    private async refreshCommitPanelData(silent = false): Promise<void> {
        if (!silent) this.postToWebview({ type: "refreshing", active: true });
        try {
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateWorkingFiles(await this.gitOps.getStatus());
            const stashes = await this.gitOps.listShelved();
            const currentBranchHasUpstream = await this.currentBranchHasUpstream();
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();

            // Default to first stash
            const selectedShelfIndex = stashes.length > 0 ? stashes[0].index : null;

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
                currentBranchHasUpstream,
            });
        } finally {
            if (!silent) this.postToWebview({ type: "refreshing", active: false });
        }
    }

    // --- Branch sending -----------------------------------------------------

    private async sendBranches(): Promise<void> {
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

    private async currentBranchHasUpstream(): Promise<boolean> {
        const branches = await this.gitOps.getBranches();
        const currentBranch = branches.find((branch) => branch.isCurrent);
        return currentBranch?.upstream !== undefined && currentBranch.upstream.length > 0;
    }

    // --- Commit detail ------------------------------------------------------

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

    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId !== this.commitDetailSeq) return;
        this.selectedCommitDetail = decorated.detail;
        this.folderIconsByName = decorated.folderIconsByName;
        this.postCommitDetailState();
    }

    // --- HTML generation ----------------------------------------------------

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-undocked.js",
            title: "IntelliGit",
            backgroundVar: "var(--vscode-editor-background)",
        });
    }

    // --- Commit draft persistence -------------------------------------------

    private getCommitDraftStorageKey(): string {
        return `${UndockedViewProvider.COMMIT_DRAFT_KEY_PREFIX}${this.repoRootUri.fsPath}`;
    }

    private getStoredCommitDraft(): string {
        return this.workspaceState?.get<string>(this.getCommitDraftStorageKey()) ?? "";
    }

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

    private sendSettings(): void {
        this.postToWebview({
            type: "settings",
            commitWindowPosition: this.resolveCommitWindowPosition(),
        });
    }

    private resolveCommitWindowPosition(): "left" | "right" {
        const config = vscode.workspace.getConfiguration();
        const rawPosition = config.get<string>("intelligit.commitWindowPosition") ?? "auto";
        if (rawPosition === "left" || rawPosition === "right") return rawPosition;
        return config.get<string>("workbench.sideBar.location") === "right" ? "right" : "left";
    }

    // --- Theme change listeners ---------------------------------------------

    private refreshThemeDataWithErrorHandling(): void {
        this.refreshThemeData().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`IntelliGit error: ${message}`);
            this.postToWebview({ type: "error", message });
        });
    }

    private async refreshThemeData(): Promise<void> {
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

    // --- Type assertion helpers ---------------------------------------------

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

    private assertGitHash(value: unknown, field: string): string {
        const hash = this.assertString(value, field).trim();
        if (!isValidGitHash(hash)) {
            throw new Error(`Invalid git hash for '${field}'.`);
        }
        return hash;
    }

    private assertNumber(value: unknown, field: string): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Expected number for '${field}', got ${typeof value}`);
        }
        return value;
    }

    private assertStringArray(value: unknown, field: string): string[] {
        if (!Array.isArray(value)) {
            throw new Error(`Expected string[] for '${field}', got ${typeof value}`);
        }
        if (!value.every((item): item is string => typeof item === "string")) {
            throw new Error(`Expected all elements of '${field}' to be strings`);
        }
        return value;
    }

    private assertRepoPathArray(value: unknown, field: string): string[] {
        const strings = this.assertStringArray(value, field);
        return strings.map((s) => assertRepoRelativePath(s));
    }
}
