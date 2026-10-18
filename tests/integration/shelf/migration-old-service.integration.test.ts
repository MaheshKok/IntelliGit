import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShelfStore } from "../../../src/shelf/store";
import { ShelfService, type ShelfServiceOptions } from "../../../src/services/shelfService";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

type Baseline = Omit<typeof import("../../../src/services/shelfService"), "ShelfService"> & {
    ShelfService: new (options: Omit<ShelfServiceOptions, "changelists">) => ShelfService;
} & typeof import("../../../src/shelf/store") &
    typeof import("../../../src/shelf/paths") &
    typeof import("../../../src/git/executor") &
    typeof import("../../../src/git/repositoryMutationGate") &
    typeof import("../../../src/git/mutationCoordinator") &
    typeof import("../../../src/git/repositoryLock");
const old = createRequire(import.meta.url)("../../fixtures/shelf-v1/shelfService.cjs") as Baseline;
const directories: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

async function fixture(migrate = true) {
    const directory = await mkdtemp(path.join(tmpdir(), "migrated-old-service-"));
    directories.push(directory);
    const root = path.join(directory, "repository");
    await mkdir(root);
    const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = (args: string[]) =>
        execFileSync("git", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]);
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "baseline"]);
    await writeFile(path.join(root, "tracked.txt"), "base\nchange\n");
    const paths = await old.resolveShelfPaths({
        repositoryRoot: root,
        globalStoragePath: path.join(directory, "storage"),
    });
    const legacy = new old.ShelfStore(paths);
    const executor = new old.GitExecutor(root, undefined, env);
    const service = new old.ShelfService({
        repositoryRoot: root,
        store: legacy,
        executor,
        gate: new old.RepositoryMutationGate(
            new old.RepositoryMutationCoordinator(),
            new old.RepositoryLock(),
        ),
    });
    const created = await service.shelve({
        name: "legacy",
        paths: ["tracked.txt"],
        silent: true,
        keepLocal: true,
    });
    expect(created.status).toBe("ok");
    const id = created.shelfId!;
    const before = await legacy.readCurrentShelfManifest(id);
    const store = new ShelfStore(paths);
    if (migrate) await store.withLock(() => store.migrateWithHeldLocks());
    return { paths, store, legacy, service, executor, root, id, before };
}

async function currentService() {
    const fixtureData = await fixture(false);
    const { root, store } = fixtureData;
    const changelists = new ChangelistStore();
    await changelists.connect(root, path.join(root, ".git"));
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const currentExecutor = new GitExecutor(root);
    const service = new ShelfService({
        repositoryRoot: root,
        store,
        executor: currentExecutor,
        gate,
        changelists,
    });
    return { ...fixtureData, service, gate, changelists, currentExecutor };
}

