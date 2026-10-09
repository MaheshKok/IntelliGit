// Hosts IntelliGit's native three-way merge editor webview for one conflicted file.
// Loads base/ours/theirs from Git index stages, streams parsed segments to the
// webview, and applies resolutions by writing the merged file and staging it.

import { parseMergeDraft } from "../webviews/protocol/mergeWorkbench";
import * as path from "path";
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { areSameRepositoryRoot } from "../utils/repositoryRoot";
import type { MergeResolutionSnapshot } from "../git/mergeResolution";
import { DiffSyntaxThemeService } from "./shared/DiffSyntaxThemeService";
import { captureWebview } from "../e2e/webviewCapture";
import { GitOps } from "../git/operations";
import {
    detectEolMetadata,
    parseConflictVersions,
    type MergeDiffOptions,
    type MergeEditorData,
} from "../mergeEditor/conflictParser";
import { readEditorFontSize } from "../mergeEditor/editorFontSize";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import {
    runWithNotificationProgress,
    showTimedInformationMessage,
    showTimedWarningMessage,
} from "../utils/notifications";
import { abortMergeWithConfirmation } from "./mergeAbort";
import { buildWebviewShellHtml } from "./webviewHtml";

/**
 * Inputs required to open the native merge editor for one repository-relative file.
 *
 * `getRepoRoot` supplies the canonical root at open time. The panel captures that root and
 * derives fixed Git operations so later active-repository changes cannot retarget writes.
 */
export interface MergeEditorPanelOptions {
    extensionUri: vscode.Uri;
    gitOps: GitOps;
    getRepoRoot: () => string;
    filePath: string;
    onConflictStateChanged: () => Promise<void>;
    onOpenConflictSession?: () => Promise<void>;
    draftStore?: vscode.Memento;
}

