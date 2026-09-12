import * as path from "node:path";
import { createReadonlyDiffUri } from "../services/diffService";
import { createLanguageAssociations } from "../utils/languageAssociations";
import { assertRepoRelativePath } from "../utils/fileOps";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import {
    getFileHistory,
    getFileHistoryParentPath,
    type FileHistoryEntry,
} from "../git/fileHistory";
import { loadDiffSide, toViewerSide } from "../diff/sideLoader";
import { exceedsDiffBudget } from "../diff/diffBudgets";
import { computeDiffSegments } from "../diff/diffSegments";
import { buildWebviewShellHtml } from "./webviewHtml";
import { captureWebview } from "../e2e/webviewCapture";
import { getErrorMessage } from "../utils/errors";
import { DiffViewerPanel } from "./DiffViewerPanel";
import type {
    HistoryInbound,
    HistoryOutbound,
    FileHistoryState,
} from "../webviews/protocol/fileHistory";

/** Inputs captured before opening a root-bound history window. */
export interface FileHistoryPanelOptions {
    extensionUri: vscode.Uri;
    repoRoot: string;
    filePath: string;
}

/** Owns the standalone file history window. */
export class FileHistoryPanel {
    private static readonly windows = new Map<string, FileHistoryPanel>();
    private readonly executor: GitExecutor;
    private readonly disposables: vscode.Disposable[] = [];
    private entries: FileHistoryEntry[] = [];
    private ref = "HEAD";
    private snapshotRef = "HEAD";
    private limit = 100;
    private generation = 0;
    private previewGeneration = 0;
    private closed = false;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly options: FileHistoryPanelOptions,
        key: string,
    ) {
        this.executor = new GitExecutor(options.repoRoot);
        this.disposables.push(
            panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw)),
        );
        panel.onDidDispose(() => {
            this.closed = true;
            this.generation++;
            this.previewGeneration++;
            this.disposables.forEach((d) => {
                d.dispose();
            });
            FileHistoryPanel.windows.delete(key);
        });
        panel.webview.html = buildWebviewShellHtml({
            extensionUri: options.extensionUri,
            webview: panel.webview,
            scriptFile: "webview-filehistory.js",
            styleFiles: ["webview-filehistory.css"],
            title: panel.title,
            e2eViewId: "file-history",
        });
    }

    /** Opens or reveals one file's window; only newly created panels are moved. */
    static async open(options: FileHistoryPanelOptions): Promise<void> {
        const key = JSON.stringify([options.repoRoot, options.filePath]);
        const existing = this.windows.get(key);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        const rawPanel = vscode.window.createWebviewPanel(
            "intelligit.fileHistory",
            vscode.l10n.t("History: {file}", { file: options.filePath }),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, "dist")],
            },
        );
        const panel = captureWebview(rawPanel, "file-history");
        this.windows.set(key, new FileHistoryPanel(panel, options, key));
        try {
            await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
        } catch (error) {
            await vscode.window.showWarningMessage(
                vscode.l10n.t("Unable to move History to a new window: {message}", {
                    message: getErrorMessage(error),
                }),
            );
        }
    }

    /** Validates webview commands against host-owned history before executing them. */
    private async receive(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== "object" || this.closed) return;
        const message = raw as Partial<HistoryOutbound>;
        try {
            if (message.type === "historyReady") await this.refresh();
            else if (message.type === "historyRefresh") {
                if (message.ref !== undefined && typeof message.ref !== "string") return;
                this.ref = message.ref ?? this.ref;
                this.limit = 100;
                await this.refresh();
            } else if (message.type === "historyMore") {
                this.limit += 100;
                await this.refresh(false);
            } else if (
                message.type === "historySelect" &&
                Array.isArray(message.hashes) &&
                Number.isSafeInteger(message.requestId)
            ) {
                if (!message.hashes.every((h) => typeof h === "string")) return;
                await this.select(message as Extract<HistoryOutbound, { type: "historySelect" }>);
            } else if (message.type === "historyAction" && typeof message.hash === "string") {
                const entry = this.entries.find((e) => e.hash === message.hash);
                if (entry) await this.action(entry, message.action);
            }
        } catch (error) {
            await this.post({ type: "historyError", message: getErrorMessage(error) });
        }
    }

    /** Reloads one immutable ref snapshot, retaining rename continuity when extending the limit. */
    private async refresh(resolveRef = true): Promise<void> {
        const generation = ++this.generation;
        this.previewGeneration++;
        try {
            const ref = this.ref;
            const limit = this.limit;
            const snapshot = resolveRef
                ? (
                      await this.executor.run([
                          "rev-parse",
                          "--verify",
                          "--end-of-options",
                          `${ref}^{commit}`,
                      ])
                  ).trim()
                : this.snapshotRef;
            if (generation !== this.generation || this.closed) return;
            const result = await getFileHistory(this.executor, this.options.filePath, {
                ref: snapshot,
                limit,
            });
            const branches = (
                await this.executor.run([
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads",
                    "refs/remotes",
                ])
            )
                .trim()
                .split("\n")
                .filter(Boolean);
            if (generation !== this.generation || this.closed) return;
            this.snapshotRef = snapshot;
            this.entries = result.entries;
            const state: FileHistoryState = {
                path: this.options.filePath,
                root: this.options.repoRoot,
                ref,
                branches,
                ...result,
                labels: historyLabels(),
            };
            await this.post({ type: "historyState", state });
        } catch (error) {
            if (generation === this.generation)
                await this.post({ type: "historyError", message: getErrorMessage(error) });
        }
    }

    /** Loads immutable sides separately so old names survive renames and deletions. */
    private async select(
        message: Extract<HistoryOutbound, { type: "historySelect" }>,
    ): Promise<void> {
        const selected = this.entries.filter((e) => message.hashes.includes(e.hash));
        if (selected.length === 0 || selected.length !== new Set(message.hashes).size) return;
        const generation = ++this.previewGeneration;
        try {
            const newer = selected[0];
            const older = selected.length > 1 ? selected[selected.length - 1] : undefined;
            let parent: string | undefined = newer.parents[0];
            if (!message.local && !older && newer.parents.length > 1) {
                parent = await vscode.window.showQuickPick(newer.parents, {
                    title: vscode.l10n.t("Choose merge parent"),
                });
                if (!parent) {
                    await this.post({
                        type: "historyDiff",
                        requestId: message.requestId,
                        error: vscode.l10n.t("No merge parent selected."),
                    });
                    return;
                }
            }
            const beforeRef = message.local ? newer.hash : (older?.hash ?? parent);
            const beforePath = message.local
                ? newer.pathAtRevision
                : (older?.pathAtRevision ??
                  (parent
                      ? await getFileHistoryParentPath(this.executor, newer, parent)
                      : newer.pathAtRevision));
            const left = beforeRef
                ? await this.load(beforeRef, beforePath)
                : toViewerSide({ status: "missing" });
            const right = message.local
                ? await this.load(null, this.options.filePath)
                : await this.load(newer.hash, newer.pathAtRevision);
            if (generation !== this.previewGeneration || this.closed) return;
            if (exceedsDiffBudget(left, right))
                throw new Error(vscode.l10n.t("This file exceeds the diff viewer size limit."));
            const data = {
                path: this.options.filePath,
                languageId: this.languageId(),
                documentId: JSON.stringify([
                    this.options.repoRoot,
                    beforeRef,
                    beforePath,
                    newer.hash,
                    message.local,
                ]),
                leftLabel: `${beforeRef?.slice(0, 8) ?? "∅"} ${beforePath}`,
                rightLabel: message.local
                    ? vscode.l10n.t("Working tree")
                    : `${newer.hash.slice(0, 8)} ${newer.pathAtRevision}`,
                ...computeDiffSegments(left.text, right.text, {
                    ignoreWhitespace: message.ignoreWhitespace === true,
                }),
                ignoreWhitespace: message.ignoreWhitespace === true,
            };
            await this.post({ type: "historyDiff", requestId: message.requestId, data });
        } catch (error) {
            if (generation === this.previewGeneration)
                await this.post({
                    type: "historyDiff",
                    requestId: message.requestId,
                    error: getErrorMessage(error),
                });
        }
    }

    /** Preserves unsupported/missing distinctions from the shared bounded side loader. */
    private async load(ref: string | null, filePath: string) {
        if (assertRepoRelativePath(filePath) !== filePath)
            throw new Error(vscode.l10n.t("This filename is not supported by the diff viewer."));
        const result = await loadDiffSide({
            repoRoot: this.options.repoRoot,
            filePath,
            side: ref ? { kind: "ref", ref } : { kind: "worktree" },
        });
        if (result.status === "over-budget" || result.status === "ineligible")
            throw new Error(
                vscode.l10n.t("This file cannot be displayed by the diff viewer: {reason}", {
                    reason: result.status === "ineligible" ? result.reason : result.status,
                }),
            );
        return toViewerSide(result);
    }

    /** Runs only file-history inspection actions with a validated selected revision. */
    private async action(entry: FileHistoryEntry, action: string | undefined): Promise<void> {
        if (action === "copy") await vscode.env.clipboard.writeText(entry.hash);
        else if (action === "open") {
            const side = await this.load(entry.hash, entry.pathAtRevision);
            const doc = await vscode.workspace.openTextDocument(
                createReadonlyDiffUri(entry.pathAtRevision, side.text, entry.hash.slice(0, 8)),
            );
            await vscode.window.showTextDocument(doc, { preview: true });
        } else if (action === "affected") {
            const parent =
                entry.parents.length > 1
                    ? await vscode.window.showQuickPick(entry.parents, {
                          title: vscode.l10n.t("Choose merge parent"),
                      })
                    : entry.parents[0];
            if (entry.parents.length > 1 && !parent) return;
            const files = (
                await this.executor.run([
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    "-z",
                    ...(parent ? [parent] : []),
                    entry.hash,
                ])
            )
                .split("\0")
                .filter(Boolean);
            await vscode.window.showQuickPick(files, {
                title: vscode.l10n.t("Files affected in {revision}", {
                    revision: entry.hash.slice(0, 8),
                }),
            });
        } else if (action === "diff") {
            const parent =
                entry.parents.length > 1
                    ? await vscode.window.showQuickPick(entry.parents, {
                          title: vscode.l10n.t("Choose merge parent"),
                      })
                    : entry.parents[0];
            if (entry.parents.length > 1 && !parent) return;
            const left = parent
                ? await this.load(
                      parent,
                      await getFileHistoryParentPath(this.executor, entry, parent),
                  )
                : toViewerSide({ status: "missing" });
            const right = await this.load(entry.hash, entry.pathAtRevision);
            if (exceedsDiffBudget(left, right))
                throw new Error(vscode.l10n.t("This file exceeds the diff viewer size limit."));
            await DiffViewerPanel.open({
                extensionUri: this.options.extensionUri,
                path: entry.pathAtRevision,
                leftLabel: parent?.slice(0, 8) ?? "∅",
                rightLabel: entry.hash.slice(0, 8),
                languageId: this.languageId(),
                leftText: left.text,
                rightText: right.text,
            });
        }
    }

    /** Uses installed language contributions for the shared viewer syntax highlighter. */
    private languageId(): string {
        const associations = createLanguageAssociations();
        const filename = path.basename(this.options.filePath).toLowerCase();
        return (
            associations.byFilename.get(filename) ??
            associations.byExtension.get(path.extname(filename)) ??
            "plaintext"
        );
    }

    /** Never sends to a disposed window. */
    private async post(message: HistoryInbound): Promise<void> {
        if (!this.closed) await this.panel.webview.postMessage(message);
    }
}

/** Localizes history chrome in the extension host using static extension catalogs. */
function historyLabels(): Record<string, string> {
    return {
        branch: vscode.l10n.t("Branch"),
        refresh: vscode.l10n.t("Refresh"),
        search: vscode.l10n.t("Search history"),
        more: vscode.l10n.t("Load more"),
        empty: vscode.l10n.t("No file history found."),
        select: vscode.l10n.t("Select a revision to view its changes."),
        details: vscode.l10n.t("Show Details"),
        actions: vscode.l10n.t("History Actions"),
        copy: vscode.l10n.t("Copy Revision"),
        open: vscode.l10n.t("Open Revision"),
        local: vscode.l10n.t("Compare with Local"),
        diff: vscode.l10n.t("Show Diff"),
        affected: vscode.l10n.t("Show All Affected Files"),
        author: vscode.l10n.t("Author"),
        date: vscode.l10n.t("Date"),
        subject: vscode.l10n.t("Commit"),
        resize: vscode.l10n.t("Resize history list"),
    };
}
