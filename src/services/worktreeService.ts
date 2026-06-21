import * as fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import {
    addWorktree,
    assertWorktreePathSafe,
    listWorktrees as readWorktrees,
    lockWorktree as lockGitWorktree,
    moveWorktree as moveGitWorktree,
    pruneWorktrees as pruneGitWorktrees,
    repairWorktrees as repairGitWorktrees,
    removeWorktree as removeGitWorktree,
    unlockWorktree as unlockGitWorktree,
} from "../git/worktrees";
import type { Branch, GitWorktree } from "../types";
import { getLocalNameFromRemote } from "./gitHelpers";
import { assertValidBranchName } from "../utils/gitRefs";

/** User-confirmed worktree creation request after UI prompting. */
export interface CreateWorktreeOptions {
    path: string;
    branch?: Branch;
    newBranch?: string;
    base?: string;
    detach?: boolean;
}

interface IncludedWorktreeFile {
    source: string;
    target: string;
}

/** Read-only worktree cache for the active repository root. */
export class WorktreeService implements vscode.Disposable {
    private readonly _onDidChangeWorktrees = new vscode.EventEmitter<GitWorktree[]>();
    readonly onDidChangeWorktrees = this._onDidChangeWorktrees.event;
    private cache: GitWorktree[] | undefined;

    /** Bind worktree reads to the shared executor and active root lookup. */
    constructor(
        private readonly executor: GitExecutor,
        private readonly getCurrentRoot: () => string,
        private readonly createExecutor: (repoRoot: string) => GitExecutor = (repoRoot) =>
            new GitExecutor(repoRoot),
    ) {}

    /** Return cached worktrees, loading them from Git on first use. */
    async listWorktrees(): Promise<GitWorktree[]> {
        this.cache ??= await readWorktrees(this.executor, this.getCurrentRoot());
        return this.cache;
    }

    /** Reload worktrees from Git and notify native views. */
    async refresh(): Promise<GitWorktree[]> {
        this.cache = undefined;
        this.cache = await readWorktrees(this.executor, this.getCurrentRoot());
        this._onDidChangeWorktrees.fire(this.cache);
        return this.cache;
    }

    /**
     * Returns fresh branch objects annotated from the current worktree cache.
     *
     * Callers refresh or list worktrees before decoration when they need live Git
     * state; this method stays synchronous so one decorated branch snapshot can be
     * shared consistently across host state and every webview provider.
     */
    decorateBranches(branches: Branch[]): Branch[] {
        const worktreesByBranch = new Map(
            (this.cache ?? [])
                .filter((worktree) => worktree.branch !== null)
                .map((worktree) => [worktree.branch as string, worktree]),
        );

        return branches.map((branch) => {
            const worktree = branch.isRemote ? undefined : worktreesByBranch.get(branch.name);
            return {
                ...branch,
                isCheckedOutInWorktree: worktree !== undefined,
                worktreePath: worktree?.path,
                isCurrentWorktree: worktree?.isCurrent ?? false,
            };
        });
    }

    /** Create a worktree after validating path and branch inputs. */
    async createWorktree(opts: CreateWorktreeOptions): Promise<GitWorktree[]> {
        const existing = await this.listWorktrees();
        const repoRoot = this.getCurrentRoot();
        assertWorktreePathSafe(opts.path, repoRoot, existing);
        if (opts.newBranch) assertValidBranchName(opts.newBranch, "new branch name");
        const includeFiles = getIncludedWorktreeFiles(repoRoot, opts.path);

        if (opts.detach) {
            await addWorktree(this.executor, {
                path: opts.path,
                base: opts.base ?? opts.branch?.hash ?? opts.branch?.name ?? "HEAD",
                detach: true,
            });
            await copyIncludedWorktreeFiles(includeFiles);
            return this.refresh();
        }

        if (opts.branch?.isRemote) {
            assertValidBranchName(opts.branch.name, "remote branch name");
            const localName = opts.newBranch ?? getLocalNameFromRemote(opts.branch.name);
            assertValidBranchName(localName, "local branch name");
            await addWorktree(this.executor, {
                path: opts.path,
                newBranch: localName,
                base: opts.branch.name,
            });
            await this.executor.run(["branch", `--set-upstream-to=${opts.branch.name}`, localName]);
            await copyIncludedWorktreeFiles(includeFiles);
            return this.refresh();
        }

        if (opts.branch) assertValidBranchName(opts.branch.name);
        await addWorktree(this.executor, {
            path: opts.path,
            branch: opts.branch?.name,
            newBranch: opts.newBranch,
            base: opts.base,
        });
        await copyIncludedWorktreeFiles(includeFiles);
        return this.refresh();
    }

