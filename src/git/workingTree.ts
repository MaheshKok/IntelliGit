import type { WorkingFile } from "../types";
import { normalizeGitNumstatPath } from "./numstat";
import { mapStatusCode } from "./parsers";

/**
 * File-operation plan for rolling selected working-tree paths back to HEAD.
 *
 * Reset paths are removed from the index, checkout paths are restored from HEAD, and cleanup paths
 * are removed from the filesystem when status marks them as created or untracked.
 */
export interface RollbackPlan {
    resetPaths: string[];
    checkoutPaths: string[];
    cleanupPaths: string[];
}

type PorcelainStatusEntry = {
    index: string;
    worktree: string;
    path: string;
    sourcePath: string | undefined;
    nextIndex: number;
};

type MutableRollbackPlan = {
    resetPaths: Set<string>;
    checkoutPaths: Set<string>;
    cleanupPaths: Set<string>;
};

/**
 * Parses NUL-delimited porcelain status into IntelliGit working-file rows.
 *
 * Rename and copy source paths are consumed from the following NUL field, staged and unstaged states
 * are split into separate rows, ignored `!!` paths stay unstaged, and staged adds avoid duplicate
 * modified rows for edited new files.
 */
export function parseWorkingTreeStatus(result: string): WorkingFile[] {
    const files: WorkingFile[] = [];
    const entries = result.split("\0");

    for (let i = 0; i < entries.length; i++) {
        const entry = readPorcelainStatusEntry(entries, i);
        if (!entry) continue;

        i = entry.nextIndex;
        files.push(...toWorkingFiles(entry));
    }

    return files;
}

/**
 * Applies Git numstat additions and deletions to existing working-file rows.
 *
 * Paths are normalized with Git numstat escaping rules and matched by path plus staged state so staged
 * and unstaged copies of the same file keep independent statistics.
 */
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

/**
 * Extracts paths already staged as deletions from NUL-delimited porcelain status.
 *
 * The result lets callers avoid passing those paths back to `git add`, which would accidentally
 * re-stage deleted files as present when users only wanted to stage other selections.
 */
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

/**
 * Builds the reset, checkout, and cleanup operations needed to roll back selected paths safely.
 *
 * Rename/copy source paths, untracked files, and staged additions receive separate treatment so the
 * caller only cleans paths identified by Git status for the user's selected rollback scope.
 */
export function planRollbackFiles(paths: string[], status: string): RollbackPlan {
    const selectedPaths = new Set(paths);
    const plan: MutableRollbackPlan = {
        resetPaths: new Set(paths),
        checkoutPaths: new Set(paths),
        cleanupPaths: new Set(),
    };
    const entries = status.split("\0");

    for (let i = 0; i < entries.length; i++) {
        const entry = readPorcelainStatusEntry(entries, i);
        if (!entry) continue;

        i = entry.nextIndex;
        if (!isRollbackPathSelected(entry, selectedPaths)) continue;

        applyRollbackEntry(plan, entry);
    }

    return {
        resetPaths: Array.from(plan.resetPaths),
        checkoutPaths: Array.from(plan.checkoutPaths),
        cleanupPaths: Array.from(plan.cleanupPaths),
    };
}

/** Decodes one porcelain entry and consumes its following rename/copy source-path field when present. */
function readPorcelainStatusEntry(
    entries: string[],
    entryIndex: number,
): PorcelainStatusEntry | undefined {
    const rawEntry = entries[entryIndex];
    if (!rawEntry || rawEntry.length < 4) return undefined;

    const index = rawEntry.charAt(0);
    const worktree = rawEntry.charAt(1);
    const path = rawEntry.slice(3);
    if (!path) return undefined;

    const hasSourcePath = isRenameOrCopy(index, worktree) && entryIndex + 1 < entries.length;
    return {
        index,
        worktree,
        path,
        sourcePath: hasSourcePath ? entries[entryIndex + 1] : undefined,
        nextIndex: hasSourcePath ? entryIndex + 1 : entryIndex,
    };
}

/** Creates the staged and unstaged view rows implied by one parsed porcelain status entry. */
function toWorkingFiles(entry: PorcelainStatusEntry): WorkingFile[] {
    const files: WorkingFile[] = [];
    const hasStaged = entry.index !== " " && entry.index !== "?" && entry.index !== "!";
    const hasUnstaged = entry.worktree !== " ";
    const stagedStatus = mapStatusCode(entry.index);
    const unstagedStatus = mapStatusCode(entry.worktree);

    if (hasStaged && stagedStatus) {
        files.push(createWorkingFile(entry.path, stagedStatus, true));
    }
    if (hasUnstaged && unstagedStatus && !(entry.index === "A" && unstagedStatus === "M")) {
        files.push(createWorkingFile(entry.path, unstagedStatus, false));
    }

    return files;
}

/** Returns whether either path represented by a porcelain status entry belongs to the rollback request. */
function isRollbackPathSelected(entry: PorcelainStatusEntry, selectedPaths: Set<string>): boolean {
    return (
        selectedPaths.has(entry.path) ||
        (entry.sourcePath !== undefined &&
            entry.sourcePath.length > 0 &&
            selectedPaths.has(entry.sourcePath))
    );
}

/** Adds the reset, checkout, and cleanup work required by a selected porcelain status entry. */
function applyRollbackEntry(plan: MutableRollbackPlan, entry: PorcelainStatusEntry): void {
    if (entry.index === "R" && entry.sourcePath) {
        plan.resetPaths.add(entry.path);
        plan.resetPaths.add(entry.sourcePath);
        plan.cleanupPaths.add(entry.path);
        plan.checkoutPaths.delete(entry.path);
        plan.checkoutPaths.add(entry.sourcePath);
        return;
    }

    if (entry.index === "C" && entry.sourcePath) {
        plan.resetPaths.add(entry.path);
        plan.cleanupPaths.add(entry.path);
        plan.checkoutPaths.delete(entry.path);
        return;
    }

    if (entry.index === "?" && entry.worktree === "?") {
        plan.resetPaths.delete(entry.path);
        plan.cleanupPaths.add(entry.path);
        plan.checkoutPaths.delete(entry.path);
    }
    if (entry.index === "A") {
        plan.cleanupPaths.add(entry.path);
        plan.checkoutPaths.delete(entry.path);
    }
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
