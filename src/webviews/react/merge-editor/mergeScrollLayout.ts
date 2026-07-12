// Pure vertical-geometry model for the PyCharm-style merge editor.
//
// The three panes (ours / result / theirs) flow independently at their natural
// heights, so a hunk that is 1 line on the left and 9 lines in the middle no
// longer pads the left pane with blank rows. Segment boundaries still align
// across panes via a shared "canonical" space (the tallest pane per segment);
// within a segment each pane scrolls proportionally, letting hunks diverge while
// unchanged regions stay in lockstep. This module is deliberately free of React
// and DOM so the mapping can be unit-tested directly.

/** Editor row height in pixels, matched to the .code-line CSS line-height. */
export const LINE_HEIGHT_PX = 20;

/** The three merge panes, keyed for per-pane geometry lookups. */
export type MergePane = "left" | "middle" | "right";

/** Rendered row counts for one segment, per pane, plus its conflict flag. */
export interface SegmentPaneLines {
    left: number;
    middle: number;
    right: number;
    conflict: boolean;
    /** Conflict segment id (present only for conflict segments). */
    id?: number;
}

/** Top offset and height (px) of one hunk in the canonical space. */
interface HunkExtent {
    top: number;
    height: number;
}

/**
 * Precomputed vertical geometry for the whole merge document. All arrays are
 * indexed by segment; the canonical space is the per-segment maximum pane
 * height, so `canonicalTotalPx` sizes the single scrollbar and every pane maps
 * into it.
 */
export interface MergeVerticalLayout {
    canonicalTopPx: number[];
    canonicalHPx: number[];
    canonicalTotalPx: number;
    paneTopPx: Record<MergePane, number[]>;
    paneHPx: Record<MergePane, number[]>;
    paneTotalPx: Record<MergePane, number>;
    /** Conflict segment id -\> its canonical top/height, for jump-to-hunk. */
    hunkCanonical: Map<number, HunkExtent>;
}

// Every segment — common or conflict — occupies exactly `lines * LINE_HEIGHT_PX`
// in flow: conflict blocks draw their rules with a zero-height inset box-shadow
// (no border/margin), so this geometry, the DOM's margin-box, and each block's
// `contain-intrinsic-size` agree exactly regardless of segment adjacency.
/** Height in px of a pane block holding `lines` rows. */
function blockHeight(lines: number): number {
    return lines * LINE_HEIGHT_PX;
}

/**
 * Builds the vertical geometry tables from each segment's per-pane row counts.
 *
 * The canonical height of a segment is the tallest pane's height, so panes
 * never drift apart across segment boundaries even though a shorter pane's hunk
 * ends earlier (its next line follows immediately, PyCharm-style).
 */
export function buildVerticalLayout(segments: SegmentPaneLines[]): MergeVerticalLayout {
    const canonicalTopPx: number[] = [];
    const canonicalHPx: number[] = [];
    const paneTopPx: Record<MergePane, number[]> = { left: [], middle: [], right: [] };
    const paneHPx: Record<MergePane, number[]> = { left: [], middle: [], right: [] };
    const hunkCanonical = new Map<number, HunkExtent>();

    let canonicalCursor = 0;
    const paneCursor: Record<MergePane, number> = { left: 0, middle: 0, right: 0 };

    for (const segment of segments) {
        const hLeft = blockHeight(segment.left);
        const hMiddle = blockHeight(segment.middle);
        const hRight = blockHeight(segment.right);
        const hCanonical = Math.max(hLeft, hMiddle, hRight);

        canonicalTopPx.push(canonicalCursor);
        canonicalHPx.push(hCanonical);
        paneTopPx.left.push(paneCursor.left);
        paneTopPx.middle.push(paneCursor.middle);
        paneTopPx.right.push(paneCursor.right);
        paneHPx.left.push(hLeft);
        paneHPx.middle.push(hMiddle);
        paneHPx.right.push(hRight);

        if (segment.conflict && segment.id !== undefined) {
            hunkCanonical.set(segment.id, { top: canonicalCursor, height: hCanonical });
        }

        canonicalCursor += hCanonical;
        paneCursor.left += hLeft;
        paneCursor.middle += hMiddle;
        paneCursor.right += hRight;
    }

    return {
        canonicalTopPx,
        canonicalHPx,
        canonicalTotalPx: canonicalCursor,
        paneTopPx,
        paneHPx,
        paneTotalPx: { left: paneCursor.left, middle: paneCursor.middle, right: paneCursor.right },
        hunkCanonical,
    };
}

/** Largest index `i` with `tops[i] <= value`, or 0 when `value` precedes all. */
function segmentIndexForOffset(tops: number[], value: number): number {
    if (tops.length === 0) return 0;
    let lo = 0;
    let hi = tops.length - 1;
    let result = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tops[mid] <= value) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}

/** Clamps `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/**
 * Maps a canonical scroll position to the pixel offset a given pane's column
 * should be translated to. At a segment boundary the pane sits at its own top;
 * within a segment it advances proportionally to that pane's height, so a short
 * hunk resolves quickly and its next line follows immediately while a taller
 * pane keeps scrolling through the same hunk.
 */
export function paneOffsetForCanonical(
    layout: MergeVerticalLayout,
    pane: MergePane,
    canonicalScroll: number,
    viewportH: number,
): number {
    const { canonicalTopPx, canonicalHPx, paneTopPx, paneHPx, paneTotalPx } = layout;
    if (canonicalTopPx.length === 0) return 0;
    const i = segmentIndexForOffset(canonicalTopPx, canonicalScroll);
    const segHeight = canonicalHPx[i];
    const frac = segHeight > 0 ? (canonicalScroll - canonicalTopPx[i]) / segHeight : 0;
    const raw = paneTopPx[pane][i] + frac * paneHPx[pane][i];
    const maxOffset = Math.max(0, paneTotalPx[pane] - viewportH);
    return clamp(raw, 0, maxOffset);
}

/** Horizontal control-point proximity (fraction of the span) for ribbon curves. */
const RIBBON_CTRL_PROXIMITY_X = 0.3;

/**
 * Builds the SVG path for one connector ribbon spanning `x0..x1`, joining the
 * hunk edge `aTop..aBot` (near pane) to `bTop..bBot` (far pane). Both long
 * edges are cubic Béziers with horizontal end tangents — control points at
 * 30% / 70% of the span, IntelliJ's curve-trapezium geometry — so the ribbon
 * meets each pane's rectangular band without a kink and flexes smoothly while
 * proportional scrolling slides the panes apart. Aligned sides degenerate to
 * straight edges; a zero-height side collapses the ribbon into a wedge.
 */
export function ribbonPathD(
    x0: number,
    x1: number,
    aTop: number,
    aBot: number,
    bTop: number,
    bBot: number,
): string {
    const cA = x0 + (x1 - x0) * RIBBON_CTRL_PROXIMITY_X;
    const cB = x0 + (x1 - x0) * (1 - RIBBON_CTRL_PROXIMITY_X);
    return (
        `M ${x0},${aTop} C ${cA},${aTop} ${cB},${bTop} ${x1},${bTop}` +
        ` L ${x1},${bBot} C ${cB},${bBot} ${cA},${aBot} ${x0},${aBot} Z`
    );
}
