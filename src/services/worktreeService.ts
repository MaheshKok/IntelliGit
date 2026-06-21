import * as vscode from "vscode";
import type { GitExecutor } from "../git/executor";
import { listWorktrees as readWorktrees } from "../git/worktrees";
import type { GitWorktree } from "../types";

/** Read-only worktree cache for the active repository root. */
export class WorktreeService implements vscode.Disposable {
    private readonly _onDidChangeWorktrees = new vscode.EventEmitter<GitWorktree[]>();
    readonly onDidChangeWorktrees = this._onDidChangeWorktrees.event;
    private cache: GitWorktree[] | undefined;

    /** Bind worktree reads to the shared executor and active root lookup. */
    constructor(
        private readonly executor: GitExecutor,
        private readonly getCurrentRoot: () => string,
    ) {}

    /** Return cached worktrees, loading them from Git on first use. */
    async listWorktrees(): Promise<GitWorktree[]> {
        this.cache ??= await readWorktrees(this.executor, this.getCurrentRoot());
        return this.cache;
    }

    /** Reload worktrees from Git and notify native views. */
    async refresh(): Promise<GitWorktree[]> {
        this.cache = await readWorktrees(this.executor, this.getCurrentRoot());
        this._onDidChangeWorktrees.fire(this.cache);
        return this.cache;
    }

    /** Release the change emitter owned by this cache. */
    dispose(): void {
        this._onDidChangeWorktrees.dispose();
    }
}
