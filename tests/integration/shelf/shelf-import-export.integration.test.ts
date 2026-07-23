import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemporaryRepositories, createShelfFixture, fileBytes } from "./shelfTestHarness";

afterEach(cleanTemporaryRepositories);

describe("ShelfService real repository patch import and export", () => {
    it("exports a flattened shelf and imports it into a fresh matching repository", async () => {
        const source = await createShelfFixture({ initialFiles: { "roundtrip.txt": "base\n" } });
        await writeFile(path.join(source.root, "roundtrip.txt"), "exported content\n");
        const shelf = await source.service.shelve({
            name: "export source",
            paths: ["roundtrip.txt"],
            silent: true,
            keepLocal: true,
        });
        const exportPath = path.join(source.root, "exported.patch");
        await writeFile(exportPath, await source.service.exportPatch({ id: shelf.shelfId! }));

        const destination = await createShelfFixture({
            initialFiles: { "roundtrip.txt": "base\n" },
        });
        const imported = await destination.service.importPatch({
            fileUris: [exportPath],
            name: "round trip",
        });
        await expect(
            destination.service.unshelve({
                id: imported.shelfId!,
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).resolves.toMatchObject({ status: "ok", entries: [{ kind: "applied" }] });
        expect(await fileBytes(destination.root, "roundtrip.txt")).toEqual(
            Buffer.from("exported content\n"),
        );
    });

    it("imports the checked-in PyCharm unified-diff fixture as a content-only shelf", async () => {
        const fixturePath = path.join(
            process.cwd(),
            "tests/integration/shelf/fixtures/pycharm-unified.patch",
        );
        const destination = await createShelfFixture({ initialFiles: { "pycharm.txt": "base\n" } });
        const imported = await destination.service.importPatch({
            fileUris: [fixturePath],
            name: "PyCharm fixture",
        });
        await expect(destination.service.getShelfFiles(imported.shelfId!)).resolves.toMatchObject([
            { worktreeBlock: { path: "pycharm.txt", status: "M" }, baseAvailability: "none" },
        ]);

        await destination.service.unshelve({
            id: imported.shelfId!,
            removeFromShelf: false,
            mode: "flattened",
        });
        expect(await fileBytes(destination.root, "pycharm.txt")).toEqual(
            Buffer.from("from pycharm shelf\n"),
        );
    });

    it("replays identical shelve and import requests without duplicating shelves", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "saved\n");
        const shelveRequest = {
            name: "idempotent shelve",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
            idempotencyToken: "same-shelve-request",
        };
        const firstShelf = await fixture.service.shelve(shelveRequest);
        const replayedShelf = await fixture.service.shelve(shelveRequest);
        expect(replayedShelf).toMatchObject({ shelfId: firstShelf.shelfId });
        await expect(fixture.service.listShelves()).resolves.toMatchObject({
            shelves: [{ id: firstShelf.shelfId }],
        });

        const patchPath = path.join(
            process.cwd(),
            "tests/integration/shelf/fixtures/pycharm-unified.patch",
        );
        const importRequest = {
            fileUris: [patchPath],
            name: "idempotent import",
            idempotencyToken: "same-import-request",
        };
        const firstImport = await fixture.service.importPatch(importRequest);
        const replayedImport = await fixture.service.importPatch(importRequest);
        expect(replayedImport).toMatchObject({ shelfId: firstImport.shelfId });
        const listed = await fixture.service.listShelves();
        expect(listed.shelves.map((shelf) => shelf.id)).toEqual(
            expect.arrayContaining([firstShelf.shelfId, firstImport.shelfId]),
        );
    });
});
