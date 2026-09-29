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

test("Git Log fills its webview without host body gutters at every window width", async ({
    fixtureWorkspace,
}, testInfo) => {
    const app = await launchFixtureWorkspace({
        // Allows the same rendered regression to run in an installed compatible host, e.g. Cursor.
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
        const hostWindow = await app.browserWindow(page);

        for (const hostStyle of ["installed", "legacy-unlayered"]) {
            for (const width of [1600, 1100, 640]) {
                await hostWindow.evaluate((browserWindow, nextWidth) => {
                    browserWindow.setContentSize(nextWidth, 900);
                }, width);
                await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
                // Resizing can replace the webview; reacquire and measure the same live frame.
                await expect(async () => {
                    const graph = await view.revealPanel();
                    await expect(graph.getByTestId("commit-list-viewport")).toBeVisible();
                    if (hostStyle === "legacy-unlayered") {
                        // Cursor injects these defaults without a cascade layer. Reapply them
                        // to replacement frames without accumulating styles during retries.
                        await graph.locator("head").evaluate((head) => {
                            if (head.querySelector("#git-log-layout-legacy-defaults")) return;
                            const defaults = document.createElement("style");
                            defaults.id = "git-log-layout-legacy-defaults";
                            defaults.textContent = "body { margin: 0; padding: 0 20px; }";
                            head.prepend(defaults);
                        });
                    }
                    const bounds = await graph.locator("#root").evaluate((root) => {
                        const rect = root.getBoundingClientRect();
                        const body = getComputedStyle(document.body);
                        return {
                            left: rect.left,
                            rightGap: document.documentElement.clientWidth - rect.right,
                            paddingLeft: body.paddingLeft,
                            paddingRight: body.paddingRight,
                        };
                    });
                    expect(
                        bounds,
                        `Git Log must meet both webview edges (${hostStyle}, ${width}px)`,
                    ).toEqual({
                        left: 0,
                        rightGap: 0,
                        paddingLeft: "0px",
                        paddingRight: "0px",
                    });
                }).toPass({ timeout: 30_000, intervals: [250] });
                const screenshotPath = testInfo.outputPath(`git-log-${hostStyle}-${width}.png`);
                await page.screenshot({ path: screenshotPath });
                await testInfo.attach(`git-log-${hostStyle}-${width}`, {
                    path: screenshotPath,
                    contentType: "image/png",
                });
            }
        }
    } finally {
        await app.close();
    }
});