/** Maximum merged-file payload accepted from the webview, guarding runaway messages. */
const MAX_APPLY_CONTENT_BYTES = 2 * 1024 * 1024;

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
    private static readonly draftQueues = new Map<string, Promise<void>>();

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private diffOptions: MergeDiffOptions = {};
    private snapshot?: MergeResolutionSnapshot;
    private applying = false;
    private applied = false;
    private loading?: Promise<void>;
    private loadedData?: MergeEditorData;
    private readonly syntaxTheme: DiffSyntaxThemeService;

    /**
     * Binds webview HTML, message handling, and disposal tracking for a new panel.
     */
    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private readonly repoRoot: string,
        private readonly panelKey: string,
        private readonly safePath: string,
        private onConflictStateChanged: () => Promise<void>,
        private onOpenConflictSession?: () => Promise<void>,
        private readonly draftStore?: vscode.Memento,
    ) {
        this.panel = panel;
        this.syntaxTheme = new DiffSyntaxThemeService(
            panel.webview,
            vscode.Uri.file(path.join(repoRoot, safePath)),
        );
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
                    await this.panel.webview.postMessage(
                        this.snapshot
                            ? { type: "resolutionError", message: errorMessage }
                            : { type: "loadError", message: errorMessage, nativeMerge: true },
                    );
                } catch {
                    // Panel may have been disposed between the liveness check and postMessage.
                }
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            this.syntaxTheme.dispose();
            if (MergeEditorPanel.panels.get(this.panelKey) === this) {
                MergeEditorPanel.panels.delete(this.panelKey);
            }
        });
    }

    /**
     * Opens or reveals the native merge editor for a repository-relative conflict file.
     *
     * The path is validated before any panel state exists. Reopening an existing panel
     * refreshes callbacks without reseeding an unsaved result.
     */
    static open(options: MergeEditorPanelOptions): Promise<void> {
        let safePath: string;
        try {
            safePath = assertRepoRelativePath(options.filePath);
        } catch (error) {
            return Promise.reject(new Error(getErrorMessage(error)));
        }

        const repoRoot = path.resolve(options.getRepoRoot());
        const panelKey = JSON.stringify([repoRoot, safePath]);
        const existing = MergeEditorPanel.panels.get(panelKey);
        if (existing && !existing.disposed) {
            existing.onConflictStateChanged = options.onConflictStateChanged;
            existing.onOpenConflictSession = options.onOpenConflictSession;
            existing.panel.reveal(vscode.ViewColumn.Active);
            // Revealing an existing session must never reseed an unsaved result.
            return Promise.resolve();
        }

        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.mergeEditor",
            vscode.l10n.t("Merge: {file}", { file: path.posix.basename(safePath) }),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, "dist")],
            },
        );
        const panel = captureWebview(rawPanel, "merge-editor");

        const instance = new MergeEditorPanel(
            panel,
            options.extensionUri,
            options.gitOps.deriveFor(repoRoot),
            repoRoot,
            panelKey,
            safePath,
            options.onConflictStateChanged,
            options.onOpenConflictSession,
            options.draftStore,
        );
        MergeEditorPanel.panels.set(panelKey, instance);
        return Promise.resolve();
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
        if (!this.isAlive()) return;
        const msg = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        const type = typeof msg.type === "string" ? msg.type : "";
        switch (type) {
            case "requestSyntaxTheme":
                await this.syntaxTheme.publish();
                return;
            case "ready":
                this.loading ??= this.postConflictData().finally(() => {
                    this.loading = undefined;
                });
                await this.loading;
                return;

            case "loadMergeDraft":
                await this.loadDraft();
                return;
            case "saveMergeDraft": {
                await this.saveDraft(msg);
                return;
            }
            case "discardMergeDraft":
                await this.queueDraftUpdate(async () => {
                    const previous = parseMergeDraft(this.draftStore?.get(this.draftKey));
                    if (previous?.snapshotId === msg.snapshotId)
                        await this.draftStore?.update(this.draftKey, undefined);
                });
                return;

            case "setIgnoreMode": {
                // Comparison-policy changes must not replace an editable result or its anchors.
                if (this.snapshot) return;
                const mode = msg.mode;
                if (mode !== "none" && mode !== "whitespace") return;
                this.diffOptions = { ignoreWhitespace: mode === "whitespace" };
                await this.postConflictData();
                return;
            }

            case "applyResolution": {
                if (msg.snapshotId !== this.snapshot?.id)
                    throw new Error(
                        vscode.l10n.t(
                            "The conflict session changed. Reopen the merge editor before applying.",
                        ),
                    );
                const content = msg.content;
                if (typeof content !== "string") {
                    throw new Error(vscode.l10n.t("Merge result payload must be a string."));
                }
                if (content.length > MAX_APPLY_CONTENT_BYTES) {
                    throw new Error(
                        vscode.l10n.t("Merge result payload exceeds the supported size."),
                    );
                }
                await this.applyResolvedContent(content);
                return;
            }

            case "acceptYours":
                if (this.snapshot) await this.applyResolvedContent(this.snapshot.ours);
                return;

            case "acceptTheirs":
                if (this.snapshot) await this.applyResolvedContent(this.snapshot.theirs);
                return;

            case "openConflictSession":
                if (this.onOpenConflictSession) {
                    await this.onOpenConflictSession();
                } else {
                    await vscode.commands.executeCommand("intelligit.openConflictSession");
                }
                return;

            case "abortMerge":
                await this.abortMerge();
                return;

            case "close":
                await this.draftQueue;
                this.panel.dispose();
                return;

            case "openNativeMerge": {
                const uri = vscode.Uri.file(path.join(this.repoRoot, this.safePath));
                try {
                    await vscode.commands.executeCommand("git.openMergeEditor", uri);
                } catch {
                    await vscode.commands.executeCommand("vscode.open", uri);
                }
                return;
            }
            default:
                return;
        }
    }

    /**
     * Writes webview-produced merged content to the working tree and stages the file.
     *
     * The write targets the repository root captured at open time so a repository
     * switch mid-session cannot redirect the file outside the original work tree.
     */
    private async applyResolvedContent(content: string): Promise<void> {
        if (this.applying) return;
        const snapshot = this.snapshot;
        if (!snapshot)
            throw new Error(vscode.l10n.t("Load the conflict before applying a resolution."));
        this.applying = true;
        try {
            await runWithNotificationProgress(
                vscode.l10n.t("Applying merge result for {path}...", { path: this.safePath }),
                async () => {
                    await this.gitOps.applyMergeResolution(this.safePath, snapshot, content, () =>
                        this.assertNoDirtyEditor(),
                    );
                },
            );
            this.applied = true;
            await this.panel.webview.postMessage({ type: "resolutionApplied" });
            await this.queueDraftUpdate(async () => {
                const previous = parseMergeDraft(this.draftStore?.get(this.draftKey));
                if (previous?.snapshotId === snapshot.id)
                    await this.draftStore?.update(this.draftKey, undefined);
            });
            showTimedInformationMessage(
                vscode.l10n.t("Merged and staged: {path}", { path: this.safePath }),
            );
            await this.notifyConflictStateChanged();
            if (this.isAlive()) this.panel.dispose();
        } finally {
            this.applying = false;
        }
    }

    /** Refuses dirty buffers even when the workspace spells the same path through an alias. */
    private async assertNoDirtyEditor(): Promise<void> {
        const target = await realpath(path.join(this.repoRoot, this.safePath));
        const documents = vscode.workspace.textDocuments ?? [];
        for (const document of documents) {
            if (!document.isDirty || document.uri.scheme !== "file") continue;
            // Workspace aliases (including macOS /var) must not bypass unsaved-buffer protection.
            const candidate = await realpath(document.uri.fsPath).catch(() => document.uri.fsPath);
            if (document.isDirty && areSameRepositoryRoot(target, candidate)) {
                throw new Error(
                    vscode.l10n.t(
                        "The file has unsaved editor changes. Save or discard them before applying; your merge draft is retained.",
                    ),
                );
            }
        }
    }

    /** Confirms and aborts the repository merge backing this editor panel. */
    private async abortMerge(): Promise<void> {
        await abortMergeWithConfirmation({
            gitOps: this.gitOps,
            onConflictStateChanged: () => this.notifyConflictStateChanged(),
            disposePanel: () => {
                if (this.isAlive()) this.panel.dispose();
            },
        });
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

    /** Waits for prior owners' writes before loading the durable recovery copy. */
    private async loadDraft(): Promise<void> {
        await this.draftQueue;
        if (!this.isAlive()) return;
        await this.panel.webview.postMessage({
            type: "mergeDraft",
            draft: parseMergeDraft(this.draftStore?.get(this.draftKey)),
        });
    }

    /** Validates and acknowledges a serialized draft without replacing an earlier operation. */
    private async saveDraft(msg: Record<string, unknown>): Promise<void> {
        const draft = parseMergeDraft(msg.draft);
        if (!draft || draft.snapshotId !== this.snapshot?.id || !Number.isSafeInteger(msg.revision))
            return;
        await this.queueDraftUpdate(async () => {
            if (this.applied || !this.draftStore) return;
            const previous = parseMergeDraft(this.draftStore.get(this.draftKey));
            if (previous && previous.snapshotId !== draft.snapshotId) return;
            await this.draftStore.update(this.draftKey, draft);
            if (this.isAlive())
                await this.panel.webview.postMessage({
                    type: "mergeDraftSaved",
                    revision: msg.revision,
                });
        });
    }

    /** Orders writes across panel lifetimes; superseded owners cannot enqueue stale recovery text. */
    private queueDraftUpdate(update: () => Promise<void>): Promise<void> {
        const pending = this.draftQueue.then(async () => {
            if (!this.isAlive() || MergeEditorPanel.panels.get(this.panelKey) !== this) return;
            await update();
        });
        const settled = pending.catch(() => undefined);
        MergeEditorPanel.draftQueues.set(this.draftKey, settled);
        void settled.then(() => {
            if (MergeEditorPanel.draftQueues.get(this.draftKey) === settled)
                MergeEditorPanel.draftQueues.delete(this.draftKey);
        });
        return pending;
    }

    /** Reopened panels wait for writes already in flight for the same durable draft key. */
    private get draftQueue(): Promise<void> {
        return MergeEditorPanel.draftQueues.get(this.draftKey) ?? Promise.resolve();
    }

    private isAlive(): boolean {
        return !this.disposed;
    }

    private get draftKey(): string {
        return "mergeDraft." + createHash("sha256").update(this.panelKey).digest("hex");
    }

    /**
     * Loads Git stage versions, parses merge segments, and posts them to the webview.
     *
     * A file with no stage entries is reported as a load error instead of rendering an
     * empty editor, because that state means the file is not actually conflicted.
     */
    private async postConflictData(): Promise<void> {
        if (!this.isAlive()) return;
        if (this.loadedData) {
            await this.panel.webview.postMessage({
                type: "setConflictData",
                data: this.loadedData,
            });
            return;
        }
        const versions = await this.gitOps.openMergeResolution(this.safePath);
        if (this.isAlive()) {
            if (versions.base === "" && versions.ours === "" && versions.theirs === "") {
                await this.panel.webview.postMessage({
                    type: "loadError",
                    message: vscode.l10n.t("File is not in a conflicted state: {path}", {
                        path: this.safePath,
                    }),
                    nativeMerge: true,
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
                        workbench: {
                            snapshotId: versions.id,
                            draftKey: this.draftKey,
                            base: versions.base,
                            ours: versions.ours,
                            theirs: versions.theirs,
                            operation: await this.gitOps.getActiveOperation(),
                        },
                        filePath: this.safePath,
                        segments,
                        oursLabel: labels.ours,
                        theirsLabel: labels.theirs,
                        eol: eolMetadata.eol,
                        hasTrailingNewline: eolMetadata.hasTrailingNewline,
                        diffOptions: this.diffOptions,
                        editorFontSize: readEditorFontSize(),
                    };

                    await this.panel.webview.postMessage({ type: "setConflictData", data });
                    this.snapshot = versions;
                    this.loadedData = data;
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
            // One live panel per conflicted file, and the bundle is shared with
            // ShelfConflictEditorPanel -- the scriptFile-derived default would collide on both axes.
            e2eViewId: `merge-editor\u0000${this.safePath}`,
        });
    }
}
