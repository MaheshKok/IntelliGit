import { describe, expect, it } from "vitest";
import type { DiffSegment } from "../../../src/webviews/protocol/diffViewerTypes";
import { buildVerticalLayout } from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import { DIFF_PANES } from "../../../src/webviews/react/diff-viewer/segmentMarkers";
import {
    adjacentChangeIndex,
    buildStripeMarks,
} from "../../../src/webviews/react/diff-viewer/changeStripe";

const common = (line: string): DiffSegment => ({ type: "common", left: [line], right: [line] });
const changed = (left: string[], right: string[]): DiffSegment => ({
    type: "changed",
    left,
    right,
});
const inserted = (line: string): DiffSegment => changed([], [line]);
const deleted = (line: string): DiffSegment => changed([line], []);

/**
 * The layout exactly as `DiffViewerApp` derives it -- a 1:1 map over `segments`, in order.
 * The stripe indexes the layout by segment index, so anything that broke that alignment
 * would put every mark on the wrong line, and this is the shape that has to hold.
 */
function layoutFor(segments: readonly DiffSegment[]) {
    return buildVerticalLayout(
        segments.map((segment, index) => ({
            paneLines: { left: segment.left.length, right: segment.right.length },
            conflict: segment.type === "changed",
            id: segment.type === "changed" ? index : undefined,
        })),
        DIFF_PANES,
    );
}

/**
 * The stripe divides by the scroll range, which is the document plus a whole trailing
 * viewport. Most cases here are about which segment a mark points at, not where it lands,
 * so they take the unmeasured viewport: `scrollRangePx` floors that at three rows, which
 * is a known 60px rather than a number that has to be restated in every expectation.
 * The cases that ARE about position pass a viewport of their own.
 */
const marksFor = (segments: readonly DiffSegment[], viewportPx = 0) =>
    buildStripeMarks(segments, layoutFor(segments), viewportPx);

/** The floor `scrollRangePx` applies when nothing has been measured: 3 rows of 20px. */
const UNMEASURED_PAD_PX = 60;

describe("buildStripeMarks", () => {
    it("draws each change in the hue of the block it points at", () => {
        const segments = [
            common("shared();"),
            inserted("added();"),
            deleted("removed();"),
            changed(["before();"], ["after();"]),
        ];

        expect(marksFor(segments).map((mark) => mark.tone)).toEqual([
            "inserted",
            "deleted",
            "modified",
        ]);
    });

    it("marks nothing when the two sides agree", () => {
        expect(marksFor([common("a();"), common("b();"), common("c();")])).toEqual([]);
    });

    it("carries the segment's own index, not its position among the marks", () => {
        const segments = [
            common("a();"),
            common("b();"),
            inserted("added();"),
            common("c();"),
            deleted("removed();"),
        ];

        expect(marksFor(segments).map((mark) => mark.index)).toEqual([2, 4]);
    });

    // The defect this exists for: index the layout by a mark's ordinal instead of its
    // segment index and a change at the end of a long file draws at the very top, which
    // is worse than no stripe -- it points confidently at the wrong place.
    it("puts a change at the end of a long file at the end of the stripe", () => {
        const segments = [
            ...Array.from({ length: 200 }, (_, row) => common(`row${row}();`)),
            inserted("added();"),
        ];

        const marks = marksFor(segments);

        // 200 common rows then the change: the mark's top is 4000px into a 4020px document,
        // and the range it is a share of carries the trailing pad on top of that. The exact
        // number is pinned rather than a "near the bottom" band, because the defect above
        // puts this mark at zero and any band loose enough to survive a padding change would
        // also survive that. It does NOT reach 100%: the blank screen below the last line is
        // part of what scrolls, so the final change sits above the end of the track.
        const RANGE_PX = 201 * 20 + UNMEASURED_PAD_PX;
        expect(marks).toHaveLength(1);
        expect(marks[0].topPct).toBeCloseTo((4000 / RANGE_PX) * 100, 5);
        expect(marks[0].topPct + marks[0].heightPct).toBeCloseTo((4020 / RANGE_PX) * 100, 5);
    });

    it("puts a change at the start of a long file at the top of the stripe", () => {
        const segments = [
            inserted("added();"),
            ...Array.from({ length: 200 }, (_, row) => common(`row${row}();`)),
        ];

        expect(marksFor(segments)[0].topPct).toBe(0);
    });

    it("keeps every mark inside the stripe, in reading order", () => {
        const segments = [
            inserted("one();"),
            common("a();"),
            changed(["b();", "c();"], ["b2();"]),
            common("d();"),
            deleted("two();"),
            common("e();"),
        ];

        const marks = marksFor(segments);

        expect(marks).toHaveLength(3);
        for (const mark of marks) {
            expect(mark.topPct, `${mark.tone} top`).toBeGreaterThanOrEqual(0);
            expect(mark.heightPct, `${mark.tone} height`).toBeGreaterThan(0);
            expect(mark.topPct + mark.heightPct, `${mark.tone} bottom`).toBeLessThanOrEqual(100);
        }
        expect(marks.map((mark) => mark.topPct)).toEqual(
            [...marks.map((mark) => mark.topPct)].sort((left, right) => left - right),
        );
    });

    it("gives a one-line change in a long file a real share of the stripe", () => {
        const segments = [
            ...Array.from({ length: 500 }, (_, row) => common(`row${row}();`)),
            inserted("added();"),
        ];

        expect(marksFor(segments)[0].heightPct).toBeGreaterThan(0);
    });

    it("returns nothing for an unmeasured layout rather than marks at NaN", () => {
        // Through `marksFor` like every other case. Called directly it read as a deliberate
        // two-argument call, which is exactly the shape this suite cannot typecheck: the
        // guard returns before `viewportPx` is used, so a missing third argument passes
        // here and says nothing about the callers that do reach the division.
        expect(marksFor([])).toEqual([]);
    });
});

