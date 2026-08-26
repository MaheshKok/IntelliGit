// Where the changes are, expressed against the viewer's one scroll range.
//
// The two panes share a single scroller, so a reader who has not scrolled cannot tell
// where the changes sit -- or whether any exist below the fold at all. The stripe answers
// that from the numbers the scroller is already sized by: `scrollRangePx(canonicalTotalPx,
// viewportPx)` IS the scroll range (`.diff-vscroll-spacer` is that tall), so a segment's
// fraction of it is its fraction of the scrollbar, with no second measurement to keep in sync.
//
// It is the padded range, not the document height. The scroller carries a whole trailing
// viewport so the last line can scroll clear off the top, and dividing by the document
// height instead would push every mark down by exactly that padding -- furthest at the
// bottom, where a mark is hardest to check against the code it claims to point at. The
// viewport is threaded in for that reason alone: the padding is no longer a constant, so a
// stripe that did not see the measurement would disagree with the spacer on every resize.
//
// The tone comes from `segmentMarker` rather than a second classification. The whole
// point of a mark beside the scrollbar is that its colour matches the block it points at,
// and two classifiers would drift apart with nothing going red.

import type { DiffSegment } from "../../protocol/diffViewerTypes";
import { scrollRangePx, type DiffVerticalLayout } from "../diff-core/mergeScrollLayout";
import { segmentMarker, type DiffPane, type SegmentMarker } from "./segmentMarkers";

/** The hues a change mark is drawn in, matching the edge bar on the block it points at. */
export type StripeTone = "inserted" | "deleted" | "modified";

/**
 * Every tone a mark can be drawn in. Exported for the same reason `SEGMENT_MARKERS` is:
 * the failure a stripe suffers is silent -- a tone with no rule behind it renders as an
 * invisible mark -- so `tests/unit/visual/diffCorePalette.test.ts` iterates this and
 * demands a matching colour, rather than trusting that one was remembered.
 */
export const STRIPE_TONES: readonly StripeTone[] = ["inserted", "deleted", "modified"];

/** One change's place in the shared scroll range, as a percentage of the whole. */
export interface StripeMark {
    /** Index into `segments`, so a click can scroll to the block this marks. */
    readonly index: number;
    /** Distance from the top of the scroll range, 0-100. */
    readonly topPct: number;
    /** Share of the scroll range this segment occupies, 0-100. */
    readonly heightPct: number;
    readonly tone: StripeTone;
}

/**
 * The tone each right-pane marker draws in. The right side is read because it classifies
 * changed segment on its own: an addition is `inserted` there, a deletion leaves that
 * side with no rows and so reads `empty`, and a two-sided edit is `modified`.
 * `diff-segment-deleted` cannot arrive from the right today -- it needs `side === "left"`
 * -- and is mapped rather than omitted so that a later change to `segmentMarker` yields
 * the right colour instead of a silently unmarked change.
 */
const TONE_BY_RIGHT_MARKER: Record<SegmentMarker, StripeTone> = {
    "diff-segment-empty": "deleted",
    "diff-segment-inserted": "inserted",
    "diff-segment-deleted": "deleted",
    "diff-segment-modified": "modified",
};

/**
 * Every changed segment's position in the shared scroll range, in render order.
 *
 * Returns nothing for an empty or unmeasured layout: a percentage of a zero range is not
 * a position, and a stripe of `NaN`-topped marks would render as a stack at the origin.
 */
export function buildStripeMarks(
    segments: readonly DiffSegment[],
    layout: DiffVerticalLayout<DiffPane>,
    viewportPx: number,
): StripeMark[] {
    // Guard on the document height, not the padded range: the padding has a floor of its
    // own, so `scrollRangePx` is never zero and an unmeasured layout would sail past a
    // check on it.
    if (layout.canonicalTotalPx <= 0) return [];
    const total = scrollRangePx(layout.canonicalTotalPx, viewportPx);

    const marks: StripeMark[] = [];
    segments.forEach((segment, index) => {
        const marker = segmentMarker(segment, "right");
        if (marker === null) return;
        marks.push({
            index,
            topPct: ((layout.canonicalTopPx[index] ?? 0) / total) * 100,
            heightPct: ((layout.canonicalHPx[index] ?? 0) / total) * 100,
            tone: TONE_BY_RIGHT_MARKER[marker],
        });
    });
    return marks;
}

/**
 * `scrollTop` can sit a fraction of a pixel off a segment's own top, so a strict
 * comparison would find the change the reader is already looking at and move nowhere.
 * A pixel of tolerance makes the second press advance instead of sticking.
 */
const SAME_POSITION_PX = 1;

/**
 * The changed segment to move to from `scrollTop`, or `undefined` when none lies that way.
 *
 * The stripe is aria-hidden and its marks take no tab stops -- one per change would be
 * hundreds on a real diff -- so click-to-jump reaches the pointer only. This is the same
 * jump addressed by position rather than by mark, which is what lets a key offer it
 * without the stripe having to become focusable. VS Code draws the same line: its minimap
 * is decorative and the change navigation lives on a command.
 *
 * Marks arrive in segment order, so they are already ascending by top; the first one past
 * the fold in either direction is the answer. Nothing wraps -- at the last change the key
 * does nothing, which is quieter than silently returning to the top.
 */
export function adjacentChangeIndex(
    marks: readonly StripeMark[],
    layout: DiffVerticalLayout<DiffPane>,
    scrollTop: number,
    direction: 1 | -1,
): number | undefined {
    const topOf = (mark: StripeMark): number => layout.canonicalTopPx[mark.index] ?? 0;

    if (direction === 1) {
        return marks.find((mark) => topOf(mark) > scrollTop + SAME_POSITION_PX)?.index;
    }
    for (let position = marks.length - 1; position >= 0; position -= 1) {
        const mark = marks[position];
        if (mark && topOf(mark) < scrollTop - SAME_POSITION_PX) return mark.index;
    }
    return undefined;
}
