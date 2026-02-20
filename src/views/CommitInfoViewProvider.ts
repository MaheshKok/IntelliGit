import * as vscode from "vscode";
import type { CommitDetail, ThemeFolderIconMap } from "../types";
import type { CommitInfoInbound } from "../webviews/react/commitInfoTypes";
import { IconThemeService } from "./shared";
import { buildWebviewShellHtml } from "./webviewHtml";

export class CommitInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitFiles";

    private view?: vscode.WebviewView;
    private detail?: CommitDetail;
    private ready = false;
    private folderIconsByName: ThemeFolderIconMap = {};
    private requestSeq = 0;
    private readonly iconTheme: IconThemeService;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.iconTheme.dispose();
        this.view = webviewView;
        this.ready = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === "ready") {
                this.ready = true;
                await this.iconTheme.initIconThemeData();
                this.postCurrentState();
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
            this.ready = false;
            this.iconTheme.dispose();
        });

        webviewView.webview.html = buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview: webviewView.webview,
            scriptFile: "webview-commitinfo.js",
            title: "Changed Files",
            backgroundVar: "var(--vscode-editor-background)",
        });
    }

    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.requestSeq;
        this.detail = detail;
        this.folderIconsByName = {};
        this.postCurrentState();
        this.decorateAndStoreDetail(detail, requestId).catch((err) => {
            if (requestId !== this.requestSeq) return;
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
                `Commit detail error (request ${requestId}): ${message}`,
            );
        });
    }

    clear(): void {
        this.requestSeq += 1;
        this.detail = undefined;
        this.folderIconsByName = {};
        this.postToWebview({ type: "clear" });
    }

    private postCurrentState(): void {
        if (!this.ready) return;
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        if (!this.detail) {
            this.postToWebview({ type: "clear" });
            return;
        }
        this.postToWebview({
            type: "setCommitDetail",
            detail: this.detail,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.folderIconsByName,
            iconFonts,
        });
    }

    private postToWebview(msg: CommitInfoInbound): void {
        this.view?.webview.postMessage(msg);
    }

    private async decorateAndStoreDetail(detail: CommitDetail, requestId: number): Promise<void> {
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId !== this.requestSeq) return;
        this.detail = decorated.detail;
        this.folderIconsByName = decorated.folderIconsByName;
        this.postCurrentState();
    }

    dispose(): void {
        this.iconTheme.dispose();
    }
}
