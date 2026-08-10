import { expect, test } from "./playwright/harnessPage";
import { collectOracleInputs } from "./playwright/collectOracleInputs";

test.describe("contrast collector inactive state", () => {
    test("marks disabled elements and their descendants inactive", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("commit-graph-card");

        await page.locator("#root").evaluate((root) => {
            root.innerHTML = `
                <button class="contrast-sample" data-testid="disabled-element" disabled>
                    Disabled element
                </button>
                <button class="contrast-sample" disabled>
                    <span class="contrast-sample" data-testid="disabled-descendant">
                        Disabled descendant
                    </span>
                </button>
                <div class="contrast-sample" data-testid="aria-disabled-element" aria-disabled="true">
                    Aria-disabled element
                </div>
                <div class="contrast-sample" aria-disabled="true">
                    <span class="contrast-sample" data-testid="aria-disabled-descendant">
                        Aria-disabled descendant
                    </span>
                </div>
                <button class="contrast-sample" data-testid="active-element">
                    Active element
                </button>
            `;
        });

        const inputs = await collectOracleInputs(page);
        const testIds = [
            "disabled-element",
            "disabled-descendant",
            "aria-disabled-element",
            "aria-disabled-descendant",
            "active-element",
        ] as const;
        const inactiveByTestId = testIds.map((testId) => {
            const sample = inputs.contrast.find((contrastSample) =>
                contrastSample.id.includes(`[data-testid="${testId}"]`),
            );
            expect(sample, `missing contrast sample for ${testId}`).toBeDefined();
            return sample?.inactive;
        });

        expect(inputs.contrast).toHaveLength(testIds.length);
        expect(inactiveByTestId).toEqual([true, true, true, true, false]);
    });
});
