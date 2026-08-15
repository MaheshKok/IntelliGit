import { describe, expect, it } from "vitest";

import {
    classifyAccessibleName,
    type AccessibleNameEvidence,
} from "../../../visual/oracles/accessibleNameVerdict";

/** A single unambiguous candidate that the element announces correctly -- the cleared baseline. */
const CLEARED: AccessibleNameEvidence = {
    sourceCount: 1,
    completeSourceExists: false,
    announcesRenderedText: false,
    announcesSomeSource: true,
};

const evidence = (overrides: Partial<AccessibleNameEvidence>): AccessibleNameEvidence => ({
    ...CLEARED,
    ...overrides,
});

describe("classifyAccessibleName", () => {
    it("clears an element that announces the whole source it abbreviates", () => {
        expect(classifyAccessibleName(CLEARED)).toBeUndefined();
    });

    it("can fail: a single candidate the element never announces is a lost name", () => {
        expect(classifyAccessibleName(evidence({ announcesSomeSource: false }))).toBe(
            "truncated-name",
        );
    });

    it("can fail: several candidates stay ambiguous even when one of them is announced", () => {
        // A passing name check proves only that ONE candidate matched, so it settles nothing about
        // which string the element was actually cut from.
        expect(classifyAccessibleName(evidence({ sourceCount: 3 }))).toBe("ambiguous-source");
    });

    it("clears a complete label that announces its own text verbatim", () => {
        // `Push...` is a whole catalog entry, and the element announces `Push...`. The measured
        // rendering is `textContent`, so every character it holds is exposed -- nothing is lost,
        // whatever else in the vocabulary happens to start with `Push`.
        expect(
            classifyAccessibleName(
                evidence({
                    sourceCount: 2,
                    completeSourceExists: true,
                    announcesRenderedText: true,
                    announcesSomeSource: false,
                }),
            ),
        ).toBeUndefined();
    });

    it("can fail: a complete source does NOT clear an element that announces something else", () => {
        // The blanket "this rendering exists in the vocabulary" rule this replaced cleared such an
        // element without ever asking it, which is how a genuine truncation used to escape. The
        // element's own announcement is what earns the exoneration.
        expect(
            classifyAccessibleName(
                evidence({
                    completeSourceExists: true,
                    announcesRenderedText: false,
                    announcesSomeSource: false,
                }),
            ),
        ).toBe("ambiguous-source");
    });

    it("can fail: announcing its own text does not clear a JavaScript-side cut", () => {
        // `Rename Loc…` equals no vocabulary entry, so it announcing itself is not evidence of
        // completeness -- it is precisely the defect: the cut string is all assistive technology
        // ever hears. Clearing on the announcement alone would blind the oracle to every
        // `slice() + "…"` in the product.
        expect(
            classifyAccessibleName(
                evidence({
                    completeSourceExists: false,
                    announcesRenderedText: true,
                    announcesSomeSource: false,
                }),
            ),
        ).toBe("truncated-name");
    });
});
