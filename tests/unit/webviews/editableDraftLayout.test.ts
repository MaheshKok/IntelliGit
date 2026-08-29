import { describe, expect, it } from "vitest";
import {
    sameEffectiveEditableBlockLayout,
    type EditableBlockLayout,
} from "../../../src/webviews/react/diff-viewer/editableDraftLayout";

/** Creates a stable layout fixture with one targeted geometry field overridden. */
function layout(overrides: Partial<EditableBlockLayout> = {}): EditableBlockLayout {
    return {
        side: "right",
        indices: [4, 7],
        rowCount: 3,
        pendingGrowthTargetIndex: 7,
        maxLineLength: 18,
        ...overrides,
    };
}

describe("sameEffectiveEditableBlockLayout", () => {
    it("treats identical layout geometry as equal", () => {
        expect(sameEffectiveEditableBlockLayout(layout(), layout(), 20)).toBe(true);
    });

    it("treats draft widths below the base diff width as equal", () => {
        expect(
            sameEffectiveEditableBlockLayout(
                layout({ maxLineLength: 19 }),
                layout({ maxLineLength: 20 }),
                20,
            ),
        ).toBe(true);
    });

    it("detects a draft width crossing the base diff width", () => {
        expect(
            sameEffectiveEditableBlockLayout(
                layout({ maxLineLength: 20 }),
                layout({ maxLineLength: 21 }),
                20,
            ),
        ).toBe(false);
    });

    it.each([
        ["row count", { rowCount: 4 }],
        ["side", { side: "left" as const }],
        ["indices", { indices: [4, 8] }],
        ["pending growth target", { pendingGrowthTargetIndex: 4 }],
    ])("detects a change in %s", (_label, change) => {
        expect(sameEffectiveEditableBlockLayout(layout(), layout(change), 20)).toBe(false);
    });

    it("detects opening and closing the active layout", () => {
        expect(sameEffectiveEditableBlockLayout(null, layout(), 20)).toBe(false);
        expect(sameEffectiveEditableBlockLayout(layout(), null, 20)).toBe(false);
    });
});
