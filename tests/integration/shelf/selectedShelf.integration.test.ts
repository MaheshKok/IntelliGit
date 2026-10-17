import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PartialChanges } from "../../../src/git/partialChanges";
import { changeIds } from "../../../src/changes/selection";
import {
    cleanTemporaryRepositories,
    createShelfFixture,
    fileBytes,
    git,
    indexSnapshot,
} from "./shelfTestHarness";

afterEach(cleanTemporaryRepositories);

describe("selected content shelves", () => {
    it.each([true, false])(
        "saves only a selected block and restores it beside retained edits (recordBase=%s)",
        async (recordBase) => {
            const base = Array.from({ length: 60 }, (_, i) => `line ${i}\n`).join("");
            const first = base.replace("line 20\n", "shelved selection\n");
            const remaining = base.replace("line 26\n", "retained nearby change\n");
            const working = first.replace("line 26\n", "retained nearby change\n");
            const fixture = await createShelfFixture({
                initialFiles: { "tracked.txt": base },
                recordBaseRevisions: recordBase,
            });
            await writeFile(path.join(fixture.root, "tracked.txt"), working);
            const partial = new PartialChanges(fixture.executor, fixture.root);
            const view = await partial.open("tracked.txt");
            const lineIds = view.blocks
                .flatMap((block) => block.lines)
                .filter((line) => line.oldLine === 21 || line.newLine === 21)
                .filter((line) => line.kind !== "context")
                .map((line) => line.id);
            expect(lineIds).toHaveLength(2);
            const selection = { snapshotId: view.snapshotId, lineIds };
            const snapshot = partial.snapshot(view.snapshotId);
            const before = await indexSnapshot(fixture.root);
            const saved = await fixture.service.saveSelectedChanges(
                {
                    name: "selected text",
                    path: "tracked.txt",
                    baseCommit: snapshot.head,
                    base: Buffer.from(snapshot.view.base),
                    patch: await partial.exportPatch(selection, () => undefined),
                },
                () => partial.validate(selection, () => undefined),
            );
            expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(Buffer.from(working));
            expect(await indexSnapshot(fixture.root)).toEqual(before);
            const files = await fixture.service.getShelfFiles(saved.shelfId!);
            expect(files).toMatchObject([
                { baseAvailability: recordBase ? "full" : "history", indexBlock: undefined },
            ]);
            await partial.rollback(selection, () => undefined);
            expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(Buffer.from(remaining));
            const index = await indexSnapshot(fixture.root);
            const outcome = await fixture.service.unshelve({
                id: saved.shelfId!,
                mode: "flattened",
                removeFromShelf: false,
            });
            expect(outcome.entries[0].kind).toBe("applied");
            expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(Buffer.from(working));
            expect(await indexSnapshot(fixture.root)).toEqual(index);
        },
    );

    it("refuses a stale selection before publishing a shelf", async () => {
        const fixture = await createShelfFixture();
        await writeFile(path.join(fixture.root, "tracked.txt"), "changed\n");
        const partial = new PartialChanges(fixture.executor, fixture.root);
        const view = await partial.open("tracked.txt");
        const selection = { snapshotId: view.snapshotId, lineIds: changeIds(view.blocks) };
        const patch = await partial.exportPatch(selection, () => undefined);
        await writeFile(path.join(fixture.root, "tracked.txt"), "external\n");
        await expect(
            fixture.service.saveSelectedChanges(
                {
                    name: "stale",
                    path: "tracked.txt",
                    baseCommit: (await git(fixture.root, ["rev-parse", "HEAD"])).toString().trim(),
                    base: Buffer.from(view.base),
                    patch,
                },
                () => partial.validate(selection, () => undefined),
            ),
        ).rejects.toThrow("changed");
        expect((await fixture.service.listShelves()).shelfIds).toEqual([]);
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(Buffer.from("external\n"));
    });
});
