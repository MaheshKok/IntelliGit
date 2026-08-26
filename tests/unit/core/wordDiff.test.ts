// Tests for pure word-diff algorithms in diff/wordDiff.ts.

import { describe, it, expect } from "vitest";
import {
    tokenizeWordDiff,
    normalizeLineForWordDiff,
    computeTokenLcsPairs,
    tokenSimilarityRatio,
    alignCompareLinesForWordDiff,
    buildWordDiffMask,
    bridgeChangedWordRuns,
} from "../../../src/diff/wordDiff";

describe("tokenizeWordDiff", () => {
    it("returns empty array for empty string", () => {
        expect(tokenizeWordDiff("")).toEqual([]);
    });

    it("splits words, whitespace, and punctuation", () => {
        const tokens = tokenizeWordDiff("const x = 42;");
        expect(tokens).toEqual(["const", " ", "x", " ", "=", " ", "42", ";"]);
    });

    it("handles single token", () => {
        expect(tokenizeWordDiff("hello")).toEqual(["hello"]);
    });
});

describe("normalizeLineForWordDiff", () => {
    it("collapses whitespace and trims", () => {
        expect(normalizeLineForWordDiff("  hello   world  ")).toBe("hello world");
    });

    it("returns empty string for whitespace-only input", () => {
        expect(normalizeLineForWordDiff("   ")).toBe("");
    });
});

describe("computeTokenLcsPairs", () => {
    it("returns empty for empty arrays", () => {
        expect(computeTokenLcsPairs([], ["a"])).toEqual([]);
        expect(computeTokenLcsPairs(["a"], [])).toEqual([]);
    });

    it("finds LCS pairs for simple case", () => {
        const pairs = computeTokenLcsPairs(["a", "b", "c"], ["a", "c"]);
        expect(pairs).toEqual([
            [0, 0],
            [2, 1],
        ]);
    });

    it("returns full match for identical arrays", () => {
        const arr = ["x", "y", "z"];
        const pairs = computeTokenLcsPairs(arr, arr);
        expect(pairs).toEqual([
            [0, 0],
            [1, 1],
            [2, 2],
        ]);
    });

    it("handles no common elements", () => {
        expect(computeTokenLcsPairs(["a", "b"], ["c", "d"])).toEqual([]);
    });
});

describe("tokenSimilarityRatio", () => {
    it("returns 1 for identical strings", () => {
        expect(tokenSimilarityRatio("hello world", "hello world")).toBe(1);
    });

    it("returns 0.98 for whitespace-only differences", () => {
        expect(tokenSimilarityRatio("hello  world", "hello world")).toBe(0.98);
    });

    it("returns 0 when one is empty and the other is not", () => {
        expect(tokenSimilarityRatio("hello", "")).toBe(0);
        expect(tokenSimilarityRatio("", "hello")).toBe(0);
    });

    it("returns value between 0 and 1 for partially similar strings", () => {
        const ratio = tokenSimilarityRatio("const x = 1;", "const y = 2;");
        expect(ratio).toBeGreaterThan(0);
        expect(ratio).toBeLessThan(1);
    });
});

describe("alignCompareLinesForWordDiff", () => {
    it("returns empty array for empty lines", () => {
        expect(alignCompareLinesForWordDiff([], ["a"])).toEqual([]);
    });

    it("returns empty strings when compare is empty", () => {
        expect(alignCompareLinesForWordDiff(["a", "b"], [])).toEqual(["", ""]);
    });

    it("returns copy when lengths match", () => {
        const result = alignCompareLinesForWordDiff(["a", "b"], ["c", "d"]);
        expect(result).toEqual(["c", "d"]);
    });

    it("aligns lines of different lengths", () => {
        const result = alignCompareLinesForWordDiff(
            ["const x = 1;", "const y = 2;"],
            ["const x = 1;"],
        );
        expect(result).toHaveLength(2);
        expect(result[0]).toBe("const x = 1;");
        expect(result[1]).toBe("");
    });

    it("leaves inserted source lines blank while retaining later matches", () => {
        expect(
            alignCompareLinesForWordDiff(
                ["const inserted = true;", "return total;"],
                ["return total;"],
            ),
        ).toEqual(["", "return total;"]);
    });
});

describe("buildWordDiffMask", () => {
    it("returns all-false for identical lines", () => {
        const mask = buildWordDiffMask("hello world", "hello world");
        expect(mask.every((v) => !v)).toBe(true);
    });

    it("marks changed tokens as true", () => {
        const mask = buildWordDiffMask("const x = 1;", "const y = 2;");
        // At minimum, the differing tokens should be marked
        expect(mask.some((v) => v)).toBe(true);
    });

    it("returns empty array for empty line", () => {
        expect(buildWordDiffMask("", "anything")).toEqual([]);
    });
});

