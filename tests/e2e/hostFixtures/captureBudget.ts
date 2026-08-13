// The one place the Layer-2 time budget is written down, because it is a sum
// and every consumer of it was previously a hand-picked round number.
//
// The failure this module exists to prevent is not "a timeout was too short".
// It is a timeout that fires BEFORE the more specific one underneath it: the
// capture test used to allow ten minutes for four sequential launches whose own
// per-launch ceiling is five minutes each. Launches two, three and four could
// therefore never reach `ELECTRON_LAUNCH_TIMEOUT_MS`, so a genuinely stuck
// launch reported "Test timeout of 600000ms exceeded" -- a message that names
// neither the fixture nor the launch -- instead of the explicit launch-timeout
// error the 300s value was chosen to produce. An outer bound that pre-empts an
// inner one silently deletes the inner one's diagnostic.
//
// So the outer bounds are DERIVED from the inner ones here rather than restated
// as literals elsewhere. Raising a per-launch ceiling now widens the test
// timeout and the suite timeout with it, and no separate test is needed to keep
// them in agreement -- they cannot disagree.

import { HOST_FIXTURE_THEMES } from "./hostFixtureThemes";

/**
 * Ceiling for `electron.launch()` itself, distinct from
 * {@link FRAME_RESOLUTION_TIMEOUT_MS} (which only bounds frame-chain resolution
 * *after* the app is up). Playwright's Electron default is 180s, comfortable on
 * an idle machine but observed empirically to be too tight under real
 * contention -- a dev machine under load, or a busy CI runner -- where a cold VS
 * Code start plus the CDP handshake takes longer. A generous explicit value is
 * cheap: it extends only the ceiling, never the typical run, and turns "launch
 * was merely slow" into a pass rather than a flake indistinguishable from a
 * genuinely broken launch.
 */
export const ELECTRON_LAUNCH_TIMEOUT_MS = 300_000;

/** How long one capture keeps retrying webview frame-chain resolution before giving up. */
export const FRAME_RESOLUTION_TIMEOUT_MS = 45_000;

/**
 * Slack for resolving the VS Code build. `globalSetup` normally pays this once
 * before any test runs, but the capture also calls `resolveVSCodeExecutable`
 * itself, so on a cold cache it can land inside the test's own budget.
 */
const VSCODE_DOWNLOAD_BUDGET_MS = 600_000;

/**
 * Worst case for the whole four-fixture capture: every launch and every frame
 * resolution burning its full ceiling, plus one cold download.
 */
export const HOST_FIXTURE_CAPTURE_TIMEOUT_MS =
    HOST_FIXTURE_THEMES.length * (ELECTRON_LAUNCH_TIMEOUT_MS + FRAME_RESOLUTION_TIMEOUT_MS) +
    VSCODE_DOWNLOAD_BUDGET_MS;

/** Room above the capture for the rest of the suite -- the spike spec and `globalSetup`'s own download. */
const OTHER_SPECS_BUDGET_MS = 900_000;

/**
 * Suite-level ceiling for `playwright.e2e.config.ts`. Playwright's
 * `globalTimeout` defaults to `0`, meaning no limit at all, so a wedged
 * `globalSetup` download blocks the E2E gate until something outside Playwright
 * kills it. Finite and above every budget it contains.
 */
export const E2E_SUITE_GLOBAL_TIMEOUT_MS = HOST_FIXTURE_CAPTURE_TIMEOUT_MS + OTHER_SPECS_BUDGET_MS;
