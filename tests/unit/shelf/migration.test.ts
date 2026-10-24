import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureShelfRoot, resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStaleShelfError, ShelfStore, type ShelfStoreOptions } from "../../../src/shelf/store";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { ShelfReverter } from "../../../src/shelf/recovery";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";

const OldStore = (
    createRequire(import.meta.url)(
        "../../fixtures/shelf-v1/shelfService.cjs",
    ) as typeof import("../../../src/shelf/store")
).ShelfStore;
const directories: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

async function fixture(count = 3) {
    const directory = await mkdtemp(path.join(tmpdir(), "shelf-migration-"));
    directories.push(directory);
    const repositoryRoot = path.join(directory, "repository");
    await mkdir(repositoryRoot);
    const paths = await resolveShelfPaths({
        repositoryRoot,
        globalStoragePath: path.join(directory, "storage"),
    });
    await ensureShelfRoot(paths);
    const old = new OldStore(paths);
    for (let index = 0; index < count; index++) {
        const id = `shelf-${index}`;
        const object = await old.putObject(id, Buffer.from(`original-${index}`));
        await old.writeShelfGeneration(id, {
            schemaVersion: 1,
            objectHashes: [object.hash],
            metadata: { name: `legacy-${index}`, lifecycle: "shelved" },
            files: [],
        });
    }
    return { paths, old, repositoryRoot, store: new ShelfStore(paths) };
}

async function migrate(store: ShelfStore) {
    await store.withLock(() => store.migrateWithHeldLocks());
}