/**
 * A file with three changes spread through common rows, so "the next one" and "the one
 * before" are distinguishable and neither is the first nor the last segment. A selector
 * that always answered with an end of the file would pass on a one-change fixture.
 */
const NAVIGABLE = [
    common("head();"),
    inserted("added();"),
    common("mid1();"),
    common("mid2();"),
    common("mid3();"),
    deleted("removed();"),
    common("tail1();"),
    common("tail2();"),
    common("tail3();"),
    changed(["was();"], ["now();"]),
];

describe("adjacentChangeIndex", () => {
    const marks = marksFor(NAVIGABLE);
    const layout = layoutFor(NAVIGABLE);
    /** The scroll offset that puts a segment's own first row at the top of the viewport. */
    const topOf = (index: number): number => layout.canonicalTopPx[index] ?? Number.NaN;

    it("moves to the first change below where the reader is", () => {
        expect(adjacentChangeIndex(marks, layout, 0, 1)).toBe(1);
    });

    it("moves to the nearest change above, not the first one in the file", () => {
        expect(adjacentChangeIndex(marks, layout, topOf(9), -1)).toBe(5);
    });

    it("advances off a change the reader is already sitting on instead of re-finding it", () => {
        expect(adjacentChangeIndex(marks, layout, topOf(5), 1)).toBe(9);
        expect(adjacentChangeIndex(marks, layout, topOf(5), -1)).toBe(1);
    });

    it("still advances when the scroll offset is a fraction of a pixel off the change", () => {
        expect(adjacentChangeIndex(marks, layout, topOf(5) + 0.5, 1)).toBe(9);
        expect(adjacentChangeIndex(marks, layout, topOf(5) - 0.5, 1)).toBe(9);
    });

    it("stops at the ends rather than wrapping round to the other one", () => {
        expect(adjacentChangeIndex(marks, layout, 0, -1)).toBeUndefined();
        expect(adjacentChangeIndex(marks, layout, topOf(9), 1)).toBeUndefined();
    });

    it("does nothing on a file with no changes at all", () => {
        const segments = [common("only();"), common("common();")];
        expect(adjacentChangeIndex(marksFor(segments), layoutFor(segments), 0, 1)).toBeUndefined();
    });
});
