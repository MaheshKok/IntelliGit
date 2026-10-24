import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";

const mocks = vi.hoisted(() => ({
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
}));

vi.mock("vscode", () => ({
    window: {
        showQuickPick: mocks.showQuickPick,
        showInputBox: mocks.showInputBox,
    },
    l10n: {
        t: (message: string, args?: Record<string, string>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replace(`{${key}}`, value),
                message,
            ),
    },
}));

import {
    assertChangelistTargetCurrent,
    pickChangelistTarget,
} from "../../../src/commands/changelistTarget";

function state(): ChangelistState {
    return {
        revision: 7,
        activeId: "C",
        lists: [
            { id: "A", name: "Alpha", draft: "alpha draft" },
            { id: "B", name: "Beta", draft: "beta draft" },
            { id: "C", name: "Current", draft: "current draft" },
            { id: "D", name: "Destination", draft: "destination draft" },
        ],
        files: {},
        changes: {},
    };
}

describe("changelist target intent", () => {
    beforeEach(() => vi.clearAllMocks());

    it("target cancellation creates no list and changes no draft", async () => {
        const current = state();
        const before = structuredClone(current);
        mocks.showQuickPick.mockResolvedValueOnce(undefined);

        await expect(
            pickChangelistTarget({
                state: current,
                sourceLists: [
                    { id: "A", name: "Alpha", draft: "alpha draft" },
                    { id: "B", name: "Beta", draft: "beta draft" },
                ],
            }),
        ).resolves.toBeUndefined();
        expect(current).toEqual(before);
        expect(mocks.showInputBox).not.toHaveBeenCalled();
    });

    it("draft cancellation returns no intent and changes no draft", async () => {
        const current = state();
        const before = structuredClone(current);
        mocks.showQuickPick
            .mockImplementationOnce(async (items: Array<{ target?: { id?: string } }>) =>
                items.find((item) => item.target?.id === "D"),
            )
            .mockResolvedValueOnce(undefined);

        await expect(
            pickChangelistTarget({
                state: current,
                sourceLists: [{ id: "A", name: "Alpha", draft: "alpha draft" }],
            }),
        ).resolves.toBeUndefined();
        expect(current).toEqual(before);
    });

    it("new target remains inactive", async () => {
        const current = state();
        mocks.showQuickPick.mockImplementationOnce(async (items: Array<{ targetKind: string }>) =>
            items.find((item) => item.targetKind === "new"),
        );
        mocks.showInputBox.mockResolvedValueOnce("Recovered");

        await expect(pickChangelistTarget({ state: current })).resolves.toEqual({
            target: { kind: "new", name: "Recovered", revision: 7 },
        });
        expect(current.activeId).toBe("C");
        expect(current.lists.map((list) => list.id)).not.toContain("Recovered");
    });

    it("stale destination revision rejects before mutation", () => {
        expect(() =>
            assertChangelistTargetCurrent(state(), {
                kind: "existing",
                id: "D",
                revision: 6,
            }),
        ).toThrow("Changelists changed");
    });

    it("mixed source drafts are individually selectable and never concatenated", async () => {
        const current = state();
        mocks.showQuickPick
            .mockImplementationOnce(async (items: Array<{ target?: { id?: string } }>) =>
                items.find((item) => item.target?.id === "D"),
            )
            .mockImplementationOnce(async (items: Array<{ choice: { sourceListId?: string } }>) =>
                items.find((item) => item.choice.sourceListId === "B"),
            );

        await expect(
            pickChangelistTarget({
                state: current,
                sourceLists: [
                    { id: "A", name: "Alpha", draft: "alpha draft" },
                    { id: "B", name: "Beta", draft: "beta draft" },
                ],
            }),
        ).resolves.toEqual({
            target: { kind: "existing", id: "D", revision: 7 },
            draftChoice: {
                kind: "copySource",
                sourceListId: "B",
                expectedDestinationDraft: "destination draft",
            },
        });
        const draftItems = mocks.showQuickPick.mock.calls[1][0] as Array<{
            choice: { sourceListId?: string };
        }>;
        expect(
            draftItems
                .filter((item) => item.choice.sourceListId)
                .map((item) => item.choice.sourceListId),
        ).toEqual(["A", "B"]);
    });

    it("saved source absent from current state uses captured name and draft", async () => {
        const current = state();
        current.lists = current.lists.filter((list) => list.id !== "B");
        mocks.showQuickPick
            .mockImplementationOnce(async (items: Array<{ target?: { id?: string } }>) =>
                items.find((item) => item.target?.id === "D"),
            )
            .mockImplementationOnce(async (items: Array<{ choice: { sourceListId?: string } }>) =>
                items.find((item) => item.choice.sourceListId === "B"),
            );

        await expect(
            pickChangelistTarget({
                state: current,
                sourceLists: [{ id: "B", name: "Saved Beta", draft: "captured beta draft" }],
            }),
        ).resolves.toEqual({
            target: { kind: "existing", id: "D", revision: 7 },
            draftChoice: {
                kind: "copySource",
                sourceListId: "B",
                expectedDestinationDraft: "destination draft",
            },
        });
        const captured = (
            mocks.showQuickPick.mock.calls[1][0] as Array<{
                label: string;
                detail?: string;
                choice: { sourceListId?: string };
            }>
        ).find((item) => item.choice.sourceListId === "B");
        expect(captured).toMatchObject({ label: "Copy Draft from Saved Beta" });
        expect(captured?.detail).toContain("captured beta draft");
    });
});
