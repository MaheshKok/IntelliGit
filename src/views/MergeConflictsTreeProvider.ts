import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";

/**
 * Tree item representing one repository-relative conflicted file.
 *
 * The command payload includes both the original Git path and a workspace URI so command handlers
 * can open the merge editor without re-deriving the active repository root from global state.
 */
export class MergeConflictTreeItem extends vscode.TreeItem {
    /**
     * Builds the VS Code tree row and command payload for a conflicted Git path.
     *
     * The path is expected to come from `GitOps.getConflictedFiles`; the item preserves that
     * repository-relative value for merge commands while deriving a workspace URI for editor APIs.
     */
    constructor(
        public readonly filePath: string,
        workspaceRoot: vscode.Uri,
    ) {
        const label = path.basename(filePath) || filePath;
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = path.dirname(filePath) === "." ? undefined : path.dirname(filePath);
        this.tooltip = filePath;
        this.contextValue = "intelligit.conflictFile";
        this.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("problemsWarningIcon.foreground"),
        );
        const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
        this.command = {
            command: "intelligit.openMergeConflict",
            title: vscode.l10n.t("Open Merge Conflict"),
            arguments: [{ filePath, uri }],
        };
    }
}

/**
 * Provides the merge-conflicts tree view for the active repository.
 *
 * The provider caches the last successful conflict file list. Refresh failures are intentionally
 * converted to an empty tree so repository transitions, aborted merges, or transient Git errors do
 * not leave stale conflict badges visible in the VS Code UI.
 */
export class MergeConflictsTreeProvider implements vscode.TreeDataProvider<MergeConflictTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private conflicts: string[] = [];

    /**
     * Creates a conflict tree bound to one active repository root.
     *
     * `gitOps` and `workspaceRoot` must describe the same repository because refreshes read Git
     * conflict paths while tree items later map those paths into workspace URIs.
     */
    constructor(
        private readonly gitOps: GitOps,
        private workspaceRoot: vscode.Uri,
    ) {}

    /**
     * Switches the tree to a new active workspace root and clears stale conflict rows.
     */
    setWorkspaceRoot(workspaceRoot: vscode.Uri): void {
        this.workspaceRoot = workspaceRoot;
        this.conflicts = [];
        this._onDidChangeTreeData.fire();
    }

    /**
     * Reloads conflicted files and emits a tree change event for badge/context updates.
     *
     * @returns The number of conflicts currently cached after the refresh completes.
     */
    async refresh(): Promise<number> {
        try {
            this.conflicts = await this.gitOps.getConflictedFiles();
        } catch {
            this.conflicts = [];
            this._onDidChangeTreeData.fire();
            return 0;
        }
        this._onDidChangeTreeData.fire();
        return this.conflicts.length;
    }

    /**
     * Returns the already configured conflict row without mutating cached conflict state.
     */
    getTreeItem(element: MergeConflictTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * Returns top-level conflict rows only; conflict items do not have child nodes.
     */
    getChildren(element?: MergeConflictTreeItem): MergeConflictTreeItem[] {
        if (element) return [];
        return this.conflicts.map(
            (filePath) => new MergeConflictTreeItem(filePath, this.workspaceRoot),
        );
    }

    /**
     * Releases the tree data change emitter owned by this provider.
     */
    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
