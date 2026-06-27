// Shared line-number helpers for the merge editor.
// Kept outside segment components so Fast Refresh sees component modules cleanly.

/** Line-number value for a rendered row; `null` reserves padding rows. */
export type LineNumberValue = number | null;

/**
 * Builds displayed line numbers for a pane, using null placeholders when a
 * shorter side needs visual padding to align with the hunk's row count.
 */
export function buildLineNumberValues(
    startAt: number,
    actualCount: number,
    rowCount: number,
): LineNumberValue[] {
    const values: LineNumberValue[] = [];
    for (let i = 0; i < rowCount; i++) {
        values.push(i < actualCount ? startAt + i : null);
    }
    return values;
}

/**
 * Builds displayed line numbers from an intra-hunk row alignment: rows mapped
 * to a source line get sequential numbers while spacer rows render blank.
 */
export function buildAlignedLineNumberValues(
    startAt: number,
    lineIndex: Array<number | null>,
    rowCount: number,
): LineNumberValue[] {
    const values: LineNumberValue[] = [];
    for (let i = 0; i < rowCount; i++) {
        const sourceIndex = i < lineIndex.length ? lineIndex[i] : null;
        values.push(sourceIndex === null ? null : startAt + sourceIndex);
    }
    return values;
}
