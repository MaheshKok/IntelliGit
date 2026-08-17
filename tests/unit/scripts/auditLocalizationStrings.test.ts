import { describe, expect, it } from "vitest";

import { escapeMarkdown } from "../../../scripts/audit-localization-strings.js";

/**
 * `escapeMarkdown` renders candidate strings into a Markdown table cell in the audit report.
 *
 * The cases below are about ORDER, not about the character set. Escaping works by prefixing a
 * backslash, so the backslash is itself a metacharacter and has to be escaped FIRST -- otherwise
 * the escape it writes for a later character gets consumed as the escape for an earlier one, and
 * the delimiter it was protecting goes through unescaped. CodeQL raised this as
 * `js/incomplete-sanitization`, and it is the same class of defect as an incompletely escaped
 * regex: the visible symptom is not a crash but silently wrong output.
 */
describe("audit report Markdown escaping", () => {
    it("keeps a table delimiter escaped even when a backslash precedes it", () => {
        // `\|` is the case the old two-step escape got wrong. It rewrote the pipe to `\|`, which
        // sat directly behind the source backslash and produced `\\|` -- Markdown reads that as an
        // escaped BACKSLASH followed by a live pipe, so the cell ends early and the row gains a
        // column. Asserting on the rendered meaning rather than on a literal spelling: every
        // backslash in the output must belong to a complete escape pair.
        const escaped = escapeMarkdown("a\\|b");

        expect(
            escaped,
            "a source backslash must be doubled so the pipe's own escape is not absorbed by it",
        ).toBe("a\\\\\\|b");
    });

    it("escapes a backslash that stands alone, with no delimiter after it", () => {
        expect(
            escapeMarkdown("C:\\path"),
            "a lone backslash is still a Markdown escape character and must be doubled",
        ).toBe("C:\\\\path");
    });

    it("still escapes the delimiters it always escaped", () => {
        // Guards the fix from over-correcting: adding backslash handling must not drop, reorder,
        // or double-apply the pipe and backtick escaping that the report already depended on.
        expect(escapeMarkdown("a|b"), "pipe must remain escaped").toBe("a\\|b");
        expect(escapeMarkdown("a`b"), "backtick must remain escaped").toBe("a\\`b");
        expect(escapeMarkdown("plain text"), "text with no metacharacters must pass through").toBe(
            "plain text",
        );
    });

    it("leaves no bare delimiter anywhere in a string that mixes all three characters", () => {
        // The property behind the three cases above: after escaping, no `|` or backtick may appear
        // without an odd-length backslash run in front of it. Stated as a property because the
        // literal-spelling assertions can only cover the combinations someone thought to write
        // down, and this is the invariant the report actually needs.
        const escaped = escapeMarkdown("x\\|y`z\\\\|w");
        const bareDelimiter = /(?<!\\)(?:\\\\)*([|`])/.exec(escaped);

        expect(
            bareDelimiter?.[1],
            `every delimiter must sit behind an odd number of backslashes; got ${escaped}`,
        ).toBeUndefined();
    });
});
