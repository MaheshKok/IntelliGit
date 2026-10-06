import {
    LINE_HEIGHT_PX,
    ribbonOutlineD,
    ribbonPathD,
    type DiffVerticalLayout,
    type RibbonSpan,
} from "../diff-core/mergeScrollLayout";
import { bandSpansForMiddleGap } from "./mergeScrollLayout";
import type { ConflictSegment, HunkResolution, HunkSideDismissal } from "./types";
import { connectorClass } from "./segments";

export const MERGE_PANES = ["left", "middle", "right"] as const;
/** One of the three ordered merge columns. */
export type MergePaneId = (typeof MERGE_PANES)[number];

/** Row extent of one side's target inside the stacked result block (in lines). */
interface ResultSlice {
    top: number;
    count: number;
}

/** One divider side of a hunk's connector: color, settled state, and target. */
interface ConnectorSideSpec {
    colorClass: string;
    /** Settled (accepted/discarded): drawn as PyCharm's dotted contour, not a band. */
    resolved: boolean;
    /** Sub-extent of the result the side maps to; whole block when absent. */
    midSlice?: ResultSlice;
}

/** Both connector sides and the layout index for one hunk. */
export interface ConnectorRenderSpec {
    id: number;
    index: number;
    left?: ConnectorSideSpec;
    right?: ConnectorSideSpec;
}

/**
 * Derives both connector sides for a hunk, PyCharm-style: a pending side keeps
 * its filled suggestion band; a settled side (accepted into the result,
 * discarded via X, or dropped with "none") turns into a dotted contour so the
 * hunk stays traceable across panes after the decision. Stacking both sides
 * settles both ribbons and points each at its own slice of the result. While
 * exactly one side is accepted, the other side — pending append or discarded —
 * points at the zero-height append edge below the accepted lines instead of
 * re-wrapping the whole result block. A one-sided hunk (`ours-only` /
 * `theirs-only`) has no suggestion on its non-contributing divider — PyCharm
 * links only the side that actually changed — so that side is omitted from
 * the returned spec entirely rather than drawn as a stray empty connector.
 */
export function connectorSideSpecs(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
    dismissed: HunkSideDismissal | undefined,
): { left?: ConnectorSideSpec; right?: ConnectorSideSpec } {
    const pendingClass = connectorClass(segment);
    const resolvedClass = `${pendingClass} connector-resolved`;
    let sides: { left: ConnectorSideSpec; right: ConnectorSideSpec };
    if (resolution === "both" || resolution === "both-reversed") {
        const oursLen = segment.oursLines.length;
        const theirsLen = segment.theirsLines.length;
        const oursFirst = resolution === "both";
        sides = {
            left: {
                colorClass: resolvedClass,
                resolved: true,
                midSlice: { top: oursFirst ? 0 : theirsLen, count: oursLen },
            },
            right: {
                colorClass: resolvedClass,
                resolved: true,
                midSlice: { top: oursFirst ? oursLen : 0, count: theirsLen },
            },
        };
    } else {
        const leftResolved =
            resolution === "ours" || resolution === "none" || dismissed?.ours === true;
        const rightResolved =
            resolution === "theirs" || resolution === "none" || dismissed?.theirs === true;
        sides = {
            left: {
                colorClass: leftResolved ? resolvedClass : pendingClass,
                resolved: leftResolved,
                midSlice:
                    resolution === "theirs"
                        ? { top: segment.theirsLines.length, count: 0 }
                        : undefined,
            },
            right: {
                colorClass: rightResolved ? resolvedClass : pendingClass,
                resolved: rightResolved,
                midSlice:
                    resolution === "ours" ? { top: segment.oursLines.length, count: 0 } : undefined,
            },
        };
    }
    if (segment.changeKind === "ours-only") return { left: sides.left };
    if (segment.changeKind === "theirs-only") return { right: sides.right };
    return sides;
}

const RIBBON_LINE_TARGET_HEIGHT_PX = 3;

/** Maps a side's result slice to pixel extents inside the middle block. */
function sliceExtent(
    midTop: number,
    midBot: number,
    slice: ResultSlice | undefined,
): { top: number; bot: number } {
    if (!slice) return { top: midTop, bot: midBot };
    const top = midTop + slice.top * LINE_HEIGHT_PX;
    return { top, bot: top + slice.count * LINE_HEIGHT_PX };
}

/** Reads a numeric px-valued CSS variable used by merge-editor geometry. */
export function readPxVar(element: Element, name: string): number {
    const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
}

/** Reads a required positive geometry variable without guessing a missing width. */
export function requirePxVar(element: Element, name: string): number {
    const value = readPxVar(element, name);
    if (!Number.isFinite(value) || value <= 0)
        throw new Error(`merge-editor: CSS variable ${name} is missing or 0`);
    return value;
}

/** Horizontal spans for one divider: filled band vs resolved contour x-zones. */
export interface DividerSpans {
    /** Gutter-to-gutter span the filled suggestion band covers. */
    band: RibbonSpan;
    /** Pane-outer-edge span the resolved dotted contour traces. */
    contour: RibbonSpan;
}

/**
 * Sets one connector ribbon's path across a gutter. Pending sides draw the
 * filled band (flat under the pane gutters, curved only in the divider strip);
 * resolved sides draw the dotted linked-block contour instead. Any zero-height
 * side — an empty result, an untouched pane of a one-sided hunk, or an append
 * edge — is clamped to a thin line so insertion targets stay visible without a
 * full row, PyCharm-style.
 */
