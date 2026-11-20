// The HEAD CI status bar item and settle notification in a real VS Code host (Phase 13). The CI
// details come from the E2E-only fixture seam (src/e2e/ciFixture.ts), so no provider or network
// is involved; "Refresh Commit Check Badges" restarts the HEAD monitor on the seeded detail.

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
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");

const RUNNING = {
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
};

const FAILED = {
    ...RUNNING,
    complete: true,
    outcome: "failure",
    runs: [
        {
            ...RUNNING.runs[0],
            state: "failure",
            jobs: [{ ...RUNNING.runs[0].jobs[0], state: "failure" }],
        },
    ],
};

const CAPABILITIES = { ...NO_CI_CAPABILITIES, runs: true, jobs: true };

type Fixture = { detail: unknown; capabilities: Record<string, unknown> };

interface Host {
    page: Page;
    seed(fixture: Fixture): Promise<void>;
}

/** Launches VS Code on the fixture workspace, runs the body, and closes the host. */
async function withHost(
    fixtureWorkspace: FixtureWorkspaceFixture,
    testInfo: TestInfo,
    body: (host: Host) => Promise<void>,
): Promise<void> {
    const { workspace } = fixtureWorkspace;
    const settingsPath = path.join(workspace.root, ".vscode", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
        settingsPath,
        JSON.stringify({ "workbench.colorTheme": "Default Dark Modern" }),
    );
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
            // The notification is held while the window is unfocused.
            browserWindow.focus();
        });
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        const channel = new E2eControlChannelClient(fixtureWorkspace.channelDir);
        await body({
            page,
            seed: async (fixture) => {
                const seeded = await channel.request({
                    store: "memento",
                    scope: "global",
                    key: "intelligit.e2e.ciFixture",
                    operation: "seed",
                    value: fixture,
                });
                expect(seeded.ok, `CI fixture seed failed: ${seeded.ok ? "" : seeded.error}`).toBe(
                    true,
                );
            },
        });
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

/** The HEAD item: the only status bar entry with both a failed and a passed count. */
function headStatusItem(page: Page) {
    return page
        .locator('[id="workbench.parts.statusbar"] .statusbar-item')
        .filter({ has: page.locator(".codicon-error") })
        .filter({ has: page.locator(".codicon-check") });
}

test("status bar item opens the Checks tab", async ({ fixtureWorkspace }, testInfo) => {
    test.setTimeout(240_000);
    await withHost(fixtureWorkspace, testInfo, async ({ page, seed }) => {
        await seed({ detail: RUNNING, capabilities: CAPABILITIES });
        await new Workbench(page).runCommand("IntelliGit: Refresh Commit Check Badges");
        const item = headStatusItem(page);
        await expect(item).toBeVisible({ timeout: 30_000 });
        await page.screenshot({ path: testInfo.outputPath("ci-head-status-item.png") });

        await item.click();
        const graph = await new IntelliGitView(page).revealPanel();
        await expect(graph.getByTestId("checks-tab").getByTestId("ci-header")).toBeVisible();
    });
});

test("toast buttons appear per capability", async ({ fixtureWorkspace }, testInfo) => {
    test.setTimeout(240_000);
    await withHost(fixtureWorkspace, testInfo, async ({ page, seed }) => {
        // Logs on, re-run off: the notification offers Open log but not Re-run failed.
        const capabilities = { ...CAPABILITIES, logs: true, rerunFailed: false };
        await seed({ detail: RUNNING, capabilities });
        await new Workbench(page).runCommand("IntelliGit: Refresh Commit Check Badges");
        // Seen running first, so the hash is recorded as pending before it settles.
        await expect(headStatusItem(page)).toBeVisible({ timeout: 30_000 });
        await seed({ detail: FAILED, capabilities });

        const toast = page
            .locator(".notifications-toasts .notification-toast")
            .filter({ hasText: "CI finished for" });
        await expect(toast).toHaveCount(1, { timeout: 60_000 });
        await expect(toast).toContainText("1 failed, 0 passed");
        await expect(toast.getByRole("button", { name: "Open Checks" })).toBeVisible();
        await expect(toast.getByRole("button", { name: "Open log" })).toBeVisible();
        await expect(toast.getByRole("button", { name: "Re-run failed" })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("ci-head-settle-toast.png") });
    });
});
