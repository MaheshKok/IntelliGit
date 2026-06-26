// Spec-derived tests for normalizeCommitChecksSettings. Cases are written from the
// documented contract — validate the `intelligit.commitChecks` config object at the
// trust boundary, coerce non-booleans to defaults, ignore unknown provider keys, and
// safely compile a user CI/CD filter regex without ever throwing — not by mirroring the
// implementation. The normalizer is pure: no VS Code, no I/O.

import { describe, expect, it } from "vitest";
import { normalizeCommitChecksSettings } from "../../../../src/services/commitChecks/settingsConfig";

const ALL_PROVIDERS = ["github", "gitlab", "bitbucket-cloud", "bitbucket-server"] as const;

describe("normalizeCommitChecksSettings — defaults", () => {
    it("enables the feature and every provider when raw is undefined", () => {
        const settings = normalizeCommitChecksSettings(undefined);
        expect(settings.enabled).toBe(true);
        for (const id of ALL_PROVIDERS) {
            expect(settings.providers[id]).toBe(true);
        }
        expect(settings.ciCdPattern).toBeUndefined();
        expect(settings.ciCdFilterInvalid).toBeFalsy();
    });

    it("returns defaults for null", () => {
        expect(normalizeCommitChecksSettings(null).enabled).toBe(true);
    });

    it("returns defaults for a non-object scalar", () => {
        expect(normalizeCommitChecksSettings("garbage").enabled).toBe(true);
        expect(normalizeCommitChecksSettings(42).providers.gitlab).toBe(true);
    });

    it("returns defaults for an array (objects, but not a config map)", () => {
        const settings = normalizeCommitChecksSettings(["enabled"]);
        expect(settings.enabled).toBe(true);
        expect(settings.providers.github).toBe(true);
    });
});

describe("normalizeCommitChecksSettings — enabled flag", () => {
    it("honors an explicit false", () => {
        expect(normalizeCommitChecksSettings({ enabled: false }).enabled).toBe(false);
    });

    it("honors an explicit true", () => {
        expect(normalizeCommitChecksSettings({ enabled: true }).enabled).toBe(true);
    });

    it("coerces a non-boolean enabled to the default (true), not to its truthiness", () => {
        // A string "false" is truthy in JS; the boundary must not treat it as a boolean.
        expect(normalizeCommitChecksSettings({ enabled: "false" }).enabled).toBe(true);
        expect(normalizeCommitChecksSettings({ enabled: 0 }).enabled).toBe(true);
        expect(normalizeCommitChecksSettings({ enabled: null }).enabled).toBe(true);
    });
});

describe("normalizeCommitChecksSettings — provider toggles", () => {
    it("honors an explicit per-provider false and leaves the rest enabled", () => {
        const settings = normalizeCommitChecksSettings({ providers: { gitlab: false } });
        expect(settings.providers.gitlab).toBe(false);
        expect(settings.providers.github).toBe(true);
        expect(settings.providers["bitbucket-cloud"]).toBe(true);
        expect(settings.providers["bitbucket-server"]).toBe(true);
    });

    it("ignores unknown provider keys", () => {
        const settings = normalizeCommitChecksSettings({
            providers: { gitbucket: false, "": false, gitlab: false },
        });
        expect(settings.providers.gitlab).toBe(false);
        expect((settings.providers as Record<string, boolean>).gitbucket).toBeUndefined();
        expect(Object.keys(settings.providers).sort()).toEqual([...ALL_PROVIDERS].sort());
    });

    it("coerces a non-boolean provider value to the default (true)", () => {
        const settings = normalizeCommitChecksSettings({
            providers: { gitlab: "no", github: 0, "bitbucket-cloud": null },
        });
        expect(settings.providers.gitlab).toBe(true);
        expect(settings.providers.github).toBe(true);
        expect(settings.providers["bitbucket-cloud"]).toBe(true);
    });

    it("returns all-enabled when providers is not an object", () => {
        const settings = normalizeCommitChecksSettings({ providers: "all" });
        for (const id of ALL_PROVIDERS) {
            expect(settings.providers[id]).toBe(true);
        }
    });

    it("returns all-enabled when providers is an array", () => {
        const settings = normalizeCommitChecksSettings({ providers: ["gitlab"] });
        expect(settings.providers.gitlab).toBe(true);
    });
});

describe("normalizeCommitChecksSettings — ciCdFilter compilation", () => {
    it("keeps the built-in pattern for an empty string (no override, no invalid flag)", () => {
        const settings = normalizeCommitChecksSettings({ ciCdFilter: "" });
        expect(settings.ciCdPattern).toBeUndefined();
        expect(settings.ciCdFilterInvalid).toBeFalsy();
    });

    it("keeps the built-in pattern when ciCdFilter is not a string", () => {
        // A non-string is absent/wrong-type, not a bad user regex — no invalid warning.
        const settings = normalizeCommitChecksSettings({ ciCdFilter: 123 });
        expect(settings.ciCdPattern).toBeUndefined();
        expect(settings.ciCdFilterInvalid).toBeFalsy();
    });

    it("compiles a valid regex and applies it case-insensitively", () => {
        const settings = normalizeCommitChecksSettings({ ciCdFilter: "deploy|smoke" });
        expect(settings.ciCdPattern).toBeInstanceOf(RegExp);
        expect(settings.ciCdPattern?.test("Deploy to prod")).toBe(true);
        expect(settings.ciCdPattern?.test("smoke test")).toBe(true);
        expect(settings.ciCdPattern?.test("unrelated")).toBe(false);
        expect(settings.ciCdFilterInvalid).toBeFalsy();
    });

    it("flags an invalid regex without throwing and leaves the pattern undefined", () => {
        const settings = normalizeCommitChecksSettings({ ciCdFilter: "(" });
        expect(settings.ciCdPattern).toBeUndefined();
        expect(settings.ciCdFilterInvalid).toBe(true);
    });
});

describe("normalizeCommitChecksSettings — immutability", () => {
    it("returns a frozen settings object and frozen providers map", () => {
        const settings = normalizeCommitChecksSettings({ enabled: true });
        expect(Object.isFrozen(settings)).toBe(true);
        expect(Object.isFrozen(settings.providers)).toBe(true);
    });

    it("produces independent objects across calls (no shared mutable state)", () => {
        const a = normalizeCommitChecksSettings({ providers: { gitlab: false } });
        const b = normalizeCommitChecksSettings(undefined);
        expect(a.providers).not.toBe(b.providers);
        expect(b.providers.gitlab).toBe(true);
    });
});
