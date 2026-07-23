import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import {
    assertShelfCaptureStateSupported,
    captureWorktreeRawFidelity,
} from "../../../src/shelf/capture";
import { ShelfUnsupportedStateError, type ShelfFileEntry } from "../../../src/shelf/model";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
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

async function createRepository(): Promise<string> {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-capture-"));
    directories.push(repositoryRoot);
    await git(repositoryRoot, ["init"]);
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "base\n");
    await git(repositoryRoot, ["add", "tracked.txt"]);
    await git(repositoryRoot, ["commit", "-m", "base"]);
    return repositoryRoot;
}

function entry(relativePath: string): ShelfFileEntry {
    return {
        changeId: relativePath,
        worktreeBlock: { path: relativePath, status: "M" },
        binary: false,
        untracked: false,
        baseAvailability: "full",
        exactReconstruction: true,
        lifecycle: "shelved",
    };
}

describe("Phase-1 shelf capture primitives", () => {
    it("stores raw before/after objects when eol filtering changes materialized bytes", async () => {
        const repositoryRoot = await createRepository();
        await writeFile(path.join(repositoryRoot, ".gitattributes"), "*.txt text eol=crlf\n");
        await git(repositoryRoot, ["add", ".gitattributes"]);
        await git(repositoryRoot, ["commit", "-m", "eol"]);
        await rm(path.join(repositoryRoot, "tracked.txt"));
        await git(repositoryRoot, ["checkout", "--", "tracked.txt"]);
        const worktreeBytes = await readFile(path.join(repositoryRoot, "tracked.txt"));
        const paths = await resolveShelfPaths({
            repositoryRoot,
            globalStoragePath: path.join(repositoryRoot, "shelf-storage"),
        });
        const store = new ShelfStore(paths);

        const result = await captureWorktreeRawFidelity({
            materializedBytes: Buffer.from("base\n"),
            preimageBytes: Buffer.from("base\n"),
            repositoryRoot,
            relativePath: "tracked.txt",
            shelfId: "shelf-one",
            store,
            entry: entry("tracked.txt"),
        });

        expect(worktreeBytes).toEqual(Buffer.from("base\r\n"));
        expect(result.entry.exactReconstruction).toBe(false);
        expect(result.rawBeforeObjectHash).toBeDefined();
        expect(result.rawAfterObjectHash).toBeDefined();
        expect(result.entry.worktreeBlock?.rawBeforeObjectHash).toBe(result.rawBeforeObjectHash);
        expect(result.entry.worktreeBlock?.rawAfterObjectHash).toBe(result.rawAfterObjectHash);
        await expect(store.readObject("shelf-one", result.rawBeforeObjectHash!)).resolves.toEqual(
            Buffer.from("base\n"),
        );
        await expect(store.readObject("shelf-one", result.rawAfterObjectHash!)).resolves.toEqual(
            Buffer.from("base\r\n"),
        );
    });

    it("keeps exact entries object-free when index materialization matches worktree bytes", async () => {
        const repositoryRoot = await createRepository();
        const paths = await resolveShelfPaths({
            repositoryRoot,
            globalStoragePath: path.join(repositoryRoot, "shelf-storage"),
        });

        const result = await captureWorktreeRawFidelity({
            materializedBytes: Buffer.from("base\n"),
            repositoryRoot,
            relativePath: "tracked.txt",
            shelfId: "shelf-one",
            store: new ShelfStore(paths),
            entry: entry("tracked.txt"),
        });

        expect(result.entry.exactReconstruction).toBe(true);
        expect(result.rawBeforeObjectHash).toBeUndefined();
        expect(result.rawAfterObjectHash).toBeUndefined();
    });

    it("keeps ordinary unstaged edits exact when their materialized layer matches", async () => {
        const repositoryRoot = await createRepository();
        await writeFile(path.join(repositoryRoot, "tracked.txt"), "edited\n");
        const paths = await resolveShelfPaths({
            repositoryRoot,
            globalStoragePath: path.join(repositoryRoot, "shelf-storage"),
        });

        const result = await captureWorktreeRawFidelity({
            materializedBytes: Buffer.from("edited\n"),
            repositoryRoot,
            relativePath: "tracked.txt",
            shelfId: "shelf-one",
            store: new ShelfStore(paths),
            entry: entry("tracked.txt"),
        });

        expect(result.entry.exactReconstruction).toBe(true);
        expect(result.rawBeforeObjectHash).toBeUndefined();
        expect(result.rawAfterObjectHash).toBeUndefined();
    });

    it.each([
        [
            "symlink",
            async (root: string) => {
                await symlink("tracked.txt", path.join(root, "link.txt"));
                await git(root, ["add", "link.txt"]);
            },
        ],
        [
            "submodule",
            async (root: string) => {
                const nested = path.join(root, "nested");
                await git(root, ["init", nested]);
                await writeFile(path.join(nested, "nested.txt"), "nested\n");
                await git(nested, ["add", "nested.txt"]);
                await git(nested, ["commit", "-m", "nested"]);
                await git(root, ["add", "nested"]);
            },
        ],
        [
            "unmerged-stage",
            async (root: string) => {
                await git(root, ["checkout", "-b", "side"]);
                await writeFile(path.join(root, "tracked.txt"), "side\n");
                await git(root, ["add", "tracked.txt"]);
                await git(root, ["commit", "-m", "side"]);
                await git(root, ["checkout", "-"]);
                await writeFile(path.join(root, "tracked.txt"), "main\n");
                await git(root, ["add", "tracked.txt"]);
                await git(root, ["commit", "-m", "main"]);
                await expect(
                    execFileAsync("git", ["merge", "side"], { cwd: root }),
                ).rejects.toBeDefined();
            },
        ],
        [
            "intent-to-add",
            async (root: string) => {
                await writeFile(path.join(root, "intent.txt"), "intent\n");
                await git(root, ["add", "--intent-to-add", "intent.txt"]);
            },
        ],
        [
            "skip-worktree",
            async (root: string) => {
                await git(root, ["update-index", "--skip-worktree", "tracked.txt"]);
            },
        ],
        [
            "assume-unchanged",
            async (root: string) => {
                await git(root, ["update-index", "--assume-unchanged", "tracked.txt"]);
            },
        ],
    ] as const)("rejects %s before capture", async (state, setup) => {
        const repositoryRoot = await createRepository();
        await setup(repositoryRoot);

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).state).toBe(state);
    });

    it("rejects an untracked symlink before capture", async () => {
        const repositoryRoot = await createRepository();
        await symlink("tracked.txt", path.join(repositoryRoot, "untracked-link.txt"));

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).state).toBe("symlink");
    });

    it("rejects a tracked regular file replaced by a directory with an untracked child", async () => {
        const repositoryRoot = await createRepository();
        const tracked = path.join(repositoryRoot, "tracked");
        await writeFile(tracked, "base\n");
        await git(repositoryRoot, ["add", "tracked"]);
        await git(repositoryRoot, ["commit", "-m", "tracked file"]);
        await rm(tracked);
        await mkdir(tracked);
        await writeFile(path.join(tracked, "child"), "child\n");

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).changeId).toBe("tracked");
        expect((error as ShelfUnsupportedStateError).state).toBe("type-swap");
    });

    it("rejects a tracked regular file replaced by an empty directory", async () => {
        const repositoryRoot = await createRepository();
        const tracked = path.join(repositoryRoot, "tracked.txt");
        await rm(tracked);
        await mkdir(tracked);

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).changeId).toBe("tracked.txt");
        expect((error as ShelfUnsupportedStateError).state).toBe("type-swap");
    });

    it("rejects a staged tracked-file replacement by a directory", async () => {
        const repositoryRoot = await createRepository();
        const tracked = path.join(repositoryRoot, "tracked");
        await writeFile(tracked, "base\n");
        await git(repositoryRoot, ["add", "tracked"]);
        await git(repositoryRoot, ["commit", "-m", "tracked file"]);
        await rm(tracked);
        await mkdir(tracked);
        await writeFile(path.join(tracked, "child"), "child\n");
        await git(repositoryRoot, ["add", "-A"]);

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).changeId).toBe("tracked");
        expect((error as ShelfUnsupportedStateError).state).toBe("type-swap");
    });

    it.each([
        [
            "a missing tracked file",
            async (root: string) => {
                await rm(path.join(root, "tracked.txt"));
            },
        ],
        [
            "a regular tracked modification",
            async (root: string) => {
                await writeFile(path.join(root, "tracked.txt"), "edited\n");
            },
        ],
    ] as const)("allows %s", async (_description, setup) => {
        const repositoryRoot = await createRepository();
        await setup(repositoryRoot);

        await expect(
            assertShelfCaptureStateSupported(new GitExecutor(repositoryRoot), repositoryRoot),
        ).resolves.toBeUndefined();
    });

    it("rejects a staged deletion of a symlink retained in the pinned base", async () => {
        const repositoryRoot = await createRepository();
        await symlink("tracked.txt", path.join(repositoryRoot, "base-link.txt"));
        await git(repositoryRoot, ["add", "base-link.txt"]);
        await git(repositoryRoot, ["commit", "-m", "add symlink"]);
        await git(repositoryRoot, ["rm", "base-link.txt"]);

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).state).toBe("symlink");
    });

    it("rejects an untracked nested repository as a submodule", async () => {
        const repositoryRoot = await createRepository();
        const nested = path.join(repositoryRoot, "nested");
        await git(repositoryRoot, ["init", nested]);
        await writeFile(path.join(nested, "nested.txt"), "nested\n");
        await git(nested, ["add", "nested.txt"]);
        await git(nested, ["commit", "-m", "nested"]);

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).state).toBe("submodule");
    });

    it("rejects a tracked worktree type-change to a symlink", async () => {
        const repositoryRoot = await createRepository();
        await rm(path.join(repositoryRoot, "tracked.txt"));
        await symlink("replacement.txt", path.join(repositoryRoot, "tracked.txt"));

        const error = await assertShelfCaptureStateSupported(
            new GitExecutor(repositoryRoot),
            repositoryRoot,
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ShelfUnsupportedStateError);
        expect((error as ShelfUnsupportedStateError).state).toBe("symlink");
    });
});
