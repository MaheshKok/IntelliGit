import { expect, test } from "./playwright/harnessPage";

test("dismissed insertion words return to host-theme syntax", async ({ mountHarness, page }) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });

    await page.locator('[data-conflict-id="1"] .conflict-actions-right .discard-btn').click();

    const row = page.locator(
        '[data-conflict-id="1"] .conflict-column.dismissed .conflict-theirs .real-code-line',
    );
    const word = row.locator(".word-diff-change").first();
    await expect(word).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    const rowStyle = await row.evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, colorScheme: style.colorScheme };
    });
    await expect(word).toHaveCSS("color-scheme", rowStyle.colorScheme);
    await expect(word).toHaveCSS("color", rowStyle.color);
});
