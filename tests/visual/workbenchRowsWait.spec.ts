import { expect, test, waitForWorkbenchRowsToMatch } from "./playwright/harnessPage";

const ROWS = `
    <style>
        .cm-editor { display: flex; position: relative; }
        .cm-content > div, .cm-gutterElement { height: 20px; }
    </style>
    <div class="merge-editor workbench">
        <div class="cm-editor">
            <div class="cm-content"><div>Content</div></div>
            <div class="cm-gutters"><div class="cm-gutterElement">1</div></div>
        </div>
    </div>
`;

test.describe("workbench gutter-row wait", () => {
    test.beforeEach(async ({ page }) => {
        // Static DOM avoids the harness's reduced-motion transition override.
        await page.setContent(ROWS);
    });

    test("rejects a 14px gutter beside a 20px row", async ({ page }) => {
        await page.locator(".cm-gutterElement").evaluate((cell) => {
            cell.style.height = "14px";
        });
        await expect(page.evaluate(waitForWorkbenchRowsToMatch, 300)).rejects.toThrow(
            "is 14px tall beside a 20px row",
        );
    });

    test("settles equal heights with an unchanged layout", async ({ page }) => {
        await expect(page.evaluate(waitForWorkbenchRowsToMatch, 300)).resolves.toBeUndefined();
    });

    test("rejects equal heights when layout changes every frame", async ({ page }) => {
        await page.locator(".cm-editor").evaluate((editor) => {
            let offset = 0;
            const move = () => {
                editor.style.top = `${++offset}px`;
                requestAnimationFrame(move);
            };
            requestAnimationFrame(move);
        });
        await expect(page.evaluate(waitForWorkbenchRowsToMatch, 300)).rejects.toThrow(
            "layout still changing",
        );
    });

    test("rejects a visible editor with content but no gutter cells", async ({ page }) => {
        await page.locator(".cm-gutters").evaluate((gutters) => gutters.remove());
        await expect(page.evaluate(waitForWorkbenchRowsToMatch, 300)).rejects.toThrow(
            "editor 1 has content but no gutter cells",
        );
    });

    test("settles an empty editor without gutter cells", async ({ page }) => {
        await page.locator(".cm-gutters").evaluate((gutters) => gutters.remove());
        await page.locator(".cm-content").evaluate((content) => {
            content.textContent = " \n\t ";
        });
        await expect(page.evaluate(waitForWorkbenchRowsToMatch, 300)).resolves.toBeUndefined();
    });

    test("ignores a hidden editor with content but no gutter cells", async ({ page }) => {
        await page.locator(".merge-editor").evaluate((workbench) => {
            workbench.insertAdjacentHTML(
                "beforeend",
                '<div class="cm-editor" style="display:none"><div class="cm-content"><div>Hidden base</div></div></div>',
            );
        });
        await expect(page.evaluate(waitForWorkbenchRowsToMatch, 300)).resolves.toBeUndefined();
    });
});
