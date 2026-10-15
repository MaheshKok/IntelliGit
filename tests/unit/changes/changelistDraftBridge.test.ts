import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { changelistDraftBridge } from "../../../src/views/changelistDraftBridge";

function fixture() {
    const values = new Map<string, unknown>();
    const storage = {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
        keys: () => [...values.keys()],
    } satisfies vscode.Memento;
    return { storage, store: ChangelistStore.forStorage(storage) };
}

describe("native changelist draft routing", () => {
    it("serializes rapid edits to the captured list across focus and worktree changes", async () => {
        const { storage, store } = fixture();
        const state = await store.create("/one", 0, "Feature");
        const feature = state.lists[1].id;
        store.selectDraft("/one", feature);
        const delivered = vi.fn();
        const docked = changelistDraftBridge(storage, delivered);
        const undocked = changelistDraftBridge(storage, delivered);
        docked.persistDraft("/one", "f");
        docked.persistDraft("/one", "fi");
        docked.persistDraft("/one", "fix");
        store.selectDraft("/one", "all");
        undocked.persistDraft("/two", "other checkout");
        await vi.waitFor(() => expect(store.draft("/one", feature)).toBe("fix"));
        await vi.waitFor(() => expect(store.draft("/two", "all")).toBe("other checkout"));
        expect(store.draft("/one", "all")).toBe("");
        expect(delivered).not.toHaveBeenCalledWith("/one", expect.anything());
        store.selectDraft("/one", feature);
        expect(undocked.readDraft("/one")).toBe("fix");
        expect(new ChangelistStore(storage).draft("/one", feature)).toBe("fix");
    });

    it("redirects the native mirror after deletion but rejects callbacks bearing the deleted ID", async () => {
        const { storage, store } = fixture();
        let state = await store.create("/one", 0, "Feature");
        const feature = state.lists[1].id;
        state = await store.saveDraft("/one", feature, "", "source draft");
        store.selectDraft("/one", feature);
        state = await store.remove("/one", state.revision, feature, "default");
        expect(state.removedScopes?.[feature]).toBe("default");
        expect(store.mirrorScope("/one")).toBe("default");
        expect(changelistDraftBridge(storage, vi.fn()).readDraft("/one")).toBe("source draft");
        await expect(store.saveDraft("/one", feature, "source draft", "late")).rejects.toThrow(
            "no longer exists",
        );
        expect(new ChangelistStore(storage).get("/one").removedScopes).toEqual({
            [feature]: "default",
        });
    });
});
