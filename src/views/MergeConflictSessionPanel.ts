import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import type { MergeConflictSessionData } from "../webviews/react/merge-conflicts-session/types";

interface MergeConflictSessionLabels {
    sourceBranch?: string;
    targetBranch?: string;
}

interface MergeConflictSessionCallbacks {
    onOpenMergeConflict: (filePath: string) => Promise<void>;
    onConflictStateChanged: () => Promise<void>;
}

export class MergeConflictSessionPanel {
    private static currentPanel: MergeConflictSessionPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private sourceBranch = "incoming branch";
    private targetBranch = "current branch";

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        labels: MergeConflictSessionLabels,
        private readonly callbacks: MergeConflictSessionCallbacks,
    ) {
        this.panel = panel;
        this.updateLabels(labels);

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
        };

        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(message);
                await this.panel.webview.postMessage({ type: "loadError", message });
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            if (MergeConflictSessionPanel.currentPanel === this) {
                MergeConflictSessionPanel.currentPanel = undefined;
            }
        });
    }

    static async open(
        extensionUri: vscode.Uri,
        gitOps: GitOps,
        labels: MergeConflictSessionLabels,
        callbacks: MergeConflictSessionCallbacks,
    ): Promise<void> {
        const existing = MergeConflictSessionPanel.currentPanel;
        if (existing && !existing.disposed) {
            existing.updateLabels(labels);
            existing.panel.reveal(vscode.ViewColumn.Active);
            await existing.postSessionData({ closeWhenResolved: false });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "intelligit.mergeConflictSession",
            "Conflicts",
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
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

    static async refreshIfOpen(): Promise<void> {
        const existing = MergeConflictSessionPanel.currentPanel;
        if (!existing || existing.disposed) return;
        await existing.postSessionData({ closeWhenResolved: true });
    }

    static isOpen(): boolean {
        const panel = MergeConflictSessionPanel.currentPanel;
        return !!panel && !panel.disposed;
    }

    private updateLabels(labels: MergeConflictSessionLabels): void {
        const source = labels.sourceBranch?.trim();
        const target = labels.targetBranch?.trim();
        this.sourceBranch = source || this.sourceBranch;
        this.targetBranch = target || this.targetBranch;
    }

    private async handleMessage(msg: { type?: unknown; filePath?: unknown }): Promise<void> {
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
                await runWithNotificationProgress(
                    `Accepting yours for ${filePath}...`,
                    async () => {
                        await this.gitOps.acceptConflictSide(filePath, "ours");
                    },
                );
                await this.callbacks.onConflictStateChanged();
                await this.postSessionData({ closeWhenResolved: true });
                return;
            }

            case "acceptTheirs": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                await runWithNotificationProgress(
                    `Accepting theirs for ${filePath}...`,
                    async () => {
                        await this.gitOps.acceptConflictSide(filePath, "theirs");
                    },
                );
                await this.callbacks.onConflictStateChanged();
                await this.postSessionData({ closeWhenResolved: true });
                return;
            }

            case "close":
                this.panel.dispose();
                return;

            default:
                return;
        }
    }

    private getFilePath(value: unknown): string | null {
        if (typeof value !== "string") return null;
        const filePath = value.trim();
        return filePath ? filePath : null;
    }

    private async postSessionData(options: { closeWhenResolved: boolean }): Promise<void> {
        const files = await this.gitOps.getConflictFilesDetailed();
        if (files.length === 0 && options.closeWhenResolved) {
            vscode.window.showInformationMessage("All merge conflicts are resolved.");
            this.panel.dispose();
            return;
        }

        const data: MergeConflictSessionData = {
            sourceBranch: this.sourceBranch,
            targetBranch: this.targetBranch,
            files,
        };

        await this.panel.webview.postMessage({ type: "setSessionData", data });
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-mergeconflictsession.js",
            styleFiles: ["webview-mergeconflictsession.css"],
            title: "Conflicts",
        });
    }
}
