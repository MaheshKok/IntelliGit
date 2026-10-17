import { describe, expect, it } from "vitest";
import { ChangelistStore } from "../../../src/changes/changelistStore";

const key = "intelligit.changelists.v1";
const feature = "00000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

function legacy() {
    return {
        schemaVersion: 1,
        entries: [
            {
                root: "/worktree/a",
                state: {
                    revision: 7,
                    activeId: feature,
                    lists: [
                        { id: "default", name: "Default" },
                        { id: feature, name: "計算" },
                    ],
                    files: { "calculator.ts": "default" },
                    changes: {
                        "calculator.ts": {
                            contentId: "snapshot",
                            totalChanges: 4,
                            lines: { [fingerprint]: feature },
                            stale: true,
                            selections: {
                                all: { contentId: "old", lineIds: [], total: 4 },
                                [feature]: { contentId: "snapshot", lineIds: ["0:1"], total: 4 },
                            },
                        },
                    },
                },
            },
        ],
    };
}

function persistence(initial: unknown = legacy()) {
    const values = new Map<string, unknown>([
        [key, initial],
        ["commitDraft:/worktree/a", "legacy aggregate"],
    ]);
    const writes: string[] = [];
    let fail: string | undefined;
    return {
        values,
        writes,
        failAt: (value?: string) => {
            fail = value;
        },
        get: <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
        update: async (name: string, value: unknown) => {
            writes.push(name);
            if (name === fail) throw new Error("disk unavailable");
            values.set(name, structuredClone(value));
        },
    };
}

