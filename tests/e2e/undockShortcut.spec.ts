import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "./fixtureWorkspace";
import { launchFixtureWorkspace } from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");

for (const iconStyle of ["color", "standard"]) {
    test(`the moved Graph keeps its full-workbench shortcut (${iconStyle})`, async ({
        fixtureWorkspace,
    }, testInfo) => {
        const settingsDir = path.join(fixtureWorkspace.workspace.root, ".vscode");
        const settingsPath = path.join(settingsDir, "settings.json");
        await mkdir(settingsDir, { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ "intelligit.icons": iconStyle }));
        const electronApp = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace: fixtureWorkspace.workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const window = await electronApp.firstWindow();
            await window.waitForLoadState("domcontentloaded");
            const workbench = new Workbench(window);
            const shortcut = window.getByRole("button", { name: "Undock...", exact: true });
            await workbench.runCommand("IntelliGit: Show Git Log");
            await expect(shortcut).toBeVisible();
            await workbench.runCommand("View: Move View");
            // VS Code groups these identically named views under Source Control, then IntelliGit.
            // Assert that pinned host contract before selecting the IntelliGit entry.
            const graphViews = window.getByRole("option", { name: "Graph", exact: true });
            await expect(graphViews).toHaveCount(2);
            await graphViews.nth(1).click();
            await window.getByRole("option", { name: /^New Panel Entry/ }).click();
            const modifier = process.platform === "darwin" ? "Meta" : "Control";
            await window.keyboard.press(`${modifier}+j`);
            await window.keyboard.press(`${modifier}+j`);
            await window.screenshot({ path: testInfo.outputPath("moved-graph.png") });
            await expect(
                shortcut,
                "moved IntelliGit Graph must retain the full-workbench shortcut",
            ).toBeVisible();
            await writeFile(
                settingsPath,
                JSON.stringify({
                    "intelligit.icons": iconStyle,
                    "intelligit.undockableWindowButtonVisability": false,
                }),
            );
            await expect(shortcut).toHaveCount(0);
            await writeFile(settingsPath, JSON.stringify({ "intelligit.icons": iconStyle }));
            await expect(shortcut).toBeVisible();
            await shortcut.focus();
            await expect(shortcut).toBeFocused();
            await window.keyboard.press("Enter");
            await window.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
            await expect(window.getByRole("tab", { name: /IntelliGit — workspace/ })).toBeVisible();
            // A tab title alone can pass while its webview is still blank.
            await expect
                .poll(
                    async () => {
                        const visible = await Promise.all(
                            window.frames().map((frame) =>
                                frame
                                    .getByTestId("undocked-graph-section")
                                    .isVisible()
                                    .catch(() => false),
                            ),
                        );
                        return visible.some(Boolean);
                    },
                    { timeout: 30_000 },
                )
                .toBe(true);
            await window.screenshot({ path: testInfo.outputPath("opened-workbench.png") });
        } finally {
            await electronApp.close();
        }
    });
}
