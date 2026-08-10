import { describe, expect, it } from "vitest";

import {
    compositeOver,
    contrastRatio,
    findContrastViolations,
    flattenStack,
    relativeLuminance,
    type Rgba,
    type ContrastFailureKind,
} from "../../../visual/oracles/contrast";

const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };

describe("contrast colour math", () => {
    const belowFloorSample = {
        foreground: { r: 120, g: 120, b: 120, a: 1 } as const,
        backgroundLayers: [{ r: 120, g: 120, b: 120, a: 1 }] as const,
    } as const;
    const inactiveSample = { id: "inactive", inactive: true, ...belowFloorSample };
    const activeSample = { id: "active", inactive: false, ...belowFloorSample };

    it("composites source-over and flattens layers back-to-front", () => {
        const translucentRed: Rgba = { r: 255, g: 0, b: 0, a: 0.5 };
        const translucentBlue: Rgba = { r: 0, g: 0, b: 255, a: 0.5 };

        expect(compositeOver(translucentRed, translucentBlue)).toEqual({
            r: 170,
            g: 0,
            b: 85,
            a: 0.75,
        });
        expect(flattenStack([white, { r: 0, g: 0, b: 0, a: 0.5 }])).toEqual({
            r: 127.5,
            g: 127.5,
            b: 127.5,
            a: 1,
        });
    });

    it("uses the WCAG sRGB curve for mid-tone luminance", () => {
        expect(relativeLuminance({ r: 128, g: 128, b: 128, a: 0.25 })).toBeCloseTo(
            0.2158605001,
            10,
        );
    });

    it("has symmetric contrast ratios with the WCAG anchors", () => {
        expect(contrastRatio(black, white)).toBeCloseTo(21, 10);
        expect(contrastRatio(white, black)).toBeCloseTo(21, 10);
        expect(
            contrastRatio({ r: 83, g: 117, b: 201, a: 1 }, { r: 83, g: 117, b: 201, a: 0.2 }),
        ).toBe(1);
        expect(contrastRatio(black, white)).toBe(contrastRatio(white, black));
    });

    it("returns no violations for opaque backgrounds above the caller floor", () => {
        expect(
            findContrastViolations(
                [{ id: "body", inactive: false, foreground: black, backgroundLayers: [white] }],
                4.5,
            ),
        ).toEqual([]);
    });

    it("skips inactive samples", () => {
        expect(findContrastViolations([inactiveSample], 4.5)).toEqual([]);
    });

    it("still reports an identical active sample below the floor", () => {
        expect(findContrastViolations([activeSample], 4.5)).toEqual([
            { id: "active", kind: "below-floor", ratio: 1 },
        ]);
    });

    it("can fail: reports an opaque low-contrast foreground", () => {
        const grey: Rgba = { r: 120, g: 120, b: 120, a: 1 };
        const kind: ContrastFailureKind = "below-floor";

        expect(
            findContrastViolations(
                [{ id: "muted", inactive: false, foreground: grey, backgroundLayers: [grey] }],
                4.5,
            ),
        ).toEqual([{ id: "muted", kind, ratio: 1 }]);
    });

    // Scoring the declared foreground colour instead of its composite is a false green, and it is
    // the shape a real theme produces: 15%-alpha black on white renders as light grey (~1.4:1) but
    // measures as pure black on white (21:1) if the alpha is dropped. The oracle exists to catch
    // exactly this, so the case has to be pinned.
    it("can fail: reports a semi-transparent foreground that renders below the floor", () => {
        const violations = findContrastViolations(
            [
                {
                    id: "disabled-label",
                    inactive: false,
                    foreground: { r: 0, g: 0, b: 0, a: 0.15 },
                    backgroundLayers: [white],
                },
            ],
            4.5,
        );

        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ id: "disabled-label", kind: "below-floor" });
        expect(violations[0].ratio).toBeCloseTo(1.41, 2);
    });

    it("can fail: reports a background that never resolves to opaque", () => {
        expect(
            findContrastViolations(
                [
                    {
                        id: "transparent-card",
                        inactive: false,
                        foreground: black,
                        backgroundLayers: [{ r: 255, g: 255, b: 255, a: 0 }],
                    },
                ],
                4.5,
            ),
        ).toEqual([{ id: "transparent-card", kind: "unresolved-background" }]);
    });

    it("resolves a transparent layer when an opaque layer is underneath", () => {
        expect(
            findContrastViolations(
                [
                    {
                        id: "card",
                        inactive: false,
                        foreground: black,
                        backgroundLayers: [white, { r: 255, g: 0, b: 0, a: 0 }],
                    },
                ],
                4.5,
            ),
        ).toEqual([]);
    });

    it("honours the caller-supplied floor", () => {
        expect(
            findContrastViolations(
                [
                    {
                        id: "custom-floor",
                        inactive: false,
                        foreground: black,
                        backgroundLayers: [white],
                    },
                ],
                22,
            ),
        ).toEqual([{ id: "custom-floor", kind: "below-floor", ratio: 21 }]);
    });

    it("is deterministic and does not mutate its input", () => {
        const samples = [
            {
                id: "card",
                inactive: false,
                foreground: black,
                backgroundLayers: [white, { r: 255, g: 255, b: 255, a: 0.25 }],
            },
        ] as const;
        const before = structuredClone(samples);

        const first = findContrastViolations(samples, 4.5);
        const second = findContrastViolations(samples, 4.5);

        expect(first).toEqual(second);
        expect(samples).toEqual(before);
    });
});
