// Native TreeDataProvider that shows changed files for a selected commit in the bottom panel.
// Displays a flat list with status color icons, additions/deletions counts, and opens diff on click.

import * as vscode from 'vscode';
import type { CommitFile } from '../types';

const STATUS_ICONS: Record<string, string> = {
    A: 'diff-added',
    M: 'diff-modified',
    D: 'diff-removed',
    R: 'diff-renamed',
    C: 'diff-added',
    T: 'diff-modified',
};

const STATUS_LABELS: Record<string, string> = {
    A: 'Added',
    M: 'Modified',
    D: 'Deleted',
    R: 'Renamed',
    C: 'Copied',
    T: 'Type changed',
};

export class FileItem extends vscode.TreeItem {
    constructor(public readonly file: CommitFile) {
        super(file.path, vscode.TreeItemCollapsibleState.None);

        this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[file.status] ?? 'file');
        this.tooltip = `${STATUS_LABELS[file.status] ?? file.status}: ${file.path}`;

        const stats: string[] = [];
        if (file.additions > 0) stats.push(`+${file.additions}`);
        if (file.deletions > 0) stats.push(`-${file.deletions}`);
        this.description = stats.join(' ');

        this.contextValue = 'changedFile';
    }
}

export class CommitFilesTreeProvider implements vscode.TreeDataProvider<FileItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private files: CommitFile[] = [];

    setFiles(files: CommitFile[]): void {
        this.files = files;
        this._onDidChangeTreeData.fire(undefined);
    }

    clear(): void {
        this.files = [];
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: FileItem): vscode.TreeItem {
        return element;
    }

    getChildren(): FileItem[] {
        return this.files.map(f => new FileItem(f));
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
