import path from "node:path";
import * as vscode from "vscode";
import { captureWebview } from "../e2e/webviewCapture";
import {
    detectEolMetadata,
    parseConflictVersions,
    type MergeDiffOptions,
    type MergeEditorData,
} from "../mergeEditor/conflictParser";
import { readEditorFontSize } from "../mergeEditor/editorFontSize";
import type {
    ApplyShelfConflictResolutionInput,
    ApplyShelfConflictResolutionResult,
    ShelfConflictSessionPayload,
} from "../services/shelfConflictSession";
import type { ShelfService } from "../services/shelfService";
import { getErrorMessage } from "../utils/errors";
import { buildWebviewShellHtml } from "./webviewHtml";

const MAX_APPLY_CONTENT_BYTES = 100 * 1024 * 1024;

/** Host dependencies extracted from the VS Code panel so message behavior is unit-testable. */
export interface ShelfConflictEditorMessageDeps {
    readonly shelfId: string;
    readonly changeId: string;
    readonly payload: ShelfConflictSessionPayload;
    readonly apply: (
        input: ApplyShelfConflictResolutionInput,
    ) => Promise<ApplyShelfConflictResolutionResult>;
    readonly postConflictData: (diffOptions: MergeDiffOptions) => Promise<void>;
    readonly chooseStaleResolution: () => Promise<"keep" | "overwrite">;
    readonly onApplied: () => Promise<void>;
    readonly dispose: () => void;
}

/** Options for one repository-scoped shelf conflict editor. */
export interface ShelfConflictEditorPanelOptions {
    readonly extensionUri: vscode.Uri;
    readonly repositoryRoot: string;
    readonly shelfService: Pick<
        ShelfService,
        "openShelfConflictSession" | "applyShelfConflictResolution"
    >;
    readonly shelfId: string;
    readonly changeId: string;
    readonly onApplied: () => Promise<void>;
}

/** Creates the untrusted-webview message handler without requiring a real WebviewPanel in tests. */
export function createShelfConflictEditorMessageHandler(
    dependencies: ShelfConflictEditorMessageDeps,
): (raw: unknown) => Promise<void> {
    const apply = async (content: string): Promise<void> => {
        const input = {
            id: dependencies.shelfId,
            changeId: dependencies.changeId,
            content,
            expectedShelfGeneration: dependencies.payload.shelfGeneration,
            expectedPathFingerprint: dependencies.payload.worktreeFingerprint,
        } satisfies ApplyShelfConflictResolutionInput;
        const result = await dependencies.apply(input);
        if (result.status === "stale") {
            if ((await dependencies.chooseStaleResolution()) !== "overwrite") return;
            const override = await dependencies.apply({
                ...input,
                staleOverride: "overwriteParkingCurrent",
            });
            await finishApply(override, dependencies);
            return;
        }
        await finishApply(result, dependencies);
    };

    return async (raw: unknown): Promise<void> => {
        const message =
            typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        switch (message.type) {
            case "ready":
                await dependencies.postConflictData({});
                return;
            case "setIgnoreMode":
                if (message.mode === "none" || message.mode === "whitespace") {
                    await dependencies.postConflictData({
                        ignoreWhitespace: message.mode === "whitespace",
                    });
                }
                return;
            case "applyResolution":
                if (typeof message.content !== "string") {
                    throw new Error("Shelf merge result payload must be a string.");
                }
                if (message.content.length > MAX_APPLY_CONTENT_BYTES) {
                    throw new Error("Shelf merge result payload exceeds the supported size.");
                }
                await apply(message.content);
                return;
            case "acceptYours":
                await apply(dependencies.payload.current);
                return;
            case "acceptTheirs":
                await apply(dependencies.payload.patchedBase);
                return;
            case "openConflictSession":
                return;
            case "abortMerge":
            case "close":
                dependencies.dispose();
                return;
            default:
                return;
        }
    };
}

async function finishApply(
    result: ApplyShelfConflictResolutionResult,
    dependencies: ShelfConflictEditorMessageDeps,
): Promise<void> {
    if (result.status === "stale") return;
    if (result.status === "refused") throw new Error(result.reason);
    await dependencies.onApplied();
    dependencies.dispose();
}

