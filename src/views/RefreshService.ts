// Auto-refresh service extracted from extension.ts.
// Manages debounced light (commit panel only) and full
// (branches + graph + panel + conflicts) refresh cycles,
// plus file system watchers on the .git directory.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch, GitWorktree } from "../types";
import { CommitGraphViewProvider } from "./CommitGraphViewProvider";
import { CommitPanelViewProvider } from "./CommitPanelViewProvider";
import { MergeConflictsTreeProvider } from "./MergeConflictsTreeProvider";
import type { UndockedViewProvider } from "./UndockedViewProvider";
import type { WorktreeService } from "../services/worktreeService";

/**
 * View and Git dependencies coordinated by refresh events for one active repository.
 *
 * The service assumes all providers in this bundle already point at the same repository root;
 * callers must replace or recreate the service when the active repository changes so cached view
 * state and file watchers do not cross repository boundaries.
 */
export interface RefreshServiceDeps {
    gitOps: GitOps;
    commitGraph: CommitGraphViewProvider;
    additionalCommitGraphs?: CommitGraphViewProvider[];
    commitPanel: CommitPanelViewProvider;
    mergeConflicts: MergeConflictsTreeProvider;
    mergeConflictsView: vscode.TreeView<unknown>;
    worktrees?: WorktreeService;
    onBranchesUpdated: (branches: Branch[]) => void;
    onWorktreesUpdated?: (worktrees: GitWorktree[]) => void;
    getUndocked?: () => UndockedViewProvider | undefined;
}

/** Minimal VS Code Git extension API surface consumed by refresh wiring. */
interface VsCodeGitExtension {
    getAPI(version: 1): VsCodeGitApi;
}

/** Repository events exposed by VS Code's built-in Git extension. */
interface VsCodeGitApi {
    repositories: VsCodeGitRepository[];
    onDidOpenRepository?: (
        listener: (repository: VsCodeGitRepository) => unknown,
    ) => vscode.Disposable;
    onDidCloseRepository?: (
        listener: (repository: VsCodeGitRepository) => unknown,
    ) => vscode.Disposable;
}

/** VS Code Git repository handle used for root matching and state-change events. */
interface VsCodeGitRepository {
    rootUri: vscode.Uri;
    onDidChangeState?: (listener: () => unknown) => vscode.Disposable;
}

/** Debounced refresh source labels used to keep diagnostics and tests deterministic. */
type RefreshEventType =
    | "workspace-file"
    | "git-index"
    | "git-state"
    | "git-refs"
    | "git-repository-state";

/**
 * Coordinates debounced UI refreshes and repository watchers for one active Git root.
 *
 * The service owns timers, `.git` filesystem watchers, VS Code Git API listeners, and conflict
 * badge/context updates. It assumes all injected providers already target the same repository;
 * dispose and recreate it when the active root changes so cached refresh events cannot cross roots.
 */
export class RefreshService implements vscode.Disposable {
    private static readonly lightRefreshSuppressionAfterFullMs = 800;
    private static readonly pollingRefreshIntervalMs = 5000;

    private lightTimer: ReturnType<typeof setTimeout> | undefined;
    private fullTimer: ReturnType<typeof setTimeout> | undefined;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private readonly fsWatchers: fs.FSWatcher[] = [];
    private readonly gitRepositoryStateDisposables = new Map<string, vscode.Disposable>();
    private readonly disposables: vscode.Disposable[] = [];
    private suppressedLightTimer: ReturnType<typeof setTimeout> | undefined;
    private pollingRefreshInFlight = false;
    private recentFullScheduledUntil = 0;
    private disposed = false;

    /** Create a refresh coordinator for one active repository root. */
    constructor(
        private readonly deps: RefreshServiceDeps,
        private readonly repoRoot: string,
    ) {}

    /** Refresh the merge-conflict tree and expose the conflict badge/context state. */
    async refreshMergeConflicts(): Promise<void> {
        const count = await this.deps.mergeConflicts.refresh();
        this.deps.mergeConflictsView.description = count > 0 ? `${count}` : "";
        await vscode.commands.executeCommand(
            "setContext",
            "intelligit.hasMergeConflicts",
            count > 0,
        );
    }

    /** Refresh commit panel views without reloading branch or graph state. */
    async refreshCommitPanels(): Promise<void> {
        const undocked = this.deps.getUndocked?.();
        await Promise.all([
            this.deps.commitPanel.refreshSilent(),
            ...(undocked ? [undocked.refreshSilent()] : []),
        ]);
    }

