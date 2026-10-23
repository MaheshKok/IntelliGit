import { spawn } from "node:child_process";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartialChanges } from "../../../src/git/partialChanges";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import {
    ShelfReverter,
    ShelfWorktreeRemovalCompletedError,
    type RevertCheckpoint,
} from "../../../src/shelf/recovery";
import { ShelfStore } from "../../../src/shelf/store";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { changeIds } from "../../../src/changes/selection";
import {
    FILENAMES_MAY_CONTAIN_RESERVED_CHARACTERS,
    POSIX_PERMISSIONS_ENFORCED,
} from "../../helpers/platformCapabilities";
import { describeAbruptTermination } from "../../helpers/abruptTermination";
import { cleanTemporaryRepositories, createShelfFixture, git } from "./shelfTestHarness";

afterEach(cleanTemporaryRepositories);
const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
const selected = base.replace("line 4\n", "selected\n");
const remaining = base.replace("line 24\n", "other list\n");
const working = selected.replace("line 24\n", "other list\n");

async function fixture(checkpoint?: (point: RevertCheckpoint) => Promise<void>) {
    const fixture = await createShelfFixture({
        initialFiles: { "tracked.txt": base, "other.txt": "base\n" },
    });
    await fixture.store.withLock(() => fixture.store.migrateWithHeldLocks());
    await writeFile(path.join(fixture.root, "tracked.txt"), selected);
    await writeFile(path.join(fixture.root, "other.txt"), "unrelated staged\n");
    await git(fixture.root, ["add", "tracked.txt", "other.txt"]);
    await writeFile(path.join(fixture.root, "tracked.txt"), working);
    const workflow = new PartialChanges(fixture.executor, fixture.root);
    const repositoryLock = new RepositoryLock();
    const reverter = new ShelfReverter({
        repositoryRoot: fixture.root,
        gitOps: new GitOps(fixture.executor),
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), repositoryLock),
        store: fixture.store,
        checkpoint,
    });
    const view = await workflow.open("tracked.txt");
    return {
        ...fixture,
        workflow,
        repositoryLock,
        reverter,
        selection: { snapshotId: view.snapshotId, lineIds: changeIds(view.blocks.slice(0, 1)) },
    };
}

