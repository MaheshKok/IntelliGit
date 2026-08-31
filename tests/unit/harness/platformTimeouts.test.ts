import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    WINDOWS_BUDGET_MS,
    harnessTimeouts,
    withWindowsHeadroom,
} from "../../setup/platformTimeouts";

/**
 * Guards the one number that decides whether a slow Windows runner reports a bug or invents one.
 *
 * Three runs of `Installed-package portability` died on `Error: Test timed out in 30000ms` inside
 * five days, naming a DIFFERENT test every time: `snapshotNormalize` (run 33098964139),
 * `scenarios.independence` (33102425937), then five tests across four files (33390002981). Three
 * disjoint sets of tests failing with one identical error is not three bugs in those tests. Run
 * 33390002981 re-ran green with no code change at all, and the same shard's own numbers say why:
 * against its green sibling on 62f2ed90 the whole shard ran 2x slower, filesystem-heavy files
 * 2-6x, and the one in-memory file (`view-providers.integration`) 1.0x. Tests needing 1.1s, 2.6s,
 * 3.6s, 4.8s and 6.7s on the good runner all hit the 30s wall on the slow one.
 *
 * The repository had already reached this conclusion once and applied it too narrowly.
 * `REAL_SCENARIO_TIMEOUT_MS` (#223) carries the finding -- "Windows runs this work 2-5x slower",
 * "a 10% margin on the slowest leg is a red waiting for an ordinary bad minute" -- but only the
 * `webviewFixtureGate` files ever opted in, so every other filesystem-heavy suite kept the flat
 * 30s and kept dying on it. A guard protects only its call sites.
 */
describe("withWindowsHeadroom", () => {
    it("raises a budget to the Windows floor without lowering a larger one", () => {
        // The seven recorder `beforeAll` hooks seed two independent git workspaces each and
        // already ask for 60s. Scaling by a factor would take them to 360s, past the point where
        // the timeout still catches a hang; a floor leaves every base at or above it untouched.
        expect(withWindowsHeadroom(30_000, "win32")).toBe(WINDOWS_BUDGET_MS);
        expect(withWindowsHeadroom(60_000, "win32")).toBe(WINDOWS_BUDGET_MS);
        expect(withWindowsHeadroom(240_000, "win32")).toBe(240_000);
    });

    it("changes nothing where no CI leg has asked for it yet", () => {
        // Not "where it never happens": contention is the mechanism, and Windows only has the most
        // of it. On a mac, `screenshotComparatorMeta` runs in 3,701ms alone and blew its own
        // 60,000ms wall inside the full 347-file suite. No CI Linux or macOS leg has produced one,
        // so widening a wall that is holding would blunt it for no gain -- but the day one does,
        // this assertion is what should change, not the failing test.
        expect(withWindowsHeadroom(30_000, "linux")).toBe(30_000);
        expect(withWindowsHeadroom(30_000, "darwin")).toBe(30_000);
        expect(withWindowsHeadroom(60_000, "linux")).toBe(60_000);
    });

    it("still catches a hang rather than waiting out the job", () => {
        // A timeout that outlives its job reports nothing: the runner kills the job first and the
        // failure arrives as a cancelled leg with no test named. `compatibility.yml` caps the
        // Windows shards at 90 minutes, and the red shard used ~14 of them.
        expect(WINDOWS_BUDGET_MS).toBeLessThan(90 * 60_000);
    });
});

describe("harnessTimeouts", () => {
    it("moves both clocks together, because a hook seeds what a test then measures", () => {
        expect(harnessTimeouts("win32")).toEqual({
            testTimeout: WINDOWS_BUDGET_MS,
            hookTimeout: WINDOWS_BUDGET_MS,
        });
        expect(harnessTimeouts("linux")).toEqual({
            testTimeout: 30_000,
            hookTimeout: 30_000,
        });
    });
});

/**
 * The helper is worth nothing unless the config actually reads it.
 *
 * A platform-aware constant that no consumer imports typechecks, tests green, and leaves Windows
 * on the same 30s wall -- the setting is right and the artifact never changed. Two checks, because
 * neither alone is enough here. The resolved config catches a base that drifted away from the
 * helper, but on a non-Windows box it reads 30,000 either way and so cannot see the platform
 * branch being deleted; the source check can see exactly that, and nothing else.
 *
 * The config cannot simply be imported under a stubbed `win32` -- see `harnessTimeouts`.
 */
describe("vitest.config.ts", () => {
    it("takes its timeouts from the helper rather than restating them", async () => {
        const loaded = (await import("../../../vitest.config")) as {
            default: { test?: { testTimeout?: number; hookTimeout?: number } };
        };
        const resolved = loaded.default.test ?? {};

        expect({
            testTimeout: resolved.testTimeout,
            hookTimeout: resolved.hookTimeout,
        }).toEqual(harnessTimeouts());
    });

    it("still spreads the helper, so the Windows branch has a reader", async () => {
        const source = await readFile(
            fileURLToPath(new URL("../../../vitest.config.ts", import.meta.url)),
            "utf8",
        );

        expect(
            /\.\.\.harnessTimeouts\(\)/.test(source),
            "vitest.config.ts no longer spreads harnessTimeouts(), so every Windows shard is back " +
                "on the flat 30s wall that failed three runs in five days. The assertion above " +
                "cannot see this: off Windows the helper and a hardcoded 30_000 agree exactly.",
        ).toBe(true);
    });
});
