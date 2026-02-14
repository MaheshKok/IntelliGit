// Extension entry point. Registers three coordinated views: sidebar branch tree,
// bottom-panel commit graph (webview), and bottom-panel changed files tree.
// The extension host is the sole data coordinator -- views never talk directly.

import * as vscode from "vscode";
import { GitExecutor } from "./git/executor";
import { GitOps } from "./git/operations";
import { BranchTreeProvider } from "./views/BranchTreeProvider";
import { CommitGraphViewProvider } from "./views/CommitGraphViewProvider";
import { CommitFilesTreeProvider } from "./views/CommitFilesTreeProvider";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const repoRoot = workspaceFolder.uri.fsPath;
    const executor = new GitExecutor(repoRoot);
    const gitOps = new GitOps(executor);

    try {
        const isRepo = await gitOps.isRepository();
        if (!isRepo) return;
    } catch {
        return;
    }

    // --- Providers ---

    const branchTree = new BranchTreeProvider();
    const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps);
    const commitFiles = new CommitFilesTreeProvider();

    // --- Register views ---

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("pycharmGit.branches", branchTree),
        vscode.window.registerWebviewViewProvider(CommitGraphViewProvider.viewType, commitGraph),
        vscode.window.registerTreeDataProvider("pycharmGit.commitFiles", commitFiles),
    );

    // --- Wire data flow ---

    // When a commit is selected in the graph, load its details and show changed files
    context.subscriptions.push(
        commitGraph.onCommitSelected(async (hash) => {
            try {
                const detail = await gitOps.getCommitDetail(hash);
                commitFiles.setCommitDetail(detail);
                await vscode.commands.executeCommand(
                    "setContext",
                    "pycharmGit.hasSelectedCommit",
                    true,
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to load commit: ${message}`);
            }
        }),
    );

    // When a branch is selected in the webview's inline branch column, clear changed files
    context.subscriptions.push(
        commitGraph.onBranchFilterChanged(async () => {
            commitFiles.clear();
            await vscode.commands.executeCommand(
                "setContext",
                "pycharmGit.hasSelectedCommit",
                false,
            );
        }),
    );

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand("pycharmGit.refresh", async () => {
            const branches = await gitOps.getBranches();
            branchTree.refresh(branches);
            commitGraph.setBranches(branches);
            await commitGraph.refresh();
            commitFiles.clear();
            await vscode.commands.executeCommand(
                "setContext",
                "pycharmGit.hasSelectedCommit",
                false,
            );
        }),

        vscode.commands.registerCommand(
            "pycharmGit.filterByBranch",
            async (branchName?: string) => {
                await commitGraph.filterByBranch(branchName ?? null);
                commitFiles.clear();
                await vscode.commands.executeCommand(
                    "setContext",
                    "pycharmGit.hasSelectedCommit",
                    false,
                );
            },
        ),

        vscode.commands.registerCommand("pycharmGit.showGitLog", async () => {
            // Reveal the sidebar and panel views
            await vscode.commands.executeCommand("pycharmGit.branches.focus");
            await vscode.commands.executeCommand("pycharmGit.commitGraph.focus");
        }),
    );

    // --- Initial load ---

    const branches = await gitOps.getBranches();
    branchTree.refresh(branches);
    commitGraph.setBranches(branches);

    // --- Disposables ---

    context.subscriptions.push(branchTree, commitGraph, commitFiles);
}

export function deactivate(): void {}