describe("selected worktree removal", () => {
    it.each([
        ["repository", false],
        ["store", false],
        ["repository", true],
        ["store", true],
    ] as const)(
        "classifies %s release failure after completion (existing completed error: %s)",
        async (boundary, existingCompletedError) => {
            const f = await fixture(async (point) => {
                if (existingCompletedError && point === "journal-committed")
                    throw new Error("post-publication failure");
            });
            const releaseError = new Error(boundary + " release failed");
            if (boundary === "repository") {
                const acquire = f.repositoryLock.acquire.bind(f.repositoryLock);
                vi.spyOn(f.repositoryLock, "acquire").mockImplementation(async (directory) => {
                    const release = await acquire(directory);
                    return async () => {
                        await release();
                        throw releaseError;
                    };
                });
            } else {
                const withLock = f.store.withLock.bind(f.store);
                let storeDepth = 0;
                vi.spyOn(f.store, "withLock").mockImplementation(
                    async <T>(operation: () => Promise<T>): Promise<T> => {
                        storeDepth++;
                        try {
                            return await withLock(operation);
                        } finally {
                            if (--storeDepth === 0) throw releaseError;
                        }
                    },
                );
            }
            const index = await readFile(path.join(f.root, ".git/index"));
            const result = await f.workflow
                .rollback(f.selection, () => undefined, f.reverter, "release-completed")
                .catch((error: unknown) => error);
            expect(result).toBeInstanceOf(ShelfWorktreeRemovalCompletedError);
            expect(result).toMatchObject({ completed: true, cause: releaseError });
            const recoveryDirectory = (result as ShelfWorktreeRemovalCompletedError)
                .recoveryDirectory;
            expect(await readFile(path.join(recoveryDirectory, "tracked.txt"), "utf8")).toBe(
                working,
            );
            expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(remaining);
            expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
            expect((await f.store.readJournals())[0].state).toBe("shelved");
        },
    );

    it("removes only selected lines while preserving exact index bytes, unrelated edits, mode and HEAD", async () => {
        const f = await fixture();
        if (POSIX_PERMISSIONS_ENFORCED) await chmod(path.join(f.root, "tracked.txt"), 0o755);
        const index = await readFile(path.join(f.root, ".git/index"));
        const head = await git(f.root, ["rev-parse", "HEAD"]);
        const result = await f.workflow.rollback(
            f.selection,
            () => undefined,
            f.reverter,
            "selected-remove",
        );
        expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(remaining);
        expect(await readFile(path.join(f.root, "other.txt"), "utf8")).toBe("unrelated staged\n");
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
        expect(await git(f.root, ["rev-parse", "HEAD"])).toEqual(head);
        if (POSIX_PERMISSIONS_ENFORCED)
            expect((await lstat(path.join(f.root, "tracked.txt"))).mode & 0o777).toBe(0o755);
        expect(await readFile(path.join(result.recoveryDirectory, "tracked.txt"), "utf8")).toBe(
            working,
        );
        expect((await f.store.readJournals())[0]).toMatchObject({ state: "shelved" });
        expect((await f.store.readJournals())[0].shelf).toBeUndefined();
    });

    it.each(["dirty", "stale", "empty", "foreign", "index-side"])(
        "refuses %s before calling the destructive reverter",
        async (fault) => {
            const f = await fixture();
            const spy = vi.spyOn(f.reverter, "revertWorktree");
            const selection = { ...f.selection };
            if (fault === "stale")
                await writeFile(path.join(f.root, "tracked.txt"), working + "external\n");
            if (fault === "empty") selection.lineIds = [];
            if (fault === "foreign") selection.lineIds = ["foreign"];
            if (fault === "index-side") {
                const view = await f.workflow.open("tracked.txt", "index");
                selection.snapshotId = view.snapshotId;
                selection.lineIds = changeIds(view.blocks);
            }
            const bytes = await readFile(path.join(f.root, "tracked.txt"));
            const index = await readFile(path.join(f.root, ".git/index"));
            await expect(
                f.workflow.rollback(
                    selection,
                    () => {
                        if (fault === "dirty") throw new Error("dirty buffer");
                    },
                    f.reverter,
                    "refused",
                ),
            ).rejects.toThrow();
            // Stale/dirty validation also runs under the reverter gate, before its first journal/write.
            if (["empty", "foreign", "index-side"].includes(fault))
                expect(spy).not.toHaveBeenCalled();
            expect(await f.store.readJournals()).toEqual([]);
            expect(await readFile(path.join(f.root, "tracked.txt"))).toEqual(bytes);
            expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
        },
    );

    it.each(["crlf", "no-final-newline", "unicode"])(
        "preserves %s bytes outside the selection",
        async (kind) => {
            const f = await fixture();
            let before = base;
            let after = working;
            let kept = remaining;
            let name = "tracked.txt";
            if (kind === "crlf") {
                await git(f.root, ["config", "core.autocrlf", "true"]);
                before = base.replaceAll("\n", "\r\n");
                after = working.replaceAll("\n", "\r\n");
                kept = remaining.replaceAll("\n", "\r\n");
            }
            if (kind === "no-final-newline") {
                before = before.trimEnd();
                after = after.trimEnd();
                kept = kept.trimEnd();
            }
            if (kind === "unicode") {
                // Without `*` on Windows, the `[é]` class still proves the name reaches Git literally.
                name = FILENAMES_MAY_CONTAIN_RESERVED_CHARACTERS
                    ? "literal [é]*.txt"
                    : "literal [é].txt";
                await git(f.root, ["mv", "tracked.txt", name]);
            }
            await writeFile(path.join(f.root, name), before);
            await git(f.root, ["add", "--", name]);
            await git(f.root, ["commit", "-m", "fixture shape"]);
            await writeFile(path.join(f.root, name), after);
            const view = await f.workflow.open(name);
            const index = await readFile(path.join(f.root, ".git/index"));
            await f.workflow.rollback(
                { snapshotId: view.snapshotId, lineIds: changeIds(view.blocks.slice(0, 1)) },
                () => undefined,
                f.reverter,
                "shape",
            );
            expect(await readFile(path.join(f.root, name))).toEqual(Buffer.from(kept));
            expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
        },
    );

    it.each([
        "journal-created",
        "original-durable",
        "source-moved",
        "base-written",
        "recovery-verified",
    ] as const)("failure at %s restores working bytes without writing the index", async (point) => {
        const f = await fixture(async (actual) => {
            if (actual === point) throw new Error("injected " + point);
        });
        const index = await readFile(path.join(f.root, ".git/index"));
        await expect(
            f.workflow.rollback(f.selection, () => undefined, f.reverter, "interrupted"),
        ).rejects.toThrow("injected " + point);
        expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
    });

    it("does not move the original if durable backup publication fails", async () => {
        const f = await fixture();
        vi.spyOn(f.store, "putObject").mockImplementation(async () => {
            expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(working);
            throw new Error("backup unavailable");
        });
        const index = await readFile(path.join(f.root, ".git/index"));
        await expect(
            f.workflow.rollback(f.selection, () => undefined, f.reverter, "backup-fail"),
        ).rejects.toThrow("backup unavailable");
        expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(working);
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
    });

    it.each(["worktree", "index"])(
        "retains recovery and external %s edits after installation",
        async (surface) => {
            let root = "";
            let externalIndex: Buffer | undefined;
            const f = await fixture(async (point) => {
                if (point !== "base-written") return;
                if (surface === "worktree")
                    await writeFile(path.join(root, "tracked.txt"), "external after removal\n");
                else {
                    await writeFile(path.join(root, "tracked.txt"), "external staged\n");
                    await git(root, ["add", "tracked.txt"]);
                    await writeFile(path.join(root, "tracked.txt"), remaining);
                    externalIndex = await readFile(path.join(root, ".git/index"));
                }
            });
            root = f.root;
            const index = await readFile(path.join(root, ".git/index"));
            await expect(
                f.workflow.rollback(f.selection, () => undefined, f.reverter, "external-edit"),
            ).rejects.toThrow("retained recovery");
            expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe(
                surface === "worktree" ? "external after removal\n" : remaining,
            );
            expect(await readFile(path.join(root, ".git/index"))).toEqual(externalIndex ?? index);
            expect((await f.store.readJournals())[0].state).toBe("shelvePendingRevert");
            expect((await f.reverter.resumePending()).retainedIds).toEqual(["external-edit"]);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(externalIndex ?? index);
        },
    );

    it("keeps the independent recovery shelf when cancelled removal cleans its journal", async () => {
        const f = await fixture(async (point) => {
            if (point === "source-moved") throw new Error("cancel removal");
        });
        const saved = await f.service.shelve({
            name: "Independent recovery",
            paths: ["tracked.txt"],
            keepLocal: true,
            silent: true,
        });
        expect(saved.shelfId).toBeDefined();
        const manifest = await f.store.readCurrentShelfManifest(saved.shelfId!);
        await expect(
            f.workflow.rollback(f.selection, () => undefined, f.reverter, "cancelled"),
        ).rejects.toThrow("cancel removal");
        expect(await f.store.readJournals()).toEqual([]);
        expect(await f.store.readCurrentShelfManifest(saved.shelfId!)).toEqual(manifest);
        expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(working);
    });

    it("reports completed removal without replay after a post-commit failure", async () => {
        const f = await fixture(async (actual) => {
            if (actual === "journal-committed") throw new Error("notification failed");
        });
        await expect(
            f.workflow.rollback(f.selection, () => undefined, f.reverter, "completed"),
        ).rejects.toThrow("Do not repeat");
        expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(remaining);
        expect((await f.store.readJournals())[0].state).toBe("shelved");
    });
});