/** Hosts one working-tree-only editor per repository, shelf, and logical change. */
export class ShelfConflictEditorPanel {
    private static readonly panels = new Map<string, ShelfConflictEditorPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly key: string;
    private disposed = false;
    private payload: ShelfConflictSessionPayload | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly options: ShelfConflictEditorPanelOptions,
    ) {
        this.panel = panel;
        this.key = `${options.repositoryRoot}\u0000${options.shelfId}\u0000${options.changeId}`;
        panel.webview.html = buildWebviewShellHtml({
            extensionUri: options.extensionUri,
            webview: panel.webview,
            scriptFile: "webview-mergeeditor.js",
            styleFiles: ["webview-mergeeditor.css"],
            title: vscode.l10n.t("Resolve shelf conflict: {file}", {
                file: path.posix.basename(options.changeId),
            }),
            // One live panel per (repo, shelf, change), and the bundle is shared with
            // MergeEditorPanel -- the scriptFile-derived default would collide on both axes.
            e2eViewId: `shelf-conflict-editor\u0000${this.key}`,
        });
        panel.webview.onDidReceiveMessage(async (message) => {
            try {
                await this.handleMessage(message);
            } catch (error) {
                if (this.disposed) return;
                const text = getErrorMessage(error);
                vscode.window.showErrorMessage(text);
                await this.panel.webview.postMessage({ type: "loadError", message: text });
            }
        });
        panel.onDidDispose(() => {
            this.disposed = true;
            if (ShelfConflictEditorPanel.panels.get(this.key) === this) {
                ShelfConflictEditorPanel.panels.delete(this.key);
            }
        });
    }

    /** Reveals an existing session or opens one new shelf-only merge editor. */
    static async open(options: ShelfConflictEditorPanelOptions): Promise<void> {
        const key = `${options.repositoryRoot}\u0000${options.shelfId}\u0000${options.changeId}`;
        const existing = this.panels.get(key);
        if (existing && !existing.disposed) {
            existing.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.shelfConflictEditor",
            vscode.l10n.t("Resolve shelf conflict"),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, "dist")],
            },
        );
        const panel = captureWebview(rawPanel, "shelf-conflict-editor");
        const instance = new ShelfConflictEditorPanel(panel, options);
        this.panels.set(key, instance);
        try {
            await instance.load();
        } catch (error) {
            panel.dispose();
            throw error;
        }
    }

    private async load(): Promise<void> {
        const payload = await this.options.shelfService.openShelfConflictSession(
            this.options.shelfId,
            this.options.changeId,
        );
        this.payload = payload;
        this.panel.title = vscode.l10n.t("Resolve shelf conflict: {file}", {
            file: path.posix.basename(payload.path),
        });
        await this.postConflictData({});
    }

    private async handleMessage(raw: unknown): Promise<void> {
        if (!this.payload) {
            const type =
                typeof raw === "object" && raw !== null
                    ? (raw as Record<string, unknown>).type
                    : undefined;
            if (type === "ready") return;
            throw new Error("Shelf conflict session is not loaded.");
        }
        const handler = createShelfConflictEditorMessageHandler({
            shelfId: this.options.shelfId,
            changeId: this.options.changeId,
            payload: this.payload,
            apply: (input) => this.options.shelfService.applyShelfConflictResolution(input),
            postConflictData: (diffOptions) => this.postConflictData(diffOptions),
            chooseStaleResolution: () => this.chooseStaleResolution(),
            onApplied: this.options.onApplied,
            dispose: () => {
                this.panel.dispose();
            },
        });
        await handler(raw);
    }

    private async postConflictData(diffOptions: MergeDiffOptions): Promise<void> {
        if (!this.payload || this.disposed) return;
        const { base, current, patchedBase } = this.payload;
        const eol = detectEolMetadata(current, patchedBase, base);
        const data: MergeEditorData & { sessionKind: "shelf" } = {
            filePath: this.payload.path,
            segments: parseConflictVersions(base, current, patchedBase, diffOptions),
            oursLabel: "Local",
            theirsLabel: "Shelved",
            eol: eol.eol,
            hasTrailingNewline: eol.hasTrailingNewline,
            diffOptions,
            // Same source as `MergeEditorPanel`'s payload: both panels render through the SAME
            // webview and stylesheet, where an absent `editorFontSize` falls back to
            // `--vscode-editor-font-size` -- a variable that is unitless on some VS Code builds and
            // therefore ignored. Omitting it here made one `editor.fontSize` setting produce two
            // different code sizes depending on which of the two editors opened the conflict.
            editorFontSize: readEditorFontSize(),
            sessionKind: "shelf",
        };
        await this.panel.webview.postMessage({ type: "setConflictData", data });
    }

    private async chooseStaleResolution(): Promise<"keep" | "overwrite"> {
        // Bound to locals rather than repeated literals: `showWarningMessage` returns the button
        // label verbatim, so the comparison below must be the exact same localized string. Two
        // separate `l10n.t` calls would still agree, but a future edit to one literal and not the
        // other would silently degrade this to always-"keep".
        const overwriteLabel = vscode.l10n.t("Overwrite (previous content saved to recovery)");
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t("The shelf conflict changed while this editor was open."),
            { modal: true },
            vscode.l10n.t("Keep working tree"),
            overwriteLabel,
        );
        return choice === overwriteLabel ? "overwrite" : "keep";
    }
}
