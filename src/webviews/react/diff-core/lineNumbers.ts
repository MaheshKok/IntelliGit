// Shared line-number helpers for pane renderers.

/** Line-number value for a rendered row; `null` reserves padding rows. */
export type LineNumberValue = number | null;

/**
 * Builds displayed line numbers for one pane, using null placeholders when a
 * shorter side needs visual padding to align with its rendered row count.
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
