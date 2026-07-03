// Intra-hunk row alignment for the three-way merge editor. Maps the ours and
// theirs line arrays of one conflict hunk onto a shared row grid anchored on
// the base version: each side is aligned against base (like PyCharm), so
// similar lines occupy the same row index and gaps become explicit null
// spacer rows. When the hunk has no base lines (dual insertion), the sides
// are aligned directly against each other instead.

import {
    computeLineAlignmentActions,
    MAX_LINE_ALIGNMENT_CELLS,
} from "../../../mergeEditor/wordDiff";

/**
 * Row layout for one conflict hunk. `ours`, `theirs`, and `base` always have
 * `rowCount` entries; `null` entries are spacer rows that exist purely so the
 * other panes' content lines up. The line-index arrays map each row back to
 * the source line position inside the hunk (or `null` on spacers) so line
 * numbers can skip spacer rows. `base` carries the base line sharing a row,
 * used as the word-diff comparison target for both side panes.
 */
export interface AlignedHunkRows {
    rowCount: number;
    ours: Array<string | null>;
    theirs: Array<string | null>;
    base: Array<string | null>;
    oursLineIndex: Array<number | null>;
    theirsLineIndex: Array<number | null>;
}

/** Mutable row accumulator shared by the alignment builders. */
interface RowBuilder {
    ours: Array<string | null>;
    theirs: Array<string | null>;
    base: Array<string | null>;
    oursLineIndex: Array<number | null>;
    theirsLineIndex: Array<number | null>;
}

function newRowBuilder(): RowBuilder {
    return { ours: [], theirs: [], base: [], oursLineIndex: [], theirsLineIndex: [] };
}

function toAlignedRows(rows: RowBuilder): AlignedHunkRows {
    return { rowCount: rows.ours.length, ...rows };
}

/**
 * Aligns the two sides of a conflict hunk onto a shared row grid using the
 * same similarity-scored alignment path as the word-diff comparator. With a
 * non-empty base, each side is aligned against base independently and the two
 * alignments are merged on the base axis; without base lines the sides are
 * aligned directly against each other.
 *
 * Guarantees: source lines are never reordered, rewritten, or dropped; all
 * outputs have identical length; no row is a spacer in all three columns.
 * Hunks whose size would make an alignment matrix too expensive fall back to
 * a top-aligned layout (content first, spacers below).
 */
export function alignConflictRows(
    oursLines: string[],
    theirsLines: string[],
    baseLines: string[] = [],
): AlignedHunkRows {
    const m = oursLines.length;
    const n = theirsLines.length;
    const b = baseLines.length;
    if (m === 0 && n === 0 && b === 0) {
        return toAlignedRows(newRowBuilder());
    }

    if (b === 0) {
        if (m === 0 || n === 0 || m * n > MAX_LINE_ALIGNMENT_CELLS) {
            return topAlignedRows(oursLines, theirsLines, baseLines);
        }
        return sideAlignedRows(oursLines, theirsLines);
    }

    if (b * m > MAX_LINE_ALIGNMENT_CELLS || b * n > MAX_LINE_ALIGNMENT_CELLS) {
        return topAlignedRows(oursLines, theirsLines, baseLines);
    }
    return baseAnchoredRows(oursLines, theirsLines, baseLines);
}

/**
 * How one side maps onto the base axis: for each base line, the paired side
 * line index (or null when the side dropped it), plus the side lines inserted
 * before each base position.
 */
interface BaseAxisMapping {
    pairedLine: Array<number | null>;
    insertedBefore: number[][];
}

function mapSideOntoBase(baseLines: string[], sideLines: string[]): BaseAxisMapping {
    const pairedLine: Array<number | null> = Array.from({ length: baseLines.length }, () => null);
    const insertedBefore: number[][] = Array.from({ length: baseLines.length + 1 }, () => []);

    const actions = computeLineAlignmentActions(baseLines, sideLines);
    let baseIndex = 0;
    let sideIndex = 0;
    for (const action of actions) {
        if (action === "pair") {
            pairedLine[baseIndex] = sideIndex;
            baseIndex++;
            sideIndex++;
        } else if (action === "skipA") {
            // Base line with no counterpart on this side.
            baseIndex++;
        } else {
            // Side line inserted relative to base.
            insertedBefore[baseIndex].push(sideIndex);
            sideIndex++;
        }
    }
    return { pairedLine, insertedBefore };
}

