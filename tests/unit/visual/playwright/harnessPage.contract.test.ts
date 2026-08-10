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
});
