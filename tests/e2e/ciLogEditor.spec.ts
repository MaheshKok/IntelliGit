// Full CI log in a read-only editor, in a real VS Code host. The CI detail and the job logs
// come from the E2E-only fixture seam (src/e2e/ciFixture.ts), so no provider or network is
// involved; the window's in-memory log store and the `intelligit-ci-log` document are real.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page, TestInfo } from "@playwright/test";
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
const JOBS = ["job-one", "job-two", "job-three", "job-four"];
/** 0-based line of each log's GitLab error marker; the editor shows it as line 31. */
const ERROR_LINE = 30;

function jobLog(name: string): string {
    const lines = Array.from({ length: 60 }, (_, index) => `${name} output ${index}`);
    lines[5] = `${name} Test Files  1 failed (1)`;
    lines[ERROR_LINE] = `ERROR: ${name} failed with exit code 1`;
    return lines.join("\n");
}

const CI_FIXTURE = {
    detail: {
        provider: "gitlab",
        complete: true,
        outcome: "failure",
        runs: [
            {
                id: "501",
                name: "pipeline",
                state: "failure",
                jobs: JOBS.map((name, index) => ({
                    id: String(601 + index),
                    logicalId: `pipeline/${name}`,
                    name,
                    checkName: name,
                    state: "failure",
                    steps: [],
                })),
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    },
    capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true, logs: true },
    logs: Object.fromEntries(JOBS.map((name, index) => [String(601 + index), jobLog(name)])),
};

async function withChecksTab(
    fixtureWorkspace: FixtureWorkspaceFixture,
    testInfo: TestInfo,
    body: (context: {
        page: Page;
        tab: ReturnType<Awaited<ReturnType<IntelliGitView["revealPanel"]>>["getByTestId"]>;
    }) => Promise<void>,
): Promise<void> {
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
        // The panel opens a few rows tall, which leaves the Checks body no room to click in.
        await new Workbench(page).runCommand("View: Toggle Maximized Panel");
        await body({ page, tab: graph.getByTestId("checks-tab") });
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

function editorText(page: Page) {
    return page.locator(".editor-group-container .monaco-editor:visible .view-lines").first();
}

function editorTab(page: Page, name: string) {
    return page.locator(".tabs-container .tab", { hasText: `${name}.log` });
}

test("Open full log opens a read-only editor at the first error line", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(240_000);
    await withChecksTab(fixtureWorkspace, testInfo, async ({ page, tab }) => {
        // The first failed job is selected and its excerpt arrives without opening an editor.
        await expect(tab.getByTestId("ci-log-excerpt")).toContainText(
            "ERROR: job-one failed with exit code 1",
        );
        await expect(editorTab(page, "job-one")).toHaveCount(0);

        await tab.getByRole("button", { name: "Open full log in editor" }).click();
        await expect(editorTab(page, "job-one")).toBeVisible();
        await expect(editorText(page)).toContainText("ERROR: job-one failed with exit code 1");
        await expect(page.locator('[id="status.editor.selection"]')).toContainText(
            `Ln ${ERROR_LINE + 1}, Col 1`,
        );

        // Typing changes nothing: the log document is read-only.
        await editorText(page).click();
        await page.keyboard.type("ZZQ");
        await expect(editorText(page)).not.toContainText("ZZQ");
        await page.screenshot({ path: testInfo.outputPath("ci-log-editor.png") });
    });
});

test("first tab keeps its text after a fourth log is opened", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(240_000);
    await withChecksTab(fixtureWorkspace, testInfo, async ({ page, tab }) => {
        // The window keeps three logs; the fourth evicts the first from the store.
        for (const [index, name] of JOBS.entries()) {
            // Opening a log in an editor restores the maximized panel, so maximize it again.
            if (index > 0) await new Workbench(page).runCommand("View: Toggle Maximized Panel");
            await tab.getByTestId("ci-job-row").filter({ hasText: name }).click();
            await expect(tab.getByTestId("ci-log-excerpt")).toContainText(`ERROR: ${name}`);
            await tab.getByRole("button", { name: "Open full log in editor" }).click();
            await expect(editorTab(page, name)).toBeVisible();
        }
        await editorTab(page, "job-one").click();
        await expect(editorText(page)).toContainText("ERROR: job-one failed with exit code 1");
        await expect(editorText(page)).not.toContainText("no longer loaded");
    });
});
