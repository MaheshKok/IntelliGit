import path from "node:path";
import { expect, test } from "./fixtureWorkspace";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");

test("bottom Git Log preserves its loaded document and commit details across panel tab switches", async ({
    fixtureWorkspace,
}) => {
    const app = await launchFixtureWorkspace({
        executablePath:
            process.env.INTELLIGIT_E2E_EXECUTABLE_PATH ??
            (await resolveVSCodeExecutable(REPO_ROOT)),
        repoRoot: REPO_ROOT,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    try {
        const page = await app.firstWindow();
        const hostWindow = await app.browserWindow(page);
        // Keep all three panes visible even when the host starts with an auxiliary sidebar.
        await hostWindow.evaluate((browserWindow) => browserWindow.setContentSize(1600, 900));
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        const workbench = new Workbench(page);
        const view = new IntelliGitView(page);
        await workbench.runCommand("IntelliGit: Show Git Log");
        const graph = await view.revealPanel();
        const details = graph.getByTestId("commit-info-pane");
        await expect(details).toHaveAttribute("data-pane-state", "detail");
        const commitText = await graph.getByTestId("commit-list-viewport").innerText();
        const detailText = await details.innerText();
        expect(commitText).not.toBe("");
        // This marker exists only in the live document; a reload cannot restore it from saved state.
        await graph.locator("html").evaluate((element) => {
            element.setAttribute("data-persistence-probe", "original-document");
        });

        for (let switchCount = 0; switchCount < 3; switchCount += 1) {
            await workbench.runCommand("View: Toggle Output");
            await expect(graph.getByTestId("commit-list-viewport")).toBeHidden();
            await workbench.runCommand("IntelliGit: Show Git Log");
            const returned = await view.revealPanel();
            await expect(returned.locator("html")).toHaveAttribute(
                "data-persistence-probe",
                "original-document",
            );
            await expect(returned.getByTestId("commit-list-viewport")).toHaveText(commitText, {
                useInnerText: true,
            });
            await expect(returned.getByTestId("commit-info-pane")).toHaveText(detailText, {
                useInnerText: true,
            });
        }
    } finally {
        await app.close();
    }
});
