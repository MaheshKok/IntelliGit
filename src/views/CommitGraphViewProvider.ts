// WebviewViewProvider for the bottom panel commit graph.
// Loads the CommitGraphApp React app, handles pagination, branch filtering,
// and posts selected commit hashes back to the extension host.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, CommitDetail, ThemeIconFont } from "../types";
import { FileIconThemeResolver, type ThemeFolderIcons } from "../utils/fileIconTheme";
import type {
    BranchAction,
    CommitAction,
    CommitGraphInbound,
} from "../webviews/react/commitGraphTypes";
import { buildWebviewShellHtml } from "./webviewHtml";

export class CommitGraphViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitGraph";

    private view?: vscode.WebviewView;
    private currentBranch: string | null = null;
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private requestSeq = 0;
    private readonly PAGE_SIZE = 500;

    private branches: Branch[] = [];
    private selectedCommitDetail: CommitDetail | null = null;
    private iconResolver?: FileIconThemeResolver;
    private folderIcons: ThemeFolderIcons = {};
    private iconFonts: ThemeIconFont[] = [];
    private commitDetailSeq = 0;

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

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconResolver = new FileIconThemeResolver(webviewView.webview);

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "ready":
                    await this.initIconThemeData();
                    this.sendBranches();
                    await this.loadInitial();
                    this.postCommitDetailState();
                    break;
                case "selectCommit":
                    this._onCommitSelected.fire(msg.hash);
                    break;
                case "loadMore":
                    await this.loadMore();
                    break;
                case "filterText":
                    await this.filterByText(msg.text);
                    break;
                case "filterBranch":
                    this.currentBranch = msg.branch;
                    this.filterText = "";
                    this._onBranchFilterChanged.fire(msg.branch);
                    this.postToWebview({ type: "setSelectedBranch", branch: msg.branch });
                    await this.loadInitial();
                    break;
                case "branchAction":
                    this._onBranchAction.fire({
                        action: msg.action,
                        branchName: msg.branchName,
                    });
                    break;
                case "commitAction":
                    this._onCommitAction.fire({
                        action: msg.action,
                        hash: msg.hash,
                    });
                    break;
            }
        });
    }

    setBranches(branches: Branch[]): void {
        this.branches = branches;
        this.sendBranches();
    }

    async filterByBranch(branch: string | null): Promise<void> {
        this.currentBranch = branch;
        this.filterText = "";
        this.postToWebview({ type: "setSelectedBranch", branch });
        await this.loadInitial();
    }

    async refresh(): Promise<void> {
        await this.initIconThemeData();
        this.sendBranches();
        await this.loadInitial();
    }

    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
        this.postCommitDetailState();
        void this.decorateAndStoreCommitDetail(detail, requestId);
    }

    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.postCommitDetailState();
    }

    private sendBranches(): void {
        this.postToWebview({ type: "setBranches", branches: this.branches });
    }

    private async loadInitial(): Promise<void> {
        const requestId = ++this.requestSeq;
        this.offset = 0;
        this.loadingMore = false;
        try {
            const commits = await this.gitOps.getLog(
                this.PAGE_SIZE,
                this.currentBranch ?? undefined,
                this.filterText || undefined,
                0,
            );
            if (requestId !== this.requestSeq) return;
            this.offset = commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: false,
                unpushedHashes: await this.gitOps.getUnpushedCommitHashes(),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
        }
    }

    private async loadMore(): Promise<void> {
        if (this.loadingMore) return;
        this.loadingMore = true;
        const requestId = ++this.requestSeq;
        try {
            const commits = await this.gitOps.getLog(
                this.PAGE_SIZE,
                this.currentBranch ?? undefined,
                this.filterText || undefined,
                this.offset,
            );
            if (requestId !== this.requestSeq) return;
            const newCommits = commits;
            this.offset += newCommits.length;
            this.postToWebview({
                type: "loadCommits",
                commits: newCommits,
                hasMore: newCommits.length >= this.PAGE_SIZE,
                append: true,
                unpushedHashes: await this.gitOps.getUnpushedCommitHashes(),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
        } finally {
            this.loadingMore = false;
        }
    }

    private async filterByText(text: string): Promise<void> {
        this.filterText = text;
        await this.loadInitial();
    }

    private postToWebview(msg: CommitGraphInbound): void {
        this.view?.webview.postMessage(msg);
    }

    private postCommitDetailState(): void {
        if (this.selectedCommitDetail) {
            this.postToWebview({
                type: "setCommitDetail",
                detail: this.selectedCommitDetail,
                folderIcon: this.folderIcons.folderIcon,
                folderExpandedIcon: this.folderIcons.folderExpandedIcon,
                iconFonts: this.iconFonts,
            });
            return;
        }
        this.postToWebview({ type: "clearCommitDetail" });
    }

    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        await this.initIconThemeData();
        if (requestId !== this.commitDetailSeq) return;
        const decorated = await this.decorateCommitDetail(detail);
        if (requestId !== this.commitDetailSeq) return;
        this.selectedCommitDetail = decorated;
        this.postCommitDetailState();
    }

    private async decorateCommitDetail(detail: CommitDetail): Promise<CommitDetail> {
        if (!this.iconResolver) return detail;
        const files = await this.iconResolver.decorateCommitFiles(detail.files);
        return { ...detail, files };
    }

    private async initIconThemeData(): Promise<void> {
        if (!this.iconResolver || !this.view) return;
        const distRoot = vscode.Uri.joinPath(this.extensionUri, "dist");
        const themeRoot = await this.iconResolver.getThemeResourceRootUri();
        this.view.webview.options = {
            ...this.view.webview.options,
            localResourceRoots: themeRoot ? [distRoot, themeRoot] : [distRoot],
        };
        this.folderIcons = await this.iconResolver.getFolderIcons();
        this.iconFonts = await this.iconResolver.getThemeFonts();
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-commitgraph.js",
            title: "Commit Graph",
            backgroundVar: "var(--vscode-editor-background)",
        });
    }

    dispose(): void {
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
        this._onCommitAction.dispose();
    }
}
