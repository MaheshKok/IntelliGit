// Native TreeDataProvider that shows changed files for a selected commit in the bottom panel.
// Displays commit metadata (hash, author, date) above a flat file list with status icons.

import * as vscode from 'vscode';
import type { CommitFile, CommitDetail } from '../types';

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

type TreeElement = CommitInfoItem | FileItem;

class CommitInfoItem extends vscode.TreeItem {
    constructor(label: string, description: string, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'commitInfo';
    }
}

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

export class CommitFilesTreeProvider implements vscode.TreeDataProvider<TreeElement> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private files: CommitFile[] = [];
    private detail: CommitDetail | null = null;

    setCommitDetail(commitDetail: CommitDetail): void {
        this.detail = commitDetail;
        this.files = commitDetail.files;
        this._onDidChangeTreeData.fire(undefined);
    }

    clear(): void {
        this.files = [];
        this.detail = null;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        return element;
    }

    getChildren(): TreeElement[] {
        const items: TreeElement[] = [];

        // Files first
        items.push(...this.files.map(f => new FileItem(f)));

        // Commit details below
        if (this.detail) {
            items.push(new CommitInfoItem(
                this.detail.shortHash,
                this.detail.message,
                'git-commit',
            ));
            items.push(new CommitInfoItem(
                this.detail.author,
                fmtRelativeDate(this.detail.date),
                'person',
            ));
            const count = this.files.length;
            items.push(new CommitInfoItem(
                `${count} file${count !== 1 ? 's' : ''} changed`,
                '',
                'diff',
            ));
        }

        return items;
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

        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        const weeks = Math.floor(diffDays / 7);
        if (diffDays < 30) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
        const months = Math.floor(diffDays / 30);
        if (diffDays < 365) return `${months} month${months !== 1 ? 's' : ''} ago`;
        const years = Math.floor(diffDays / 365);
        return `${years} year${years !== 1 ? 's' : ''} ago`;
    } catch {
        return iso;
    }
}
