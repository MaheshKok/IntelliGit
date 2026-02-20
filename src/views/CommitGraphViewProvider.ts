// WebviewViewProvider for the bottom panel commit graph.
// Loads the CommitGraphApp React app, handles pagination, branch filtering,
// and posts selected commit hashes back to the extension host.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, CommitDetail, ThemeFolderIconMap } from "../types";
import type {
    BranchAction,
    CommitAction,
    CommitGraphInbound,
} from "../webviews/react/commitGraphTypes";
import { IconThemeService } from "./shared/IconThemeService";
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
    private folderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;
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

    private readonly _onCommitAction = new vscode.EventEmitter<{
        action: CommitAction;
        hash: string;
    }>();
    readonly onCommitAction = this._onCommitAction.event;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.iconTheme.dispose();
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);

        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
                this.iconTheme.dispose();
            }
        });

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "ready":
                    await this.iconTheme.initIconThemeData();
                    await this.sendBranches();
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
        this.sendBranches().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Branch update error: ${message}`);
        });
    }

    async filterByBranch(branch: string | null): Promise<void> {
        this.currentBranch = branch;
        this.filterText = "";
        this.postToWebview({ type: "setSelectedBranch", branch });
        await this.loadInitial();
    }

    async refresh(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        await this.loadInitial();
    }

    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
        this.folderIconsByName = {};
        this.postCommitDetailState();
        this.decorateAndStoreCommitDetail(detail, requestId).catch((err) => {
            if (requestId !== this.commitDetailSeq) return;
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Commit detail error: ${message}`);
        });
    }

    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.folderIconsByName = {};
        this.postCommitDetailState();
    }

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
        this.iconTheme.dispose();
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
        this._onCommitAction.dispose();
    }
}
