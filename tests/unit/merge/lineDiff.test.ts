// Spec-derived tests for the IntelliJ-style line diff pipeline (lineDiff.ts).
// Expectations come from the IntelliJ merge diff contract (important-line
// anchoring, gap re-diff, boundary sliding) — not from the implementation.
import { describe, expect, it } from "vitest";

import { diffLinesFair, type EqualRange } from "../../../src/mergeEditor/lineDiff";

function assertValidRanges(ranges: EqualRange[], lines1: string[], lines2: string[]): void {
    let prev1 = 0;
    let prev2 = 0;
    for (const range of ranges) {
        expect(range.start1).toBeGreaterThanOrEqual(prev1);
        expect(range.start2).toBeGreaterThanOrEqual(prev2);
        expect(range.end1).toBeGreaterThan(range.start1);
        expect(range.end2).toBeGreaterThan(range.start2);
        expect(range.end1 - range.start1).toBe(range.end2 - range.start2);
        expect(range.end1).toBeLessThanOrEqual(lines1.length);
        expect(range.end2).toBeLessThanOrEqual(lines2.length);
        for (let i = 0; i < range.end1 - range.start1; i++) {
            expect(lines1[range.start1 + i]).toBe(lines2[range.start2 + i]);
        }
        prev1 = range.end1;
        prev2 = range.end2;
    }
}

describe("diffLinesFair — degenerate inputs", () => {
    it("returns no ranges for two empty files", () => {
        expect(diffLinesFair([], [])).toEqual([]);
    });

    it("returns no ranges when one side is empty", () => {
        expect(diffLinesFair([], ["const value = 1;"])).toEqual([]);
        expect(diffLinesFair(["const value = 1;"], [])).toEqual([]);
    });

    it("returns one full-cover range for identical files", () => {
        const lines = ["function greet() {", "  return 'hello';", "}"];
        expect(diffLinesFair(lines, [...lines])).toEqual([
            { start1: 0, end1: 3, start2: 0, end2: 3 },
        ]);
    });

    it("returns no ranges for completely different files", () => {
        const result = diffLinesFair(
            ["const alpha = 1;", "const beta = 2;"],
            ["let gamma = 3;", "let delta = 4;"],
        );
        expect(result).toEqual([]);
    });

    it("matches a single identical line", () => {
        expect(diffLinesFair(["only line here"], ["only line here"])).toEqual([
            { start1: 0, end1: 1, start2: 0, end2: 1 },
        ]);
    });
});

describe("diffLinesFair — important-line anchoring", () => {
    it("does not let unimportant lines create anchors across unrelated scopes", () => {
        // Two functions; the first is rewritten. Its closing brace must stay
        // attached to the unchanged tail, not fragment the change.
        const lines1 = [
            "function alpha() {",
            "  return 1;",
            "}",
            "function beta() {",
            "  return 2;",
            "}",
        ];
        const lines2 = [
            "function gamma() {",
            "  return 3;",
            "}",
            "function beta() {",
            "  return 2;",
            "}",
        ];
        expect(diffLinesFair(lines1, lines2)).toEqual([
            { start1: 2, end1: 6, start2: 2, end2: 6 },
        ]);
    });

    it("prefers the high-information line when two anchor candidates cross", () => {
        // Only one of the two shared lines can match (order is inverted).
        // The information-rich statement must win over structural noise.
        const lines1 = ["database: {", "middle aaa bbb", "return this.config;"];
        const lines2 = ["return this.config;", "middle ccc ddd", "database: {"];
        expect(diffLinesFair(lines1, lines2)).toEqual([
            { start1: 2, end1: 3, start2: 0, end2: 1 },
        ]);
    });

    it("still matches unimportant lines when no important anchors exist", () => {
        // Inside a single gap, standalone unimportant runs may match.
        const lines1 = ["first aaa", "}", "second bbb"];
        const lines2 = ["third ccc", "}", "fourth ddd"];
        expect(diffLinesFair(lines1, lines2)).toEqual([
            { start1: 1, end1: 2, start2: 1, end2: 2 },
        ]);
    });

    it("matches all-blank files by position", () => {
        expect(diffLinesFair(["", "", ""], ["", ""])).toEqual([
            { start1: 0, end1: 2, start2: 0, end2: 2 },
        ]);
    });
});

