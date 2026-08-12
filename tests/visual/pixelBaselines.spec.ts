import { HOST_CONTEXT_FIXTURES, HOST_CONTEXT_IDS } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";
import { environmentVerdict } from "./playwright/visualEnvironmentGuard";
import { oracles } from "../oracles";

const { planPixelAssertions } = oracles.get("pixelAssertionPlan");

test.describe("pixel baseline screenshots", () => {
    for (const contextId of HOST_CONTEXT_IDS) {
        test(`${contextId} matches the pixel baseline`, async ({ mountHarness, page }) => {
            const plan = planPixelAssertions(environmentVerdict());
            if (plan.kind === "skip") {
                test.skip(true, plan.reason);
                return;
            }
            if (plan.kind === "fail") throw new Error(plan.reason);

            await mountHarness(contextId, {
                webviewFixture: HOST_CONTEXT_FIXTURES[contextId],
            });
            await page.evaluate(async () => {
                // toHaveScreenshot's animations: "disabled" finishes CSS animations and
                // transitions, but SMIL runs on a separate timeline it never touches. The
                // pending-checks spinner in CommitChecksPopover is inlined SMIL
                // (<animateTransform repeatCount="indefinite">), so on the commit-graph
                // screens it rotates forever and Playwright cannot get two consecutive
                // matching frames -- it gives up after 5s having written nothing, or worse,
                // happens to catch two matching frames and records a baseline at an
                // arbitrary rotation that no later run can reproduce.
                //
                // Pinning each timeline to t=0 fixes the phase rather than the speed. A still
                // image can never assert that an animation runs, so nothing is lost here that
                // a screenshot could have caught: colour, size, position and presence of the
                // spinner are all still compared.
                for (const svg of document.querySelectorAll("svg")) {
                    svg.pauseAnimations();
                    svg.setCurrentTime(0);
                }
                await document.fonts.ready;
            });
            await expect(page).toHaveScreenshot();
        });
    }
});
