// The optional CI column in a real VS Code host (PLAN.md Phase 15). CI data comes from the
// E2E-only fixture seam (src/e2e/ciFixture.ts), so no provider or network is involved, and the
// E2E control channel turns the Checks tab switch on, so the host posts the column flag.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Locator } from "@playwright/test";
import { expect, test } from "./fixtureWorkspace";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import { runGit } from "../fixtures/repo/gitRun";
import { NO_CI_CAPABILITIES } from "../../src/shared/ci/capabilities";
import {
    AUTHOR_COL_WIDTH,
    CHECKS_COL_WIDTH,
    CI_COL_WIDTH,
    DATE_COL_WIDTH,
    MESSAGE_MIN_WIDTH,
    METADATA_COLUMN_MARGIN,
    ROW_SIDE_PADDING,
} from "../../src/webviews/react/commit-list/styles";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { waitForWorkbench, WorkbenchDiagnostics } from "./hostFixtures/electronWorkbench";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");
const THEMES = [
    { id: "Default Light Modern", kind: "vscode-light" },
    { id: "Default Dark Modern", kind: "vscode-dark" },
] as const;

// Two passed checks and one failed: every commit's cell reads "2/3".
const CI_FIXTURE = {
    detail: {
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [],
        runsCoverage: "full",
        otherChecks: [
            { name: "unit-tests", description: "Passed", state: "success", source: "check-run" },
            { name: "lint", description: "Passed", state: "success", source: "check-run" },
            { name: "deploy", description: "Failed", state: "failure", source: "status" },
        ],
        otherChecksCoverage: "full",
    },
    capabilities: NO_CI_CAPABILITIES,
};

/** Workspace settings for one theme with the CI column switched on. */
function settings(themeId: string): string {
    return JSON.stringify({
        "workbench.colorTheme": themeId,
        "intelligit.commitChecks.showCiColumn": true,
    });
}

/** Forces the commit list's width, or restores its own with null. */
async function setListWidth(graph: FrameLocator, width: number | null): Promise<void> {
    await graph.getByTestId("commit-list-viewport").evaluate((viewport, nextWidth) => {
        // The viewport sits in the list's root column; its width is what the list lays out against.
        const root = viewport.parentElement!.parentElement as HTMLElement;
        root.style.flex = nextWidth === null ? "" : "none";
        root.style.width = nextWidth === null ? "" : `${nextWidth}px`;
    }, width);
}

async function box(locator: Locator, name: string) {
    const bounds = await locator.boundingBox();
    expect(bounds, `${name} box`).not.toBeNull();
    return bounds!;
}

