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
        expect(matchTruncatedRendering(`Fix parser${ellipsis}`, ["Fix parser regression"])).toEqual(
            {
                rendered: `Fix parser${ellipsis}`,
                sources: ["Fix parser regression"],
                completeSourceExists: false,
            },
        );
    });

    it("matches a middle ellipsis", () => {
        expect(
            matchTruncatedRendering("feature/.../main", ["feature/long-lived-topic/main"]),
        ).toEqual({
            rendered: "feature/.../main",
            sources: ["feature/long-lived-topic/main"],
            completeSourceExists: false,
        });
    });

    it("matches the measured merge label when its fixture source extends it", () => {
        expect(matchTruncatedRendering("Merge...", ["Merge branch 'feature'"])).toEqual({
            rendered: "Merge...",
            sources: ["Merge branch 'feature'"],
            completeSourceExists: false,
        });
    });

    it("does not match the measured merge label when no source extends it", () => {
        expect(matchTruncatedRendering("Merge...", ["Merge", "Resolve conflict"])).toBeUndefined();
    });

    it("can fail: a complete label ending in a convention ellipsis is exonerated by a DIFFERENT source", () => {
        // The catalog spells this convention both ways, so before the whole-vocabulary membership
        // check each entry accused the other and every locale reported a truncation that was not
        // one. The accusing source is never the source being compared, so a per-source equality
        // check cannot catch this.
        expect(
            matchTruncatedRendering("Merge...", ["Merge…", "Merge...", "Resolve conflict"]),
        ).toBeUndefined();
        expect(
            matchTruncatedRendering("Merge…", ["Merge…", "Merge...", "Resolve conflict"]),
        ).toBeUndefined();
    });

    it("still reports a real truncation whose rendering is absent from the vocabulary", () => {
        expect(
            matchTruncatedRendering("Änderungen fes…", ["Änderungen festschreiben", "Merge..."]),
        ).toEqual({
            rendered: "Änderungen fes…",
            sources: ["Änderungen festschreiben"],
            completeSourceExists: false,
        });
    });

    it("normalizes NFC and collapsed whitespace before matching", () => {
        expect(matchTruncatedRendering("Cafe\u0301\tparser…", ["Café parser regression"])).toEqual({
            rendered: "Cafe\u0301\tparser…",
            sources: ["Café parser regression"],
            completeSourceExists: false,
        });
    });

    it("can fail: a rendered string equal to its source is not a match", () => {
        expect(matchTruncatedRendering("Full visible text", ["Full visible text"])).toBeUndefined();
    });

    it("can fail: a bare prefix with no ellipsis is not a match", () => {
        expect(
            matchTruncatedRendering("feature/login", ["feature/login (remote)"]),
        ).toBeUndefined();
    });

    it("reports every ambiguous source in sorted order", () => {
        expect(
            matchTruncatedRendering("feature/.../main", [
                "feature/very-long-topic/main",
                "feature/long-lived-topic/main",
            ]),
        ).toEqual({
            rendered: "feature/.../main",
            sources: ["feature/long-lived-topic/main", "feature/very-long-topic/main"],
            completeSourceExists: false,
        });
    });

    it("can fail: a verbatim source does not exonerate an element another source could have cut", () => {
        // The case a vocabulary-wide membership test threw away. A fixture holding BOTH a real
        // `Merge...` command label and a `Merge branch 'feature'` commit subject renders an element
        // that could be either, so answering "complete" skips the accessible-name check for a name
        // that may genuinely be lost. The verbatim source is reported, not obeyed.
        expect(matchTruncatedRendering("Merge...", ["Merge...", "Merge branch 'feature'"])).toEqual(
            {
                rendered: "Merge...",
                sources: ["Merge branch 'feature'"],
                completeSourceExists: true,
            },
        );
    });

    it("can fail: the verbatim source counts even when spelled with the other ellipsis", () => {
        // `Merge…` and `Merge...` are one label spelled two ways. If canonicalization were dropped
        // the vocabulary entry would stop being recognised as verbatim, and this element would be
        // reported as an unambiguous truncation of the commit subject -- a false positive with a
        // confident label on it.
        expect(matchTruncatedRendering("Merge...", ["Merge…", "Merge branch 'feature'"])).toEqual({
            rendered: "Merge...",
            sources: ["Merge branch 'feature'"],
            completeSourceExists: true,
        });
    });

    it("can fail: a verbatim source alone still yields no match at all", () => {
        // The exoneration itself must survive: with nothing else that could have produced the
        // rendering, a label ending in the convention ellipsis is complete and is not a finding.
        expect(matchTruncatedRendering("Merge...", ["Merge…", "Merge..."])).toBeUndefined();
    });
});
