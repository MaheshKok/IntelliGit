// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { WorkingFile, StashEntry } from "../types";

export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "pycharmGit.commitPanel";

    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];

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
        webviewView.webview.options = { enableScripts: true };
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

        this.render();
        this.refreshData();
    }

    async refresh(): Promise<void> {
        await this.refreshData();
    }

    private async refreshData(): Promise<void> {
        this.files = await this.gitOps.getStatus();
        this.stashes = await this.gitOps.stashList();
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
        }
    }

    private postToWebview(msg: unknown): void {
        this.view?.webview.postMessage(msg);
    }

    private render(): void {
        if (!this.view) return;
        const nonce = getNonce();
        this.view.webview.html = getCommitPanelHtml(nonce);
    }

    dispose(): void {
        // nothing
    }
}

function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    for (let i = 0; i < 32; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
    return r;
}

function getCommitPanelHtml(nonce: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
    height: 100%; width: 100%;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    overflow: hidden;
}
.container { display: flex; flex-direction: column; height: 100%; }

/* --- Tab bar (Commit | Shelf) --- */
.tab-bar {
    display: flex; flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
}
.tab-bar .tab {
    padding: 6px 16px; font-size: 12px; font-weight: 600;
    cursor: pointer; user-select: none;
    color: var(--vscode-foreground); opacity: 0.6;
    border-bottom: 2px solid transparent;
    background: none; border-top: none; border-left: none; border-right: none;
}
.tab-bar .tab:hover { opacity: 0.85; }
.tab-bar .tab.active {
    opacity: 1;
    border-bottom-color: var(--vscode-focusBorder, #007acc);
}

/* --- Toolbar --- */
.toolbar {
    display: flex; align-items: center; gap: 2px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    flex-shrink: 0;
}
.toolbar button {
    background: none; border: none; color: #abb2bf;
    cursor: pointer; padding: 4px 6px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    position: relative;
}
.toolbar button:hover { background: var(--vscode-list-hoverBackground); color: #d4d8e0; }
.toolbar button svg { width: 18px; height: 18px; }
.toolbar .spacer { flex: 1; }

/* Custom tooltip for toolbar buttons */
.toolbar button::after {
    content: attr(data-tip);
    position: absolute; bottom: -26px; left: 50%;
    transform: translateX(-50%);
    background: var(--vscode-editorWidget-background, #1e1e1e);
    color: var(--vscode-editorWidget-foreground, #ccc);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    padding: 2px 8px; border-radius: 3px;
    font-size: 11px; white-space: nowrap;
    pointer-events: none; opacity: 0;
    transition: opacity 0.15s ease;
    z-index: 100;
}
.toolbar button:hover::after { opacity: 1; }

/* --- Sections --- */
.scroll-area { flex: 1 1 auto; overflow-y: auto; min-height: 40px; }
.section-header {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 6px; cursor: pointer; user-select: none;
    font-weight: 700; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.3px;
    line-height: 24px; position: relative;
}
.section-header:hover { background: var(--vscode-list-hoverBackground); }
.section-header .count {
    color: var(--vscode-descriptionForeground);
    font-weight: normal; font-size: 11px;
    margin-left: auto;
}
.chevron {
    font-size: 11px; width: 14px; text-align: center;
    flex-shrink: 0; opacity: 0.7;
    transition: transform 0.15s ease; display: inline-block;
}
.chevron.open { transform: rotate(90deg); }

/* --- File & folder rows --- */
.file-row, .folder-row {
    display: flex; align-items: center; gap: 4px;
    padding: 1px 6px 1px 6px; line-height: 24px; font-size: 13px;
    cursor: pointer; position: relative;
}
.file-row:hover, .folder-row:hover { background: var(--vscode-list-hoverBackground); }
.file-row input[type="checkbox"], .folder-row input[type="checkbox"] {
    margin: 0; flex-shrink: 0; cursor: pointer;
}
.file-row .fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-row .fdir {
    color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 4px;
}
.file-row .stats { margin-left: auto; font-size: 11px; flex-shrink: 0; }
.folder-row .fname { opacity: 0.85; flex: 1; }
.folder-row .count {
    margin-left: auto; font-size: 11px;
    color: var(--vscode-descriptionForeground);
}
.icon16 { width: 16px; height: 16px; flex-shrink: 0; }

/* Indent guide lines */
.indent-guide {
    position: absolute; top: 0; bottom: 0; width: 1px;
    background: var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.1));
}
.file-row:hover .indent-guide, .folder-row:hover .indent-guide {
    background: var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.2));
}

