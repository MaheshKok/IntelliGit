import { describe, expect, it } from "vitest";

import {
    contrastKey,
    describeDiff,
    diffFindings,
    isClean,
    normalizeFindingKeys,
} from "../../../visual/oracles/findingsBaseline";

describe("normalizeFindingKeys", () => {
    it("deduplicates and sorts so the baseline never churns on order or repeats", () => {
        expect(normalizeFindingKeys(["b", "a", "b"])).toEqual(["a", "b"]);
    });

    it("returns an empty list unchanged", () => {
        expect(normalizeFindingKeys([])).toEqual([]);
    });
});

describe("diffFindings", () => {
    it("reports nothing when observed and baseline agree", () => {
        const diff = diffFindings(["a", "b"], ["b", "a"]);
        expect(diff).toEqual({ regressions: [], resolved: [] });
        expect(isClean(diff)).toBe(true);
    });

    it("can fail: reports a finding that is observed but not baselined as a regression", () => {
        const diff = diffFindings(["a", "b"], ["a"]);
        expect(diff.regressions).toEqual(["b"]);
        expect(diff.resolved).toEqual([]);
        expect(isClean(diff)).toBe(false);
    });

    // The direction that a `observed ⊆ baseline` check would miss entirely. Without this,
    // a fixed defect stays in the file forever and the baseline silently re-accepts the bug
    // if it ever comes back.
    it("can fail: reports a baselined finding that no longer occurs as resolved", () => {
        const diff = diffFindings(["a"], ["a", "b"]);
        expect(diff.regressions).toEqual([]);
        expect(diff.resolved).toEqual(["b"]);
        expect(isClean(diff)).toBe(false);
    });

    it("can fail: reports both directions at once", () => {
        const diff = diffFindings(["a", "c"], ["a", "b"]);
        expect(diff.regressions).toEqual(["c"]);
        expect(diff.resolved).toEqual(["b"]);
        expect(isClean(diff)).toBe(false);
    });

    it("treats an empty baseline as every observed finding being new", () => {
        expect(diffFindings(["a", "b"], []).regressions).toEqual(["a", "b"]);
    });

    it("collapses duplicate observations rather than reporting one key twice", () => {
        expect(diffFindings(["a", "a"], []).regressions).toEqual(["a"]);
    });

    it("sorts both sides so failure messages are stable across runs", () => {
        const diff = diffFindings(["z", "y"], ["q", "p"]);
        expect(diff.regressions).toEqual(["y", "z"]);
        expect(diff.resolved).toEqual(["p", "q"]);
    });
});

describe("contrastKey", () => {
    // Storing the bare id would let a known-bad element degrade further without failing;
    // storing the raw float would churn the baseline on sub-pixel rendering noise.
    it("rounds the ratio to one decimal place", () => {
        expect(contrastKey("span.foo", 4.4712)).toBe("span.foo @4.5");
        expect(contrastKey("span.foo", 1.0622755735215792)).toBe("span.foo @1.1");
    });

    it("can fail: a meaningful degradation changes the key, so the diff catches it", () => {
        const before = contrastKey("span.foo", 4.4);
        const after = contrastKey("span.foo", 1.2);
        expect(before).not.toBe(after);
        expect(diffFindings([after], [before]).regressions).toEqual([after]);
    });

    it("does not change the key for sub-0.05 noise", () => {
        expect(contrastKey("span.foo", 3.201)).toBe(contrastKey("span.foo", 3.199));
    });
});

describe("describeDiff", () => {
    it("names both the regressions and the stale entries", () => {
        const message = describeDiff("ctx clipping", diffFindings(["new"], ["gone"]));
        expect(message).toContain("+ new");
        expect(message).toContain("- gone");
        expect(message).toContain("UPDATE_VISUAL_BASELINE=1");
    });

    it("is empty when there is nothing to report", () => {
        expect(describeDiff("ctx clipping", diffFindings([], []))).toBe("");
    });
});
