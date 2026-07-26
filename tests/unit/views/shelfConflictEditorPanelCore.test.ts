import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import {
    createShelfConflictEditorMessageHandler,
    type ShelfConflictEditorMessageDeps,
} from "../../../src/views/ShelfConflictEditorPanel";

const payload = {
    path: "src/file.ts",
    base: "base\n",
    current: "local\n",
    patchedBase: "shelved\n",
    worktreeFingerprint: "644:fingerprint",
    shelfGeneration: 4,
};

function makeDeps(overrides: Partial<ShelfConflictEditorMessageDeps> = {}) {
    const apply = vi.fn(async () => ({ status: "applied" as const, newGeneration: 5 }));
    const postConflictData = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const onApplied = vi.fn(async () => undefined);
    const chooseStaleResolution = vi.fn(async () => "keep" as const);
    return {
        shelfId: "shelf-a",
        changeId: "change-a",
        apply,
        postConflictData,
        dispose,
        onApplied,
        chooseStaleResolution,
        ...overrides,
        payload,
    } satisfies ShelfConflictEditorMessageDeps;
}

describe("ShelfConflictEditorPanel message core", () => {
    it("rejects non-string resolution content before calling the service", async () => {
        const deps = makeDeps();
        const handle = createShelfConflictEditorMessageHandler(deps);

        await expect(handle({ type: "applyResolution", content: 12 })).rejects.toThrow(
            "must be a string",
        );
        expect(deps.apply).not.toHaveBeenCalled();
    });

    it("offers the explicit stale override and parks through the second guarded apply", async () => {
        const apply = vi
            .fn()
            .mockResolvedValueOnce({ status: "stale" as const, reason: "path" as const })
            .mockResolvedValueOnce({ status: "applied" as const, newGeneration: 5 });
        const deps = makeDeps({
            apply,
            chooseStaleResolution: vi.fn(async () => "overwrite" as const),
        });
        const handle = createShelfConflictEditorMessageHandler(deps);

        await handle({ type: "applyResolution", content: "merged\n" });

        expect(apply).toHaveBeenNthCalledWith(1, {
            id: "shelf-a",
            changeId: "change-a",
            content: "merged\n",
            expectedShelfGeneration: 4,
            expectedPathFingerprint: "644:fingerprint",
        });
        expect(apply).toHaveBeenNthCalledWith(2, {
            id: "shelf-a",
            changeId: "change-a",
            content: "merged\n",
            expectedShelfGeneration: 4,
            expectedPathFingerprint: "644:fingerprint",
            staleOverride: "overwriteParkingCurrent",
        });
        expect(deps.onApplied).toHaveBeenCalledOnce();
        expect(deps.dispose).toHaveBeenCalledOnce();
    });

    it("routes accept-side commands to the immutable local and shelved contents", async () => {
        const ours = makeDeps();
        await createShelfConflictEditorMessageHandler(ours)({ type: "acceptYours" });
        expect(ours.apply).toHaveBeenCalledWith(expect.objectContaining({ content: "local\n" }));

        const theirs = makeDeps();
        await createShelfConflictEditorMessageHandler(theirs)({ type: "acceptTheirs" });
        expect(theirs.apply).toHaveBeenCalledWith(
            expect.objectContaining({ content: "shelved\n" }),
        );
    });

    it("reposts segments for the supported diff mode and ignores conflict-session opening", async () => {
        const deps = makeDeps();
        const handle = createShelfConflictEditorMessageHandler(deps);

        await handle({ type: "setIgnoreMode", mode: "whitespace" });
        await handle({ type: "openConflictSession" });

        expect(deps.postConflictData).toHaveBeenCalledWith({ ignoreWhitespace: true });
    });

    it("disposes on close and abort without applying or restoring anything", async () => {
        const deps = makeDeps();
        const handle = createShelfConflictEditorMessageHandler(deps);

        await handle({ type: "abortMerge" });
        expect(deps.dispose).toHaveBeenCalledOnce();
        expect(deps.apply).not.toHaveBeenCalled();
    });
});
