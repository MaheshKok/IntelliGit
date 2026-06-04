import * as vscode from "vscode";
import type { CommitDetail, ThemeFolderIconMap } from "../types";
import type { CommitInfoInbound, CommitInfoOutbound } from "../webviews/protocol/commitInfoTypes";
import { IconThemeService } from "./shared";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { isValidGitHash } from "../services/gitHelpers";

export class CommitInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitFiles";

    private view?: vscode.WebviewView;
    private detail?: CommitDetail;
    private ready = false;
    private folderIconsByName: ThemeFolderIconMap = {};
    private requestSeq = 0;
    private readonly iconTheme: IconThemeService;
    private readonly _onOpenCommitFileDiff = new vscode.EventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    readonly onOpenCommitFileDiff = this._onOpenCommitFileDiff.event;

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

        webviewView.webview.onDidReceiveMessage(async (msg: CommitInfoOutbound) => {
            switch (msg.type) {
                case "ready":
                    try {
                        await this.iconTheme.initIconThemeData();
                    } catch (err) {
                        console.error("[IntelliGit] Failed to initialize icon theme data:", err);
                    }
                    this.ready = true;
                    this.postCurrentState();
                    break;
                case "openCommitFileDiff":
                    try {
                        this._onOpenCommitFileDiff.fire({
                            commitHash: this.assertGitHash(msg.commitHash, "commitHash"),
                            filePath: assertRepoRelativePath(
                                this.assertString(msg.filePath, "filePath"),
                            ),
                        });
                    } catch (err) {
                        const message = getErrorMessage(err);
                        vscode.window.showErrorMessage(
                            vscode.l10n.t("Commit file action error: {message}", { message }),
                        );
                    }
                    break;
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
            title: vscode.l10n.t("Changed Files"),
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
            const msg = getErrorMessage(err);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Commit detail error: {message}", { message: msg }),
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

    private assertString(value: unknown, field: string): string {
        if (typeof value !== "string") {
            throw new Error(`Expected string for '${field}', got ${typeof value}`);
        }
        return value;
    }

    private assertGitHash(value: unknown, field: string): string {
        const hash = this.assertString(value, field).trim();
        if (!isValidGitHash(hash)) {
            throw new Error(`Invalid git hash for '${field}'.`);
        }
        return hash;
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
        this._onOpenCommitFileDiff.dispose();
    }
}
