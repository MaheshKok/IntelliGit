import { mergeSelectors } from "./mergeSelectors";
import { expect, test } from "./playwright/harnessPage";
import { mountLegacyMerge, mountWorkbenchMerge } from "./legacyMerge";

test("diff gutters, ribbons and collapsed lines use host change colors", async ({
    mountHarness,
    page,
}, testInfo) => {
    await mountHarness("diff-viewer", { webviewFixture: "clean.json" });
    const hostColor = (expression: string) =>
        page.evaluate((value) => {
            const probe = document.createElement("span");
            probe.style.backgroundColor = value;
            document.body.append(probe);
            const resolved = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return resolved;
        }, expression);
    for (const [state, expression] of [
        ["modified", "var(--vscode-editorGutter-modifiedBackground, #007acc)"],
        ["deleted", "var(--vscode-editorGutter-deletedBackground, #f14c4c)"],
        ["inserted", "var(--vscode-editorGutter-addedBackground, #2ea043)"],
    ]) {
        const color = await hostColor(expression);
        const direction = state === "inserted" ? "inserted" : "removed";
        const gutter = await hostColor(
            `var(--vscode-diffEditorGutter-${direction}LineBackground, var(--vscode-diffEditor-${direction}LineBackground, var(--vscode-diffEditor-${direction}TextBackground, transparent)))`,
        );
        await expect(
            page.locator(`.diff-pane .diff-segment-${state} .line-numbers`).first(),
        ).toHaveCSS("background-color", gutter);
        const ribbon = page.locator(`.diff-ribbon.diff-segment-${state}`).first();
        await expect(ribbon).toHaveCSS("fill", color);
        await expect(ribbon).toHaveCSS("opacity", "1");
    }
    await expect(page.locator(".diff-gap-deleted").first()).toHaveCSS(
        "box-shadow",
        `${await hostColor("var(--vscode-editorGutter-deletedBackground, #f14c4c)")} 0px 0px 0px 1px`,
    );
    await page.screenshot({ path: testInfo.outputPath("diff-gutters.png") });
});

for (const target of ["legacy", "workbench"] as const) {
    const selectors = mergeSelectors[target];
    test(`merge conflict gutters and thin boundaries retain dark colors (${target})`, async ({
        mountHarness,
        page,
    }, testInfo) => {
        if (target === "legacy") await mountLegacyMerge(mountHarness, page);
        else await mountWorkbenchMerge(mountHarness, page);
        await expect(page.locator(selectors.pendingGutterCell).first()).toHaveCSS(
            "background-color",
            "rgb(75, 21, 21)",
        );
        const connector = page.locator(selectors.conflictRibbon).first();
        await expect(connector).toHaveCSS("fill", "rgb(75, 21, 21)");
        await expect(connector).toHaveCSS("stroke", "rgb(75, 21, 21)");
        await expect(page.locator(selectors.conflictBoundary).first()).toHaveCSS(
            "box-shadow",
            /^rgb\(75, 21, 21\) 0px 2px 0px 0px inset, rgb\(75, 21, 21\) 0px -2px 0px 0px inset/,
        );
        await expect(page.locator(selectors.insertionRibbon).first()).toHaveCSS(
            "fill",
            "rgb(38, 75, 51)",
        );
        await expect(page.locator(selectors.insertionRibbon).first()).toHaveCSS(
            "stroke",
            "rgb(38, 75, 51)",
        );
        await page.screenshot({ path: testInfo.outputPath("merge-gutters.png") });
    });
}
