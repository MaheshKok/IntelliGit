import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { GitOps } from "../../../src/git/operations";
import { RepositoryLock, isExclusiveCreateBlocked } from "../../../src/git/repositoryLock";
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
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
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

/**
 * Restages tracked.txt the way a Git process that respects the index lock does: it takes
 * `.git/index.lock` first and, as Git does, gives up when another process already holds it.
 */
async function restageUnderLock(root: string, executor: GitExecutor, oid: string) {
    let release: () => Promise<void>;
    try {
        release = await holdIndexLock(root);
    } catch (error) {
        if (isExclusiveCreateBlocked(error)) return "refused";
        throw error;
    }
    try {
        await stageForeignEntry(root, executor, oid);
    } finally {
        await release();
    }
    return "staged";
}

async function stagedEntry(root: string) {
    return (await git(root, ["ls-files", "--stage", "--", "tracked.txt"])).toString("utf8");
}

/**
 * Reverts a staged change while another Git process contends for index.lock from the `at`
 * checkpoint on. In "holds-lock" that process takes the lock at `at`, restages tracked.txt and
 * releases the lock 300 ms later, so the write under test waits for it and must then see the
 * change. In "between-check-and-write" nothing holds the lock at `at`; instead a lock-respecting
 * Git process tries to restage tracked.txt right before the next index write runs, and `gap()`
 * reports whether it got in ("staged") or met a held index.lock ("refused").
 */
async function contendedReverter(
    at: RevertCheckpoint,
    interrupt = false,
    contender: "holds-lock" | "between-check-and-write" = "holds-lock",
) {
    const f = await createShelfFixture();
    await writeFile(path.join(f.root, "tracked.txt"), "local\n");
    await git(f.root, ["add", "tracked.txt"]);
    const oidOf = async (spec: string) =>
        (await git(f.root, ["rev-parse", spec])).toString("utf8").trim();
    const baseOid = await oidOf("HEAD:tracked.txt");
    const localOid = await oidOf(":tracked.txt");
    await f.store.withLock(() => f.store.migrateWithHeldLocks());
    const foreignOid = (
        await f.executor.runBinary(["hash-object", "-w", "--stdin"], {
            input: Buffer.from("foreign\n"),
        })
    ).stdout
        .toString("utf8")
        .trim();
    let gapArmed = false;
    let gap: "staged" | "refused" | undefined;
    const runBinary = f.executor.runBinary.bind(f.executor);
    vi.spyOn(f.executor, "runBinary").mockImplementation(async (args, options) => {
        if (gapArmed && isIndexWrite(args)) {
            gapArmed = false;
            gap = await restageUnderLock(f.root, f.executor, foreignOid);
        }
        return runBinary(args, options);
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
            if (contender === "between-check-and-write") gapArmed = true;
            else {
                const release = await holdIndexLock(f.root);
                setTimeout(
                    () => void stageForeignEntry(f.root, f.executor, foreignOid).finally(release),
                    300,
                );
            }
            if (interrupt) throw new Error(`interrupted at ${at}`);
        },
    });
    const revert = () =>
        reverter.revert({ transactionId: "contended", files: [{ relativePath: "tracked.txt" }] });
    return { root: f.root, foreignOid, baseOid, localOid, recoveryGit, revert, gap: () => gap };
}