/** Base-hub layout: merge both side-to-base alignments on the base axis. */
function baseAnchoredRows(
    oursLines: string[],
    theirsLines: string[],
    baseLines: string[],
): AlignedHunkRows {
    const oursMap = mapSideOntoBase(baseLines, oursLines);
    const theirsMap = mapSideOntoBase(baseLines, theirsLines);
    const rows = newRowBuilder();

    const pushOursInsertion = (lineIndex: number): void => {
        rows.ours.push(oursLines[lineIndex]);
        rows.theirs.push(null);
        rows.base.push(null);
        rows.oursLineIndex.push(lineIndex);
        rows.theirsLineIndex.push(null);
    };
    const pushTheirsInsertion = (lineIndex: number): void => {
        rows.ours.push(null);
        rows.theirs.push(theirsLines[lineIndex]);
        rows.base.push(null);
        rows.oursLineIndex.push(null);
        rows.theirsLineIndex.push(lineIndex);
    };

    for (let k = 0; k <= baseLines.length; k++) {
        for (const lineIndex of oursMap.insertedBefore[k]) pushOursInsertion(lineIndex);
        for (const lineIndex of theirsMap.insertedBefore[k]) pushTheirsInsertion(lineIndex);
        if (k === baseLines.length) break;

        const oursLine = oursMap.pairedLine[k];
        const theirsLine = theirsMap.pairedLine[k];
        rows.ours.push(oursLine === null ? null : oursLines[oursLine]);
        rows.theirs.push(theirsLine === null ? null : theirsLines[theirsLine]);
        rows.base.push(baseLines[k]);
        rows.oursLineIndex.push(oursLine);
        rows.theirsLineIndex.push(theirsLine);
    }

    return toAlignedRows(rows);
}

/** Direct ours-to-theirs layout used when the hunk has no base lines. */
function sideAlignedRows(oursLines: string[], theirsLines: string[]): AlignedHunkRows {
    const actions = computeLineAlignmentActions(oursLines, theirsLines);
    const rows = newRowBuilder();
    let i = 0;
    let j = 0;
    for (const action of actions) {
        if (action === "pair") {
            rows.ours.push(oursLines[i]);
            rows.theirs.push(theirsLines[j]);
            rows.oursLineIndex.push(i);
            rows.theirsLineIndex.push(j);
            i++;
            j++;
        } else if (action === "skipA") {
            rows.ours.push(oursLines[i]);
            rows.theirs.push(null);
            rows.oursLineIndex.push(i);
            rows.theirsLineIndex.push(null);
            i++;
        } else {
            rows.ours.push(null);
            rows.theirs.push(theirsLines[j]);
            rows.oursLineIndex.push(null);
            rows.theirsLineIndex.push(j);
            j++;
        }
        rows.base.push(null);
    }
    return toAlignedRows(rows);
}

/**
 * Cheap fallback layout: all columns start at row zero and shorter columns
 * are padded with trailing spacers. Used for empty sides and oversized hunks.
 */
function topAlignedRows(
    oursLines: string[],
    theirsLines: string[],
    baseLines: string[],
): AlignedHunkRows {
    const rowCount = Math.max(oursLines.length, theirsLines.length, baseLines.length);
    const rows = newRowBuilder();
    for (let row = 0; row < rowCount; row++) {
        rows.ours.push(row < oursLines.length ? oursLines[row] : null);
        rows.theirs.push(row < theirsLines.length ? theirsLines[row] : null);
        rows.base.push(row < baseLines.length ? baseLines[row] : null);
        rows.oursLineIndex.push(row < oursLines.length ? row : null);
        rows.theirsLineIndex.push(row < theirsLines.length ? row : null);
    }
    return toAlignedRows(rows);
}
