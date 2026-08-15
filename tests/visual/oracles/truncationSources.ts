/**
 * Collects every string leaf from a recorded fixture payload.
 *
 * The payload is the external record of user data that the rendered webview received, so the
 * oracle never derives its expected value from the DOM it is checking.
 */
export function collectSourceStrings(messages: readonly unknown[]): readonly string[] {
    const strings = new Set<string>();

    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            strings.add(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (value !== null && typeof value === "object") {
            Object.values(value).forEach(visit);
        }
    };

    messages.forEach(visit);
    return [...strings].sort();
}

/**
 * The one spelling every comparison in this file runs against.
 *
 * The catalog spells the "opens a dialog" convention both ways, so the boundary checks used to
 * loop over both spellings and each entry then accused the other of truncating it. Canonicalizing
 * in `normalizeText` instead makes the two spellings one string, which is what they always were.
 */
const ELLIPSIS = "…";

/** Normalizes the two representations before comparing their source boundaries. */
function normalizeText(value: string): string {
    return value
        .normalize("NFC")
        .replace(/\.\.\./gu, ELLIPSIS)
        .replace(/\s+/gu, " ")
        .trim();
}

function hasTailEllipsis(rendered: string, source: string): boolean {
    if (!rendered.endsWith(ELLIPSIS)) {
        return false;
    }
    const prefix = rendered.slice(0, -ELLIPSIS.length);
    return prefix.length > 0 && prefix.length < source.length && source.startsWith(prefix);
}

function hasMiddleEllipsis(rendered: string, source: string): boolean {
    let ellipsisIndex = rendered.indexOf(ELLIPSIS);
    while (ellipsisIndex >= 0) {
        const suffixStart = ellipsisIndex + ELLIPSIS.length;
        if (ellipsisIndex > 0 && suffixStart < rendered.length) {
            const prefix = rendered.slice(0, ellipsisIndex);
            const suffix = rendered.slice(suffixStart);
            if (
                source.startsWith(prefix) &&
                source.endsWith(suffix) &&
                prefix.length + suffix.length < source.length
            ) {
                return true;
            }
        }
        ellipsisIndex = rendered.indexOf(ELLIPSIS, ellipsisIndex + ELLIPSIS.length);
    }
    return false;
}

/**
 * Finds every fixture source that could have produced an abbreviated rendered string.
 *
 * Matching is deliberately structural rather than length-based: short strings need no special
 * exclusion, and multiple matching payload values remain visible to the caller as ambiguity.
 */
export interface TruncationMatch {
    readonly rendered: string;
    readonly sources: readonly string[];
    /**
     * True when the vocabulary ALSO contains this rendering verbatim, so it may be a complete
     * label rather than a cut one and the two cases cannot be told apart from the strings alone.
     */
    readonly completeSourceExists: boolean;
}

/** Returns all sorted source strings that the rendered value abbreviates, or `undefined`. */
export function matchTruncatedRendering(
    rendered: string,
    sources: readonly string[],
): TruncationMatch | undefined {
    const normalizedRendered = normalizeText(rendered);
    const matchingSources = new Set<string>();
    let completeSourceExists = false;

    for (const source of sources) {
        const normalizedSource = normalizeText(source);

        // A source that IS the rendering cannot also be the longer string the rendering was cut
        // from, so it is recorded and skipped rather than compared. Abandoning the whole element
        // on this -- which is what a vocabulary-wide membership test did -- throws away the case
        // that matters: a fixture holding both a real `Merge...` command label and a truncated
        // `Merge branch 'feature'` has an element that could be either, and answering "complete"
        // silently skips the accessible-name check for a name that may well be lost.
        if (normalizedSource === normalizedRendered) {
            completeSourceExists = true;
            continue;
        }

        if (
            !hasTailEllipsis(normalizedRendered, normalizedSource) &&
            !hasMiddleEllipsis(normalizedRendered, normalizedSource)
        ) {
            continue;
        }
        matchingSources.add(source);
    }

    if (matchingSources.size === 0) {
        return undefined;
    }
    return { rendered, sources: [...matchingSources].sort(), completeSourceExists };
}
