import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { changeFingerprint } from "../../../src/changes/parseDiff";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";

function snapshotOf(file: string) {
    return rangeSnapshot({
        view: { base: "", blocks: [] },
        working: `${file}\n`,
        contentId: changeFingerprint(file),
        head: "a".repeat(40),
        indexHash: changeFingerprint("index"),
    } as unknown as Parameters<typeof rangeSnapshot>[0]);
}

describe("range tracking writes", () => {
    afterEach(() => vi.restoreAllMocks());

    it("never serializes the whole state to detect an unchanged range write", async () => {
        const store = new ChangelistStore();
        await store.track("/one", "seed.txt", snapshotOf("seed.txt"));
        const stringify = vi.spyOn(JSON, "stringify");

        const changed = await store.track("/one", "a.txt", snapshotOf("a.txt"));
        const unchanged = await store.track("/one", "a.txt", snapshotOf("a.txt"));

        const wholeState = stringify.mock.calls.filter(
            ([value]) =>
                typeof value === "object" &&
                value !== null &&
                "changes" in value &&
                "revision" in value,
        );
        expect(
            wholeState.length,
            "a range write must not serialize the whole changelist state",
        ).toBe(0);
        expect(unchanged.revision, "re-tracking an identical snapshot must not bump").toBe(
            changed.revision,
        );
    });

    it("tracks a batch in one revision and one notification", async () => {
        const store = new ChangelistStore();
        for (const file of ["seed1.txt", "seed2.txt"])
            await store.track("/one", file, snapshotOf(file));
        const notified: number[] = [];
        store.subscribe((_root, state) => notified.push(state.revision));
        const start = store.revision("/one");

        const batch = ["a.txt", "b.txt", "c.txt"].map((file) => ({
            file,
            snapshot: snapshotOf(file),
        }));
        const tracked = await store.trackBatch("/one", batch, start);
        const unchanged = await store.trackBatch("/one", batch, tracked.revision);

        expect(tracked.revision, "one batch is one revision").toBe(start + 1);
        expect(Object.keys(tracked.changes).sort()).toEqual([
            "a.txt",
            "b.txt",
            "c.txt",
            "seed1.txt",
            "seed2.txt",
        ]);
        expect(unchanged.revision, "re-tracking identical snapshots must not bump").toBe(
            tracked.revision,
        );
        expect(notified, "one batch notifies once").toEqual([start + 1]);
    });

    it("saves a batch whose last file is unchanged", async () => {
        const store = new ChangelistStore();
        const first = await store.trackBatch(
            "/one",
            ["a.txt", "b.txt"].map((file) => ({ file, snapshot: snapshotOf(file) })),
        );

        const next = await store.trackBatch(
            "/one",
            [
                { file: "a.txt", snapshot: snapshotOf("a.txt edited") },
                { file: "b.txt", snapshot: snapshotOf("b.txt") },
            ],
            first.revision,
        );

        expect(next.revision, "an earlier file's change must survive an unchanged last file").toBe(
            first.revision + 1,
        );
    });
});

