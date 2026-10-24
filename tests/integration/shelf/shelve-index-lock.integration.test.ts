import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { GitOps } from "../../../src/git/operations";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import {
    REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS,
    RepositoryMutationGate,
} from "../../../src/git/repositoryMutationGate";
import {
    ShelfReverter,
    ShelfRollbackRetainedError,
    type RevertCheckpoint,
} from "../../../src/shelf/recovery";
import { GitExecutorRecoveryGit } from "../../../src/shelf/recoveryGit";
import { cleanTemporaryRepositories, createShelfFixture, git } from "./shelfTestHarness";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanTemporaryRepositories();
});

/** Holds `.git/index.lock` the way a concurrent Git process (VS Code's own refresh) does. */
async function holdIndexLock(root: string) {
    const lock = path.join(root, ".git", "index.lock");
    await writeFile(lock, "", { flag: "wx" });
    return () => rm(lock, { force: true });
}

function isIndexWrite(args: readonly string[]) {
    return args[0] === "update-index" && args[1] === "-z";
}

/** Restages tracked.txt the way another Git process does: in its own index file, then renamed in. */
async function stageForeignEntry(root: string, executor: GitExecutor, oid: string) {
    const foreign = path.join(root, ".git", "foreign-index");
    await copyFile(path.join(root, ".git", "index"), foreign);
    await executor.runBinary(["update-index", "--cacheinfo", `100644,${oid},tracked.txt`], {
        env: { GIT_INDEX_FILE: foreign },
    });
    await rename(foreign, path.join(root, ".git", "index"));
}

async function stagedEntry(root: string) {
    return (await git(root, ["ls-files", "--stage", "--", "tracked.txt"])).toString("utf8");
}

/**
 * Reverts a staged change while, from the `at` checkpoint on, another Git process holds
 * index.lock. That process restages tracked.txt and releases the lock either right after the
 * write under test is first refused ("at-refusal"), so the first retry is the only attempt that
 * can see the change, or just before a retried write runs ("before-retry"), so a re-check made
 * while the lock was still held read the index that process was about to replace. In
 * "before-retry" a timer restages and releases after 300 ms when no retried write comes first.
 */
async function contendedReverter(
    at: RevertCheckpoint,
    interrupt = false,
    publishes: "at-refusal" | "before-retry" = "at-refusal",
) {
    const f = await createShelfFixture();
    await writeFile(path.join(f.root, "tracked.txt"), "local\n");
    await git(f.root, ["add", "tracked.txt"]);
    await f.store.withLock(() => f.store.migrateWithHeldLocks());
    const foreignOid = (
        await f.executor.runBinary(["hash-object", "-w", "--stdin"], {
            input: Buffer.from("foreign\n"),
        })
    ).stdout
        .toString("utf8")
        .trim();
    let release: (() => Promise<void>) | undefined;
    let staged = false;
    let refused = false;
    const publish = async () => {
        if (staged) return;
        staged = true;
        await stageForeignEntry(f.root, f.executor, foreignOid);
        await release?.();
    };
    const runBinary = f.executor.runBinary.bind(f.executor);
    vi.spyOn(f.executor, "runBinary").mockImplementation(async (args, options) => {
        if (refused && isIndexWrite(args)) await publish();
        try {
            return await runBinary(args, options);
        } catch (error) {
            if (release && !staged && isIndexWrite(args)) {
                if (publishes === "at-refusal") await publish();
                else if (!refused) {
                    refused = true;
                    setTimeout(() => void publish(), 300);
                }
            }
            throw error;
        }
    });
    const recoveryGit = new GitExecutorRecoveryGit(f.executor);
    const reverter = new ShelfReverter({
        repositoryRoot: f.root,
        gitOps: new GitOps(f.executor),
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
        store: f.store,
        git: recoveryGit,
        checkpoint: async (checkpoint) => {
            if (checkpoint !== at) return;
            release = await holdIndexLock(f.root);
            if (interrupt) throw new Error(`interrupted at ${at}`);
        },
    });
    const revert = () =>
        reverter.revert({ transactionId: "contended", files: [{ relativePath: "tracked.txt" }] });
    return { root: f.root, foreignOid, recoveryGit, revert };
}

