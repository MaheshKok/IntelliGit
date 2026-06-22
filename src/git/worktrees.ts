import * as fs from "node:fs";
import path from "node:path";
import type { GitWorktree, WorktreeState } from "../types";
import type { GitExecutor } from "./executor";

/** Intermediate shape for one raw `git worktree list --porcelain -z` record. */
interface WorktreeRecord {
    path?: string;
    head?: string;
    branch?: string;
    bare?: boolean;
    detached?: boolean;
    locked?: string;
    prunable?: string;
}

/** Options mapped directly to `git worktree add` argv variants. */
export interface AddWorktreeOptions {
    path: string;
    branch?: string;
    newBranch?: string;
    base?: string;
    detach?: boolean;
}

/** Parses the NUL-delimited porcelain output from `git worktree list --porcelain -z`. */
export function parseWorktreeList(porcelainZ: string, currentRoot: string): GitWorktree[] {
    const records = groupWorktreeRecords(porcelainZ);
    const normalizedCurrentRoot = normalizePath(currentRoot);
    return records
        .map((record, index) => toGitWorktree(record, index, normalizedCurrentRoot))
        .filter((worktree): worktree is GitWorktree => worktree !== null);
}

/** Lists Git worktrees for the executor's current repository root. */
export async function listWorktrees(
    executor: GitExecutor,
    currentRoot: string,
): Promise<GitWorktree[]> {
    const stdout = await executor.run(["worktree", "list", "--porcelain", "-z"]);
    return parseWorktreeList(stdout, currentRoot);
}

/** Rejects unsafe target paths before `git worktree add` can write to disk. */
export function assertWorktreePathSafe(
    targetPath: string,
    repoRoot: string,
    existing: GitWorktree[],
): void {
    const target = normalizePath(targetPath);
    const targetCandidates = pathCandidates(target);
    const repoCandidates = pathCandidates(repoRoot);
    if (hasNestedPath(targetCandidates, repoCandidates)) {
        throw new Error("Worktree path must not be inside the current repository.");
    }

    for (const worktree of existing) {
        if (hasNestedPath(targetCandidates, pathCandidates(worktree.path))) {
            throw new Error("Worktree path must not be inside an existing worktree.");
        }
    }

    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (!stat.isDirectory())
        throw new Error("Worktree path already exists and is not a directory.");
    if (fs.readdirSync(target).length > 0) {
        throw new Error("Worktree path already exists and is not empty.");
    }
}

/** Adds a Git worktree using argv-only Git execution. */
export async function addWorktree(executor: GitExecutor, opts: AddWorktreeOptions): Promise<void> {
    const args = ["worktree", "add"];
    if (opts.detach) {
        args.push("--detach", opts.path, opts.base ?? opts.branch ?? "HEAD");
    } else if (opts.newBranch) {
        args.push("-b", opts.newBranch, opts.path, opts.base ?? opts.branch ?? "HEAD");
    } else {
        args.push(opts.path, opts.branch ?? opts.base ?? "HEAD");
    }
    await executor.run(args);
}

