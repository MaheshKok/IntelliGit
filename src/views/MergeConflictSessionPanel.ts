import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { runWithNotificationProgress, showTimedInformationMessage } from "../utils/notifications";
import type { MergeConflictSessionData } from "../webviews/protocol/mergeConflictSessionTypes";

/**
 * Branch labels shown in the merge-conflict session panel header.
 *
 * Empty or whitespace-only values are ignored so reopening an existing panel cannot erase the
 * last meaningful source/target labels while a merge operation is still active.
 */
interface MergeConflictSessionLabels {
    sourceBranch?: string;
    targetBranch?: string;
}

/**
 * Host-side actions invoked by validated merge-conflict webview messages.
 */
interface MergeConflictSessionCallbacks {
    onOpenMergeConflict: (filePath: string) => Promise<void>;
    onConflictStateChanged: () => Promise<void>;
}

/**
 * Owns the singleton merge-conflict session webview panel.
 *
 * The panel lists detailed conflict files for the active repository and accepts only readiness,
 * refresh, open-merge, accept-side, and close messages. File paths from the webview are optional
 * user input until validated, and side-accepting commands always refresh conflict state before
 * optionally closing the panel after all conflicts are resolved.
 */
export class MergeConflictSessionPanel {
    private static currentPanel: MergeConflictSessionPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private sourceBranch = "incoming branch";
    private targetBranch = "current branch";