describe("bridgeChangedWordRuns", () => {
    /** Renders the mask as one glyph per character: `#` filled, `.` hole. */
    const glyphs = (tokens: string[], mask: boolean[]): string =>
        tokens.map((t, i) => (mask[i] ? "#" : ".").repeat(t.length)).join("");

    /** Whitespace tokens with a filled token on both sides -- the speckle gaps. */
    const interiorHoles = (tokens: string[], mask: boolean[]): number[] =>
        tokens.reduce<number[]>((acc, token, i) => {
            const flanked = mask[i - 1] === true && mask[i + 1] === true;
            if (!mask[i] && /^\s+$/.test(token) && flanked) acc.push(i);
            return acc;
        }, []);

    it("closes the gaps between adjacent changed words so a rewrite reads as one run", () => {
        // Both sides of a real two-sided hunk. Nearly every word differs, which is the
        // case that speckles: the LCS pairs each space with a space, so the fill lands
        // on the words and skips the gaps between them.
        const line = "        // The load-bearing assertion of this pair.";
        const compare = "        // Every wash reaches the block through a token.";
        const tokens = tokenizeWordDiff(line);
        const raw = buildWordDiffMask(line, compare);

        expect(
            interiorHoles(tokens, raw).length,
            "the fixture stopped reproducing the speckle -- pick a pair where the token " +
                "LCS still matches the spaces between changed words",
        ).toBeGreaterThan(0);

        const { changed } = bridgeChangedWordRuns(tokens, raw);
        expect(
            interiorHoles(tokens, changed),
            `a changed run is still broken by unfilled whitespace, so the block renders ` +
                `as speckle rather than one wash:\n  ${line}\n  ${glyphs(tokens, changed)}`,
        ).toEqual([]);
    });

    it("leaves whitespace alone unless changed text sits on both sides", () => {
        // A pure indentation change: the whitespace itself is what differs, and the code
        // after it is untouched. Bridging must not claim it -- a caller tints a genuine
        // whitespace change neutrally, and a bridged gap carries the block's own colour.
        const line = "        const total = 1;";
        const compare = "    const total = 1;";
        const tokens = tokenizeWordDiff(line);
        const { changed, bridged } = bridgeChangedWordRuns(
            tokens,
            buildWordDiffMask(line, compare),
        );

        expect(
            bridged.some(Boolean),
            "an indent-only change was reported as bridged, which drops the neutral " +
                "whitespace tint the merge editor gives it",
        ).toBe(false);
        expect(
            changed[changed.length - 1],
            "bridging spread past the changed region and marked trailing code",
        ).toBe(false);
    });

    it("marks exactly the whitespace it filled in", () => {
        const line = "alpha beta gamma";
        const compare = "alpha zzz gamma";
        const tokens = tokenizeWordDiff(line);
        const raw = buildWordDiffMask(line, compare);
        const { changed, bridged } = bridgeChangedWordRuns(tokens, raw);

        // `beta` alone differs, so both flanking spaces have unchanged text on one side
        // and nothing needs bridging.
        expect(bridged.some(Boolean), "bridged a gap that was not between two changes").toBe(false);
        expect(changed, "a single changed word was widened").toEqual(raw);
    });

    it("never bridges across text the author did not touch", () => {
        // `.` survives the rewrite, so it is real unchanged code sitting between two
        // changes. Painting it would report a change that is not there -- the gap is
        // only cosmetic when nothing but whitespace fills it.
        const line = "alpha.gamma";
        const compare = "delta.omega";
        const tokens = tokenizeWordDiff(line);
        const { changed, bridged } = bridgeChangedWordRuns(
            tokens,
            buildWordDiffMask(line, compare),
        );

        const dot = tokens.indexOf(".");
        expect(dot, "fixture no longer tokenizes a lone separator between two words").toBe(1);
        expect(
            changed[dot],
            "unchanged code between two changes was painted as changed, which reports " +
                "an edit the author never made",
        ).toBe(false);
        expect(bridged.some(Boolean), "a non-whitespace token was reported as bridged").toBe(false);
    });

    it("reports a bridged index for every hole it closes", () => {
        const line = "one two three";
        const compare = "AAA BBB CCC";
        const tokens = tokenizeWordDiff(line);
        const { changed, bridged } = bridgeChangedWordRuns(
            tokens,
            buildWordDiffMask(line, compare),
        );

        expect(changed.every(Boolean), "an all-changed line still has a hole").toBe(true);
        expect(
            tokens.filter((_, i) => bridged[i]),
            "bridged must name the whitespace tokens it filled, and only those",
        ).toEqual([" ", " "]);
    });
});
