// WebviewPanel for the 3-way merge conflict editor. Opens as an editor tab
// and shows ours/theirs/result columns with per-hunk accept/discard controls.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { parseConflictVersions } from "../mergeEditor/conflictParser";
import type { MergeDiffOptions, MergeEditorData } from "../mergeEditor/conflictParser";

export class MergeEditorPanel {
    private static panels = new Map<string, MergeEditorPanel>();

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private diffOptions: MergeDiffOptions = { ignoreWhitespace: false };

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private readonly workspaceRoot: vscode.Uri,
        private readonly filePath: string,
        private readonly oursSourceLabel: string,
        private readonly theirsSourceLabel: string,
        private readonly onResolved: () => void,
    ) {
        this.panel = panel;

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
        };

        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            MergeEditorPanel.panels.delete(filePath);
        });
    }

    static open(
        extensionUri: vscode.Uri,
        gitOps: GitOps,
        workspaceRoot: vscode.Uri,
        filePath: string,
        labels: { oursSourceLabel?: string; theirsSourceLabel?: string } | undefined,
        onResolved: () => void,
    ): void {
        const existing = MergeEditorPanel.panels.get(filePath);
        if (existing && !existing.disposed) {
            existing.panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "intelligit.mergeEditor",
            `Merge: ${filePath}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        const instance = new MergeEditorPanel(
            panel,
            extensionUri,
            gitOps,
            workspaceRoot,
            filePath,
            labels?.oursSourceLabel?.trim() || "current branch",
            labels?.theirsSourceLabel?.trim() || "incoming branch",
            onResolved,
        );
        MergeEditorPanel.panels.set(filePath, instance);
    }

    private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
        switch (msg.type) {
            case "ready":
                await this.loadConflictData();
                break;

            case "setIgnoreMode": {
                const mode = msg.mode === "whitespace" ? "whitespace" : "none";
                this.diffOptions = { ignoreWhitespace: mode === "whitespace" };
                await this.loadConflictData();
                break;
            }

            case "applyResolution": {
                if (typeof msg.content !== "string") {
                    vscode.window.showErrorMessage(
                        `Invalid merge resolution content for ${this.filePath}.`,
                    );
                    return;
                }
                const content = msg.content;
                const fileUri = vscode.Uri.joinPath(this.workspaceRoot, this.filePath);
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
                await this.gitOps.stageFile(this.filePath);
                vscode.window.showInformationMessage(`Resolved: ${this.filePath}`);
                this.onResolved();
                this.panel.dispose();
                break;
            }

            case "acceptYours": {
                await this.gitOps.acceptConflictSide(this.filePath, "ours");
                vscode.window.showInformationMessage(`Accepted yours: ${this.filePath}`);
                this.onResolved();
                this.panel.dispose();
                break;
            }

            case "acceptTheirs": {
                await this.gitOps.acceptConflictSide(this.filePath, "theirs");
                vscode.window.showInformationMessage(`Accepted theirs: ${this.filePath}`);
                this.onResolved();
                this.panel.dispose();
                break;
            }

            case "close":
                this.panel.dispose();
                break;
        }
    }

    private async loadConflictData(): Promise<void> {
        try {
            const versions = await this.gitOps.getConflictFileVersions(this.filePath);
            const segments = parseConflictVersions(
                versions.base,
                versions.ours,
                versions.theirs,
                this.diffOptions,
            );

            const data: MergeEditorData = {
                filePath: this.filePath,
                segments,
                oursLabel: this.oursSourceLabel,
                theirsLabel: this.theirsSourceLabel,
                diffOptions: this.diffOptions,
            };

            await this.panel.webview.postMessage({ type: "setConflictData", data });
        } catch (err) {
            const message = getErrorMessage(err);
            await this.panel.webview.postMessage({ type: "loadError", message });
        }
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-mergeeditor.js",
            styleFiles: ["webview-mergeeditor.css"],
            title: "Merge Editor",
        });
    }
}
