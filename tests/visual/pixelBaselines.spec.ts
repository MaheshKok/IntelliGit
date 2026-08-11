import { HOST_CONTEXT_FIXTURES, HOST_CONTEXT_IDS } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";
import { environmentVerdict } from "./playwright/visualEnvironmentGuard";
import { planPixelAssertions } from "./oracles/pixelAssertionPlan";

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
                await document.fonts.ready;
            });
            await expect(page).toHaveScreenshot();
        });
    }
});
