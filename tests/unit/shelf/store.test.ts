import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureShelfRoot, resolveShelfPaths, ShelfPathError } from "../../../src/shelf/paths";
import {
    ShelfStaleCatalogError,
    ShelfStaleShelfError,
    ShelfStore,
    ShelfStoreCorruptionError,
} from "../../../src/shelf/store";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function makeStore() {
    const temporary = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-store-"));
    directories.push(temporary);
    const repositoryRoot = path.join(temporary, "repository");
    await mkdir(repositoryRoot);
    const paths = await resolveShelfPaths({
        repositoryRoot,
        globalStoragePath: path.join(temporary, "storage"),
    });
    await ensureShelfRoot(paths);
    return { paths, store: new ShelfStore(paths) };
}

function persistedShelfInput() {
    const patch = "a".repeat(64);
    const base = "b".repeat(64);
    const rawBefore = "c".repeat(64);
    const rawAfter = "d".repeat(64);
    return {
        schemaVersion: 1,
        objectHashes: [patch, base, rawBefore, rawAfter],
        metadata: {
            name: "Keep current work",
            baseCommit: "e".repeat(40),
            lifecycle: "shelved" as const,
        },
        files: [
            {
                changeId: "src-app",
                indexBlock: {
                    path: "src/app.ts",
                    status: "M" as const,
                    patchObjectHash: patch,
                    baseObjectHash: base,
                },
                worktreeBlock: {
                    path: "src/app.ts",
                    status: "M" as const,
                    patchObjectHash: patch,
                    baseObjectHash: base,
                    rawBeforeObjectHash: rawBefore,
                    rawAfterObjectHash: rawAfter,
                },
                binary: false,
                untracked: false,
                baseAvailability: "full" as const,
                exactReconstruction: false,
                lifecycle: "shelved" as const,
            },
        ],
    };
}

function resealManifest(manifest: { checksum: string }): void {
    manifest.checksum = createHash("sha256")
        .update(JSON.stringify({ ...manifest, checksum: "" }))
        .digest("hex");
}

