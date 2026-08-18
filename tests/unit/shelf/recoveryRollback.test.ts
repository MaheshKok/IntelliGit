import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import {
    RecoverySafetyError,
    ShelfReverter,
    ShelfRollbackRetainedError,
    type RevertCheckpoint,
} from "../../../src/shelf/recovery";
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

async function gitOutput(directory: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: directory });
    return stdout;
}

async function createReverter(checkpoint?: (checkpoint: RevertCheckpoint) => Promise<void>) {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-rollback-"));
    directories.push(repositoryRoot);
    await git(repositoryRoot, ["init"]);
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "base\n");
    await git(repositoryRoot, ["add", "tracked.txt"]);
    await git(repositoryRoot, ["commit", "-m", "base"]);
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "change\n");
    const paths = await resolveShelfPaths({
        repositoryRoot,
        globalStoragePath: path.join(repositoryRoot, "shelf-storage"),
    });
    const executor = new GitExecutor(repositoryRoot);
    const gitOps = new GitOps(executor);
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const store = new ShelfStore(paths);
    return {
        repositoryRoot,
        gitOps,
        store,
        reverter: new ShelfReverter({ repositoryRoot, gitOps, gate, store, checkpoint }),
    };
}

describe("ShelfReverter per-path rollback index guards", () => {
    it("refuses a symlinked Git recovery parent before relocating the worktree original", async () => {
        const { repositoryRoot, gitOps, reverter } = await createReverter();
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-recovery-outside-"));
        directories.push(outside);
        const recoveryRoot = path.join(
            (await gitOps.getGitDirectories()).gitDir,
            "intelligit",
            "recovery",
        );
        await mkdir(path.dirname(recoveryRoot), { recursive: true });
        await symlink(outside, recoveryRoot);

        await expect(
            reverter.revert({
                transactionId: "symlinked-recovery",
                files: [{ relativePath: "tracked.txt", baseBytes: Buffer.from("base\n") }],
            }),
        ).rejects.toBeInstanceOf(RecoverySafetyError);
        expect(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8")).toBe("change\n");
        expect(await readdir(outside)).toEqual([]);
    });

    it("retains a pending journal instead of traversing a symlinked recovery root during resume", async () => {
        const { repositoryRoot, gitOps, reverter, store } = await createReverter();
        const transactionId = "resume-symlinked-recovery";
        const gitDirectories = await gitOps.getGitDirectories();
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-resume-outside-"));
        directories.push(outside);
        const recoveryRoot = path.join(gitDirectories.gitDir, "intelligit", "recovery");
        await mkdir(path.dirname(recoveryRoot), { recursive: true });
        await symlink(outside, recoveryRoot);
        const target = path.join(repositoryRoot, "tracked.txt");
        await store.writeJournal({
            id: transactionId,
            state: "shelvePendingRevert",
            expectedIndexFingerprint: createHash("sha256")
                .update(await gitOutput(repositoryRoot, ["ls-files", "--stage", "-v", "-z"]))
                .digest("hex"),
            pathProgress: {
                "tracked.txt": {
                    phase: "planned",
                    target,
                    recoveryPath: path.join(recoveryRoot, transactionId, "tracked.txt"),
                    hadOriginal: true,
                    writtenFingerprint: "absent",
                },
            },
        });

        expect(await reverter.resumePending()).toEqual({
            rolledBackIds: [],
            retainedIds: [transactionId],
        });
        expect(await readFile(target, "utf8")).toBe("change\n");
        expect(await readdir(outside)).toEqual([]);
        expect((await store.readJournals())[0]).toMatchObject({
            id: transactionId,
            state: "ghost",
        });
    });

    it("resumes a planned-only pending path as an idempotent no-op", async () => {
        const { repositoryRoot, gitOps, reverter, store } = await createReverter();
        const transactionId = "planned-only";
        const target = path.join(repositoryRoot, "tracked.txt");
        const recoveryPath = path.join(
            (await gitOps.getGitDirectories()).gitDir,
            "intelligit",
            "recovery",
            transactionId,
            "tracked.txt",
        );
        await store.writeJournal({
            id: transactionId,
            state: "shelvePendingRevert",
            expectedIndexFingerprint: "0".repeat(64),
            pathProgress: {
                "tracked.txt": {
                    phase: "planned",
                    target,
                    recoveryPath,
                    hadOriginal: true,
                    writtenFingerprint: "absent",
                },
            },
        });

        expect(await reverter.resumePending()).toEqual({
            rolledBackIds: [transactionId],
            retainedIds: [],
        });
        expect(await reverter.resumePending()).toEqual({ rolledBackIds: [], retainedIds: [] });
        expect(await readFile(target, "utf8")).toBe("change\n");
        expect(await store.readJournals()).toEqual([]);
    });

    it("restores an original moved after a planned journal but before moved progress persists", async () => {
        const { repositoryRoot, gitOps, reverter, store } = await createReverter();
        const transactionId = "planned-moved";
        const target = path.join(repositoryRoot, "tracked.txt");
        const recoveryPath = path.join(
            (await gitOps.getGitDirectories()).gitDir,
            "intelligit",
            "recovery",
            transactionId,
            "tracked.txt",
        );
        const originalIndexEntry = {
            mode: "100644",
            oid: (await gitOutput(repositoryRoot, ["rev-parse", ":tracked.txt"])).trim(),
        };
        await store.writeJournal({
            id: transactionId,
            state: "shelvePendingRevert",
            expectedIndexFingerprint: createHash("sha256")
                .update(await gitOutput(repositoryRoot, ["ls-files", "--stage", "-v", "-z"]))
                .digest("hex"),
            pathProgress: {
                "tracked.txt": {
                    phase: "planned",
                    target,
                    recoveryPath,
                    hadOriginal: true,
                    writtenFingerprint: "absent",
                    originalIndexEntry,
                    writtenIndexEntry: originalIndexEntry,
                },
            },
        });
        await mkdir(path.dirname(recoveryPath), { recursive: true });
        await rename(target, recoveryPath);

        expect(await reverter.resumePending()).toEqual({
            rolledBackIds: [transactionId],
            retainedIds: [],
        });
        expect(await readFile(target, "utf8")).toBe("change\n");
        await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(await reverter.resumePending()).toEqual({ rolledBackIds: [], retainedIds: [] });
    });

    it("retains both states when a planned-path recovery copy and third-party target coexist", async () => {
        const { repositoryRoot, gitOps, reverter, store } = await createReverter();
        const transactionId = "planned-reappeared";
        const target = path.join(repositoryRoot, "tracked.txt");
        const recoveryPath = path.join(
            (await gitOps.getGitDirectories()).gitDir,
            "intelligit",
            "recovery",
            transactionId,
            "tracked.txt",
        );
        const originalIndexEntry = {
            mode: "100644",
            oid: (await gitOutput(repositoryRoot, ["rev-parse", ":tracked.txt"])).trim(),
        };
        await store.writeJournal({
            id: transactionId,
            state: "shelvePendingRevert",
            expectedIndexFingerprint: createHash("sha256")
                .update(await gitOutput(repositoryRoot, ["ls-files", "--stage", "-v", "-z"]))
                .digest("hex"),
            pathProgress: {
                "tracked.txt": {
                    phase: "planned",
                    target,
                    recoveryPath,
                    hadOriginal: true,
                    writtenFingerprint: "absent",
                    originalIndexEntry,
                    writtenIndexEntry: originalIndexEntry,
                },
            },
        });
        await mkdir(path.dirname(recoveryPath), { recursive: true });
        await rename(target, recoveryPath);
        await writeFile(target, "third party\n");

        expect(await reverter.resumePending()).toEqual({
            rolledBackIds: [],
            retainedIds: [transactionId],
        });
        expect(await readFile(target, "utf8")).toBe("third party\n");
        expect(await readFile(recoveryPath, "utf8")).toBe("change\n");
        expect((await store.readJournals())[0]).toMatchObject({
            id: transactionId,
            state: "ghost",
        });
    });

    it("retains an impossible planned no-original recovery copy", async () => {
        const { repositoryRoot, gitOps, reverter, store } = await createReverter();
        const transactionId = "planned-no-original-copy";
        const target = path.join(repositoryRoot, "untracked.txt");
        const recoveryPath = path.join(
            (await gitOps.getGitDirectories()).gitDir,
            "intelligit",
            "recovery",
            transactionId,
            "untracked.txt",
        );
        await store.writeJournal({
            id: transactionId,
            state: "shelvePendingRevert",
            expectedIndexFingerprint: createHash("sha256")
                .update(await gitOutput(repositoryRoot, ["ls-files", "--stage", "-v", "-z"]))
                .digest("hex"),
            pathProgress: {
                "untracked.txt": {
                    phase: "planned",
                    target,
                    recoveryPath,
                    hadOriginal: false,
                    writtenFingerprint: "absent",
                },
            },
        });
        await mkdir(path.dirname(recoveryPath), { recursive: true });
        await writeFile(recoveryPath, "unexpected recovery copy\n");

        expect(await reverter.resumePending()).toEqual({
            rolledBackIds: [],
            retainedIds: [transactionId],
        });
        expect(await readFile(recoveryPath, "utf8")).toBe("unexpected recovery copy\n");
        expect((await store.readJournals())[0]).toMatchObject({
            id: transactionId,
            state: "ghost",
        });
    });

    it("restores transaction paths without overwriting an unrelated third-party index entry", async () => {
        let root = "";
        let verified = 0;
        const subject = await createReverter(async (checkpoint) => {
            if (checkpoint !== "recovery-verified") return;
            verified += 1;
            if (verified !== 2) return;
            await writeFile(path.join(root, "third-party.txt"), "third party\n");
            await git(root, ["add", "third-party.txt"]);
            throw new Error("crash after unrelated index change");
        });
        root = subject.repositoryRoot;
        await writeFile(path.join(root, "a.txt"), "a base\n");
        await writeFile(path.join(root, "b.txt"), "b base\n");
        await git(root, ["add", "a.txt", "b.txt"]);
        await git(root, ["commit", "-m", "rollback paths"]);
        await writeFile(path.join(root, "a.txt"), "a staged\n");
        await writeFile(path.join(root, "b.txt"), "b staged\n");
        await git(root, ["add", "a.txt", "b.txt"]);

        await expect(
            subject.reverter.revert({
                transactionId: "per-path-index-guard",
                files: [{ relativePath: "a.txt" }, { relativePath: "b.txt" }],
            }),
        ).rejects.toThrow("crash after unrelated index change");

        expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("a staged\n");
        expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("b staged\n");
        expect(await gitOutput(root, ["show", ":a.txt"])).toBe("a staged\n");
        expect(await gitOutput(root, ["show", ":b.txt"])).toBe("b staged\n");
        expect(await gitOutput(root, ["show", ":third-party.txt"])).toBe("third party\n");
    });

    it("retains recovery instead of restoring through a symlink swapped during rollback", async () => {
        let root = "";
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-rollback-outside-"));
        directories.push(outside);
        const { repositoryRoot, gitOps, reverter } = await createReverter(async (checkpoint) => {
            if (checkpoint !== "source-moved") return;
            await rename(path.join(root, "nested"), path.join(root, "nested-original"));
            await symlink(outside, path.join(root, "nested"));
            throw new Error("crash after symlink swap");
        });
        root = repositoryRoot;
        await mkdir(path.join(root, "nested"), { recursive: true });
        await writeFile(path.join(root, "nested", "untracked.txt"), "original\n");

        const error = await reverter
            .revert({
                transactionId: "rollback-symlink-swap",
                files: [{ relativePath: "nested/untracked.txt" }],
            })
            .catch((reason: unknown) => reason);
        const recoveryPath = path.join(
            (await gitOps.getGitDirectories()).gitDir,
            "intelligit",
            "recovery",
            "rollback-symlink-swap",
            "nested",
            "untracked.txt",
        );

        expect(error).toBeInstanceOf(ShelfRollbackRetainedError);
        await expect(readFile(path.join(outside, "untracked.txt"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await readFile(recoveryPath, "utf8")).toBe("original\n");
    });

    it("recreates a missing parent while restoring a deleted nested tracked file", async () => {
        const { repositoryRoot, reverter } = await createReverter();
        await mkdir(path.join(repositoryRoot, "gone"), { recursive: true });
        await writeFile(path.join(repositoryRoot, "gone", "nested.txt"), "nested base\n");
        await git(repositoryRoot, ["add", "gone/nested.txt"]);
        await git(repositoryRoot, ["commit", "-m", "nested base"]);
        await rm(path.join(repositoryRoot, "gone"), { recursive: true, force: true });
        await git(repositoryRoot, ["add", "-u"]);

        await reverter.revert({
            transactionId: "restore-nested-delete",
            files: [{ relativePath: "gone/nested.txt" }],
        });

        expect(await readFile(path.join(repositoryRoot, "gone", "nested.txt"), "utf8")).toBe(
            "nested base\n",
        );
        expect(await gitOutput(repositoryRoot, ["show", ":gone/nested.txt"])).toBe("nested base\n");
    });
});
