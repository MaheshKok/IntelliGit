// Spec-derived tests for the pure vertical-geometry model. Expected pixel
// values are computed by hand from the fixture, not read back from the impl:
// every block is exactly lines * LINE_HEIGHT_PX (20) tall — no conflict chrome.

import { describe, expect, it } from "vitest";
import {
    buildVerticalLayout,
    connectorChannelSpan,
    paneOffsetForCanonical,
    ribbonOutlineD,
    ribbonPathD,
    scrollRangePx,
    type PaneId,
    type SegmentPaneLines,
} from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import { bandSpansForMiddleGap } from "../../../src/webviews/react/merge-editor/mergeScrollLayout";

// common(3) | conflict id=0 ours=1/result=3/theirs=2 | common(2)
//
// heights (px):        left  middle  right  canonical
//   seg0 common(3)      60     60     60      60
//   seg1 conflict       20     60     40      60   (lines*20, no chrome)
//   seg2 common(2)      40     40     40      40
const FIXTURE: SegmentPaneLines[] = [
    { paneLines: { left: 3, middle: 3, right: 3 }, conflict: false },
    { paneLines: { left: 1, middle: 3, right: 2 }, conflict: true, id: 0 },
    { paneLines: { left: 2, middle: 2, right: 2 }, conflict: false },
];

describe("buildVerticalLayout", () => {
    it("stacks canonical tops from the tallest pane per segment", () => {
        const layout = buildVerticalLayout(FIXTURE, ["left", "middle", "right"] as const);
        expect(layout.canonicalTopPx).toEqual([0, 60, 120]);
        expect(layout.canonicalHPx).toEqual([60, 60, 40]);
        expect(layout.canonicalTotalPx).toBe(160);
        // The trailing rows hang off the SCROLL RANGE, never off the canonical space the
        // line above pins -- pad that and every pane offset and ribbon extent moves with it.
        expect(scrollRangePx(layout.canonicalTotalPx, 0)).toBe(220);
    });

    it("hangs a whole viewport below the document so the last line can be scrolled out of sight", () => {
        // The trailing space is what the scroller can travel past the end, so a viewport's
        // worth of it means the final line reaches the top edge and then leaves — three fixed
        // rows only ever lifted it clear of the bottom, which still reads as a cut-off file.
        //
        // Literals, not `TRAILING_ROWS * LINE_HEIGHT_PX` or the argument echoed back: an
        // expectation built from the constant it polices passes just as happily when that
        // constant is zero, and one built from `viewportPx` passes when the document is
        // dropped from the sum.
        expect(scrollRangePx(800, 500)).toBe(1300);
        expect(scrollRangePx(0, 500)).toBe(500);
    });

    it("keeps three blank rows as the floor before the viewport has been measured", () => {
        // `measureViewport` has not run on the first paint, and a viewport of 0 would make the
        // scroll range the document exactly — the last line flush against the bottom edge,
        // which is the state this trailing space exists to prevent.
        expect(scrollRangePx(800, 0)).toBe(860);
        expect(scrollRangePx(800, 40)).toBe(860);
        expect(scrollRangePx(800, 61)).toBe(861);
    });

    it("advances each pane by its own natural height, not the canonical height", () => {
        const layout = buildVerticalLayout(FIXTURE, ["left", "middle", "right"] as const);
        // Left pane's 1-line conflict (20px) means seg2 starts at 80, not 120.
        expect(layout.paneTopPx.left).toEqual([0, 60, 80]);
        expect(layout.paneTopPx.middle).toEqual([0, 60, 120]);
        expect(layout.paneTopPx.right).toEqual([0, 60, 100]);
        expect(layout.paneTotalPx).toEqual({ left: 120, middle: 160, right: 140 });
    });

    it("maps each conflict id to its canonical extent for jump-to-hunk", () => {
        const layout = buildVerticalLayout(FIXTURE, ["left", "middle", "right"] as const);
        expect(layout.hunkCanonical.get(0)).toEqual({ top: 60, height: 60 });
        expect(layout.hunkCanonical.has(1)).toBe(false);
    });

    it("returns zeroed geometry for an empty document", () => {
        const layout = buildVerticalLayout([], ["left", "middle", "right"] as const);
        expect(layout.canonicalTotalPx).toBe(0);
        expect(layout.paneTotalPx).toEqual({ left: 0, middle: 0, right: 0 });
        expect(paneOffsetForCanonical(layout, "left", 0)).toBe(0);
    });
});

