// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { WorkingFile, StashEntry } from "../types";

export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";

    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];

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
                const message = err instanceof Error ? err.message : String(err);
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
        this.stashes = await this.gitOps.stashList();
        const uniquePaths = new Set(this.files.map((f) => f.path));
        this._onDidChangeFileCount.fire(uniquePaths.size);
        this.postToWebview({ type: "update", files: this.files, stashes: this.stashes });
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
                const uri = vscode.Uri.file(
                    vscode.workspace.workspaceFolders![0].uri.fsPath + "/" + filePath,
                );
                await vscode.commands.executeCommand("git.openChange", uri);
                break;
            }

            case "stashSave": {
                const name = msg.name as string;
                const paths = msg.paths as string[] | undefined;
                await this.gitOps.stashSave(name || "Shelved changes", paths);
                vscode.window.showInformationMessage("Changes shelved.");
                await this.refreshData();
                break;
            }

            case "stashPop": {
                const index = msg.index as number;
                await this.gitOps.stashPop(index);
                vscode.window.showInformationMessage("Unshelved changes.");
                await this.refreshData();
                break;
            }

            case "stashApply": {
                const index = msg.index as number;
                await this.gitOps.stashApply(index);
                vscode.window.showInformationMessage("Applied shelved changes.");
                await this.refreshData();
                break;
            }

            case "stashDrop": {
                const index = msg.index as number;
                const confirm = await vscode.window.showWarningMessage(
                    "Delete this shelved change?",
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                await this.gitOps.stashDrop(index);
                vscode.window.showInformationMessage("Shelved change deleted.");
                await this.refreshData();
                break;
            }

            case "openFile": {
                const filePath = msg.path as string;
                const uri = vscode.Uri.joinPath(
                    vscode.workspace.workspaceFolders![0].uri,
                    filePath,
                );
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
                    await this.gitOps.deleteFile(filePath);
                } catch {
                    // If git rm fails (untracked file), delete via filesystem
                    const uri = vscode.Uri.joinPath(
                        vscode.workspace.workspaceFolders![0].uri,
                        filePath,
                    );
                    await vscode.workspace.fs.delete(uri);
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

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "dist", "webview-commitpanel.js"),
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
    <title>Commit</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root {
            width: 100%; height: 100%; overflow: hidden;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    dispose(): void {
        this._onDidChangeFileCount.dispose();
    }
}

function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    for (let i = 0; i < 32; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
    return r;
}
