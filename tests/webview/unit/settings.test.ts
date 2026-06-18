// Spec-derived tests for getSettings() in src/webviews/react/shared/settings.ts.
// Tests are written against the documented contract (defensive runtime checks
// with safe defaults), not by mirroring the implementation. The suite runs in
// the default node environment so the `typeof window === "undefined"` branch is
// exercised naturally, then stubs `window` to drive the populated branches.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "../../../src/webviews/react/shared/settings";

const DEFAULTS = {
    hoverDelay: 300,
    tooltipsEnabled: true,
    iconStyle: "standard",
    commitWindowPosition: "left",
} as const;

function stubWindowSettings(intelligitSettings: unknown): void {
    vi.stubGlobal("window", { intelligitSettings });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getSettings: environment and shape guards", () => {
    it("returns all defaults when window is undefined", () => {
        // No window stub: node environment leaves `window` undefined.
        expect(getSettings()).toEqual(DEFAULTS);
    });

    it("returns defaults when intelligitSettings is missing on window", () => {
        vi.stubGlobal("window", {});
        expect(getSettings()).toEqual(DEFAULTS);
    });

    it("returns defaults when intelligitSettings is null", () => {
        stubWindowSettings(null);
        expect(getSettings()).toEqual(DEFAULTS);
    });

    it("returns defaults when intelligitSettings is undefined", () => {
        stubWindowSettings(undefined);
        expect(getSettings()).toEqual(DEFAULTS);
    });

    it("returns defaults when intelligitSettings is a non-object primitive", () => {
        stubWindowSettings("not-an-object");
        expect(getSettings()).toEqual(DEFAULTS);
    });

    it("returns defaults when intelligitSettings is a number", () => {
        stubWindowSettings(42);
        expect(getSettings()).toEqual(DEFAULTS);
    });

    it("returns per-field defaults for an empty settings object", () => {
        stubWindowSettings({});
        expect(getSettings()).toEqual(DEFAULTS);
    });
});

describe("getSettings: hoverDelay coercion", () => {
    it("uses a provided numeric hoverDelay", () => {
        stubWindowSettings({ hoverDelay: 750 });
        expect(getSettings().hoverDelay).toBe(750);
    });

    it("preserves zero rather than falling back to the default", () => {
        // Boundary: 0 is a valid number; a truthiness-based fallback would
        // wrongly replace it with 300.
        stubWindowSettings({ hoverDelay: 0 });
        expect(getSettings().hoverDelay).toBe(0);
    });

    it("preserves a negative numeric hoverDelay", () => {
        stubWindowSettings({ hoverDelay: -5 });
        expect(getSettings().hoverDelay).toBe(-5);
    });

    it("falls back to 300 when hoverDelay is a numeric string", () => {
        stubWindowSettings({ hoverDelay: "750" });
        expect(getSettings().hoverDelay).toBe(300);
    });

    it("falls back to 300 when hoverDelay is a boolean", () => {
        stubWindowSettings({ hoverDelay: true });
        expect(getSettings().hoverDelay).toBe(300);
    });

    it("falls back to 300 when hoverDelay is null", () => {
        stubWindowSettings({ hoverDelay: null });
        expect(getSettings().hoverDelay).toBe(300);
    });

    it("falls back to 300 when hoverDelay is NaN", () => {
        // Boundary: typeof NaN === "number", so a typeof-only guard would leak
        // NaN into setTimeout/transition logic. A finite-number guard rejects it.
        stubWindowSettings({ hoverDelay: NaN });
        expect(getSettings().hoverDelay).toBe(300);
    });

    it("falls back to 300 when hoverDelay is Infinity", () => {
        stubWindowSettings({ hoverDelay: Infinity });
        expect(getSettings().hoverDelay).toBe(300);
    });

    it("falls back to 300 when hoverDelay is -Infinity", () => {
        stubWindowSettings({ hoverDelay: -Infinity });
        expect(getSettings().hoverDelay).toBe(300);
    });
});

