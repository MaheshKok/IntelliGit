import { describe, expect, it } from "vitest";

import {
    collectSourceStrings,
    matchTruncatedRendering,
} from "../../../visual/oracles/truncationSources";

describe("collectSourceStrings", () => {
    it("walks nested arrays and objects, deduplicates, and sorts string leaves", () => {
        expect(
            collectSourceStrings([
                "bravo",
                { nested: ["alpha", { value: "charlie" }, 42] },
                { duplicate: "bravo", ignored: false },
                null,
            ]),
        ).toEqual(["alpha", "bravo", "charlie"]);
    });
});

describe("matchTruncatedRendering", () => {
    it.each(["…", "..."])("matches a tail ellipsis written as %s", (ellipsis) => {
        expect(matchTruncatedRendering(`Fix parser${ellipsis}`, ["Fix parser regression"])).toEqual({
            rendered: `Fix parser${ellipsis}`,
            sources: ["Fix parser regression"],
        });
    });

    it("matches a middle ellipsis", () => {
        expect(
            matchTruncatedRendering("feature/.../main", ["feature/long-lived-topic/main"]),
        ).toEqual({
            rendered: "feature/.../main",
            sources: ["feature/long-lived-topic/main"],
        });
    });

    it("matches the measured merge label when its fixture source extends it", () => {
        expect(
            matchTruncatedRendering("Merge...", ["Merge branch 'feature'"]),
        ).toEqual({
            rendered: "Merge...",
            sources: ["Merge branch 'feature'"],
        });
    });

    it("does not match the measured merge label when no source extends it", () => {
        expect(matchTruncatedRendering("Merge...", ["Merge", "Resolve conflict"])).toBeUndefined();
    });

    it("normalizes NFC and collapsed whitespace before matching", () => {
        expect(
            matchTruncatedRendering("Cafe\u0301\tparser…", ["Café parser regression"]),
        ).toEqual({
            rendered: "Cafe\u0301\tparser…",
            sources: ["Café parser regression"],
        });
    });

    it("can fail: a rendered string equal to its source is not a match", () => {
        expect(matchTruncatedRendering("Full visible text", ["Full visible text"])).toBeUndefined();
    });

    it("can fail: a bare prefix with no ellipsis is not a match", () => {
        expect(matchTruncatedRendering("feature/login", ["feature/login (remote)"])).toBeUndefined();
    });

    it("reports every ambiguous source in sorted order", () => {
        expect(
            matchTruncatedRendering("feature/.../main", [
                "feature/very-long-topic/main",
                "feature/long-lived-topic/main",
            ]),
        ).toEqual({
            rendered: "feature/.../main",
            sources: [
                "feature/long-lived-topic/main",
                "feature/very-long-topic/main",
            ],
        });
    });
});
