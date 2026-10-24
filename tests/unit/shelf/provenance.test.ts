import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    parseShelfPersistenceContract,
    ShelfPersistenceContractError,
} from "../../../src/shelf/model";
import { assertPersistedObjectReferences } from "../../../src/shelf/persistence";
import { ensureShelfRoot, resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

function contract() {
    return {
        metadata: {
            name: "selected text",
            lifecycle: "shelved" as const,
            selection: {
                version: 1 as const,
                scope: "selection" as const,
                sourceLists: [
                    {
                        id: "default",
                        name: "प्रथम",
                        description: "First\nlist",
                        draft: "Draft α\n",
                    },
                    {
                        id: "12345678-1234-1234-1234-123456789abc",
                        name: "第二",
                        description: "Second",
                        draft: "Draft β\r\n",
                    },
                ],
                scopeDraft: "All draft\n",
                entries: [
                    {
                        changeId: "partial-text",
                        sourceListIds: ["default", "12345678-1234-1234-1234-123456789abc"],
                        ownershipObjectHash: "b".repeat(64),
                    },
                ],
            },
        },
        files: [
            {
                changeId: "partial-text",
                worktreeBlock: {
                    path: "src/split.txt",
                    status: "M" as const,
                    patchObjectHash: "a".repeat(64),
                },
                binary: false,
                untracked: false,
                baseAvailability: "history" as const,
                exactReconstruction: true,
                lifecycle: "shelved" as const,
            },
        ],
    };
}

async function makeStore() {
    const directory = await mkdtemp(path.join(tmpdir(), "shelf-provenance-"));
    directories.push(directory);
    const repositoryRoot = path.join(directory, "repo");
    await mkdir(repositoryRoot);
    const paths = await resolveShelfPaths({
        repositoryRoot,
        globalStoragePath: path.join(directory, "storage"),
    });
    await ensureShelfRoot(paths);
    return { paths, store: new ShelfStore(paths) };
}

describe("shelf provenance storage boundary", () => {
    it("manifest parse retains both source drafts and exact selected ownership", async () => {
        const { paths, store } = await makeStore();
        await store.withLock(() => store.migrateWithHeldLocks());
        const input = contract();
        const legacy = {
            ...input,
            metadata: { name: input.metadata.name, lifecycle: input.metadata.lifecycle },
        };
        await store.writeShelfGeneration("selected", {
            ...legacy,
            schemaVersion: 1,
            objectHashes: ["a".repeat(64), "b".repeat(64)],
        });
        // A sealed fixture tests persisted parsing without enabling pre-migration provenance writes.
        const manifestPath = path.join(paths.root, "shelves", "selected", "gen-1", "manifest.json");
        const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
        persisted.metadata = input.metadata;
        persisted.checksum = createHash("sha256")
            .update(JSON.stringify({ ...persisted, checksum: "" }))
            .digest("hex");
        await writeFile(manifestPath, JSON.stringify(persisted));
        const reopened = await new ShelfStore(paths).readCurrentShelfManifest("selected");
        expect(reopened.metadata).toEqual(input.metadata);
    });

    it("does not enable provenance publication before the schema migration", async () => {
        const { paths, store } = await makeStore();
        const catalogBefore = await readFile(path.join(paths.root, "catalog.json"), "utf8").catch(
            () => undefined,
        );
        await expect(
            store.writeShelfGeneration("selected", {
                ...contract(),
                schemaVersion: 1,
                objectHashes: ["a".repeat(64), "b".repeat(64)],
            }),
        ).rejects.toThrow("Shelf migration must finish");
        await expect(
            readFile(path.join(paths.root, "shelves", "selected", "current")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
            await readFile(path.join(paths.root, "catalog.json"), "utf8").catch(() => undefined),
        ).toBe(catalogBefore);
    });

    it("rejects a dangling ownership object", () => {
        expect(() => assertPersistedObjectReferences(contract(), ["a".repeat(64)])).toThrow(
            ShelfPersistenceContractError,
        );
    });

    it("preserves source text and accepted boundary lengths without normalizing or truncating", () => {
        const input = contract();
        input.metadata.selection.sourceLists[0] = {
            id: "default",
            name: "  Cafe\u0301  ",
            description: "x".repeat(4_000),
            draft: "d".repeat(100_000),
        };
        input.metadata.selection.scopeDraft = "a".repeat(100_000);
        const parsed = parseShelfPersistenceContract(input);
        expect(parsed.metadata.selection).toEqual(input.metadata.selection);
        input.metadata.selection.sourceLists[0].draft = "later edit";
        expect(parsed.metadata.selection?.sourceLists[0].draft).toBe("d".repeat(100_000));
    });

    it.each([
        [
            "unknown version",
            (value: ReturnType<typeof contract>) => {
                Object.assign(value.metadata.selection, { version: 2 });
            },
        ],
        [
            "unknown scope",
            (value: ReturnType<typeof contract>) => {
                Object.assign(value.metadata.selection, { scope: "all" });
            },
        ],
        [
            "duplicate source ID",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.sourceLists[1].id = "default";
            },
        ],
        [
            "unknown owner",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.entries[0].sourceListIds = ["missing"];
            },
        ],
        [
            "duplicate owner",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.entries[0].sourceListIds = ["default", "default"];
            },
        ],
        [
            "missing owners",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.entries[0].sourceListIds = [];
            },
        ],
        [
            "unknown change ID",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.entries[0].changeId = "missing";
            },
        ],
        [
            "duplicate change ID",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.entries.push(value.metadata.selection.entries[0]);
            },
        ],
        [
            "unsafe object hash",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.entries[0].ownershipObjectHash = "../objects";
            },
        ],
        [
            "oversized name",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.sourceLists[0].name = "x".repeat(81);
            },
        ],
        [
            "control-bearing name",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.sourceLists[0].name = "bad\nname";
            },
        ],
        [
            "oversized description",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.sourceLists[0].description = "x".repeat(4001);
            },
        ],
        [
            "oversized draft",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.sourceLists[0].draft = "x".repeat(100001);
            },
        ],
        [
            "oversized All draft",
            (value: ReturnType<typeof contract>) => {
                value.metadata.selection.scopeDraft = "x".repeat(100001);
            },
        ],
    ])("rejects %s without discarding provenance", (_name, mutate) => {
        const value = contract();
        mutate(value);
        expect(() => parseShelfPersistenceContract(value)).toThrow(ShelfPersistenceContractError);
    });
});
