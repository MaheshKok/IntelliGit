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

interface VsCodeGitExtension {
    getAPI(version: 1): VsCodeGitApi;
}

interface VsCodeGitApi {
    repositories: VsCodeGitRepository[];
    onDidOpenRepository?: (
        listener: (repository: VsCodeGitRepository) => unknown,
    ) => vscode.Disposable;
    onDidCloseRepository?: (
        listener: (repository: VsCodeGitRepository) => unknown,
    ) => vscode.Disposable;
}

interface VsCodeGitRepository {
    rootUri: vscode.Uri;
    onDidChangeState?: (listener: () => unknown) => vscode.Disposable;
}

export class RefreshService implements vscode.Disposable {
    private lightTimer: ReturnType<typeof setTimeout> | undefined;
    private fullTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly fsWatchers: fs.FSWatcher[] = [];
    private readonly gitRepositoryStateDisposables = new Map<string, vscode.Disposable>();
    private readonly disposables: vscode.Disposable[] = [];
    private disposed = false;

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
        this.registerVsCodeGitWatchers();
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

    private registerVsCodeGitWatchers(): void {
        void this.registerVsCodeGitWatchersAsync().catch((err) => {
            console.error("[IntelliGit] Failed to register VS Code Git refresh listener:", err);
        });
    }

    private async registerVsCodeGitWatchersAsync(): Promise<void> {
        const gitExtension = vscode.extensions?.getExtension<VsCodeGitExtension>("vscode.git");
        if (!gitExtension) return;

        const git = await gitExtension.activate();
        if (this.disposed) return;

        const api = git.getAPI(1);
        for (const repository of api.repositories) {
            this.registerGitRepositoryStateWatcher(repository);
        }

        if (api.onDidOpenRepository) {
            this.disposables.push(
                api.onDidOpenRepository((repository) => {
                    this.registerGitRepositoryStateWatcher(repository);
                }),
            );
        }

        if (api.onDidCloseRepository) {
            this.disposables.push(
                api.onDidCloseRepository((repository) => {
                    this.disposeGitRepositoryStateWatcher(repository);
                }),
            );
        }
    }

    private registerGitRepositoryStateWatcher(repository: VsCodeGitRepository): void {
        if (this.disposed || !this.isActiveRepository(repository) || !repository.onDidChangeState) {
            return;
        }

        const rootKey = normalizedPath(repository.rootUri.fsPath);
        if (this.gitRepositoryStateDisposables.has(rootKey)) return;

        this.gitRepositoryStateDisposables.set(
            rootKey,
            repository.onDidChangeState(() => this.debouncedLightRefresh()),
        );
    }

    private disposeGitRepositoryStateWatcher(repository: VsCodeGitRepository): void {
        const rootKey = normalizedPath(repository.rootUri.fsPath);
        const disposable = this.gitRepositoryStateDisposables.get(rootKey);
        if (!disposable) return;
        disposable.dispose();
        this.gitRepositoryStateDisposables.delete(rootKey);
    }

    private isActiveRepository(repository: VsCodeGitRepository): boolean {
        return normalizedPath(repository.rootUri.fsPath) === normalizedPath(this.repoRoot);
    }

    dispose(): void {
        this.disposed = true;
        if (this.lightTimer) clearTimeout(this.lightTimer);
        if (this.fullTimer) clearTimeout(this.fullTimer);
        for (const watcher of this.fsWatchers) {
            watcher.close();
        }
        for (const disposable of this.gitRepositoryStateDisposables.values()) {
            disposable.dispose();
        }
        this.gitRepositoryStateDisposables.clear();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}

function normalizedPath(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
