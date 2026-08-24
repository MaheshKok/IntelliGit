import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { resolveGitDir } from "../git/gitDirectory";
import { logGitOpsWarning } from "../git/operationSupport";

/** Sources whose existing watcher pathways can invalidate a repository diff snapshot. */
export type RepositoryWorkingTreeChangeSource =
    | "workspace-file"
    | "git-index"
    | "git-state"
    | "git-refs"
    | "git-repository-state";

/** Root-keyed change notification supplied to repository-scoped consumers. */
export interface RepositoryWorkingTreeChange {
    /** Normalized repository root observed by the watcher. */
    readonly repoRoot: string;
    /** Repository-relative path when a workspace watcher identifies one. */
    readonly path?: string;
    /** Existing watcher route that observed the change. */
    readonly source: RepositoryWorkingTreeChangeSource;
}
/** A subscription that can synchronously move to another repository root. */
export interface RepositoryWorkingTreeChangeSubscription extends vscode.Disposable {
    /** Replaces the listener/root pair without yielding to another watcher callback. */
    rebind(repoRoot: string, listener: (event: RepositoryWorkingTreeChange) => void): void;
}

const ignoredWorkspaceEventDirs = new Set([".git", "dist", "build", "out"]);
const rootWatchers = new Map<string, RootWorkingTreeWatcher>();

/**
 * Subscribes a consumer to one root's existing text, workspace, and Git-state watcher routes.
 *
 * The underlying watcher is reference-counted by subscriptions, so collapsing a repository row
 * cannot stop updates for an open diff panel on the same root.
 */
export function subscribeToRepositoryWorkingTreeChanges(
    repoRoot: string,
    listener: (event: RepositoryWorkingTreeChange) => void,
): RepositoryWorkingTreeChangeSubscription {
    const subscription = new RootWorkingTreeChangeSubscription();
    subscription.rebind(repoRoot, listener);
    return subscription;
}

/** Publishes a Git-extension state change into the root watcher that is already armed. */
export function publishRepositoryWorkingTreeChange(event: RepositoryWorkingTreeChange): void {
    rootWatchers.get(normalizeRoot(event.repoRoot))?.fire({
        ...event,
        repoRoot: normalizeRoot(event.repoRoot),
    });
}

