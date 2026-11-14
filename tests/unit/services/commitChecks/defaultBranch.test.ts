// The default branch for required checks comes from `origin/HEAD` and its tip, read from a real
// repository on every call and never cached (PLAN.md §8, K22).

import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../../src/git/executor";
import { GitOps } from "../../../../src/git/operations";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

vi.mock("vscode", () => ({ l10n: { t: (text: string) => text } }));

let root: string;
let gitOps: GitOps;

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(message: string): string {
    git("commit", "--allow-empty", "-q", "-m", message);
    return git("rev-parse", "HEAD");
}

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "intelligit-default-branch-"));
    git("init", "-q", "-b", "work");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    gitOps = new GitOps(new GitExecutor(root));
});

afterEach(async () => {
    await removeScratchDirectories(root);
});

describe("readDefaultBranch", () => {
    it("missing origin/HEAD → null", async () => {
        const tip = commit("one");
        // A remote branch named like the usual default exists, but origin/HEAD does not point at it.
        git("update-ref", "refs/remotes/origin/main", tip);

        await expect(gitOps.readDefaultBranch()).resolves.toBeNull();
    });

    it("origin/HEAD pointing at a branch with no tip → null", async () => {
        commit("one");
        git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

        await expect(gitOps.readDefaultBranch()).resolves.toBeNull();
    });

    it("tip read from origin/<name>", async () => {
        const trunk = commit("trunk tip");
        const other = commit("other tip");
        git("update-ref", "refs/remotes/origin/trunk", trunk);
        git("update-ref", "refs/remotes/origin/main", other);
        git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

        await expect(gitOps.readDefaultBranch()).resolves.toEqual({
            name: "trunk",
            tipHash: trunk,
        });
    });

    it("keeps a slash in the branch name", async () => {
        const tip = commit("release tip");
        git("update-ref", "refs/remotes/origin/release/2026", tip);
        git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/2026");

        await expect(gitOps.readDefaultBranch()).resolves.toEqual({
            name: "release/2026",
            tipHash: tip,
        });
    });

    it("a remote tip that moves between two comparisons is read fresh", async () => {
        const first = commit("first");
        git("update-ref", "refs/remotes/origin/trunk", first);
        git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
        await expect(gitOps.readDefaultBranch()).resolves.toEqual({
            name: "trunk",
            tipHash: first,
        });

        // What an ordinary `git fetch` does to the remote-tracking ref.
        const second = commit("second");
        git("update-ref", "refs/remotes/origin/trunk", second);
        await expect(gitOps.readDefaultBranch()).resolves.toEqual({
            name: "trunk",
            tipHash: second,
        });

        // `git remote set-head origin --auto` after the remote renamed its default branch.
        git("update-ref", "refs/remotes/origin/develop", first);
        git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
        await expect(gitOps.readDefaultBranch()).resolves.toEqual({
            name: "develop",
            tipHash: first,
        });
    });
});
