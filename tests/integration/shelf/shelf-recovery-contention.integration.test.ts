import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeAbruptTermination } from "../../helpers/abruptTermination";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfReverter, ShelfRecoveryFullError } from "../../../src/shelf/recovery";
import { ShelfStaleCatalogError } from "../../../src/shelf/store";
import { ShelfService } from "../../../src/services/shelfService";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import {
    cleanTemporaryRepositories,
    createLinkedWorktree,
    createSecondService,
    createShelfFixture,
    fileBytes,
    git,
    gitDirectory,
    indexSnapshot,
} from "./shelfTestHarness";

afterEach(cleanTemporaryRepositories);

function runCrashWorker(
    repositoryRoot: string,
    storageRoot: string,
): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const worker = spawn(
            "bun",
            [
                "tests/integration/shelf/shelfCrashWorker.ts",
                repositoryRoot,
                storageRoot,
                "source-moved",
            ],
            { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
        );
        const stderr: Buffer[] = [];
        worker.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        worker.once("error", reject);
        worker.once("close", (code, signal) =>
            resolve({ code, signal, stderr: Buffer.concat(stderr).toString("utf8") }),
        );
    });
}

/**
 * Fails unless the crash worker died without running cleanup, in whatever way this platform says
 * that. The stderr the worker produced is folded into the message because the usual cause of a
 * surprise here is the worker throwing before it reached its checkpoint.
 */
function expectAbruptTermination(outcome: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
}): void {
    const verdict = describeAbruptTermination(outcome);
    expect(
        verdict.abrupt,
        `Crash worker did not die abruptly: ${verdict.reason}. stderr:\n${outcome.stderr}`,
    ).toBe(true);
}

async function expireCrashLocks(repositoryRoot: string, storageRoot: string): Promise<void> {
    const commonDir = path.resolve(
        repositoryRoot,
        (await git(repositoryRoot, ["rev-parse", "--git-common-dir"])).toString("utf8").trim(),
    );
    const shelfPaths = await resolveShelfPaths({ repositoryRoot, globalStoragePath: storageRoot });
    for (const lockPath of [
        path.join(commonDir, "intelligit", "repo.lock"),
        path.join(shelfPaths.root, ".store-lock", "store.lock"),
    ]) {
        let serializedOwner: string;
        try {
            serializedOwner = await readFile(lockPath, "utf8");
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error(
                    `Crash worker likely exited before holding expected lock: ${lockPath}`,
                );
            }
            throw error;
        }
        const owner = JSON.parse(serializedOwner) as Record<string, unknown>;
        await writeFile(lockPath, JSON.stringify({ ...owner, heartbeatAt: 0 }));
    }
}

