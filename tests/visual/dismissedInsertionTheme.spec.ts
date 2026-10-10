import { mergeSelectors } from "./mergeSelectors";
import { expect, test } from "./playwright/harnessPage";
import { mountLegacyMerge, mountWorkbenchMerge } from "./legacyMerge";

for (const target of ["legacy", "workbench"] as const) {
    const selectors = mergeSelectors[target];
    test(`dismissed insertion words return to host-theme syntax (${target})`, async ({
        mountHarness,
        page,
    }) => {
        if (target === "legacy") await mountLegacyMerge(mountHarness, page);
        else await mountWorkbenchMerge(mountHarness, page);

        await page.locator(selectors.discardButton).click();

        const row = page.locator(selectors.dismissedRow);
        const word = row.locator(selectors.wordFill).first();
        await expect(word).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

        const hostColor = await page
            .locator(selectors.content)
            .evaluate((element) => getComputedStyle(element).color);
        await expect(row).toHaveCSS("color-scheme", "light");
        await expect(row).toHaveCSS("color", hostColor);
        await expect(word).toHaveCSS("color-scheme", "light");
        await expect(word).toHaveCSS("color", hostColor);
    });
}
