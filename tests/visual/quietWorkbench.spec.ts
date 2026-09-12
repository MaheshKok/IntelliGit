import { oracles } from "../oracles";
import { parseRgba } from "./playwright/collectOracleInputs";
import { expect, test } from "./playwright/harnessPage";

test("merge identity and summaries stay readable without overlap", async ({
    mountHarness,
    page,
}) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json", locale: "de" });
    await page.locator('[aria-controls="merge-details"]').click();
    const boxes = await page.locator(".merge-title, .merge-stats").evaluateAll((elements) =>
        elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        }),
    );
    expect(boxes).toHaveLength(2);
    const [title, stats] = boxes;
    expect(
        title.right <= stats.left || title.bottom <= stats.top || stats.bottom <= title.top,
        "file identity and summary markers must not overlap",
    ).toBe(true);
    const summaries = page.locator(".merge-stat-pill");
    await expect(summaries).toHaveCount(3);
    for (const summary of await summaries.all()) {
        await expect(summary).toBeVisible();
        expect(await summary.textContent()).toMatch(/\d/);
        expect(
            await summary.evaluate((element) => element.scrollWidth <= element.clientWidth),
            "localized status text must fit inside its marker",
        ).toBe(true);
    }
    const path = page.locator(".merge-title .file-path");
    await expect(path).toBeVisible();
    // Font metrics vary across hosts; the complete fixture filename must fit on each.
    await expect(path).toHaveText("conflict.txt");
    expect(
        await path.evaluate((element) => element.scrollWidth <= element.clientWidth),
        "filename must remain readable without clipping",
    ).toBe(true);
});

for (const locale of ["en", "de", "ru"]) {
    test(`narrow conflict session keeps files and actions reachable in ${locale}`, async ({
        mountHarness,
        page,
    }) => {
        await page.setViewportSize({ width: 320, height: 720 });
        await mountHarness("merge-conflict-session", { webviewFixture: "conflicted.json", locale });
        const table = await page.locator(".table-wrap").boundingBox();
        const actions = await page.locator(".action-column").boundingBox();
        expect(table?.width, "file list must not be squeezed by an action sidebar").toBeGreaterThan(
            275,
        );
        expect(actions?.y, "actions follow the table on narrow panels").toBeGreaterThanOrEqual(
            (table?.y ?? 0) + (table?.height ?? 0),
        );
        for (const action of await page.locator(".action-column button, .close-btn").all()) {
            await expect(action).toBeInViewport();
        }
    });
}

test("tablet conflict session preserves its action rail without page overflow", async ({
    mountHarness,
    page,
}) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await mountHarness("merge-conflict-session", { webviewFixture: "conflicted.json" });
    const table = await page.locator(".table-wrap").boundingBox();
    const actions = await page.locator(".action-column").boundingBox();
    expect(actions?.x).toBeGreaterThanOrEqual((table?.x ?? 0) + (table?.width ?? 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        768,
    );
});

test("composer controls animate only compositor properties and retain keyboard focus", async ({
    mountHarness,
    page,
}) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await mountHarness("commit-panel", { webviewFixture: "dirty.json" });
    const unsafe = await page.locator("button, textarea, [role=tab]").evaluateAll((elements) =>
        elements.flatMap((element) => {
            const style = getComputedStyle(element);
            const durations = style.transitionDuration.split(",").map(parseFloat);
            return style.transitionProperty
                .split(",")
                .flatMap((property, index) =>
                    durations[index % durations.length] > 0 &&
                    !["transform", "opacity", "none"].includes(property.trim())
                        ? [property.trim()]
                        : [],
                );
        }),
    );
    expect(unsafe, "controls must not animate layout, color, or all properties").toEqual([]);
    const editor = page.locator("textarea");
    await page.getByRole("checkbox", { name: "binary.bin", exact: true }).check();
    await editor.fill("Polish workbench");
    await editor.press("Tab");
    const commit = page.getByTestId("commit-action-commit");
    await expect(commit).toBeFocused();
    const outline = await commit.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outline).not.toBe("none");
    const tab = page.getByRole("tab").first();
    expect(
        await tab.evaluate((element) =>
            parseFloat(getComputedStyle(element, "::after").transitionDuration),
        ),
        "tab indicator must animate when motion is allowed",
    ).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
        await tab.evaluate((element) =>
            getComputedStyle(element, "::after")
                .transitionDuration.split(",")
                .every((value) => parseFloat(value) === 0),
        ),
        "reduced motion must suppress the otherwise animated tab indicator",
    ).toBe(true);
});

test("conflict error state keeps readable contrast on the host validation surface", async ({
    mountHarness,
    page,
}) => {
    await mountHarness("merge-conflict-session", {
        webviewFixture: "conflicted.json",
        locale: "de",
    });
    await page.evaluate(() => {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    type: "loadError",
                    message: "Repository temporarily unavailable. Please retry.",
                },
            }),
        );
    });
    const error = page.locator(".error");
    await expect(error).toBeVisible();
    const colors = await error.evaluate((element) => {
        const style = getComputedStyle(element);
        return { foreground: style.color, background: style.backgroundColor };
    });
    const foreground = parseRgba(colors.foreground);
    const background = parseRgba(colors.background);
    if (!foreground || !background) throw new Error("Unmeasurable validation colors");
    expect(
        oracles.get("contrast").contrastRatio(foreground, background),
        "error text must clear 4.5:1 on its validation background",
    ).toBeGreaterThanOrEqual(4.5);
});
