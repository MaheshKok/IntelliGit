// Checks tab in a real VS Code host. CI data comes from the E2E-only fixture seam
// (src/e2e/ciFixture.ts): the spec seeds one CI detail through the control channel, and
// every commit reports it, so no CI provider or network is involved.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Locator, TestInfo } from "@playwright/test";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import { runGit } from "../fixtures/repo/gitRun";
import { NO_CI_CAPABILITIES } from "../../src/shared/ci/capabilities";
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

const CI_FIXTURE = {
    detail: {
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [
            {
                id: "101",
                name: "CI",
                state: "failure",
                event: "push",
                actor: "octocat",
                ref: "main",
                runNumber: 42,
                jobs: [
                    {
                        id: "201",
                        logicalId: "CI/unit-tests",
                        name: "unit-tests",
                        checkName: "unit-tests",
                        state: "failure",
                        steps: [
                            { number: 1, name: "Set up job", state: "success" },
                            { number: 2, name: "Run tests", state: "failure" },
                        ],
                    },
                    {
                        id: "202",
                        logicalId: "CI/lint",
                        name: "lint",
                        checkName: "lint",
                        state: "success",
                        steps: [{ number: 1, name: "Lint", state: "success" }],
                    },
                ],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [
            {
                name: "deploy-preview",
                description: "Preview failed",
                state: "failure",
                source: "status",
            },
        ],
        otherChecksCoverage: "full",
    },
    capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true, steps: true, runHeader: true },
};

async function withGitLog(
    fixtureWorkspace: FixtureWorkspaceFixture,
    testInfo: TestInfo,
    body: (context: {
        app: ElectronApplication;
        graph: Awaited<ReturnType<IntelliGitView["revealPanel"]>>;
        settingsPath: string;
        head: string;
    }) => Promise<void>,
): Promise<void> {
    const { workspace } = fixtureWorkspace;
    const settingsPath = path.join(workspace.root, ".vscode", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ "workbench.colorTheme": THEMES[0].id }));
    const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
    const diagnostics = new WorkbenchDiagnostics(workspace.profileDir);
    let app: ElectronApplication | undefined;
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
        await new Workbench(page).runCommand("IntelliGit: Show Git Log");
        const graph = await new IntelliGitView(page).revealPanel();
        await expect(graph.getByTestId("commit-info-pane")).toHaveAttribute(
            "data-pane-state",
            "detail",
        );
        await body({ app, graph, settingsPath, head });
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
}

test("Checks tab shows the tree in light and dark themes, narrow and wide pane", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(240_000);
    await withGitLog(fixtureWorkspace, testInfo, async ({ app, graph, settingsPath }) => {
        // Files stays the default tab.
        await expect(graph.getByRole("tab", { name: "Files" })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await graph.getByRole("tab", { name: "Checks" }).click();
        const tab = graph.getByTestId("checks-tab");
        await expect(tab.getByTestId("ci-header-run-line")).toContainText("octocat");
        await expect(tab.getByTestId("ci-job-row").filter({ hasText: "unit-tests" })).toBeVisible();
        // The failed job opens to its failing step.
        await expect(tab.getByTestId("ci-step-row").filter({ hasText: "Run tests" })).toBeVisible();
        await expect(
            tab.getByTestId("ci-check-row").filter({ hasText: "deploy-preview" }),
        ).toBeVisible();

        const page = await app.firstWindow();
        // The panel opens a few rows tall; maximized, the captures show the tree and detail.
        await new Workbench(page).runCommand("View: Toggle Maximized Panel");
        for (const theme of THEMES) {
            await writeFile(settingsPath, JSON.stringify({ "workbench.colorTheme": theme.id }));
            await expect(graph.locator("body")).toHaveAttribute(
                "data-vscode-theme-kind",
                theme.kind,
            );
            await expect(
                tab.getByTestId("ci-step-row").filter({ hasText: "Run tests" }),
            ).toBeVisible();
            await expectFrameLayout(tab);
            await page.screenshot({ path: testInfo.outputPath(`${theme.kind}.png`) });
            // A narrower window hides the details pane behind the commit list, so the narrow
            // and wide pane are set on the tab body, the box the 760 px container query reads.
            for (const bodyWidth of [740, 790]) {
                await expectFrameLayout(tab, bodyWidth);
                await tab.screenshot({
                    path: testInfo.outputPath(`${theme.kind}-tab-${bodyWidth}.png`),
                });
            }
            await expectFrameLayout(tab, null);
        }
    });
});

/**
 * Checks the Checks tab against Figma frame 2:2 (checks-tab.html `.split`): from 760 px the
 * tree is a 340 px column with the job detail beside it; below 760 px the detail sits under
 * the tree at full width.
 *
 * @param tab - The Checks tab body.
 * @param bodyWidth - Width forced on the tab body, null to restore the pane's own width,
 *   undefined to measure the current width.
 */
async function expectFrameLayout(tab: Locator, bodyWidth?: number | null): Promise<void> {
    const body = tab.locator(".intelligit-checks-body");
    if (bodyWidth !== undefined) {
        await body.evaluate((element, width) => {
            (element as HTMLElement).style.width = width === null ? "" : `${width}px`;
        }, bodyWidth);
    }
    const width = await body.evaluate((element) => element.clientWidth);
    const tree = await tab.getByRole("tree").boundingBox();
    const detail = await tab.getByTestId("ci-job-detail").boundingBox();
    expect(tree, "tree box").not.toBeNull();
    expect(detail, "job detail box").not.toBeNull();
    if (width >= 760) {
        expect(Math.round(tree!.width), `tree column at ${width} px`).toBe(340);
        expect(detail!.x, `detail beside the tree at ${width} px`).toBeGreaterThanOrEqual(
            tree!.x + tree!.width - 1,
        );
        expect(Math.abs(detail!.y - tree!.y), `same row at ${width} px`).toBeLessThan(2);
    } else {
        expect(detail!.y, `detail under the tree at ${width} px`).toBeGreaterThanOrEqual(
            tree!.y + tree!.height - 1,
        );
        expect(Math.abs(detail!.x - tree!.x), `one column at ${width} px`).toBeLessThan(2);
    }
}

test("Open in Checks from the popover", async ({ fixtureWorkspace }, testInfo) => {
    test.setTimeout(240_000);
    await withGitLog(fixtureWorkspace, testInfo, async ({ graph, head }) => {
        await graph.getByTestId(`commit-checks-button-${head}`).click();
        await graph.getByRole("button", { name: "Open in Checks" }).click();
        await expect(graph.getByRole("button", { name: "Open in Checks" })).toHaveCount(0);
        await expect(graph.getByRole("tab", { name: "Checks" })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(
            graph.getByTestId("checks-tab").getByTestId("ci-job-row").first(),
        ).toBeVisible();
    });
});
