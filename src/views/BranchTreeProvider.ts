// Native TreeDataProvider that renders branches in the sidebar under the activity bar icon.
// Shows three sections: HEAD (current branch), Local branches, and Remote branches grouped by remote.

import * as vscode from "vscode";
import type { Branch } from "../types";

type BranchItemType = "head" | "section" | "remote-group" | "branch";

export class BranchItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly itemType: BranchItemType,
        public readonly branch?: Branch,
        collapsible?: vscode.TreeItemCollapsibleState,
    ) {
        super(label, collapsible ?? vscode.TreeItemCollapsibleState.None);

        switch (itemType) {
            case "head":
                this.iconPath = new vscode.ThemeIcon("git-branch");
                this.contextValue = "head";
                this.description = branch?.hash.slice(0, 7);
                break;
            case "section":
                this.iconPath = new vscode.ThemeIcon("folder-opened");
                this.contextValue = "section";
                break;
            case "remote-group":
                this.iconPath = new vscode.ThemeIcon("repo");
                this.contextValue = "remote-group";
                break;
            case "branch":
                if (branch?.isCurrent) {
                    this.contextValue = "currentBranch";
                } else {
                    this.contextValue = branch?.isRemote ? "remoteBranch" : "localBranch";
                }
                this.iconPath = branch?.isCurrent
                    ? new vscode.ThemeIcon("git-branch", new vscode.ThemeColor("charts.green"))
                    : new vscode.ThemeIcon("git-branch");
                if (branch) {
                    this.description = formatTrackingInfo(branch);
                    const trackingTooltip = formatTrackingTooltip(branch);
                    this.tooltip = trackingTooltip ? `${branch.name}\n${trackingTooltip}` : branch.name;
                    this.command = {
                        command: "intelligit.filterByBranch",
                        title: "Filter by Branch",
                        arguments: [branch.name],
                    };
                }
                break;
        }
    }
}

function formatTrackingInfo(branch: Branch): string {
    const parts: string[] = [];
    if (branch.ahead > 0) parts.push(`\u{1F535}\u2B06${branch.ahead}`);
    if (branch.behind > 0) parts.push(`\u{1F7E0}\u2B07${branch.behind}`);
    return parts.join(" ");
}

function formatTrackingTooltip(branch: Branch): string {
    const parts: string[] = [];
    if (branch.ahead > 0) {
        parts.push(`Ahead by ${branch.ahead} commit${branch.ahead === 1 ? "" : "s"} (to push)`);
    }
    if (branch.behind > 0) {
        parts.push(`Behind by ${branch.behind} commit${branch.behind === 1 ? "" : "s"} (to pull)`);
    }
    return parts.join(" | ");
}

export class BranchTreeProvider implements vscode.TreeDataProvider<BranchItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private branches: Branch[] = [];
    private currentBranch = "";

    refresh(branches: Branch[]): void {
        this.branches = branches;
        this.currentBranch = branches.find((b) => b.isCurrent)?.name ?? "HEAD";
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: BranchItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BranchItem): BranchItem[] {
        if (!element) {
            return this.getRootItems();
        }

        if (element.itemType === "section" && element.label === "Local") {
            return this.getLocalBranches();
        }

        if (element.itemType === "section" && element.label === "Remote") {
            return this.getRemoteGroups();
        }

        if (element.itemType === "remote-group") {
            return this.getRemoteBranches(element.label as string);
        }

        return [];
    }

    private getRootItems(): BranchItem[] {
        const items: BranchItem[] = [];

        const current = this.branches.find((b) => b.isCurrent);
        if (current) {
            items.push(new BranchItem(`HEAD \u2192 ${current.name}`, "head", current));
        }

        const hasLocal = this.branches.some((b) => !b.isRemote);
        if (hasLocal) {
            items.push(
                new BranchItem(
                    "Local",
                    "section",
                    undefined,
                    vscode.TreeItemCollapsibleState.Expanded,
                ),
            );
        }

        const hasRemote = this.branches.some((b) => b.isRemote);
        if (hasRemote) {
            items.push(
                new BranchItem(
                    "Remote",
                    "section",
                    undefined,
                    vscode.TreeItemCollapsibleState.Expanded,
                ),
            );
        }

        return items;
    }

    private getLocalBranches(): BranchItem[] {
        return this.branches
            .filter((b) => !b.isRemote)
            .map((b) => new BranchItem(b.name, "branch", b));
    }

    private getRemoteGroups(): BranchItem[] {
        const remotes = new Set<string>();
        for (const b of this.branches) {
            if (b.isRemote && b.remote) {
                remotes.add(b.remote);
            }
        }
        return Array.from(remotes).map(
            (r) =>
                new BranchItem(
                    r,
                    "remote-group",
                    undefined,
                    vscode.TreeItemCollapsibleState.Collapsed,
                ),
        );
    }

    private getRemoteBranches(remote: string): BranchItem[] {
        return this.branches
            .filter((b) => b.isRemote && b.remote === remote)
            .map((b) => {
                const shortName = b.name.split("/").slice(1).join("/");
                return new BranchItem(shortName, "branch", b);
            });
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
