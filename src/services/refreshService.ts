// Auto-refresh service extracted from extension.ts.
// Manages debounced light (commit panel only) and full
// (branches + graph + panel + conflicts) refresh cycles,
// plus file system watchers on the .git directory.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch } from "../types";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { MergeConflictsTreeProvider } from "../views/MergeConflictsTreeProvider";
import type { UndockedViewProvider } from "../views/UndockedViewProvider";

export interface RefreshServiceDeps {
    gitOps: GitOps;
    commitGraph: CommitGraphViewProvider;
    additionalCommitGraphs?: CommitGraphViewProvider[];
    commitPanel: CommitPanelViewProvider;
    mergeConflicts: MergeConflictsTreeProvider;
    mergeConflictsView: vscode.TreeView<unknown>;
    onBranchesUpdated: (branches: Branch[]) => void;
    getUndocked?: () => UndockedViewProvider | undefined;
}

export class RefreshService implements vscode.Disposable {
    private lightTimer: ReturnType<typeof setTimeout> | undefined;
    private fullTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly fsWatchers: fs.FSWatcher[] = [];
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly deps: RefreshServiceDeps,
        private readonly repoRoot: string,
    ) {}

    async refreshMergeConflicts(): Promise<void> {
        const count = await this.deps.mergeConflicts.refresh();
        this.deps.mergeConflictsView.description = count > 0 ? `${count}` : "";
        await vscode.commands.executeCommand(
            "setContext",
            "intelligit.hasMergeConflicts",
            count > 0,
        );
    }

    async refreshCommitPanels(): Promise<void> {
        const undocked = this.deps.getUndocked?.();
        await Promise.all([
            this.deps.commitPanel.refresh(),
            ...(undocked ? [undocked.refresh()] : []),
        ]);
    }

    async refreshConflictUi(): Promise<void> {
        await this.refreshCommitPanels();
        await this.refreshMergeConflicts();
    }

    async refreshAll(): Promise<void> {
        await vscode.commands.executeCommand("intelligit.refresh");
    }

    debouncedLightRefresh(): void {
        if (this.lightTimer) clearTimeout(this.lightTimer);
        this.lightTimer = setTimeout(() => {
            void this.refreshCommitPanels().catch((err) => {
                console.error("[IntelliGit] Light refresh failed:", err);
            });
        }, 300);
    }

    debouncedFullRefresh(): void {
        if (this.fullTimer) clearTimeout(this.fullTimer);
        this.fullTimer = setTimeout(() => {
            void (async () => {
                const branches = await this.deps.gitOps.getBranches();
                const commitGraphs = [
                    this.deps.commitGraph,
                    ...(this.deps.additionalCommitGraphs ?? []),
                ];
                this.deps.onBranchesUpdated(branches);
                for (const graph of commitGraphs) {
                    graph.setBranches(branches);
                }
                this.deps.commitPanel.setBranches(branches);
                const undocked = this.deps.getUndocked?.();
                undocked?.setBranches(branches);
                await Promise.all(commitGraphs.map((graph) => graph.refresh()));
                await this.refreshCommitPanels();
                await this.refreshMergeConflicts();
            })().catch((err) => {
                console.error("[IntelliGit] Full refresh failed:", err);
            });
        }, 500);
    }

    registerFileWatchers(): void {
        const handler = () => this.debouncedLightRefresh();

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(handler),
            vscode.workspace.onDidSaveTextDocument(handler),
            vscode.workspace.onDidCreateFiles(handler),
            vscode.workspace.onDidDeleteFiles(handler),
            vscode.workspace.onDidRenameFiles(handler),
        );

        this.registerGitDirWatchers();
    }

    private resolveGitDir(): string {
        const dotGit = path.join(this.repoRoot, ".git");
        try {
            const stat = fs.statSync(dotGit);
            if (stat.isFile()) {
                const content = fs.readFileSync(dotGit, "utf8").trim();
                const match = content.match(/^gitdir:\s*(.+)$/);
                if (match) {
                    const gitDir = match[1];
                    return path.isAbsolute(gitDir) ? gitDir : path.resolve(this.repoRoot, gitDir);
                }
            }
        } catch {
            // Fall through to default
        }
        return dotGit;
    }

    private registerGitDirWatchers(): void {
        const gitDir = this.resolveGitDir();
        const gitStateFiles = new Set([
            "HEAD",
            "FETCH_HEAD",
            "packed-refs",
            "MERGE_HEAD",
            "REBASE_HEAD",
            "index",
        ]);

        try {
            const dirWatcher = fs.watch(gitDir, (_event, filename) => {
                if (!filename) {
                    this.debouncedFullRefresh();
                    return;
                }
                if (gitStateFiles.has(filename)) {
                    if (filename === "index") {
                        this.debouncedLightRefresh();
                    } else {
                        this.debouncedFullRefresh();
                    }
                }
            });
            this.fsWatchers.push(dirWatcher);
        } catch {
            /* .git dir may not be watchable */
        }

        try {
            // fs.watch with recursive: true is only supported on macOS and Windows.
            // On Linux, use vscode.workspace.createFileSystemWatcher for cross-platform
            // recursive watching of the refs directory.
            const refsPath = path.join(gitDir, "refs");
            if (process.platform === "linux") {
                const pattern = new vscode.RelativePattern(vscode.Uri.file(refsPath), "**/*");
                const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                const handler = () => this.debouncedFullRefresh();
                this.disposables.push(
                    watcher.onDidChange(handler),
                    watcher.onDidCreate(handler),
                    watcher.onDidDelete(handler),
                    watcher,
                );
            } else {
                const refsWatcher = fs.watch(refsPath, { recursive: true }, () =>
                    this.debouncedFullRefresh(),
                );
                this.fsWatchers.push(refsWatcher);
            }
        } catch {
            /* refs dir may not exist yet or may not be watchable */
        }
    }

    dispose(): void {
        if (this.lightTimer) clearTimeout(this.lightTimer);
        if (this.fullTimer) clearTimeout(this.fullTimer);
        for (const watcher of this.fsWatchers) {
            watcher.close();
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
