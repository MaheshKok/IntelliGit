/**
 * `captureBudget.ts` exists to stop an outer timeout from firing before the more
 * specific one underneath it, because an outer bound that pre-empts an inner one
 * silently deletes the inner one's diagnostic: the reader gets "Test timeout of
 * Nms exceeded", which names neither the fixture nor the launch, instead of the
 * explicit launch-timeout error the inner ceiling was chosen to produce.
 *
 * That property is invisible at runtime. Reproducing it for real needs four
 * sequential VS Code launches each stalling for five minutes, so nothing in the
 * E2E suite will ever execute the case -- and deriving the outer bound from the
 * inner ones, which is what the module does, is not by itself sufficient: a
 * derivation that sums the inner ceilings EXACTLY still pre-empts them, since
 * the capture also spends time outside those ceilings.
 *
 * So the invariant is asserted here as a time rather than as a sum. For each
 * capture the suite will actually run, this computes the wall-clock moment at
 * which that capture's OWN launch ceiling would expire in the worst case, and
 * requires the outer budget to still be alive at that moment. Restating the
 * module's arithmetic would prove nothing -- a test derived from the code it
 * tests cannot detect that code being wrong -- so nothing below adds up a
 * budget; it asks when each ceiling fires.
 */

import { describe, expect, it } from "vitest";

import {
    E2E_SUITE_GLOBAL_TIMEOUT_MS,
    ELECTRON_LAUNCH_TIMEOUT_MS,
    FRAME_RESOLUTION_TIMEOUT_MS,
    HOST_FIXTURE_CAPTURE_TIMEOUT_MS,
    PER_CAPTURE_OVERHEAD_MS,
    VSCODE_DOWNLOAD_BUDGET_MS,
} from "../../e2e/hostFixtures/captureBudget";
import { HOST_FIXTURE_THEMES } from "../../e2e/hostFixtures/hostFixtureThemes";

/**
 * The worst-case wall-clock elapsed when capture `k` (1-based) reaches the end
 * of its own `electron.launch()` window: a cold VS Code download up front, then
 * every earlier capture consuming its full launch ceiling, its full frame
 * resolution ceiling, and its share of the surrounding overhead, then this
 * capture's launch running to its ceiling.
 *
 * The overhead term is what makes this a real measurement rather than a copy of
 * the budget: the capture spends time the two ceilings do not describe, and
 * that time still elapses against the outer timeout.
 */
function elapsedWhenLaunchCeilingFires(k: number): number {
    const completedCaptures = k - 1;
    return (
        VSCODE_DOWNLOAD_BUDGET_MS +
        completedCaptures *
            (ELECTRON_LAUNCH_TIMEOUT_MS + FRAME_RESOLUTION_TIMEOUT_MS + PER_CAPTURE_OVERHEAD_MS) +
        ELECTRON_LAUNCH_TIMEOUT_MS
    );
}

/** Same, for the frame-resolution ceiling, which fires after the launch it follows. */
function elapsedWhenFrameCeilingFires(k: number): number {
    return elapsedWhenLaunchCeilingFires(k) + FRAME_RESOLUTION_TIMEOUT_MS;
}

describe("host-fixture capture budget", () => {
    it("captures at least one fixture, so the assertions below are not vacuous", () => {
        expect(HOST_FIXTURE_THEMES.length).toBeGreaterThan(0);
    });

    /**
     * The other vacuity guard, and the one that is easy to miss. Every timing
     * assertion here reads `PER_CAPTURE_OVERHEAD_MS` on BOTH sides -- it widens
     * the budget and it advances the moment each ceiling fires -- so setting it
     * to zero shrinks both together and every one of them still passes while
     * the module is back to summing the inner ceilings exactly, which is the
     * defect. Only a floor stated independently of the constant catches that.
     */
    it("declares per-capture overhead large enough to be real", () => {
        expect(
            PER_CAPTURE_OVERHEAD_MS,
            "a zero or token value satisfies every timing assertion in this file while " +
                "restoring the exact pre-emption they exist to prevent; Electron teardown " +
                "alone is seconds, and the theme switch, the DOM read and the fixture " +
                "write sit on top of it",
        ).toBeGreaterThanOrEqual(10_000);
    });

    /**
     * Every capture, not just the last: an outer budget can be generous enough
     * for the first three and still cut the fourth off mid-launch, and the
     * fourth is the one whose diagnostic is hardest to reconstruct by hand.
     */
    for (let k = 1; k <= HOST_FIXTURE_THEMES.length; k++) {
        const label = HOST_FIXTURE_THEMES[k - 1]?.fixtureId ?? `capture ${k}`;

        it(`lets ${label} reach its own launch ceiling before the test timeout fires`, () => {
            expect(
                HOST_FIXTURE_CAPTURE_TIMEOUT_MS,
                `capture ${k} (${label}) would hit its ${ELECTRON_LAUNCH_TIMEOUT_MS}ms launch ` +
                    `ceiling at ${elapsedWhenLaunchCeilingFires(k)}ms, but the test timeout is ` +
                    `${HOST_FIXTURE_CAPTURE_TIMEOUT_MS}ms -- Playwright would report a generic ` +
                    `test timeout instead of naming this launch`,
            ).toBeGreaterThan(elapsedWhenLaunchCeilingFires(k));
        });

        it(`lets ${label} reach its own frame-resolution ceiling before the test timeout fires`, () => {
            expect(
                HOST_FIXTURE_CAPTURE_TIMEOUT_MS,
                `capture ${k} (${label}) would hit its ${FRAME_RESOLUTION_TIMEOUT_MS}ms frame ` +
                    `ceiling at ${elapsedWhenFrameCeilingFires(k)}ms, past the ` +
                    `${HOST_FIXTURE_CAPTURE_TIMEOUT_MS}ms test timeout`,
            ).toBeGreaterThan(elapsedWhenFrameCeilingFires(k));
        });
    }

    /**
     * The same pre-emption one level up. `globalTimeout` bounds the whole suite,
     * so if it equalled the capture test's own budget the capture could never
     * report its specific failure either -- and Playwright's global-timeout
     * message names no test at all.
     */
    it("leaves the suite timeout above the capture test it contains", () => {
        expect(
            E2E_SUITE_GLOBAL_TIMEOUT_MS,
            "globalTimeout must outlast the capture test, or the suite bound pre-empts it",
        ).toBeGreaterThan(HOST_FIXTURE_CAPTURE_TIMEOUT_MS);
    });

    /**
     * Guards the shape of the fix rather than its value. Slack added as a single
     * flat term would hold today and silently thin out per capture as fixtures
     * are added; multiplying it by the theme count is what keeps a fifth fixture
     * from re-opening this defect without touching the file.
     */
    it("scales the headroom with the number of captures", () => {
        const headroomPerCapture =
            (HOST_FIXTURE_CAPTURE_TIMEOUT_MS -
                VSCODE_DOWNLOAD_BUDGET_MS -
                HOST_FIXTURE_THEMES.length *
                    (ELECTRON_LAUNCH_TIMEOUT_MS + FRAME_RESOLUTION_TIMEOUT_MS)) /
            HOST_FIXTURE_THEMES.length;

        expect(
            headroomPerCapture,
            "each capture needs its own room for theme switching, the DOM read, the " +
                "fixture write and Electron teardown -- headroom that does not scale with " +
                "the capture count thins out as fixtures are added",
        ).toBeGreaterThanOrEqual(PER_CAPTURE_OVERHEAD_MS);
    });
});
