// Pane-agnostic vertical geometry and adjacent-pane ribbon paths.
//
// Each pane flows independently at its natural height while segment boundaries
// align through a shared canonical space (the tallest pane per segment). The
// engine is deliberately free of React and DOM so both two-pane and three-pane
// consumers can test the mapping directly.

/** Editor row height in pixels, matched to the `.code-line` CSS line-height. */
export const LINE_HEIGHT_PX = 20;

/**
 * Blank rows kept below the last line of a diff. Without them the final line sits
 * flush against the bottom of the viewport, which reads as a truncated file and
 * leaves the last line awkward to put under the cursor.
 *
 * They are added to the SCROLL RANGE only, never to `canonicalTotalPx`. That number
 * is the canonical space every pane offset, hunk extent and connector ribbon is
 * derived from, so padding it would move real geometry rather than simply letting
 * the scroller travel further than the document.
 */
export const TRAILING_ROWS = 3;

/** The scrollable length of a diff: the document, plus the trailing blank rows. */
export function scrollRangePx(canonicalTotalPx: number): number {
    return canonicalTotalPx + TRAILING_ROWS * LINE_HEIGHT_PX;
}

/** A consumer-defined pane identifier. Pane order is supplied to the engine. */
export type PaneId = string;

/** Rendered row counts for one segment, keyed by the consumer's ordered pane identifiers. */
export interface SegmentPaneLines<Pane extends PaneId = string> {
    paneLines: Readonly<Record<Pane, number>>;
    conflict: boolean;
    /** Conflict segment id (present only for conflict segments). */
    id?: number;
}

/** Top offset and height (px) of one hunk in canonical space. */
interface HunkExtent {
    top: number;
    height: number;
}

/**
 * Precomputed vertical geometry for one ordered pane set. All arrays are
 * indexed by segment; the canonical space is the per-segment maximum pane
 * height, so `canonicalTotalPx` sizes the shared scrollbar.
 */
export interface DiffVerticalLayout<Pane extends PaneId = string> {
    canonicalTopPx: number[];
    canonicalHPx: number[];
    canonicalTotalPx: number;
    paneTopPx: Record<Pane, number[]>;
    paneHPx: Record<Pane, number[]>;
    paneTotalPx: Record<Pane, number>;
    /** Conflict segment id maps to its canonical top/height, for jump-to-hunk. */
    hunkCanonical: Map<number, HunkExtent>;
}

// Every segment occupies exactly `lines * LINE_HEIGHT_PX` in flow: conflict
// blocks draw their rules with a zero-height inset box-shadow, so this geometry,
// the DOM margin-box, and contain-intrinsic-size agree at every boundary.
/** Height in px of a pane block holding `lines` rows. */
function blockHeight(lines: number): number {
    return lines * LINE_HEIGHT_PX;
}

function paneLineCount<Pane extends PaneId>(segment: SegmentPaneLines<Pane>, pane: Pane): number {
    return segment.paneLines[pane];
}

/**
 * Builds vertical geometry from an ordered pane-id array and each segment's
 * per-pane row counts. At a segment boundary every pane advances by its own
 * natural height; within a segment the canonical scroll position advances each
 * pane proportionally to that pane's height.
 */