test("column on in light and dark themes at narrow and wide pane widths keeps Author and Date visible", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(240_000);
    const { workspace } = fixtureWorkspace;
    const settingsPath = path.join(workspace.root, ".vscode", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, settings(THEMES[0].id));
    const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
    const diagnostics = new WorkbenchDiagnostics(workspace.profileDir);
    let app: Awaited<ReturnType<typeof launchFixtureWorkspace>> | undefined;
    let failed = false;
    try {
        app = await launchFixtureWorkspace({
            executablePath:
                process.env.INTELLIGIT_E2E_EXECUTABLE_PATH ??
                (await resolveVSCodeExecutable(REPO_ROOT)),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        diagnostics.observe(app);
        const page = await waitForWorkbench(app);
        const hostWindow = await app.browserWindow(page);
        await hostWindow.evaluate((browserWindow) => browserWindow.setContentSize(1600, 900));
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        const seeded = await new E2eControlChannelClient(fixtureWorkspace.channelDir).request({
            store: "memento",
            scope: "global",
            key: "intelligit.e2e.ciFixture",
            operation: "seed",
            value: CI_FIXTURE,
        });
        expect(seeded.ok, `CI fixture seed failed: ${seeded.ok ? "" : seeded.error}`).toBe(true);
        const workbench = new Workbench(page);
        await workbench.runCommand("IntelliGit: Show Git Log");
        const graph = await new IntelliGitView(page).revealPanel();
        await workbench.runCommand("View: Toggle Maximized Panel");

        const ciHeader = graph.getByTestId("commit-ci-header");
        const ciCell = graph.getByTestId(`commit-ci-cell-${head}`);
        const author = graph.getByTestId("commit-column-resize-author");
        const date = graph.getByTestId("commit-column-resize-date");
        const badge = graph.getByTestId(`commit-checks-button-${head}`);

        for (const theme of THEMES) {
            await writeFile(settingsPath, settings(theme.id));
            await expect(graph.locator("body")).toHaveAttribute(
                "data-vscode-theme-kind",
                theme.kind,
            );

            // Wide: the CI column sits between the subject and Author, at the Figma width.
            await setListWidth(graph, null);
            await expect(ciCell).toHaveText("2/3");
            await expect(ciHeader).toBeVisible();
            await expect(author).toBeVisible();
            await expect(date).toBeVisible();
            await expect(badge, "one checks control per row").toHaveCount(0);
            const cell = await box(ciCell, "CI cell");
            expect(Math.round(cell.width), "CI column width (Figma frame 1:2)").toBe(99);
            // The bar's colours resolve from the theme, so read them where the theme is applied.
            const paint = (state: string) =>
                graph
                    .getByTestId(`commit-ci-bar-${state}`)
                    .first()
                    .evaluate((segment) => getComputedStyle(segment).backgroundColor);
            const passedPaint = await paint("success");
            const failedPaint = await paint("failure");
            for (const [state, color] of [
                ["success", passedPaint],
                ["failure", failedPaint],
            ]) {
                expect(color, `${theme.kind} ${state} segment is painted`).not.toMatch(
                    /^(transparent|rgba\(0, 0, 0, 0\))$/,
                );
            }
            expect(
                failedPaint,
                `${theme.kind}: a failed check is not painted like a passed one`,
            ).not.toBe(passedPaint);
            expect(
                Math.abs((await box(ciHeader, "CI header")).x - cell.x),
                "header over cells",
            ).toBeLessThan(2);
            expect(cell.x, "CI column left of Author").toBeLessThan(
                (await box(author, "Author")).x,
            );
            expect(cell.x + cell.width, "CI column left of Date").toBeLessThanOrEqual(
                (await box(date, "Date")).x,
            );
            await page.screenshot({ path: testInfo.outputPath(`${theme.kind}-wide.png`) });

            // Narrow: wide enough for Author and Date beside the old badge, too narrow to add the
            // CI column as well. The graph width is read from the rendered row.
            const graphWidth = await graph
                .locator(".commit-row")
                .first()
                .evaluate((row) => parseFloat(getComputedStyle(row).marginLeft));
            const badgeLayout =
                MESSAGE_MIN_WIDTH +
                CHECKS_COL_WIDTH +
                METADATA_COLUMN_MARGIN +
                AUTHOR_COL_WIDTH +
                METADATA_COLUMN_MARGIN +
                DATE_COL_WIDTH +
                METADATA_COLUMN_MARGIN;
            const gap = CI_COL_WIDTH - CHECKS_COL_WIDTH;
            const narrow = Math.round(graphWidth + ROW_SIDE_PADDING + 2 + badgeLayout + gap / 2);
            await setListWidth(graph, narrow);
            await expect(ciCell, `the CI column gives way at ${narrow} px`).toHaveCount(0);
            await expect(ciHeader).toHaveCount(0);
            await expect(author, `Author stays at ${narrow} px`).toBeVisible();
            await expect(date, `Date stays at ${narrow} px`).toBeVisible();
            await expect(badge, "the old badge returns while the column is dropped").toBeVisible();
            await page.screenshot({ path: testInfo.outputPath(`${theme.kind}-narrow.png`) });
        }
    } catch (error) {
        failed = true;
        await diagnostics.attach(testInfo);
        throw error;
    } finally {
        diagnostics.dispose();
        try {
            await app?.close();
        } catch (closeError) {
            // A teardown error must not hide the failure that caused it.
            if (!failed) throw closeError;
            console.warn("Electron cleanup after test failure:", closeError);
        }
    }
});
