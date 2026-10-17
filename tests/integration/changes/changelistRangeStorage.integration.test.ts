import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { changeFingerprint as hash, parseChangeDiff } from "../../../src/changes/parseDiff";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import { MAX_PARTIAL_TEXT_BYTES } from "../../../src/git/partialSnapshot";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let root: string;
let gitDir: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-range-storage-"));
    gitDir = path.join(root, ".git");
    await mkdir(gitDir);
});
afterEach(async () => {
    await removeScratchDirectories(root);
});

/** Produces validated ordinary-text evidence with one independently owned insertion. */
function snapshot(file: string, lineCount: number, version?: number) {
    const lines = Array.from({ length: lineCount }, (_, line) => `${file} line ${line}\n`);
    const base = lines.join("");
    const insertion = Math.floor(lineCount / 2);
    const added = `${file} inserted version ${version}\n`;
    const working =
        version === undefined
            ? base
            : [...lines.slice(0, insertion), added, ...lines.slice(insertion)].join("");
    const diff =
        version === undefined ? "" : `@@ -${insertion},0 +${insertion + 1},1 @@\n+${added}`;
    const blocks = parseChangeDiff(diff, base, working);
    expect(Buffer.byteLength(base)).toBeLessThan(MAX_PARTIAL_TEXT_BYTES);
    expect(Buffer.byteLength(working)).toBeLessThan(MAX_PARTIAL_TEXT_BYTES);
    const contentId = hash(JSON.stringify([base, working, blocks]));
    return rangeSnapshot({
        root,
        gitDir,
        commonDir: gitDir,
        indexPath: path.join(gitDir, "index"),
        head: "a".repeat(40),
        ref: "refs/heads/main",
        indexHash: hash(base),
        worktreeHash: hash(working),
        attributes: "",
        mode: "100644",
        indexed: base,
        working,
        contentId,
        view: { snapshotId: contentId, path: file, side: "working", base, blocks },
    });
}

describe("durable range evidence", () => {
    it("aggregate range evidence does not block drafts or assignments", async () => {
        const fixtures = Array.from({ length: 32 }, (_, file) => ({
            file: `file-${file}.txt`,
            snapshots: [0, 1, 2].map((version) => snapshot(`file-${file}.txt`, 6_000, version)),
        }));
        const inlineEvidenceBytes = fixtures.reduce(
            (total, fixture) =>
                total +
                fixture.snapshots.reduce(
                    (bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)),
                    0,
                ),
            0,
        );
        expect(
            inlineEvidenceBytes,
            "real current and historical evidence must exceed the old aggregate budget",
        ).toBeGreaterThan(64 * 1024 * 1024);

        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        let state = await store.create(root, store.get(root).revision, "Feature");
        const feature = state.lists[1].id;
        for (const [index, fixture] of fixtures.entries()) {
            for (const [version, current] of fixture.snapshots.entries()) {
                await expect(
                    store.track(root, fixture.file, current).then((next) => {
                        state = next;
                    }),
                    `aggregate evidence must not block tracking ${fixture.file} version ${version}`,
                ).resolves.toBeUndefined();
                if (index === 0 && version === 0) {
                    const fingerprints = current.anchors.map((anchor) => anchor.fingerprint);
                    state = await store.assignChanges(
                        root,
                        state.revision,
                        fixture.file,
                        current.contentId,
                        feature,
                        fingerprints,
                        new Set(fingerprints),
                    );
                    state = await store.recordSelection(
                        root,
                        fixture.file,
                        current.contentId,
                        "all",
                        [],
                        current.anchors.length,
                    );
                }
            }
        }
        await expect(
            store.saveDraft(root, "all", "", "Draft after tracking large files"),
            "aggregate evidence must not block a draft",
        ).resolves.toBeDefined();
        state = await store.moveFiles(root, store.get(root).revision, feature, [
            fixtures.at(-1)!.file,
        ]);
        expect(state.files[fixtures.at(-1)!.file]).toBe(feature);
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        const persisted = reopened.get(root);
        expect(reopened.draft(root, "all")).toBe("Draft after tracking large files");
        expect(Object.keys(persisted.files)).toHaveLength(32);
        for (const [index, fixture] of fixtures.entries()) {
            const ownership = persisted.changes[fixture.file];
            expect(ownership.contentId).toBe(fixture.snapshots[2].contentId);
            expect(ownership.stale).toBe(false);
            expect(ownership.history).toHaveLength(2);
            expect(persisted.files[fixture.file]).toBe(
                index === fixtures.length - 1 ? feature : "default",
            );
            expect(ownership.lines).toEqual(
                index === 0 ? { [fixture.snapshots[2].anchors[0].fingerprint]: feature } : {},
            );
        }
        expect(persisted.changes[fixtures[0].file].selections?.all).toEqual({
            contentId: fixtures[0].snapshots[2].contentId,
            lineIds: [],
            total: 1,
        });
    }, 180_000);

    it("restores historical ownership after reconnect and remaps a removed list before redo", async () => {
        const file = "owned.txt";
        const inserted = snapshot(file, 20, 0);
        const clean = snapshot(file, 20);
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        let state = await store.create(root, store.get(root).revision, "Feature");
        const feature = state.lists[1].id;
        state = await store.track(root, file, inserted);
        const fingerprints = inserted.anchors.map((anchor) => anchor.fingerprint);
        state = await store.assignChanges(
            root,
            state.revision,
            file,
            inserted.contentId,
            feature,
            fingerprints,
            new Set(fingerprints),
        );
        await store.recordSelection(root, file, inserted.contentId, "all", [], 1);
        await store.track(root, file, clean);

        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        state = await reopened.track(root, file, inserted);
        expect(state.changes[file].lines).toEqual({ [fingerprints[0]]: feature });
        expect(state.changes[file].selections?.all.lineIds).toEqual([]);
        state = await reopened.track(root, file, clean);
        await reopened.remove(root, state.revision, feature);
        const afterRemoval = new ChangelistStore();
        await afterRemoval.connect(root, gitDir);
        state = await afterRemoval.track(root, file, inserted);
        expect(state.changes[file].lines).toEqual({});
        expect(state.files[file]).toBe("default");
        expect(state.changes[file].stale).toBe(false);
        expect(state.changes[file].selections?.all.lineIds).toEqual([]);
    });
});
