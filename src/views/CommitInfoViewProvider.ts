import * as vscode from "vscode";
import type { CommitDetail, ThemeFolderIconMap } from "../types";
import type { CommitInfoInbound, CommitInfoOutbound } from "../webviews/protocol/commitInfoTypes";
import { IconThemeService } from "./shared";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { isValidGitHash } from "../services/gitHelpers";

/**
 * Hosts the changed-files webview for the currently selected commit.
 *
 * The provider caches the latest commit detail while the view may be unresolved or not yet
 * ready. Webview file-diff requests are accepted only after commit hashes and repository
 * relative paths have been validated, then forwarded as host events for command wiring.
 */
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

    /**
     * Creates the changed-files provider before VS Code resolves its webview.
     *
     * Icon-theme resolution is intentionally delayed until a webview is attached, while commit
     * detail state can already be cached by host selection events.
     */
    constructor(private readonly extensionUri: vscode.Uri) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }

    /**
     * Resolves the VS Code changed-files view and binds its webview lifecycle.
     *
     * Resolution resets readiness and icon-theme state, restricts webview resources to `dist`,
     * and posts cached commit data only after the webview sends `ready`. The only other accepted
     * message opens a commit-file diff; invalid payloads are reported without mutating the cache.
     */
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

    /**
     * Stores a selected commit detail and decorates changed files when icon data is available.
     *
     * The raw detail is posted immediately when the webview is ready. A request sequence protects
     * against late decoration results replacing a newer selection or a cleared panel.
     */
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

    /**
     * Clears cached commit detail state and tells a ready webview to remove file rows.
     */
    clear(): void {
        this.requestSeq += 1;
        this.detail = undefined;
        this.folderIconsByName = {};
        this.postToWebview({ type: "clear" });
    }

    /**
     * Publishes cached commit detail state only after the webview has completed initialization.
     *
     * The ready gate prevents messages from being lost during VS Code's view restoration while
     * still allowing the host to update the cache before the webview exists.
     */
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

    /**
     * Validates a webview scalar field before it can be used in a host-side action.
     */
    private assertString(value: unknown, field: string): string {
        if (typeof value !== "string") {
            throw new Error(`Expected string for '${field}', got ${typeof value}`);
        }
        return value;
    }

    /**
     * Normalizes and validates a webview-provided commit hash before opening diffs.
     */
    private assertGitHash(value: unknown, field: string): string {
        const hash = this.assertString(value, field).trim();
        if (!isValidGitHash(hash)) {
            throw new Error(`Invalid git hash for '${field}'.`);
        }
        return hash;
    }

    /**
     * Applies icon-theme decoration and stores the result only if it matches the latest request.
     */
    private async decorateAndStoreDetail(detail: CommitDetail, requestId: number): Promise<void> {
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId !== this.requestSeq) return;
        this.detail = decorated.detail;
        this.folderIconsByName = decorated.folderIconsByName;
        this.postCurrentState();
    }

    /**
     * Releases the icon theme resolver and file-diff event emitter owned by this provider.
     */
    dispose(): void {
        this.iconTheme.dispose();
        this._onOpenCommitFileDiff.dispose();
    }
}
