// Intra-hunk row alignment for the three-way merge editor. Maps the ours and
// theirs line arrays of one conflict hunk onto a shared row grid: similar
// lines occupy the same row index and gaps become explicit null spacer rows,
// matching how IntelliJ keeps its side panes vertically locked together.

import { computeLineAlignmentActions, MAX_LINE_ALIGNMENT_CELLS } from "./wordDiff";

/**
 * Row layout for one conflict hunk. `ours` and `theirs` always have
 * `rowCount` entries; `null` entries are spacer rows that exist purely so the
 * opposite pane's content lines up. The line-index arrays map each row back
 * to the source line position inside the hunk (or `null` on spacers) so line
 * numbers can skip spacer rows.
 */
export interface AlignedHunkRows {
    rowCount: number;
    ours: Array<string | null>;
    theirs: Array<string | null>;
    oursLineIndex: Array<number | null>;
    theirsLineIndex: Array<number | null>;
}

/**
 * Aligns the two sides of a conflict hunk onto a shared row grid using the
 * same similarity-scored alignment path as the word-diff comparator.
 *
 * Guarantees: source lines are never reordered, rewritten, or dropped; both
 * outputs have identical length; no row is a spacer on both sides. Hunks
 * whose size would make the alignment matrix too expensive fall back to a
 * top-aligned layout (content first, spacers below).
 */
export function alignConflictRows(oursLines: string[], theirsLines: string[]): AlignedHunkRows {
    const m = oursLines.length;
    const n = theirsLines.length;
    if (m === 0 && n === 0) {
        return { rowCount: 0, ours: [], theirs: [], oursLineIndex: [], theirsLineIndex: [] };
    }
    if (m === 0 || n === 0 || m * n > MAX_LINE_ALIGNMENT_CELLS) {
        return topAlignedRows(oursLines, theirsLines);
    }

    const actions = computeLineAlignmentActions(oursLines, theirsLines);
    const ours: Array<string | null> = [];
    const theirs: Array<string | null> = [];
    const oursLineIndex: Array<number | null> = [];
    const theirsLineIndex: Array<number | null> = [];
    let i = 0;
    let j = 0;
    for (const action of actions) {
        if (action === "pair") {
            ours.push(oursLines[i]);
            theirs.push(theirsLines[j]);
            oursLineIndex.push(i);
            theirsLineIndex.push(j);
            i++;
            j++;
        } else if (action === "skipA") {
            ours.push(oursLines[i]);
            theirs.push(null);
            oursLineIndex.push(i);
            theirsLineIndex.push(null);
            i++;
        } else {
            ours.push(null);
            theirs.push(theirsLines[j]);
            oursLineIndex.push(null);
            theirsLineIndex.push(j);
            j++;
        }
    }

    return { rowCount: ours.length, ours, theirs, oursLineIndex, theirsLineIndex };
}

/**
 * Cheap fallback layout: both sides start at row zero and the shorter side is
 * padded with trailing spacers. Used for empty sides and oversized hunks.
 */
function topAlignedRows(oursLines: string[], theirsLines: string[]): AlignedHunkRows {
    const rowCount = Math.max(oursLines.length, theirsLines.length);
    const ours: Array<string | null> = [];
    const theirs: Array<string | null> = [];
    const oursLineIndex: Array<number | null> = [];
    const theirsLineIndex: Array<number | null> = [];
    for (let row = 0; row < rowCount; row++) {
        ours.push(row < oursLines.length ? oursLines[row] : null);
        theirs.push(row < theirsLines.length ? theirsLines[row] : null);
        oursLineIndex.push(row < oursLines.length ? row : null);
        theirsLineIndex.push(row < theirsLines.length ? row : null);
    }
    return { rowCount, ours, theirs, oursLineIndex, theirsLineIndex };
}
