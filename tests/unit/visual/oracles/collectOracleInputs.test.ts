import { describe, expect, it } from "vitest";

import {
    assertNonEmptyCandidates,
    contentBoxFromClientRect,
    parseRgba,
} from "../../../visual/playwright/collectOracleInputs";

describe("parseRgba", () => {
    it.each([
        ["rgb(12, 34, 56)", { r: 12, g: 34, b: 56, a: 1 }],
        ["rgba(12, 34, 56, 0.25)", { r: 12, g: 34, b: 56, a: 0.25 }],
        ["rgba(0, 0, 0, 0)", { r: 0, g: 0, b: 0, a: 0 }],
        ["color(srgb 0.5 0.25 0 / 0.5)", { r: 127.5, g: 63.75, b: 0, a: 0.5 }],
    ] as const)("parses percentage-free integer channels in %s", (value, expected) => {
        expect(parseRgba(value)).toEqual(expected);
    });

    it("throws for an unparseable colour instead of silently fabricating black", () => {
        expect(() => parseRgba("not-a-css-colour")).toThrow(/Unable to parse CSS colour/);
    });
});

describe("contentBoxFromClientRect", () => {
    it("insets the client rect by each border width", () => {
        expect(
            contentBoxFromClientRect(
                { left: 10, top: 20, right: 110, bottom: 70 },
                { top: 1, right: 2, bottom: 3, left: 4 },
            ),
        ).toEqual({ left: 14, top: 21, right: 108, bottom: 67 });
    });
});

describe("collector candidate guard", () => {
    it("can fail: zero candidates trip the collection guard", () => {
        expect(() => assertNonEmptyCandidates(0)).toThrow(/zero visible text candidates/);
    });

    it("accepts a context with at least one candidate", () => {
        expect(() => assertNonEmptyCandidates(1)).not.toThrow();
    });
});
