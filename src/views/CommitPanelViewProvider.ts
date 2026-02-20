// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { ThemeFolderIconMap, WorkingFile, StashEntry } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { deleteFileWithFallback } from "../utils/fileOps";
import { runWithStatusBar } from "../utils/statusBar";
import type { InboundMessage } from "../webviews/react/commit-panel/types";
import { IconThemeService } from "./shared/IconThemeService";

export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";

    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedShelfIndex: number | null = null;
    private shelfFiles: WorkingFile[] = [];
    private folderIconsByName: ThemeFolderIconMap = {};
    private lastFileCount = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    private readonly iconTheme: IconThemeService;

    private readonly _onDidChangeFileCount = new vscode.EventEmitter<number>();
    readonly onDidChangeFileCount = this._onDidChangeFileCount.event;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.disposeThemeChangeDisposables();
        this.iconTheme.dispose();
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);
        this.registerThemeChangeListeners();
        const thisView = webviewView;
        webviewView.onDidDispose(() => {
            if (this.view === thisView) {
                this.view = undefined;
            }
            this.iconTheme.dispose();
            this.disposeThemeChangeDisposables();
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
                this.postToWebview({ type: "error", message });
            }
        });

        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.updateViewCount(this.lastFileCount);
        this.refreshDataWithErrorHandling();
    }

    async refresh(): Promise<void> {
        await this.refreshData();
    }

    private async refreshData(): Promise<void> {
        this.postToWebview({ type: "refreshing", active: true });
        vscode.commands.executeCommand("setContext", "intelligit.commitPanel.refreshing", true);
        try {
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateWorkingFiles(await this.gitOps.getStatus());
            const stashes = await this.gitOps.listShelved();
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();

            const hasSelected =
                this.selectedShelfIndex !== null &&
                stashes.some((entry) => entry.index === this.selectedShelfIndex);
            let selectedShelfIndex: number | null;
            if (hasSelected) {
                selectedShelfIndex = this.selectedShelfIndex;
            } else {
                selectedShelfIndex = stashes.length > 0 ? stashes[0].index : null;
            }

            const shelfFiles =
                selectedShelfIndex !== null
                    ? await this.iconTheme.decorateWorkingFiles(
                          await this.gitOps.getShelvedFiles(selectedShelfIndex),
                      )
                    : [];
            this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                ...files,
                ...shelfFiles,
            ]);

            this.files = files;
            this.stashes = stashes;
            this.selectedShelfIndex = selectedShelfIndex;
            this.shelfFiles = shelfFiles;

            const uniquePaths = new Set(files.map((f) => f.path));
            const count = uniquePaths.size;
            this._onDidChangeFileCount.fire(count);
            this.updateViewCount(count);
            this.postToWebview({
                type: "update",
                files,
                stashes,
                shelfFiles,
                selectedShelfIndex,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.folderIconsByName,
                iconFonts,
            });
            this.postToWebview({ type: "refreshing", active: false });
            vscode.commands.executeCommand(
                "setContext",
                "intelligit.commitPanel.refreshing",
                false,
            );
        } catch (err) {
            this.postToWebview({ type: "refreshing", active: false });
            vscode.commands.executeCommand(
                "setContext",
                "intelligit.commitPanel.refreshing",
                false,
            );
            throw err;
        }
    }

    private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
        switch (msg.type) {
            case "ready":
                await this.refreshData();
                break;

            case "refresh":
                await this.refreshData();
                break;

            case "stageFiles":
                await this.gitOps.stageFiles(msg.paths as string[]);
                await this.refreshData();
                break;

            case "unstageFiles":
                await this.gitOps.unstageFiles(msg.paths as string[]);
                await this.refreshData();
                break;

            case "commitSelected": {
                const message = msg.message as string;
                const amend = msg.amend as boolean;
                const push = msg.push as boolean;
                const paths = msg.paths as string[];
                if (!message.trim() && !amend) {
                    vscode.window.showWarningMessage("Commit message cannot be empty.");
                    return;
                }
                if (paths.length > 0) {
                    await this.gitOps.stageFiles(paths);
                }
                await runWithStatusBar(
                    push ? "Committing and pushing..." : "Committing...",
                    async () => {
                        if (push) {
                            await this.gitOps.commitAndPush(message, amend);
                        } else {
                            await this.gitOps.commit(message, amend);
                        }
                    },
                );
                vscode.window.showInformationMessage(
                    push ? "Committed and pushed successfully." : "Committed successfully.",
                );
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                break;
            }

            case "commit": {
                const message = msg.message as string;
                const amend = msg.amend as boolean;
                if (!message.trim() && !amend) {
                    vscode.window.showWarningMessage("Commit message cannot be empty.");
                    return;
                }
                await runWithStatusBar("Committing...", async () => {
                    await this.gitOps.commit(message, amend);
                });
                vscode.window.showInformationMessage("Committed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                break;
            }

            case "commitAndPush": {
                const message = msg.message as string;
                const amend = msg.amend as boolean;
                if (!message.trim() && !amend) {
                    vscode.window.showWarningMessage("Commit message cannot be empty.");
                    return;
                }
                await runWithStatusBar("Committing and pushing...", async () => {
                    await this.gitOps.commitAndPush(message, amend);
                });
                vscode.window.showInformationMessage("Committed and pushed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                break;
            }

            case "getLastCommitMessage": {
                const lastMsg = await this.gitOps.getLastCommitMessage();
                this.postToWebview({ type: "lastCommitMessage", message: lastMsg });
                break;
            }

            case "rollback": {
                const paths = msg.paths as string[];
                if (paths.length === 0) {
                    const confirm = await vscode.window.showWarningMessage(
                        "Rollback all changes?",
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.gitOps.rollbackAll();
                } else {
                    const confirm = await vscode.window.showWarningMessage(
                        `Rollback ${paths.length} file(s)?`,
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.gitOps.rollbackFiles(paths);
                }
                vscode.window.showInformationMessage("Changes rolled back.");
                await this.refreshData();
                break;
            }

            case "showDiff": {
                const filePath = msg.path as string;
                const workspaceRoot = this.getWorkspaceRoot();
                const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
                await vscode.commands.executeCommand("git.openChange", uri);
                break;
            }

            case "shelveSave":
            case "stashSave": {
                const name = (msg.name as string | undefined) || "Shelved changes";
                const paths = msg.paths as string[] | undefined;
                await this.gitOps.shelveSave(paths, name);
                vscode.window.showInformationMessage("Changes shelved.");
                await this.refreshData();
                break;
            }

            case "shelfPop":
            case "stashPop": {
                const index = msg.index as number;
                await this.gitOps.shelvePop(index);
                vscode.window.showInformationMessage("Unshelved changes.");
                await this.refreshData();
                break;
            }

            case "shelfApply":
            case "stashApply": {
                const index = msg.index as number;
                await this.gitOps.shelveApply(index);
                vscode.window.showInformationMessage("Applied shelved changes.");
                await this.refreshData();
                break;
            }

            case "shelfDelete":
            case "stashDrop": {
                const index = msg.index as number;
                const confirm = await vscode.window.showWarningMessage(
                    "Delete this shelved change?",
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                await this.gitOps.shelveDelete(index);
                vscode.window.showInformationMessage("Shelved change deleted.");
                await this.refreshData();
                break;
            }

            case "shelfSelect": {
                const index = msg.index as number;
                this.selectedShelfIndex = Number.isFinite(index) ? index : null;
                if (this.selectedShelfIndex !== null) {
                    this.shelfFiles = await this.iconTheme.decorateWorkingFiles(
                        await this.gitOps.getShelvedFiles(this.selectedShelfIndex),
                    );
                } else {
                    this.shelfFiles = [];
                }
                this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                    ...this.files,
                    ...this.shelfFiles,
                ]);
                const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
                this.postToWebview({
                    type: "update",
                    files: this.files,
                    stashes: this.stashes,
                    shelfFiles: this.shelfFiles,
                    selectedShelfIndex: this.selectedShelfIndex,
                    folderIcon: folderIcons.folderIcon,
                    folderExpandedIcon: folderIcons.folderExpandedIcon,
                    folderIconsByName: this.folderIconsByName,
                    iconFonts,
                });
                break;
            }

            case "showShelfDiff": {
                const index = msg.index as number;
                const filePath = msg.path as string;
                const patch = await this.gitOps.getShelvedFilePatch(index, filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: patch || `No shelved diff found for ${filePath}.`,
                    language: "diff",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }

            case "openFile": {
                const filePath = msg.path as string;
                const workspaceRoot = this.getWorkspaceRoot();
                const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
                await vscode.window.showTextDocument(uri);
                break;
            }

            case "deleteFile": {
                const filePath = msg.path as string;
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${filePath}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                const workspaceRoot = this.getWorkspaceRoot();
                const deleted = await deleteFileWithFallback(this.gitOps, workspaceRoot, filePath);
                if (!deleted) return;
                vscode.window.showInformationMessage(`Deleted ${filePath}`);
                await this.refreshData();
                break;
            }

            case "showHistory": {
                const filePath = msg.path as string;
                const history = await this.gitOps.getFileHistory(filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: history || "No history found.",
                    language: "git-commit",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }
        }
    }

    private updateViewCount(count: number): void {
        this.lastFileCount = count;
        if (!this.view) return;
        this.view.description = count > 0 ? `${count}` : "";
    }

    private postToWebview(msg: InboundMessage): void {
        this.view?.webview.postMessage(msg);
    }

    private getWorkspaceRoot(): vscode.Uri {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
            throw new Error("No workspace folder is open.");
        }
        return workspaceRoot;
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-commitpanel.js",
            title: "Commit",
            backgroundVar: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
        });
    }

    dispose(): void {
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onDidChangeFileCount.dispose();
    }

    private refreshDataWithErrorHandling(): void {
        this.refreshData().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(message);
            this.postToWebview({ type: "error", message });
        });
    }

    private registerThemeChangeListeners(): void {
        const windowWithThemeEvents = vscode.window as unknown as {
            onDidChangeActiveColorTheme?: (listener: () => void) => vscode.Disposable;
        };
        if (typeof windowWithThemeEvents.onDidChangeActiveColorTheme === "function") {
            this.themeChangeDisposables.push(
                windowWithThemeEvents.onDidChangeActiveColorTheme(() => {
                    this.refreshDataWithErrorHandling();
                }),
            );
        }

        const workspaceWithThemeEvents = vscode.workspace as unknown as {
            onDidChangeConfiguration?: (
                listener: (event: { affectsConfiguration: (section: string) => boolean }) => void,
            ) => vscode.Disposable;
        };
        if (typeof workspaceWithThemeEvents.onDidChangeConfiguration === "function") {
            this.themeChangeDisposables.push(
                workspaceWithThemeEvents.onDidChangeConfiguration((event) => {
                    if (
                        event.affectsConfiguration("workbench.iconTheme") ||
                        event.affectsConfiguration("workbench.colorTheme")
                    ) {
                        this.refreshDataWithErrorHandling();
                    }
                }),
            );
        }
    }

    private disposeThemeChangeDisposables(): void {
        for (const disposable of this.themeChangeDisposables) {
            disposable.dispose();
        }
        this.themeChangeDisposables = [];
    }
}
