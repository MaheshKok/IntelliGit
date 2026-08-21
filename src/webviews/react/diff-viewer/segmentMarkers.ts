// Marker classification for the read-only two-pane diff viewer.
//
// Split out of the React tree because the classification is the only place the
// viewer decides which hue a block is drawn in, and the failure it can suffer is
// silent: a payload whose hunks never classify to one of the states still renders,
// still screenshots, and simply omits a colour. A pure function is something a
// recorded fixture can be run through directly, which is what
// `tests/unit/visual/diffViewerFixtureCoverage.test.ts` does.

import type { DiffSegment } from "../../protocol/diffViewerTypes";

/** The two sides a diff viewer payload is rendered into, in render order. */
export const DIFF_PANES = ["left", "right"] as const;

/** One side of the two-pane viewer. */
export type DiffPane = (typeof DIFF_PANES)[number];

/**
 * The marker state one pane's block of a changed segment renders in. `empty` is the
 * counterpart side of a one-sided hunk: it holds no rows, so it occupies no height and
 * paints nothing -- see `diff-viewer.css`, which marks the other three at their edge.
 */
export type SegmentMarker =
    | "diff-segment-empty"
    | "diff-segment-inserted"
    | "diff-segment-deleted"
    | "diff-segment-modified";

/** Every marker state a viewer pane block can classify to. */
export const SEGMENT_MARKERS: readonly SegmentMarker[] = [
    "diff-segment-empty",
    "diff-segment-inserted",
    "diff-segment-deleted",
    "diff-segment-modified",
];

/** Classifies one side of one segment, or `null` when the segment is unchanged. */
export function segmentMarker(segment: DiffSegment, side: DiffPane): SegmentMarker | null {
    if (segment.type === "common") return null;
    const lines = segment[side];
    const compareLines = segment[side === "left" ? "right" : "left"];
    if (lines.length === 0) return "diff-segment-empty";
    if (compareLines.length === 0) {
        return side === "right" ? "diff-segment-inserted" : "diff-segment-deleted";
    }
    return "diff-segment-modified";
}

/** The full class attribute for one side of one segment's block. */
export function segmentClassName(segment: DiffSegment, side: DiffPane): string {
    const marker = segmentMarker(segment, side);
    return marker === null ? "segment-common" : `diff-segment-changed ${marker}`;
}
