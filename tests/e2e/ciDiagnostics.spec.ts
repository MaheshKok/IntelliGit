// HEAD's CI failure annotations in the Problems panel, in a real VS Code host (PLAN.md section 11,
// Phase 14). The CI detail and its annotations come from the E2E-only fixture seam
// (src/e2e/ciFixture.ts), so no provider or network is involved; the path check against the real
// file, the Problems panel and the editor it opens are real.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page, TestInfo } from "@playwright/test";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import { NO_CI_CAPABILITIES } from "../../src/shared/ci/capabilities";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { waitForWorkbench, WorkbenchDiagnostics } from "./hostFixtures/electronWorkbench";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE = "src/ci-annotated.ts";
const MESSAGE = "expected 2 to equal 3";

const FAILED = {
    provider: "github",
    complete: true,
    outcome: "failure",
    runs: [
        {
            id: "901",
            name: "CI",
            state: "failure",
            attempt: 1,
            jobs: [
                {
                    id: "9001",
                    logicalId: "ci/unit-tests",
                    name: "unit-tests",
                    checkName: "unit-tests",
                    state: "failure",
                    steps: [],
                    checkRunId: "5001",
                    annotationCount: 1,
                },
            ],
            jobsCoverage: "full",
        },
    ],
    runsCoverage: "full",
    otherChecks: [],
    otherChecksCoverage: "full",
};

const FIXTURE = {
    detail: FAILED,
    capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true, annotations: true },
    annotations: {
        "5001": [{ path: FILE, startLine: 2, endLine: 2, level: "failure", message: MESSAGE }],
    },
};

/** Launches VS Code on the fixture workspace, seeds the CI fixture, runs the body, and closes. */
async function withHost(
    fixtureWorkspace: FixtureWorkspaceFixture,
    testInfo: TestInfo,
    body: (page: Page) => Promise<void>,
): Promise<void> {
    const { workspace } = fixtureWorkspace;
    const settingsPath = path.join(workspace.root, ".vscode", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
        settingsPath,
        JSON.stringify({ "workbench.colorTheme": "Default Dark Modern" }),
    );
    // The annotated file exists before the host starts, so no file event restarts the monitor.
    await mkdir(path.join(workspace.root, "src"), { recursive: true });
    await writeFile(path.join(workspace.root, FILE), "const a = 1;\nexpect(a + 1).toBe(3);\n");
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
        await hostWindow.evaluate((browserWindow) => {
            browserWindow.setContentSize(1600, 900);
        });
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        const channel = new E2eControlChannelClient(fixtureWorkspace.channelDir);
        const seeded = await channel.request({
            store: "memento",
            scope: "global",
            key: "intelligit.e2e.ciFixture",
            operation: "seed",
            value: FIXTURE,
        });
        expect(seeded.ok, `CI fixture seed failed: ${seeded.ok ? "" : seeded.error}`).toBe(true);
        await body(page);
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

test("Problems lists CI annotations and clicking opens the line", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(240_000);
    await withHost(fixtureWorkspace, testInfo, async (page) => {
        const workbench = new Workbench(page);
        await workbench.runCommand("IntelliGit: Refresh Commit Check Badges");
        await workbench.runCommand("Focus Problems (Errors, Warnings, Infos)");

        const row = page.locator(".markers-panel .monaco-list-row").filter({ hasText: MESSAGE });
        await expect(row).toHaveCount(1, { timeout: 60_000 });
        await expect(row).toContainText("CI: unit-tests");
        await expect(row).toContainText("Ln 2");
        await page.screenshot({ path: testInfo.outputPath("ci-diagnostics-problems.png") });

        await row.click();
        await expect(
            page.locator(".tabs-container .tab").filter({ hasText: "ci-annotated.ts" }),
        ).toBeVisible();
        // The Problems entry selects its range: the whole annotated line, 22 characters long.
        await expect(page.locator('[id="status.editor.selection"]')).toContainText(
            "Ln 2, Col 23 (22 selected)",
        );
    });
});