describe("diffLinesFair — gap correction", () => {
    it("expands equal runs inward from gap edges", () => {
        // "shared tail" sits at the end of the gap between changed regions and
        // must be recovered even though it is not an important-line anchor
        // match (it pairs via edge expansion).
        const lines1 = ["header line one", "old middle aaa", "shared tail", "footer line two"];
        const lines2 = ["header line one", "new middle bbb", "shared tail", "footer line two"];
        expect(diffLinesFair(lines1, lines2)).toEqual([
            { start1: 0, end1: 1, start2: 0, end2: 1 },
            { start1: 2, end1: 4, start2: 2, end2: 4 },
        ]);
    });

    it("recovers matches inside a gap between anchors", () => {
        const lines1 = [
            "function outer() {",
            "  const kept = compute();",
            "  removed line aaa",
            "  return kept;",
            "}",
        ];
        const lines2 = [
            "function outer() {",
            "  added line bbb",
            "  const kept = compute();",
            "  return kept;",
            "}",
        ];
        const result = diffLinesFair(lines1, lines2);
        assertValidRanges(result, lines1, lines2);
        // "const kept" must be matched (1 -> 2) despite surrounding edits.
        expect(
            result.some(
                (r) => r.start1 <= 1 && r.end1 > 1 && r.start2 + (1 - r.start1) === 2,
            ),
        ).toBe(true);
        // "return kept;" and "}" stay matched positionally.
        expect(result[result.length - 1]).toEqual({ start1: 3, end1: 5, start2: 3, end2: 5 });
    });
});

describe("diffLinesFair — chunk boundary optimization", () => {
    it("slides an ambiguous boundary so the change block ends at a blank line", () => {
        // The inserted block could be ["NEW THING", "", "common mid"] or
        // ["common mid", "NEW THING", ""]; the slider must pick the boundary
        // adjacent to the blank (unimportant) line.
        const lines1 = ["alpha text", "common mid", "beta text"];
        const lines2 = ["alpha text", "common mid", "NEW THING", "", "common mid", "beta text"];
        expect(diffLinesFair(lines1, lines2)).toEqual([
            { start1: 0, end1: 1, start2: 0, end2: 1 },
            { start1: 1, end1: 3, start2: 4, end2: 6 },
        ]);
    });

    it("keeps a boundary that already starts at a blank line", () => {
        const lines1 = ["alpha text", "common mid", "beta text"];
        const lines2 = ["alpha text", "common mid", "", "NEW THING", "common mid", "beta text"];
        expect(diffLinesFair(lines1, lines2)).toEqual([
            { start1: 0, end1: 2, start2: 0, end2: 2 },
            { start1: 2, end1: 3, start2: 5, end2: 6 },
        ]);
    });

    it("merges an appended duplicate block into one contiguous match", () => {
        // [A]B[B] -> [AB]B: the equal blocks join instead of leaving a
        // zero-length seam in the middle.
        const lines1 = ["intro words", "repeat block", "repeat block", "outro words"];
        const lines2 = ["intro words", "repeat block", "outro words"];
        const result = diffLinesFair(lines1, lines2);
        assertValidRanges(result, lines1, lines2);
        expect(result.length).toBe(2);
    });
});

describe("diffLinesFair — whitespace handling", () => {
    it("treats whitespace-only differences as equal when ignoreWhitespace is set", () => {
        const lines1 = ["  const value = compute( a, b );  "];
        const lines2 = ["const value = compute( a,   b );"];
        expect(diffLinesFair(lines1, lines2, { ignoreWhitespace: true })).toEqual([
            { start1: 0, end1: 1, start2: 0, end2: 1 },
        ]);
        expect(diffLinesFair(lines1, lines2, {})).toEqual([]);
    });

    it("keeps whitespace significant by default", () => {
        const lines1 = ["    indented statement();"];
        const lines2 = ["indented statement();"];
        expect(diffLinesFair(lines1, lines2)).toEqual([]);
    });
});

describe("diffLinesFair — structural invariants", () => {
    it("produces monotonic, in-bounds, content-equal ranges on a mixed fixture", () => {
        const lines1 = [
            "import { thing } from 'lib';",
            "",
            "export function main() {",
            "  const a = load();",
            "  process(a);",
            "  return a;",
            "}",
        ];
        const lines2 = [
            "import { thing } from 'lib';",
            "import { extra } from 'other';",
            "",
            "export function main() {",
            "  const a = loadFast();",
            "  process(a);",
            "  audit(a);",
            "  return a;",
            "}",
        ];
        const result = diffLinesFair(lines1, lines2);
        assertValidRanges(result, lines1, lines2);
        // The unchanged skeleton must be recovered.
        expect(result.some((r) => r.start1 === 0 && r.start2 === 0)).toBe(true);
        expect(result[result.length - 1].end1).toBe(lines1.length);
        expect(result[result.length - 1].end2).toBe(lines2.length);
    });
});
