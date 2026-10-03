import { expect, test } from "./playwright/harnessPage";

/** Resolves host colors through Chromium rather than assuming one serialized color syntax. */
async function color(page: import("@playwright/test").Page, variable: string): Promise<string> {
    return page.evaluate((name) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const result = getComputedStyle(probe).color;
        probe.remove();
        return result;
    }, variable);
}

test("merge workbench uses host colors and keeps input decisions reversible", async ({
    mountHarness,
    page,
}) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });
    const result = page.locator('[data-testid="merge-editor-1"] .cm-content');
    await expect(result).toHaveAttribute("contenteditable", "true");
    await expect(page.locator('[data-testid="merge-editor-0"] .cm-content')).toHaveAttribute(
        "contenteditable",
        "false",
    );
    await expect(page.locator(".merge-workbench")).toHaveCSS(
        "background-color",
        await color(page, "--vscode-editor-background"),
    );
    await expect(result).toHaveCSS("color", await color(page, "--vscode-editor-foreground"));
    const original = await result.innerText();
    await page
        .locator(".mw-connectors")
        .first()
        .getByRole("button", { name: "Accept left change", exact: true })
        .first()
        .click();
    await expect(result).toContainText("TWO-MAIN");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => result.innerText()).toBe(original);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(result).toContainText("TWO-MAIN");
    await page.getByRole("button", { name: "Base", exact: true }).click();
    await expect(page.locator(".mw-base .cm-content")).toContainText("two");
    const connectors = await page.locator(".mw-connectors path").evaluateAll((elements) =>
        elements
            .filter((element) => getComputedStyle(element).display !== "none")
            .map((element) => ({
                ribbon: element.getBoundingClientRect().toJSON(),
                channel: element.closest(".mw-connectors")!.getBoundingClientRect().toJSON(),
            })),
    );
    expect(connectors.length).toBeGreaterThan(0);
    for (const { ribbon, channel } of connectors) {
        expect(ribbon.width).toBeGreaterThan(0);
        expect(ribbon.left).toBeGreaterThanOrEqual(channel.left - 1);
        expect(ribbon.right).toBeLessThanOrEqual(channel.right + 1);
    }
});

test("merge workbench avoids duplicate whole-line tint and retains word-level contrast", async ({
    mountHarness,
    page,
}) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });
    const side = page.locator('[data-testid="merge-editor-2"]');
    const inserted = side.locator(".cm-line").filter({ hasText: "THEIRS-ONLY-ADD" });
    await expect(inserted).toHaveCount(1);
    await expect(inserted.locator(".merge-word-change")).toHaveCount(0);
    const changed = side
        .locator(".cm-line")
        .filter({ hasText: "TWO-CONFLICT" })
        .locator(".merge-word-change");
    expect(await changed.count()).toBeGreaterThan(0);
    await expect(changed.first()).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("localized merge controls remain reachable without page overflow", async ({
    mountHarness,
    page,
}) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json", locale: "de" });
    const viewport = page.viewportSize()!;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
    );
    for (const control of await page
        .locator(".mw-toolbar button, .mw-toolbar select, .mw-footer button")
        .all()) {
        await expect(control).toBeInViewport();
        const box = await control.boundingBox();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.height).toBeGreaterThan(0);
    }
});
