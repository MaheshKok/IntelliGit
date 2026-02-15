// WebviewViewProvider that shows changed files (directory tree) and commit details
// in a single vertically stacked view. Files on top, commit info at the bottom.
// A drag handle between them lets the user resize the split.

import * as vscode from "vscode";
import type { CommitDetail, CommitFile } from "../types";

export class CommitInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "pycharmGit.commitFiles";

    private view?: vscode.WebviewView;
    private detail?: CommitDetail;

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        this.render();
    }

    setCommitDetail(detail: CommitDetail): void {
        this.detail = detail;
        this.render();
    }

    clear(): void {
        this.detail = undefined;
        this.render();
    }

    private render(): void {
        if (!this.view) return;
        this.view.webview.html = this.getHtml();
    }

    private getHtml(): string {
        if (!this.detail) {
            return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
       color: var(--vscode-descriptionForeground); padding: 8px 12px; }
</style></head>
<body>No commit selected</body></html>`;
        }

        const d = this.detail;
        const filesHtml = this.buildFileTreeHtml(d.files);
        const date = fmtPyCharmDate(d.date);
        const nonce = getNonce();

        return `<!DOCTYPE html>
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
    background: var(--vscode-editor-background);
    overflow: hidden;
}

.container {
    display: flex;
    flex-direction: column;
    height: 100%;
}

