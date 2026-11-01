import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import type { HostFixture } from "../e2e/hostFixtures/types";
import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";
import { hostFixtureIdForProject } from "./playwright/visualHarnessUtils";

/**
 * From VS Code 1.143, High Contrast Light ships `--vscode-charts-orange` as `#0f4a85`, the blue of
 * the minimap marker it was copied from. Tag refs and the orange toolbar accent paint that token,
 * so on that theme they wore the same blue as branch refs. There they take the light Pull glyph's
 * fill instead; every other theme keeps its own chart orange.
 */

/** Every webview that paints a tag ref or the orange accent. */
const ORANGE_CONTEXTS = [
    "commit-graph-card",
    "commit-graph-compact",
    "commit-info",
    "undocked",
    "commit-panel",
    "file-history",
] as const;

/**
 * What `--vscode-charts-orange` must resolve to inside the webview under this project's host theme.
 *
 * Read from the host fixture and the Pull SVG rather than from `tokens.ts`, so a wrong constant
 * there cannot choose its own expectation.
 */
function expectedOrange(projectName: string): string {
    const fixtureId = hostFixtureIdForProject(projectName);
    const fixture = JSON.parse(
        readFileSync(resolve(__dirname, "fixtures/host", `${fixtureId}.json`), "utf8"),
    ) as HostFixture;
    if (fixture.provenance.themeKind === "vscode-high-contrast-light") {
        const svg = readFileSync(
            resolve(__dirname, "../../media/icons/git-pull-color-light.svg"),
            "utf8",
        );
        const hex = /fill="(#[0-9a-f]{6})"/i.exec(svg)?.[1];
        if (hex === undefined)
            throw new Error("git-pull-color-light.svg has no six-digit hex fill");
        return hex.toLowerCase();
    }
    const value = /--vscode-charts-orange:\s*([^;]+);/.exec(
        fixture.documentElement.styleCssText,
    )?.[1];
    if (value === undefined) throw new Error(`${fixtureId} defines no --vscode-charts-orange`);
    return value.trim().toLowerCase();
}

/** A CSS color as the RGBA a canvas paints it, so `#b35300` and `rgb(179, 83, 0)` compare equal. */
async function rgba(page: Page, color: string): Promise<readonly number[]> {
    return page.evaluate((value) => {
        // An unparseable value leaves `fillStyle` untouched, so the sentinel would be reported
        // as the color; throw instead.
        const SENTINEL = "rgba(1, 2, 3, 0.5)";
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("no 2d canvas context");
        context.fillStyle = SENTINEL;
        context.fillStyle = value;
        if (context.fillStyle === SENTINEL) throw new Error(`canvas cannot parse ${value}`);
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
    }, color);
}

test.describe("tags and the orange accent are not branch blue in High Contrast Light", () => {
    for (const contextId of ORANGE_CONTEXTS) {
        test(`${contextId} resolves the chart orange`, async ({ mountHarness, page }, testInfo) => {
            await mountHarness(contextId, { webviewFixture: HOST_CONTEXT_FIXTURES[contextId] });

            await expect
                .poll(() =>
                    page.evaluate(() =>
                        getComputedStyle(document.getElementById("root")!)
                            .getPropertyValue("--vscode-charts-orange")
                            .trim()
                            .toLowerCase(),
                    ),
                )
                .toBe(expectedOrange(testInfo.project.name));
        });
    }

    test("the graph's tag badge paints it", async ({ mountHarness, page }, testInfo) => {
        await mountHarness("commit-graph-card", {
            webviewFixture: HOST_CONTEXT_FIXTURES["commit-graph-card"],
        });
        const glyph = page.locator('span[title="v1.0.0"] svg').first();
        const painted = await glyph.evaluate((svg) => getComputedStyle(svg).color);

        expect(await rgba(page, painted)).toEqual(
            await rgba(page, expectedOrange(testInfo.project.name)),
        );
    });
});
