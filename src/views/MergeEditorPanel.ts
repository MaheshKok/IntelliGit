// Hosts IntelliGit's native three-way merge editor webview for one conflicted file.
// Loads base/ours/theirs from Git index stages, streams parsed segments to the
// webview, and applies resolutions by writing the merged file and staging it.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import {
    detectEolMetadata,
    parseConflictVersions,
    type MergeDiffOptions,
    type MergeEditorData,
} from "../mergeEditor/conflictParser";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import {
    runWithNotificationProgress,
    showTimedInformationMessage,
    showTimedWarningMessage,
} from "../utils/notifications";
import { buildWebviewShellHtml } from "./webviewHtml";

/**
 * Inputs required to open the native merge editor for one repository-relative file.
 *
 * `getRepoRoot` is a getter because the active repository can change while a panel
 * stays open; filesystem writes must target the root that owned the panel's Git data.
 */
export interface MergeEditorPanelOptions {
    extensionUri: vscode.Uri;
    gitOps: GitOps;
    getRepoRoot: () => string;
    filePath: string;
    onConflictStateChanged: () => Promise<void>;
}

/** Maximum merged-file payload accepted from the webview, guarding runaway messages. */
const MAX_APPLY_CONTENT_BYTES = 100 * 1024 * 1024;

/**
 * Owns one native merge-editor webview panel per conflicted file path.
 *
 * Webview messages are untrusted input: every command revalidates the panel's
 * repository-relative path, and `applyResolution` content must be a bounded string.
 * Successful resolutions write the merged file, stage it, notify conflict listeners,
 * and dispose the panel so stale conflict data can never be re-applied.
 */
export class MergeEditorPanel {
    private static readonly panels = new Map<string, MergeEditorPanel>();

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private diffOptions: MergeDiffOptions = {};

