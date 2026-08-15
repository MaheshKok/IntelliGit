import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HARNESS_PAGE_PATH = resolve(__dirname, "../../../visual/playwright/harnessPage.ts");
const harnessPageSource = readFileSync(HARNESS_PAGE_PATH, "utf8");

describe("harness page visual environment contract", () => {
    it("keeps the worker auto fixture wired to environment preparation", () => {
        expect(harnessPageSource).toContain(
            'import { prepareVisualEnvironment } from "./visualEnvironmentGuard";',
        );

        const visualEnvironmentFixture = harnessPageSource.match(
            /visualEnvironment:\s*\[[\s\S]*?\n\s*\],\n\s*mountHarness:/,
        )?.[0];
        expect(visualEnvironmentFixture).toBeDefined();
        expect(visualEnvironmentFixture).toContain(
            "await prepareVisualEnvironment(browser, workerInfo.config.workers);",
        );
        expect(visualEnvironmentFixture).toContain('{ scope: "worker", auto: true }');
    });

    it("keeps the fixture dispatch waiting for the render it triggers", () => {
        // `settleRootSubtree` is unit-tested on its own, but a correct predicate nobody awaits is
        // the same race as no predicate at all -- and deleting the one `await` leaves every other
        // test in this repo green, because the race it closes is won on timing luck far more often
        // than it is lost. This is the assertion that goes red for that deletion.
        const dispatchBlock = harnessPageSource.match(
            /if \(fixture !== undefined\) \{[\s\S]*?\n {12}\}/,
        )?.[0];
        expect(dispatchBlock).toBeDefined();
        expect(dispatchBlock).toContain("await waitForRootSubtreeToSettle(page);");
        expect(harnessPageSource).toContain(
            'import { settleRootSubtree } from "./settleRootSubtree";',
        );
        expect(harnessPageSource).toContain("await page.evaluate(settleRootSubtree, {");
    });
});