describe("migration service admission", () => {
    it.each([
        ["local", false],
        ["local", true],
        ["durable", false],
        ["durable", true],
        ["native", true],
        ["pending", true],
    ] as const)(
        "%s contention preserves persisted reads with history=%s",
        async (contention, history) => {
            const { service, changelists, store, root, paths, id, currentExecutor } =
                await currentService();
            await store.withLock(() => store.migrateWithHeldLocks());
            const initial = await store.readCurrentShelfManifest(id);
            await store.writeShelfGeneration(id, {
                ...initial,
                files: initial.files.map((entry) => ({
                    ...entry,
                    baseAvailability: history ? "history" : "none",
                })),
            });
            const persisted = await store.readCurrentShelfManifest(id);
            const pointer = await readFile(path.join(paths.root, "shelves", id, "current"));
            let release: (() => Promise<void>) | undefined;
            if (contention === "local")
                release = (await changelists.acquireTargetOperationLease(root)).release;
            if (contention === "durable") {
                const other = new ChangelistStore();
                await other.connect(root, path.join(root, ".git"));
                release = (await other.acquireTargetOperationLease(root)).release;
            }
            if (contention === "native")
                await writeFile(path.join(root, ".git/MERGE_HEAD"), "a".repeat(40));
            if (contention === "pending") {
                const state = changelists.get(root);
                vi.spyOn(changelists, "get").mockReturnValue({
                    ...state,
                    pendingTargetOperation: {},
                } as typeof state);
            }
            const acquire = vi.spyOn(changelists, "acquireTargetOperationLease");
            const binary = vi.spyOn(currentExecutor, "runBinary");
            try {
                await expect(service.getShelfFiles(id)).resolves.toEqual(persisted.files);
                if (!history) expect(acquire).not.toHaveBeenCalled();
                if (!history) expect(binary).not.toHaveBeenCalled();
                expect(binary.mock.calls.every(([args]) => args[0] === "rev-parse")).toBe(true);
                expect(await readFile(path.join(paths.root, "shelves", id, "current"))).toEqual(
                    pointer,
                );
                expect(await store.readJournals()).toEqual([]);
            } finally {
                await release?.();
            }
        },
    );

    it("optional history refresh never hides an inventory IO failure", async () => {
        const { service, store, id } = await currentService();
        await store.withLock(() => store.migrateWithHeldLocks());
        const manifest = await store.readCurrentShelfManifest(id);
        await store.writeShelfGeneration(id, {
            ...manifest,
            files: manifest.files.map((entry) => ({ ...entry, baseAvailability: "history" })),
        });
        vi.spyOn(store, "assertMutationReady").mockRejectedValue(new Error("inventory IO failure"));
        await expect(service.getShelfFiles(id)).rejects.toThrow("inventory IO failure");
    });

    it("read contention never hides corrupt persisted content", async () => {
        const { service, changelists, store, root, paths, id } = await currentService();
        await store.withLock(() => store.migrateWithHeldLocks());
        const manifest = await store.readCurrentManifest(id);
        await writeFile(
            path.join(paths.root, "shelves", id, `gen-${manifest.generation}`, "manifest.json"),
            "corrupt",
        );
        const lease = await changelists.acquireTargetOperationLease(root);
        try {
            await expect(service.getShelfFiles(id)).rejects.toThrow();
        } finally {
            await lease.release();
        }
    });
    it.each(["legacy", "native", "pending"] as const)(
        "%s reads keep persisted content without migration or mutation",
        async (state) => {
            const { service, changelists, legacy, store, root, paths, id, currentExecutor } =
                await currentService();
            if (state !== "legacy") await store.withLock(() => store.migrateWithHeldLocks());
            const manifest = await store.readCurrentShelfManifest(id);
            const pointer = await readFile(path.join(paths.root, "shelves", id, "current"));
            const index = await readFile(path.join(root, ".git/index"));
            const worktree = await readFile(path.join(root, "tracked.txt"));
            const run = vi.spyOn(currentExecutor, "run");
            const binary = vi.spyOn(currentExecutor, "runBinary");
            if (state === "native")
                await writeFile(path.join(root, ".git/MERGE_HEAD"), "a".repeat(40));
            if (state === "pending") {
                const current = changelists.get(root);
                vi.spyOn(changelists, "get").mockReturnValue({
                    ...current,
                    pendingTargetOperation: {},
                } as typeof current);
            }
            expect((await service.listShelves()).shelves[0].metadata).toEqual(manifest.metadata);
            expect(await service.getShelfFiles(id)).toEqual(manifest.files);
            expect(await readFile(path.join(paths.root, "shelves", id, "current"))).toEqual(
                pointer,
            );
            expect(await store.readJournals()).toEqual([]);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(await readFile(path.join(root, "tracked.txt"))).toEqual(worktree);
            expect(
                [...run.mock.calls, ...binary.mock.calls].every(([args]) =>
                    ["rev-parse", "show"].includes(args[0]),
                ),
            ).toBe(true);
            if (state === "legacy")
                expect((await legacy.readCurrentManifest(id)).schemaVersion).toBe(1);
        },
    );

    it("a rejected queued mutation does not prevent the next mutation", async () => {
        const { service, store, id } = await currentService();
        const results = await Promise.allSettled([
            service.renameShelf({ id: "missing", name: "failure" }),
            service.renameShelf({ id, name: "after failure" }),
        ]);
        expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
        expect((await store.readCurrentShelfManifest(id)).metadata.name).toBe("after failure");
    });
    it("holds actual metadata before repository and shelf locks through migration and rename", async () => {
        const { service, changelists, gate, store, id } = await currentService();
        const order: string[] = [];
        const acquirePersistence = ChangelistPersistence.prototype.acquire;
        vi.spyOn(ChangelistPersistence.prototype, "acquire").mockImplementation(async function (
            this: ChangelistPersistence,
        ) {
            const release = await acquirePersistence.call(this);
            return async () => {
                order.push("release");
                await release();
            };
        });
        const acquire = changelists.acquireTargetOperationLease.bind(changelists);
        vi.spyOn(changelists, "acquireTargetOperationLease").mockImplementation(async (root) => {
            const lease = await acquire(root);
            order.push("metadata");
            return lease;
        });
        const run = gate.run.bind(gate);
        vi.spyOn(gate, "run").mockImplementation(async (root, common, operation) => {
            order.push("repository");
            return run(root, common, operation);
        });
        const lock = store.withLock.bind(store);
        vi.spyOn(store, "withLock").mockImplementation(async (operation) => {
            order.push("shelf");
            return lock(operation);
        });
        await service.renameShelf({ id, name: "new client rename" });
        expect(order.slice(0, 3)).toEqual(["metadata", "repository", "shelf"]);
        expect(order.at(-1)).toBe("release");
        expect((await store.readCurrentShelfManifest(id)).metadata.name).toBe("new client rename");
        expect((await store.readCurrentManifest(id)).schemaVersion).toBe(2);
    });

    it("refuses native operations before migration publishes any pointer", async () => {
        const { service, root, store, id, before } = await currentService();
        await writeFile(path.join(root, ".git/MERGE_HEAD"), "a".repeat(40));
        await expect(service.renameShelf({ id, name: "blocked" })).rejects.toThrow(
            "Native Git operation",
        );
        expect(await store.readCurrentManifest(id)).toEqual(before);
    });

    it("rejects pending target metadata before entering the repository gate", async () => {
        const { service, changelists, gate, store, root, id, before } = await currentService();
        const state = changelists.get(root);
        // Only the durable pending-state read is controlled; lease acquisition and release are real.
        vi.spyOn(changelists, "get").mockReturnValue({
            ...state,
            pendingTargetOperation: {},
        } as typeof state);
        const run = vi.spyOn(gate, "run");
        await expect(service.renameShelf({ id, name: "blocked" })).rejects.toThrow(
            "Pending target operation",
        );
        expect(run).not.toHaveBeenCalled();
        expect(await store.readCurrentManifest(id)).toEqual(before);
    });

    it("recovers a valid legacy journal and deletes only its unchanged migration successor", async () => {
        const { service, root, legacy, store, id } = await currentService();
        const executor = new GitExecutor(root);
        const listing = await executor.runBinary(["ls-files", "--stage", "-v", "-z"]);
        const { createHash } = await import("node:crypto");
        await legacy.writeJournal({
            id: "pending",
            state: "shelvePendingRevert",
            pathProgress: {},
            expectedIndexFingerprint: createHash("sha256").update(listing.stdout).digest("hex"),
            shelf: { id, generation: 1 },
        });
        await expect(service.resumePendingRecovery()).resolves.toEqual({
            rolledBackIds: ["pending"],
            retainedIds: [],
        });
        expect((await store.listShelves()).shelfIds).toEqual([]);
        expect(await store.readJournals()).toEqual([]);
    });
});

