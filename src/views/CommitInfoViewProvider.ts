import * as vscode from "vscode";
import type { CommitDetail, ThemeIconFont } from "../types";
import { FileIconThemeResolver, type ThemeFolderIcons } from "../utils/fileIconTheme";
import type { CommitInfoInbound } from "../webviews/react/commitInfoTypes";
import { buildWebviewShellHtml } from "./webviewHtml";

export class CommitInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitFiles";

    private view?: vscode.WebviewView;
    private detail?: CommitDetail;
    private ready = false;
    private iconResolver?: FileIconThemeResolver;
    private folderIcons: ThemeFolderIcons = {};
    private iconFonts: ThemeIconFont[] = [];
    private requestSeq = 0;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        this.ready = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconResolver = new FileIconThemeResolver(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === "ready") {
                this.ready = true;
                await this.initIconThemeData();
                this.postCurrentState();
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
            this.ready = false;
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
        this.postCurrentState();
        void this.decorateAndStoreDetail(detail, requestId);
    }

    clear(): void {
        this.requestSeq += 1;
        this.detail = undefined;
        this.postToWebview({ type: "clear" });
    }

    private postCurrentState(): void {
        if (!this.ready) return;
        if (!this.detail) {
            this.postToWebview({ type: "clear" });
            return;
        }
        this.postToWebview({
            type: "setCommitDetail",
            detail: this.detail,
            folderIcon: this.folderIcons.folderIcon,
            folderExpandedIcon: this.folderIcons.folderExpandedIcon,
            iconFonts: this.iconFonts,
        });
    }

    private postToWebview(msg: CommitInfoInbound): void {
        this.view?.webview.postMessage(msg);
    }

    private async decorateAndStoreDetail(detail: CommitDetail, requestId: number): Promise<void> {
        await this.initIconThemeData();
        if (requestId !== this.requestSeq) return;
        const decorated = await this.decorateCommitDetail(detail);
        if (requestId !== this.requestSeq) return;
        this.detail = decorated;
        this.postCurrentState();
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

    dispose(): void {
        // no-op
    }
}