describe("selected worktree removal restart", () => {
    it.each([
        "journal-created",
        "original-durable",
        "source-moved",
        "worktree-installed",
        "base-written",
        "recovery-verified",
        "journal-committed",
    ])("recovers a real process crash at %s without changing index bytes", async (point) => {
        const f = await fixture();
        const index = await readFile(path.join(f.root, ".git/index"));
        const outcome = await new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
            stderr: string;
            pid: number;
        }>((resolve, reject) => {
            const child = spawn(
                "bun",
                [
                    "tests/integration/shelf/selectedRemovalCrashWorker.ts",
                    f.root,
                    f.storageRoot,
                    point,
                ],
                { stdio: ["ignore", "ignore", "pipe"] },
            );
            const stderr: Buffer[] = [];
            child.stderr.on("data", (b: Buffer) => stderr.push(b));
            child.once("error", reject);
            child.once("close", (code, signal) =>
                resolve({
                    code,
                    signal,
                    stderr: Buffer.concat(stderr).toString(),
                    pid: child.pid!,
                }),
            );
        });
        const verdict = describeAbruptTermination(outcome);
        expect(
            verdict.abrupt,
            `Crash worker did not die abruptly: ${verdict.reason}. stderr:\n${outcome.stderr}`,
        ).toBe(true);
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
        // Expire the locks the killed fixture process was holding, as in the existing crash suite.
        // A lock that is missing was never taken: the worker died before its checkpoint, which on
        // Windows looks exactly like the kill, so only its stderr can say why.
        const paths = await resolveShelfPaths({
            repositoryRoot: f.root,
            globalStoragePath: f.storageRoot,
        });
        const repositoryLock = path.join(f.root, ".git", "intelligit", "repo.lock");
        for (const lock of [repositoryLock, path.join(paths.root, ".store-lock", "store.lock")]) {
            let value: { pid: number; heartbeatAt: number };
            try {
                value = JSON.parse(await readFile(lock, "utf8"));
            } catch (error) {
                throw new Error(
                    `Crash worker likely exited before holding ${lock}: ${String(error)}\nstderr:\n${outcome.stderr}`,
                );
            }
            expect(value.pid, lock).toBe(outcome.pid);
            value.heartbeatAt = 0;
            await writeFile(lock, JSON.stringify(value));
        }
        const store = new ShelfStore(paths);
        const executor = new GitExecutor(f.root);
        const reverter = new ShelfReverter({
            repositoryRoot: f.root,
            gitOps: new GitOps(executor),
            gate: new RepositoryMutationGate(
                new RepositoryMutationCoordinator(),
                new RepositoryLock(),
            ),
            store,
        });
        const result = await reverter.resumePending();
        if (point === "worktree-installed") expect(result.retainedIds).toEqual(["process-crash"]);
        else expect(result.retainedIds).toEqual([]);
        expect(await readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe(
            ["worktree-installed", "journal-committed"].includes(point) ? remaining : working,
        );
        expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
    });
});
