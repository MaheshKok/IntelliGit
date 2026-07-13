// Spec-derived tests for the pure vertical-geometry model. Expected pixel
// values are computed by hand from the fixture, not read back from the impl:
// every block is exactly lines * LINE_HEIGHT_PX (20) tall — no conflict chrome.

import { describe, expect, it } from "vitest";
import {
    bandSpansForMiddleGap,
    buildVerticalLayout,
    paneOffsetForCanonical,
    ribbonOutlineD,
    ribbonPathD,
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
        const conflictBottom = conflictTop + largeLayout.canonicalHPx[conflictIndex];
        const visibleExtent = (pane: MergePane, canonicalScroll: number) => {
            const offset = paneOffsetForCanonical(largeLayout, pane, canonicalScroll, viewport);
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

// Connector ribbon geometry, PyCharm's divider anatomy: the band stays a flat
// rectangle under the near gutter (x0..curveX0) and the far gutter
// (curveX1..x1); ONLY the divider strip (curveX0..curveX1) curves, using cubic
// Béziers with horizontal end tangents and control points at 30% / 70% of the
// strip (IntelliJ's curve-trapezium contract). Expected strings are
// hand-computed from that contract, not read back from the implementation.
// Not exercised: reversed spans and non-finite inputs — gutter measurement
// always yields finite left-to-right x's, and offscreen culling happens
// upstream.
describe("ribbonPathD", () => {
    // Strip 140..170 (width 30) → controls at x=149 and x=161.
    const SPAN = { x0: 100, curveX0: 140, curveX1: 170, x1: 200 };

    it("keeps gutter bands rectangular and curves only across the divider strip", () => {
        expect(ribbonPathD(SPAN, 10, 50, 30, 90)).toBe(
            "M 100,10 L 140,10 C 149,10 161,30 170,30 L 200,30" +
                " L 200,90 L 170,90 C 161,90 149,50 140,50 L 100,50 Z",
        );
    });

    it("degenerates to straight horizontal edges when both sides align", () => {
        expect(ribbonPathD(SPAN, 10, 50, 10, 50)).toBe(
            "M 100,10 L 140,10 C 149,10 161,10 170,10 L 200,10" +
                " L 200,50 L 170,50 C 161,50 149,50 140,50 L 100,50 Z",
        );
    });

    it("preserves fractional offsets so ribbons track sub-pixel pane positions", () => {
        expect(ribbonPathD(SPAN, 10.5, 50.25, 30.75, 90.5)).toBe(
            "M 100,10.5 L 140,10.5 C 149,10.5 161,30.75 170,30.75 L 200,30.75" +
                " L 200,90.5 L 170,90.5 C 161,90.5 149,50.25 140,50.25 L 100,50.25 Z",
        );
    });

    it("collapses to a curved wedge when the far side has zero height", () => {
        // bTop == bBot: an insertion pointing at a line between rows. Strip
        // 10..20 (width 10) → controls at x=13 and x=17.
        expect(ribbonPathD({ x0: 0, curveX0: 10, curveX1: 20, x1: 30 }, 20, 60, 40, 40)).toBe(
            "M 0,20 L 10,20 C 13,20 17,40 20,40 L 30,40" +
                " L 30,40 L 20,40 C 17,40 13,60 10,60 L 0,60 Z",
        );
    });

    it("handles negative coordinates for hunks scrolled above the viewport", () => {
        expect(ribbonPathD({ x0: 0, curveX0: 10, curveX1: 20, x1: 30 }, -30, -10, -20, 0)).toBe(
            "M 0,-30 L 10,-30 C 13,-30 17,-20 20,-20 L 30,-20" +
                " L 30,0 L 20,0 C 17,0 13,-10 10,-10 L 0,-10 Z",
        );
    });

    it("degenerates to a vertical seam when the divider strip has zero width", () => {
        // curveX0 == curveX1: all curve x's collapse onto the shared edge, so
        // the "curve" is a vertical joint between the two flat bands.
        expect(ribbonPathD({ x0: 100, curveX0: 150, curveX1: 150, x1: 200 }, 10, 50, 30, 90)).toBe(
            "M 100,10 L 150,10 C 150,10 150,30 150,30 L 200,30" +
                " L 200,90 L 150,90 C 150,90 150,50 150,50 L 100,50 Z",
        );
    });

    it("supports zero-width gutter bands, reducing to a pure divider curve", () => {
        // A side with no gutter (e.g. the result pane's trailing edge) sets
        // x0 == curveX0; the flat segment degenerates to a zero-length line.
        expect(ribbonPathD({ x0: 100, curveX0: 100, curveX1: 200, x1: 200 }, 10, 50, 30, 90)).toBe(
            "M 100,10 L 100,10 C 130,10 170,30 200,30 L 200,30" +
                " L 200,90 L 200,90 C 170,90 130,50 100,50 L 100,50 Z",
        );
    });
});

// Resolved-hunk contour, PyCharm's "settled" rendering: two closed dotted
// rectangles — one around the source block in its own pane, one around the
// result slice — linked by an open curve pair across the divider zone. The
// span's x0..curveX0 is the a-block's pane content, curveX1..x1 the b-block's;
// outer verticals are inset 0.5px so a 1px stroke is not clipped at pane
// boundaries. The curves reuse the 30% / 70% control-point contract of the
// filled ribbon. No edge crosses a pane it does not belong to.
describe("ribbonOutlineD", () => {
    // Strip 140..170 (width 30) → controls at x=149 and x=161.
    const SPAN = { x0: 0, curveX0: 140, curveX1: 170, x1: 300 };

    it("draws two closed block rectangles linked by open divider curves", () => {
        expect(ribbonOutlineD(SPAN, 10, 50, 30, 90)).toBe(
            "M 0.5,10 L 140,10 L 140,50 L 0.5,50 Z" +
                " M 140,10 C 149,10 161,30 170,30" +
                " M 140,50 C 149,50 161,90 170,90" +
                " M 170,30 L 299.5,30 L 299.5,90 L 170,90 Z",
        );
    });

    it("links the rectangles with straight rails when both blocks align", () => {
        expect(ribbonOutlineD(SPAN, 10, 50, 10, 50)).toBe(
            "M 0.5,10 L 140,10 L 140,50 L 0.5,50 Z" +
                " M 140,10 C 149,10 161,10 170,10" +
                " M 140,50 C 149,50 161,50 170,50" +
                " M 170,10 L 299.5,10 L 299.5,50 L 170,50 Z",
        );
    });

    it("collapses a zero-height target to a flat line rectangle", () => {
        // bTop == bBot (a wedge to an insertion point): both curves converge
        // on the shared y and the b-rectangle degenerates to a dotted line.
        expect(ribbonOutlineD(SPAN, 20, 60, 40, 40)).toBe(
            "M 0.5,20 L 140,20 L 140,60 L 0.5,60 Z" +
                " M 140,20 C 149,20 161,40 170,40" +
                " M 140,60 C 149,60 161,40 170,40" +
                " M 170,40 L 299.5,40 L 299.5,40 L 170,40 Z",
        );
    });

    it("handles negative coordinates for hunks scrolled above the viewport", () => {
        expect(ribbonOutlineD(SPAN, -30, -10, -20, 0)).toBe(
            "M 0.5,-30 L 140,-30 L 140,-10 L 0.5,-10 Z" +
                " M 140,-30 C 149,-30 161,-20 170,-20" +
                " M 140,-10 C 149,-10 161,0 170,0" +
                " M 170,-20 L 299.5,-20 L 299.5,0 L 170,0 Z",
        );
    });

    it("degenerates to a vertical joint when the curve zone has zero width", () => {
        // curveX0 == curveX1: the connector collapses onto the shared edge and
        // the two rectangles simply touch it.
        expect(
            ribbonOutlineD({ x0: 100, curveX0: 150, curveX1: 150, x1: 200 }, 10, 50, 30, 90),
        ).toBe(
            "M 100.5,10 L 150,10 L 150,50 L 100.5,50 Z" +
                " M 150,10 C 150,10 150,30 150,30" +
                " M 150,50 C 150,50 150,90 150,90" +
                " M 150,30 L 199.5,30 L 199.5,90 L 150,90 Z",
        );
    });
});

// A hunk whose result has no rows (both sides changed a spot the base left
// empty) draws no in-pane band in the middle column, so the pending sides'
// divider bands must extend across the gap themselves or the 3px thin line
// stops dead at the middle pane's content edges instead of reading as one
// continuous PyCharm line through all three panels. Settled sides are left
// alone — their dotted contour already spans the middle via the result
// rectangle in ribbonOutlineD.
describe("bandSpansForMiddleGap", () => {
    const leftBand = { x0: 426, curveX0: 508, curveX1: 536, x1: 572 };
    const rightBand = { x0: 1042, curveX0: 1042, curveX1: 1070, x1: 1151 };

    it("returns the input spans unchanged (same reference) when the middle pane has rows, regardless of pending flags", () => {
        const bothPending = bandSpansForMiddleGap(leftBand, rightBand, false, true, true);
        expect(bothPending.left).toBe(leftBand);
        expect(bothPending.right).toBe(rightBand);

        const neitherPending = bandSpansForMiddleGap(leftBand, rightBand, false, false, false);
        expect(neitherPending.left).toBe(leftBand);
        expect(neitherPending.right).toBe(rightBand);
    });

    it("extends the left band across the gap to the right band's start when only the left side is pending", () => {
        const result = bandSpansForMiddleGap(leftBand, rightBand, true, true, false);
        expect(result.left).toEqual({ x0: 426, curveX0: 508, curveX1: 536, x1: 1042 });
        expect(result.right).toBe(rightBand);
        // The function must not mutate its inputs.
        expect(leftBand).toEqual({ x0: 426, curveX0: 508, curveX1: 536, x1: 572 });
    });

    it("extends the right band across the gap to the left band's end when only the right side is pending", () => {
        const result = bandSpansForMiddleGap(leftBand, rightBand, true, false, true);
        expect(result.right).toEqual({ x0: 572, curveX0: 1042, curveX1: 1070, x1: 1151 });
        expect(result.left).toBe(leftBand);
        expect(rightBand).toEqual({ x0: 1042, curveX0: 1042, curveX1: 1070, x1: 1151 });
    });

    it("extends only the left band when both sides are pending, so translucent fills do not double-paint the gap", () => {
        const result = bandSpansForMiddleGap(leftBand, rightBand, true, true, true);
        expect(result.left).toEqual({ x0: 426, curveX0: 508, curveX1: 536, x1: 1042 });
        expect(result.right).toBe(rightBand);
    });

    it("leaves both bands unchanged when neither side is pending, even with an empty middle", () => {
        const result = bandSpansForMiddleGap(leftBand, rightBand, true, false, false);
        expect(result.left).toBe(leftBand);
        expect(result.right).toBe(rightBand);
    });
});