/** Retains one reusable root watcher and fans its typed changes out to subscribers. */
class RootWorkingTreeWatcher implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<RepositoryWorkingTreeChange>();
    private readonly disposables: vscode.Disposable[] = [];
    private readonly fsWatchers: fs.FSWatcher[] = [];
    private references = 0;

    constructor(readonly repoRoot: string) {
        this.registerWorkspaceWatchers();
        this.registerGitWatchers();
    }

    /** Adds a consumer and returns its event listener disposable. */
    subscribe(listener: (event: RepositoryWorkingTreeChange) => void): vscode.Disposable {
        this.references += 1;
        return this.emitter.event(listener);
    }

    /** Releases one consumer and tears down the root watchers after the final release. */
    release(): void {
        this.references -= 1;
        if (this.references > 0) return;
        this.dispose();
        rootWatchers.delete(this.repoRoot);
    }

    /** Emits a typed root event without coupling consumers to a provider-local mutation event. */
    fire(event: RepositoryWorkingTreeChange): void {
        this.emitter.fire(event);
    }

    /** Disposes every root-scoped filesystem and document watcher. */
    dispose(): void {
        for (const watcher of this.fsWatchers) watcher.close();
        for (const disposable of this.disposables) disposable.dispose();
        this.fsWatchers.length = 0;
        this.disposables.length = 0;
        this.emitter.dispose();
    }

    /** Registers the workspace text and filesystem pathways that also see third-party edits. */
    private registerWorkspaceWatchers(): void {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) =>
                this.fireWorkspaceUri(event.document.uri),
            ),
            vscode.workspace.onDidSaveTextDocument((document) =>
                this.fireWorkspaceUri(document.uri),
            ),
            vscode.workspace.onDidCreateFiles((event) => {
                for (const uri of event.files) this.fireWorkspaceUri(uri);
            }),
            vscode.workspace.onDidDeleteFiles((event) => {
                for (const uri of event.files) this.fireWorkspaceUri(uri);
            }),
            vscode.workspace.onDidRenameFiles((event) => {
                for (const file of event.files) {
                    this.fireWorkspaceUri(file.oldUri);
                    this.fireWorkspaceUri(file.newUri);
                }
            }),
        );

        try {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(this.repoRoot), "**/*"),
            );
            const fire = (uri: vscode.Uri) => this.fireWorkspaceUri(uri);
            this.disposables.push(
                watcher.onDidChange(fire),
                watcher.onDidCreate(fire),
                watcher.onDidDelete(fire),
                watcher,
            );
        } catch {
            /* Repository file watcher may be unavailable for virtual roots. */
        }
    }

    /**
     * Retains one `fs.watch` handle so a failure after arming degrades to "not watching".
     *
     * The `try`/`catch` at each call site covers only the synchronous construction. A watch
     * that succeeds and fails later -- the git dir replaced by a checkout, an inotify limit
     * reached, EPERM on Windows -- reports that as an `error` event on the returned handle,
     * and `FSWatcher` is an `EventEmitter`, so an `error` with no listener is rethrown by
     * Node as an uncaught exception. That does not cost this one optional watcher: it
     * terminates the extension host and every other extension running in it. Every other
     * path in this file already treats an unwatchable root as acceptable degradation, so
     * the handler closes the handle and matches that.
     */
    private retainFsWatcher(watcher: fs.FSWatcher): void {
        watcher.on("error", (error) => {
            logGitOpsWarning("repositoryChangeEvents.fsWatch", error);
            try {
                watcher.close();
            } catch {
                /* The failure that raised this may already have closed the handle. */
            }
        });
        this.fsWatchers.push(watcher);
    }

    /** Registers the existing Git metadata paths that can move symbolic refs. */
    private registerGitWatchers(): void {
        const gitDir = resolveGitDir(this.repoRoot);
        const gitStateFiles = new Set([
            "HEAD",
            "FETCH_HEAD",
            "packed-refs",
            "MERGE_HEAD",
            "REBASE_HEAD",
            "index",
        ]);

        try {
            this.retainFsWatcher(
                fs.watch(gitDir, (_event, filename) => {
                    const name = filename?.toString();
                    if (!name) {
                        this.fire({ repoRoot: this.repoRoot, source: "git-state" });
                    } else if (gitStateFiles.has(name)) {
                        this.fire({
                            repoRoot: this.repoRoot,
                            source: name === "index" ? "git-index" : "git-state",
                        });
                    }
                }),
            );
        } catch {
            /* .git may not be watchable for virtual roots or isolated test fixtures. */
        }

        try {
            const refsPath = path.join(gitDir, "refs");
            if (process.platform === "linux") {
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(refsPath), "**/*"),
                );
                const fire = () => this.fire({ repoRoot: this.repoRoot, source: "git-refs" });
                this.disposables.push(
                    watcher.onDidChange(fire),
                    watcher.onDidCreate(fire),
                    watcher.onDidDelete(fire),
                    watcher,
                );
            } else {
                this.retainFsWatcher(
                    fs.watch(refsPath, { recursive: true }, () => {
                        this.fire({ repoRoot: this.repoRoot, source: "git-refs" });
                    }),
                );
            }
        } catch {
            /* The refs directory may not exist yet or the platform may not support this watcher. */
        }
    }

    /** Filters workspace events to this root and retains the path for focused diff subscribers. */
    private fireWorkspaceUri(uri: vscode.Uri): void {
        const changedPath = relativeWorkspacePath(this.repoRoot, uri.fsPath);
        if (changedPath === undefined) return;
        this.fire({
            repoRoot: this.repoRoot,
            path: changedPath,
            source: "workspace-file",
        });
    }
}

/** Stores exactly one listener/root pair and swaps it synchronously on rebinding. */
class RootWorkingTreeChangeSubscription implements RepositoryWorkingTreeChangeSubscription {
    private disposed = false;
    private watcher: RootWorkingTreeWatcher | undefined;
    private listenerDisposable: vscode.Disposable | undefined;

    /** Moves this subscription in one synchronous operation so there is no asynchronous gap. */
    rebind(repoRoot: string, listener: (event: RepositoryWorkingTreeChange) => void): void {
        if (this.disposed) return;
        const nextWatcher = getOrCreateRootWatcher(normalizeRoot(repoRoot));
        const nextListener = nextWatcher.subscribe(listener);
        const previousListener = this.listenerDisposable;
        const previousWatcher = this.watcher;
        this.watcher = nextWatcher;
        this.listenerDisposable = nextListener;
        previousListener?.dispose();
        previousWatcher?.release();
    }

    /** Releases the held root watcher reference exactly once. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.listenerDisposable?.dispose();
        this.listenerDisposable = undefined;
        this.watcher?.release();
        this.watcher = undefined;
    }
}

/** Returns the shared watcher for a normalized root, creating it only for its first consumer. */
function getOrCreateRootWatcher(repoRoot: string): RootWorkingTreeWatcher {
    const existing = rootWatchers.get(repoRoot);
    if (existing) return existing;
    const watcher = new RootWorkingTreeWatcher(repoRoot);
    rootWatchers.set(repoRoot, watcher);
    return watcher;
}

/** Resolves root identity consistently across workspace, Git, and panel callers. */
function normalizeRoot(repoRoot: string): string {
    const normalized = path.resolve(repoRoot);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Returns a slash-separated repository-relative path for a workspace URI when it is relevant. */
function relativeWorkspacePath(repoRoot: string, fsPath: string): string | undefined {
    const relative = path.relative(repoRoot, fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    const [topLevelDir] = relative.split(path.sep);
    if (topLevelDir && ignoredWorkspaceEventDirs.has(topLevelDir)) return undefined;
    return relative.split(path.sep).join("/");
}