describe("paneOffsetForCanonical", () => {
    const layout = buildVerticalLayout(FIXTURE, ["left", "middle", "right"] as const);

    it("aligns all panes at their own top on a segment boundary", () => {
        // Canonical 60 is the top of the conflict segment: each pane sits at its
        // own seg1 top (60), so unchanged code above the hunk stays in lockstep.
        expect(paneOffsetForCanonical(layout, "left", 60)).toBe(60);
        expect(paneOffsetForCanonical(layout, "middle", 60)).toBe(60);
        expect(paneOffsetForCanonical(layout, "right", 60)).toBe(60);
    });

    it("diverges proportionally to each pane's height mid-hunk", () => {
        // Halfway through the conflict (canonical 90 = 60 + 60/2): left advances
        // 10 (20/2), middle 30 (60/2), right 20 (40/2). A `-` interpolation would
        // yield 50 for the left pane instead of 70.
        expect(paneOffsetForCanonical(layout, "left", 90)).toBe(70);
        expect(paneOffsetForCanonical(layout, "middle", 90)).toBe(90);
        expect(paneOffsetForCanonical(layout, "right", 90)).toBe(80);
    });

    it("re-aligns panes at the next boundary after an unbalanced hunk", () => {
        expect(paneOffsetForCanonical(layout, "left", 120)).toBe(80);
        expect(paneOffsetForCanonical(layout, "middle", 120)).toBe(120);
        expect(paneOffsetForCanonical(layout, "right", 120)).toBe(100);
    });

    it("lets every pane translate its whole height, clear off the top of the viewport", () => {
        // A pane stopped at `totalPx - viewportH` leaves its last screenful pinned against the
        // bottom edge no matter how far the scroller travels -- the scrollbar moves and the code
        // does not. Each pane's own full height is the limit, so the last line goes out of sight.
        expect(paneOffsetForCanonical(layout, "left", 160)).toBe(120);
        expect(paneOffsetForCanonical(layout, "middle", 160)).toBe(160);
        expect(paneOffsetForCanonical(layout, "right", 160)).toBe(140);

        // And no further. 160 is exactly the end of the canonical space, where the interpolation
        // already lands on each pane's own total -- so it alone cannot tell a working upper bound
        // from a missing one. A window shorter than the trailing-row floor makes the scroll range
        // outrun the document, which is how a scroll position past the end is reached at all;
        // unbounded, each pane would sail on at its own rate and stop agreeing with the others.
        expect(paneOffsetForCanonical(layout, "left", 400)).toBe(120);
        expect(paneOffsetForCanonical(layout, "middle", 400)).toBe(160);
        expect(paneOffsetForCanonical(layout, "right", 400)).toBe(140);
    });

    it("never returns a negative offset", () => {
        expect(paneOffsetForCanonical(layout, "middle", 0)).toBe(0);
        // A document far shorter than the window still scrolls: the trailing space is a whole
        // viewport, so there is real travel to spend even here, and the offset tracks it rather
        // than being pinned to zero by a window taller than the file.
        expect(paneOffsetForCanonical(layout, "left", 90)).toBe(70);
    });

    it("keeps large unbalanced hunk boundaries stable while scrolling", () => {
        const largeLayout = buildVerticalLayout(
            [
                { paneLines: { left: 45, middle: 45, right: 45 }, conflict: false },
                {
                    paneLines: { left: 16, middle: 16, right: 28 },
                    conflict: true,
                    id: 42,
                },
                { paneLines: { left: 80, middle: 80, right: 80 }, conflict: false },
            ],
            ["left", "middle", "right"] as const,
        );
        const conflictIndex = 1;
        const conflictTop = largeLayout.canonicalTopPx[conflictIndex];
        const conflictBottom = conflictTop + largeLayout.canonicalHPx[conflictIndex];
        const visibleExtent = (pane: PaneId, canonicalScroll: number) => {
            const offset = paneOffsetForCanonical(largeLayout, pane, canonicalScroll);
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

// The two-pane viewer's connector span. The invariant is containment, not shape:
// a band that reaches outside the empty channel is drawn ON TOP OF code, which is
// exactly what shipped before -- the viewer passed `x0 = 0, x1 = viewportWidth`,
// every connector spanned the whole viewport, and nothing caught it because a
// translucent SVG over the code changes no computed style and the contrast oracle
// reads computed styles. So the assertions below are on the extreme x's of the
// rendered path, not only on the returned struct.
describe("connectorChannelSpan", () => {
    /** Every x coordinate in an SVG path `d`, in order. */
    const pathXs = (d: string): number[] =>
        [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => Number(match[1]));

    it("spans the channel exactly, with no flat run outside either pane edge", () => {
        expect(connectorChannelSpan(600, 628)).toEqual({
            x0: 600,
            curveX0: 600,
            curveX1: 628,
            x1: 628,
        });
    });

    it("normalises reversed pane edges, so a right-to-left layout still bends inward", () => {
        expect(connectorChannelSpan(628, 600)).toEqual(connectorChannelSpan(600, 628));
    });

    it("collapses to a zero-width seam before the panes have laid out", () => {
        expect(connectorChannelSpan(0, 0)).toEqual({ x0: 0, curveX0: 0, curveX1: 0, x1: 0 });
    });

    it("keeps every point of the drawn band inside the channel, never over a pane", () => {
        const span = connectorChannelSpan(600, 628);
        // Unbalanced hunk (left 40px tall, right 60px) — the case that bends hardest.
        const xs = pathXs(ribbonPathD(span, 100, 140, 220, 280));
        expect(Math.min(...xs)).toBe(600);
        expect(Math.max(...xs)).toBe(628);
    });

    it("keeps the outline inside the channel too, so a resolved hunk cannot stroke over code", () => {
        const span = connectorChannelSpan(600, 628);
        const xs = pathXs(ribbonOutlineD(span, 100, 140, 220, 280));
        // The outline insets its closing rails by 0.5px to keep the stroke inside.
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(600);
        expect(Math.max(...xs)).toBeLessThanOrEqual(628);
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
