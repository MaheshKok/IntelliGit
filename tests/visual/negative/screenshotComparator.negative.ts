import { expect, test } from "@playwright/test";

test("compares a fixed solid-colour block against its screenshot baseline", async ({ page }) => {
    await page.setContent(`
        <!doctype html>
        <html>
            <head>
                <style>
                    html, body { width: 160px; height: 120px; margin: 0; overflow: hidden; }
                    #pixel-comparator { width: 160px; height: 120px; background: rgb(70, 120, 255); }
                </style>
            </head>
            <body><div id="pixel-comparator"></div></body>
        </html>
    `);

    await expect(page).toHaveScreenshot("pixel-comparator.png");
});
