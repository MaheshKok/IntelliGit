/**
 * Worktree enumeration, feeding both the `worktrees` section and the per-worktree admin
 * directories `snapshotGitDirState.ts` walks (PLAN.md step 9: "Linked worktree *directories* live
 * outside the repo root, so `dispose()` enumerates and removes them rather than just deleting the
 * root").
 *
 * `git worktree list --porcelain` always lists the primary worktree (the repository root itself,
 * bare or not) first, confirmed empirically. Its admin directory *is* the common directory
 * already walked separately, so it is excluded from the per-worktree map here to avoid walking
 * the same bytes under two keys.
 */

import path from "node:path";
import { runGit } from "./gitRun";
import type { Section, WorktreeInfo } from "./snapshotTypes";
import { captured } from "./snapshotTypes";

export interface SnapshotWorktreesResult {
    readonly section: Section<readonly WorktreeInfo[]>;
    /** Linked worktrees only, keyed by working-directory path -> resolved absolute admin dir. */
    readonly linkedGitDirs: ReadonlyMap<string, string>;
}

export async function snapshotWorktrees(
    repoRoot: string,
    commonDir: string,
    env: NodeJS.ProcessEnv,
): Promise<SnapshotWorktreesResult> {
    const raw = await runGit(repoRoot, ["worktree", "list", "--porcelain"], env);
    const blocks = raw
        .split("\n\n")
        .map((block) => block.trim())
        .filter((block) => block.length > 0);

    const infos: WorktreeInfo[] = [];
    const linkedGitDirs = new Map<string, string>();
    for (const [index, block] of blocks.entries()) {
        const fields = parseBlockFields(block);
        const worktreePath = requireField(fields, "worktree", block);
        // The primary worktree's admin directory is the common directory, already walked
        // separately; only linked worktrees (every block after the first) get their own resolved
        // git-dir and their own entry in the private-state map.
        const gitDir = index === 0 ? commonDir : await resolveGitDir(worktreePath, env);
        if (index > 0) linkedGitDirs.set(worktreePath, gitDir);
        infos.push(buildWorktreeInfo(worktreePath, gitDir, fields));
    }
    return { section: captured(infos), linkedGitDirs };
}

function parseBlockFields(block: string): ReadonlyMap<string, string> {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
        const spaceIndex = line.indexOf(" ");
        const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
        const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);
        fields.set(key, value);
    }
    return fields;
}

function requireField(fields: ReadonlyMap<string, string>, key: string, block: string): string {
    const value = fields.get(key);
    if (!value) {
        throw new Error(`snapshotWorktrees: block missing "${key}" field: ${JSON.stringify(block)}`);
    }
    return value;
}

function buildWorktreeInfo(
    worktreePath: string,
    gitDir: string,
    fields: ReadonlyMap<string, string>,
): WorktreeInfo {
    return {
        path: worktreePath,
        gitDir,
        head: fields.get("HEAD") ?? null,
        branch: fields.get("branch") ?? null,
        bare: fields.has("bare"),
        detached: fields.has("detached"),
        locked: fields.has("locked") ? (fields.get("locked") ?? "") : null,
        prunable: fields.has("prunable") ? (fields.get("prunable") ?? "") : null,
    };
}

async function resolveGitDir(worktreePath: string, env: NodeJS.ProcessEnv): Promise<string> {
    const result = await runGit(worktreePath, ["rev-parse", "--git-dir"], env);
    return path.resolve(worktreePath, result);
}
