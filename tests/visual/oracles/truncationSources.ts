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

/** Normalizes the two representations before comparing their source boundaries. */
function normalizeText(value: string): string {
    return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function hasTailEllipsis(rendered: string, source: string): boolean {
    for (const ellipsis of ["…", "..."] as const) {
        if (!rendered.endsWith(ellipsis)) {
            continue;
        }
        const prefix = rendered.slice(0, -ellipsis.length);
        if (
            prefix.length > 0 &&
            prefix.length < source.length &&
            source.startsWith(prefix)
        ) {
            return true;
        }
    }
    return false;
}

function hasMiddleEllipsis(rendered: string, source: string): boolean {
    for (const ellipsis of ["…", "..."] as const) {
        let ellipsisIndex = rendered.indexOf(ellipsis);
        while (ellipsisIndex >= 0) {
            const suffixStart = ellipsisIndex + ellipsis.length;
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
            ellipsisIndex = rendered.indexOf(ellipsis, ellipsisIndex + ellipsis.length);
        }
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
}

/** Returns all sorted source strings that the rendered value abbreviates, or `undefined`. */
export function matchTruncatedRendering(
    rendered: string,
    sources: readonly string[],
): TruncationMatch | undefined {
    const normalizedRendered = normalizeText(rendered);
    const matchingSources = new Set<string>();

    // A rendering that appears verbatim anywhere in the source vocabulary is complete, even when it
    // ends in an ellipsis. `Merge...` is a deliberate "opens a dialog" label, not a clipped
    // `Merge branch xyz` -- and once catalog strings joined the source set, the catalog's two
    // spellings of that convention (`Merge...` and `Merge…`) each looked like a truncation of the
    // other. Checking membership only against the source currently being compared is not enough:
    // the accusing source is always a different entry.
    if (sources.some((source) => normalizeText(source) === normalizedRendered)) {
        return undefined;
    }

    for (const source of sources) {
        const normalizedSource = normalizeText(source);
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
    return { rendered, sources: [...matchingSources].sort() };
}
