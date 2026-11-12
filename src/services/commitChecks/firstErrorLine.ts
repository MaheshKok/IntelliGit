// Finds where a CI log's failure starts and cuts the excerpt around it. Host side only:
// the stored log never leaves the extension host, the excerpt does.

import {
    CI_EXCERPT_MAX_BYTES,
    CI_EXCERPT_MAX_LINES,
    cleanExcerptText,
    sanitizeExcerpt,
} from "../../shared/ci/excerpt";

/** How a provider marks errors in its logs. */
export interface CiLogErrorRules {
    /** Provider error markers, tried line by line in order; the first matching line wins. */
    patterns: readonly RegExp[];
    /** Text on the failing step's start line; the error-word fallback searches after it. */
    stepStart?: string;
}

/** The generic error words used when no provider marker matches. */
const ERROR_WORD = /\b(error|failed)\b/i;

/** Lines shown before the first error line in an excerpt. */
const EXCERPT_LINES_BEFORE = 5;

/**
 * The 0-based line where a log's failure starts.
 *
 * Tries the provider patterns first, then the first line with "error" or "failed" after the
 * failing step's start line (the whole log when that line is unknown or absent), then the last
 * line.
 *
 * @param text - Full log text.
 * @param rules - The provider's markers and the failing step's start text.
 */
export function findFirstErrorLine(text: string, rules: CiLogErrorRules): number {
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    // `search` ignores `lastIndex`, so a global pattern cannot skip a line.
    const marked = lines.findIndex((line) =>
        rules.patterns.some((pattern) => line.search(pattern) !== -1),
    );
    if (marked !== -1) return marked;
    const stepStart = rules.stepStart
        ? lines.findIndex((line) => line.includes(rules.stepStart as string))
        : -1;
    const from = stepStart + 1;
    const worded = lines.slice(from).findIndex((line) => ERROR_WORD.test(line));
    if (worded !== -1) return from + worded;
    return lines.length - 1;
}

/**
 * The webview-safe excerpt around `firstErrorLine`: a few lines before it and the lines after it,
 * at most 40 lines and 8 KB, sanitised by `sanitizeExcerpt`. Context lines before the error are
 * dropped when they alone would push the error line out of the 8 KB.
 *
 * @param text - Full log text.
 * @param firstErrorLine - 0-based line from `findFirstErrorLine`.
 */
export function buildCiLogExcerpt(text: string, firstErrorLine: number): string {
    const lines = text.split("\n");
    let start = Math.max(0, firstErrorLine - EXCERPT_LINES_BEFORE);
    while (
        start < firstErrorLine &&
        Buffer.byteLength(
            cleanExcerptText(lines.slice(start, firstErrorLine + 1).join("\n")),
            "utf8",
        ) > CI_EXCERPT_MAX_BYTES
    ) {
        start++;
    }
    return sanitizeExcerpt(lines.slice(start, start + CI_EXCERPT_MAX_LINES).join("\n"));
}
