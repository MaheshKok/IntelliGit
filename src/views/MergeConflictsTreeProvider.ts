import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";

export class MergeConflictTreeItem extends vscode.TreeItem {
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

export class MergeConflictsTreeProvider implements vscode.TreeDataProvider<MergeConflictTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private conflicts: string[] = [];

    constructor(
        private readonly gitOps: GitOps,
        private workspaceRoot: vscode.Uri,
    ) {}

    setWorkspaceRoot(workspaceRoot: vscode.Uri): void {
        this.workspaceRoot = workspaceRoot;
        this.conflicts = [];
        this._onDidChangeTreeData.fire();
    }

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

    getTreeItem(element: MergeConflictTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MergeConflictTreeItem): MergeConflictTreeItem[] {
        if (element) return [];
        return this.conflicts.map(
            (filePath) => new MergeConflictTreeItem(filePath, this.workspaceRoot),
        );
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
