import type { WorkingFile } from "../types";
import { normalizeGitNumstatPath } from "./numstat";
import { mapStatusCode } from "./parsers";

export interface RollbackPlan {
    resetPaths: string[];
    checkoutPaths: string[];
    cleanupPaths: string[];
}

export function parseWorkingTreeStatus(result: string): WorkingFile[] {
    const files: WorkingFile[] = [];
    const entries = result.split("\0");

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || entry.length < 4) continue;

        const index = entry.charAt(0);
        const worktree = entry.charAt(1);
        const hasStaged = index !== " " && index !== "?";
        const hasUnstaged = worktree !== " ";

        const stagedStatus = mapStatusCode(index);
        const unstagedStatus = mapStatusCode(worktree);
        const path = entry.slice(3);
        if (!path) continue;

        if (isRenameOrCopy(index, worktree) && i + 1 < entries.length) {
            // In porcelain -z output, rename/copy emits an extra NUL-terminated source path.
            i += 1;
        }

        if (hasStaged && hasUnstaged) {
            if (stagedStatus) {
                files.push(createWorkingFile(path, stagedStatus, true));
            }
            // Skip only unstaged "M" for newly added files (index === 'A').
            // A new file edited after staging is still just a new file —
            // the duplicate "M" row is misleading. Other unstaged statuses
            // (e.g. "D" for a staged-add then deleted) must still be shown.
            if (unstagedStatus && !(index === "A" && unstagedStatus === "M")) {
                files.push(createWorkingFile(path, unstagedStatus, false));
            }
        } else if (hasStaged && stagedStatus) {
            files.push(createWorkingFile(path, stagedStatus, true));
        } else if (hasUnstaged && unstagedStatus) {
            files.push(createWorkingFile(path, unstagedStatus, false));
        }
    }

    return files;
}

export function applyNumstatToWorkingFiles(
    files: WorkingFile[],
    output: string,
    staged: boolean,
): void {
    const filesByKey = new Map<string, WorkingFile>();
    const filesIndexByKey = new Map<string, number>();

    for (let i = 0; i < files.length; i++) {
        const key = workingFileKey(files[i].path, files[i].staged);
        filesByKey.set(key, files[i]);
        filesIndexByKey.set(key, i);
    }

    for (const line of output.trim().split("\n")) {
        if (!line.trim()) continue;

        const cols = line.split("\t");
        if (cols.length < 3) continue;

        const filePath = normalizeGitNumstatPath(cols[cols.length - 1]);
        const key = workingFileKey(filePath, staged);
        const file = filesByKey.get(key);
        if (!file) continue;

        const updated = {
            ...file,
            additions: parseGitNumstatCount(cols[0]),
            deletions: parseGitNumstatCount(cols[1]),
        };
        filesByKey.set(key, updated);
        const index = filesIndexByKey.get(key);
        if (index !== undefined) files[index] = updated;
    }
}

export function parseAlreadyStagedDeletedPaths(status: string): Set<string> {
    const alreadyStagedDeleted = new Set<string>();
    const entries = status.split("\0");

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || entry.length < 4) continue;

        const index = entry.charAt(0);
        const worktree = entry.charAt(1);
        const path = entry.slice(3);
        if (!path) continue;

        if (isRenameOrCopy(index, worktree) && i + 1 < entries.length) {
            i += 1;
        }

        if (index === "D" && worktree === " ") {
            alreadyStagedDeleted.add(path);
        }
    }

    return alreadyStagedDeleted;
}

export function planRollbackFiles(paths: string[], status: string): RollbackPlan {
    const selectedPaths = new Set(paths);
    const cleanupPaths = new Set<string>();
    const resetPaths = new Set<string>(paths);
    const checkoutPaths = new Set<string>(paths);
    const entries = status.split("\0");

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || entry.length < 4) continue;

        const index = entry.charAt(0);
        const worktree = entry.charAt(1);
        const path = entry.slice(3);
        if (!path) continue;

        const sourcePath =
            isRenameOrCopy(index, worktree) && i + 1 < entries.length ? entries[i + 1] : "";
        if (isRenameOrCopy(index, worktree) && i + 1 < entries.length) {
            i += 1;
        }
        if (!selectedPaths.has(path) && (!sourcePath || !selectedPaths.has(sourcePath))) {
            continue;
        }

        if (index === "R" && sourcePath) {
            resetPaths.add(path);
            resetPaths.add(sourcePath);
            cleanupPaths.add(path);
            checkoutPaths.delete(path);
            checkoutPaths.add(sourcePath);
            continue;
        }

        if (index === "C" && sourcePath) {
            resetPaths.add(path);
            cleanupPaths.add(path);
            checkoutPaths.delete(path);
            continue;
        }

        if (index === "?" && worktree === "?") {
            resetPaths.delete(path);
            cleanupPaths.add(path);
            checkoutPaths.delete(path);
        }
        if (index === "A") {
            cleanupPaths.add(path);
            checkoutPaths.delete(path);
        }
    }

    return {
        resetPaths: Array.from(resetPaths),
        checkoutPaths: Array.from(checkoutPaths),
        cleanupPaths: Array.from(cleanupPaths),
    };
}

function createWorkingFile(
    path: string,
    status: WorkingFile["status"],
    staged: boolean,
): WorkingFile {
    return {
        path,
        status,
        staged,
        additions: 0,
        deletions: 0,
    };
}

function isRenameOrCopy(index: string, worktree: string): boolean {
    return index === "R" || index === "C" || worktree === "R" || worktree === "C";
}

function parseGitNumstatCount(value: string): number {
    if (value === "-") return 0;
    const parsed = parseInt(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function workingFileKey(path: string, staged: boolean): string {
    return `${path}:${staged}`;
}
