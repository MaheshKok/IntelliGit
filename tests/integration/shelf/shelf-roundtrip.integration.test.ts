import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    cachedDiff,
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

describe("ShelfService real repository round trips", () => {
    it("keeps flattened unshelve index bytes identical and restores exact staged and unstaged layers", async () => {
        const flattened = await createShelfFixture();
        await writeFile(path.join(flattened.root, "tracked.txt"), "staged\n");
        await git(flattened.root, ["add", "tracked.txt"]);
        await writeFile(path.join(flattened.root, "tracked.txt"), "unstaged\n");
        const shelf = await flattened.service.shelve({
            name: "two layers",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        const beforeFlattenedIndex = await indexSnapshot(flattened.root);

        await expect(
            flattened.service.unshelve({
                id: shelf.shelfId!,
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).resolves.toMatchObject({ status: "ok", entries: [{ kind: "applied" }] });
        expect(await fileBytes(flattened.root, "tracked.txt")).toEqual(Buffer.from("unstaged\n"));
        expect(await indexSnapshot(flattened.root)).toEqual(beforeFlattenedIndex);

        const exact = await createShelfFixture();
        await writeFile(path.join(exact.root, "tracked.txt"), "staged\n");
        await git(exact.root, ["add", "tracked.txt"]);
        await writeFile(path.join(exact.root, "tracked.txt"), "unstaged\n");
        const expectedCached = await cachedDiff(exact.root);
        const exactShelf = await exact.service.shelve({
            name: "two layers exact",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });

        await expect(
            exact.service.unshelve({
                id: exactShelf.shelfId!,
                removeFromShelf: false,
                mode: "exactState",
            }),
        ).resolves.toMatchObject({ status: "ok", entries: [{ kind: "applied" }] });
        expect(await fileBytes(exact.root, "tracked.txt")).toEqual(Buffer.from("unstaged\n"));
        expect(await cachedDiff(exact.root)).toEqual(expectedCached);
    });

    it("reverses B/A cancellation and restores it through flattened and exact-state modes", async () => {
        const flattened = await createShelfFixture();
        await writeFile(path.join(flattened.root, "tracked.txt"), "staged\n");
        await git(flattened.root, ["add", "tracked.txt"]);
        await writeFile(path.join(flattened.root, "tracked.txt"), "base\n");
        const shelf = await flattened.service.shelve({
            name: "cancel flattened",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        expect(await fileBytes(flattened.root, "tracked.txt")).toEqual(Buffer.from("base\n"));
        const indexAfterRevert = await indexSnapshot(flattened.root);

        await expect(
            flattened.service.unshelve({
                id: shelf.shelfId!,
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).resolves.toMatchObject({ entries: [{ kind: "flattenedResidue" }] });
        expect(await fileBytes(flattened.root, "tracked.txt")).toEqual(Buffer.from("staged\n"));
        expect(await indexSnapshot(flattened.root)).toEqual(indexAfterRevert);

        const exact = await createShelfFixture();
        await writeFile(path.join(exact.root, "tracked.txt"), "staged\n");
        await git(exact.root, ["add", "tracked.txt"]);
        await writeFile(path.join(exact.root, "tracked.txt"), "base\n");
        const exactShelf = await exact.service.shelve({
            name: "cancel exact",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });

        await expect(
            exact.service.unshelve({
                id: exactShelf.shelfId!,
                removeFromShelf: false,
                mode: "exactState",
            }),
        ).resolves.toMatchObject({ entries: [{ kind: "applied" }] });
        expect(await fileBytes(exact.root, "tracked.txt")).toEqual(Buffer.from("base\n"));
        expect(await git(exact.root, ["show", ":tracked.txt"])).toEqual(Buffer.from("staged\n"));
    });

    it("records Save to Shelf without changing worktree or index bytes", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "staged\n");
        await git(fixture.root, ["add", "tracked.txt"]);
        await writeFile(path.join(fixture.root, "tracked.txt"), "unstaged\n");
        const beforeTree = await fileBytes(fixture.root, "tracked.txt");
        const beforeIndex = await indexSnapshot(fixture.root);

        const created = await fixture.service.shelve({
            name: "save",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });

        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(beforeTree);
        expect(await indexSnapshot(fixture.root)).toEqual(beforeIndex);
        await expect(fixture.service.getShelfFiles(created.shelfId!)).resolves.toMatchObject([
            { indexBlock: expect.any(Object), worktreeBlock: expect.any(Object) },
        ]);
    });

    it("refuses exact-state index divergence without changing the divergent tree or index", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "shelved\n");
        const shelf = await fixture.service.shelve({
            name: "exact refusal",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        await writeFile(path.join(fixture.root, "tracked.txt"), "other index\n");
        await git(fixture.root, ["add", "tracked.txt"]);
        await writeFile(path.join(fixture.root, "tracked.txt"), "other worktree\n");
        const beforeTree = await fileBytes(fixture.root, "tracked.txt");
        const beforeIndex = await indexSnapshot(fixture.root);

        await expect(
            fixture.service.unshelve({
                id: shelf.shelfId!,
                removeFromShelf: false,
                mode: "exactState",
            }),
        ).resolves.toMatchObject({ status: "partial", entries: [{ kind: "refused" }] });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(beforeTree);
        expect(await indexSnapshot(fixture.root)).toEqual(beforeIndex);
    });

    it("shelves and unshelves an unborn repository without a base commit", async () => {
        const fixture = await createShelfFixture({ commit: false, initialFiles: {} });
        await writeFile(path.join(fixture.root, "unborn.txt"), "unborn content\n");
        const shelf = await fixture.service.shelve({
            name: "unborn",
            paths: ["unborn.txt"],
            silent: true,
            keepLocal: false,
        });
        await expect(readFile(path.join(fixture.root, "unborn.txt"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(fixture.service.getShelfFiles(shelf.shelfId!)).resolves.toMatchObject([
            { baseAvailability: "none" },
        ]);

        await fixture.service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: false,
            mode: "flattened",
        });
        expect(await fileBytes(fixture.root, "unborn.txt")).toEqual(
            Buffer.from("unborn content\n"),
        );
    });

    it("targets the linked worktree and keeps the main checkout untouched", async () => {
        const main = await createShelfFixture();
        const linkedRoot = await createLinkedWorktree(main.root);
        const linked = await createSecondService(linkedRoot, main.storageRoot);
        await writeFile(path.join(linkedRoot, "tracked.txt"), "linked shelf\n");
        const shelf = await linked.service.shelve({
            name: "linked",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });

        expect(await fileBytes(main.root, "tracked.txt")).toEqual(Buffer.from("base\n"));
        expect(await fileBytes(linkedRoot, "tracked.txt")).toEqual(Buffer.from("base\n"));
        await expect(
            stat(path.join(await gitDirectory(linkedRoot), "intelligit", "recovery")),
        ).resolves.toBeDefined();
        await linked.service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: false,
            mode: "flattened",
        });
        expect(await fileBytes(linkedRoot, "tracked.txt")).toEqual(Buffer.from("linked shelf\n"));
        expect(await fileBytes(main.root, "tracked.txt")).toEqual(Buffer.from("base\n"));
    });

    it("uses raw before and after artifacts to preserve CRLF worktree bytes", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, ".gitattributes"), "*.txt text eol=crlf\n");
        await git(fixture.root, ["add", ".gitattributes"]);
        await git(fixture.root, ["commit", "-m", "eol fixture"]);
        await writeFile(path.join(fixture.root, "tracked.txt"), Buffer.from("edited\r\n"));
        const shelf = await fixture.service.shelve({
            name: "eol",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        const [entry] = await fixture.service.getShelfFiles(shelf.shelfId!);
        expect(entry).toMatchObject({
            exactReconstruction: false,
            worktreeBlock: {
                rawBeforeObjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                rawAfterObjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
        });
        const artifacts = await fixture.service.getShelfFileContents(
            shelf.shelfId!,
            entry!.changeId,
        );
        expect(artifacts.rawBefore).toEqual(await fileBytes(fixture.root, "tracked.txt"));
        const beforeIndex = await indexSnapshot(fixture.root);

        await expect(
            fixture.service.unshelve({
                id: shelf.shelfId!,
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).resolves.toMatchObject({ status: "ok", entries: [{ kind: "applied" }] });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(Buffer.from("edited\r\n"));
        expect(await indexSnapshot(fixture.root)).toEqual(beforeIndex);
    });
});