describe("ShelfService recovery and real lock contention", () => {
    it("rolls back a shelf left mid-revert by a killed process and removes its cancelled shelf", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "shelved bytes\n");
        const beforeIndex = await indexSnapshot(fixture.root);

        const outcome = await runCrashWorker(fixture.root, fixture.storageRoot);
        expectAbruptTermination(outcome);
        await expireCrashLocks(fixture.root, fixture.storageRoot);
        const restarted = await createSecondService(fixture.root, fixture.storageRoot);
        await expect(restarted.service.resumePendingRecovery()).resolves.toMatchObject({
            rolledBackIds: [expect.any(String)],
            retainedIds: [],
        });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(
            Buffer.from("shelved bytes\n"),
        );
        expect(await indexSnapshot(fixture.root)).toEqual(beforeIndex);
        await expect(restarted.service.listShelves()).resolves.toMatchObject({ shelves: [] });
    });

    it("retains a third-party change rather than overwriting it during restart rollback", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "shelved bytes\n");
        const outcome = await runCrashWorker(fixture.root, fixture.storageRoot);
        expectAbruptTermination(outcome);
        await expireCrashLocks(fixture.root, fixture.storageRoot);
        await writeFile(path.join(fixture.root, "tracked.txt"), "third party bytes\n");

        const restarted = await createSecondService(fixture.root, fixture.storageRoot);
        await expect(restarted.service.resumePendingRecovery()).resolves.toMatchObject({
            rolledBackIds: [],
            retainedIds: [expect.any(String)],
        });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(
            Buffer.from("third party bytes\n"),
        );
        await expect(restarted.store.readJournals()).resolves.toMatchObject([{ state: "ghost" }]);
    });

    it("refuses a recovery-full destructive shelf before changing tree or index", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "pending\n");
        const beforeTree = await fileBytes(fixture.root, "tracked.txt");
        const beforeIndex = await indexSnapshot(fixture.root);
        const executor = new GitExecutor(fixture.root);
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
        );
        const reverter = new ShelfReverter({
            repositoryRoot: fixture.root,
            gitOps: new GitOps(executor),
            gate,
            store: fixture.store,
            capacityAvailable: async () => false,
        });
        const service = new ShelfService({
            repositoryRoot: fixture.root,
            executor,
            store: fixture.store,
            gate,
            reverter,
        });

        await expect(
            service.shelve({
                name: "full",
                paths: ["tracked.txt"],
                silent: true,
                keepLocal: false,
            }),
        ).rejects.toBeInstanceOf(ShelfRecoveryFullError);
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(beforeTree);
        expect(await indexSnapshot(fixture.root)).toEqual(beforeIndex);
    });

    it("treats an unshelve-pending journal as inert on restart while preserving its shelf", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "shelved\n");
        const shelf = await fixture.service.shelve({
            name: "pending unshelve",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        await fixture.store.writeJournal({
            id: "integration-unshelve-pending",
            state: "unshelvePending",
            pathProgress: { "tracked.txt": "applied" },
            shelf: { id: shelf.shelfId!, generation: shelf.newGeneration! },
        });

        const restarted = await createSecondService(fixture.root, fixture.storageRoot);
        await expect(restarted.service.resumePendingRecovery()).resolves.toEqual({
            rolledBackIds: [],
            retainedIds: [],
        });
        await expect(restarted.service.listShelves()).resolves.toMatchObject({
            shelves: [{ id: shelf.shelfId!, metadata: { lifecycle: "shelved" } }],
        });
        await expect(
            restarted.store.readJournal("integration-unshelve-pending"),
        ).resolves.toMatchObject({
            state: "unshelvePending",
        });
    });

    it("refuses stale conflict override when recovery parking cannot be created", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "one\nbase\nthree\n");
        await git(fixture.root, ["add", "tracked.txt"]);
        await git(fixture.root, ["commit", "-m", "conflict base"]);
        await writeFile(path.join(fixture.root, "tracked.txt"), "one\nshelved\nthree\n");
        const shelf = await fixture.service.shelve({
            name: "park refusal",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        await writeFile(path.join(fixture.root, "tracked.txt"), "one\nlocal\nthree\n");
        await fixture.service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: false,
            mode: "flattened",
        });
        const [entry] = await fixture.service.getShelfFiles(shelf.shelfId!);
        const session = await fixture.service.openShelfConflictSession(
            shelf.shelfId!,
            entry!.changeId,
        );
        await writeFile(path.join(fixture.root, "tracked.txt"), "one\nfresh local\nthree\n");
        const recoveryRoot = path.join(await gitDirectory(fixture.root), "intelligit", "recovery");
        await rm(recoveryRoot, { recursive: true, force: true });
        await writeFile(recoveryRoot, "not a directory");

        await expect(
            fixture.service.applyShelfConflictResolution({
                id: shelf.shelfId!,
                changeId: entry!.changeId,
                content: "one\nresolution\nthree\n",
                expectedShelfGeneration: session.shelfGeneration,
                expectedPathFingerprint: session.worktreeFingerprint,
                staleOverride: true,
            }),
        ).resolves.toMatchObject({ status: "refused" });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(
            Buffer.from("one\nfresh local\nthree\n"),
        );
    });

    it("serializes independent services and rejects a stale catalog generation without store corruption", async () => {
        const fixture = await createShelfFixture();
        const second = await createSecondService(fixture.root, fixture.storageRoot);
        await writeFile(path.join(fixture.root, "tracked.txt"), "first\n");
        const createA = fixture.service.shelve({
            name: "window A",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });
        const createB = second.service.shelve({
            name: "window B",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });
        await expect(Promise.all([createA, createB])).resolves.toHaveLength(2);
        const listed = await fixture.service.listShelves();
        expect(listed.shelves).toHaveLength(2);

        await expect(
            fixture.service.shelve({
                name: "stale window",
                paths: ["tracked.txt"],
                silent: true,
                keepLocal: true,
                expectedCatalogGeneration: 0,
            }),
        ).rejects.toBeInstanceOf(ShelfStaleCatalogError);
        expect((await fixture.service.listShelves()).shelves).toHaveLength(2);

        const linkedRoot = await createLinkedWorktree(fixture.root);
        const linked = await createSecondService(linkedRoot, fixture.storageRoot);
        await writeFile(path.join(linkedRoot, "tracked.txt"), "linked\n");
        await expect(
            Promise.all([
                fixture.service.shelve({
                    name: "main mutation",
                    paths: ["tracked.txt"],
                    silent: true,
                    keepLocal: true,
                }),
                linked.service.shelve({
                    name: "linked mutation",
                    paths: ["tracked.txt"],
                    silent: true,
                    keepLocal: true,
                }),
            ]),
        ).resolves.toHaveLength(2);
        expect((await fixture.service.listShelves()).shelves).toHaveLength(3);
        expect((await linked.service.listShelves()).shelves).toHaveLength(1);
    });
});
