import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Resolves a repository's Git metadata directory synchronously.
 *
 * Linked worktrees replace `.git` with a `gitdir:` pointer file. Missing, unreadable, or malformed
 * pointers intentionally fall back to the conventional `.git` path so callers retain the prior
 * best-effort filesystem behavior.
 */
export function resolveGitDir(repoRoot: string): string {
    const dotGit = path.join(repoRoot, ".git");
    try {
        if (!statSync(dotGit).isFile()) return dotGit;
        const content = readFileSync(dotGit, "utf8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) return dotGit;
        return path.isAbsolute(match[1]) ? match[1] : path.resolve(repoRoot, match[1]);
    } catch {
        return dotGit;
    }
}

/**
 * Resolves the Git directory that holds a repository's shared state.
 *
 * A linked worktree owns `HEAD`, `index`, and the in-progress operation files, but not refs:
 * `refs/`, `packed-refs`, and the object store live in the common directory that every worktree
 * shares, and Git records the way back in a `commondir` pointer file. Callers that watch or read
 * refs need this; callers that read per-worktree state want `resolveGitDir` instead. For a plain
 * checkout the two are the same directory, so a missing or unreadable pointer falls back to it.
 */
export function resolveGitCommonDir(repoRoot: string): string {
    const gitDir = resolveGitDir(repoRoot);
    try {
        const pointer = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
        if (!pointer) return gitDir;
        return path.isAbsolute(pointer) ? pointer : path.resolve(gitDir, pointer);
    } catch {
        return gitDir;
    }
}
