/**
 * The per-test clock the Windows legs are allowed to run against.
 *
 * 180s is not a guess and not a round number picked for comfort: it is the figure
 * `REAL_SCENARIO_TIMEOUT_MS` already settled on for this repository's slowest Windows work
 * (#223), reached after `rewrites a drifted fixture` spent 53,835ms of a 60,000ms budget on run
 * 32654169455 and then 60,012ms on the next one. The reasoning there applies unchanged to every
 * other suite that seeds real repositories: what a timeout is for is catching a HANG, and 180s
 * still does that against Windows shards whose whole leg totals ~470s at their worst observed.
 *
 * Measured, on two runs of the SAME shard four hours apart (62f2ed90 green, 75e091f3 red, both
 * 86 files / 1457 tests): the shard as a whole ran 2x slower, filesystem-heavy files 2-6x, and
 * `view-providers.integration` -- the one that stays in memory -- 1.0x. Per test the tail is far
 * worse than the average: `excludes a previously staged but unchecked file` went from 1,118ms to
 * a 30,000ms timeout, at least 27x. Those red durations are censored, reporting when vitest gave
 * up rather than what the work needed, so the true tail is longer than any number here.
 */
export const WINDOWS_BUDGET_MS = 180_000;

/**
 * Raises a timeout to the Windows floor, and leaves every other platform alone.
 *
 * A FLOOR rather than a multiplier. The webview-recorder `beforeAll` hooks seed two independent
 * git workspaces and already ask for 60s; a 6x scale would put them at 360s, which outlives the
 * useful definition of a hang, while a floor leaves any base already above it exactly as its
 * author set it.
 *
 * Windows-only because that is where the EVIDENCE is, not because the mechanism is. Contention,
 * not the operating system, is what eats these budgets, and the same shape reproduces elsewhere:
 * `screenshotComparatorMeta` runs in 3,701ms alone on a mac and blew its own 60,000ms wall inside
 * a full 347-file suite on the same machine, at least 16x. No CI Linux or macOS leg has yet
 * produced one, so their numbers stay as they are -- widening a wall that is holding blunts it for
 * no gain -- but "has not yet" is the whole of the argument, and a first red on either platform is
 * a reason to widen the floor rather than to retry the job.
 *
 * `platform` is a parameter rather than a read of `process.platform` so the branch is testable as
 * a pure function. An invariant that can only be observed by running CI on another operating
 * system is one nothing can assert.
 */
export function withWindowsHeadroom(
    baseMs: number,
    platform: NodeJS.Platform = process.platform,
): number {
    return platform === "win32" ? Math.max(baseMs, WINDOWS_BUDGET_MS) : baseMs;
}

/** vitest's default per-test and per-hook clocks, before any test asks for its own. */
const BASE_TIMEOUT_MS = 30_000;

/**
 * The timeout pair `vitest.config.ts` spreads, as one value so the wiring can be asserted.
 *
 * Returned as an object rather than read out of the config by a test because the config cannot be
 * imported under a stubbed platform at all: rolldown reads `process.platform` when it transforms
 * the file, so setting it to `win32` on a mac makes the import die reaching for
 * `@rolldown/binding-win32-arm64-msvc` long before any timeout is resolved. The Windows branch is
 * therefore only ever observable here, as a pure function.
 */
export function harnessTimeouts(platform: NodeJS.Platform = process.platform): {
    testTimeout: number;
    hookTimeout: number;
} {
    return {
        testTimeout: withWindowsHeadroom(BASE_TIMEOUT_MS, platform),
        hookTimeout: withWindowsHeadroom(BASE_TIMEOUT_MS, platform),
    };
}