function setRibbonPath(
    path: SVGPathElement | undefined,
    spans: DividerSpans,
    aTop: number,
    aBot: number,
    bTop: number,
    bBot: number,
    viewportH: number,
    outline: boolean,
): void {
    if (!path) return;
    if (aBot - aTop < RIBBON_LINE_TARGET_HEIGHT_PX) {
        aBot = aTop + RIBBON_LINE_TARGET_HEIGHT_PX;
    }
    if (bBot - bTop < RIBBON_LINE_TARGET_HEIGHT_PX) {
        bBot = bTop + RIBBON_LINE_TARGET_HEIGHT_PX;
    }

    const top = Math.min(aTop, bTop);
    const bottom = Math.max(aBot, bBot);
    if (bottom < 0 || top > viewportH) {
        path.style.display = "none";
        return;
    }

    path.style.display = "";
    path.setAttribute(
        "d",
        outline
            ? ribbonOutlineD(spans.contour, aTop, aBot, bTop, bBot)
            : ribbonPathD(spans.band, aTop, aBot, bTop, bBot),
    );
}

/** Measures the filled and resolved ribbon spans across both dividers. */
export function measureRibbonSpans(
    cols: Record<MergePaneId, HTMLElement | null>,
    gutterWidthOf: (col: HTMLElement, withActions: boolean) => number,
): { left: DividerSpans; right: DividerSpans } | null {
    const { left, middle, right } = cols;
    if (!left || !middle || !right) return null;
    const leftEdge = left.offsetLeft + left.offsetWidth;
    const middleEdge = middle.offsetLeft + middle.offsetWidth;
    const rightEdge = right.offsetLeft + right.offsetWidth;
    const leftContentEnd = leftEdge - gutterWidthOf(left, true);
    const middleContentStart = middle.offsetLeft + gutterWidthOf(middle, false);
    const rightContentStart = right.offsetLeft + gutterWidthOf(right, true);
    // Band spans stop at the gutters. Contour spans (resolved hunks) wrap
    // each block's pane CONTENT in a closed dotted rectangle and let the
    // linking curves sweep the whole gutter+divider zone between them, so
    // no dotted edge crosses a pane it does not belong to.
    return {
        left: {
            band: {
                x0: leftContentEnd,
                curveX0: leftEdge,
                curveX1: middle.offsetLeft,
                x1: middleContentStart,
            },
            contour: {
                x0: left.offsetLeft,
                curveX0: leftContentEnd,
                curveX1: middleContentStart,
                x1: middleEdge,
            },
        },
        right: {
            band: {
                x0: middleEdge,
                curveX0: middleEdge,
                curveX1: right.offsetLeft,
                x1: rightContentStart,
            },
            contour: {
                x0: middleContentStart,
                curveX0: middleEdge,
                curveX1: rightContentStart,
                x1: rightEdge,
            },
        },
    };
}

/** Draws connector geometry from the offsets applied to the three columns. */
export function drawRibbons(
    layout: DiffVerticalLayout<MergePaneId>,
    offsets: Readonly<Record<MergePaneId, number>>,
    viewportH: number,
    spans: { left: DividerSpans; right: DividerSpans },
    connectors: readonly ConnectorRenderSpec[],
    paths: ReadonlyMap<string, SVGPathElement>,
): void {
    const { left: leftSpans, right: rightSpans } = spans;
    for (const { id, index, left, right } of connectors) {
        const oursTop = layout.paneTopPx.left[index] - offsets.left;
        const oursBot = oursTop + layout.paneHPx.left[index];
        const midTop = layout.paneTopPx.middle[index] - offsets.middle;
        const midBot = midTop + layout.paneHPx.middle[index];
        const theirsTop = layout.paneTopPx.right[index] - offsets.right;
        const theirsBot = theirsTop + layout.paneHPx.right[index];
        // A hunk whose result has no rows (both sides changed a spot
        // the base left empty) draws no in-pane band in the middle
        // column; extend the pending side's divider band across the
        // gap so the thin insertion line reads as one continuous
        // PyCharm line instead of stopping at the middle pane's
        // content edges.
        const middleEmpty = midBot - midTop <= 0;
        const gapBands = bandSpansForMiddleGap(
            leftSpans.band,
            rightSpans.band,
            middleEmpty,
            left !== undefined && !left.resolved,
            right !== undefined && !right.resolved,
        );
        // One-sided hunks (ours-only / theirs-only) carry a
        // suggestion on only one divider — connectorSideSpecs already
        // omitted the other side, so only draw the side present.
        if (left) {
            // Stacked resolutions point each side at its own result
            // slice; a lone accepted side leaves the other side a
            // zero-height append-edge slice.
            const leftTarget = sliceExtent(midTop, midBot, left.midSlice);
            setRibbonPath(
                paths.get(`${id}-left`),
                { band: gapBands.left, contour: leftSpans.contour },
                oursTop,
                oursBot,
                leftTarget.top,
                leftTarget.bot,
                viewportH,
                left.resolved,
            );
        }
        if (right) {
            const rightSource = sliceExtent(midTop, midBot, right.midSlice);
            setRibbonPath(
                paths.get(`${id}-right`),
                { band: gapBands.right, contour: rightSpans.contour },
                rightSource.top,
                rightSource.bot,
                theirsTop,
                theirsBot,
                viewportH,
                right.resolved,
            );
        }
    }
}