    /** Remove a non-current, non-main worktree after dirty-state confirmation. */
    async removeWorktree(worktreePath: string): Promise<GitWorktree[] | undefined> {
        const worktrees = await this.listWorktrees();
        const target = path.resolve(worktreePath);
        const worktree = worktrees.find((candidate) => path.resolve(candidate.path) === target);
        if (!worktree) throw new Error(vscode.l10n.t("Worktree not found."));
        if (worktree.isMain) throw new Error(vscode.l10n.t("Cannot remove the main worktree."));
        if (worktree.isCurrent)
            throw new Error(vscode.l10n.t("Cannot remove the current worktree."));

        const dirtyOutput = await this.createExecutor(worktree.path).run(["status", "--porcelain"]);
        const force = dirtyOutput.trim().length > 0;
        if (force) {
            const confirm = vscode.l10n.t("Delete Worktree");
            const picked = await vscode.window.showWarningMessage(
                vscode.l10n.t("Worktree has uncommitted changes. Delete it anyway?"),
                { modal: true },
                confirm,
            );
            if (picked !== confirm) return undefined;
        }

        await removeGitWorktree(this.executor, worktree.path, force);
        return this.refresh();
    }

    /** Lock a worktree and refresh cached worktree state. */
    async lockWorktree(worktreePath: string, reason?: string): Promise<GitWorktree[]> {
        await lockGitWorktree(this.executor, worktreePath, reason);
        return this.refresh();
    }

    /** Unlock a worktree and refresh cached worktree state. */
    async unlockWorktree(worktreePath: string): Promise<GitWorktree[]> {
        await unlockGitWorktree(this.executor, worktreePath);
        return this.refresh();
    }

    /** Move a worktree after validating the destination path against known worktrees. */
    async moveWorktree(worktreePath: string, newPath: string): Promise<GitWorktree[]> {
        const existing = await this.listWorktrees();
        assertWorktreePathSafe(newPath, this.getCurrentRoot(), existing);
        await moveGitWorktree(this.executor, worktreePath, newPath);
        return this.refresh();
    }

    /** Prune stale worktree records and refresh cached worktree state. */
    async pruneWorktrees(): Promise<GitWorktree[]> {
        await pruneGitWorktrees(this.executor);
        return this.refresh();
    }

    /** Repair worktree records and refresh cached worktree state. */
    async repairWorktrees(): Promise<GitWorktree[]> {
        await repairGitWorktrees(this.executor);
        return this.refresh();
    }

    /** Release the change emitter owned by this cache. */
    dispose(): void {
        this._onDidChangeWorktrees.dispose();
    }
}

function getIncludedWorktreeFiles(repoRoot: string, worktreeRoot: string): IncludedWorktreeFile[] {
    const entries = vscode.workspace
        .getConfiguration("intelligit")
        .get<string[]>("worktree.includeFiles", []);
    return entries.map((entry) => resolveIncludedWorktreeFile(entry, repoRoot, worktreeRoot));
}

function resolveIncludedWorktreeFile(
    entry: string,
    repoRoot: string,
    worktreeRoot: string,
): IncludedWorktreeFile {
    if (!entry || path.isAbsolute(entry) || entry.includes("\0")) {
        throw new Error(`Invalid worktree include file path: ${entry}`);
    }
    const relativePath = path.normalize(entry);
    if (relativePath === "." || relativePath.split(path.sep).some((segment) => segment === "..")) {
        throw new Error(`Invalid worktree include file path: ${entry}`);
    }

    const sourceRoot = path.resolve(repoRoot);
    const targetRoot = path.resolve(worktreeRoot);
    const source = path.resolve(sourceRoot, relativePath);
    const target = path.resolve(targetRoot, relativePath);
    if (!isSameOrChildPath(source, sourceRoot) || !isSameOrChildPath(target, targetRoot)) {
        throw new Error(`Invalid worktree include file path: ${entry}`);
    }
    return { source, target };
}

async function copyIncludedWorktreeFiles(files: IncludedWorktreeFile[]): Promise<void> {
    for (const file of files) {
        try {
            await fs.mkdir(path.dirname(file.target), { recursive: true });
            await fs.cp(file.source, file.target, { recursive: true, force: true });
        } catch (err) {
            if (isMissingPathError(err)) continue;
            throw err;
        }
    }
}

function isSameOrChildPath(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingPathError(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: unknown }).code === "ENOENT"
    );
}
