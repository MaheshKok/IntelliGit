import { describe, expect, it } from "vitest";

import { CI_EXCERPT_MAX_BYTES, CI_EXCERPT_MAX_LINES } from "../../../../src/shared/ci/excerpt";
import {
    buildCiLogExcerpt,
    findFirstErrorLine,
} from "../../../../src/services/commitChecks/firstErrorLine";

const GITHUB = { patterns: [/##\[error\]/], stepStart: "##[group]Run tests" };

describe("findFirstErrorLine", () => {
    it("pattern, then step fallback, then last line", () => {
        const withMarker = [
            "##[group]Set up job",
            "build failed earlier in a warning",
            "##[group]Run tests",
            "1 test failed",
            "##[error]Process completed with exit code 1.",
            "cleanup",
        ].join("\n");
        expect(findFirstErrorLine(withMarker, GITHUB)).toBe(4);

        // No provider marker: the first error word after the failing step's start line.
        const withoutMarker = [
            "##[group]Set up job",
            "an error in setup that is not the failure",
            "##[group]Run tests",
            "ok 1",
            "Tests FAILED: 2",
            "done",
        ].join("\n");
        expect(findFirstErrorLine(withoutMarker, GITHUB)).toBe(4);

        // Nothing matches: the last line, ignoring the trailing newline.
        expect(findFirstErrorLine("one\ntwo\nthree\n", GITHUB)).toBe(2);
    });

    it("searches the whole log for the error word when the step start is unknown", () => {
        const text = "setup\nERROR in compile\nlater error";
        expect(findFirstErrorLine(text, { patterns: [] })).toBe(1);
    });

    it("matches a multiline-anchored pattern on its own line", () => {
        const text = "Running\nnot an ERROR: here\nERROR: Job failed: exit code 1\n";
        expect(findFirstErrorLine(text, { patterns: [/^ERROR: /m] })).toBe(2);
    });

    it("a global pattern does not skip lines through its lastIndex", () => {
        const text = "x ##[error]a\n##[error]b";
        const rules = { patterns: [/##\[error\]/g] };
        expect(findFirstErrorLine(text, rules)).toBe(0);
        expect(findFirstErrorLine(text, rules)).toBe(0);
    });
});

describe("buildCiLogExcerpt", () => {
    it("shows the lines around the first error, bounded and sanitised", () => {
        const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
        lines[120] = "\u001b[31m##[error]boom\u001b[0m";
        const excerpt = buildCiLogExcerpt(lines.join("\n"), 120);
        const shown = excerpt.split("\n");
        expect(shown.length).toBeLessThanOrEqual(CI_EXCERPT_MAX_LINES);
        expect(shown).toContain("##[error]boom");
        expect(shown[0]).toBe("line 115");
    });

    it("stays within 8 KB for huge lines and keeps the error line in view", () => {
        const text = `${"x".repeat(100_000)}\nerror here\n${"y".repeat(100_000)}`;
        const excerpt = buildCiLogExcerpt(text, 1);
        expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(CI_EXCERPT_MAX_BYTES);
        expect(excerpt.startsWith("error here")).toBe(true);
    });
});