describe("changelist schema and lifecycle", () => {
    it("creates and moves whole files in one revision while rejecting a stale move without orphaning a list", async () => {
        const store = new ChangelistStore();
        let state = await store.reconcileFiles("/one", ["a.txt", "b.txt"]);
        const before = state;
        await expect(
            store.create("/one", state.revision, "Cancelled", "notes", true, ["missing.txt"]),
        ).rejects.toThrow("file list changed");
        expect(store.get("/one")).toEqual(before);
        state = await store.create("/one", state.revision, "Feature", "design notes", false, [
            "a.txt",
        ]);
        const feature = state.lists.find((list) => list.name === "Feature")!;
        expect(state.revision).toBe(before.revision + 1);
        expect(state.activeId).toBe("default");
        expect(feature.description).toBe("design notes");
        expect(state.files).toEqual({ "a.txt": feature.id, "b.txt": "default" });
    });

    it("backs up v1 before publication and preserves IDs, labels, stale ownership and explicit emptiness on restart", async () => {
        const original = legacy();
        const storage = persistence(original);
        const store = new ChangelistStore(storage);
        const before = store.get("/worktree/a");
        expect(before.changes).toEqual(original.entries[0].state.changes);
        expect(before.lists[0].name).toBe("Default");
        expect(before.lists.map((list) => [list.id, list.draft, list.description])).toEqual([
            ["default", "", ""],
            [feature, "", ""],
        ]);
        expect(before.allDraft).toBe("legacy aggregate");
        const migrated = await store.reconcileFiles("/worktree/a", ["calculator.ts"]);
        expect(storage.writes).toEqual([`${key}.backup`, key]);
        expect(storage.values.get(`${key}.backup`)).toEqual(original);
        expect(storage.values.get(key)).toMatchObject({ schemaVersion: 2 });
        storage.values.set("commitDraft:/worktree/a", "stale old-client draft");
        const restarted = new ChangelistStore(storage);
        expect(restarted.get("/worktree/a")).toEqual(migrated);
        expect(restarted.draft("/worktree/a", "all")).toBe("legacy aggregate");
        await restarted.reconcileFiles("/worktree/a", ["calculator.ts"]);
        expect(storage.writes).toHaveLength(2);
    });

    it.each([`${key}.backup`, key])(
        "does not publish or mutate memory after an interrupted %s write",
        async (failedKey) => {
            const storage = persistence();
            const store = new ChangelistStore(storage);
            const before = store.get("/worktree/a");
            storage.failAt(failedKey);
            await expect(
                store.edit("/worktree/a", before.revision, "default", "Changes", "notes"),
            ).rejects.toThrow("disk unavailable");
            expect(store.get("/worktree/a")).toEqual(before);
            expect(storage.values.get(key)).toEqual(legacy());
            storage.failAt();
            const restarted = new ChangelistStore(storage);
            const saved = await restarted.edit(
                "/worktree/a",
                before.revision,
                "default",
                "Changes",
                "notes",
            );
            expect(new ChangelistStore(storage).get("/worktree/a")).toEqual(saved);
            expect(storage.values.get(`${key}.backup`)).toEqual(legacy());
        },
    );

    it.each([
        null,
        { schemaVersion: 5, entries: [] },
        { schemaVersion: 2, entries: legacy().entries },
    ])("refuses corrupt or future metadata without overwriting it (%j)", async (invalid) => {
        const storage = persistence(invalid);
        const store = new ChangelistStore(storage);
        expect(() => store.get("/worktree/a")).toThrow("will not be overwritten");
        await expect(store.create("/worktree/b", 0, "New")).rejects.toThrow();
        expect(storage.writes).toEqual([]);
        expect(storage.values.get(key)).toEqual(invalid);
    });

    it("keeps drafts and descriptions independent across lists, All and linked worktrees", async () => {
        const storage = persistence();
        const store = new ChangelistStore(storage);
        let state = await store.saveDraft("/worktree/a", feature, "", "fix calculation");
        state = await store.edit("/worktree/a", state.revision, feature, "計算", "Design notes");
        await store.saveDraft("/worktree/a", "default", "", "color change");
        await store.saveDraft("/worktree/b", "all", "", "another checkout");
        const restarted = new ChangelistStore(storage);
        expect(restarted.draft("/worktree/a", feature)).toBe("fix calculation");
        expect(restarted.draft("/worktree/a", "default")).toBe("color change");
        expect(restarted.draft("/worktree/a", "all")).toBe("legacy aggregate");
        expect(restarted.draft("/worktree/b", "all")).toBe("another checkout");
        expect(restarted.get("/worktree/a").lists[1].description).toBe("Design notes");
    });

    it("rejects late draft saves and removed-scope callbacks without contaminating the destination", async () => {
        const store = new ChangelistStore(persistence());
        const accepted = store.saveDraft("/worktree/a", feature, "", "newer text");
        const delayed = store.saveDraft("/worktree/a", feature, "", "late AI result");
        const state = await accepted;
        await expect(delayed).rejects.toThrow("draft changed");
        await store.remove("/worktree/a", state.revision, feature, "default");
        await expect(
            store.saveDraft("/worktree/a", feature, "newer text", "old pane"),
        ).rejects.toThrow("no longer exists");
        expect(store.draft("/worktree/a", "default")).toBe("newer text");
        expect(store.draft("/worktree/a", "all")).toBe("legacy aggregate");
    });

    it("requires an explicit draft conflict choice and cancels without changing ownership", async () => {
        const store = new ChangelistStore(persistence());
        await store.saveDraft("/worktree/a", "default", "", "destination");
        const before = await store.saveDraft("/worktree/a", feature, "", "source");
        await expect(
            store.remove("/worktree/a", before.revision, feature, "default"),
        ).rejects.toThrow("draft to keep");
        expect(store.get("/worktree/a")).toEqual(before);
        const after = await store.remove(
            "/worktree/a",
            before.revision,
            feature,
            "default",
            "append",
        );
        expect(after.activeId).toBe("default");
        expect(after.lists[0].draft).toBe("destination\n\nsource");
        expect(after.changes["calculator.ts"].lines).toEqual({ [fingerprint]: "default" });
        expect(after.changes["calculator.ts"].selections?.default.reviewRequired).toBe(true);
        expect(after.changes["calculator.ts"].selections?.default.lineIds).toEqual(["0:1"]);
        expect(after.changes["calculator.ts"].selections?.all.lineIds).toEqual([]);
    });

    it("preserves equivalent explicit empty selections when deleting a split owner", async () => {
        const store = new ChangelistStore(persistence());
        await store.recordSelection("/worktree/a", "calculator.ts", "snapshot", "default", [], 4);
        const state = await store.recordSelection(
            "/worktree/a",
            "calculator.ts",
            "snapshot",
            feature,
            [],
            4,
        );
        const after = await store.remove("/worktree/a", state.revision, feature, "default");
        expect(after.changes["calculator.ts"].selections?.default).toEqual({
            contentId: "snapshot",
            lineIds: [],
            total: 4,
        });
        expect(after.changes["calculator.ts"].selections?.[feature]).toBeUndefined();
    });

    it("renames and deletes the legacy default without a dangling active ID or a stale-pane fallback", async () => {
        const store = new ChangelistStore();
        let state = await store.rename("/one", 0, "default", "My changes");
        state = await store.reconcileFiles("/one", ["file.txt"]);
        state = await store.remove("/one", state.revision, "default");
        expect(state.lists).toHaveLength(1);
        expect(state.lists[0].name).toBe("Changes");
        expect(state.activeId).not.toBe("default");
        expect(state.files["file.txt"]).toBe(state.activeId);
        await expect(store.activate("/one", state.revision, "default")).rejects.toThrow(
            "no longer exists",
        );
        await expect(store.create("/one", state.revision, " changes ")).rejects.toThrow(
            "already exists",
        );
    });

    it("rejects whole-file moves that would erase partial ownership or explicit empty selections", async () => {
        const store = new ChangelistStore(persistence());
        const before = store.get("/worktree/a");
        await expect(
            store.moveFiles("/worktree/a", before.revision, "default", ["calculator.ts"]),
        ).rejects.toThrow("partial editor");
        expect(store.get("/worktree/a")).toEqual(before);
    });
});
