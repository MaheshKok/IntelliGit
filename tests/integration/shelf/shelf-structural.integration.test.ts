import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathFingerprint } from "../../../src/services/shelfServiceOperations";
import {
    cleanTemporaryRepositories,
    createShelfFixture,
    fileBytes,
    git,
    indexSnapshot,
} from "./shelfTestHarness";

afterEach(cleanTemporaryRepositories);

async function createDeleteShelf(): Promise<{
    readonly root: string;
    readonly service: Awaited<ReturnType<typeof createShelfFixture>>["service"];
    readonly shelfId: string;
    readonly changeId: string;
}> {
    const fixture = await createShelfFixture({ initialFiles: { "delete.txt": "base\n" } });
    await rm(path.join(fixture.root, "delete.txt"));
    const shelf = await fixture.service.shelve({
        name: "deleted file",
        paths: ["delete.txt"],
        silent: true,
        keepLocal: false,
    });
    const [entry] = await fixture.service.getShelfFiles(shelf.shelfId!);
    return {
        root: fixture.root,
        service: fixture.service,
        shelfId: shelf.shelfId!,
        changeId: entry!.changeId,
    };
}

describe("ShelfService real repository structural resolution", () => {
    it("keeps, deletes, or applies a shelved delete through observable structural choices", async () => {
        const kept = await createDeleteShelf();
        await writeFile(path.join(kept.root, "delete.txt"), "local change\n");
        const keepResult = await kept.service.unshelve({
            id: kept.shelfId,
            removeFromShelf: false,
            mode: "flattened",
        });
        const keepEntry = keepResult.entries[0]!;
        expect(keepEntry).toMatchObject({ kind: "structuralPending", path: "delete.txt" });
        await kept.service.resolveStructural({
            id: kept.shelfId,
            changeId: kept.changeId,
            expectedShelfGeneration: (await kept.service.listShelves()).shelves[0]!.generation,
            expectedPathFingerprint: (keepEntry as { readonly pathFingerprint: string })
                .pathFingerprint,
            action: "keepLocal",
        });
        expect(await fileBytes(kept.root, "delete.txt")).toEqual(Buffer.from("local change\n"));

        const deleted = await createDeleteShelf();
        await writeFile(path.join(deleted.root, "delete.txt"), "local change\n");
        const deleteResult = await deleted.service.unshelve({
            id: deleted.shelfId,
            removeFromShelf: false,
            mode: "flattened",
        });
        const deleteEntry = deleteResult.entries[0]! as { readonly pathFingerprint: string };
        await deleted.service.resolveStructural({
            id: deleted.shelfId,
            changeId: deleted.changeId,
            expectedShelfGeneration: (await deleted.service.listShelves()).shelves[0]!.generation,
            expectedPathFingerprint: deleteEntry.pathFingerprint,
            action: "deleteLocal",
        });
        await expect(readFile(path.join(deleted.root, "delete.txt"))).rejects.toMatchObject({
            code: "ENOENT",
        });

        const shelved = await createDeleteShelf();
        const shelvedResult = await shelved.service.unshelve({
            id: shelved.shelfId,
            removeFromShelf: false,
            mode: "flattened",
        });
        const shelvedEntry = shelvedResult.entries[0]! as { readonly pathFingerprint: string };
        await shelved.service.resolveStructural({
            id: shelved.shelfId,
            changeId: shelved.changeId,
            expectedShelfGeneration: (await shelved.service.listShelves()).shelves[0]!.generation,
            expectedPathFingerprint: shelvedEntry.pathFingerprint,
            action: "useShelved",
        });
        await expect(readFile(path.join(shelved.root, "delete.txt"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("resolves a real A-to-B shelf rename by moving the local source to a new path", async () => {
        const fixture = await createShelfFixture({ initialFiles: { "a.txt": "base\n" } });
        const beforeIndex = await indexSnapshot(fixture.root);
        await git(fixture.root, ["mv", "a.txt", "b.txt"]);
        const shelf = await fixture.service.shelve({
            name: "rename",
            paths: ["a.txt", "b.txt"],
            silent: true,
            keepLocal: false,
        });
        expect(await fileBytes(fixture.root, "a.txt")).toEqual(Buffer.from("base\n"));
        await expect(readFile(path.join(fixture.root, "b.txt"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await indexSnapshot(fixture.root)).toEqual(beforeIndex);
        const [entry] = await fixture.service.getShelfFiles(shelf.shelfId!);
        const result = await fixture.service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: false,
            mode: "flattened",
        });
        const pending = result.entries.find((item) => item.changeId === entry!.changeId)! as {
            readonly pathFingerprint: string;
        };
        await fixture.service.resolveStructural({
            id: shelf.shelfId!,
            changeId: entry!.changeId,
            expectedShelfGeneration: (await fixture.service.listShelves()).shelves[0]!.generation,
            expectedPathFingerprint: pending.pathFingerprint,
            action: "renameLocal",
            targetPath: "local-a.txt",
        });
        expect(await fileBytes(fixture.root, "local-a.txt")).toEqual(Buffer.from("base\n"));
        await expect(readFile(path.join(fixture.root, "a.txt"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("rejects a stale structural fingerprint without changing the later local bytes", async () => {
        const fixture = await createDeleteShelf();
        await writeFile(path.join(fixture.root, "delete.txt"), "local before session\n");
        const result = await fixture.service.unshelve({
            id: fixture.shelfId,
            removeFromShelf: false,
            mode: "flattened",
        });
        const pending = result.entries[0]! as { readonly pathFingerprint: string };
        await writeFile(path.join(fixture.root, "delete.txt"), "external edit\n");

        await expect(
            fixture.service.resolveStructural({
                id: fixture.shelfId,
                changeId: fixture.changeId,
                expectedShelfGeneration: (await fixture.service.listShelves()).shelves[0]!
                    .generation,
                expectedPathFingerprint: pending.pathFingerprint,
                action: "deleteLocal",
            }),
        ).rejects.toThrow("stale");
        expect(await fileBytes(fixture.root, "delete.txt")).toEqual(Buffer.from("external edit\n"));
        expect(await pathFingerprint(path.join(fixture.root, "delete.txt"))).not.toBe(
            pending.pathFingerprint,
        );
    });
});
