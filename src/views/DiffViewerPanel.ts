// Hosts one reusable, read-only two-pane diff viewer webview.

import * as path from "path";
import * as vscode from "vscode";
import { captureWebview } from "../e2e/webviewCapture";
import { computeDiffSegments } from "../diff/diffSegments";
import type {
    DiffViewerData,
    InboundMessage,
    OutboundMessage,
} from "../webviews/protocol/diffViewerTypes";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { buildWebviewShellHtml } from "./webviewHtml";

/** Inputs for one immutable pair of texts shown in the diff viewer. */
export interface DiffViewerPanelOptions {
    /** Extension installation URI used to resolve bundled webview assets. */
    extensionUri: vscode.Uri;
    /** Repository-relative path displayed in the panel title and header. */
    path: string;
    /** Label for the left source. */
    leftLabel: string;
    /** Label for the right source. */
    rightLabel: string;
    /** Syntax language id supplied by the host. */
    languageId: string;
    /** Already-loaded left source text. */
    leftText: string;
    /** Already-loaded right source text. */
    rightText: string;
}

interface DiffViewerSnapshot {
    path: string;
    leftLabel: string;
    rightLabel: string;
    languageId: string;
    leftText: string;
    rightText: string;
}

/** Owns the single reusable diff viewer panel and its in-memory source snapshot. */
export class DiffViewerPanel {
    private static instance: DiffViewerPanel | undefined;

    private disposed = false;
    private ignoreWhitespace = false;
    private snapshot: DiffViewerSnapshot;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        options: DiffViewerPanelOptions,
    ) {
        this.snapshot = DiffViewerPanel.snapshotFrom(options);
        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (raw: unknown) => {
            try {
                await this.handleMessage(raw);
            } catch (error) {
                if (!this.isAlive()) return;
                const message = getErrorMessage(error);
                void vscode.window.showErrorMessage(message);
                await this.post({ type: "loadError", message });
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            if (DiffViewerPanel.instance === this) DiffViewerPanel.instance = undefined;
        });
    }

    /** Opens the reusable panel, or reveals it and replaces its current snapshot. */
    static async open(options: DiffViewerPanelOptions): Promise<void> {
        const snapshot = DiffViewerPanel.snapshotFrom(options);
        const existing = DiffViewerPanel.instance;
        if (existing && existing.isAlive()) {
            existing.snapshot = snapshot;
            existing.panel.title = vscode.l10n.t("Diff: {file}", {
                file: path.posix.basename(snapshot.path),
            });
            existing.panel.reveal(vscode.ViewColumn.Active);
            await existing.postLatestData();
            return;
        }

        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.diffViewer",
            vscode.l10n.t("Diff: {file}", { file: path.posix.basename(snapshot.path) }),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, "dist")],
            },
        );
        const panel = captureWebview(rawPanel, "diff-viewer");
        const instance = new DiffViewerPanel(panel, options.extensionUri, options);
        DiffViewerPanel.instance = instance;
        await instance.postLatestData();
    }

    /** Reports whether the reusable diff viewer panel is currently alive. */
    static isOpen(): boolean {
        return DiffViewerPanel.instance?.isAlive() ?? false;
    }

    /** Builds the latest payload from the held texts without filesystem or Git access. */
    private buildData(): DiffViewerData {
        const { leftText, rightText, ...metadata } = this.snapshot;
        const computed = computeDiffSegments(leftText, rightText, {
            ignoreWhitespace: this.ignoreWhitespace,
        });
        return { ...metadata, ...computed, ignoreWhitespace: this.ignoreWhitespace };
    }

    /** Reposts the current in-memory snapshot to the webview. */
    private async postLatestData(): Promise<void> {
        if (!this.isAlive()) return;
        await this.post({ type: "setDiffData", data: this.buildData() });
    }

    /** Posts a host-to-webview message constrained to the inbound protocol. */
    private async post(message: InboundMessage): Promise<void> {
        await this.panel.webview.postMessage(message);
    }

    /** Validates and handles the small read-only viewer message protocol. */
    private async handleMessage(raw: unknown): Promise<void> {
        const message = raw as Partial<OutboundMessage>;
        if (message.type === "ready") {
            await this.postLatestData();
            return;
        }
        if (message.type === "setIgnoreMode") {
            if (message.mode !== "none" && message.mode !== "whitespace") return;
            this.ignoreWhitespace = message.mode === "whitespace";
            await this.postLatestData();
        }
    }

    /** Creates the localized shell for the viewer's dedicated bundle and capture context. */
    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-diffviewer.js",
            styleFiles: ["webview-diffviewer.css"],
            title: vscode.l10n.t("Diff: {file}", { file: path.posix.basename(this.snapshot.path) }),
            e2eViewId: "diff-viewer",
        });
    }

    /** Normalizes and snapshots options before any panel state is created. */
    private static snapshotFrom(options: DiffViewerPanelOptions): DiffViewerSnapshot {
        return {
            path: assertRepoRelativePath(options.path),
            leftLabel: options.leftLabel,
            rightLabel: options.rightLabel,
            languageId: options.languageId,
            leftText: options.leftText,
            rightText: options.rightText,
        };
    }

    private isAlive(): boolean {
        return !this.disposed;
    }
}