    /** Refresh commit panels and merge-conflict UI after conflict-affecting commands. */
    async refreshConflictUi(): Promise<void> {
        await this.refreshCommitPanels();
        await this.refreshMergeConflicts();
    }

    /** Delegate to the extension-wide refresh command. */
    async refreshAll(): Promise<void> {
        await vscode.commands.executeCommand("intelligit.refresh");
    }

    /** Schedule a lightweight refresh that updates commit panel state only. */
    debouncedLightRefresh(): void {
        if (this.lightTimer) clearTimeout(this.lightTimer);
        this.lightTimer = setTimeout(() => {
            void this.refreshCommitPanels().catch((err) => {
                console.error("[IntelliGit] Light refresh failed:", err);
            });
        }, 300);
    }

    /** Schedule a full refresh and suppress redundant light refreshes from nearby Git events. */
    debouncedFullRefresh(): void {
        this.recentFullScheduledUntil =
            Date.now() + RefreshService.lightRefreshSuppressionAfterFullMs;
        if (this.lightTimer) {
            clearTimeout(this.lightTimer);
            this.lightTimer = undefined;
        }
        if (this.suppressedLightTimer) {
            clearTimeout(this.suppressedLightTimer);
            this.suppressedLightTimer = undefined;
        }
        if (this.fullTimer) clearTimeout(this.fullTimer);
        this.fullTimer = setTimeout(() => {
            void (async () => {
                const rawBranches = await this.deps.gitOps.getBranches();
                let worktrees: GitWorktree[] = [];
                try {
                    worktrees = (await this.deps.worktrees?.refresh()) ?? [];
                } catch (err) {
                    console.error("[IntelliGit] Worktrees refresh failed:", err);
                }
                const branches = this.deps.worktrees?.decorateBranches(rawBranches) ?? rawBranches;
                const commitGraphs = [
                    this.deps.commitGraph,
                    ...(this.deps.additionalCommitGraphs ?? []),
                ];
                this.deps.onBranchesUpdated(branches);
                this.deps.onWorktreesUpdated?.(worktrees);
                for (const graph of commitGraphs) {
                    graph.setBranches(branches, worktrees);
                }
                this.deps.commitPanel.setBranches(branches);
                const undocked = this.deps.getUndocked?.();
                undocked?.setBranches(branches, worktrees);
                await Promise.all([
                    ...commitGraphs.map((graph) => graph.refresh()),
                    this.refreshCommitPanels(),
                    this.refreshMergeConflicts(),
                ]);
            })().catch((err) => {
                console.error("[IntelliGit] Full refresh failed:", err);
            });
        }, 500);
    }

    /** Register workspace, Git-directory, and VS Code Git API refresh listeners. */
    registerFileWatchers(): void {
        /** Coalesces noisy workspace file events into the shared refresh debounce. */
        const handler = () => this.scheduleRefreshEvent("workspace-file");

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(handler),
            vscode.workspace.onDidSaveTextDocument(handler),
            vscode.workspace.onDidCreateFiles(handler),
            vscode.workspace.onDidDeleteFiles(handler),
            vscode.workspace.onDidRenameFiles(handler),
        );

