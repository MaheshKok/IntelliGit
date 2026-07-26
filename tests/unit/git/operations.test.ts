import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function git(directory: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, {
        cwd: directory,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
}

describe("GitOps.getGitDirectories", () => {
    it("resolves Git-managed directories instead of assuming a literal .git path", async () => {
        const directories = await new GitOps(new GitExecutor(process.cwd())).getGitDirectories();

        expect(directories.gitDir).toMatch(/\.git/);
        expect(directories.commonDir).toMatch(/\.git/);
    });

    it("resolves linked-worktree directories when .git is a file", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-worktree-"));
        directories.push(root);
        const linked = path.join(root, "linked");
        await git(root, ["init"]);
        await writeFile(path.join(root, "tracked.txt"), "base\n");
        await git(root, ["add", "tracked.txt"]);
        await git(root, ["commit", "-m", "base"]);
        await git(root, ["worktree", "add", "--detach", linked]);

        const gitDirectories = await new GitOps(new GitExecutor(linked)).getGitDirectories();

        expect(gitDirectories.gitDir).toContain(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        expect(gitDirectories.commonDir).toBe(path.join(await realpath(root), ".git"));
    });
});