describe("shelve save under a concurrent index.lock", () => {
    it("waits out an index.lock released mid-wait and shelves", async () => {
        const f = await createShelfFixture();
        await writeFile(path.join(f.root, "tracked.txt"), "local\n");
        // A staged change makes removal write the base entry back through `update-index -z`.
        await git(f.root, ["add", "tracked.txt"]);
        // The shelf reverter builds its own executor, so the seam is the prototype.
        const run = GitExecutor.prototype.runBinary;
        let locked = false;
        const spy = vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(async function (
            this: GitExecutor,
            args,
            options,
        ) {
            if (isIndexWrite(args) && !locked) {
                locked = true;
                const release = await holdIndexLock(f.root);
                setTimeout(() => void release(), 300);
            }
            return run.call(this, args, options);
        });
        const saved = await f.service.shelve({
            name: "Locked",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        expect(locked, "the index write met a held index.lock").toBe(true);
        expect(saved.shelfId, "shelve succeeds once the lock is released").toBeDefined();
        expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe("base\n");
        expect(spy.mock.calls.filter(([args]) => isIndexWrite(args)).length).toBeGreaterThan(1);
    });

    it("re-checks the index before retrying a restore write, keeping an entry staged meanwhile", async () => {
        const { root, foreignOid, recoveryGit, revert } = await contendedReverter("base-written");
        const write = vi.spyOn(recoveryGit, "writeIndexEntry");
        await expect(revert(), "the restore refuses the restaged path").rejects.toThrow(
            ShelfRollbackRetainedError,
        );
        await expect(
            write.mock.results[0]?.value,
            "the retried write stops at the index precondition",
        ).rejects.toThrow("Index changed during the shelf recovery transaction.");
        expect(await stagedEntry(root), "the other process's entry survives").toBe(
            `100644 ${foreignOid} 0\ttracked.txt\n`,
        );
    });

    it("re-checks a rolled-back path before retrying its index write, keeping an entry staged meanwhile", async () => {
        const { root, foreignOid, revert } = await contendedReverter("index-updated", true);
        await expect(revert(), "rollback retains the restaged path").rejects.toThrow(
            ShelfRollbackRetainedError,
        );
        expect(await stagedEntry(root), "the other process's entry survives").toBe(
            `100644 ${foreignOid} 0\ttracked.txt\n`,
        );
    });

    it("re-checks a restore write only once index.lock is gone, keeping an entry its holder staged", async () => {
        const { root, foreignOid, revert } = await contendedReverter(
            "base-written",
            false,
            "before-retry",
        );
        const outcome = await revert().then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(await stagedEntry(root), "the other process's entry survives").toBe(
            `100644 ${foreignOid} 0\ttracked.txt\n`,
        );
        expect(outcome, "the restore refuses the restaged path").toBeInstanceOf(
            ShelfRollbackRetainedError,
        );
    });

    it("re-checks a rolled-back path only once index.lock is gone, keeping an entry its holder staged", async () => {
        const { root, foreignOid, revert } = await contendedReverter(
            "index-updated",
            true,
            "before-retry",
        );
        const outcome = await revert().then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(await stagedEntry(root), "the other process's entry survives").toBe(
            `100644 ${foreignOid} 0\ttracked.txt\n`,
        );
        expect(outcome, "rollback retains the restaged path").toBeInstanceOf(
            ShelfRollbackRetainedError,
        );
    });

    it("fails with Git's own message once a held index.lock outlasts the bound", async () => {
        const f = await createShelfFixture();
        const recovery = new GitExecutorRecoveryGit(f.executor);
        const entry = await recovery.getIndexEntry("tracked.txt");
        await holdIndexLock(f.root);
        const started = Date.now();
        const outcome = await Promise.race([
            recovery.writeIndexEntry("tracked.txt", entry).then(
                () => "written",
                (error: Error) => error.message,
            ),
            new Promise<string>((resolve) =>
                setTimeout(
                    () => resolve("still waiting"),
                    REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS + 3_000,
                ),
            ),
        ]);
        const elapsed = Date.now() - started;
        expect(outcome, "the wait gives up with Git's unchanged message").toMatch(
            /^git update-index -z exited with 128: fatal: Unable to create '.*index\.lock': File exists/,
        );
        expect(elapsed, "the wait lasts the bound").toBeGreaterThanOrEqual(
            REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS,
        );
    }, 20_000);

    it("does not retry other Git errors", async () => {
        const f = await createShelfFixture();
        const recovery = new GitExecutorRecoveryGit(f.executor);
        const entry = await recovery.getIndexEntry("tracked.txt");
        await writeFile(path.join(f.root, ".git", "index"), "not an index");
        const spy = vi.spyOn(f.executor, "runBinary");
        await expect(recovery.writeIndexEntry("tracked.txt", entry)).rejects.toThrow(
            /^git update-index -z exited with 128: (?![\s\S]*index\.lock)/,
        );
        expect(
            spy.mock.calls.filter(([args]) => isIndexWrite(args)),
            "a non-lock Git failure runs once",
        ).toHaveLength(1);
    });
});
