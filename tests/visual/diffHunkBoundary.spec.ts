import { expect, test } from "./playwright/harnessPage";

for (const state of ["modified", "deleted", "inserted"] as const) {
    test(`${state} diff boundaries blend into the line fill`, async ({
        mountHarness,
        page,
    }, testInfo) => {
        await mountHarness("diff-viewer", { webviewFixture: "clean.json" });
        const blocks = page.locator(`.diff-segment-changed.diff-segment-${state}`);
        await expect(blocks.first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`${state}-boundaries.png`) });
        const samples = await blocks.evaluateAll((elements) =>
            elements.map((element) => {
                const style = getComputedStyle(element);
                return {
                    fill: style.backgroundColor,
                    // Chromium resolves this fixed palette to RGB; unknown syntax fails below.
                    edges: style.boxShadow.match(/rgba?\([^)]+\)/g) ?? [],
                    height: element.getBoundingClientRect().height,
                };
            }),
        );
        expect(samples.length, `${state} blocks must render`).toBeGreaterThan(0);
        for (const sample of samples) {
            expect(sample.height, `${state} block must occupy visible rows`).toBeGreaterThan(0);
            expect(
                sample.edges,
                `${state} must retain three geometry-neutral inset edges`,
            ).toHaveLength(3);
            // The green side marker stays distinct; red boundaries must all blend into their fill.
            const edges = state === "inserted" ? sample.edges.slice(1) : sample.edges;
            expect(edges, `${state} boundary must match its light line fill`).toEqual(
                edges.map(() => sample.fill),
            );
        }
    });
}