describe("shelve save under a concurrent index.lock", () => {
    it("waits out an index.lock released mid-wait and shelves", async () => {
        const f = await createShelfFixture();
        await writeFile(path.join(f.root, "tracked.txt"), "local\n");
        // A staged change makes removal write the base entry back through `update-index -z`.
        await git(f.root, ["add", "tracked.txt"]);
        // The shelf reverter builds its own recovery Git, so the seams are the prototypes.
        const write = GitExecutorRecoveryGit.prototype.writeIndexEntry;
        let locked = false;
        let releasing = false;
        vi.spyOn(GitExecutorRecoveryGit.prototype, "writeIndexEntry").mockImplementation(
            async function (this: GitExecutorRecoveryGit, ...args) {
                if (!locked) {
                    locked = true;
                    const release = await holdIndexLock(f.root);
                    setTimeout(() => {
                        releasing = true;
                        void release();
                    }, 300);
                }
                return write.apply(this, args);
            },
        );
        const run = GitExecutor.prototype.runBinary;
        const editsAfterRelease: boolean[] = [];
        vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(async function (
            this: GitExecutor,
            args,
            options,
        ) {
            if (locked && isIndexWrite(args)) editsAfterRelease.push(releasing);
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
        expect(
            editsAfterRelease,
            "Git edits the index only once the other process lets go",
        ).toEqual([true]);
    });

    it("checks the index for a restore write only once it holds index.lock, keeping an entry the lock's holder staged", async () => {
        const { root, foreignOid, recoveryGit, revert } = await contendedReverter("base-written");
        const write = vi.spyOn(recoveryGit, "writeIndexEntry");
        await expect(revert(), "the restore refuses the restaged path").rejects.toThrow(
            ShelfRollbackRetainedError,
        );
        await expect(
            write.mock.results[0]?.value,
            "the write stops at the index check it runs under the lock",
        ).rejects.toThrow("Index changed during the shelf recovery transaction.");
        expect(await stagedEntry(root), "the other process's entry survives").toBe(
            `100644 ${foreignOid} 0\ttracked.txt\n`,
        );
    });

    it("checks a rolled-back path only once it holds index.lock, keeping an entry the lock's holder staged", async () => {
        const { root, foreignOid, revert } = await contendedReverter("index-updated", true);
        await expect(revert(), "rollback retains the restaged path").rejects.toThrow(
            ShelfRollbackRetainedError,
        );
        expect(await stagedEntry(root), "the other process's entry survives").toBe(
            `100644 ${foreignOid} 0\ttracked.txt\n`,
        );
    });

    it("keeps another Git process out of index.lock between a restore's index check and its write", async () => {
        const { root, baseOid, revert, gap } = await contendedReverter(
            "base-written",
            false,
            "between-check-and-write",
        );
        await revert();
        expect(gap(), "another Git process cannot take index.lock after the check").toBe("refused");
        expect(await stagedEntry(root), "the restore stages the base entry").toBe(
            `100644 ${baseOid} 0\ttracked.txt\n`,
        );
    });

    it("keeps another Git process out of index.lock between a rolled-back path's index check and its write", async () => {
        const { root, localOid, revert, gap } = await contendedReverter(
            "index-updated",
            true,
            "between-check-and-write",
        );
        await expect(revert(), "the interrupted revert rolls back").rejects.toThrow(
            "interrupted at index-updated",
        );
        expect(gap(), "another Git process cannot take index.lock after the check").toBe("refused");
        expect(await stagedEntry(root), "rollback restages the original entry").toBe(
            `100644 ${localOid} 0\ttracked.txt\n`,
        );
    });

    it("fails with Git's lock wording once a held index.lock outlasts the bound", async () => {
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
        expect(outcome, "the wait gives up with Git's wording").toMatch(
            /^Unable to create '.*index\.lock': File exists\./,
        );
        expect(elapsed, "the wait lasts the bound").toBeGreaterThanOrEqual(
            REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS,
        );
    }, 20_000);

    // Windows refuses a newline in a directory name.
    it.skipIf(process.platform === "win32")(
        "waits out an index.lock in a checkout whose path holds a newline",
        async () => {
            const root = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-line\nbreak-"));
            try {
                await git(root, ["init"]);
                await writeFile(path.join(root, "tracked.txt"), "base\n");
                await git(root, ["add", "tracked.txt"]);
                const recovery = new GitExecutorRecoveryGit(new GitExecutor(root));
                const entry = await recovery.getIndexEntry("tracked.txt");
                const release = await holdIndexLock(root);
                setTimeout(() => void release(), 200);
                const outcome = await recovery.writeIndexEntry("tracked.txt", entry).then(
                    () => "written",
                    (error: Error) => error.message,
                );
                expect(outcome, "the refused write waits for the lock").toBe("written");
            } finally {
                await removeScratchDirectories(root);
            }
        },
    );

    it("writes into a linked worktree's own index, leaving the main checkout's alone", async () => {
        const f = await createShelfFixture();
        const linked = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-linked-"));
        try {
            await git(f.root, ["worktree", "add", "--detach", linked]);
            await writeFile(path.join(f.root, "other.txt"), "linked\n");
            const oid = (await git(f.root, ["hash-object", "-w", "--", "other.txt"]))
                .toString("utf8")
                .trim();
            const mainBefore = await stagedEntry(f.root);
            await new GitExecutorRecoveryGit(new GitExecutor(linked)).writeIndexEntry(
                "tracked.txt",
                { mode: "100644", oid },
            );
            expect(await stagedEntry(linked), "the linked worktree's index holds the write").toBe(
                `100644 ${oid} 0\ttracked.txt\n`,
            );
            expect(await stagedEntry(f.root), "the main checkout's index is untouched").toBe(
                mainBefore,
            );
        } finally {
            await removeScratchDirectories(linked);
        }
    });

    it("does not retry other Git errors", async () => {
        const f = await createShelfFixture();
        const recovery = new GitExecutorRecoveryGit(f.executor);
        const entry = await recovery.getIndexEntry("tracked.txt");
        await writeFile(path.join(f.root, ".git", "index"), "not an index");
        const spy = vi.spyOn(f.executor, "runBinary");
        await expect(recovery.writeIndexEntry("tracked.txt", entry)).rejects.toThrow(
            /^git update-index -z exited with 128: /,
        );
        expect(
            spy.mock.calls.filter(([args]) => isIndexWrite(args)),
            "a non-lock Git failure runs once",
        ).toHaveLength(1);
        expect(
            existsSync(path.join(f.root, ".git", "index.lock")),
            "a failed write removes the index.lock it took",
        ).toBe(false);
    });
});
