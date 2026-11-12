// Turns a slice of a CI log into inert text that may reach the webview. The webview
// renders the result as a React text node; this removes what a text node would still
// show deceptively (terminal escapes, bidi overrides, control characters) and bounds it.

/** Maximum lines of a log excerpt sent to the webview. */
export const CI_EXCERPT_MAX_LINES = 40;
/** Maximum UTF-8 bytes of a log excerpt sent to the webview. */
export const CI_EXCERPT_MAX_BYTES = 8 * 1024;

// The escape and control characters are the point of these patterns.
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Operating system commands end with BEL or with ESC backslash.
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// C0 except tab and newline, DEL, C1, and the bidi embedding/override/isolate controls.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Sanitizes and bounds a CI log excerpt for display as plain text.
 *
 * @param text - Raw log text around the first error line.
 * @returns At most 40 lines and 8 KB, cut on a UTF-8 boundary, with ANSI escapes removed
 *   and bidi and other control characters (except newline and tab) replaced by U+FFFD.
 */
export function sanitizeExcerpt(text: string): string {
    const lines = cleanExcerptText(text).split("\n").slice(0, CI_EXCERPT_MAX_LINES).join("\n");
    return cutToUtf8Bytes(lines, CI_EXCERPT_MAX_BYTES);
}

/**
 * The cleaning half of `sanitizeExcerpt`, without its bounds: ANSI escapes removed, CRLF made LF,
 * and bidi and other control characters (except newline and tab) replaced by U+FFFD.
 *
 * @param text - Raw log text.
 * @returns The cleaned text, which may be longer in UTF-8 bytes than `text`.
 */
export function cleanExcerptText(text: string): string {
    return text
        .replace(ANSI_OSC, "")
        .replace(ANSI_CSI, "")
        .replace(/\r\n/g, "\n")
        .replace(UNSAFE_CHARS, "�");
}

/** Maximum characters of a provider's failure summary. */
const CI_FAILURE_SUMMARY_MAX_CHARS = 2000;

/**
 * A provider's failure text, cleaned like an excerpt and cut to 2 000 characters.
 *
 * @param text - Raw failure text from the provider.
 * @returns The cleaned text, or undefined when nothing is left.
 */
export function cleanFailureSummary(text: string): string | undefined {
    const cleaned = cleanExcerptText(text).trim();
    if (!cleaned) return undefined;
    return [...cleaned].slice(0, CI_FAILURE_SUMMARY_MAX_CHARS).join("");
}

/** Keeps whole code points while their UTF-8 length fits in `maxBytes`. */
function cutToUtf8Bytes(text: string, maxBytes: number): string {
    let bytes = 0;
    let end = 0;
    for (const char of text) {
        const codePoint = char.codePointAt(0) ?? 0;
        const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += char.length;
    }
    return text.slice(0, end);
}
