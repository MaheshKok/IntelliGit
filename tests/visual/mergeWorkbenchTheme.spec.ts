import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./playwright/harnessPage";
import { mountLegacyMerge, mountWorkbenchMerge } from "./legacyMerge";

const unresolved = ".overview-marker.marker-conflict.unresolved";
const resolved = ".overview-marker.marker-conflict.resolved";
const ribbon = "svg.merge-connectors path.merge-connector";
const legacyAccept = ".col-left .conflict-actions-left .accept-btn";
const workbenchAccept = ".pane-ours .accept-btn";

async function stableStyle(locator: Locator, properties: string[]) {
    await expect(locator).toHaveCount(1);
    let previous = "";
    let stable = 0;
    let values: string[] = [];
    await expect
        .poll(async () => {
            values = await locator.evaluate((element, names) => {
                const style = getComputedStyle(element);
                return names.map((name) => style.getPropertyValue(name));
            }, properties);
            const current = JSON.stringify(values);
            stable = current === previous ? stable + 1 : 0;
            previous = current;
            return stable;
        })
        .toBeGreaterThanOrEqual(2);
    return values;
}

function expectPaint(value: string) {
    expect(value).not.toBe("");
    expect(["transparent", "rgba(0, 0, 0, 0)", "none"]).not.toContain(value);
}

function shadowColours(shadow: string) {
    const colours = shadow.match(/(?:rgba?|hsla?|color)\([^)]*\)/g);
    if (!colours?.length) throw new Error(`no colour tokens in shadow: ${shadow}`);
    return colours;
}

test.afterEach(async ({ page }) => {
    await expect
        .poll(() =>
            page.locator(".merge-viewport, .merge-col").evaluateAll((elements) =>
                elements.map((element) => ({
                    top: element.scrollTop,
                    left: element.scrollLeft,
                })),
            ),
        )
        .toEqual(Array.from({ length: 4 }, () => ({ top: 0, left: 0 })));
});

test("rail marks an unresolved true conflict in main's colour", async ({ mountHarness, page }) => {
    await mountLegacyMerge(mountHarness, page);
    const [expected] = await stableStyle(page.locator(unresolved).first(), ["background-color"]);
    expectPaint(expected);
    await mountWorkbenchMerge(mountHarness, page);
    const [actual] = await stableStyle(page.locator(unresolved).first(), ["background-color"]);
    expect(actual, "unresolved rail background equals LegacyApp").toBe(expected);
    expectPaint(actual);
});

test("rail marks a resolved conflict in main's colour", async ({ mountHarness, page }) => {
    await mountLegacyMerge(mountHarness, page);
    await page.locator(legacyAccept).first().click();
    const [expected] = await stableStyle(page.locator(resolved).first(), ["background-color"]);
    expectPaint(expected);
    await mountWorkbenchMerge(mountHarness, page);
    await page.locator(workbenchAccept).first().click();
    const [actual] = await stableStyle(page.locator(resolved).first(), ["background-color"]);
    expect(actual, "resolved rail background equals LegacyApp").toBe(expected);
    expectPaint(actual);
});

/** Resolves `color-mix(in srgb, var(<name>) 16%, transparent)` inside the workbench root. */
async function ringColour(page: Page, name: string) {
    const colour = await page.locator(".merge-editor.workbench").evaluate((root, variable) => {
        const probe = document.createElement("span");
        probe.style.color = `color-mix(in srgb, var(${variable}) 16%, transparent)`;
        root.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
    }, name);
    expectPaint(colour);
    return colour;
}

test("the active hunk ring uses main's focus colour", async ({ mountHarness, page }, testInfo) => {
    await mountLegacyMerge(mountHarness, page);
    await page.locator(unresolved).first().click();
    const [mainShadow] = await stableStyle(
        page.locator(".col-middle .segment-conflict.change-conflict.active").first(),
        ["box-shadow"],
    );
    // Pending main blocks carry boundaries first, then the 16% focus ring (the sole
    // shadow after resolution, merge-editor.css's resolved.active rule).
    const expected = shadowColours(mainShadow).at(-1)!;
    expectPaint(expected);
    await mountWorkbenchMerge(mountHarness, page);
    await page.locator(unresolved).first().click();
    const [shadow] = await stableStyle(
        page.locator(".pane-result .cm-line.mrow-active.mrow-first").first(),
        ["box-shadow"],
    );
    const actual = shadowColours(shadow).at(-1)!;
    expectPaint(actual);
    // The ring check can only tell the focus colour from the accent where the theme
    // gives them different values; say so out loud where it cannot.
    const focusRing = await ringColour(page, "--vscode-focusBorder");
    const accentRing = await ringColour(page, "--merge-accent");
    if (focusRing === accentRing) {
        const note = `ring check cannot tell --vscode-focusBorder from --merge-accent here: both resolve to ${focusRing} in ${testInfo.project.name}`;
        console.log(note);
        testInfo.annotations.push({ type: "ring-not-discriminating", description: note });
    }
    expect(actual, "active hunk ring colour equals LegacyApp's 16% focus ring").toBe(expected);
});