    /**
     * Binds webview HTML, message handling, and disposal tracking for a new panel.
     */
    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private readonly getRepoRoot: () => string,
        private readonly safePath: string,
        private onConflictStateChanged: () => Promise<void>,
    ) {
        this.panel = panel;
        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (msg) => {
            const message: unknown = msg;
            try {
                await this.handleMessage(message);
            } catch (error) {
                if (!this.isAlive()) return;
                const errorMessage = getErrorMessage(error);
                vscode.window.showErrorMessage(errorMessage);
                try {
                    if (!this.isAlive()) return;
                    await this.panel.webview.postMessage({
                        type: "loadError",
                        message: errorMessage,
                    });
                } catch {
                    // Panel may have been disposed between the liveness check and postMessage.
                }
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            if (MergeEditorPanel.panels.get(this.safePath) === this) {
                MergeEditorPanel.panels.delete(this.safePath);
            }
        });
    }

    /**
     * Opens or reveals the native merge editor for a repository-relative conflict file.
     *
     * The path is validated before any panel state exists. Reopening an existing panel
     * refreshes its callbacks and conflict data instead of duplicating editors.
     */
    static async open(options: MergeEditorPanelOptions): Promise<void> {
        const safePath = assertRepoRelativePath(options.filePath);

        const existing = MergeEditorPanel.panels.get(safePath);
        if (existing && !existing.disposed) {
            existing.onConflictStateChanged = options.onConflictStateChanged;
            existing.panel.reveal(vscode.ViewColumn.Active);
            await existing.postConflictData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "intelligit.mergeEditor",
            vscode.l10n.t("Merge: {file}", { file: path.posix.basename(safePath) }),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, "dist")],
            },
        );

        const instance = new MergeEditorPanel(
            panel,
            options.extensionUri,
            options.gitOps,
            options.getRepoRoot,
            safePath,
            options.onConflictStateChanged,
        );
        MergeEditorPanel.panels.set(safePath, instance);
    }

    /** Reports whether any native merge editor panel is currently open. */
    static isOpen(): boolean {
        return MergeEditorPanel.panels.size > 0;
    }

    /**
     * Validates and handles messages from the merge editor webview.
     *
     * Unknown message types are ignored. `applyResolution` requires a bounded string
     * payload; side-accepting commands resolve through Git rather than webview content.
     */
    private async handleMessage(raw: unknown): Promise<void> {
        const msg = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        const type = typeof msg.type === "string" ? msg.type : "";
        switch (type) {
            case "ready":
                await this.postConflictData();
                return;

            case "setIgnoreMode": {
                const mode = msg.mode;
                if (mode !== "none" && mode !== "whitespace") return;
                this.diffOptions = { ignoreWhitespace: mode === "whitespace" };
                await this.postConflictData();
                return;
            }

            case "applyResolution": {
                const content = msg.content;
                if (typeof content !== "string") {
                    throw new Error("Merge result payload must be a string.");
                }
                if (content.length > MAX_APPLY_CONTENT_BYTES) {
                    throw new Error("Merge result payload exceeds the supported size.");
                }
                await this.applyResolvedContent(content);
                return;
            }

            case "acceptYours":
                await this.acceptSide("ours");
                return;

            case "acceptTheirs":
                await this.acceptSide("theirs");
                return;

            case "openConflictSession":
                await vscode.commands.executeCommand("intelligit.openConflictSession");
                return;

            case "abortMerge":
                await this.abortMerge();
                return;

            case "close":
                this.panel.dispose();
                return;

            default:
                return;
        }
    }

    /**
     * Writes webview-produced merged content to the working tree and stages the file.
     *
     * The write targets the repository root captured at apply time so a repository
     * switch mid-session cannot redirect the file outside the original work tree.
     */
    private async applyResolvedContent(content: string): Promise<void> {
        const absolutePath = path.join(this.getRepoRoot(), this.safePath);
        await runWithNotificationProgress(
            vscode.l10n.t("Applying merge result for {path}...", { path: this.safePath }),
            async () => {
                await fs.promises.writeFile(absolutePath, content, "utf8");
                await this.gitOps.stageFile(this.safePath);
            },
        );
        showTimedInformationMessage(
            vscode.l10n.t("Merged and staged: {path}", { path: this.safePath }),
        );
        await this.notifyConflictStateChanged();
        if (this.isAlive()) this.panel.dispose();
    }

    /** Confirms and aborts the repository merge backing this editor panel. */
    private async abortMerge(): Promise<void> {
        const abortAction = vscode.l10n.t("Abort Merge");
        const confirmed = await vscode.window.showWarningMessage(
            vscode.l10n.t("Abort the current merge? Local conflict resolutions will be discarded."),
            { modal: true },
            abortAction,
        );
        if (confirmed !== abortAction) return;

        await runWithNotificationProgress(vscode.l10n.t("Aborting merge..."), async () => {
            await this.gitOps.abortMerge();
        });
        showTimedInformationMessage(vscode.l10n.t("Merge aborted."));
        await this.notifyConflictStateChanged();
        if (this.isAlive()) this.panel.dispose();
    }

    /**
     * Resolves the whole file to one side through Git checkout and staging.
     */
    private async acceptSide(side: "ours" | "theirs"): Promise<void> {
        const progressLabel =
            side === "ours"
                ? vscode.l10n.t("Accepting yours for {path}...", { path: this.safePath })
                : vscode.l10n.t("Accepting theirs for {path}...", { path: this.safePath });
        await runWithNotificationProgress(progressLabel, async () => {
            await this.gitOps.acceptConflictSide(this.safePath, side);
        });
        await this.notifyConflictStateChanged();
        if (this.isAlive()) this.panel.dispose();
    }

    /**
     * Notifies conflict listeners without letting refresh failures mask a successful merge.
     */
    private async notifyConflictStateChanged(): Promise<void> {
        try {
            await this.onConflictStateChanged();
        } catch (error) {
            showTimedWarningMessage(
                vscode.l10n.t("Failed to refresh conflict UI: {message}", {
                    message: getErrorMessage(error),
                }),
            );
        }
    }

    private isAlive(): boolean {
        return !this.disposed;
    }

    /**
     * Loads Git stage versions, parses merge segments, and posts them to the webview.
     *
     * A file with no stage entries is reported as a load error instead of rendering an
     * empty editor, because that state means the file is not actually conflicted.
     */
    private async postConflictData(): Promise<void> {
        if (!this.isAlive()) return;
        const versions = await this.gitOps.getConflictFileVersions(this.safePath);
        if (this.isAlive()) {
            if (versions.base === "" && versions.ours === "" && versions.theirs === "") {
                await this.panel.webview.postMessage({
                    type: "loadError",
                    message: vscode.l10n.t("File is not in a conflicted state: {path}", {
                        path: this.safePath,
                    }),
                });
            } else {
                const labels = await this.gitOps.getMergeSideLabels();
                if (this.isAlive()) {
                    const segments = parseConflictVersions(
                        versions.base,
                        versions.ours,
                        versions.theirs,
                        this.diffOptions,
                    );
                    const eolMetadata = detectEolMetadata(
                        versions.ours,
                        versions.theirs,
                        versions.base,
                    );

                    const data: MergeEditorData = {
                        filePath: this.safePath,
                        segments,
                        oursLabel: labels.ours,
                        theirsLabel: labels.theirs,
                        eol: eolMetadata.eol,
                        hasTrailingNewline: eolMetadata.hasTrailingNewline,
                        diffOptions: this.diffOptions,
                    };

                    await this.panel.webview.postMessage({ type: "setConflictData", data });
                }
            }
        }
    }

    /**
     * Builds the merge editor shell with script and style resources scoped to the webview.
     */
    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-mergeeditor.js",
            styleFiles: ["webview-mergeeditor.css"],
            title: vscode.l10n.t("Merge: {file}", { file: path.posix.basename(this.safePath) }),
        });
    }
}
