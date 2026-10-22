import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeRangeTracker } from "../../../src/changes/changeRangeTracker";
import type { ChangelistStore } from "../../../src/changes/changelistStore";
import type { PartialChanges } from "../../../src/git/partialChanges";
import type { WorkingFile } from "../../../src/types";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

vi.mock("../../../src/changes/rangeObservation", () => ({
    rangeObservation: async () => "observation",
}));

describe("ChangeRangeTracker", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "intelligit-range-tracker-"));
    });

    afterEach(async () => {
        await removeScratchDirectories(root);
    });

    it("keeps at most one full pass queued behind a running one", async () => {
        let releaseFirst!: () => void;
        const parked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const indexEntries = vi
            .fn<PartialChanges["indexEntries"]>()
            .mockImplementationOnce(async () => {
                await parked;
                return new Map();
            })
            .mockResolvedValue(new Map());
        const requireReview = vi.fn<ChangelistStore["requireReview"]>().mockResolvedValue();
        const store = {
            // A renamed source with ownership marks each pass's destination for review.
            get: () => ({ revision: 0, activeId: "a", files: {}, changes: { "old.txt": {} } }),
            requireReview,
        } as unknown as ChangelistStore;
        const tracker = new ChangeRangeTracker(
            root,
            { indexEntries } as unknown as PartialChanges,
            store,
        );
        const renamed = (destination: string): WorkingFile[] => [
            {
                path: destination,
                sourcePath: "old.txt",
                status: "R",
                staged: false,
                additions: 0,
                deletions: 0,
            },
        ];

        const running = tracker.reconcile(renamed("first.txt"), 1);
        await vi.waitFor(() => expect(indexEntries).toHaveBeenCalledTimes(1));
        // The 5 s poll keeps calling while the first pass is parked.
        const polls = [2, 3, 4].map((epoch) =>
            tracker.reconcile(renamed(`poll${epoch}.txt`), epoch),
        );
        releaseFirst();
        await Promise.all([running, ...polls]);

        expect(
            indexEntries,
            "polls during a running pass must coalesce into one",
        ).toHaveBeenCalledTimes(2);
        const reviewed = requireReview.mock.calls
            .map(([, file, , epoch]) => `${file}@${epoch}`)
            .filter((entry) => !entry.startsWith("old.txt"));
        expect(reviewed, "the queued pass must use the latest call's files and epoch").toEqual([
            "first.txt@1",
            "poll4.txt@4",
        ]);
    });

    it("saves a pass's modified files in one store write", async () => {
        const files = ["a.txt", "b.txt", "c.txt"];
        await Promise.all(files.map((file) => writeFile(path.join(root, file), `${file}\n`)));
        const writes: string[][] = [];
        const store = {
            get: () => ({ revision: 7, activeId: "a", files: {}, changes: {} }),
            track: vi.fn(async (_root: string, file: string) => {
                writes.push([file]);
            }),
            trackBatch: vi.fn(async (_root: string, entries: { file: string }[]) => {
                writes.push(entries.map((entry) => entry.file));
            }),
            requireReview: vi.fn().mockResolvedValue(undefined),
        } as unknown as ChangelistStore;
        const partial = {
            indexEntries: async () => new Map(),
            open: async (file: string) => ({ snapshotId: file }),
            snapshot: (id: string) => ({
                contentId: id,
                gitDir: root,
                commonDir: root,
                view: { base: "", blocks: [] },
                working: `${id}\n`,
                head: "head",
                indexHash: "index",
            }),
        } as unknown as PartialChanges;
        const modified = files.map((file): WorkingFile => ({
            path: file,
            status: "M",
            staged: false,
            additions: 1,
            deletions: 0,
        }));

        await new ChangeRangeTracker(root, partial, store).reconcile(modified);

        expect(writes, "a pass must save its files in one store write, not one per file").toEqual([
            files,
        ]);
        expect(store.requireReview).not.toHaveBeenCalled();
    });
});
