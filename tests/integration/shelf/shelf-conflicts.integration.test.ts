import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    cleanTemporaryRepositories,
    createShelfFixture,
    fileBytes,
    git,
    gitDirectory,
    indexSnapshot,
} from "./shelfTestHarness";

afterEach(cleanTemporaryRepositories);

async function createTextConflict(options: { readonly recordBaseRevisions?: boolean } = {}) {
    const fixture = await createShelfFixture({
        initialFiles: { "tracked.txt": "one\nbase\nthree\n" },
        recordBaseRevisions: options.recordBaseRevisions,
    });
    await writeFile(path.join(fixture.root, "tracked.txt"), "one\nshelved\nthree\n");
    const shelf = await fixture.service.shelve({
        name: "text conflict",
        paths: ["tracked.txt"],
        silent: true,
        keepLocal: false,
    });
    await writeFile(path.join(fixture.root, "tracked.txt"), "one\nlocal\nthree\n");
    const [entry] = await fixture.service.getShelfFiles(shelf.shelfId!);

    return { fixture, shelfId: shelf.shelfId!, changeId: entry!.changeId };
}

describe("ShelfService real repository conflict sessions", () => {
    it("uses real merge-file conflict markers, resolves only the worktree, and ghosts the completed shelf", async () => {
        const { fixture, shelfId, changeId } = await createTextConflict();
        const beforeResolutionIndex = await indexSnapshot(fixture.root);

        await expect(
            fixture.service.unshelve({
                id: shelfId,
                changeIds: [changeId],
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).resolves.toMatchObject({
            status: "conflicts",
            entries: [{ kind: "conflicted", changeId }],
        });
        const conflicted = await fileBytes(fixture.root, "tracked.txt");
        expect(conflicted.toString("utf8")).toContain("<<<<<<<");
        expect(conflicted.toString("utf8")).toContain("local");
        expect(conflicted.toString("utf8")).toContain("shelved");

        const session = await fixture.service.openShelfConflictSession(shelfId, changeId);
        expect(session).toMatchObject({
            path: "tracked.txt",
            base: "one\nbase\nthree\n",
            current: "one\nlocal\nthree\n",
            patchedBase: "one\nshelved\nthree\n",
        });

        await expect(
            fixture.service.applyShelfConflictResolution({
                id: shelfId,
                changeId,
                content: "one\nresolved\nthree\n",
                expectedShelfGeneration: session.shelfGeneration,
                expectedPathFingerprint: session.worktreeFingerprint,
            }),
        ).resolves.toMatchObject({ status: "applied" });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(
            Buffer.from("one\nresolved\nthree\n"),
        );
        expect(await indexSnapshot(fixture.root)).toEqual(beforeResolutionIndex);
        await expect(fixture.service.listShelves()).resolves.toMatchObject({
            shelves: [{ id: shelfId, metadata: { lifecycle: "applied" } }],
        });
        await expect(fixture.store.readJournals()).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    state: "ghost",
                    shelf: expect.objectContaining({ id: shelfId }),
                }),
            ]),
        );
    });

    it("refuses stale paths, then parks fresh local bytes before an explicit override writes the resolution", async () => {
        const { fixture, shelfId, changeId } = await createTextConflict();
        await fixture.service.unshelve({
            id: shelfId,
            changeIds: [changeId],
            removeFromShelf: false,
            mode: "flattened",
        });
        const session = await fixture.service.openShelfConflictSession(shelfId, changeId);
        await writeFile(path.join(fixture.root, "tracked.txt"), "one\nfresh local\nthree\n");

        await expect(
            fixture.service.applyShelfConflictResolution({
                id: shelfId,
                changeId,
                content: "one\nresolved\nthree\n",
                expectedShelfGeneration: session.shelfGeneration,
                expectedPathFingerprint: session.worktreeFingerprint,
            }),
        ).resolves.toEqual({ status: "stale", reason: "path" });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(
            Buffer.from("one\nfresh local\nthree\n"),
        );

        await expect(
            fixture.service.applyShelfConflictResolution({
                id: shelfId,
                changeId,
                content: "one\nresolved\nthree\n",
                expectedShelfGeneration: session.shelfGeneration,
                expectedPathFingerprint: session.worktreeFingerprint,
                staleOverride: "overwriteParkingCurrent",
            }),
        ).resolves.toMatchObject({ status: "applied" });
        const recoveryRoot = path.join(await gitDirectory(fixture.root), "intelligit", "recovery");
        const recoveryCopies = await Promise.all(
            (await readdir(recoveryRoot)).map((transaction) =>
                readFile(path.join(recoveryRoot, transaction, "tracked.txt")).catch(
                    () => undefined,
                ),
            ),
        );
        expect(recoveryCopies).toContainEqual(Buffer.from("one\nfresh local\nthree\n"));
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(
            Buffer.from("one\nresolved\nthree\n"),
        );
    });

    it("refuses a session when a separate real shelf operation advances its generation", async () => {
        const fixture = await createShelfFixture({
            initialFiles: {
                "tracked.txt": "one\nbase\nthree\n",
                "other.txt": "begin\nbase\nend\n",
            },
        });
        await writeFile(path.join(fixture.root, "tracked.txt"), "one\nshelved\nthree\n");
        await writeFile(path.join(fixture.root, "other.txt"), "begin\nshelved\nend\n");
        const shelf = await fixture.service.shelve({
            name: "generation stale",
            paths: ["tracked.txt", "other.txt"],
            silent: true,
            keepLocal: false,
        });
        await writeFile(path.join(fixture.root, "tracked.txt"), "one\nlocal\nthree\n");
        await writeFile(path.join(fixture.root, "other.txt"), "begin\nlocal\nend\n");
        const entries = await fixture.service.getShelfFiles(shelf.shelfId!);
        const conflict = entries.find((entry) => entry.worktreeBlock?.path === "tracked.txt")!;
        const other = entries.find((entry) => entry.worktreeBlock?.path === "other.txt")!;
        await fixture.service.unshelve({
            id: shelf.shelfId!,
            changeIds: [conflict.changeId],
            removeFromShelf: false,
            mode: "flattened",
        });
        const session = await fixture.service.openShelfConflictSession(
            shelf.shelfId!,
            conflict.changeId,
        );

        await expect(
            fixture.service.unshelve({
                id: shelf.shelfId!,
                changeIds: [other.changeId],
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).resolves.toMatchObject({ status: "conflicts", entries: [{ kind: "conflicted" }] });
        const otherSession = await fixture.service.openShelfConflictSession(
            shelf.shelfId!,
            other.changeId,
        );
        await expect(
            fixture.service.applyShelfConflictResolution({
                id: shelf.shelfId!,
                changeId: other.changeId,
                content: "begin\nother resolved\nend\n",
                expectedShelfGeneration: otherSession.shelfGeneration,
                expectedPathFingerprint: otherSession.worktreeFingerprint,
            }),
        ).resolves.toMatchObject({ status: "applied" });
        const beforeStaleApply = await fileBytes(fixture.root, "tracked.txt");

        await expect(
            fixture.service.applyShelfConflictResolution({
                id: shelf.shelfId!,
                changeId: conflict.changeId,
                content: "one\nresolved\nthree\n",
                expectedShelfGeneration: session.shelfGeneration,
                expectedPathFingerprint: session.worktreeFingerprint,
            }),
        ).resolves.toEqual({ status: "stale", reason: "shelf" });
        expect(await fileBytes(fixture.root, "tracked.txt")).toEqual(beforeStaleApply);
    });

    it("opens a pinned history base without base-object recording, then rejects it after real history pruning", async () => {
        const { fixture, shelfId, changeId } = await createTextConflict({
            recordBaseRevisions: false,
        });
        await fixture.service.unshelve({
            id: shelfId,
            changeIds: [changeId],
            removeFromShelf: false,
            mode: "flattened",
        });
        await expect(
            fixture.service.openShelfConflictSession(shelfId, changeId),
        ).resolves.toMatchObject({
            base: "one\nbase\nthree\n",
            patchedBase: "one\nshelved\nthree\n",
        });

        const oldBranch = (await git(fixture.root, ["branch", "--show-current"]))
            .toString("utf8")
            .trim();
        await git(fixture.root, ["checkout", "--orphan", "shelf-no-base"]);
        await git(fixture.root, ["rm", "-rf", "--cached", "."]);
        await writeFile(path.join(fixture.root, "tracked.txt"), "replacement history\n");
        await git(fixture.root, ["add", "tracked.txt"]);
        await git(fixture.root, ["commit", "-m", "replacement history"]);
        await git(fixture.root, ["branch", "-D", oldBranch]);
        await git(fixture.root, ["reflog", "expire", "--expire=now", "--all"]);
        await git(fixture.root, ["gc", "--prune=now"]);
        await expect(fixture.service.getShelfFiles(shelfId)).resolves.toMatchObject([
            { changeId, baseAvailability: "none" },
        ]);
        await expect(fixture.service.openShelfConflictSession(shelfId, changeId)).rejects.toThrow(
            "not eligible",
        );
    });
});
