import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { KNOWN_BAD_LEG_IDS } from "./flowLegKnownBadHarness";

/**
 * The four known-bad legs used to be one loop in one file, which made silently losing a leg
 * structurally impossible. As four separate `flowLegKnownBad.<leg>.test.ts` files (split so the
 * Windows CI shards can spread them), deleting one would shrink the suite without turning anything
 * red -- this restores the enumeration guarantee: exactly one leg file per id, no extras.
 */
describe("flowLegKnownBad leg files", () => {
    it("has exactly one flowLegKnownBad.<leg>.test.ts file per known-bad leg id", () => {
        const present = readdirSync(__dirname)
            .map((name) => /^flowLegKnownBad\.(.+)\.test\.ts$/.exec(name)?.[1])
            .filter((leg): leg is string => leg !== undefined && leg !== "coverage");
        expect([...present].sort()).toEqual([...KNOWN_BAD_LEG_IDS].sort());
    });
});
