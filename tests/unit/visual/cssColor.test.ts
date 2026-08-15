/**
 * Locks the colour maths in cssColor.ts itself, which the two consumers below
 * exercise only incidentally and never enough to catch these two bugs:
 *
 *  - percentage r/g/b channels were divided by 100 like alpha is, landing on
 *    a 0-1 scale instead of CSS's 0-255 scale for those channels;
 *  - color-mix()'s second explicit weight was silently discarded whenever the
 *    first was also given, so `color-mix(in srgb, #f00 30%, #00f 30%)` mixed
 *    30%/70% instead of the correct normalized 50%/50%.
 *
 * Neither shows up in dangerButtonContrast.test.ts or diffStatusChroma.test.ts:
 * every fixture and token those two resolve is hex, a plain-number rgba(), or
 * a color-mix() with at most one explicit weight.
 */

import { describe, expect, it } from "vitest";

import { resolveRgba } from "../../helpers/cssColor";

const noVars = new Map<string, string>();

/** Resolves `expression` with no `var()` bindings available. */
function resolve(expression: string) {
    return resolveRgba(expression, noVars);
}

describe("percentage channels in rgb()/rgba() literals", () => {
    it("scales percentage r/g/b to 0-255 while keeping percentage alpha on 0-1", () => {
        const { rgb, alpha } = resolve("rgb(100% 0% 0% / 50%)");
        expect(rgb).toEqual([255, 0, 0]);
        expect(alpha).toBeCloseTo(0.5, 10);
    });

    it("scales a percentage channel sitting next to plain-number channels", () => {
        const { rgb, alpha } = resolve("rgb(100% 0 0)");
        expect(rgb).toEqual([255, 0, 0]);
        expect(alpha).toBeCloseTo(1, 10);
    });

    it("keeps a percentage alpha on 0-1 when r/g/b are plain numbers", () => {
        const { rgb, alpha } = resolve("rgba(0, 128, 255, 50%)");
        expect(rgb).toEqual([0, 128, 255]);
        expect(alpha).toBeCloseTo(0.5, 10);
    });

    it("still accepts the all-plain-number form", () => {
        const { rgb, alpha } = resolve("rgba(0, 128, 255, 0.5)");
        expect(rgb).toEqual([0, 128, 255]);
        expect(alpha).toBeCloseTo(0.5, 10);
    });

    it("still accepts transparent", () => {
        expect(resolve("transparent")).toEqual({ rgb: [0, 0, 0], alpha: 0 });
    });

    it("still accepts 3-, 6- and 8-digit hex", () => {
        expect(resolve("#f00").rgb).toEqual([255, 0, 0]);
        expect(resolve("#ff0000").rgb).toEqual([255, 0, 0]);
        const withAlpha = resolve("#ff000080");
        expect(withAlpha.rgb).toEqual([255, 0, 0]);
        expect(withAlpha.alpha).toBeCloseTo(128 / 255, 10);
    });
});

describe("color-mix() weight handling", () => {
    it("defaults to 50/50 when both weights are omitted", () => {
        const { rgb, alpha } = resolve("color-mix(in srgb, #f00, #00f)");
        expect(rgb).toEqual([128, 0, 128]);
        expect(alpha).toBeCloseTo(1, 10);
    });

    it("treats one given weight as the first colour's share (weight on the first arg)", () => {
        const { rgb, alpha } = resolve("color-mix(in srgb, #f00 20%, #00f)");
        expect(rgb).toEqual([51, 0, 204]);
        expect(alpha).toBeCloseTo(1, 10);
    });

    it("treats one given weight as 100% minus it (weight on the second arg)", () => {
        const { rgb, alpha } = resolve("color-mix(in srgb, #f00, #00f 20%)");
        expect(rgb).toEqual([204, 0, 51]);
        expect(alpha).toBeCloseTo(1, 10);
    });

    it("normalizes both explicit weights and scales alpha down when they undersubscribe", () => {
        // The worked example from CSS Color 5: 30%/30% normalizes to a 50/50 mix,
        // and because the two weights only account for 60% of the recipe, the
        // result's alpha is scaled by that 60% too.
        const { rgb, alpha } = resolve("color-mix(in srgb, #f00 30%, #00f 30%)");
        expect(rgb).toEqual([128, 0, 128]);
        expect(alpha).toBeCloseTo(0.6, 10);
    });

    it("normalizes both explicit weights with no alpha scaling when they oversubscribe", () => {
        const { rgb, alpha } = resolve("color-mix(in srgb, #f00 80%, #00f 40%)");
        expect(rgb).toEqual([170, 0, 85]);
        expect(alpha).toBeCloseTo(1, 10);
    });

    it("normalizes both explicit weights with no alpha scaling when they sum to exactly 100%", () => {
        const { rgb, alpha } = resolve("color-mix(in srgb, #f00 60%, #00f 40%)");
        expect(rgb).toEqual([153, 0, 102]);
        expect(alpha).toBeCloseTo(1, 10);
    });

    it("rejects two weights that sum to 0%, which CSS does not define", () => {
        // Pinned to the message: without the guard the weights divide 0 by 0 and every
        // channel resolves to NaN, and a bare `toThrow()` would be satisfied by any
        // downstream failure that NaN happens to cause rather than by this guard.
        expect(() => resolve("color-mix(in srgb, #f00 0%, #00f 0%)")).toThrow(/weights sum to 0%/);
    });
});