/** Removes a Git worktree without deleting its branch. */
export async function removeWorktree(
    executor: GitExecutor,
    worktreePath: string,
    force: boolean,
): Promise<void> {
    await executor.run(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
}

/** Locks a worktree, optionally recording Git's lock reason. */
export async function lockWorktree(
    executor: GitExecutor,
    worktreePath: string,
    reason?: string,
): Promise<void> {
    await executor.run(["worktree", "lock", ...(reason ? ["--reason", reason] : []), worktreePath]);
}

/** Unlocks a previously locked worktree. */
export async function unlockWorktree(executor: GitExecutor, worktreePath: string): Promise<void> {
    await executor.run(["worktree", "unlock", worktreePath]);
}

/** Moves a worktree to a prevalidated destination path. */
export async function moveWorktree(
    executor: GitExecutor,
    worktreePath: string,
    newPath: string,
): Promise<void> {
    await executor.run(["worktree", "move", worktreePath, newPath]);
}

/** Prunes stale worktree administrative records. */
export async function pruneWorktrees(executor: GitExecutor): Promise<void> {
    await executor.run(["worktree", "prune"]);
}

/** Repairs worktree administrative metadata. */
export async function repairWorktrees(executor: GitExecutor): Promise<void> {
    await executor.run(["worktree", "repair"]);
}

/** Groups Git's NUL-delimited porcelain stream into records, with empty tokens ending a record. */
function groupWorktreeRecords(porcelainZ: string): WorktreeRecord[] {
    const records: WorktreeRecord[] = [];
    let current: WorktreeRecord = {};
    for (const token of porcelainZ.split("\0")) {
        if (token === "") {
            if (current.path) records.push(current);
            current = {};
            continue;
        }
        applyToken(current, token);
    }
    if (current.path) records.push(current);
    return records;
}

/** Applies one porcelain token to the current record and ignores unknown future Git fields. */
function applyToken(record: WorktreeRecord, token: string): void {
    const separator = token.indexOf(" ");
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? "" : token.slice(separator + 1);
    switch (key) {
        case "worktree":
            record.path = normalizePath(value);
            break;
        case "HEAD":
            record.head = value;
            break;
        case "branch":
            record.branch = stripHeadsPrefix(value);
            break;
        case "bare":
            record.bare = true;
            break;
        case "detached":
            record.detached = true;
            break;
        case "locked":
            record.locked = value;
            break;
        case "prunable":
            record.prunable = value;
            break;
    }
}

/** Converts a parsed record into the extension model, preserving Git's first-record main-worktree contract. */
function toGitWorktree(
    record: WorktreeRecord,
    index: number,
    normalizedCurrentRoot: string,
): GitWorktree | null {
    if (!record.path) return null;
    const isMain = index === 0;
    const isLocked = record.locked !== undefined;
    const isPrunable = record.prunable !== undefined;
    const lockedReason = record.locked?.trim() || undefined;
    const prunableReason = record.prunable?.trim() || undefined;
    return {
        path: record.path,
        head: record.head ?? null,
        branch: record.branch ?? null,
        state: getWorktreeState(record, isMain),
        isMain,
        isCurrent: record.path === normalizedCurrentRoot,
        isLocked,
        ...(lockedReason ? { lockedReason } : {}),
        isPrunable,
        ...(prunableReason ? { prunableReason } : {}),
    };
}

/** Derives the stable UI state from porcelain flags, with bare and detached overriding main/linked. */
function getWorktreeState(record: WorktreeRecord, isMain: boolean): WorktreeState {
    if (record.bare) return "bare";
    if (record.detached) return "detached";
    return isMain ? "main" : "linked";
}

/** Converts local branch refs from porcelain output into branch names shown in IntelliGit. */
function stripHeadsPrefix(refname: string): string {
    const prefix = "refs/heads/";
    return refname.startsWith(prefix) ? refname.slice(prefix.length) : refname;
}

/** Resolves paths before equality checks so comparisons do not depend on the process cwd. */
function normalizePath(rawPath: string): string {
    return path.resolve(rawPath);
}

/** Returns normalized and realpath variants so existing symlinked paths share one safety check. */
function pathCandidates(rawPath: string): string[] {
    const normalized = normalizePath(rawPath);
    const candidates = [normalized];
    try {
        candidates.push(fs.realpathSync.native(normalized));
    } catch {
        // Missing targets are compared by normalized absolute path only.
    }
    return Array.from(new Set(candidates));
}

/** Checks same-path and descendant relationships across normalized/realpath candidate sets. */
function hasNestedPath(children: string[], parents: string[]): boolean {
    return children.some((child) =>
        parents.some((parent) => {
            const relative = path.relative(parent, child);
            return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        }),
    );
}
