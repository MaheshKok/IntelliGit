import path from "node:path";
import type { ElectronApplication, FrameLocator, Page } from "@playwright/test";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Row gestures belong to the list, not the document. A browser's default shift-click
 * extends the text selection from the previous click, and a double-click selects the word
 * under the pointer; both painted list text as if it were a text document. The rows must
 * keep their own selection state while the document selection stays empty.
 */
async function launchGraph(
    fixtureWorkspace: FixtureWorkspaceFixture,
): Promise<{ app: ElectronApplication; page: Page; graph: FrameLocator }> {
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
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        const workbench = new Workbench(page);
        const view = new IntelliGitView(page);
        await workbench.runCommand("IntelliGit: Show Git Log");
        const graph = await view.revealPanel();
        return { app, page, graph };
    } catch (error) {
        // The callers only start their own try/finally after this helper returns, so a setup
        // failure here must release the app itself and still surface the original error.
        await app.close().catch(() => undefined);
        throw error;
    }
}

function selectedText(graph: FrameLocator): Promise<string> {
    return graph.locator("body").evaluate(() => window.getSelection()?.toString() ?? "");
}

test("shift-clicking commit rows selects rows without selecting their text", async ({
    fixtureWorkspace,
}, testInfo) => {
    const { app, page, graph } = await launchGraph(fixtureWorkspace);
    try {
        const rows = graph.locator(".commit-row");
        await expect(rows.nth(2)).toBeVisible({ timeout: 30_000 });
        expect(await rows.count()).toBeGreaterThanOrEqual(3);

        await rows.nth(0).click();
        await expect(rows.nth(0)).toHaveAttribute("aria-pressed", "true");
        // The host echoes the primary hash after the first click. Let that echo land before
        // the range gesture, otherwise the test races the echo instead of the range logic.
        await page.waitForTimeout(250);
        await rows.nth(2).click({ modifiers: ["Shift"] });

        const selectedRowCount = await rows.evaluateAll(
            (elements) =>
                elements.filter((element) => element.getAttribute("aria-pressed") === "true")
                    .length,
        );
        const text = await selectedText(graph);

        const screenshotPath = testInfo.outputPath("shift-click-selection.png");
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("shift-click-selection", {
            path: screenshotPath,
            contentType: "image/png",
        });

        expect(selectedRowCount, "shift-click must keep all three rows selected").toBe(3);
        expect(
            text,
            "shift-clicking rows must not select the commit text underneath the pointer",
        ).toBe("");
    } finally {
        await app.close();
    }
});

test("double-clicking a changed file opens it without selecting its name", async ({
    fixtureWorkspace,
}, testInfo) => {
    const { app, page, graph } = await launchGraph(fixtureWorkspace);
    try {
        const rows = graph.locator(".commit-row");
        // A non-merge commit opens its file diff directly; a merge commit would first ask
        // which parent to compare against, and that modal would hide the gesture under test.
        const fileCommit = rows.filter({ hasText: "Feature commit 3" }).first();
        await expect(fileCommit).toBeVisible({ timeout: 30_000 });
        await fileCommit.click();
        // The host answers the selection by replacing the details pane. Let that render
        // settle before holding a locator into the file list it owns.
        await page.waitForTimeout(250);

        const fileRows = graph.getByTestId("commit-info-pane").locator('[role="treeitem"]');
        await expect(fileRows.first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(250);
        const filePath = await fileRows.first().getAttribute("title");
        expect(filePath, "the changed-file row must carry its path as a title").toBeTruthy();

        const fileLabel = fileRows
            .first()
            .getByText(path.basename(filePath ?? ""), { exact: true });
        await fileLabel.dblclick();
        const text = await selectedText(graph);

        const screenshotPath = testInfo.outputPath("file-double-click-selection.png");
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("file-double-click-selection", {
            path: screenshotPath,
            contentType: "image/png",
        });

        expect(
            text,
            `double-clicking "${filePath}" must open its diff without selecting the file name`,
        ).toBe("");
    } finally {
        await app.close();
    }
});
