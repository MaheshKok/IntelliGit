import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangelistEvidenceError } from "../../../src/changes/changelistPersistence";
import { ChangeRangeTracker } from "../../../src/changes/changeRangeTracker";
import {
    ChangelistRevisionError,
    type ChangelistStore,
} from "../../../src/changes/changelistStore";
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
            revision: () => 7,
            track: vi.fn(async (_root: string, file: string) => {
                writes.push([file]);
            }),
            trackBatch: vi.fn(async (_root: string, entries: { file: string }[]) => {
                writes.push(entries.map((entry) => entry.file));
            }),
            requireReview: vi.fn().mockResolvedValue(undefined),
        } as unknown as ChangelistStore;

        await new ChangeRangeTracker(root, fakePartial(root), store).reconcile(modified(files));

        expect(writes, "a pass must save its files in one store write, not one per file").toEqual([
            files,
        ]);
        expect(store.requireReview).not.toHaveBeenCalled();
    });

    it("retries a batch together after the pass's own review mark moves the revision", async () => {
        // missing.txt is reported modified but absent, so its review mark lands after the batch is captured.
        await Promise.all(
            ["a.txt", "c.txt"].map((file) => writeFile(path.join(root, file), `${file}\n`)),
        );
        let revision = 7;
        const attempts: string[] = [];
        const store = {
            get: () => ({ revision, activeId: "a", files: {}, changes: {} }),
            revision: () => revision,
            track: vi.fn(async (_root: string, file: string) => {
                attempts.push(`track ${file}`);
            }),
            trackBatch: vi.fn(
                async (_root: string, entries: { file: string }[], expected?: number) => {
                    const files = entries.map((entry) => entry.file).join(",");
                    attempts.push(`batch ${files}@${expected}`);
                    if (expected !== revision) throw new ChangelistRevisionError();
                },
            ),
            requireReview: vi.fn(async () => {
                revision++;
            }),
        } as unknown as ChangelistStore;

        await new ChangeRangeTracker(root, fakePartial(root), store).reconcile(
            modified(["a.txt", "c.txt", "missing.txt"]),
        );

        expect(attempts, "unchanged files must retry as one batch, not one write each").toEqual([
            "batch a.txt,c.txt@7",
            "batch a.txt,c.txt@8",
        ]);
    });

    it("reads a file's ownership after a review mark earlier in the pass moved it", async () => {
        await Promise.all(
            ["a.txt", "c.txt"].map((file) => writeFile(path.join(root, file), `${file}\n`)),
        );
        let revision = 7;
        let changes: Record<string, unknown> = {};
        const attempts: string[] = [];
        const store = {
            get: () => ({ revision, activeId: "a", files: {}, changes }),
            revision: () => revision,
            track: vi.fn(async (_root: string, file: string) => {
                attempts.push(`track ${file}`);
            }),
            trackBatch: vi.fn(
                async (_root: string, entries: { file: string }[], expected?: number) => {
                    attempts.push(
                        `batch ${entries.map((entry) => entry.file).join(",")}@${expected}`,
                    );
                    if (expected !== revision) throw new ChangelistRevisionError();
                },
            ),
            requireReview: vi.fn(async (_root: string, file: string) => {
                attempts.push(`review ${file}`);
                revision++;
                // Another window moves c.txt's ranges while this pass marks missing.txt.
                if (file === "missing.txt") changes = { "c.txt": { contentId: "elsewhere" } };
            }),
        } as unknown as ChangelistStore;

        await new ChangeRangeTracker(root, fakePartial(root), store).reconcile(
            modified(["a.txt", "missing.txt", "c.txt"]),
        );

        expect(attempts, "a file captured after the move must save, not need review").toEqual([
            "review missing.txt",
            "batch a.txt@7",
            "batch a.txt@8",
            "batch c.txt@8",
        ]);
    });

    it("refuses a retry for a file whose ownership moved while review marks were written", async () => {
        const files = ["a.txt", "b.txt", "c.txt"];
        await Promise.all(files.map((file) => writeFile(path.join(root, file), `${file}\n`)));
        let revision = 7;
        let changes: Record<string, unknown> = {};
        const attempts: string[] = [];
        const store = {
            get: () => ({ revision, activeId: "a", files: {}, changes }),
            revision: () => revision,
            track: vi.fn(async (_root: string, file: string) => {
                attempts.push(`track ${file}`);
                throw new ChangelistRevisionError();
            }),
            trackBatch: vi.fn(
                async (_root: string, entries: { file: string }[], expected?: number) => {
                    attempts.push(
                        `batch ${entries.map((entry) => entry.file).join(",")}@${expected}`,
                    );
                    if (attempts.length === 1) {
                        // Another window moves b.txt's ranges just before the first write.
                        changes = { "b.txt": { contentId: "elsewhere" } };
                        revision++;
                    }
                    if (expected !== revision) throw new ChangelistRevisionError();
                },
            ),
            requireReview: vi.fn(async (_root: string, file: string) => {
                attempts.push(`review ${file}`);
                revision++;
                // ...and moves c.txt's while b.txt's review mark is being written.
                if (file === "b.txt") changes = { ...changes, "c.txt": { contentId: "elsewhere" } };
            }),
        } as unknown as ChangelistStore;

        await new ChangeRangeTracker(root, fakePartial(root), store).reconcile(modified(files));

        expect(attempts, "the retry must recheck every file at the revision it fences").toEqual([
            "batch a.txt,b.txt,c.txt@7",
            "review b.txt",
            "review c.txt",
            "batch a.txt@10",
        ]);
    });

    it("fences each batch with the revision its own files were read at", async () => {
        const files = Array.from({ length: 65 }, (_, index) => `f${index}.txt`);
        await Promise.all(files.map((file) => writeFile(path.join(root, file), `${file}\n`)));
        let revision = 7;
        const fences: string[] = [];
        const store = {
            get: () => ({ revision, activeId: "a", files: {}, changes: {} }),
            revision: () => revision,
            trackBatch: vi.fn(
                async (_root: string, entries: { file: string }[], expected?: number) => {
                    fences.push(`${entries.length}@${expected}`);
                    revision++;
                },
            ),
            requireReview: vi.fn().mockResolvedValue(undefined),
        } as unknown as ChangelistStore;

        await new ChangeRangeTracker(root, fakePartial(root), store).reconcile(modified(files));

        expect(fences, "a later batch must not reuse the first batch's revision").toEqual([
            "64@7",
            "1@8",
        ]);
    });

    it("replays a batch with damaged evidence file by file so earlier files still save", async () => {
        const files = ["a.txt", "b.txt", "c.txt"];
        await Promise.all(files.map((file) => writeFile(path.join(root, file), `${file}\n`)));
        const attempts: string[] = [];
        const store = {
            get: () => ({ revision: 7, activeId: "a", files: {}, changes: {} }),
            revision: () => 7,
            trackBatch: vi.fn(async (_root: string, entries: { file: string }[]) => {
                attempts.push(`batch ${entries.map((entry) => entry.file).join(",")}`);
                throw new ChangelistEvidenceError("damaged");
            }),
            track: vi.fn(async (_root: string, file: string) => {
                attempts.push(`track ${file}`);
                if (file === "b.txt") throw new ChangelistEvidenceError("damaged");
            }),
            requireReview: vi.fn().mockResolvedValue(undefined),
        } as unknown as ChangelistStore;

        await expect(
            new ChangeRangeTracker(root, fakePartial(root), store).reconcile(modified(files)),
        ).rejects.toBeInstanceOf(ChangelistEvidenceError);

        expect(attempts, "damaged evidence must stop at its own file, as before batching").toEqual([
            "batch a.txt,b.txt,c.txt",
            "track a.txt",
            "track b.txt",
        ]);
    });
});

function fakePartial(root: string): PartialChanges {
    return {
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
}

function modified(files: readonly string[]): WorkingFile[] {
    return files.map((file) => ({
        path: file,
        status: "M",
        staged: false,
        additions: 1,
        deletions: 0,
    }));
}