describe("ShelfStore", () => {
    it("deduplicates immutable content-addressed objects and commits an atomic current generation", async () => {
        const { store } = await makeStore();
        const first = await store.putObject("shelf-one", Buffer.from("payload"));
        const duplicate = await store.putObject("shelf-one", Buffer.from("payload"));

        expect(duplicate).toEqual(first);
        await store.writeGeneration("shelf-one", {
            schemaVersion: 1,
            objectHashes: [first.hash],
            files: [],
        });
        const current = await store.readCurrentManifest("shelf-one");

        expect(current.generation).toBe(1);
        expect(current.objectHashes).toEqual([first.hash]);
        expect(await store.readObject("shelf-one", first.hash)).toEqual(Buffer.from("payload"));
    });

    it("refuses object writes through a shelf-internal symlinked parent", async () => {
        const { paths, store } = await makeStore();
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-outside-"));
        directories.push(outside);
        const objects = path.join(paths.root, "shelves", "shelf-one", "objects");
        await mkdir(path.dirname(objects), { recursive: true });
        await symlink(outside, objects);

        await expect(store.putObject("shelf-one", Buffer.from("payload"))).rejects.toBeInstanceOf(
            ShelfPathError,
        );
        expect(await readdir(outside)).toEqual([]);
    });

    it("refuses symlinked generation, journal, catalog, and garbage paths", async () => {
        const generation = await makeStore();
        const generationOutside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-outside-"));
        directories.push(generationOutside);
        const shelf = path.join(generation.paths.root, "shelves", "shelf-one");
        await mkdir(path.dirname(shelf), { recursive: true });
        await symlink(generationOutside, shelf);
        await expect(
            generation.store.writeGeneration("shelf-one", {
                schemaVersion: 1,
                objectHashes: [],
                files: [],
            }),
        ).rejects.toBeInstanceOf(ShelfPathError);

        const journal = await makeStore();
        const journalOutside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-outside-"));
        directories.push(journalOutside);
        await symlink(journalOutside, path.join(journal.paths.root, "journals"));
        await expect(
            journal.store.writeJournal({
                id: "tx",
                state: "shelvePendingRevert",
                pathProgress: {},
            }),
        ).rejects.toBeInstanceOf(ShelfPathError);

        const catalog = await makeStore();
        const catalogOutside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-outside-"));
        directories.push(catalogOutside);
        await symlink(
            path.join(catalogOutside, "catalog.json"),
            path.join(catalog.paths.root, "catalog.json"),
        );
        await expect(
            catalog.store.runIdempotent(
                { token: "catalog", operation: "create", payload: Buffer.from("payload") },
                async () => ({ ok: true }),
            ),
        ).rejects.toBeInstanceOf(ShelfPathError);

        const garbage = await makeStore();
        const live = await garbage.store.putObject("shelf-one", Buffer.from("live"));
        await garbage.store.writeGeneration("shelf-one", {
            schemaVersion: 1,
            objectHashes: [live.hash],
            files: [],
        });
        const garbageOutside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-outside-"));
        directories.push(garbageOutside);
        const objects = path.join(garbage.paths.root, "shelves", "shelf-one", "objects");
        await rm(objects, { recursive: true, force: true });
        await symlink(garbageOutside, objects);
        await expect(garbage.store.collectGarbage("shelf-one")).rejects.toBeInstanceOf(
            ShelfPathError,
        );

        await expect(
            Promise.all([
                readdir(generationOutside),
                readdir(journalOutside),
                readdir(garbageOutside),
            ]),
        ).resolves.toEqual([[], [], []]);
    });

    it("keeps the previous current pointer if a later pointer replacement faults", async () => {
        const { paths, store } = await makeStore();
        const object = await store.putObject("shelf-one", Buffer.from("payload"));
        await store.writeGeneration("shelf-one", {
            schemaVersion: 1,
            objectHashes: [object.hash],
            files: [],
        });
        const failing = new ShelfStore(paths, {
            beforeCurrentPointerRename: async () => {
                throw new Error("simulated crash");
            },
        });

        await expect(
            failing.writeGeneration("shelf-one", {
                schemaVersion: 1,
                objectHashes: [object.hash],
                files: [],
            }),
        ).rejects.toThrow("simulated crash");

        expect((await store.readCurrentManifest("shelf-one")).generation).toBe(1);
    });

    it("never overwrites an orphaned immutable generation after a pointer crash", async () => {
        const { paths, store } = await makeStore();
        await store.writeGeneration("shelf-one", {
            schemaVersion: 1,
            objectHashes: [],
            files: ["first"],
        });
        const failing = new ShelfStore(paths, {
            beforeCurrentPointerRename: async () => {
                throw new Error("simulated pointer crash");
            },
        });

        await expect(
            failing.writeGeneration("shelf-one", {
                schemaVersion: 1,
                objectHashes: [],
                files: ["orphaned"],
            }),
        ).rejects.toThrow("simulated pointer crash");
        const orphaned = await readFile(
            path.join(paths.root, "shelves", "shelf-one", "gen-2", "manifest.json"),
        );

        const retry = await store.writeGeneration("shelf-one", {
            schemaVersion: 1,
            objectHashes: [],
            files: ["retry"],
        });

        expect(retry.generation).toBe(3);
        expect(
            await readFile(path.join(paths.root, "shelves", "shelf-one", "gen-2", "manifest.json")),
        ).toEqual(orphaned);
        expect((await store.readCurrentManifest("shelf-one")).files).toEqual(["retry"]);
    });

    it("rethrows a non-ENOENT current-pointer read failure instead of overwriting generation one", async () => {
        const { paths, store } = await makeStore();
        await mkdir(path.join(paths.root, "shelves", "shelf-one", "current"), { recursive: true });

        await expect(
            store.writeGeneration("shelf-one", { schemaVersion: 1, objectHashes: [], files: [] }),
        ).rejects.toMatchObject({ code: "EISDIR" });
        await expect(
            readFile(path.join(paths.root, "shelves", "shelf-one", "gen-1", "manifest.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a current pointer whose immutable manifest is missing", async () => {
        const { paths, store } = await makeStore();
        const shelfDirectory = path.join(paths.root, "shelves", "shelf-one");
        await mkdir(shelfDirectory, { recursive: true });
        await writeFile(path.join(shelfDirectory, "current"), "1\n");

        await expect(
            store.writeGeneration("shelf-one", { schemaVersion: 1, objectHashes: [], files: [] }),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            readFile(path.join(shelfDirectory, "gen-2", "manifest.json")),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("replays a durable idempotency result, preserves a created shelf, and rejects a conflicting token payload", async () => {
        const { paths, store } = await makeStore();
        let operations = 0;
        const request = {
            token: "request-token",
            operation: "create",
            payload: Buffer.from("same request"),
        };

        const first = await store.runIdempotent(request, async () => {
            operations += 1;
            const object = await store.putObject("shelf-one", Buffer.from("payload"));
            await store.writeGeneration("shelf-one", {
                schemaVersion: 1,
                objectHashes: [object.hash],
                files: [],
            });
            return { shelfId: "shelf-one" };
        });
        const replay = await store.runIdempotent(request, async () => {
            operations += 1;
            return { shelfId: "different" };
        });

        expect(first).toEqual({ shelfId: "shelf-one" });
        expect(replay).toEqual(first);
        expect(operations).toBe(1);
        expect(
            JSON.parse(await readFile(path.join(paths.root, "catalog.json"), "utf8")) as {
                readonly shelves: readonly string[];
            },
        ).toMatchObject({ shelves: ["shelf-one"] });
        await expect(
            store.runIdempotent(
                { ...request, payload: Buffer.from("different request") },
                async () => ({ shelfId: "shelf-one" }),
            ),
        ).rejects.toThrow("already used");
    });

    it("surfaces corrupt manifests and collects only unreachable objects", async () => {
        const { paths, store } = await makeStore();
        const live = await store.putObject("shelf-one", Buffer.from("live"));
        const dead = await store.putObject("shelf-one", Buffer.from("dead"));
        await store.writeGeneration("shelf-one", {
            schemaVersion: 1,
            objectHashes: [live.hash],
            files: [],
        });
        const broken = path.join(paths.root, "shelves", "broken");
        await mkdir(path.join(broken, "gen-1"), { recursive: true });
        await writeFile(path.join(broken, "current"), "1\n");
        await writeFile(path.join(broken, "gen-1", "manifest.json"), "{not json");

        const listed = await store.listShelves();
        const removed = await store.collectGarbage("shelf-one");

        expect(listed.corruptShelfIds).toContain("broken");
        expect(removed).toEqual([dead.hash]);
        await expect(store.readObject("shelf-one", dead.hash)).rejects.toThrow();
        expect(await store.readObject("shelf-one", live.hash)).toEqual(Buffer.from("live"));
    });

    it("serializes store mutations and records all Phase-1 journal transition states", async () => {
        const { paths, store } = await makeStore();
        const second = new ShelfStore(paths);
        await store.withLock(async () => {
            await expect(second.withLock(async () => undefined)).rejects.toThrow(
                "already in progress",
            );
        });

        await store.writeJournal({ id: "tx-1", state: "shelvePendingRevert", pathProgress: {} });
        await store.writeJournal({ id: "tx-2", state: "unshelvePending", pathProgress: {} });
        await store.transitionJournal("tx-2", "applied");
        await store.writeJournal({ id: "tx-3", state: "ghost", pathProgress: {} });

        expect(await store.readJournals()).toEqual([
            { id: "tx-1", state: "shelvePendingRevert", pathProgress: {} },
            { id: "tx-2", state: "applied", pathProgress: {} },
            { id: "tx-3", state: "ghost", pathProgress: {} },
        ]);
    });

    it("round-trips a validated persisted shelf contract with metadata and per-layer artifacts", async () => {
        const { store } = await makeStore();
        const input = persistedShelfInput();

        await store.writeShelfGeneration("shelf-one", input);

        await expect(store.readCurrentShelfManifest("shelf-one")).resolves.toMatchObject({
            generation: 1,
            metadata: input.metadata,
            files: input.files,
        });
    });

    it("rejects malformed persisted shelf metadata and untrusted manifest paths on reread", async () => {
        const { paths, store } = await makeStore();
        const input = persistedShelfInput();
        await store.writeShelfGeneration("shelf-one", input);
        const manifestPath = path.join(
            paths.root,
            "shelves",
            "shelf-one",
            "gen-1",
            "manifest.json",
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
            metadata: { name: string; baseCommit: string; lifecycle: string };
            files: Array<{ indexBlock: { path: string } }>;
            checksum: string;
        };
        manifest.metadata.name = "";
        resealManifest(manifest);
        await writeFile(manifestPath, JSON.stringify(manifest));

        await expect(store.readCurrentShelfManifest("shelf-one")).rejects.toBeInstanceOf(
            ShelfStoreCorruptionError,
        );

        for (const [shelfId, unsafePath] of [
            ["shelf-two", "../escape"],
            ["shelf-three", "tracked.txt:stream"],
            ["shelf-four", "aux.txt"],
        ]) {
            await store.writeShelfGeneration(shelfId, input);
            const shelfPath = path.join(paths.root, "shelves", shelfId, "gen-1", "manifest.json");
            const shelfManifest = JSON.parse(await readFile(shelfPath, "utf8")) as {
                files: Array<{ indexBlock: { path: string } }>;
                checksum: string;
            };
            shelfManifest.files[0].indexBlock.path = unsafePath;
            resealManifest(shelfManifest);
            await writeFile(shelfPath, JSON.stringify(shelfManifest));
            await expect(store.readCurrentShelfManifest(shelfId)).rejects.toBeInstanceOf(
                ShelfStoreCorruptionError,
            );
        }
    });

    it("rejects stale shelf or catalog generations inside the reentrant store lock without mutating", async () => {
        const { store } = await makeStore();
        const input = persistedShelfInput();
        await store.writeShelfGeneration("shelf-one", input);
        let mutations = 0;

        await expect(
            store.withGenerationCas(
                { shelfId: "shelf-one", expectedShelfGeneration: 0 },
                async () => {
                    mutations += 1;
                    return store.writeShelfGeneration("shelf-one", input);
                },
            ),
        ).rejects.toBeInstanceOf(ShelfStaleShelfError);
        await expect(
            store.withGenerationCas({ expectedCatalogGeneration: 0 }, async () => {
                mutations += 1;
            }),
        ).rejects.toBeInstanceOf(ShelfStaleCatalogError);

        expect(mutations).toBe(0);
        expect((await store.readCurrentShelfManifest("shelf-one")).generation).toBe(1);
    });

    it("serializes concurrent generation-CAS mutations so exactly one advances the shelf", async () => {
        const { store } = await makeStore();
        const input = persistedShelfInput();
        await store.writeShelfGeneration("shelf-one", input);
        let mutations = 0;

        const attempts = await Promise.allSettled([
            store.withGenerationCas(
                { shelfId: "shelf-one", expectedShelfGeneration: 1 },
                async () => {
                    mutations += 1;
                    return store.writeShelfGeneration("shelf-one", input);
                },
            ),
            store.withGenerationCas(
                { shelfId: "shelf-one", expectedShelfGeneration: 1 },
                async () => {
                    mutations += 1;
                    return store.writeShelfGeneration("shelf-one", input);
                },
            ),
        ]);

        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
        expect(mutations).toBe(1);
        expect((await store.readCurrentShelfManifest("shelf-one")).generation).toBe(2);
    });

    it("preserves validated shelf linkage in pending journals without changing legacy reverter journals", async () => {
        const { paths, store } = await makeStore();
        await store.writeJournal({
            id: "capture",
            state: "shelvePendingRevert",
            pathProgress: {},
            shelf: { id: "shelf-one", generation: 4 },
        });
        await store.writeJournal({ id: "legacy", state: "shelvePendingRevert", pathProgress: {} });

        await expect(store.readJournals()).resolves.toEqual([
            {
                id: "capture",
                state: "shelvePendingRevert",
                pathProgress: {},
                shelf: { id: "shelf-one", generation: 4 },
            },
            { id: "legacy", state: "shelvePendingRevert", pathProgress: {} },
        ]);
        await writeFile(
            path.join(paths.root, "journals", "capture.json"),
            JSON.stringify({
                id: "capture",
                state: "shelvePendingRevert",
                pathProgress: {},
                shelf: { id: "../escape", generation: 4 },
            }),
        );

        await expect(store.readJournals()).rejects.toBeInstanceOf(ShelfStoreCorruptionError);
    });

    it("deletes one shelf under the store lock without purging its independent recovery journal", async () => {
        const { store } = await makeStore();
        const input = persistedShelfInput();
        await store.writeShelfGeneration("shelf-one", input);
        await store.writeJournal({
            id: "recovery-one",
            state: "shelved",
            pathProgress: {},
            shelf: { id: "shelf-one", generation: 1 },
        });

        await store.deleteShelf("shelf-one");

        await expect(store.listShelves()).resolves.toEqual({
            shelfIds: [],
            corruptShelfIds: [],
            catalogGeneration: 2,
        });
        await expect(store.readCurrentShelfManifest("shelf-one")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(store.readJournals()).resolves.toEqual([
            {
                id: "recovery-one",
                state: "shelved",
                pathProgress: {},
                shelf: { id: "shelf-one", generation: 1 },
            },
        ]);
    });
});
