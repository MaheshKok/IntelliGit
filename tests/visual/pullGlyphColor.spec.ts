import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator } from "@playwright/test";

import type { HostFixture } from "../e2e/hostFixtures/types";
import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";
import { hostFixtureIdForProject } from "./playwright/visualHarnessUtils";

/**
 * #218: every Pull glyph wears the graph title bar's Pull color.
 *
 * The title-bar Pull is a static SVG, and VS Code picks its file by theme kind: the `dark` file on
 * dark and high-contrast dark themes, the `light` file on light and high-contrast light ones (the
 * `icon` pair of the color Pull command in package.json). The Changes tab bar's Pull and the
 * branch menu's Update mixed `--vscode-charts-orange` 70/30 with the icon foreground instead.
 * Dark Modern and Light Modern ship that token at 33% alpha, so both glyphs rendered a dim,
 * see-through brown beside the bright title-bar glyph, and the high-contrast themes, which define
 * no chart colors, drifted to a pastel.
 *
 * Only the "color" icon style shows any of this, and the harness renders "standard" unless a spec
 * asks, so no pixel baseline could see it.
 */

/** The file VS Code paints the title-bar Pull from, by `data-vscode-theme-kind`. */
const TITLE_BAR_PULL_SVG: Readonly<Record<string, string>> = {
    "vscode-dark": "git-pull-color.svg",
    "vscode-high-contrast": "git-pull-color.svg",
    "vscode-light": "git-pull-color-light.svg",
    "vscode-high-contrast-light": "git-pull-color-light.svg",
};

/**
 * The opaque RGBA the title bar paints its Pull with under this project's host theme.
 *
 * The theme kind comes from the host fixture's provenance rather than from the page, so a page
 * that lost its theme classes cannot choose its own expectation.
 */
function titleBarPullRgba(projectName: string): readonly number[] {
    const fixture = JSON.parse(
        readFileSync(
            resolve(__dirname, "fixtures/host", `${hostFixtureIdForProject(projectName)}.json`),
            "utf8",
        ),
    ) as HostFixture;
    const { themeKind } = fixture.provenance;
    const file = TITLE_BAR_PULL_SVG[themeKind];
    if (file === undefined) throw new Error(`no title-bar Pull icon for theme kind "${themeKind}"`);
    const svg = readFileSync(resolve(__dirname, "../../media/icons", file), "utf8");
    const hex = /fill="#([0-9a-f]{6})"/i.exec(svg)?.[1];
    if (hex === undefined) throw new Error(`${file} has no six-digit hex fill`);
    return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).concat(255);
}

/**
 * The RGBA a glyph's path is filled with.
 *
 * Through a canvas, as in `disabledButtonAffordance.spec.ts`: the defect's value arrives as the
 * `color(srgb ... / a)` a `color-mix()` computes to, and a string match over color functions is a
 * false pass waiting for the next one.
 */
async function glyphRgba(glyph: Locator): Promise<readonly number[]> {
    return glyph
        .locator("path")
        .first()
        .evaluate((path) => {
            // An unparseable value leaves `fillStyle` untouched, so the sentinel would be reported
            // as the glyph's color; throw instead.
            const SENTINEL = "rgba(1, 2, 3, 0.5)";
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("no 2d canvas context");
            const fill = getComputedStyle(path).fill;
            context.fillStyle = SENTINEL;
            context.fillStyle = fill;
            if (context.fillStyle === SENTINEL) throw new Error(`canvas cannot parse ${fill}`);
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data);
        });
}

test.describe("#218 Pull glyphs wear the graph title bar's Pull color", () => {
    test("the Changes tab bar's Pull", async ({ mountHarness, page }, testInfo) => {
        await mountHarness("commit-panel", {
            webviewFixture: HOST_CONTEXT_FIXTURES["commit-panel"],
            iconStyle: "color",
        });
        const pull = page.getByRole("button", { name: "Pull", exact: true }).locator("svg");

        expect(await glyphRgba(pull)).toEqual(titleBarPullRgba(testInfo.project.name));
    });

    test("the branch menu's Update", async ({ mountHarness, page }, testInfo) => {
        await mountHarness("commit-graph-card", {
            webviewFixture: HOST_CONTEXT_FIXTURES["commit-graph-card"],
            iconStyle: "color",
        });
        // The HEAD row leads the branch column and opens the current branch's menu, whose Update
        // runs the same pull as the other two Pulls (#218).
        await page.locator("button.branch-row").first().click({ button: "right" });
        const update = page.getByRole("menuitem", { name: "Update", exact: true }).locator("svg");

        expect(await glyphRgba(update)).toEqual(titleBarPullRgba(testInfo.project.name));
    });
});
