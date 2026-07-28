import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

async function git(directory: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
        cwd: directory,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
    return stdout;
}

async function createGitRepository(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-operation-state-"));
    directories.push(root);
    await git(root, ["init"]);
    return root;
}

/** Resolves the absolute path of a repository's live index file the same way production code does. */
async function getIndexPath(root: string): Promise<string> {
    const reported = (await git(root, ["rev-parse", "--git-path", "index"])).trim();
    return path.isAbsolute(reported) ? reported : path.resolve(root, reported);
}

/** Lists `withIndexSnapshot`'s temp-directory names currently present under the OS temp root. */
async function listIndexSnapshotDirs(): Promise<Set<string>> {
    const entries = await readdir(tmpdir());
    return new Set(entries.filter((name) => name.startsWith("intelligit-index-")));
}

describe("GitOps.getGitDirectories", () => {
    it("resolves Git-managed directories and the normalized repository root", async () => {
        const directories = await new GitOps(new GitExecutor(process.cwd())).getGitDirectories();

        expect(directories.gitDir).toMatch(/\.git/);
        expect(directories.commonDir).toMatch(/\.git/);
        expect(directories.root).toBe(path.resolve(process.cwd()));
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
        expect(gitDirectories.root).toBe(await realpath(linked));
    });
});

describe("GitOps.hasWholeIndexOperationInProgress", () => {
    it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])(
        "detects the %s marker",
        async (marker) => {
            const root = await createGitRepository();
            await writeFile(path.join(root, ".git", marker), "state\n");

            await expect(
                new GitOps(new GitExecutor(root)).hasWholeIndexOperationInProgress(),
            ).resolves.toBe(true);
        },
    );

    it.each(["rebase-merge", "rebase-apply"])("detects the %s directory", async (directory) => {
        const root = await createGitRepository();
        await mkdir(path.join(root, ".git", directory));

        await expect(
            new GitOps(new GitExecutor(root)).hasWholeIndexOperationInProgress(),
        ).resolves.toBe(true);
    });

    it("resolves a linked worktree gitdir file before checking markers", async () => {
        const root = await createGitRepository();
        const linked = path.join(root, "linked");
        await writeFile(path.join(root, "tracked.txt"), "base\n");
        await git(root, ["add", "tracked.txt"]);
        await git(root, ["commit", "-m", "base"]);
        await git(root, ["worktree", "add", "--detach", linked]);
        const reportedGitDir = (await git(linked, ["rev-parse", "--git-dir"])).trim();
        const gitDir = path.isAbsolute(reportedGitDir)
            ? reportedGitDir
            : path.resolve(linked, reportedGitDir);
        await writeFile(path.join(gitDir, "CHERRY_PICK_HEAD"), "state\n");

        await expect(
            new GitOps(new GitExecutor(linked)).hasWholeIndexOperationInProgress(),
        ).resolves.toBe(true);
    });

    it("returns false for a clean repository", async () => {
        const root = await createGitRepository();

        await expect(
            new GitOps(new GitExecutor(root)).hasWholeIndexOperationInProgress(),
        ).resolves.toBe(false);
    });
});

describe("GitOps.withIndexSnapshot", () => {
    it("restores the pre-operation index bytes and cleans up the temp dir on success", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const indexPath = await getIndexPath(root);
        const originalIndexBytes = await readFile(indexPath);
        const tempDirsBefore = await listIndexSnapshotDirs();

        const result = await gitOps.withIndexSnapshot(async () => {
            await writeFile(path.join(root, "b.txt"), "b\n");
            await git(root, ["add", "b.txt"]);
            return "operation-result";
        });

        expect(result).toBe("operation-result");
        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
        // Other test workers create snapshot dirs concurrently in the shared
        // tmpdir; retry so only a dir this test leaks permanently fails.
        let leakedDirs: string[] = [];
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const tempDirsAfter = await listIndexSnapshotDirs();
            leakedDirs = [...tempDirsAfter].filter((dir) => !tempDirsBefore.has(dir));
            if (leakedDirs.length === 0) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(leakedDirs).toEqual([]);
    });

    it("restores the index and rethrows the same error when the operation fails", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const indexPath = await getIndexPath(root);
        const originalIndexBytes = await readFile(indexPath);
        const operationError = new Error("operation boom");

        await expect(
            gitOps.withIndexSnapshot(async () => {
                await writeFile(path.join(root, "b.txt"), "b\n");
                await git(root, ["add", "b.txt"]);
                throw operationError;
            }),
        ).rejects.toBe(operationError);

        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
    });

    it("preserves the operation error as the cause when restore also fails after the operation fails", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const operationError = new Error("operation boom");

        const caught: unknown = await gitOps
            .withIndexSnapshot(async () => {
                await rm(path.join(root, ".git"), { recursive: true, force: true });
                throw operationError;
            })
            .catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(Error);
        const error = caught as Error;
        expect(error.message).toContain("operation boom");
        expect(error.message.toLowerCase()).toContain("restor");
        expect(error.cause).toBe(operationError);
    });

    it("reports that the commit succeeded but the index restore failed", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);

        const caught: unknown = await gitOps
            .withIndexSnapshot(async () => {
                await rm(path.join(root, ".git"), { recursive: true, force: true });
                return "operation-result";
            })
            .catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(Error);
        const error = caught as Error;
        expect(error.message.toLowerCase()).toContain("commit succeeded");
        expect(error.message.toLowerCase()).toContain("restor");
    });

    it("falls back to a direct copy when a concurrent Git process holds the index .lock file", async () => {
        const root = await createGitRepository();
        const gitOps = new GitOps(new GitExecutor(root));
        await writeFile(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "a.txt"]);
        const indexPath = await getIndexPath(root);
        const originalIndexBytes = await readFile(indexPath);
        await writeFile(`${indexPath}.lock`, "held-by-another-git-process");

        const result = await gitOps.withIndexSnapshot(async () => {
            // A real `git` write here would also block on the planted `.lock` file, so mutate
            // the index bytes directly to isolate this test to the restore fallback itself.
            await writeFile(indexPath, "mutated-index-bytes-outside-git");
            return "operation-result";
        });

        expect(result).toBe("operation-result");
        await expect(readFile(indexPath)).resolves.toEqual(originalIndexBytes);
    });
});
