/** The finding suffix an abbreviated rendering earns, or `undefined` when it is not a finding. */
export type AccessibleNameVerdict = "ambiguous-source" | "truncated-name" | undefined;

export interface AccessibleNameEvidence {
    /** How many vocabulary strings could have been cut down to this rendering. */
    readonly sourceCount: number;
    /** Whether some vocabulary string equals the rendering outright, ellipsis spelling aside. */
    readonly completeSourceExists: boolean;
    /** Whether the element's computed accessible name is the rendering itself. */
    readonly announcesRenderedText: boolean;
    /** Whether the computed accessible name is one of the candidate sources. */
    readonly announcesSomeSource: boolean;
}

/**
 * Decides whether an abbreviated rendering has actually lost content.
 *
 * Split out of the Playwright collector so it can be tested and mutated without a browser: the
 * collector's remaining job is to compute the two accessible-name booleans, which is the part that
 * genuinely needs a page.
 *
 * The rendering measured upstream is `element.textContent`, so CSS `text-overflow: ellipsis` never
 * reaches this oracle -- an overflowing element still reports its full string, and its accessible
 * name is that same full string. Only a JavaScript-side cut (`slice() + "…"`) or a label that ends
 * in the convention ellipsis by design arrives here at all.
 *
 * That is why an element announcing its own rendering verbatim is cleared when a complete source
 * exists: both facts together say the string on screen is a whole vocabulary entry AND every
 * character of it is exposed, so nothing is missing. The evidence is what clears it. A blanket
 * "this rendering appears somewhere in the vocabulary" rule would clear it without ever asking the
 * element, which is how a genuine truncation used to escape; and reporting it regardless would
 * accuse every `Push...`, `Rename...` and `Loading...` menu label in all twelve catalogs of
 * hiding a name it is plainly announcing.
 *
 * A JavaScript-side cut cannot take that exit: `Rename Loc…` matches no complete source, so
 * `completeSourceExists` is false and the announcement of its own truncated text is exactly the
 * defect being reported.
 */
export function classifyAccessibleName(evidence: AccessibleNameEvidence): AccessibleNameVerdict {
    if (evidence.completeSourceExists && evidence.announcesRenderedText) {
        return undefined;
    }
    // Ambiguity is itself the finding: with several candidates in play a passing name check proves
    // only that ONE of them matched, so neither a pass nor a failure settles what was lost.
    if (evidence.sourceCount > 1 || evidence.completeSourceExists) {
        return "ambiguous-source";
    }
    return evidence.announcesSomeSource ? undefined : "truncated-name";
}