/* File-type icon badge */
.ft-icon {
    width: 16px; height: 16px; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 7px; font-weight: 700; border-radius: 2px;
    font-family: monospace; letter-spacing: -0.5px;
}

/* File name coloring by status */
.fn-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d19a66); }
.fn-A, .fn-new { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
.fn-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); text-decoration: line-through; }
.fn-R { color: var(--vscode-gitDecoration-renamedResourceForeground, #a371f7); }
.fn-U { color: var(--vscode-gitDecoration-conflictingResourceForeground, #e5c07b); }
.fn-untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }

.add-stat { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
.del-stat { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }

/* --- Bottom area --- */
.bottom-area {
    flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border, #444);
    display: flex; flex-direction: column;
}
.amend-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; font-size: 12px;
}
.amend-row input { cursor: pointer; }
.amend-row label { cursor: pointer; user-select: none; }
.commit-box { padding: 4px 8px; }
.commit-box textarea {
    width: 100%; min-height: 60px; max-height: 150px; resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 3px; padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
}
.commit-box textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
.commit-box textarea:focus { border-color: var(--vscode-focusBorder); }
.button-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; }
.button-row button { cursor: pointer; font-size: 13px; font-family: var(--vscode-font-family); }
.btn-primary {
    background: #4a6edb; color: #fff;
    border: none; border-radius: 4px;
    padding: 5px 18px; font-weight: 600;
}
.btn-primary:hover { background: #5a7ee8; }
.btn-secondary {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-button-secondaryBackground, #555);
    border-radius: 4px; padding: 4px 14px;
}
.btn-secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.08));
    border-color: var(--vscode-button-secondaryForeground, #888);
}

/* --- Tab content visibility --- */
.tab-content { display: none; flex-direction: column; flex: 1; overflow: hidden; }
.tab-content.active { display: flex; }

/* --- Shelf tab --- */
.shelf-empty {
    color: var(--vscode-descriptionForeground);
    font-size: 12px; padding: 16px; text-align: center;
}
.stash-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; line-height: 22px; font-size: 12px;
}
.stash-row:hover { background: var(--vscode-list-hoverBackground); }
.stash-row .stash-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stash-row .stash-date {
    color: var(--vscode-descriptionForeground); font-size: 11px; flex-shrink: 0;
}
.stash-row button {
    background: none; border: none; color: var(--vscode-foreground);
    cursor: pointer; padding: 2px 4px; border-radius: 3px; opacity: 0.6;
}
.stash-row button:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.stash-row button svg { width: 12px; height: 12px; }
.empty-msg {
    color: var(--vscode-descriptionForeground);
    font-size: 12px; padding: 8px 12px; text-align: center;
}
</style>
</head>
<body>
<div class="container">
    <!-- Tab bar -->
    <div class="tab-bar">
        <button class="tab active" data-tab="commit">Commit</button>
        <button class="tab" data-tab="shelf">Shelf</button>
    </div>

    <!-- === COMMIT TAB === -->
    <div class="tab-content active" id="commitTab">
        <!-- Toolbar -->
        <div class="toolbar">
            <button id="btnRefresh" title="Refresh" data-tip="Refresh">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.528 1.236.528 1.949a4.093 4.093 0 0 1-4.09 4.09 4.093 4.093 0 0 1-4.09-4.09 4.088 4.088 0 0 1 3.354-4.027v1.938l4.308-2.906L7.43.002v1.906a5.593 5.593 0 0 0-4.856 5.617A5.594 5.594 0 0 0 8.166 13.1a5.594 5.594 0 0 0 5.592-5.575c0-1.755-.461-2.381-1.307-3.416l1-.5z"/></svg>
            </button>
            <button id="btnRollback" title="Rollback" data-tip="Rollback">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M2.5 2l3.068 3.069L4.856 5.78l.707-.707L3.594 3.1H7A4.505 4.505 0 0 1 11.5 7.609 4.505 4.505 0 0 1 7 12.109H3.5v1H7a5.506 5.506 0 0 0 5.5-5.5A5.506 5.506 0 0 0 7 2.109H3.594l1.97-1.97-.708-.707L1.788 2.5z"/></svg>
            </button>
            <button id="btnGroupBy" title="Group by Directory" data-tip="Group by Directory">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2H1.5A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4V3zM1.5 3h4.79l.85.85a.5.5 0 0 0 .36.15h7a.5.5 0 0 1 .5.5v.5H1V3.5a.5.5 0 0 1 .5-.5zM1 12.5V6h14v6.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5z"/></svg>
            </button>
            <button id="btnShelve" title="Shelve Changes" data-tip="Shelve Changes">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M14.5 1h-13A1.5 1.5 0 0 0 0 2.5v2A1.5 1.5 0 0 0 1 5.95V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.95A1.5 1.5 0 0 0 16 4.5v-2A1.5 1.5 0 0 0 14.5 1zM14 13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6h12v7.5zm1-9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v2zM6 9h4v1H6V9z"/></svg>
            </button>
            <button id="btnShowDiff" title="Show Diff Preview" data-tip="Show Diff Preview">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h5.586a1.5 1.5 0 0 1 1.06.44l2.415 2.414A1.5 1.5 0 0 1 13 5.914V12.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12.5v-9zm1.5-.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V5.914L9.086 2.5H3.5zM7 7V5h1v2h2v1H8v2H7V8H5V7h2z"/></svg>
            </button>
            <span class="spacer"></span>
            <button id="btnExpandAll" title="Expand All" data-tip="Expand All">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M9 9H4v1h5V9zM9 4H4v1h5V4z"/><path fill="currentColor" d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11z"/></svg>
            </button>
            <button id="btnCollapseAll" title="Collapse All" data-tip="Collapse All">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M9 9H4v1h5V9z"/><path fill="currentColor" d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11z"/></svg>
            </button>
        </div>

        <!-- File list -->
        <div class="scroll-area" id="scrollArea"></div>

        <!-- Bottom: amend + message + buttons -->
        <div class="bottom-area">
            <div class="amend-row">
                <input type="checkbox" id="amendCheckbox">
                <label for="amendCheckbox">Amend</label>
            </div>
            <div class="commit-box">
                <textarea id="commitMessage" placeholder="Commit Message" rows="3"></textarea>
            </div>
            <div class="button-row">
                <button class="btn-primary" id="btnCommit">Commit</button>
                <button class="btn-secondary" id="btnCommitPush">Commit and Push...</button>
            </div>
        </div>
    </div>

    <!-- === SHELF TAB === -->
    <div class="tab-content" id="shelfTab">
        <div class="toolbar">
            <button id="btnShelfRefresh" title="Refresh" data-tip="Refresh">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.528 1.236.528 1.949a4.093 4.093 0 0 1-4.09 4.09 4.093 4.093 0 0 1-4.09-4.09 4.088 4.088 0 0 1 3.354-4.027v1.938l4.308-2.906L7.43.002v1.906a5.593 5.593 0 0 0-4.856 5.617A5.594 5.594 0 0 0 8.166 13.1a5.594 5.594 0 0 0 5.592-5.575c0-1.755-.461-2.381-1.307-3.416l1-.5z"/></svg>
            </button>
        </div>
        <div class="scroll-area" id="shelfList"></div>
    </div>