describe("all-pointer shelf migration", () => {
    it.each(["publication", "deletion"] as const)(
        "resumes useful writes after a %s catalog crash without losing the ledger",
        async (operation) => {
            const { paths, store } = await fixture(1);
            await migrate(store);
            const request = {
                token: "retained-ledger",
                operation: "fixture",
                payload: Buffer.from("same"),
            };
            await store.runIdempotent(request, async () => ({ retained: true }));
            vi.spyOn(
                store as unknown as { writeCatalog: () => Promise<void> },
                "writeCatalog",
            ).mockRejectedValueOnce(new Error("catalog crash"));
            if (operation === "publication")
                await expect(
                    store.writeShelfGeneration("published", {
                        schemaVersion: 2,
                        objectHashes: [],
                        files: [],
                        metadata: { name: "published", lifecycle: "shelved" },
                    }),
                ).rejects.toThrow("catalog crash");
            else await expect(store.deleteShelf("shelf-0")).rejects.toThrow("catalog crash");
            const restarted = new ShelfStore(paths);
            await migrate(restarted);
            await expect(
                restarted.putObject("next", Buffer.from("useful")),
            ).resolves.toHaveProperty("hash");
            expect((await restarted.listShelves()).shelfIds).toEqual(
                operation === "publication" ? ["published", "shelf-0"] : [],
            );
            await expect(
                restarted.runIdempotent(request, async () => {
                    throw new Error("ledger was lost");
                }),
            ).resolves.toEqual({ retained: true });
        },
    );

    it("validates the complete inventory once for many objects in one continuous hold", async () => {
        const { store } = await fixture(3);
        await migrate(store);
        const reads = vi.spyOn(
            store as unknown as { readManifest: (...args: unknown[]) => Promise<unknown> },
            "readManifest",
        );
        await store.withLock(async () => {
            for (let index = 0; index < 5; index++)
                await store.putObject("new", Buffer.from(`object-${index}`));
        });
        expect(
            reads,
            "three live manifests must be validated once, not once per object",
        ).toHaveBeenCalledTimes(3);
    });

    it.each(["foreign", "corrupt"] as const)(
        "revalidates %s current data on the next independent hold",
        async (kind) => {
            const { paths, store } = await fixture(1);
            await migrate(store);
            await store.withLock(() => store.putObject("new", Buffer.from("first hold")));
            if (kind === "foreign")
                await writeFile(path.join(paths.root, "shelves/shelf-0/current"), "1\n");
            else
                await writeFile(
                    path.join(paths.root, "shelves/shelf-0/gen-2/manifest.json"),
                    "corrupt current",
                );
            await expect(
                store.withLock(() => store.putObject("new", Buffer.from("second hold"))),
            ).rejects.toThrow();
        },
    );

    it.each(["publish", "delete"] as const)(
        "cached admission cannot %s a newly observed legacy source",
        async (operation) => {
            const { paths, store } = await fixture(1);
            await migrate(store);
            await store.withLock(async () => {
                await store.assertMutationReady();
                const manifest = await store.readCurrentShelfManifest("shelf-0");
                await writeFile(path.join(paths.root, "shelves/shelf-0/current"), "1\n");
                await expect(
                    operation === "publish"
                        ? store.writeShelfGeneration("shelf-0", manifest)
                        : store.deleteShelf("shelf-0"),
                ).rejects.toThrow("Foreign shelf");
                expect(
                    await readFile(path.join(paths.root, "shelves/shelf-0/current"), "utf8"),
                ).toBe("1\n");
            });
        },
    );

    it("failed validation cannot admit another mutation in the same hold", async () => {
        const { paths, store } = await fixture(1);
        await migrate(store);
        await writeFile(path.join(paths.root, "shelves/shelf-0/current"), "1\n");
        await store.withLock(async () => {
            await expect(store.putObject("new", Buffer.from("first"))).rejects.toThrow(
                "Foreign shelf",
            );
            await expect(store.putObject("new", Buffer.from("second"))).rejects.toThrow(
                "Foreign shelf",
            );
        });
    });

    it("an inherited asynchronous context loses admission when its outer hold exits", async () => {
        const { paths, store } = await fixture(1);
        await migrate(store);
        let continueChild!: () => void;
        const trigger = new Promise<void>((resolve) => {
            continueChild = resolve;
        });
        let child!: Promise<unknown>;
        await store.withLock(async () => {
            await store.putObject("new", Buffer.from("admitted"));
            child = trigger.then(async () => {
                const admission = await store.assertMutationReady().then(
                    () => "admitted",
                    (error: Error) => error.message,
                );
                expect(admission).toBe("Shelf admission requires the store lock.");
                await expect(store.putObject("new", Buffer.from("expired"))).rejects.toThrow(
                    "Foreign shelf",
                );
            });
        });
        await writeFile(path.join(paths.root, "shelves/shelf-0/current"), "1\n");
        continueChild();
        await expect(child).resolves.toBeUndefined();
    });
    it.each(["backup", "journal"] as const)(
        "partial recovery rejects corrupt migration %s before its callback",
        async (artifact) => {
            const { paths, old } = await fixture(2);
            await expect(
                migrate(
                    new ShelfStore(paths, {
                        migrationCheckpoint: async () => {
                            throw new Error("stop");
                        },
                    }),
                ),
            ).rejects.toThrow("stop");
            await old.writeJournal({
                id: "partial",
                state: "shelvePendingRevert",
                pathProgress: {},
            });
            const target = path.join(paths.root, `migration-v2-${artifact}.json`);
            await writeFile(target, "corrupt evidence");
            const store = new ShelfStore(paths);
            let called = false;
            await expect(
                store.withLock(() =>
                    store.withPendingRecovery("partial", async () => {
                        called = true;
                    }),
                ),
            ).rejects.toThrow();
            expect(called).toBe(false);
            expect(await readFile(target, "utf8")).toBe("corrupt evidence");
            expect((await old.readJournals())[0].state).toBe("shelvePendingRevert");
        },
    );

    it("recovery rejects valid migration evidence copied from another repository", async () => {
        const source = await fixture(2);
        const target = await fixture(2);
        await expect(
            migrate(
                new ShelfStore(source.paths, {
                    migrationCheckpoint: async () => {
                        throw new Error("stop");
                    },
                }),
            ),
        ).rejects.toThrow("stop");
        for (const artifact of ["backup", "journal"])
            await writeFile(
                path.join(target.paths.root, `migration-v2-${artifact}.json`),
                await readFile(path.join(source.paths.root, `migration-v2-${artifact}.json`)),
            );
        await target.old.writeJournal({
            id: "foreign",
            state: "shelvePendingRevert",
            pathProgress: {},
        });
        let called = false;
        await expect(
            target.store.withLock(() =>
                target.store.withPendingRecovery("foreign", async () => {
                    called = true;
                }),
            ),
        ).rejects.toThrow();
        expect(called).toBe(false);
    });

    it("recovery retains the journal when its admitted shelf changes before finish", async () => {
        const { paths, store, old } = await fixture(1);
        await old.writeJournal({
            id: "changed-shelf",
            state: "shelvePendingRevert",
            pathProgress: {},
            shelf: { id: "shelf-0", generation: 1 },
        });
        await store.withLock(() =>
            store.withPendingRecovery("changed-shelf", async () => {
                const manifest = await old.readCurrentShelfManifest("shelf-0");
                const changed = {
                    ...manifest,
                    metadata: { ...manifest.metadata, name: "later edit" },
                    checksum: "",
                };
                changed.checksum = createHash("sha256")
                    .update(JSON.stringify(changed))
                    .digest("hex");
                await writeFile(
                    path.join(paths.root, "shelves/shelf-0/gen-1/manifest.json"),
                    JSON.stringify(changed),
                );
                await expect(
                    store.finishPendingRecovery("changed-shelf", "rolledBack"),
                ).rejects.toThrow();
            }),
        );
        expect((await store.readJournals())[0].state).toBe("shelvePendingRevert");
    });
    it("partial migration permits exact existing journal recovery without admitting new writes", async () => {
        const { paths, old } = await fixture(2);
        const interrupted = new ShelfStore(paths, {
            migrationCheckpoint: async () => {
                throw new Error("stop");
            },
        });
        await expect(migrate(interrupted)).rejects.toThrow("stop");
        await old.writeJournal({
            id: "partial-pending",
            state: "shelvePendingRevert",
            pathProgress: {},
            shelf: { id: "shelf-1", generation: 1 },
        });
        const resumed = new ShelfStore(paths);
        await resumed.withLock(() =>
            resumed.withPendingRecovery("partial-pending", async () => {
                await resumed.finishPendingRecovery("partial-pending", "retained");
                await expect(resumed.putObject("new", Buffer.from("blocked"))).rejects.toThrow(
                    "migration must finish",
                );
            }),
        );
        expect((await resumed.readJournals())[0].state).toBe("ghost");
        await migrate(resumed);
        expect((await resumed.readCurrentManifest("shelf-1")).schemaVersion).toBe(2);
    });
    it("cancelled capture deletion refuses changed content even after a valid migration", async () => {
        const { old, store } = await fixture(1);
        const captured = await old.readCurrentManifest("shelf-0");
        await old.writeShelfGeneration("shelf-0", {
            ...captured,
            metadata: { name: "replacement", lifecycle: "shelved" },
            files: [],
        });
        await migrate(store);
        await expect(
            store.withLock(() => store.deleteRecoveredShelf("shelf-0", captured)),
        ).rejects.toThrow("recovery review");
        expect((await store.readCurrentShelfManifest("shelf-0")).metadata.name).toBe("replacement");
    });

    it("cancelled v2 capture deletion refuses a later generation", async () => {
        const { store } = await fixture(1);
        await migrate(store);
        const captured = await store.readCurrentShelfManifest("shelf-0");
        await store.writeShelfGeneration("shelf-0", captured);
        await expect(
            store.withLock(() => store.deleteRecoveredShelf("shelf-0", captured)),
        ).rejects.toThrow("recovery review");
        expect((await store.listShelves()).shelfIds).toEqual(["shelf-0"]);
    });
    it("pending recovery rejects a stale linked generation before its callback", async () => {
        const { old, store } = await fixture(1);
        await old.writeJournal({
            id: "stale",
            state: "shelvePendingRevert",
            pathProgress: {},
            shelf: { id: "shelf-0", generation: 1 },
        });
        const source = await old.readCurrentShelfManifest("shelf-0");
        await old.writeShelfGeneration("shelf-0", {
            ...source,
            metadata: { ...source.metadata, name: "intervening rename" },
        });
        let invoked = false;
        await expect(
            store.withLock(() =>
                store.withPendingRecovery("stale", async () => {
                    invoked = true;
                }),
            ),
        ).rejects.toThrow();
        expect(invoked).toBe(false);
        expect((await old.readCurrentShelfManifest("shelf-0")).metadata.name).toBe(
            "intervening rename",
        );
    });

    it("pending recovery rechecks exact journal bytes before terminalization", async () => {
        const { paths, old, store } = await fixture(1);
        const journal = { id: "changed", state: "shelvePendingRevert" as const, pathProgress: {} };
        await old.writeJournal(journal);
        await store.withLock(() =>
            store.withPendingRecovery("changed", async () => {
                await writeFile(
                    path.join(paths.root, "journals/changed.json"),
                    JSON.stringify({ ...journal, unknownEvidence: "must retain" }),
                );
                await expect(
                    store.finishPendingRecovery("changed", "rolledBack"),
                ).rejects.toThrow();
                await expect(store.putObject("new", Buffer.from("not admitted"))).rejects.toThrow();
            }),
        );
        expect(
            JSON.parse(await readFile(path.join(paths.root, "journals/changed.json"), "utf8"))
                .unknownEvidence,
        ).toBe("must retain");
    });

    it("legacy uncertain recovery retains its journal before migration without granting ordinary writes", async () => {
        const { old, store, repositoryRoot } = await fixture(1);
        await old.writeJournal({
            id: "legacy-pending",
            state: "shelvePendingRevert",
            pathProgress: {},
            expectedIndexFingerprint: "invalid",
        });
        const reverter = new ShelfReverter({
            repositoryRoot,
            store,
            gitOps: {
                getGitDirectories: async () => ({
                    gitDir: repositoryRoot,
                    commonDir: repositoryRoot,
                }),
            },
            gate: new RepositoryMutationGate(
                new RepositoryMutationCoordinator(),
                new RepositoryLock(),
            ),
        });
        await expect(reverter.resumePending()).resolves.toEqual({
            rolledBackIds: [],
            retainedIds: ["legacy-pending"],
        });
        expect((await store.readJournals())[0].state).toBe("ghost");
        await expect(store.putObject("new", Buffer.from("not admitted"))).rejects.toThrow();
        await migrate(store);
        expect((await store.readJournals())[0].state).toBe("ghost");
    });

    // Nothing ever finishes these journals, so refusing on one would refuse every later shelf write.
    it.each(["before", "after"] as const)(
        "an unshelve-pending journal left %s the upgrade stays inert and admits writes",
        async (when) => {
            const { old, store } = await fixture(1);
            const journal = {
                id: "unshelve-interrupted",
                state: "unshelvePending" as const,
                pathProgress: {},
                shelf: { id: "shelf-0", generation: 1 },
            };
            if (when === "before") await old.writeJournal(journal);
            await migrate(store);
            if (when === "after") await store.writeJournal(journal);
            // Every shelf mutation runs the upgrade first, so this is the next write's admission.
            await expect(migrate(store)).resolves.toBeUndefined();
            expect((await store.readJournals())[0].state).toBe("unshelvePending");
        },
    );
    it("migration finishes every live pointer before enabling v2 writes", async () => {
        const { paths, old, store } = await fixture();
        const original = await readFile(
            path.join(paths.root, "shelves/shelf-0/gen-1/manifest.json"),
        );
        await migrate(store);
        for (const id of ["shelf-0", "shelf-1", "shelf-2"]) {
            const manifest = await store.readCurrentShelfManifest(id);
            expect(manifest.schemaVersion, `${id} current schema`).toBe(2);
            expect(manifest.generation).toBe(2);
            await expect(old.readCurrentShelfManifest(id)).rejects.toThrow();
            expect(await store.readObject(id, manifest.objectHashes[0])).toEqual(
                Buffer.from(`original-${id.slice(-1)}`),
            );
        }
        expect(
            await readFile(path.join(paths.root, "shelves/shelf-0/gen-1/manifest.json")),
        ).toEqual(original);
        expect(
            JSON.parse(await readFile(path.join(paths.root, "catalog.json"), "utf8")).schemaVersion,
        ).toBe(2);
    });

    it.each([0, 3])(
        "a catalog generation read before migrating %i shelves still admits a write after it",
        async (count) => {
            const { store } = await fixture(count);
            const seen = (await store.listShelves()).catalogGeneration;
            await migrate(store);
            await expect(
                store.withGenerationCas(
                    { expectedCatalogGeneration: seen },
                    async () => "admitted",
                ),
            ).resolves.toBe("admitted");
            // Each promoted shelf's own generation still moves, so a stale per-shelf view is refused.
            if (count > 0)
                await expect(
                    store.withGenerationCas(
                        { shelfId: "shelf-0", expectedShelfGeneration: 1 },
                        async () => "admitted",
                    ),
                ).rejects.toThrow(ShelfStaleShelfError);
        },
    );

    it.each([
        ["keeps", "lists the same shelves out of order", ["shelf-2", "shelf-0", "shelf-1"], 0],
        ["advances", "missed a shelf", ["shelf-0", "shelf-1"], 1],
        // Same length as the real list, so only a member-by-member comparison sees the swap.
        ["advances", "swaps a shelf for one with no folder", ["shelf-0", "shelf-1", "gone"], 1],
    ])(
        "migration %s the catalog generation when the catalog %s",
        async (_verb, _case, shelves, delta) => {
            const { paths, store } = await fixture(3);
            const catalogPath = path.join(paths.root, "catalog.json");
            const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
            await writeFile(catalogPath, JSON.stringify({ ...catalog, shelves }));
            const seen = (await store.listShelves()).catalogGeneration;
            await migrate(store);
            expect((await store.listShelves()).catalogGeneration).toBe(seen + delta);
        },
    );

    it("new mutators refuse unmigrated storage before objects or callbacks", async () => {
        const { paths, store } = await fixture(0);
        await expect(store.putObject("new", Buffer.from("unsafe"))).rejects.toThrow();
        let invoked = false;
        await expect(
            store.withGenerationCas({}, async () => {
                invoked = true;
            }),
        ).rejects.toThrow();
        expect(invoked).toBe(false);
        await expect(readdir(path.join(paths.root, "shelves/new"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it.each([1, 2, 3, "catalog"])(
        "resumes interruption after %s without duplicate promotion",
        async (stop) => {
            const { paths } = await fixture();
            let promoted = 0;
            const options = {
                migrationCheckpoint: async (checkpoint: { phase: string }) => {
                    if (checkpoint.phase === "pointer") promoted++;
                    if (
                        (checkpoint.phase === "pointer" && promoted === stop) ||
                        (checkpoint.phase === "catalog" && stop === "catalog")
                    )
                        throw new Error("injected stop");
                },
            } as ShelfStoreOptions;
            await expect(migrate(new ShelfStore(paths, options))).rejects.toThrow("injected stop");
            await expect(
                new ShelfStore(paths).putObject("new", Buffer.from("unsafe")),
            ).rejects.toThrow();
            const resumed = new ShelfStore(paths);
            await migrate(resumed);
            for (const id of ["shelf-0", "shelf-1", "shelf-2"])
                expect((await resumed.readCurrentManifest(id)).generation).toBe(2);
            await migrate(resumed);
            for (const id of ["shelf-0", "shelf-1", "shelf-2"])
                expect((await resumed.readCurrentManifest(id)).generation).toBe(2);
        },
    );

    it("partial migration preserves old edits made before resume", async () => {
        const { paths, old } = await fixture();
        const interrupted = new ShelfStore(paths, {
            migrationCheckpoint: async (checkpoint: { phase: string }) => {
                if (checkpoint.phase === "pointer") throw new Error("stop");
            },
        } as ShelfStoreOptions);
        await expect(migrate(interrupted)).rejects.toThrow("stop");
        const before = await old.readCurrentShelfManifest("shelf-1");
        await old.writeShelfGeneration("shelf-1", {
            ...before,
            metadata: { ...before.metadata, name: "old intervening edit" },
        });
        await old.deleteShelf("shelf-2");
        const resumed = new ShelfStore(paths);
        await migrate(resumed);
        expect((await resumed.readCurrentShelfManifest("shelf-1")).metadata.name).toBe(
            "old intervening edit",
        );
        expect((await resumed.readCurrentShelfManifest("shelf-1")).generation).toBe(3);
        expect((await resumed.listShelves()).shelfIds).toEqual(["shelf-0", "shelf-1"]);
        await expect(
            readFile(path.join(paths.root, "shelves/shelf-2/current")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("retains foreign v1 artifacts and refuses new writes after completion", async () => {
        const { paths, old, store } = await fixture(1);
        await migrate(store);
        const foreign = await old.putObject("foreign", Buffer.from("foreign bytes"));
        await expect(
            old.writeGeneration("foreign", {
                schemaVersion: 1,
                objectHashes: [foreign.hash],
                files: [],
            }),
        ).rejects.toThrow();
        const pointer = await readFile(path.join(paths.root, "shelves/foreign/current"));
        await expect(store.putObject("new", Buffer.from("unsafe"))).rejects.toThrow();
        await expect(migrate(store)).rejects.toThrow();
        expect(await readFile(path.join(paths.root, "shelves/foreign/current"))).toEqual(pointer);
        expect(await old.readObject("foreign", foreign.hash)).toEqual(Buffer.from("foreign bytes"));
    });

    it("corrupt object stops promotion with original pointers and evidence intact", async () => {
        const { paths, old, store } = await fixture(1);
        const before = await old.readCurrentShelfManifest("shelf-0");
        const objectPath = path.join(paths.root, "shelves/shelf-0/objects", before.objectHashes[0]);
        await writeFile(objectPath, "corrupt evidence");
        await expect(migrate(store)).rejects.toThrow();
        expect(await readFile(path.join(paths.root, "shelves/shelf-0/current"), "utf8")).toBe(
            "1\n",
        );
        expect(await readFile(objectPath, "utf8")).toBe("corrupt evidence");
    });
});
