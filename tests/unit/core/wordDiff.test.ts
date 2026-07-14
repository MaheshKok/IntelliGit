// Tests for pure word-diff algorithms in merge-editor/wordDiff.ts.

import { describe, it, expect } from "vitest";
import {
    tokenizeWordDiff,
    normalizeLineForWordDiff,
    computeTokenLcsPairs,
    tokenSimilarityRatio,
    alignCompareLinesForWordDiff,
    buildWordDiffMask,
} from "../../../src/mergeEditor/wordDiff";

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