describe("getSettings: tooltipsEnabled is disabled only by literal false", () => {
    it("is false only when explicitly set to false", () => {
        stubWindowSettings({ tooltipsEnabled: false });
        expect(getSettings().tooltipsEnabled).toBe(false);
    });

    it("is true when explicitly set to true", () => {
        stubWindowSettings({ tooltipsEnabled: true });
        expect(getSettings().tooltipsEnabled).toBe(true);
    });

    it("is true when the falsy value 0 is provided (not strictly false)", () => {
        // Guards against a Boolean()-style simplification that would coerce 0.
        stubWindowSettings({ tooltipsEnabled: 0 });
        expect(getSettings().tooltipsEnabled).toBe(true);
    });

    it('is true when the string "false" is provided (not the boolean false)', () => {
        stubWindowSettings({ tooltipsEnabled: "false" });
        expect(getSettings().tooltipsEnabled).toBe(true);
    });

    it("is true when tooltipsEnabled is null (only literal false disables)", () => {
        // Documents the deliberate asymmetry with hoverDelay: null disables
        // hoverDelay (-> default) but leaves tooltips enabled, because the guard
        // is `!== false`, and null is not false.
        stubWindowSettings({ tooltipsEnabled: null });
        expect(getSettings().tooltipsEnabled).toBe(true);
    });
});

describe("getSettings: iconStyle is color only on exact match", () => {
    it('returns "color" for exactly "color"', () => {
        stubWindowSettings({ iconStyle: "color" });
        expect(getSettings().iconStyle).toBe("color");
    });

    it('returns "standard" for exactly "standard"', () => {
        stubWindowSettings({ iconStyle: "standard" });
        expect(getSettings().iconStyle).toBe("standard");
    });

    it('returns "standard" for a case-mismatched "COLOR"', () => {
        stubWindowSettings({ iconStyle: "COLOR" });
        expect(getSettings().iconStyle).toBe("standard");
    });

    it('returns "standard" for an unknown icon style', () => {
        stubWindowSettings({ iconStyle: "rainbow" });
        expect(getSettings().iconStyle).toBe("standard");
    });
});

describe("getSettings: commitWindowPosition is right only on exact match", () => {
    it('returns "right" for exactly "right"', () => {
        stubWindowSettings({ commitWindowPosition: "right" });
        expect(getSettings().commitWindowPosition).toBe("right");
    });

    it('returns "left" for exactly "left"', () => {
        stubWindowSettings({ commitWindowPosition: "left" });
        expect(getSettings().commitWindowPosition).toBe("left");
    });

    it('returns "left" for a case-mismatched "RIGHT"', () => {
        stubWindowSettings({ commitWindowPosition: "RIGHT" });
        expect(getSettings().commitWindowPosition).toBe("left");
    });

    it('returns "left" for an unknown position', () => {
        stubWindowSettings({ commitWindowPosition: "center" });
        expect(getSettings().commitWindowPosition).toBe("left");
    });
});

describe("getSettings: full payload and stability", () => {
    it("maps a fully valid payload field-by-field", () => {
        stubWindowSettings({
            hoverDelay: 120,
            tooltipsEnabled: false,
            iconStyle: "color",
            commitWindowPosition: "right",
        });
        expect(getSettings()).toEqual({
            hoverDelay: 120,
            tooltipsEnabled: false,
            iconStyle: "color",
            commitWindowPosition: "right",
        });
    });

    it("ignores unrelated extra fields", () => {
        stubWindowSettings({ hoverDelay: 200, unrelated: "ignored" });
        expect(getSettings()).toEqual({ ...DEFAULTS, hoverDelay: 200 });
    });

    it("returns the same concrete values on repeated reads of unchanged state", () => {
        // Pins the value (not mere self-equality) so an implementation that
        // returned alternating/stateful results would fail.
        stubWindowSettings({ iconStyle: "color" });
        const expected = { ...DEFAULTS, iconStyle: "color" };
        expect(getSettings()).toEqual(expected);
        expect(getSettings()).toEqual(expected);
    });
});