export function buildVerticalLayout<Pane extends PaneId>(
    segments: readonly SegmentPaneLines<Pane>[],
    paneIds: readonly Pane[],
): DiffVerticalLayout<Pane> {
    const canonicalTopPx: number[] = [];
    const canonicalHPx: number[] = [];
    const paneTopPx = Object.fromEntries(paneIds.map((pane) => [pane, []])) as unknown as Record<
        Pane,
        number[]
    >;
    const paneHPx = Object.fromEntries(paneIds.map((pane) => [pane, []])) as unknown as Record<
        Pane,
        number[]
    >;
    const hunkCanonical = new Map<number, HunkExtent>();
    const paneCursor = Object.fromEntries(paneIds.map((pane) => [pane, 0])) as Record<Pane, number>;

    let canonicalCursor = 0;
    for (const segment of segments) {
        const heights = paneIds.map((pane) => blockHeight(paneLineCount(segment, pane)));
        const canonicalHeight = Math.max(...heights, 0);

        canonicalTopPx.push(canonicalCursor);
        canonicalHPx.push(canonicalHeight);
        paneIds.forEach((pane, index) => {
            paneTopPx[pane].push(paneCursor[pane]);
            paneHPx[pane].push(heights[index]);
            paneCursor[pane] += heights[index];
        });

        if (segment.conflict && segment.id !== undefined) {
            hunkCanonical.set(segment.id, { top: canonicalCursor, height: canonicalHeight });
        }
        canonicalCursor += canonicalHeight;
    }

    return {
        canonicalTopPx,
        canonicalHPx,
        canonicalTotalPx: canonicalCursor,
        paneTopPx,
        paneHPx,
        paneTotalPx: Object.fromEntries(paneIds.map((pane) => [pane, paneCursor[pane]])) as Record<
            Pane,
            number
        >,
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
 * Maps canonical scroll to one pane's translated offset. The pane advances
 * proportionally inside a segment and clamps to its own scrollable extent.
 */
export function paneOffsetForCanonical<Pane extends PaneId>(
    layout: DiffVerticalLayout<Pane>,
    pane: Pane,
    canonicalScroll: number,
    viewportH: number,
): number {
    const { canonicalTopPx, canonicalHPx, paneTopPx, paneHPx, paneTotalPx } = layout;
    if (canonicalTopPx.length === 0) return 0;
    const i = segmentIndexForOffset(canonicalTopPx, canonicalScroll);
    const segmentHeight = canonicalHPx[i];
    const fraction = segmentHeight > 0 ? (canonicalScroll - canonicalTopPx[i]) / segmentHeight : 0;
    const raw = paneTopPx[pane][i] + fraction * paneHPx[pane][i];
    const maxOffset = Math.max(0, paneTotalPx[pane] - viewportH);
    return clamp(raw, 0, maxOffset);
}

/** Horizontal control-point proximity (fraction of the divider strip). */
const RIBBON_CTRL_PROXIMITY_X = 0.3;

/**
 * Horizontal anatomy of one adjacent-pane connector ribbon. Flat gutter zones
 * use `x0..curveX0` and `curveX1..x1`; only the divider strip bends.
 */
export interface RibbonSpan {
    x0: number;
    curveX0: number;
    curveX1: number;
    x1: number;
}

/**
 * The span a two-pane connector is drawn across: the empty channel between the panes,
 * and nothing outside it. `paneEdge` and `nextPaneEdge` are the facing inner edges, in
 * the ribbon layer's own coordinates.
 *
 * The whole channel bends -- there are no flat runs, because a flat run is the part of
 * a ribbon that lies UNDER a pane, and a two-pane viewer has no room for one. That is
 * the defect this replaces: the viewer passed `x0 = 0, x1 = viewportWidth`, so every
 * band ran the full width and composited over both panes' code instead of bridging a
 * gap. Nothing failed, because a translucent SVG drawn on top changes no computed
 * style and the contrast oracle reads computed styles.
 *
 * Argument order is not trusted: the edges come from two DOM rects, and a right-to-left
 * layout hands them back the other way round.
 */
export function connectorChannelSpan(paneEdge: number, nextPaneEdge: number): RibbonSpan {
    const x0 = Math.min(paneEdge, nextPaneEdge);
    const x1 = Math.max(paneEdge, nextPaneEdge);
    return { x0, curveX0: x0, curveX1: x1, x1 };
}

/**
 * Builds the filled SVG path joining two adjacent pane extents. The 30% / 70%
 * Bézier controls preserve the measured IntelliJ curve-trapezium geometry.
 */
export function ribbonPathD(
    span: RibbonSpan,
    aTop: number,
    aBot: number,
    bTop: number,
    bBot: number,
): string {
    const { x0, curveX0, curveX1, x1 } = span;
    const width = curveX1 - curveX0;
    const cA = curveX0 + width * RIBBON_CTRL_PROXIMITY_X;
    const cB = curveX0 + width * (1 - RIBBON_CTRL_PROXIMITY_X);
    return (
        `M ${x0},${aTop} L ${curveX0},${aTop}` +
        ` C ${cA},${aTop} ${cB},${bTop} ${curveX1},${bTop} L ${x1},${bTop}` +
        ` L ${x1},${bBot} L ${curveX1},${bBot}` +
        ` C ${cB},${bBot} ${cA},${aBot} ${curveX0},${aBot} L ${x0},${aBot} Z`
    );
}

/**
 * Builds the dotted resolved-hunk outline joining two adjacent panes. The
 * 0.5px inset keeps the one-pixel stroke inside each pane boundary.
 */
export function ribbonOutlineD(
    span: RibbonSpan,
    aTop: number,
    aBot: number,
    bTop: number,
    bBot: number,
): string {
    const { x0, curveX0, curveX1, x1 } = span;
    const width = curveX1 - curveX0;
    const cA = curveX0 + width * RIBBON_CTRL_PROXIMITY_X;
    const cB = curveX0 + width * (1 - RIBBON_CTRL_PROXIMITY_X);
    return (
        `M ${x0 + 0.5},${aTop} L ${curveX0},${aTop} L ${curveX0},${aBot} L ${x0 + 0.5},${aBot} Z` +
        ` M ${curveX0},${aTop} C ${cA},${aTop} ${cB},${bTop} ${curveX1},${bTop}` +
        ` M ${curveX0},${aBot} C ${cA},${aBot} ${cB},${bBot} ${curveX1},${bBot}` +
        ` M ${curveX1},${bTop} L ${x1 - 0.5},${bTop} L ${x1 - 0.5},${bBot} L ${curveX1},${bBot} Z`
    );
}
