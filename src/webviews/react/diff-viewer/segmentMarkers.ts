// Marker classification for the read-only two-pane diff viewer.
//
// Split out of the React tree because the classification is the only place the
// viewer decides which hue a block is drawn in, and the failure it can suffer is
// silent: a payload whose hunks never classify to one of the states still renders,
// still screenshots, and simply omits a colour. A pure function is something a
// recorded fixture can be run through directly, which is what
// `tests/unit/visual/diffViewerFixtureCoverage.test.ts` does.

import type { RibbonSpan } from "../diff-core/mergeScrollLayout";
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
/** The rule marking where a one-sided hunk sits in the pane that holds none of it. */
type SegmentGapMarker = "diff-gap-inserted" | "diff-gap-deleted";

/**
 * Classifies the collapsed position of a one-sided hunk, from the side that has no rows.
 *
 * That side cannot say what changed -- `segmentMarker` only ever calls it
 * `diff-segment-empty`, because emptiness is all it can see of itself. Its counterpart
 * can: content was either inserted at this position or removed from it. Returning null
 * for every other segment keeps the rule off two-sided hunks, which need no marker
 * because they have rows of their own to paint.
 */
function segmentGapMarker(segment: DiffSegment, side: DiffPane): SegmentGapMarker | null {
    if (segmentMarker(segment, side) !== "diff-segment-empty") return null;
    const counterpart = segmentMarker(segment, side === "left" ? "right" : "left");
    if (counterpart === "diff-segment-inserted") return "diff-gap-inserted";
    return counterpart === "diff-segment-deleted" ? "diff-gap-deleted" : null;
}

export function segmentClassName(segment: DiffSegment, side: DiffPane): string {
    const marker = segmentMarker(segment, side);
    if (marker === null) return "segment-common";
    const gap = segmentGapMarker(segment, side);
    return gap === null
        ? `diff-segment-changed ${marker}`
        : `diff-segment-changed ${marker} ${gap}`;
}

/**
 * The one pane a whole-file change lives in, or null when both panes hold content.
 *
 * An added file puts every line on the right and a deleted file puts every line on the
 * left; in both cases the other pane is an empty column the size of the file, and every
 * ribbon runs to it. Derived from the segments instead of a host-supplied flag: the
 * segments already state which sides have lines, and a flag restating that could differ
 * from what is being rendered right next to it.
 *
 * A file with no lines at all is not one-sided -- there is nothing to show in either
 * pane, so collapsing would just pick a side arbitrarily.
 */
export function soleSidedPane(segments: readonly DiffSegment[]): DiffPane | null {
    let left = 0;
    let right = 0;
    for (const segment of segments) {
        left += segment.left.length;
        right += segment.right.length;
    }
    if (left === 0 && right > 0) return "right";
    return right === 0 && left > 0 ? "left" : null;
}

/**
 * The pane a hunk's revert arrow is vertically aligned to.
 *
 * The arrow WRITES INTO the editable pane, but it stands beside the SOURCE pane -- the rows
 * the change came from, which are exactly the rows it copies. That is where the eye already
 * is: reverting a hunk is a decision about the lines being brought back, not about the lines
 * that are about to be overwritten.
 *
 * This is a choice between two collapses, not an escape from one. Neither side always holds
 * rows: a pure deletion is empty on the editable side, a pure insertion is empty on the
 * source side, and whichever side is empty puts the arrow on a zero-height seam between two
 * unrelated lines. Aligning to the source moves that collapse off deletions and onto
 * insertions -- deliberately, because deletions and modifications are the hunks whose source
 * rows are the thing the button copies, and an insertion's revert is a delete with no source
 * rows to point at in the first place.
 *
 * Only the vertical placement moves. The arrow's direction glyph still points at the pane it
 * writes into (`DiffHunkActionLayer`), and it still stands in the connector channel between
 * the panes -- `revertArrowX` decides where across that channel.
 */
export function revertArrowPane(editablePane: DiffPane): DiffPane {
    return editablePane === "left" ? "right" : "left";
}

/** Where a revert arrow's box hangs in the connector channel, as inline style values. */
export interface RevertArrowX {
    /** The channel edge the box is anchored to, in the action layer's own coordinates. */
    leftPx: number;
    /** Which of the box's own edges lands on `leftPx`. */
    transform: string;
}

/**
 * The arrow's horizontal placement: butted against the inner edge of the pane it stands
 * beside, not floating at the channel's midpoint.
 *
 * The arrow is read together with a line number -- "revert the hunk at 305" -- and a glyph
 * centred in the 28px channel touches neither number, so the eye has to pick which side it
 * annotates before it can act on it. Anchoring it to the source pane's edge answers that for
 * free, and it is the same pane `revertArrowPane` already aligns the arrow to vertically, so
 * both axes now say the same thing about which rows the button is about.
 *
 * The offset is a transform rather than a subtracted width because the box is 20px in
 * `diff-viewer.css` and nothing here should have to agree with that number: `leftPx` names
 * the channel edge, the transform names which of the box's own edges meets it.
 */
export function revertArrowX(span: RibbonSpan, pane: DiffPane): RevertArrowX {
    return pane === "left"
        ? { leftPx: span.x0, transform: "translateX(0)" }
        : { leftPx: span.x1, transform: "translateX(-100%)" };
}

/**
 * The single state a segment's connector ribbon reads as.
 *
 * A ribbon spans both panes, so unlike a pane block it cannot be in two states at once:
 * the side that holds rows decides it, and a two-sided hunk is a modification. Without
 * this the ribbon has no state at all and every hunk's connector is drawn in one hue,
 * which is what made an insertion's band read as a modification's -- the merge editor
 * colours its own connectors per variant (`merge-editor.css:446-457`).
 *
 * `diff-segment-empty` is never returned: it is the state of the side that holds no
 * rows, and a ribbon whose only state were `empty` would be a connector for a segment
 * with nothing on either side.
 */
export function segmentRibbonMarker(segment: DiffSegment): SegmentMarker | null {
    const right = segmentMarker(segment, "right");
    if (right === null) return null;
    return right === "diff-segment-empty" ? segmentMarker(segment, "left") : right;
}
