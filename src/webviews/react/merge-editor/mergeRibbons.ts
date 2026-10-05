import type { ConflictSegment, HunkResolution, HunkSideDismissal } from "./types";
import { connectorClass } from "./segments";

export const MERGE_PANES = ["left", "middle", "right"] as const;
/** One of the three ordered merge columns. */
export type MergePaneId = (typeof MERGE_PANES)[number];

/** Row extent of one side's target inside the stacked result block (in lines). */
export interface ResultSlice {
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
