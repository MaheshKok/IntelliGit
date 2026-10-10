import { expect, test } from "./playwright/harnessPage";
import { mountLegacyMerge } from "./legacyMerge";
import conflict from "./fixtures/merge-editor/conflicted.json";

test("right-hand input gutter keeps long-line scrolling linked in both directions", async ({
    mountHarness,
    page,
}) => {
    await mountHarness("shelf-conflict-editor");
    const data = structuredClone(conflict.messages[0].message.data);
    const longLine = "long code content ".repeat(80);
    data.segments[0].lines = [longLine];
    for (const side of ["base", "ours", "theirs"] as const)
        data.workbench[side] = data.workbench[side].replace("one", longLine);
    await page.evaluate(
        (payload) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setConflictData",
                        data: payload,
                    },
                }),
            ),
        data,
    );
    const inputs = [0, 1, 2].map((pane) =>
        page.locator(`[data-testid="merge-editor-${pane}"] .cm-scroller`),
    );
    await expect(inputs[0]).toBeVisible();
    await inputs[0].evaluate((element) => {
        element.scrollLeft = 120;
    });
    for (const input of inputs)
        await expect.poll(() => input.evaluate((element) => element.scrollLeft)).toBe(120);
    // Let the linked programmatic scroll events finish before driving the opposite pane.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
    await inputs[2].evaluate((element) => {
        element.scrollLeft = 240;
    });
    for (const input of inputs)
        await expect.poll(() => input.evaluate((element) => element.scrollLeft)).toBe(240);
});

test("workbench retains the existing merge diff-area design", async ({
    mountHarness,
    page,
}, testInfo) => {
    await mountLegacyMerge(mountHarness, page);
    const chrome = () =>
        page.locator(".merge-editor").evaluate((root) => {
            const style = (selector: string) => {
                const value = getComputedStyle(root.querySelector(selector)!);
                return {
                    background: value.backgroundColor,
                    padding: value.padding,
                    fontSize: value.fontSize,
                    minHeight: value.minHeight,
                };
            };
            return [style(".merge-toolbar"), style(".pane-meta-row"), style(".merge-footer")];
        });
    const original = await chrome();
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });
    expect(await chrome()).toEqual(original);
    const apply = page.getByRole("button", { name: "Apply", exact: true });
    await expect(apply).toBeDisabled();
    await expect(apply).toHaveCSS("opacity", "0.55");
    await expect(page.locator(".mw-toolbar select.mw-hunks")).toBeVisible();
    await expect(page.locator(".mw-hunks button")).toHaveCount(0);
    const left = page.locator('[data-testid="merge-editor-0"]');
    const right = page.locator('[data-testid="merge-editor-2"]');
    for (const [pane, side] of [
        [left, "right"],
        [right, "left"],
    ] as const) {
        const numberBox = (await pane.locator(".cm-gutters").boundingBox())!;
        const textBox = (await pane.locator(".cm-content").boundingBox())!;
        if (side === "right") expect(numberBox.x).toBeGreaterThan(textBox.x);
        else expect(numberBox.x + numberBox.width).toBeLessThanOrEqual(textBox.x + 1);
    }
    await expect(left.locator(".cm-scroller")).toHaveCSS("line-height", "20px");
    const changed = left.locator(".cm-line.merge-range-pending").first();
    await expect(changed).toHaveCSS("background-color", "rgb(59, 42, 50)");
    await expect(changed).toHaveCSS("color", "rgb(171, 178, 191)");
    await expect(left.locator(".cm-gutterElement.merge-range-pending").first()).toHaveCSS(
        "background-color",
        "rgb(75, 21, 21)",
    );
    await expect(left.locator(".cm-gutterElement.merge-range-pending").first()).toHaveCSS(
        "color",
        "rgb(171, 178, 191)",
    );
    const actions = page.locator(".mw-connectors-ours .mw-actions").first();
    await expect(actions.locator(".accept-btn")).toHaveCSS("color", "rgb(102, 187, 106)");
    await expect(actions.locator(".discard-btn")).toHaveCSS("color", "rgb(251, 31, 73)");
    const gutter = (await left.locator(".cm-gutters").boundingBox())!;
    const actionBox = (await actions.boundingBox())!;
    expect(actionBox.x).toBeGreaterThanOrEqual(gutter.x);
    expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(gutter.x + gutter.width);
    await expect(actions.locator(".accept-btn svg path")).toHaveCSS("fill", "rgb(102, 187, 106)");
    await actions.locator(".accept-btn").click();
    await expect(apply).toBeEnabled();
    await expect(apply).toHaveCSS("opacity", "1");
    await expect(page.locator(".mw-connectors-ours path").first()).toHaveCSS("fill", "none");
    await expect(page.locator(".mw-connectors-ours path").first()).toHaveCSS(
        "stroke-dasharray",
        "2px, 2px",
    );
    await expect(left.locator(".cm-line.merge-range-pending")).toHaveCount(0);
    await expect(left.locator(".cm-line.merge-range-resolved").first()).toHaveCSS(
        "color",
        await color(page, "--vscode-editor-foreground"),
    );
    const contour = await left
        .locator(".cm-line.merge-range-resolved")
        .first()
        .evaluate((element) => getComputedStyle(element, "::before").borderTopStyle);
    expect(contour).toBe("dotted");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(changed).toHaveCSS("background-color", "rgb(59, 42, 50)");
    await page.screenshot({ path: testInfo.outputPath("author-design.png") });
});

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
    const connectors = await page.locator(".mw-connectors > svg path").evaluateAll((elements) =>
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
