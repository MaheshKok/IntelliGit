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
