// "Find where CI broke" from the Git Log's row menu, in a real VS Code host (PLAN.md journey 14,
// Phase 16). The CI results come from the E2E-only fixture seam (src/e2e/ciFixture.ts): the
// oldest selected commit passed and the two newer ones failed, so no provider or network is
// involved; the row selection, the menu, the host's bisect and the bisect view are real.

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
const FILE = "ci-bisect.txt";

/** One commit's CI: the "unit-tests" check run in the given state. */
function flatDetail(state: "success" | "failure") {
    return {
        provider: "github",
        complete: true,
        outcome: state,
        runs: [],
        runsCoverage: "full",
        otherChecks: [
            {
                id: `unit-${state}`,
                logicalId: "check\0unit-tests",
                name: "unit-tests",
                description: "",
                state,
                source: "check-run",
            },
        ],
        otherChecksCoverage: "full",
    };
}

test.use({ scenario: "clean" });

test("Find where CI broke from the row menu", async ({ fixtureWorkspace }, testInfo) => {
    test.setTimeout(240_000);
    const { workspace } = fixtureWorkspace;
    const git = (args: string[], env = workspace.env) => runGit(workspace.root, args, env);
    // The seeded history's first commit has the env's pinned date, and the Git Log lists `--all` in
    // date order, so a commit made with that same date can sort between these three rows. Each one
    // gets its own date after the newest seeded commit, so they show as three adjacent rows.
    const newest = Math.max(
        ...(await git(["log", "--all", "--format=%ct"])).split("\n").map(Number),
    );
    if (!Number.isFinite(newest))
        throw new Error("Could not read the fixture's newest commit time");
    let dated = 0;
    const commit = async (content: string, message: string): Promise<string> => {
        await writeFile(path.join(workspace.root, FILE), `${content}\n`);
        await git(["add", "--", FILE]);
        dated += 1;
        const when = `@${newest + dated * 60} +0000`;
        await git(["commit", "-m", message], {
            ...workspace.env,
            GIT_AUTHOR_DATE: when,
            GIT_COMMITTER_DATE: when,
        });
        return git(["rev-parse", "HEAD"]);
    };
    await commit("green", "bisect: CI passes");
    const breaks = await commit("red", "bisect: CI breaks");
    const head = await commit("still red", "bisect: CI still red");
    // The Git Log gives an unpushed commit no checks (CI never ran on it), so push them.
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
                // Every other commit, the oldest selected one included, passed.
                detail: flatDetail("success"),
                details: { [breaks]: flatDetail("failure"), [head]: flatDetail("failure") },
                capabilities: NO_CI_CAPABILITIES,
            },
        });
        expect(seeded.ok, `CI fixture seed failed: ${seeded.ok ? "" : seeded.error}`).toBe(true);
        await new Workbench(page).runCommand("IntelliGit: Show Git Log");
        const graph = await new IntelliGitView(page).revealPanel();
        await expect(graph.getByTestId("commit-info-pane")).toHaveAttribute(
            "data-pane-state",
            "detail",
        );
        await new Workbench(page).runCommand("View: Toggle Maximized Panel");

        const row = (message: string) => graph.locator(".commit-row", { hasText: message });
        await row("bisect: CI still red").click();
        await row("bisect: CI passes").click({ modifiers: ["Shift"] });
        await expect(row("bisect: CI breaks")).toHaveAttribute("aria-pressed", "true");
        await row("bisect: CI breaks").click({ button: "right" });
        await graph.locator(".intelligit-context-item", { hasText: "Find where CI broke" }).click();

        const bisect = graph.getByTestId("checks-tab").getByTestId("ci-bisect");
        const job = bisect.getByTestId("ci-bisect-job").filter({ hasText: "unit-tests" });
        await expect(job).toContainText(`broke at ${breaks.slice(0, 7)} · 1 commit ago`);
        await expect(job.getByTestId("ci-bisect-square")).toHaveCount(3);
        await page.screenshot({ path: testInfo.outputPath("ci-bisect.png") });

        await bisect.getByTestId("ci-bisect-close").click();
        await expect(graph.getByTestId("ci-bisect")).toHaveCount(0);
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