    /**
     * Binds panel HTML, message handling, and disposal tracking for a newly created panel.
     */
    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        labels: MergeConflictSessionLabels,
        private callbacks: MergeConflictSessionCallbacks,
    ) {
        this.panel = panel;
        this.updateLabels(labels);

        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (msg) => {
            const message: unknown = msg;
            try {
                await this.handleMessage(message);
            } catch (error) {
                if (!this.isAlive()) return;
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(message);
                try {
                    if (!this.isAlive()) return;
                    await this.panel.webview.postMessage({ type: "loadError", message });
                } catch {
                    // Panel may have been disposed between the active check and postMessage.
                }
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            if (MergeConflictSessionPanel.currentPanel === this) {
                MergeConflictSessionPanel.currentPanel = undefined;
            }
        });
    }

    /**
     * Opens or reveals the singleton conflict session panel for the active repository.
     *
     * Reusing an existing panel updates branch labels and callbacks, then refreshes its session
     * data without closing it even if the latest conflict list is empty.
     */
    static async open(
        extensionUri: vscode.Uri,
        gitOps: GitOps,
        labels: MergeConflictSessionLabels,
        callbacks: MergeConflictSessionCallbacks,
    ): Promise<void> {
        const existing = MergeConflictSessionPanel.currentPanel;
        if (existing && !existing.disposed) {
            existing.updateLabels(labels);
            existing.updateCallbacks(callbacks);
            existing.panel.reveal(vscode.ViewColumn.Active);
            await existing.postSessionData({ closeWhenResolved: false });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "intelligit.mergeConflictSession",
            "Conflicts",
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );

        const instance = new MergeConflictSessionPanel(
            panel,
            extensionUri,
            gitOps,
            labels,
            callbacks,
        );
        MergeConflictSessionPanel.currentPanel = instance;
        await instance.postSessionData({ closeWhenResolved: false });
    }

    /**
     * Refreshes the open conflict session and closes it when all conflicts have been resolved.
     */
    static async refreshIfOpen(): Promise<void> {
        const existing = MergeConflictSessionPanel.currentPanel;
        if (!existing || existing.disposed) return;
        await existing.postSessionData({ closeWhenResolved: true });
    }

    /**
     * Reports whether the singleton panel is still alive for command enablement checks.
     */
    static isOpen(): boolean {
        const panel = MergeConflictSessionPanel.currentPanel;
        return !!panel && !panel.disposed;
    }

    /**
     * Applies non-empty branch labels while preserving previous fallback labels.
     */
    private updateLabels(labels: MergeConflictSessionLabels): void {
        const source = labels.sourceBranch?.trim();
        const target = labels.targetBranch?.trim();
        this.sourceBranch = source || this.sourceBranch;
        this.targetBranch = target || this.targetBranch;
    }

    /**
     * Replaces host callbacks when an existing panel is reused for a new activation context.
     */
    private updateCallbacks(callbacks: MergeConflictSessionCallbacks): void {
        this.callbacks = callbacks;
    }

    /**
     * Validates and handles messages from the conflict session webview.
     *
     * Unknown message types are ignored. Empty or missing file paths are treated as no-ops, while
     * accept-side operations additionally validate repository-relative paths before invoking Git.
     */
    private async handleMessage(raw: unknown): Promise<void> {
        const msg = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        const type = typeof msg.type === "string" ? msg.type : "";
        switch (type) {
            case "ready":
            case "refresh":
                await this.postSessionData({ closeWhenResolved: false });
                return;

            case "openMerge": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                await this.callbacks.onOpenMergeConflict(filePath);
                await this.postSessionData({ closeWhenResolved: true });
                return;
            }

            case "acceptYours": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                const safePath = assertRepoRelativePath(filePath);
                // Conflict state refresh must wait until Git accepts the chosen side.
                // react-doctor-disable-next-line react-doctor/async-parallel
                await runWithNotificationProgress(
                    `Accepting yours for ${safePath}...`,
                    async () => {
                        await this.gitOps.acceptConflictSide(safePath, "ours");
                    },
                );
                await this.callbacks.onConflictStateChanged();
                await this.postSessionData({ closeWhenResolved: true });
                return;
            }

            case "acceptTheirs": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                const safePath = assertRepoRelativePath(filePath);
                // Conflict state refresh must wait until Git accepts the chosen side.
                // react-doctor-disable-next-line react-doctor/async-parallel
                await runWithNotificationProgress(
                    `Accepting theirs for ${safePath}...`,
                    async () => {
                        await this.gitOps.acceptConflictSide(safePath, "theirs");
                    },
                );
                await this.callbacks.onConflictStateChanged();
                await this.postSessionData({ closeWhenResolved: true });
                return;
            }

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
     * Extracts a non-empty file path from webview input without treating absence as an error.
     */
    private getFilePath(value: unknown): string | null {
        if (typeof value !== "string") return null;
        return value.trim().length > 0 ? value : null;
    }

    /** Confirms and aborts the active merge represented by this conflict session. */
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
        await this.callbacks.onConflictStateChanged();
        if (this.isAlive()) this.panel.dispose();
    }

    private isAlive(): boolean {
        return !this.disposed;
    }

    /**
     * Posts the latest conflict file details and optionally closes when the list becomes empty.
     *
     * Liveness checks bracket Git reads and postMessage calls because the user may close the panel
     * while a refresh or accept-side operation is awaiting asynchronous work.
     */
    private async postSessionData(options: { closeWhenResolved: boolean }): Promise<void> {
        if (!this.isAlive()) return;
        const files = await this.gitOps.getConflictFilesDetailed();
        if (this.isAlive()) {
            if (files.length === 0 && options.closeWhenResolved) {
                showTimedInformationMessage(vscode.l10n.t("All merge conflicts are resolved."));
                this.panel.dispose();
            } else {
                const data: MergeConflictSessionData = {
                    sourceBranch: this.sourceBranch,
                    targetBranch: this.targetBranch,
                    files,
                };

                if (!this.isAlive()) return;
                try {
                    await this.panel.webview.postMessage({ type: "setSessionData", data });
                } catch {
                    // Panel may have been disposed between the active check and postMessage.
                }
            }
        }
    }

    /**
     * Builds the conflict session shell with script and style resources scoped to the webview.
     */
    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-mergeconflictsession.js",
            styleFiles: ["webview-mergeconflictsession.css"],
            title: vscode.l10n.t("Conflicts"),
        });
    }
}
