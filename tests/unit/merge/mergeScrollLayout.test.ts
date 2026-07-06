// Spec-derived tests for the pure vertical-geometry model. Expected pixel
// values are computed by hand from the fixture, not read back from the impl:
// every block is exactly lines * LINE_HEIGHT_PX (20) tall — no conflict chrome.

import { describe, expect, it } from "vitest";
import {
    buildVerticalLayout,
    paneOffsetForCanonical,
    type MergePane,
    type SegmentPaneLines,
} from "../../../src/webviews/react/merge-editor/mergeScrollLayout";

// common(3) | conflict id=0 ours=1/result=3/theirs=2 | common(2)
//
// heights (px):        left  middle  right  canonical
//   seg0 common(3)      60     60     60      60
//   seg1 conflict       20     60     40      60   (lines*20, no chrome)
//   seg2 common(2)      40     40     40      40
const FIXTURE: SegmentPaneLines[] = [
    { left: 3, middle: 3, right: 3, conflict: false },
    { left: 1, middle: 3, right: 2, conflict: true, id: 0 },
    { left: 2, middle: 2, right: 2, conflict: false },
];

describe("buildVerticalLayout", () => {
    it("stacks canonical tops from the tallest pane per segment", () => {
        const layout = buildVerticalLayout(FIXTURE);
        expect(layout.canonicalTopPx).toEqual([0, 60, 120]);
        expect(layout.canonicalHPx).toEqual([60, 60, 40]);
        expect(layout.canonicalTotalPx).toBe(160);
    });

    it("advances each pane by its own natural height, not the canonical height", () => {
        const layout = buildVerticalLayout(FIXTURE);
        // Left pane's 1-line conflict (20px) means seg2 starts at 80, not 120.
        expect(layout.paneTopPx.left).toEqual([0, 60, 80]);
        expect(layout.paneTopPx.middle).toEqual([0, 60, 120]);
        expect(layout.paneTopPx.right).toEqual([0, 60, 100]);
        expect(layout.paneTotalPx).toEqual({ left: 120, middle: 160, right: 140 });
    });

    it("maps each conflict id to its canonical extent for jump-to-hunk", () => {
        const layout = buildVerticalLayout(FIXTURE);
        expect(layout.hunkCanonical.get(0)).toEqual({ top: 60, height: 60 });
        expect(layout.hunkCanonical.has(1)).toBe(false);
    });

    it("returns zeroed geometry for an empty document", () => {
        const layout = buildVerticalLayout([]);
        expect(layout.canonicalTotalPx).toBe(0);
        expect(layout.paneTotalPx).toEqual({ left: 0, middle: 0, right: 0 });
        expect(paneOffsetForCanonical(layout, "left", 0, 100)).toBe(0);
    });
});

describe("paneOffsetForCanonical", () => {
    const layout = buildVerticalLayout(FIXTURE);
    const VIEWPORT = 40; // small enough that clamping does not swallow the proportional range

    it("aligns all panes at their own top on a segment boundary", () => {
        // Canonical 60 is the top of the conflict segment: each pane sits at its
        // own seg1 top (60), so unchanged code above the hunk stays in lockstep.
        expect(paneOffsetForCanonical(layout, "left", 60, VIEWPORT)).toBe(60);
        expect(paneOffsetForCanonical(layout, "middle", 60, VIEWPORT)).toBe(60);
        expect(paneOffsetForCanonical(layout, "right", 60, VIEWPORT)).toBe(60);
    });

    it("diverges proportionally to each pane's height mid-hunk", () => {
        // Halfway through the conflict (canonical 90 = 60 + 60/2): left advances
        // 10 (20/2), middle 30 (60/2), right 20 (40/2). A `-` interpolation would
        // yield 50 for the left pane instead of 70.
        expect(paneOffsetForCanonical(layout, "left", 90, VIEWPORT)).toBe(70);
        expect(paneOffsetForCanonical(layout, "middle", 90, VIEWPORT)).toBe(90);
        expect(paneOffsetForCanonical(layout, "right", 90, VIEWPORT)).toBe(80);
    });

    it("re-aligns panes at the next boundary after an unbalanced hunk", () => {
        expect(paneOffsetForCanonical(layout, "left", 120, VIEWPORT)).toBe(80);
        expect(paneOffsetForCanonical(layout, "middle", 120, VIEWPORT)).toBe(120);
        expect(paneOffsetForCanonical(layout, "right", 120, VIEWPORT)).toBe(100);
    });

    it("clamps to each pane's max offset at the document end", () => {
        // Beyond the last boundary every pane clamps to totalPx - viewportH.
        expect(paneOffsetForCanonical(layout, "left", 160, VIEWPORT)).toBe(80); // 120-40
        expect(paneOffsetForCanonical(layout, "middle", 160, VIEWPORT)).toBe(120); // 160-40
        expect(paneOffsetForCanonical(layout, "right", 160, VIEWPORT)).toBe(100); // 140-40
    });

    it("never returns a negative offset when the viewport exceeds content", () => {
        expect(paneOffsetForCanonical(layout, "middle", 0, 5000)).toBe(0);
        expect(paneOffsetForCanonical(layout, "left", 90, 5000)).toBe(0);
    });

    it("keeps large unbalanced hunk boundaries stable while scrolling", () => {
        const largeLayout = buildVerticalLayout([
            { left: 45, middle: 45, right: 45, conflict: false },
            { left: 16, middle: 16, right: 28, conflict: true, id: 42 },
            { left: 80, middle: 80, right: 80, conflict: false },
        ]);
        const viewport = 200;
        const conflictIndex = 1;
        const conflictTop = largeLayout.canonicalTopPx[conflictIndex];
        const conflictBottom =
            conflictTop + largeLayout.canonicalHPx[conflictIndex];
        const visibleExtent = (pane: MergePane, canonicalScroll: number) => {
            const offset = paneOffsetForCanonical(
                largeLayout,
                pane,
                canonicalScroll,
                viewport,
            );
            const top = largeLayout.paneTopPx[pane][conflictIndex] - offset;
            return { top, bottom: top + largeLayout.paneHPx[pane][conflictIndex] };
        };

        expect(visibleExtent("left", conflictTop).top).toBe(0);
        expect(visibleExtent("middle", conflictTop).top).toBe(0);
        expect(visibleExtent("right", conflictTop).top).toBe(0);

        const midScroll = conflictTop + largeLayout.canonicalHPx[conflictIndex] / 2;
        expect(visibleExtent("left", midScroll)).toEqual({ top: -160, bottom: 160 });
        expect(visibleExtent("middle", midScroll)).toEqual({ top: -160, bottom: 160 });
        expect(visibleExtent("right", midScroll)).toEqual({ top: -280, bottom: 280 });

        expect(visibleExtent("left", conflictBottom).bottom).toBe(0);
        expect(visibleExtent("middle", conflictBottom).bottom).toBe(0);
        expect(visibleExtent("right", conflictBottom).bottom).toBe(0);
    });
});
