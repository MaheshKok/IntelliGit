import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS } from "../../../src/git/repositoryMutationGate";
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
