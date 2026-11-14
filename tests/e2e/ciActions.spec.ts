// Cancel run's inline confirm in a real VS Code host. The CI detail comes from the E2E-only
// fixture seam (src/e2e/ciFixture.ts), so no provider or network is involved; the test never
// confirms, so nothing is sent.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "./fixtureWorkspace";
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

const CI_FIXTURE = {
    detail: {
        provider: "github",
        complete: false,
        outcome: "pending",
        runs: [
            {
                id: "901",
                name: "CI",
                state: "running",
                attempt: 1,
                jobs: [
                    {
                        id: "9001",
                        logicalId: "ci/unit-tests",
                        name: "unit-tests",
                        checkName: "unit-tests",
                        state: "running",
                        steps: [],
                    },
                ],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    },
    capabilities: {
        ...NO_CI_CAPABILITIES,
        runs: true,
        jobs: true,
        rerunFailed: true,
        rerunJob: true,
        cancel: true,
        writeScopeHelp: "commit.checks.tab.writeScopeHelpGithub",
    },
};

test("inline cancel confirm and Keep running", async ({ fixtureWorkspace }, testInfo) => {
    test.setTimeout(240_000);
    const { workspace } = fixtureWorkspace;
    const settingsPath = path.join(workspace.root, ".vscode", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
        settingsPath,
        JSON.stringify({ "workbench.colorTheme": "Default Dark Modern" }),
    );
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
        // The default selection can land on a stash row, so open the head commit's checks.
        await graph.getByTestId(`commit-checks-button-${head}`).click();
        await graph.getByRole("button", { name: "Open in Checks" }).click();
        await new Workbench(page).runCommand("View: Toggle Maximized Panel");
        const header = graph.getByTestId("checks-tab").getByTestId("ci-header");

        await header.getByRole("button", { name: "Cancel run" }).click();
        await expect(header.getByRole("button", { name: "Confirm cancel" })).toBeVisible();
        await expect(header.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("ci-cancel-confirm.png") });

        await header.getByRole("button", { name: "Keep running" }).click();
        await expect(header.getByRole("button", { name: "Confirm cancel" })).toHaveCount(0);
        await expect(header.getByRole("button", { name: "Cancel run" })).toBeVisible();
        await expect(graph.getByTestId("ci-action-fence")).toHaveCount(0);
        await expect(graph.getByTestId("ci-action-alert")).toHaveCount(0);
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
