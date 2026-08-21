// Merge-only ribbon adapter.
// The generic layout and adjacent-pane SVG geometry live in diff-core; this
// helper preserves the merge editor's special three-pane empty-result behavior.

import type { RibbonSpan } from "../diff-core/mergeScrollLayout";

/**
 * Extends pending band spans across the middle pane when a merge hunk has no
 * result rows, so the thin line remains continuous through all three panels.
 * Only pending sides extend; when both are pending, only the left band extends
 * to avoid double-painting the shared middle run.
 */
export function bandSpansForMiddleGap(
    leftBand: RibbonSpan,
    rightBand: RibbonSpan,
    middleEmpty: boolean,
    leftPending: boolean,
    rightPending: boolean,
): { left: RibbonSpan; right: RibbonSpan } {
    if (!middleEmpty) return { left: leftBand, right: rightBand };
    const left = leftPending ? { ...leftBand, x1: rightBand.x0 } : leftBand;
    const right = rightPending && !leftPending ? { ...rightBand, x0: leftBand.x1 } : rightBand;
    return { left, right };
}
