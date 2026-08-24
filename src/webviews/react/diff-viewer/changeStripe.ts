// Where the changes are, expressed against the viewer's one scroll range.
//
// The two panes share a single scroller, so a reader who has not scrolled cannot tell
// where the changes sit -- or whether any exist below the fold at all. The stripe answers
// that from the layout the scroller is already sized by: `canonicalTotalPx` IS the scroll
// range (`.diff-vscroll-spacer` is that tall), so a segment's fraction of it is its
// fraction of the scrollbar, with no second measurement to keep in sync.
//
// The tone comes from `segmentMarker` rather than a second classification. The whole
// point of a mark beside the scrollbar is that its colour matches the block it points at,
// and two classifiers would drift apart with nothing going red.

import type { DiffSegment } from "../../protocol/diffViewerTypes";
import type { DiffVerticalLayout } from "../diff-core/mergeScrollLayout";
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
): StripeMark[] {
    const total = layout.canonicalTotalPx;
    if (total <= 0) return [];

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
