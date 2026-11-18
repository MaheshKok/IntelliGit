// "Changed since last green" in a failed job's detail, in a real VS Code host (PLAN.md journey
// 10, Phase 12). The CI details come from the E2E-only fixture seam (src/e2e/ciFixture.ts): the
// head commit's job failed and its first parent's passed, so no provider or network is
// involved; the Git walk, the name-status diff and the two-revision diff editor are real.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "./fixtureWorkspace";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import { runGit } from "../fixtures/repo/gitRun";
import { FIXTURE_REFS } from "../fixtures/repo/seed";
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
const FILE = "ci-changed.txt";
const LOGICAL_ID = "job\0CI\0unit-tests";

const DETAIL_BASE = {
    provider: "github",
    complete: true,
    runsCoverage: "full",
    otherChecksCoverage: "full",
};

/** The head commit: the "unit-tests" job of the "CI" workflow failed. */
const FAILED = {
    ...DETAIL_BASE,
    outcome: "failure",
    runs: [
        {
            id: "701",
            name: "CI",
            state: "failure",
            jobs: [
                {
                    id: "801",
                    logicalId: LOGICAL_ID,
                    name: "unit-tests",
                    checkName: "unit-tests",
                    state: "failure",
                    steps: [],
                },
            ],
            jobsCoverage: "full",
        },
    ],
    otherChecks: [],
};

/** The first parent: the same job's check run passed. */
const PASSED = {
    ...DETAIL_BASE,
    outcome: "success",
    runs: [],
    otherChecks: [
        {
            id: "901",
            logicalId: LOGICAL_ID,
            name: "unit-tests",
            description: "",
            state: "success",
            source: "check-run",
        },
    ],
};

test.use({ scenario: "clean" });

test("clicking a file opens a two-revision diff", async ({ fixtureWorkspace }, testInfo) => {
    test.setTimeout(240_000);
    const { workspace } = fixtureWorkspace;
    const git = (args: string[]) => runGit(workspace.root, args, workspace.env);
    await writeFile(path.join(workspace.root, FILE), "passing version\n");
    await git(["add", "--", FILE]);
    await git(["commit", "-m", "CI passes"]);
    const green = await git(["rev-parse", "HEAD"]);
    await writeFile(path.join(workspace.root, FILE), "failing version\n");
    await git(["add", "--", FILE]);
    await git(["commit", "-m", "CI fails"]);
    const head = await git(["rev-parse", "HEAD"]);
    // The Git Log gives an unpushed commit no checks button (CI never ran on it), so push both.
    await git(["push", "--quiet", FIXTURE_REFS.remote, FIXTURE_REFS.main]);

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
        await hostWindow.evaluate((browserWindow) => browserWindow.setContentSize(1600, 900));
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        const seeded = await new E2eControlChannelClient(fixtureWorkspace.channelDir).request({
            store: "memento",
            scope: "global",
            key: "intelligit.e2e.ciFixture",
            operation: "seed",
            value: {
                detail: FAILED,
                details: { [green]: PASSED },
                capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true },
            },
        });
        expect(seeded.ok, `CI fixture seed failed: ${seeded.ok ? "" : seeded.error}`).toBe(true);
        await new Workbench(page).runCommand("IntelliGit: Show Git Log");
        const graph = await new IntelliGitView(page).revealPanel();
        await expect(graph.getByTestId("commit-info-pane")).toHaveAttribute(
            "data-pane-state",
            "detail",
        );
        await graph.getByTestId(`commit-checks-button-${head}`).click();
        await graph.getByRole("button", { name: "Open in Checks" }).click();
        await new Workbench(page).runCommand("View: Toggle Maximized Panel");
        const tab = graph.getByTestId("checks-tab");

        // The failed job is selected; its first parent is the last commit where it passed.
        const changed = tab.getByTestId("ci-changed-since-green");
        await expect(changed).toContainText(`Changed since last green (${green.slice(0, 7)})`);
        await changed.getByTestId("ci-changed-file").filter({ hasText: FILE }).click();

        const title = `${FILE} (${green.slice(0, 8)} ↔ ${head.slice(0, 8)})`;
        await expect(page.locator(".tabs-container .tab", { hasText: title })).toBeVisible();
        const diff = page.locator(".editor-group-container .monaco-diff-editor:visible").first();
        await expect(diff.locator(".editor.original .view-lines")).toContainText("passing version");
        await expect(diff.locator(".editor.modified .view-lines")).toContainText("failing version");
        await page.screenshot({ path: testInfo.outputPath("ci-changed-since-green.png") });
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
