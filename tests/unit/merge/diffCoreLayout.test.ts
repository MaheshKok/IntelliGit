import { describe, expect, it } from "vitest";
import {
    buildVerticalLayout,
    paneOffsetForCanonical,
    ribbonOutlineD,
    ribbonPathD,
    type SegmentPaneLines,
} from "../../../src/webviews/react/diff-core/mergeScrollLayout";

describe("diff-core pane layouts", () => {
    it("maps a two-pane layout through canonical space and one adjacent ribbon", () => {
        const paneIds = ["ours", "result"] as const;
        const segments: SegmentPaneLines<(typeof paneIds)[number]>[] = [
            { paneLines: { ours: 1, result: 3 }, conflict: true, id: 7 },
            { paneLines: { ours: 2, result: 2 }, conflict: false },
        ];

        const layout = buildVerticalLayout(segments, paneIds);

        expect(layout.canonicalTopPx).toEqual([0, 60]);
        expect(layout.canonicalHPx).toEqual([60, 40]);
        expect(layout.paneTopPx).toEqual({ ours: [0, 20], result: [0, 60] });
        expect(layout.paneHPx).toEqual({ ours: [20, 40], result: [60, 40] });
        expect(layout.paneTotalPx).toEqual({ ours: 60, result: 100 });
        expect(layout.hunkCanonical.get(7)).toEqual({ top: 0, height: 60 });
        expect(paneOffsetForCanonical(layout, "ours", 30)).toBe(10);
        expect(paneOffsetForCanonical(layout, "result", 30)).toBe(30);

        expect(ribbonPathD({ x0: 0, curveX0: 10, curveX1: 20, x1: 30 }, 0, 20, 10, 30)).toBe(
            "M 0,0 L 10,0 C 13,0 17,10 20,10 L 30,10" +
                " L 30,30 L 20,30 C 17,30 13,20 10,20 L 0,20 Z",
        );
        expect(ribbonOutlineD({ x0: 0, curveX0: 10, curveX1: 20, x1: 30 }, 0, 20, 10, 30)).toBe(
            "M 0.5,0 L 10,0 L 10,20 L 0.5,20 Z" +
                " M 10,0 C 13,0 17,10 20,10" +
                " M 10,20 C 13,20 17,30 20,30" +
                " M 20,10 L 29.5,10 L 29.5,30 L 20,30 Z",
        );
    });

    it("keeps three-pane geometry as two independent adjacent ribbons", () => {
        const paneIds = ["left", "middle", "right"] as const;
        const segments: SegmentPaneLines<(typeof paneIds)[number]>[] = [
            { paneLines: { left: 2, middle: 1, right: 3 }, conflict: true, id: 9 },
        ];
        const layout = buildVerticalLayout(segments, paneIds);

        expect(layout.canonicalTotalPx).toBe(60);
        expect(layout.paneTotalPx).toEqual({ left: 40, middle: 20, right: 60 });
        expect(ribbonPathD({ x0: 0, curveX0: 10, curveX1: 20, x1: 30 }, 0, 40, 10, 30)).toBe(
            "M 0,0 L 10,0 C 13,0 17,10 20,10 L 30,10" +
                " L 30,30 L 20,30 C 17,30 13,40 10,40 L 0,40 Z",
        );
        expect(ribbonPathD({ x0: 40, curveX0: 50, curveX1: 60, x1: 70 }, 10, 30, 0, 60)).toBe(
            "M 40,10 L 50,10 C 53,10 57,0 60,0 L 70,0" +
                " L 70,60 L 60,60 C 57,60 53,30 50,30 L 40,30 Z",
        );
    });
});