/* --- File tree --- */
.files-section {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 40px;
    padding: 4px 0;
}
details { margin: 0; }
summary {
    display: flex; align-items: center; gap: 4px;
    padding: 2px 0 2px 4px; cursor: pointer;
    list-style: none; line-height: 22px;
    user-select: none;
}
summary::-webkit-details-marker { display: none; }
summary::marker { display: none; }
summary::before {
    content: '\\25B6'; display: inline-block; font-size: 9px;
    width: 16px; text-align: center; flex-shrink: 0;
    transition: transform 0.1s; opacity: 0.6;
}
details[open] > summary::before { transform: rotate(90deg); }
.file-row {
    display: flex; align-items: center; gap: 4px;
    padding: 2px 0 2px 4px; line-height: 22px;
}
.indent { display: inline-block; width: 16px; flex-shrink: 0; }
.icon { width: 16px; height: 16px; flex-shrink: 0; }
.stats {
    margin-left: auto; font-size: 0.9em; flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
}
.add-stat { color: #2EA043; }
.del-stat { color: #F85149; }
.folder-count {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em; margin-left: 4px;
}
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* --- Drag handle --- */
.drag-handle {
    flex: 0 0 5px;
    cursor: row-resize;
    background: var(--vscode-panel-border, var(--vscode-widget-border, #444));
    position: relative;
}
.drag-handle::after {
    content: '';
    position: absolute;
    left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 30px; height: 2px;
    background: var(--vscode-descriptionForeground);
    opacity: 0.4;
    border-radius: 1px;
}
.drag-handle:hover {
    background: var(--vscode-focusBorder, #007acc);
}

/* --- Commit details --- */
.commit-section {
    flex: 0 0 auto;
    overflow-y: auto;
    min-height: 30px;
}
.commit-header {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 8px;
    font-weight: 600; font-size: 0.92em;
    color: var(--vscode-descriptionForeground);
    user-select: none;
    cursor: pointer;
}
.commit-header::before {
    content: '\\25B6'; display: inline-block; font-size: 9px;
    width: 16px; text-align: center; flex-shrink: 0;
    transition: transform 0.1s; opacity: 0.6;
}
.commit-header.open::before { transform: rotate(90deg); }
.commit-body {
    padding: 8px 12px;
    word-wrap: break-word; overflow-wrap: break-word;
}
.message { font-weight: 600; white-space: pre-wrap; line-height: 1.4; margin-bottom: 6px; }
.body { color: var(--vscode-descriptionForeground); white-space: pre-wrap; margin-bottom: 6px; line-height: 1.4; }
.meta { color: var(--vscode-descriptionForeground); font-size: 0.92em; line-height: 1.5; }
.hash { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
.author-name { font-weight: 500; }
</style>
</head>
<body>
<div class="container">
    <div class="files-section" id="filesSection">
        ${filesHtml}
    </div>
    <div class="drag-handle" id="dragHandle"></div>
    <div class="commit-section" id="commitSection">
        <div class="commit-header open" id="commitHeader">Commit Details</div>
        <div class="commit-body" id="commitBody">
            <div class="message">${esc(d.message)}</div>
            ${d.body ? `<div class="body">${esc(d.body)}</div>` : ""}
            <div class="meta">
                <span class="hash">${d.shortHash}</span> by <span class="author-name">${esc(d.author)}</span>
            </div>
            <div class="meta">${esc(d.email)} on ${date}</div>
            <div class="meta" style="margin-top:4px">
                ${d.files.length} file${d.files.length !== 1 ? "s" : ""} changed
            </div>
        </div>
    </div>
</div>
<script nonce="${nonce}">
(function() {
    const container = document.querySelector('.container');
    const filesSection = document.getElementById('filesSection');
    const dragHandle = document.getElementById('dragHandle');
    const commitSection = document.getElementById('commitSection');
    const commitHeader = document.getElementById('commitHeader');
    const commitBody = document.getElementById('commitBody');

    // Default commit section height = 40% of container
    let commitHeight = Math.round(container.clientHeight * 0.4);
    commitSection.style.height = commitHeight + 'px';

    // Collapse/expand toggle
    let collapsed = false;
    commitHeader.addEventListener('click', function() {
        collapsed = !collapsed;
        commitHeader.classList.toggle('open', !collapsed);
        commitBody.style.display = collapsed ? 'none' : '';
        if (collapsed) {
            commitSection.style.height = 'auto';
            commitSection.style.minHeight = '0';
            commitSection.style.overflow = 'hidden';
        } else {
            commitSection.style.height = commitHeight + 'px';
            commitSection.style.minHeight = '30px';
            commitSection.style.overflow = 'auto';
        }
    });

    // Drag to resize
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    dragHandle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        dragging = true;
        startY = e.clientY;
        startHeight = commitSection.offsetHeight;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        const delta = startY - e.clientY;
        const newHeight = Math.max(30, Math.min(container.clientHeight - 60, startHeight + delta));
        commitHeight = newHeight;
        commitSection.style.height = newHeight + 'px';
        if (collapsed) {
            collapsed = false;
            commitHeader.classList.add('open');
            commitBody.style.display = '';
            commitSection.style.minHeight = '30px';
            commitSection.style.overflow = 'auto';
        }
    });

    document.addEventListener('mouseup', function() {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
})();
</script>
</body>
</html>`;
    }

    private buildFileTreeHtml(files: CommitFile[]): string {
        interface DirNode {
            name: string;
            fullPath: string;
            files: CommitFile[];
            children: Map<string, DirNode>;
        }

        const rootFiles: CommitFile[] = [];
        const rootDirs = new Map<string, DirNode>();

        for (const f of files) {
            const parts = f.path.split("/");
            if (parts.length === 1) {
                rootFiles.push(f);
                continue;
            }
            let currentMap = rootDirs;
            let currentPath = "";
            for (let i = 0; i < parts.length - 1; i++) {
                const segment = parts[i];
                currentPath = currentPath ? `${currentPath}/${segment}` : segment;
                if (!currentMap.has(segment)) {
                    currentMap.set(segment, {
                        name: segment,
                        fullPath: currentPath,
                        files: [],
                        children: new Map(),
                    });
                }
                const node = currentMap.get(segment)!;
                if (i === parts.length - 2) {
                    node.files.push(f);
                } else {
                    currentMap = node.children;
                }
            }
        }

        const countFiles = (node: DirNode): number => {
            let c = node.files.length;
            for (const child of node.children.values()) c += countFiles(child);
            return c;
        };

        const renderDir = (node: DirNode, depth: number): string => {
            const indent = '<span class="indent"></span>'.repeat(depth);
            const count = countFiles(node);
            let h = `<details open>
<summary>${indent}${FOLDER_SVG}${esc(node.name)}<span class="folder-count">${count} file${count !== 1 ? "s" : ""}</span></summary>`;
            for (const child of node.children.values()) {
                h += renderDir(child, depth + 1);
            }
            for (const f of node.files) {
                h += renderFile(f, depth + 1);
            }
            h += "</details>";
            return h;
        };

        const renderFile = (f: CommitFile, depth: number): string => {
            const indent = '<span class="indent"></span>'.repeat(depth);
            const fileName = f.path.split("/").pop()!;
            const icon = STATUS_SVGS[f.status] ?? FILE_SVG;
            const stats: string[] = [];
            if (f.additions > 0) stats.push(`<span class="add-stat">+${f.additions}</span>`);
            if (f.deletions > 0) stats.push(`<span class="del-stat">-${f.deletions}</span>`);
            return `<div class="file-row">${indent}${icon}<span class="file-name">${esc(fileName)}</span><span class="stats">${stats.join(" ")}</span></div>`;
        };

        let html = "";
        for (const dir of rootDirs.values()) {
            html += renderDir(dir, 0);
        }
        for (const f of rootFiles) {
            html += renderFile(f, 0);
        }
        return html;
    }

    dispose(): void {
        // nothing to dispose
    }
}

// --- SVG icons ---

const FOLDER_SVG =
    '<svg class="icon" viewBox="0 0 16 16"><path fill="var(--vscode-icon-foreground, currentColor)" d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.85A.5.5 0 0 0 6.5 2.5H1.5z"/></svg>';

const FILE_SVG =
    '<svg class="icon" viewBox="0 0 16 16"><path fill="currentColor" d="M3.75 1.5a.25.25 0 0 0-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073zM2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25z"/></svg>';

const STATUS_SVGS: Record<string, string> = {
    A: '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#2EA043" stroke-width="1.5"/><path d="M8 5v6M5 8h6" stroke="#2EA043" stroke-width="1.5"/></svg>',
    M: '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#D29922" stroke-width="1.5"/><path d="M5.5 6.5h5M5.5 9.5h5" stroke="#D29922" stroke-width="1.5"/></svg>',
    D: '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#F85149" stroke-width="1.5"/><path d="M5 8h6" stroke="#F85149" stroke-width="1.5"/></svg>',
    R: '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#A371F7" stroke-width="1.5"/><path d="M5 8h4M8 5.5L10.5 8 8 10.5" stroke="#A371F7" stroke-width="1.5" fill="none"/></svg>',
    C: '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#2EA043" stroke-width="1.5"/><path d="M8 5v6M5 8h6" stroke="#2EA043" stroke-width="1.5"/></svg>',
    T: '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#D29922" stroke-width="1.5"/><path d="M5.5 6.5h5M5.5 9.5h5" stroke="#D29922" stroke-width="1.5"/></svg>',
};

// --- Helpers ---

function esc(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function fmtPyCharmDate(iso: string): string {
    const d = new Date(iso);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const yr = d.getFullYear().toString().slice(-2);
    let hr = d.getHours();
    const ampm = hr >= 12 ? "PM" : "AM";
    hr = hr % 12 || 12;
    const min = d.getMinutes().toString().padStart(2, "0");
    return `${m}/${day}/${yr} at ${hr}:${min}\u202F${ampm}`;
}

function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    for (let i = 0; i < 32; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
    return r;
}