describe("migration against exact shipped old service", () => {
    it.each(["rename", "restore", "delete"] as const)(
        "old cached %s cannot replace migrated pointer or mutate Git",
        async (operation) => {
            const { paths, store, service, executor, root, id, before } = await fixture();
            const pointer = await readFile(path.join(paths.root, "shelves", id, "current"));
            const manifest = await store.readCurrentShelfManifest(id);
            const index = await readFile(path.join(root, ".git/index"));
            const worktree = await readFile(path.join(root, "tracked.txt"));
            const run = vi.spyOn(executor, "run");
            const binary = vi.spyOn(executor, "runBinary");
            const expectedShelfGeneration = before.generation;
            if (operation === "rename")
                await expect(
                    service.renameShelf({ id, expectedShelfGeneration, name: "unsafe" }),
                ).rejects.toThrow();
            if (operation === "restore")
                await expect(
                    service.unshelve({
                        id,
                        expectedShelfGeneration,
                        removeFromShelf: true,
                        mode: "flattened",
                    }),
                ).rejects.toThrow();
            if (operation === "delete")
                await expect(
                    service.deleteShelf({ id, expectedShelfGeneration }),
                ).rejects.toThrow();
            expect(await readFile(path.join(paths.root, "shelves", id, "current"))).toEqual(
                pointer,
            );
            expect((await store.readCurrentManifest(id)).checksum).toBe(manifest.checksum);
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(await readFile(path.join(root, "tracked.txt"))).toEqual(worktree);
            expect(
                [...run.mock.calls, ...binary.mock.calls].every(
                    ([args]) => args[0] === "rev-parse",
                ),
            ).toBe(true);
        },
    );

    it.each(["rename", "restore", "delete"] as const)(
        "old fresh %s refuses promoted legacy and provenance shelves before Git",
        async (operation) => {
            const { paths, store, service, executor, root, id } = await fixture();
            const source = await store.readCurrentShelfManifest(id);
            for (const hash of source.objectHashes)
                await store.putObject("provenance", await store.readObject(id, hash));
            await store.writeShelfGeneration("provenance", {
                ...source,
                metadata: {
                    ...source.metadata,
                    selection: {
                        version: 1,
                        scope: "files",
                        sourceLists: [
                            {
                                id: "default",
                                name: "來源",
                                description: "original",
                                draft: "keep draft\n",
                            },
                        ],
                        entries: source.files.map((file) => ({
                            changeId: file.changeId,
                            sourceListIds: ["default"],
                        })),
                    },
                },
            });
            const index = await readFile(path.join(root, ".git/index"));
            const worktree = await readFile(path.join(root, "tracked.txt"));
            const run = vi.spyOn(executor, "run");
            const binary = vi.spyOn(executor, "runBinary");
            for (const shelfId of [id, "provenance"]) {
                const pointer = await readFile(
                    path.join(paths.root, "shelves", shelfId, "current"),
                );
                const manifest = await store.readCurrentShelfManifest(shelfId);
                if (operation === "rename")
                    await expect(
                        service.renameShelf({ id: shelfId, name: "unsafe" }),
                    ).rejects.toThrow();
                if (operation === "restore")
                    await expect(
                        service.unshelve({ id: shelfId, removeFromShelf: true, mode: "flattened" }),
                    ).rejects.toThrow();
                if (operation === "delete")
                    await expect(service.deleteShelf({ id: shelfId })).rejects.toThrow();
                expect(
                    await readFile(path.join(paths.root, "shelves", shelfId, "current")),
                ).toEqual(pointer);
                expect((await store.readCurrentShelfManifest(shelfId)).checksum).toBe(
                    manifest.checksum,
                );
            }
            expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
            expect(await readFile(path.join(root, "tracked.txt"))).toEqual(worktree);
            expect(
                [...run.mock.calls, ...binary.mock.calls].every(
                    ([args]) => args[0] === "rev-parse",
                ),
            ).toBe(true);
        },
    );

    it("old new-ID capture fails before removal and retains foreign recovery data", async () => {
        const { paths, store, service, root } = await fixture();
        const index = await readFile(path.join(root, ".git/index"));
        const worktree = await readFile(path.join(root, "tracked.txt"));
        await expect(
            service.shelve({
                name: "foreign",
                paths: ["tracked.txt"],
                silent: true,
                keepLocal: false,
            }),
        ).rejects.toThrow("Invalid shelf catalog.");
        expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
        expect(await readFile(path.join(root, "tracked.txt"))).toEqual(worktree);
        const listed = await store.listShelves();
        expect(listed.corruptShelfIds).toHaveLength(1);
        const foreignId = listed.corruptShelfIds[0];
        const pointer = await readFile(path.join(paths.root, "shelves", foreignId, "current"));
        await expect(store.withLock(() => store.migrateWithHeldLocks())).rejects.toThrow();
        expect(await readFile(path.join(paths.root, "shelves", foreignId, "current"))).toEqual(
            pointer,
        );
    });
});
