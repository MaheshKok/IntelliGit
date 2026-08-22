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
    /** Optional panel title; the path-derived localized title is used when absent. */
    title?: string;
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
    /** Internal generation binding used to protect the reusable panel from stale cleanup. */
    sessionGeneration?: number;
    /** Cancels the session's delegate when this panel is disposed. */
    onSessionDisposed?: () => void;
}

/** Generation binding used by the host to guard panel cleanup. */
export interface DiffViewerPanelSessionBinding {
    readonly generation: number;
    readonly onDispose: () => void;
}

interface DiffViewerSnapshot {
    path: string;
    title?: string;
    leftLabel: string;
    rightLabel: string;
    languageId: string;
    leftText: string;
    rightText: string;
}

/** Owns the single reusable diff viewer panel and its in-memory source snapshot. */
export class DiffViewerPanel {
    private static instance: DiffViewerPanel | undefined;
    private static pendingSession: DiffViewerPanelSessionBinding | undefined;

    private disposed = false;
    private ignoreWhitespace = false;
    private snapshot: DiffViewerSnapshot;
    private loadError: string | undefined;
    private sessionGeneration: number | undefined;
    private onSessionDisposed: (() => void) | undefined;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        options: DiffViewerPanelOptions,
    ) {
        this.snapshot = DiffViewerPanel.snapshotFrom(options);
        this.sessionGeneration = options.sessionGeneration;
        this.onSessionDisposed = options.onSessionDisposed;
        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (raw: unknown) => {
            try {
                await this.handleMessage(raw);
            } catch (error) {
                if (!this.isAlive()) return;
                const message = getErrorMessage(error);
                void vscode.window.showErrorMessage(message);
                this.loadError = message;
                await this.postLatestData();
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            const onSessionDisposed = this.onSessionDisposed;
            this.sessionGeneration = undefined;
            this.onSessionDisposed = undefined;
            if (DiffViewerPanel.instance === this) DiffViewerPanel.instance = undefined;
            onSessionDisposed?.();
        });
    }

    /** Claims the reusable panel for a generation before its asynchronous load completes. */
    static claimSession(binding: DiffViewerPanelSessionBinding): void {
        const existing = DiffViewerPanel.instance;
        if (existing && existing.isAlive()) {
            existing.bindSession(binding);
            return;
        }
        if (
            DiffViewerPanel.pendingSession === undefined ||
            DiffViewerPanel.pendingSession.generation < binding.generation
        ) {
            DiffViewerPanel.pendingSession = binding;
        }
    }

    /** Clears only the session that still owns the panel; newer bindings are untouched. */
    static clearSessionBinding(generation: number): boolean {
        let cleared = false;
        if (DiffViewerPanel.pendingSession?.generation === generation) {
            DiffViewerPanel.pendingSession = undefined;
            cleared = true;
        }
        const existing = DiffViewerPanel.instance;
        if (!existing || existing.sessionGeneration !== generation) return cleared;
        existing.sessionGeneration = undefined;
        return true;
    }

    /** Posts a generation-checked refresh error while retaining the currently rendered snapshots. */
    static async postLoadError(generation: number, message: string): Promise<void> {
        const existing = DiffViewerPanel.instance;
        if (!existing || !existing.isAlive() || existing.sessionGeneration !== generation) return;
        existing.loadError = message;
        await existing.postLatestData();
    }

    /** Opens the reusable panel, or reveals it and replaces its current snapshot. */
    static async open(options: DiffViewerPanelOptions): Promise<void> {
        const snapshot = DiffViewerPanel.snapshotFrom(options);
        const existing = DiffViewerPanel.instance;
        if (existing && existing.isAlive()) {
            if (options.sessionGeneration !== undefined) {
                if (
                    existing.sessionGeneration !== undefined &&
                    existing.sessionGeneration > options.sessionGeneration
                ) {
                    return;
                }
                existing.bindSession({
                    generation: options.sessionGeneration,
                    onDispose: options.onSessionDisposed ?? (() => undefined),
                });
            }
            existing.snapshot = snapshot;
            existing.loadError = undefined;
            existing.panel.title = DiffViewerPanel.panelTitle(snapshot);
            existing.panel.reveal(vscode.ViewColumn.Active);
            await existing.postLatestData();
            return;
        }

        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.diffViewer",
            DiffViewerPanel.panelTitle(snapshot),
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
        if (DiffViewerPanel.pendingSession?.generation === options.sessionGeneration) {
            DiffViewerPanel.pendingSession = undefined;
        }
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
        return {
            ...metadata,
            ...computed,
            ignoreWhitespace: this.ignoreWhitespace,
            loadError: this.loadError,
        };
    }

    /** Reposts the current in-memory snapshot and its active refresh error to the webview. */
    private async postLatestData(): Promise<void> {
        if (!this.isAlive()) return;
        // Keep payload construction before the first await: rapid optimistic toggles
        // must stamp their own mode before the next message handler can run.
        const message: InboundMessage = { type: "setDiffData", data: this.buildData() };
        await this.post(message);
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
            title: DiffViewerPanel.panelTitle(this.snapshot),
            e2eViewId: "diff-viewer",
        });
    }

    /** Normalizes and snapshots options before any panel state is created. */
    private static snapshotFrom(options: DiffViewerPanelOptions): DiffViewerSnapshot {
        return {
            path: assertRepoRelativePath(options.path),
            title: options.title,
            leftLabel: options.leftLabel,
            rightLabel: options.rightLabel,
            languageId: options.languageId,
            leftText: options.leftText,
            rightText: options.rightText,
        };
    }

    /** Resolves the caller's title or the existing localized path-based fallback. */
    private static panelTitle(snapshot: DiffViewerSnapshot): string {
        return (
            snapshot.title ??
            vscode.l10n.t("Diff: {file}", { file: path.posix.basename(snapshot.path) })
        );
    }

    private isAlive(): boolean {
        return !this.disposed;
    }

    private bindSession(binding: DiffViewerPanelSessionBinding): void {
        if (this.sessionGeneration !== undefined && this.sessionGeneration > binding.generation) {
            return;
        }
        this.sessionGeneration = binding.generation;
        this.onSessionDisposed = binding.onDispose;
    }
}
