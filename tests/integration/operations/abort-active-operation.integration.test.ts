import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
let originalGitConfigGlobal: string | undefined;
let originalGitConfigNoSystem: string | undefined;

beforeEach(() => {
    originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = devNull;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(async () => {
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    if (originalGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem;
    // Git keeps writing into `.git/objects/pack` after the command that triggered it has
    // returned, so a file can appear between this rm's readdir and its rmdir and surface as
    // `ENOTEMPTY: directory not empty, rmdir '.../.git/objects/pack'`. It failed CI on a row
    // whose own assertions had all passed, which is the signature of a teardown race rather
    // than a defect in the row. `maxRetries`/`retryDelay` are Node's documented remedy for
    // exactly this error class, and `tests/fixtures/repo/harness.ts` already carries the same
    // fix for the same error. Retrying is safe because these directories are scratch this file
    // created and nothing recreates them once teardown has begun.
    await Promise.all(
        directories
            .splice(0)
            .map((directory) =>
                rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
            ),
    );
});

describe("GitOps.abortMerge active operation dispatch", () => {
    it("aborts a conflicted merge and restores its pre-merge HEAD", async () => {
        const repositoryRoot = await createRepository();
        await commitFile(repositoryRoot, "merge.txt", "base\n", "base");
        await git(repositoryRoot, ["branch", "topic"]);
        await git(repositoryRoot, ["switch", "topic"]);
        await commitFile(repositoryRoot, "merge.txt", "topic\n", "topic change");
        await git(repositoryRoot, ["switch", "main"]);
        await commitFile(repositoryRoot, "merge.txt", "main\n", "main change");
        const preMergeHead = await head(repositoryRoot);

        await expectGitFailure(repositoryRoot, ["merge", "topic"]);

        const ops = gitOps(repositoryRoot);
        expect(await ops.getActiveOperation()).toBe("merge");
        await expect(ops.abortMerge()).resolves.toBeUndefined();

        expect(await markerExists(repositoryRoot, "MERGE_HEAD")).toBe(false);
        expect(await head(repositoryRoot)).toBe(preMergeHead);
        expect(await worktreeIsClean(repositoryRoot)).toBe(true);
    });

    it("aborts a conflicted cherry-pick and restores its pre-cherry-pick HEAD", async () => {
        const repositoryRoot = await createRepository();
        await commitFile(repositoryRoot, "cherry.txt", "base\n", "base");
        await git(repositoryRoot, ["branch", "source"]);
        await git(repositoryRoot, ["switch", "source"]);
        await commitFile(repositoryRoot, "cherry.txt", "source\n", "source change");
        const sourceCommit = await head(repositoryRoot);
        await git(repositoryRoot, ["switch", "main"]);
        await commitFile(repositoryRoot, "cherry.txt", "main\n", "main change");
        const preCherryPickHead = await head(repositoryRoot);

        await expectGitFailure(repositoryRoot, ["cherry-pick", sourceCommit]);

        const ops = gitOps(repositoryRoot);
        expect(await ops.getActiveOperation()).toBe("cherry-pick");
        await expect(ops.abortMerge()).resolves.toBeUndefined();

        expect(await markerExists(repositoryRoot, "CHERRY_PICK_HEAD")).toBe(false);
        expect(await head(repositoryRoot)).toBe(preCherryPickHead);
    });

    it("aborts a single-commit conflicted revert and restores its pre-revert HEAD", async () => {
        const repositoryRoot = await createRepository();
        await commitFile(repositoryRoot, "revert.txt", "base\n", "base");
        await commitFile(repositoryRoot, "revert.txt", "target\n", "target");
        const targetCommit = await head(repositoryRoot);
        await commitFile(repositoryRoot, "revert.txt", "later\n", "later");
        const preRevertHead = await head(repositoryRoot);

        await expectGitFailure(repositoryRoot, ["revert", targetCommit]);

        const ops = gitOps(repositoryRoot);
        expect(await ops.getActiveOperation()).toBe("revert");
        expect(await markerExists(repositoryRoot, "sequencer")).toBe(false);
        await expect(ops.abortMerge()).resolves.toBeUndefined();

        expect(await markerExists(repositoryRoot, "REVERT_HEAD")).toBe(false);
        expect(await head(repositoryRoot)).toBe(preRevertHead);
    });

    it("aborts a multi-commit conflicted revert back to the pre-revert HEAD", async () => {
        const repositoryRoot = await createRepository();
        await commitFile(repositoryRoot, "revert.txt", "base\n", "base");
        await commitFile(repositoryRoot, "revert.txt", "target\n", "first target");
        const firstTarget = await head(repositoryRoot);
        await commitFile(repositoryRoot, "other.txt", "second target\n", "second target");
        const secondTarget = await head(repositoryRoot);
        await commitFile(repositoryRoot, "revert.txt", "later\n", "later");
        const preRevertHead = await head(repositoryRoot);

        await expectGitFailure(repositoryRoot, ["revert", secondTarget, firstTarget]);

        const ops = gitOps(repositoryRoot);
        expect(await ops.getActiveOperation()).toBe("revert");
        expect(await markerExists(repositoryRoot, "sequencer")).toBe(true);
        expect(await head(repositoryRoot)).not.toBe(preRevertHead);
        await expect(ops.abortMerge()).resolves.toBeUndefined();

        expect(await head(repositoryRoot)).toBe(preRevertHead);
        expect(await markerExists(repositoryRoot, "sequencer")).toBe(false);
    });

    it("aborts a conflicted rebase and restores its pre-rebase HEAD", async () => {
        const repositoryRoot = await createRepository();
        await commitFile(repositoryRoot, "rebase.txt", "base\n", "base");
        await git(repositoryRoot, ["branch", "topic"]);
        await commitFile(repositoryRoot, "rebase.txt", "main\n", "main change");
        await git(repositoryRoot, ["switch", "topic"]);
        await commitFile(repositoryRoot, "rebase.txt", "topic\n", "topic change");
        const preRebaseHead = await head(repositoryRoot);

        await expectGitFailure(repositoryRoot, ["rebase", "main"]);

        const ops = gitOps(repositoryRoot);
        expect(await ops.getActiveOperation()).toBe("rebase");
        await expect(ops.abortMerge()).resolves.toBeUndefined();

        expect(await head(repositoryRoot)).toBe(preRebaseHead);
    });

    it("uses the live merge classification after a completed rebase", async () => {
        const repositoryRoot = await createRepository();
        await commitFile(repositoryRoot, "rebase.txt", "base\n", "base");
        await git(repositoryRoot, ["branch", "topic"]);
        await commitFile(repositoryRoot, "rebase.txt", "main\n", "main change");
        await git(repositoryRoot, ["switch", "topic"]);
        await commitFile(repositoryRoot, "rebase.txt", "topic\n", "topic change");

        await expectGitFailure(repositoryRoot, ["rebase", "main"]);
        await writeFile(path.join(repositoryRoot, "rebase.txt"), "resolved\n");
        await git(repositoryRoot, ["add", "rebase.txt"]);
        await git(repositoryRoot, ["rebase", "--continue"]);

        // Some Git versions retain REBASE_HEAD after --continue while others remove it. Only the
        // rebase directories identify a live operation, so neither behavior is a test precondition.
        expect(await markerExists(repositoryRoot, "rebase-merge")).toBe(false);
        expect(await markerExists(repositoryRoot, "rebase-apply")).toBe(false);

        await git(repositoryRoot, ["switch", "-c", "merge-topic"]);
        await commitFile(repositoryRoot, "merge.txt", "topic\n", "topic merge change");
        await git(repositoryRoot, ["switch", "topic"]);
        await commitFile(repositoryRoot, "merge.txt", "main\n", "main merge change");

        await expectGitFailure(repositoryRoot, ["merge", "merge-topic"]);

        const ops = gitOps(repositoryRoot);
        expect(await ops.getActiveOperation()).toBe("merge");
        await expect(ops.abortMerge()).resolves.toBeUndefined();

        expect(await markerExists(repositoryRoot, "MERGE_HEAD")).toBe(false);
    });
});

/** Creates a cleanup-managed repository with a local identity. */
async function createRepository(): Promise<string> {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "intelligit-abort-operation-"));
    directories.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-b", "main"]);
    await git(repositoryRoot, ["config", "user.email", "integration@example.invalid"]);
    await git(repositoryRoot, ["config", "user.name", "Integration Test"]);
    await git(repositoryRoot, ["config", "commit.gpgSign", "false"]);
    await commitFile(repositoryRoot, "initial.txt", "initial\n", "initial");
    return repositoryRoot;
}

/** Commits one file change inside an isolated fixture. */
async function commitFile(
    repositoryRoot: string,
    filename: string,
    contents: string,
    message: string,
): Promise<void> {
    await writeFile(path.join(repositoryRoot, filename), contents);
    await git(repositoryRoot, ["add", filename]);
    await git(repositoryRoot, ["commit", "-m", message]);
}

/** Runs Git against one isolated fixture. */
async function git(repositoryRoot: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", [...args], {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_EDITOR: "true",
        },
    });
    return stdout;
}

/** Verifies that the real Git command failed while leaving its fixture available for assertions. */
async function expectGitFailure(repositoryRoot: string, args: readonly string[]): Promise<void> {
    await expect(git(repositoryRoot, args)).rejects.toThrow();
}

/** Reads the current fixture HEAD. */
async function head(repositoryRoot: string): Promise<string> {
    return (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
}

/** Checks an entry under the worktree-aware Git directory. */
async function markerExists(repositoryRoot: string, marker: string): Promise<boolean> {
    const gitDirectory = path.resolve(
        repositoryRoot,
        (await git(repositoryRoot, ["rev-parse", "--git-dir"])).trim(),
    );
    try {
        await access(path.join(gitDirectory, marker));
        return true;
    } catch {
        return false;
    }
}

/** Returns whether Git reports no tracked or untracked worktree changes. */
async function worktreeIsClean(repositoryRoot: string): Promise<boolean> {
    return (await git(repositoryRoot, ["status", "--porcelain"])).trim() === "";
}

/** Creates production Git operations rooted in the isolated fixture. */
function gitOps(repositoryRoot: string): GitOps {
    return new GitOps(new GitExecutor(repositoryRoot));
}
