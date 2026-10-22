import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeRangeTracker } from "../../../src/changes/changeRangeTracker";
import type { ChangelistStore } from "../../../src/changes/changelistStore";
import type { PartialChanges } from "../../../src/git/partialChanges";
import type { WorkingFile } from "../../../src/types";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

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
});
