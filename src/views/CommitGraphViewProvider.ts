// WebviewViewProvider for the bottom panel commit graph.
// Loads the CommitGraphApp React app, handles pagination, branch filtering,
// and posts selected commit hashes back to the extension host.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch } from "../types";

export class CommitGraphViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitGraph";

    private view?: vscode.WebviewView;
    private currentBranch: string | null = null;
    private filterText = "";
    private offset = 0;
    private readonly PAGE_SIZE = 500;

    private branches: Branch[] = [];

    private readonly _onCommitSelected = new vscode.EventEmitter<string>();
    readonly onCommitSelected = this._onCommitSelected.event;

    private readonly _onBranchFilterChanged = new vscode.EventEmitter<string | null>();
    readonly onBranchFilterChanged = this._onBranchFilterChanged.event;

    private readonly _onBranchAction = new vscode.EventEmitter<{
        action: string;
        branchName: string;
    }>();
    readonly onBranchAction = this._onBranchAction.event;

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

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "ready":
                    this.sendBranches();
                    await this.loadInitial();
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
                    await this.loadInitial();
                    break;
                case "branchAction":
                    this._onBranchAction.fire({
                        action: msg.action,
                        branchName: msg.branchName,
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
        await this.loadInitial();
    }

    async refresh(): Promise<void> {
        this.sendBranches();
        await this.loadInitial();
    }

    private sendBranches(): void {
        this.postToWebview({ type: "setBranches", branches: this.branches });
    }

    private async loadInitial(): Promise<void> {
        this.offset = 0;
        try {
            const commits = await this.gitOps.getLog(
                this.PAGE_SIZE,
                this.currentBranch ?? undefined,
                this.filterText || undefined,
            );
            this.offset = commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: false,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
        }
    }

    private async loadMore(): Promise<void> {
        try {
            const commits = await this.gitOps.getLog(
                this.PAGE_SIZE + this.offset,
                this.currentBranch ?? undefined,
                this.filterText || undefined,
            );
            const newCommits = commits.slice(this.offset);
            this.offset = commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits: newCommits,
                hasMore: newCommits.length > 0,
                append: true,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
        }
    }

    private async filterByText(text: string): Promise<void> {
        this.filterText = text;
        await this.loadInitial();
    }

    private postToWebview(msg: unknown): void {
        this.view?.webview.postMessage(msg);
    }

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "dist", "webview-commitgraph.js"),
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
    <title>Commit Graph</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root {
            width: 100%; height: 100%; overflow: hidden;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    dispose(): void {
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
    }
}

function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    for (let i = 0; i < 32; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
    return r;
}
