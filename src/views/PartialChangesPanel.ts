import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { PartialEditorOutbound, PartialEditorReply } from "../webviews/protocol/changelists";
import type {
    ChangeFileView,
    ChangelistState,
    SelectedFileChanges,
} from "../webviews/protocol/changeSelection";
import { buildWebviewShellHtml } from "./webviewHtml";
import { captureWebview } from "../e2e/webviewCapture";
import { assertMessage } from "./messageValidation";
import { getErrorMessage } from "../utils/errors";

/** Captured-root operations injected by the owning Changes workflow. */
export interface PartialPanelActions {
    load(side: "working" | "index"): Promise<{
        file: ChangeFileView;
        contentId: string;
        lists: ChangelistState;
        listId: string;
        selectedOperations?: boolean;
    }>;
    stage(selection: SelectedFileChanges): Promise<void>;
    use(selection: SelectedFileChanges): Promise<void>;
    commit(selection: SelectedFileChanges, message: string): Promise<string>;
    assign(selection: SelectedFileChanges, listId: string, revision: number): Promise<void>;
    /** Optional host-owned save/export/removal operations; completion fences successful removals. */
    selected?(
        selection: SelectedFileChanges,
        operation: "save" | "shelve" | "rollback" | "export",
    ): Promise<{ message: string; removed: boolean }>;
    openNative(): Promise<void>;
}

/** Owns one fixed file session; its browser never supplies Git arguments or paths. */
export class PartialChangesPanel {
    private busy = false;
    private committed = false;
    private alive = true;
    private readonly panel: vscode.WebviewPanel;
    private side: "working" | "index" = "working";

    /** Creates the usable partial editor with the existing production shell and E2E boundary. */
    constructor(
        extensionUri: vscode.Uri,
        file: string,
        private readonly actions: PartialPanelActions,
    ) {
        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.partialChanges",
            vscode.l10n.t("Selected changes: {path}", { path: file }),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );
        this.panel = captureWebview(rawPanel, "partial-changes");
        this.panel.webview.html = buildWebviewShellHtml({
            webview: this.panel.webview,
            extensionUri,
            scriptFile: "webview-partialchanges.js",
            styleFiles: ["webview-partialchanges.css"],
            title: this.panel.title,
            backgroundVar: "var(--vscode-editor-background)",
            e2eViewId: `partial-changes:${randomUUID()}`,
        });
        this.panel.onDidDispose(() => {
            this.alive = false;
        });
        this.panel.webview.onDidReceiveMessage((raw: unknown) => {
            return this.handle(raw).catch((error: unknown) =>
                this.post({
                    type: "partialError",
                    message: vscode.l10n.t("Selected changes failed: {message}", {
                        message: getErrorMessage(error),
                    }),
                }),
            );
        });
    }

    private async handle(raw: unknown): Promise<void> {
        const message = assertMessage(raw) as unknown as PartialEditorOutbound;
        if (this.busy || this.committed) return;
        if (message.type === "openNative") return this.actions.openNative();
        if (message.type === "ready") {
            if (
                message.side !== undefined &&
                message.side !== "working" &&
                message.side !== "index"
            )
                return;
            this.side = message.side ?? this.side;
            return this.load();
        }
        if (
            ![
                "stageSelection",
                "commitSelection",
                "assignSelection",
                "useSelection",
                "saveSelection",
                "shelveSelection",
                "rollbackSelection",
                "exportSelection",
            ].includes(message.type)
        )
            return;
        this.busy = true;
        try {
            if (
                message.type === "saveSelection" ||
                message.type === "shelveSelection" ||
                message.type === "rollbackSelection" ||
                message.type === "exportSelection"
            ) {
                if (!this.actions.selected)
                    throw new Error("Selected shelf operations are unavailable.");
                const operation =
                    message.type === "saveSelection"
                        ? "save"
                        : message.type === "shelveSelection"
                          ? "shelve"
                          : message.type === "rollbackSelection"
                            ? "rollback"
                            : "export";
                let result: { message: string; removed: boolean };
                try {
                    result = await this.actions.selected(message.selection, operation);
                } catch (error) {
                    await this.reportSelectedError(error);
                    return;
                }
                await this.completeSelected(result);
            } else if (message.type === "useSelection") {
                await this.actions.use(message.selection);
                await this.load();
            } else if (message.type === "assignSelection") {
                await this.actions.assign(message.selection, message.listId, message.revision);
                await this.load();
            } else if (message.type === "stageSelection") {
                await this.actions.stage(message.selection);
                await this.post({ type: "partialStaged" });
                await this.load();
            } else if (message.type === "commitSelection") {
                const commit = await this.actions.commit(message.selection, message.message);
                this.committed = true;
                await this.post({ type: "partialCommitted", commit });
            }
        } finally {
            this.busy = false;
        }
    }

    private async load(): Promise<void> {
        const data = await this.actions.load(this.side);
        await this.post({ type: "partialFile", ...data });
    }

    /** Failed selected completion delivery is terminal and falls back to a native recovery notice. */
    private async completeSelected(result: { message: string; removed: boolean }): Promise<void> {
        this.committed = result.removed;
        try {
            if (
                !this.alive ||
                !(await this.panel.webview.postMessage({
                    type: "partialOperationCompleted",
                    ...result,
                }))
            )
                throw new Error("Selected completion could not be posted.");
        } catch (error) {
            this.committed = true;
            const warning = `${result.message} Completion delivery failed; do not repeat the operation.`;
            await vscode.window.showWarningMessage(warning);
            throw new Error(warning, { cause: error });
        }
    }

    /** Preserves selected-operation recovery errors when the webview cannot receive them, without inferring completion from text. */
    private async reportSelectedError(error: unknown): Promise<void> {
        const message = vscode.l10n.t("Selected changes failed: {message}", {
            message: getErrorMessage(error),
        });
        try {
            if (
                this.alive &&
                (await this.panel.webview.postMessage({ type: "partialError", message }))
            )
                return;
        } catch {
            // Native delivery retains the original host error rather than a transport failure.
        }
        this.committed = true;
        await vscode.window.showWarningMessage(message);
    }

    private async post(message: PartialEditorReply): Promise<void> {
        if (this.alive) await this.panel.webview.postMessage(message);
    }
}
