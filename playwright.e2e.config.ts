import { defineConfig } from "@playwright/test";
import { E2E_SUITE_GLOBAL_TIMEOUT_MS } from "./tests/e2e/hostFixtures/captureBudget";

/**
 * Layer 2 (real VS Code, driven through Playwright's `_electron`).
 *
 * Kept deliberately small while Phase 0 is still proving its assumption: this
 * config exists to run the spike at `tests/e2e/spike/`, not to be the finished
 * Layer-2 harness. Phase 4 (PLAN.md step 21) grows it once the spike's gate has
 * passed.
 */
export default defineConfig({
    testDir: "tests/e2e",

    // Downloads the pinned VS Code build once, outside any test's timeout —
    // otherwise a cold cache (every CI runner, every new checkout) fails the
    // first test with a timeout that is indistinguishable from a hung launch.
    globalSetup: "./tests/e2e/globalSetup.ts",

    // `globalTimeout` defaults to 0 -- no limit at all. That default turns the
    // download above into an unbounded stall: a wedged fetch blocks the E2E gate
    // until something outside Playwright kills the job, with no failure to read.
    // Derived, not hand-picked, so it stays above every budget it contains
    // (see captureBudget.ts).
    globalTimeout: E2E_SUITE_GLOBAL_TIMEOUT_MS,

    // Every test owns a disposable VS Code profile and launches a real Electron
    // app. Running those concurrently multiplies heavyweight instances without
    // shortening the critical path, and makes a failure far harder to read.
    workers: 1,
    fullyParallel: false,

    // A retry here would mask exactly the flake this suite is built to detect.
    retries: 0,
    forbidOnly: Boolean(process.env.CI),

    // Downloading and launching VS Code dominates; the assertions are fast.
    timeout: 180_000,

    reporter: [["list"]],
    use: {
        trace: "retain-on-failure",
        screenshot: "only-on-failure",

        // Playwright's default action timeout is 0 — wait forever. Against a
        // real Electron app that turns any lost CDP session into a test that
        // burns its entire budget and then reports only "timeout exceeded",
        // naming neither the action nor the element. Observed here: a
        // `.click()` on the IntelliGit activity-bar item hung for the full
        // ten minutes. A bounded action fails in seconds and says which
        // locator it was waiting for, which is the difference between a
        // diagnosable failure and a mystery.
        actionTimeout: 20_000,
    },
});
