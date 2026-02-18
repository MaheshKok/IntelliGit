import * as vscode from "vscode";
import type { CommitDetail } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";

export class CommitInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitFiles";

    private view?: vscode.WebviewView;
    private detail?: CommitDetail;
    private ready = false;

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

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "ready") {
                this.ready = true;
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
        this.detail = detail;
        this.postCurrentState();
    }

    clear(): void {
        this.detail = undefined;
        this.postToWebview({ type: "clear" });
    }

    private postCurrentState(): void {
        if (!this.ready) return;
        if (!this.detail) {
            this.postToWebview({ type: "clear" });
            return;
        }
        this.postToWebview({ type: "setCommitDetail", detail: this.detail });
    }

    private postToWebview(msg: unknown): void {
        this.view?.webview.postMessage(msg);
    }

    dispose(): void {
        // no-op
    }
}