        try {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(this.repoRoot), "**/*"),
            );
            const repoFileHandler = (uri: vscode.Uri) => {
                const relativePath = path.relative(this.repoRoot, uri.fsPath);
                if (relativePath === ".git" || relativePath.startsWith(`.git${path.sep}`)) {
                    return;
                }
                this.scheduleRefreshEvent("workspace-file");
            };
            this.disposables.push(
                watcher.onDidChange(repoFileHandler),
                watcher.onDidCreate(repoFileHandler),
                watcher.onDidDelete(repoFileHandler),
                watcher,
            );
        } catch {
            /* Repository file watcher may be unavailable for virtual roots. */
        }

        this.registerGitDirWatchers();
        this.registerVsCodeGitWatchers();
        this.registerPollingRefresh();
    }

    /** Polls as a fallback for file changes that VS Code or Git watchers miss. */
    private registerPollingRefresh(): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => {
            if (this.disposed || this.pollingRefreshInFlight) return;
            this.pollingRefreshInFlight = true;
            void this.refreshCommitPanels()
                .catch((err) => {
                    console.error("[IntelliGit] Polling refresh failed:", err);
                })
                .finally(() => {
                    this.pollingRefreshInFlight = false;
                });
        }, RefreshService.pollingRefreshIntervalMs);
    }

    /** Resolve the real Git metadata directory, including worktree-style .git files. */
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

    /** Watch Git metadata files whose changes imply light or full UI refreshes. */
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
                    this.scheduleRefreshEvent("git-state");
                    return;
                }
                if (gitStateFiles.has(filename)) {
                    if (filename === "index") {
                        this.scheduleRefreshEvent("git-index");
                    } else {
                        this.scheduleRefreshEvent("git-state");
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
                /** Coalesces Linux Git ref watcher events into the shared refresh debounce. */
                const handler = () => this.scheduleRefreshEvent("git-refs");
                this.disposables.push(
                    watcher.onDidChange(handler),
                    watcher.onDidCreate(handler),
                    watcher.onDidDelete(handler),
                    watcher,
                );
            } else {
                const refsWatcher = fs.watch(refsPath, { recursive: true }, () =>
                    this.scheduleRefreshEvent("git-refs"),
                );
                this.fsWatchers.push(refsWatcher);
            }
        } catch {
            /* refs dir may not exist yet or may not be watchable */
        }
    }

    /** Start asynchronous registration for VS Code's Git repository state events. */
    private registerVsCodeGitWatchers(): void {
        void this.registerVsCodeGitWatchersAsync().catch((err) => {
            console.error("[IntelliGit] Failed to register VS Code Git refresh listener:", err);
        });
    }

    /** Register already-open repositories and future repository open/close events. */
    private async registerVsCodeGitWatchersAsync(): Promise<void> {
        const gitExtension = vscode.extensions?.getExtension<VsCodeGitExtension>("vscode.git");
        if (!gitExtension) return;

        const git = await gitExtension.activate();
        if (!this.disposed) {
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
    }

    /** Register a VS Code Git state listener for the active repository only. */
    private registerGitRepositoryStateWatcher(repository: VsCodeGitRepository): void {
        if (this.disposed || !this.isActiveRepository(repository) || !repository.onDidChangeState) {
            return;
        }

        const rootKey = normalizedPath(repository.rootUri.fsPath);
        if (this.gitRepositoryStateDisposables.has(rootKey)) return;

        this.gitRepositoryStateDisposables.set(
            rootKey,
            repository.onDidChangeState(() => this.scheduleRefreshEvent("git-repository-state")),
        );
    }

    /** Dispose the VS Code Git state listener for a repository that closed. */
    private disposeGitRepositoryStateWatcher(repository: VsCodeGitRepository): void {
        const rootKey = normalizedPath(repository.rootUri.fsPath);
        const disposable = this.gitRepositoryStateDisposables.get(rootKey);
        if (!disposable) return;
        disposable.dispose();
        this.gitRepositoryStateDisposables.delete(rootKey);
    }

    /** Check whether a VS Code Git repository matches this service's repository root. */
    private isActiveRepository(repository: VsCodeGitRepository): boolean {
        return normalizedPath(repository.rootUri.fsPath) === normalizedPath(this.repoRoot);
    }

    /** Route refresh events through one light/full coalescing policy. */
    private scheduleRefreshEvent(eventType: RefreshEventType): void {
        switch (eventType) {
            case "git-state":
            case "git-refs":
                this.debouncedFullRefresh();
                return;
            case "workspace-file":
                this.debouncedLightRefresh();
                return;
            case "git-index":
            case "git-repository-state":
                if (Date.now() < this.recentFullScheduledUntil) {
                    if (this.suppressedLightTimer) clearTimeout(this.suppressedLightTimer);
                    this.suppressedLightTimer = setTimeout(() => {
                        this.suppressedLightTimer = undefined;
                        this.debouncedLightRefresh();
                    }, this.recentFullScheduledUntil - Date.now());
                    return;
                }
                this.debouncedLightRefresh();
                return;
        }
    }

    /** Dispose timers, file watchers, and VS Code Git listeners owned by this service. */
    dispose(): void {
        this.disposed = true;
        if (this.lightTimer) clearTimeout(this.lightTimer);
        if (this.fullTimer) clearTimeout(this.fullTimer);
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.suppressedLightTimer) clearTimeout(this.suppressedLightTimer);
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

/**
 * Normalizes paths for repository identity comparisons across platforms.
 *
 * VS Code Git API repository roots and the extension's selected root can differ in spelling or
 * case on Windows, so refresh listener registration compares resolved normalized identities.
 */
function normalizedPath(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
