import type { DiffSegment } from "../../protocol/diffViewerTypes";
import type { DiffPane } from "./segmentMarkers";

/**
 * The geometry contributed by the currently edited block to the whole diff view.
 *
 * `indices` identifies the aligned segment range, `rowCount` controls vertical layout, and
 * `maxLineLength` contributes to the shared horizontal extent. `pendingGrowthTargetIndex` keeps
 * paint and geometry on the same host segment while unposted rows are pending. The draft may
 * change its text without changing any of these values, so callers can retain the previous state
 * object when the effective whole-view geometry remains unchanged.
 */
export interface EditableBlockLayout {
    readonly side: DiffPane;
    readonly indices: readonly number[];
    readonly rowCount: number;
    /** Active host segment that owns rows beyond the latest echoed run. */
    readonly pendingGrowthTargetIndex: number | null;
    /** Longest line in the draft, in UTF-16 code units. */
    readonly maxLineLength: number;
}

/** Computes the base shared width from the authoritative diff segments only. */
export function baseMaxLineLengthForSegments(segments: readonly DiffSegment[]): number {
    let max = 1;
    for (const segment of segments) {
        for (const line of segment.left) max = Math.max(max, line.length);
        for (const line of segment.right) max = Math.max(max, line.length);
    }
    return max;
}

/** Returns the shared width required by the base diff and the latest draft in constant time. */
export function effectiveMaxLineLength(
    baseMaxLineLength: number,
    latestDraft: EditableBlockLayout | null,
): number {
    return Math.max(baseMaxLineLength, latestDraft?.maxLineLength ?? 0);
}

/** Compares aligned segment indices element by element without serializing the arrays. */
function sameIndices(previous: readonly number[], next: readonly number[]): boolean {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index++) {
        if (previous[index] !== next[index]) return false;
    }
    return true;
}

/**
 * Tests whether replacing one draft layout can affect visible whole-view geometry.
 *
 * Widths are compared after applying the base diff width: a draft that remains within that
 * extent cannot change the shared scrollbar, while crossing it must trigger an update. Segment
 * indices are compared element by element so distinct ranges cannot collide through serialization.
 */
export function sameEffectiveEditableBlockLayout(
    previous: EditableBlockLayout | null,
    next: EditableBlockLayout | null,
    baseMaxLineLength: number,
): boolean {
    if (previous === next) return true;
    if (previous === null || next === null) return false;
    if (
        previous.side !== next.side ||
        previous.rowCount !== next.rowCount ||
        previous.pendingGrowthTargetIndex !== next.pendingGrowthTargetIndex
    ) {
        return false;
    }
    if (!sameIndices(previous.indices, next.indices)) return false;
    return (
        Math.max(baseMaxLineLength, previous.maxLineLength) ===
        Math.max(baseMaxLineLength, next.maxLineLength)
    );
}
