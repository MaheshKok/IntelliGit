import { expect, test } from "./playwright/harnessPage";

test("diff gutters, ribbons and collapsed lines use solid change colors", async ({
    mountHarness,
    page,
}, testInfo) => {
    await mountHarness("diff-viewer", { webviewFixture: "clean.json" });
    for (const [state, color] of [
        ["modified", "rgb(75, 21, 21)"],
        ["deleted", "rgb(75, 21, 21)"],
        ["inserted", "rgb(38, 75, 51)"],
    ]) {
        await expect(
            page.locator(`.diff-pane .diff-segment-${state} .line-numbers`).first(),
        ).toHaveCSS("background-color", color);
        const ribbon = page.locator(`.diff-ribbon.diff-segment-${state}`).first();
        await expect(ribbon).toHaveCSS("fill", color);
        await expect(ribbon).toHaveCSS("opacity", "1");
    }
    await expect(page.locator(".diff-gap-deleted").first()).toHaveCSS(
        "box-shadow",
        "rgb(75, 21, 21) 0px 0px 0px 1px",
    );
    await page.screenshot({ path: testInfo.outputPath("diff-gutters.png") });
});

test("merge conflict gutters and thin boundaries retain dark colors", async ({
    mountHarness,
    page,
}, testInfo) => {
    await mountHarness("merge-editor", { webviewFixture: "conflicted.json" });
    await expect(page.locator(".change-conflict .conflict-ours .real-line-row").first()).toHaveCSS(
        "background-color",
        "rgb(75, 21, 21)",
    );
    const connector = page.locator(".merge-connector.change-conflict").first();
    await expect(connector).toHaveCSS("fill", "rgb(75, 21, 21)");
    await expect(connector).toHaveCSS("stroke", "rgb(75, 21, 21)");
    await expect(page.locator(".segment-conflict.change-conflict").first()).toHaveCSS(
        "box-shadow",
        /^rgb\(75, 21, 21\) 0px 2px 0px 0px inset, rgb\(75, 21, 21\) 0px -2px 0px 0px inset/,
    );
    await expect(page.locator(".merge-connector.variant-insertion").first()).toHaveCSS(
        "fill",
        "rgb(38, 75, 51)",
    );
    await expect(page.locator(".merge-connector.variant-insertion").first()).toHaveCSS(
        "stroke",
        "rgb(38, 75, 51)",
    );
    await page.screenshot({ path: testInfo.outputPath("merge-gutters.png") });
});
