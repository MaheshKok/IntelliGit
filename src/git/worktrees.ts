import path from "node:path";
import type { GitWorktree, WorktreeState } from "../types";
import type { GitExecutor } from "./executor";

interface WorktreeRecord {
    path?: string;
    head?: string;
    branch?: string;
    bare?: boolean;
    detached?: boolean;
    locked?: string;
    prunable?: string;
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

function getWorktreeState(record: WorktreeRecord, isMain: boolean): WorktreeState {
    if (record.bare) return "bare";
    if (record.detached) return "detached";
    return isMain ? "main" : "linked";
}

function stripHeadsPrefix(refname: string): string {
    const prefix = "refs/heads/";
    return refname.startsWith(prefix) ? refname.slice(prefix.length) : refname;
}

function normalizePath(rawPath: string): string {
    return path.resolve(rawPath);
}