</div>

<script nonce="${nonce}">
(function() {
    const vscode = acquireVsCodeApi();
    let files = [];
    let stashes = [];
    let checkedPaths = new Set();
    let groupByDir = true;
    let expandedDirs = new Set();
    let changesOpen = true;
    let unversionedOpen = true;
    let allDirsExpanded = true;

    const scrollArea = document.getElementById('scrollArea');
    const commitMessage = document.getElementById('commitMessage');
    const amendCheckbox = document.getElementById('amendCheckbox');
    const shelfList = document.getElementById('shelfList');

    // --- Tab switching ---
    document.querySelectorAll('.tab-bar .tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.tab-bar .tab').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
            tab.classList.add('active');
            var target = tab.getAttribute('data-tab');
            document.getElementById(target + 'Tab').classList.add('active');
        });
    });

    // --- Toolbar handlers ---
    document.getElementById('btnRefresh').addEventListener('click', function() {
        vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('btnShelfRefresh').addEventListener('click', function() {
        vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('btnRollback').addEventListener('click', function() {
        var selected = Array.from(checkedPaths);
        vscode.postMessage({ type: 'rollback', paths: selected });
    });
    document.getElementById('btnGroupBy').addEventListener('click', function() {
        groupByDir = !groupByDir;
        renderFiles();
    });
    document.getElementById('btnShowDiff').addEventListener('click', function() {
        var selected = Array.from(checkedPaths);
        if (selected.length > 0) {
            vscode.postMessage({ type: 'showDiff', path: selected[0] });
        }
    });
    document.getElementById('btnShelve').addEventListener('click', function() {
        var name = prompt('Shelf name:', 'Shelved changes');
        if (name === null) return;
        var selected = Array.from(checkedPaths);
        vscode.postMessage({ type: 'stashSave', name: name, paths: selected.length > 0 ? selected : undefined });
    });
    document.getElementById('btnExpandAll').addEventListener('click', function() {
        allDirsExpanded = true;
        changesOpen = true;
        unversionedOpen = true;
        expandedDirs.clear();
        collectAllDirs(files).forEach(function(d) { expandedDirs.add(d); });
        renderFiles();
    });
    document.getElementById('btnCollapseAll').addEventListener('click', function() {
        allDirsExpanded = false;
        changesOpen = false;
        unversionedOpen = false;
        expandedDirs.clear();
        renderFiles();
    });

    // --- Commit handlers ---
    document.getElementById('btnCommit').addEventListener('click', function() {
        stageCheckedAndCommit('commit');
    });
    document.getElementById('btnCommitPush').addEventListener('click', function() {
        stageCheckedAndCommit('commitAndPush');
    });

    function stageCheckedAndCommit(action) {
        var msg = commitMessage.value.trim();
        var amend = amendCheckbox.checked;
        if (!msg && !amend) return;
        var toStage = Array.from(checkedPaths);
        if (toStage.length > 0) {
            vscode.postMessage({ type: 'stageFiles', paths: toStage });
        }
        setTimeout(function() {
            vscode.postMessage({ type: action, message: msg, amend: amend });
        }, toStage.length > 0 ? 300 : 0);
    }

    // --- Amend toggle ---
    amendCheckbox.addEventListener('change', function() {
        if (amendCheckbox.checked) {
            vscode.postMessage({ type: 'getLastCommitMessage' });
        }
    });

    // --- Message handler ---
    window.addEventListener('message', function(event) {
        var msg = event.data;
        switch (msg.type) {
            case 'update':
                files = msg.files || [];
                stashes = msg.stashes || [];
                checkedPaths = new Set(files.map(function(f) { return f.path; }));
                if (allDirsExpanded) {
                    collectAllDirs(files).forEach(function(d) { expandedDirs.add(d); });
                }
                renderFiles();
                renderStashes();
                break;
            case 'lastCommitMessage':
                commitMessage.value = msg.message || '';
                break;
            case 'committed':
                commitMessage.value = '';
                amendCheckbox.checked = false;
                break;
            case 'error':
                break;
        }
    });

    function collectAllDirs(fileList) {
        var dirs = new Set();
        for (var i = 0; i < fileList.length; i++) {
            var parts = fileList[i].path.split('/');
            for (var j = 1; j < parts.length; j++) {
                dirs.add(parts.slice(0, j).join('/'));
            }
        }
        return dirs;
    }

    // --- File type icon ---
    var EXT_ICONS = {
        ts: { label: 'TS', bg: '#3178c6' },
        tsx: { label: 'TX', bg: '#3178c6' },
        js: { label: 'JS', bg: '#f0db4f', fg: '#323330' },
        jsx: { label: 'JX', bg: '#f0db4f', fg: '#323330' },
        json: { label: 'JS', bg: '#5b5b5b' },
        md: { label: 'M', bg: '#519aba' },
        css: { label: 'CS', bg: '#563d7c' },
        scss: { label: 'SC', bg: '#c6538c' },
        html: { label: 'HT', bg: '#e44d26' },
        svg: { label: 'SV', bg: '#ffb13b', fg: '#323330' },
        py: { label: 'PY', bg: '#3572a5' },
        rs: { label: 'RS', bg: '#dea584' },
        go: { label: 'GO', bg: '#00add8' },
        yaml: { label: 'YA', bg: '#cb171e' },
        yml: { label: 'YA', bg: '#cb171e' },
        xml: { label: 'XM', bg: '#f26522' },
        sh: { label: 'SH', bg: '#4eaa25' },
        toml: { label: 'TO', bg: '#9c4221' },
        lock: { label: 'LK', bg: '#666' },
        gitignore: { label: 'GI', bg: '#f34f29' },
        env: { label: 'EN', bg: '#ecd53f', fg: '#323330' },
    };

    function fileTypeIcon(filename, status) {
        var ext = filename.split('.').pop().toLowerCase();
        if (filename.startsWith('.')) ext = filename.slice(1);
        var info = EXT_ICONS[ext];
        if (!info) info = { label: ext.slice(0, 2).toUpperCase(), bg: '#6b6b6b' };
        var fg = info.fg || '#fff';
        // Dim the background slightly for deleted files
        var bg = info.bg;
        if (status === 'D') { bg = '#6b6b6b'; }
        return '<span class="ft-icon" style="background:' + esc(bg) + ';color:' + esc(fg) + '" title="' + esc(ext.toUpperCase() + ' file') + '">' + esc(info.label) + '</span>';
    }

    // --- Folder icon ---
    var FOLDER_SVG = '<svg class="icon16" viewBox="0 0 16 16" title="Directory"><path fill="#c09553" d="M14.5 4H7.71l-.85-.85A.5.5 0 0 0 6.5 3H1.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V4.5a.5.5 0 0 0-.5-.5z"/></svg>';

    // --- Status letter for right side ---
    var STATUS_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflicting', '?': 'Unversioned', C: 'Copied' };

    function statusLetter(status) {
        var colors = { M: '#d19a66', A: '#73c991', D: '#c74e39', R: '#a371f7', U: '#e5c07b', '?': '#73c991', C: '#73c991' };
        var c = colors[status] || '#888';
        var label = STATUS_LABELS[status] || status;
        var letter = status === '?' ? 'U' : status;
        return '<span style="color:' + c + ';font-size:11px;font-weight:600;width:14px;text-align:center;flex-shrink:0" title="' + esc(label) + '">' + esc(letter) + '</span>';
    }

    // --- Render files ---
    function renderFiles() {
        var uniqueFiles = [];
        var seen = {};
        for (var i = 0; i < files.length; i++) {
            if (!seen[files[i].path]) {
                seen[files[i].path] = true;
                uniqueFiles.push(files[i]);
            }
        }

        // Split into tracked changes and unversioned
        var tracked = uniqueFiles.filter(function(f) { return f.status !== '?'; });
        var unversioned = uniqueFiles.filter(function(f) { return f.status === '?'; });

        if (uniqueFiles.length === 0) {
            scrollArea.textContent = '';
            var emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty-msg';
            emptyDiv.textContent = 'No changes';
            scrollArea.appendChild(emptyDiv);
            return;
        }

        var html = '';

        // --- Changes section ---
        if (tracked.length > 0) {
            var allTrackedChecked = tracked.every(function(f) { return checkedPaths.has(f.path); });
            html += '<div class="section-header" data-section="changes">';
            html += '<input type="checkbox" data-section-check="changes" ' + (allTrackedChecked ? 'checked' : '') + '>';
            html += '<span class="chevron ' + (changesOpen ? 'open' : '') + '">&#9654;</span>';
            html += ' Changes';
            html += '<span class="count">' + tracked.length + '</span>';
            html += '</div>';
            if (changesOpen) {
                if (groupByDir) {
                    html += renderAsTree(tracked);
                } else {
                    for (var i = 0; i < tracked.length; i++) {
                        html += renderFileRow(tracked[i], 0);
                    }
                }
            }
        }

        // --- Unversioned Files section ---
        if (unversioned.length > 0) {
            var allUnvChecked = unversioned.every(function(f) { return checkedPaths.has(f.path); });
            html += '<div class="section-header" data-section="unversioned">';
            html += '<input type="checkbox" data-section-check="unversioned" ' + (allUnvChecked ? 'checked' : '') + '>';
            html += '<span class="chevron ' + (unversionedOpen ? 'open' : '') + '">&#9654;</span>';
            html += ' Unversioned Files';
            html += '<span class="count">' + unversioned.length + '</span>';
            html += '</div>';
            if (unversionedOpen) {
                if (groupByDir) {
                    html += renderAsTree(unversioned);
                } else {
                    for (var j = 0; j < unversioned.length; j++) {
                        html += renderFileRow(unversioned[j], 0);
                    }
                }
            }
        }

        scrollArea.textContent = '';
        var temp = document.createElement('div');
        temp.innerHTML = html;
        while (temp.firstChild) { scrollArea.appendChild(temp.firstChild); }

        // Wire events
        wireFileEvents();
    }

    function wireFileEvents() {
        scrollArea.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
            cb.addEventListener('change', handleCheckboxChange);
        });
        scrollArea.querySelectorAll('.file-row').forEach(function(row) {
            row.addEventListener('dblclick', function() {
                var path = row.getAttribute('data-path');
                if (path) vscode.postMessage({ type: 'showDiff', path: path });
            });
        });
        scrollArea.querySelectorAll('.folder-row').forEach(function(row) {
            row.addEventListener('click', function(e) {
                if (e.target.tagName === 'INPUT') return;
                var dir = row.getAttribute('data-dir');
                if (expandedDirs.has(dir)) expandedDirs.delete(dir);
                else expandedDirs.add(dir);
                renderFiles();
            });
        });
        scrollArea.querySelectorAll('.section-header').forEach(function(hdr) {
            hdr.addEventListener('click', function(e) {
                if (e.target.tagName === 'INPUT') return;
                var section = hdr.getAttribute('data-section');
                if (section === 'changes') changesOpen = !changesOpen;
                else if (section === 'unversioned') unversionedOpen = !unversionedOpen;
                renderFiles();
            });
        });
    }

    function renderAsTree(fileList) {
        var tree = {};
        for (var i = 0; i < fileList.length; i++) {
            var f = fileList[i];
            var parts = f.path.split('/');
            var node = tree;
            for (var j = 0; j < parts.length - 1; j++) {
                var dir = parts.slice(0, j + 1).join('/');
                if (!node[parts[j]]) node[parts[j]] = { __dir: dir, __files: [] };
                node = node[parts[j]];
            }
            if (!node.__files) node.__files = [];
            node.__files.push(f);
        }
        return renderTreeNode(tree, 0);
    }

    var INDENT_STEP = 24;
    var INDENT_BASE = 30;
    var GUIDE_BASE = 17;

    function indentGuides(treeDepth) {
        var html = '';
        for (var g = 0; g <= treeDepth; g++) {
            html += '<span class="indent-guide" style="left:' + (GUIDE_BASE + g * INDENT_STEP) + 'px"></span>';
        }
        return html;
    }

    function renderTreeNode(node, depth) {
        var html = '';
        var padLeft = INDENT_BASE + depth * INDENT_STEP;
        var keys = Object.keys(node).filter(function(k) { return k !== '__dir' && k !== '__files'; });

        for (var ki = 0; ki < keys.length; ki++) {
            var key = keys[ki];
            var sub = node[key];
            var dir = sub.__dir || key;
            var isExpanded = expandedDirs.has(dir);
            var dirFiles = collectDirFiles(sub);
            var allDirChecked = dirFiles.every(function(f) { return checkedPaths.has(f.path); });

            html += '<div class="folder-row" data-dir="' + esc(dir) + '" style="padding-left:' + padLeft + 'px" title="' + esc(dir) + '">';
            html += indentGuides(depth);
            html += '<input type="checkbox" data-dir-check="' + esc(dir) + '" ' + (allDirChecked ? 'checked' : '') + '>';
            html += '<span class="chevron ' + (isExpanded ? 'open' : '') + '">&#9654;</span>';
            html += FOLDER_SVG;
            html += '<span class="fname">' + esc(key) + '</span>';
            html += '<span class="count">' + dirFiles.length + '</span>';
            html += '</div>';

            if (isExpanded) {
                html += renderTreeNode(sub, depth + 1);
                if (sub.__files) {
                    for (var fi = 0; fi < sub.__files.length; fi++) {
                        html += renderFileRow(sub.__files[fi], depth + 1);
                    }
                }
            }
        }

        if (node.__files && depth === 0) {
            for (var ri = 0; ri < node.__files.length; ri++) {
                html += renderFileRow(node.__files[ri], depth);
            }
        }

        return html;
    }

    function collectDirFiles(node) {
        var result = [];
        if (node.__files) result = result.concat(node.__files);
        var keys = Object.keys(node).filter(function(k) { return k !== '__dir' && k !== '__files'; });
        for (var i = 0; i < keys.length; i++) {
            result = result.concat(collectDirFiles(node[keys[i]]));
        }
        return result;
    }

    function renderFileRow(f, depth) {
        var padLeft = INDENT_BASE + depth * INDENT_STEP;
        var fileName = f.path.split('/').pop();
        var dir = f.path.split('/').slice(0, -1).join('/');
        var checked = checkedPaths.has(f.path) ? 'checked' : '';
        var fnClass = f.status === '?' ? 'fn-untracked' : 'fn-' + f.status;

        var stats = '';
        if (f.additions > 0) stats += '<span class="add-stat">+' + f.additions + '</span> ';
        if (f.deletions > 0) stats += '<span class="del-stat">-' + f.deletions + '</span>';

        var html = '<div class="file-row" data-path="' + esc(f.path) + '" style="padding-left:' + padLeft + 'px" title="' + esc(f.path) + '">';
        html += indentGuides(depth);
        html += '<input type="checkbox" data-path-check="' + esc(f.path) + '" ' + checked + '>';
        html += fileTypeIcon(fileName, f.status);
        html += '<span class="fname ' + fnClass + '">' + esc(fileName) + '</span>';
        if (!groupByDir && dir) {
            html += '<span class="fdir">' + esc(dir) + '</span>';
        }
        if (stats) html += '<span class="stats">' + stats + '</span>';
        html += statusLetter(f.status);
        html += '</div>';
        return html;
    }

    function handleCheckboxChange(e) {
        var el = e.target;
        var sectionCheck = el.getAttribute('data-section-check');
        if (sectionCheck) {
            var uniqueFiles = [];
            var seen = {};
            for (var i = 0; i < files.length; i++) {
                if (!seen[files[i].path]) {
                    seen[files[i].path] = true;
                    uniqueFiles.push(files[i]);
                }
            }
            var sectionFiles;
            if (sectionCheck === 'changes') {
                sectionFiles = uniqueFiles.filter(function(f) { return f.status !== '?'; });
            } else {
                sectionFiles = uniqueFiles.filter(function(f) { return f.status === '?'; });
            }
            for (var j = 0; j < sectionFiles.length; j++) {
                if (el.checked) checkedPaths.add(sectionFiles[j].path);
                else checkedPaths.delete(sectionFiles[j].path);
            }
            renderFiles();
            return;
        }

        var pathCheck = el.getAttribute('data-path-check');
        if (pathCheck) {
            if (el.checked) checkedPaths.add(pathCheck);
            else checkedPaths.delete(pathCheck);
            renderFiles();
            return;
        }

        var dirCheck = el.getAttribute('data-dir-check');
        if (dirCheck) {
            var dirFiles = files.filter(function(f) { return f.path.startsWith(dirCheck + '/'); });
            var dirPaths = [];
            var dirSeen = {};
            for (var k = 0; k < dirFiles.length; k++) {
                if (!dirSeen[dirFiles[k].path]) {
                    dirSeen[dirFiles[k].path] = true;
                    dirPaths.push(dirFiles[k].path);
                }
            }
            for (var m = 0; m < dirPaths.length; m++) {
                if (el.checked) checkedPaths.add(dirPaths[m]);
                else checkedPaths.delete(dirPaths[m]);
            }
            renderFiles();
            return;
        }
    }

    // --- Render stashes ---
    function renderStashes() {
        var tabLabel = document.querySelector('.tab[data-tab="shelf"]');
        if (stashes.length > 0) {
            tabLabel.textContent = 'Shelf (' + stashes.length + ')';
        } else {
            tabLabel.textContent = 'Shelf';
        }

        if (stashes.length === 0) {
            shelfList.textContent = '';
            var emptyDiv = document.createElement('div');
            emptyDiv.className = 'shelf-empty';
            emptyDiv.textContent = 'No shelved changes';
            shelfList.appendChild(emptyDiv);
            return;
        }

        var html = '';
        for (var i = 0; i < stashes.length; i++) {
            var s = stashes[i];
            html += '<div class="stash-row">';
            html += '<svg class="icon16" viewBox="0 0 16 16" style="flex-shrink:0;opacity:0.7"><path fill="currentColor" d="M14.5 1h-13A1.5 1.5 0 0 0 0 2.5v2A1.5 1.5 0 0 0 1 5.95V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.95A1.5 1.5 0 0 0 16 4.5v-2A1.5 1.5 0 0 0 14.5 1zM14 13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6h12v7.5zm1-9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v2z"/></svg>';
            html += '<span class="stash-msg">' + esc(s.message) + '</span>';
            html += '<span class="stash-date">' + fmtDate(s.date) + '</span>';
            html += '<button data-apply="' + s.index + '" title="Apply"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg></button>';
            html += '<button data-pop="' + s.index + '" title="Pop (apply and remove)"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1a.75.75 0 0 1 .75.75v6.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V1.75A.75.75 0 0 1 8 1z" transform="rotate(180 8 8)"/></svg></button>';
            html += '<button data-drop="' + s.index + '" title="Delete"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"/></svg></button>';
            html += '</div>';
        }

        shelfList.textContent = '';
        var temp = document.createElement('div');
        temp.innerHTML = html;
        while (temp.firstChild) { shelfList.appendChild(temp.firstChild); }

        shelfList.querySelectorAll('button[data-apply]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                vscode.postMessage({ type: 'stashApply', index: parseInt(btn.getAttribute('data-apply')) });
            });
        });
        shelfList.querySelectorAll('button[data-pop]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                vscode.postMessage({ type: 'stashPop', index: parseInt(btn.getAttribute('data-pop')) });
            });
        });
        shelfList.querySelectorAll('button[data-drop]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                vscode.postMessage({ type: 'stashDrop', index: parseInt(btn.getAttribute('data-drop')) });
            });
        });
    }

    function fmtDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        var m = d.getMonth() + 1;
        var day = d.getDate();
        var yr = d.getFullYear().toString().slice(-2);
        var hr = d.getHours();
        var ampm = hr >= 12 ? 'PM' : 'AM';
        hr = hr % 12 || 12;
        var min = d.getMinutes().toString().padStart(2, '0');
        return m + '/' + day + '/' + yr + ' ' + hr + ':' + min + ' ' + ampm;
    }

    function esc(text) {
        if (text == null) return '';
        return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
