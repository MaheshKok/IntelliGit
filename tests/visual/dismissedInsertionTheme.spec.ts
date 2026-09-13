import { expect, test } from "./playwright/harnessPage";

test("dismissed insertion words return to host-theme syntax", async ({ mountHarness, page }) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });

    await page.locator('[data-conflict-id="1"] .conflict-actions-right .discard-btn').click();

    const row = page.locator(
        '[data-conflict-id="1"] .conflict-column.dismissed .conflict-theirs .real-code-line',
    );
    const word = row.locator(".word-diff-change").first();
    await expect(word).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    const hostColor = await page
        .locator(".merge-content")
        .evaluate((element) => getComputedStyle(element).color);
    await expect(row).toHaveCSS("color-scheme", "light");
    await expect(row).toHaveCSS("color", hostColor);
    await expect(word).toHaveCSS("color-scheme", "light");
    await expect(word).toHaveCSS("color", hostColor);
});
