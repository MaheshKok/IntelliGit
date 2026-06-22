import path from "node:path";
import * as vscode from "vscode";
import type { WorktreeService } from "../services/worktreeService";
import type { GitWorktree } from "../types";

/** Native read-only tree provider for Git worktrees in the IntelliGit sidebar. */
export class WorktreesTreeProvider
    implements vscode.TreeDataProvider<GitWorktree>, vscode.Disposable
{
    static readonly viewType = "intelligit.worktrees";

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private readonly worktreeSubscription: vscode.Disposable;
    private worktrees: GitWorktree[] = [];
    private loaded = false;

    /** Create a tree provider backed by the shared read-only worktree service. */
    constructor(private readonly worktreeService: WorktreeService) {
        this.worktreeSubscription = this.worktreeService.onDidChangeWorktrees((worktrees) => {
            this.worktrees = worktrees;
            this.loaded = true;
            this._onDidChangeTreeData.fire();
        });
    }

    /** Ask the service to reload and let its change event update the tree. */
    async refresh(): Promise<void> {
        await this.worktreeService.refresh();
    }

    /** Convert one cached Git worktree into a native VS Code tree row. */
    getTreeItem(worktree: GitWorktree): vscode.TreeItem {
        const item = new vscode.TreeItem(
            getWorktreeLabel(worktree),
            vscode.TreeItemCollapsibleState.None,
        );
        item.id = worktree.path;
        item.description = path.basename(worktree.path) || worktree.path;
        item.tooltip = worktree.path;
        item.contextValue = getContextValue(worktree);
        item.iconPath = getIcon(worktree);
        return item;
    }

    /** Return top-level worktree rows only; worktree rows are leaves. */
    async getChildren(element?: GitWorktree): Promise<GitWorktree[]> {
        if (element) return [];
        if (!this.loaded) {
            this.worktrees = await this.worktreeService.listWorktrees();
            this.loaded = true;
        }
        return this.worktrees;
    }

    /** Dispose service and tree-data subscriptions owned by this provider. */
    dispose(): void {
        this.worktreeSubscription.dispose();
        this._onDidChangeTreeData.dispose();
    }
}

/** Chooses the most useful stable row label without exposing full paths in the primary column. */
function getWorktreeLabel(worktree: GitWorktree): string {
    if (worktree.branch) return worktree.branch;
    if (worktree.head) return worktree.head.slice(0, 7);
    return path.basename(worktree.path) || worktree.path;
}

/** Encodes row capabilities for VS Code `when` clauses without re-checking state in package metadata. */
function getContextValue(worktree: GitWorktree): string {
    return [
        "intelligit.worktree",
        worktree.state,
        !worktree.isMain && !worktree.isCurrent ? "deletable" : undefined,
        !worktree.isMain && !worktree.isCurrent && !worktree.isLocked ? "lockable" : undefined,
        worktree.isCurrent ? "current" : undefined,
        worktree.isLocked ? "locked" : undefined,
        worktree.isPrunable ? "prunable" : undefined,
    ]
        .filter(Boolean)
        .join(" ");
}

/** Maps Git worktree state to VS Code theme icons while keeping current/locked/prunable visually distinct. */
function getIcon(worktree: GitWorktree): vscode.ThemeIcon {
    if (worktree.isCurrent) {
        return new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
    }
    if (worktree.isLocked) {
        return new vscode.ThemeIcon(
            "lock",
            new vscode.ThemeColor("problemsWarningIcon.foreground"),
        );
    }
    if (worktree.isPrunable) {
        return new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("problemsWarningIcon.foreground"),
        );
    }
    if (worktree.state === "detached") return new vscode.ThemeIcon("git-commit");
    if (worktree.state === "bare") return new vscode.ThemeIcon("database");
    return new vscode.ThemeIcon("repo");
}
