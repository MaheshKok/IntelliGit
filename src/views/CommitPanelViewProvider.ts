// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { WorkingFile, StashEntry } from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isUntrackedPathspecError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    const code =
        typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "").toLowerCase()
            : "";

    return (
        message.includes("did not match any files") ||
        (message.includes("pathspec") && message.includes("did not match")) ||
        code === "enoent"
    );
}

export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";

    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedShelfIndex: number | null = null;
    private shelfFiles: WorkingFile[] = [];

    private readonly _onDidChangeFileCount = new vscode.EventEmitter<number>();
    readonly onDidChangeFileCount = this._onDidChangeFileCount.event;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        webviewView.onDidDispose(() => {
            this.view = undefined;
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
        this.refreshData();
    }

    async refresh(): Promise<void> {
        await this.refreshData();
    }

    private async refreshData(): Promise<void> {
        this.files = await this.gitOps.getStatus();
        this.stashes = await this.gitOps.listShelved();

        const hasSelected =
            this.selectedShelfIndex !== null &&
            this.stashes.some((entry) => entry.index === this.selectedShelfIndex);
        if (!hasSelected) {
            this.selectedShelfIndex = this.stashes.length > 0 ? this.stashes[0].index : null;
        }

        if (this.selectedShelfIndex !== null) {
            this.shelfFiles = await this.gitOps.getShelvedFiles(this.selectedShelfIndex);
        } else {
            this.shelfFiles = [];
        }

        const uniquePaths = new Set(this.files.map((f) => f.path));
        this._onDidChangeFileCount.fire(uniquePaths.size);
        this.postToWebview({
            type: "update",
            files: this.files,
            stashes: this.stashes,
            shelfFiles: this.shelfFiles,
            selectedShelfIndex: this.selectedShelfIndex,
        });
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
                if (push) {
                    await this.gitOps.commitAndPush(message, amend);
                    vscode.window.showInformationMessage("Committed and pushed successfully.");
                } else {
                    await this.gitOps.commit(message, amend);
                    vscode.window.showInformationMessage("Committed successfully.");
                }
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
                await this.gitOps.commit(message, amend);
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
                await this.gitOps.commitAndPush(message, amend);
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
                    this.shelfFiles = await this.gitOps.getShelvedFiles(this.selectedShelfIndex);
                } else {
                    this.shelfFiles = [];
                }
                this.postToWebview({
                    type: "update",
                    files: this.files,
                    stashes: this.stashes,
                    shelfFiles: this.shelfFiles,
                    selectedShelfIndex: this.selectedShelfIndex,
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
                try {
                    await this.gitOps.deleteFile(filePath, true);
                } catch (error) {
                    if (!isUntrackedPathspecError(error)) {
                        const message = getErrorMessage(error);
                        console.error("Failed to delete file with git rm:", error);
                        vscode.window.showErrorMessage(`Delete failed: ${message}`);
                        return;
                    }

                    try {
                        const workspaceRoot = this.getWorkspaceRoot();
                        const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
                        await vscode.workspace.fs.delete(uri);
                    } catch (fsError) {
                        const message = getErrorMessage(fsError);
                        console.error("Failed to delete file from filesystem:", fsError);
                        vscode.window.showErrorMessage(`Delete failed: ${message}`);
                        return;
                    }
                }
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

    private postToWebview(msg: unknown): void {
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
        this._onDidChangeFileCount.dispose();
    }
}