describe("worktree changelist metadata", () => {
    it("prepares only the staging scope with revision CAS under a shared lease", async () => {
        const store = new ChangelistStore();
        let state = await store.create("/one", 0, "Feature");
        const feature = state.lists[1].id;
        state = await store.recordSelection("/one", "one.txt", "content", "all", ["0:2"], 3);
        const file = { path: "one.txt", contentId: "content", lineIds: ["0:1"], total: 3 };
        await expect(
            store.prepareStageInclusion("/one", state.revision, feature, file),
        ).rejects.toThrow("lease");
        const release = await store.beginCommit("/one");
        try {
            await expect(
                store.prepareStageInclusion("/one", state.revision - 1, feature, file),
            ).rejects.toThrow("changed");
            const prepared = await store.prepareStageInclusion(
                "/one",
                state.revision,
                feature,
                file,
            );
            expect(prepared.changes["one.txt"].selections?.all.lineIds).toEqual(["0:2"]);
            expect(prepared.changes["one.txt"].selections?.[feature].lineIds).toEqual(["0:1"]);
        } finally {
            release();
        }
    });
    it("restores only overwritten scope choices and removes newly-created inclusion", async () => {
        const store = new ChangelistStore();
        let state = await store.create("/one", 0, "Feature");
        const feature = state.lists[1].id;
        state = await store.recordSelection("/one", "one.txt", "before", "all", ["0:2"], 3);
        const previous = state;
        const release = await store.beginCommit("/one");
        try {
            const attempted = await store.prepareCommitInclusion("/one", state.revision, feature, [
                { path: "one.txt", contentId: "before", lineIds: ["0:1"], total: 3 },
            ]);
            const restored = await store.restoreCommitInclusion(
                "/one",
                previous,
                attempted,
                feature,
                ["one.txt"],
            );
            expect(restored.changes["one.txt"].selections).toEqual(
                previous.changes["one.txt"].selections,
            );
        } finally {
            release();
        }
    });
    it("persists both named and All inclusion only under an owned commit lease", async () => {
        const store = new ChangelistStore();
        let state = await store.create("/one", 0, "Feature");
        const id = state.lists[1].id;
        const inclusion = [{ path: "one.txt", contentId: "snapshot", lineIds: ["0:1"], total: 2 }];
        await expect(
            store.prepareCommitInclusion("/one", state.revision, id, inclusion),
        ).rejects.toThrow("lease");
        const release = await store.beginCommit("/one");
        try {
            state = await store.prepareCommitInclusion("/one", state.revision, id, inclusion);
            expect(state.changes["one.txt"].selections?.all).toEqual(
                state.changes["one.txt"].selections?.[id],
            );
            expect(state.changes["one.txt"].selections?.all.lineIds).toEqual(["0:1"]);
        } finally {
            release();
        }
    });
    it("persists lists and active membership without invoking Git", async () => {
        const values = new Map<string, unknown>();
        const storage = {
            get: <T>(key: string) => values.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                values.set(key, structuredClone(value));
            },
        };
        const store = new ChangelistStore(storage);
        let state = await store.create("/one", 0, "Feature");
        const feature = state.lists[1].id;
        state = await store.activate("/one", state.revision, feature);
        state = await store.reconcileFiles("/one", ["one.txt", "__proto__"]);
        expect(state.files["one.txt"]).toBe(feature);
        expect(Object.hasOwn(state.files, "__proto__")).toBe(true);
        expect(new ChangelistStore(storage).get("/one")).toEqual(state);
        expect(store.get("/two").files).toEqual({});
    });

    it("rejects stale concurrent metadata mutations and preserves the accepted one", async () => {
        const store = new ChangelistStore();
        const accepted = store.create("/one", 0, "First");
        const rejected = store.create("/one", 0, "Second");
        await expect(accepted).resolves.toMatchObject({ revision: 1 });
        await expect(rejected).rejects.toThrow("changed");
        expect(store.get("/one").lists).toHaveLength(2);
    });

    it("moves removed-list members to Default without losing files", async () => {
        const store = new ChangelistStore();
        let state = await store.create("/one", 0, "Feature");
        const feature = state.lists[1].id;
        state = await store.reconcileFiles("/one", ["one.txt"]);
        state = await store.moveFiles("/one", state.revision, feature, ["one.txt"]);
        state = await store.remove("/one", state.revision, feature);
        expect(state.files).toEqual({ "one.txt": "default" });
        state = await store.remove("/one", state.revision, "default");
        expect(state.lists).toHaveLength(1);
        expect(state.lists[0].name).toBe("Changes");
        expect(state.activeId).not.toBe("default");
        expect(state.files["one.txt"]).toBe(state.activeId);
    });

    it("prunes only records still owned as observed", async () => {
        const store = new ChangelistStore();
        let state = await store.create("/one", 0, "Feature");
        const feature = state.lists[1].id;
        state = await store.reconcileFiles("/one", ["unchanged.txt", "moved.txt"]);
        const observed = new Map(Object.entries(state.files));
        state = await store.moveFiles("/one", state.revision, feature, ["moved.txt"]);
        state = await store.reconcileFiles("/one", [], undefined, observed);
        expect(state.files["unchanged.txt"], "a record still owned as observed is pruned").toBe(
            undefined,
        );
        expect(state.files["moved.txt"], "a record moved since it was observed survives").toBe(
            feature,
        );
    });

    it("marks per-line ownership stale after content changes and requires explicit review", async () => {
        const store = new ChangelistStore();
        let state = await store.reconcileFiles("/one", ["one.txt"]);
        state = await store.registerChanges("/one", "one.txt", "first");
        const fingerprint = "a".repeat(64);
        state = await store.assignChanges(
            "/one",
            state.revision,
            "one.txt",
            "first",
            "default",
            [fingerprint],
            new Set([fingerprint]),
        );
        state = await store.registerChanges("/one", "one.txt", "second");
        expect(state.changes["one.txt"].stale).toBe(true);
        await expect(
            store.assignChanges(
                "/one",
                state.revision,
                "one.txt",
                "first",
                "default",
                [fingerprint],
                new Set([fingerprint]),
            ),
        ).rejects.toThrow("stale");
        state = await store.assignChanges(
            "/one",
            state.revision,
            "one.txt",
            "second",
            "default",
            [fingerprint],
            new Set([fingerprint]),
        );
        expect(state.changes["one.txt"].stale).toBe(false);
    });

    it("does not publish a failed persistence mutation", async () => {
        const store = new ChangelistStore({
            get: () => undefined,
            update: async () => {
                throw new Error("disk failure");
            },
        });
        await expect(store.create("/one", 0, "Feature")).rejects.toThrow("disk failure");
        expect(store.get("/one").revision).toBe(0);
    });

    it("keeps commit inclusion separate from line ownership and preserves stale choices", async () => {
        const store = new ChangelistStore();
        await store.reconcileFiles("/one", ["one.txt"]);
        let state = await store.registerChanges("/one", "one.txt", "first", 4);
        state = await store.recordSelection("/one", "one.txt", "first", "all", ["0:1"], 4);
        expect(state.changes["one.txt"].lines).toEqual({});
        expect(state.changes["one.txt"].selections?.all.lineIds).toEqual(["0:1"]);
        state = await store.registerChanges("/one", "one.txt", "second", 6);
        expect(state.changes["one.txt"].selections?.all.contentId).toBe("first");
        state = await store.resetSelection("/one", state.revision, "all", ["one.txt"]);
        expect(state.changes["one.txt"].selections?.all).toBeUndefined();
    });

    it("does not erase unreviewed assignments with a subset replacement", async () => {
        const store = new ChangelistStore();
        let state = await store.registerChanges("/one", "one.txt", "old");
        const first = "a".repeat(64);
        const second = "b".repeat(64);
        state = await store.assignChanges(
            "/one",
            state.revision,
            "one.txt",
            "old",
            "default",
            [first, second],
            new Set([first, second]),
        );
        state = await store.registerChanges("/one", "one.txt", "new");
        await expect(
            store.assignChanges(
                "/one",
                state.revision,
                "one.txt",
                "new",
                "default",
                [first],
                new Set([first, second]),
            ),
        ).rejects.toThrow("all current");
        expect(store.get("/one").changes["one.txt"].lines).toEqual({
            [first]: "default",
            [second]: "default",
        });
    });

    it("retains corrupt metadata rather than overwriting another root's records", async () => {
        const original = { schemaVersion: 2, entries: [{ root: "/one", state: {} }] };
        let written = false;
        const store = new ChangelistStore({
            get: <T>() => original as T,
            update: async () => {
                written = true;
            },
        });
        expect(() => store.get("/one")).toThrow("will not be overwritten");
        await expect(store.create("/two", 0, "New")).rejects.toThrow();
        expect(written).toBe(false);
    });

    it("shares a root commit lease across providers without blocking another repository", async () => {
        const storage = { get: <T>() => undefined as T | undefined, update: async () => undefined };
        const first = ChangelistStore.forStorage(storage);
        const second = ChangelistStore.forStorage(storage);
        expect(second).toBe(first);
        const release = await first.beginCommit("/one");
        expect(second.isCommitting("/one")).toBe(true);
        await expect(second.beginCommit("/one")).rejects.toThrow("in progress");
        await expect(second.create("/one", 0, "Blocked")).rejects.toThrow("during");
        await expect(
            second.recordSelection("/one", "one.txt", "content", "all", [], 0),
        ).rejects.toThrow("during");
        await expect(second.create("/two", 0, "Other root")).resolves.toMatchObject({
            revision: 1,
        });
        release();
        release();
        expect(second.isCommitting("/one")).toBe(false);
        await expect(second.create("/one", 0, "Accepted")).resolves.toMatchObject({ revision: 1 });
    });

    it("consumes only committed ownership and leaves explicit empty inclusion for the remainder", async () => {
        const store = new ChangelistStore();
        let state = await store.create("/one", 0, "Other");
        const other = state.lists[1].id;
        const first = "a".repeat(64);
        const second = "b".repeat(64);
        state = await store.registerChanges("/one", "one.txt", "before", 4);
        state = await store.assignChanges(
            "/one",
            state.revision,
            "one.txt",
            "before",
            "default",
            [first],
            new Set([first, second]),
        );
        state = await store.assignChanges(
            "/one",
            state.revision,
            "one.txt",
            "before",
            other,
            [second],
            new Set([first, second]),
        );
        await store.recordSelection("/one", "one.txt", "before", "all", ["0:1"], 4);
        const release = await store.beginCommit("/one");
        try {
            state = await store.consumeCommitted(
                "/one",
                "one.txt",
                "after",
                "all",
                new Set([first]),
                new Set([second]),
                2,
            );
            expect(state.changes["one.txt"]).toMatchObject({
                contentId: "after",
                lines: { [second]: other },
                stale: false,
                selections: { all: { contentId: "after", lineIds: [], total: 2 } },
            });
            expect(state.changes["one.txt"].lines[first]).toBeUndefined();
            state = await store.consumeCommitted(
                "/one",
                "one.txt",
                "shifted",
                "all",
                new Set(),
                new Set(),
                2,
            );
            expect(state.changes["one.txt"].stale).toBe(true);
        } finally {
            release();
        }
    });
});