test("ribbons fill in main's colour", async ({ mountHarness, page }) => {
    await mountLegacyMerge(mountHarness, page);
    const expected = await stableStyle(page.locator(ribbon).first(), ["fill", "stroke"]);
    expectPaint(expected[0]);
    await mountWorkbenchMerge(mountHarness, page);
    const actual = await stableStyle(page.locator(ribbon).first(), ["fill", "stroke"]);
    expect(actual, "pending ribbon fill and stroke equal LegacyApp").toEqual(expected);
    expectPaint(actual[0]);
});

async function firstFrame(page: Page) {
    await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.chromeFirstFrame))
        .toBeTruthy();
    return page.evaluate(() => JSON.parse(document.documentElement.dataset.chromeFirstFrame!));
}

async function autoResolvedDetails(page: Page) {
    const details = page.locator("#merge-details");
    await expect(details).toHaveCount(1);
    const text = await details.textContent();
    if (text === null) throw new Error("details text missing");
    // Zero has no auto-resolved pill in either renderer.
    const match = text.match(/(\d+) auto-resolved/);
    return match ? Number(match[1]) : 0;
}

test("toolbar and pane headers paint on the first frame like main's", async ({
    mountHarness,
    page,
}, testInfo) => {
    await page.addInitScript(() => {
        const observer = new MutationObserver(() => {
            const root = document.querySelector(".merge-editor");
            if (!root) return;
            observer.disconnect();
            requestAnimationFrame(() => {
                document.documentElement.dataset.chromeFirstFrame = JSON.stringify({
                    toolbar: Boolean(root.querySelector(".merge-toolbar")),
                    headers: Boolean(root.querySelector(".pane-meta-row")),
                });
            });
        });
        observer.observe(document, { childList: true, subtree: true });
    });
    await mountLegacyMerge(mountHarness, page);
    const expected = await firstFrame(page);
    const legacyCount = await autoResolvedDetails(page);
    expect(expected).toEqual({ toolbar: true, headers: true });
    await mountWorkbenchMerge(mountHarness, page);
    const actual = await firstFrame(page);
    const workbenchCount = await autoResolvedDetails(page);
    console.log(`auto-resolved at load: LegacyApp=${legacyCount}; workbench=${workbenchCount}`);
    await testInfo.attach("auto-resolved-counts", {
        body: JSON.stringify({ legacyCount, workbenchCount }),
        contentType: "application/json",
    });
    expect(workbenchCount, "workbench auto-resolved count equals LegacyApp's").toBe(legacyCount);
    expect(actual, "workbench first painted frame has main's toolbar and pane headers").toEqual(
        expected,
    );
});

async function rootGeometry(page: Page) {
    const root = page.locator(".merge-editor");
    const footer = page.locator(".merge-footer");
    await expect(footer).toBeVisible();
    await expect
        .poll(
            () =>
                footer.evaluate((element) => {
                    const box = element.getBoundingClientRect();
                    return (
                        box.top >= 0 &&
                        box.left >= 0 &&
                        box.bottom <= innerHeight &&
                        box.right <= innerWidth
                    );
                }),
            { message: "footer must fit entirely inside the viewport" },
        )
        .toBe(true);
    return stableStyle(root, ["height", "overflow"]);
}

test("the root fits the viewport like main's", async ({ mountHarness, page }) => {
    await mountLegacyMerge(mountHarness, page);
    const expected = await rootGeometry(page);
    await mountWorkbenchMerge(mountHarness, page);
    expect(await rootGeometry(page)).toEqual(expected);
});

async function focusAndPress(page: Page, selector: string) {
    const target = page.locator(selector).first();
    await page.keyboard.press("Tab");
    await target.focus();
    expect(
        await target.evaluate((element) => element.matches(":focus-visible")),
        `${selector} must have keyboard-visible focus`,
    ).toBe(true);
    const outline = await stableStyle(target, [
        "outline-color",
        "outline-style",
        "outline-width",
        "outline-offset",
    ]);
    const box = await target.boundingBox();
    if (!box) throw new Error(`missing button box: ${selector}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
        expect(await target.evaluate((element) => element.matches(":active"))).toBe(true);
        return { outline, shadow: await stableStyle(target, ["box-shadow"]) };
    } finally {
        await page.mouse.up();
    }
}

test("focus and press styling match main's", async ({ mountHarness, page }) => {
    await mountLegacyMerge(mountHarness, page);
    const accept = await focusAndPress(page, legacyAccept);
    const marker = await focusAndPress(page, ".overview-marker");
    await mountWorkbenchMerge(mountHarness, page);
    expect(
        await focusAndPress(page, workbenchAccept),
        "accept-button focus and press styles",
    ).toEqual(accept);
    expect(
        await focusAndPress(page, ".overview-marker"),
        "rail-marker focus and press styles",
    ).toEqual(marker);
});
