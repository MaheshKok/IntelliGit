import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveGitCommonDir, resolveGitDir } from "../../../src/git/gitDirectory";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

// These run against the real filesystem on purpose. The behaviour under test is how Git lays a
// linked worktree out on disk -- a `.git` pointer file, a `commondir` pointer beside it -- so a
// mocked `fs` would be asserting this file's own idea of that layout rather than Git's.
let fixture: string | undefined;

afterEach(() => {
    if (fixture) removeScratchDirectoriesSync(fixture);
    fixture = undefined;
});

/** Builds a main checkout plus one linked worktree, laid out the way `git worktree add` does. */
function makeWorktreeFixture(): { mainGitDir: string; worktreeRoot: string } {
    fixture = mkdtempSync(path.join(tmpdir(), "intelligit-gitdir-"));
    const mainGitDir = path.join(fixture, "main", ".git");
    const worktreeGitDir = path.join(mainGitDir, "worktrees", "wt");
    const worktreeRoot = path.join(fixture, "wt");
    mkdirSync(path.join(mainGitDir, "refs", "remotes", "origin"), { recursive: true });
    mkdirSync(path.join(worktreeGitDir, "refs"), { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
    return { mainGitDir, worktreeRoot };
}

describe("resolveGitCommonDir", () => {
    it("follows a linked worktree's commondir pointer to the shared Git directory", () => {
        const { mainGitDir, worktreeRoot } = makeWorktreeFixture();
        expect(resolveGitCommonDir(worktreeRoot)).toBe(mainGitDir);
    });

    // Guards the pair, not just the new resolver: per-worktree state (HEAD, index, rebase files)
    // must keep resolving to the worktree's own directory, or moving refs onto the common one
    // would have dragged every other caller of `resolveGitDir` along with it.
    it("leaves the per-worktree Git directory pointing at the worktree", () => {
        const { mainGitDir, worktreeRoot } = makeWorktreeFixture();
        expect(resolveGitDir(worktreeRoot)).toBe(path.join(mainGitDir, "worktrees", "wt"));
    });

    it("returns the repository's own Git directory when there is no worktree pointer", () => {
        fixture = mkdtempSync(path.join(tmpdir(), "intelligit-gitdir-"));
        const repoRoot = path.join(fixture, "repo");
        mkdirSync(path.join(repoRoot, ".git", "refs"), { recursive: true });
        expect(resolveGitCommonDir(repoRoot)).toBe(path.join(repoRoot, ".git"));
    });
});
