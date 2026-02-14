// Native TreeDataProvider that shows changed files for a selected commit in the bottom panel.
// Files are displayed in a directory tree structure matching PyCharm's layout.
// Below the files, a separator and commit metadata (hash, author, date) are shown.

import * as vscode from "vscode";
import type { CommitFile, CommitDetail } from "../types";

const STATUS_ICONS: Record<string, string> = {
    A: "diff-added",
    M: "diff-modified",
    D: "diff-removed",
    R: "diff-renamed",
    C: "diff-added",
    T: "diff-modified",
};

const STATUS_LABELS: Record<string, string> = {
    A: "Added",
    M: "Modified",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    T: "Type changed",
};

type TreeElement = FolderItem | FileItem | SeparatorItem | CommitInfoItem;

class FolderItem extends vscode.TreeItem {
    readonly kind = "folder" as const;
    constructor(
        public readonly folderPath: string,
        public readonly fileCount: number,
    ) {
        const label = folderPath.split("/").pop() ?? folderPath;
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
        this.iconPath = new vscode.ThemeIcon("folder");
        this.contextValue = "folder";
    }
}

export class FileItem extends vscode.TreeItem {
    readonly kind = "file" as const;
    constructor(
        public readonly file: CommitFile,
        showFullPath: boolean,
    ) {
        const label = showFullPath ? file.path : file.path.split("/").pop()!;
        super(label, vscode.TreeItemCollapsibleState.None);

        this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[file.status] ?? "file");
        this.tooltip = `${STATUS_LABELS[file.status] ?? file.status}: ${file.path}`;

        const stats: string[] = [];
        if (file.additions > 0) stats.push(`+${file.additions}`);
        if (file.deletions > 0) stats.push(`-${file.deletions}`);
        this.description = stats.join(" ");

        this.contextValue = "changedFile";
    }
}

class SeparatorItem extends vscode.TreeItem {
    readonly kind = "separator" as const;
    constructor() {
        super("", vscode.TreeItemCollapsibleState.None);
        this.description = "\u2500".repeat(40);
        this.contextValue = "separator";
    }
}

class CommitInfoItem extends vscode.TreeItem {
    readonly kind = "commitInfo" as const;
    constructor(label: string, description: string, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = "commitInfo";
    }
}

interface DirNode {
    name: string;
    fullPath: string;
    files: CommitFile[];
    children: Map<string, DirNode>;
}

function buildFileTree(files: CommitFile[]): { rootFiles: CommitFile[]; folders: DirNode[] } {
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

    return { rootFiles, folders: Array.from(rootDirs.values()) };
}

function countFilesInDir(node: DirNode): number {
    let count = node.files.length;
    for (const child of node.children.values()) {
        count += countFilesInDir(child);
    }
    return count;
}

export class CommitFilesTreeProvider implements vscode.TreeDataProvider<TreeElement> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private files: CommitFile[] = [];
    private detail: CommitDetail | null = null;
    private tree: { rootFiles: CommitFile[]; folders: DirNode[] } = { rootFiles: [], folders: [] };

    setCommitDetail(commitDetail: CommitDetail): void {
        this.detail = commitDetail;
        this.files = commitDetail.files;
        this.tree = buildFileTree(this.files);
        this._onDidChangeTreeData.fire(undefined);
    }

    clear(): void {
        this.files = [];
        this.detail = null;
        this.tree = { rootFiles: [], folders: [] };
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeElement): TreeElement[] {
        if (!element) {
            return this.getRootChildren();
        }

        if (element instanceof FolderItem) {
            return this.getFolderChildren(element.folderPath);
        }

        return [];
    }

    private getRootChildren(): TreeElement[] {
        const items: TreeElement[] = [];

        // Folder nodes
        for (const dir of this.tree.folders) {
            items.push(new FolderItem(dir.fullPath, countFilesInDir(dir)));
        }

        // Root-level files (no directory)
        for (const f of this.tree.rootFiles) {
            items.push(new FileItem(f, true));
        }

        // Separator + commit details
        if (this.detail) {
            items.push(new SeparatorItem());
            items.push(
                new CommitInfoItem(this.detail.shortHash, this.detail.message, "git-commit"),
            );
            items.push(
                new CommitInfoItem(this.detail.author, fmtRelativeDate(this.detail.date), "person"),
            );
            const count = this.files.length;
            items.push(
                new CommitInfoItem(`${count} file${count !== 1 ? "s" : ""} changed`, "", "diff"),
            );
        }

        return items;
    }

    private getFolderChildren(folderPath: string): TreeElement[] {
        const node = this.findDirNode(folderPath);
        if (!node) return [];

        const items: TreeElement[] = [];

        // Sub-folders
        for (const child of node.children.values()) {
            items.push(new FolderItem(child.fullPath, countFilesInDir(child)));
        }

        // Files in this folder
        for (const f of node.files) {
            items.push(new FileItem(f, false));
        }

        return items;
    }

    private findDirNode(folderPath: string): DirNode | undefined {
        const segments = folderPath.split("/");
        let currentMap = new Map<string, DirNode>();
        for (const dir of this.tree.folders) {
            currentMap.set(dir.name, dir);
        }

        let node: DirNode | undefined;
        for (const seg of segments) {
            node = currentMap.get(seg);
            if (!node) return undefined;
            currentMap = node.children;
        }
        return node;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

function fmtRelativeDate(iso: string): string {
    try {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return "today";
        if (diffDays === 1) return "yesterday";
        if (diffDays < 7) return `${diffDays} days ago`;
        const weeks = Math.floor(diffDays / 7);
        if (diffDays < 30) return `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
        const months = Math.floor(diffDays / 30);
        if (diffDays < 365) return `${months} month${months !== 1 ? "s" : ""} ago`;
        const years = Math.floor(diffDays / 365);
        return `${years} year${years !== 1 ? "s" : ""} ago`;
    } catch {
        return iso;
    }
}
