import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { expect, test } from "./fixtureWorkspace";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "dirty" });
test("opens file history in a separate window with the shared diff viewer", async ({
    fixtureWorkspace,
}, testInfo) => {
    const repoRoot = path.resolve(__dirname, "../..");
    const historyPath = "history-example.ts";
    for (let revision = 1; revision <= 8; revision++) {
        await writeFile(
            path.join(fixtureWorkspace.workspace.root, historyPath),
            `export const revision = ${revision};\n`,
        );
        const gitOptions = {
            cwd: fixtureWorkspace.workspace.root,
            env: fixtureWorkspace.workspace.env,
        };
        execFileSync("git", ["add", historyPath], gitOptions);
        execFileSync(
            "git",
            ["commit", "--only", historyPath, "-m", `Update history example ${revision}`],
            gitOptions,
        );
        if (revision === 4) execFileSync("git", ["tag", "v1.0-history"], gitOptions);
    }
    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(repoRoot),
        repoRoot,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    try {
        // Keep context menus in the renderer so Playwright can exercise hover on macOS too.
        const settingsPath = path.join(
            fixtureWorkspace.workspace.profileDir,
            "User",
            "settings.json",
        );
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        await writeFile(
            settingsPath,
            JSON.stringify({ ...settings, "window.menuStyle": "custom" }),
        );
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+P`);
        const input = page.locator(".quick-input-widget .quick-input-box input").first();
        await expect(input).toBeVisible();
        await input.fill(historyPath);
        await page.getByRole("option").filter({ hasText: historyPath }).first().click();
        await expect(input).toBeHidden();
        await page
            .getByRole("treeitem")
            .filter({ hasText: historyPath })
            .click({ button: "right" });
        await expect(
            page.getByRole("menuitem", { name: "Show File History", exact: true }),
        ).toHaveCount(0);
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        await expect(
            page.getByRole("menuitem", { name: "Show File History", exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("file-history-context-menu.png") });
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await page.locator(".tab.active").click({ button: "right" });
        await expect(
            page.getByRole("menuitem", { name: "Show File History", exact: true }),
        ).toHaveCount(0);
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        const historyAction = page.getByRole("menuitem", {
            name: "Show File History",
            exact: true,
        });
        await expect(historyAction).toBeVisible();
        const nextWindow = app.waitForEvent("window", { timeout: 30_000 });
        await historyAction.click();
        const historyWindow = await nextWindow.catch(async (error) => {
            await page.screenshot({ path: testInfo.outputPath("history-open-failure.png") });
            console.log(
                "History notifications:",
                await page.locator(".notifications-toasts").textContent(),
            );
            console.log(
                "History windows:",
                await app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows().map(
                        (window: { getTitle(): string; webContents: { getURL(): string } }) => ({
                            title: window.getTitle(),
                            url: window.webContents.getURL(),
                        }),
                    ),
                ),
            );
            console.log(
                "History pages:",
                app
                    .context()
                    .pages()
                    .map((page) => page.url()),
            );
            throw error;
        });
        await historyWindow.waitForLoadState("domcontentloaded");
        const frame = historyWindow
            .locator("iframe.webview")
            .first()
            .contentFrame()
            .locator("iframe#active-frame")
            .contentFrame();
        await expect(frame.locator(".file-history")).toBeVisible({ timeout: 30_000 });
        const rows = frame.getByRole("listbox").getByRole("option");
        await expect(rows).toHaveCount(8);
        await expect(frame.locator(".file-history-columns")).toHaveCount(0);
        await expect(frame.locator(".file-history-details")).toHaveCount(0);
        await expect(frame.getByText("v1.0-history", { exact: true })).toBeVisible();
        await expect(frame.locator('[data-testid="diff-viewer-root"]')).toBeVisible();
        await expect(frame.locator(".code-lines").first()).toBeVisible();
        await rows.nth(1).click();
        await expect(frame.getByTestId("diff-pane-right")).toContainText("revision = 7");
        await frame.getByRole("button", { name: "Show Details", exact: true }).click();
        await expect(frame.locator(".file-history-details")).toContainText(
            "Update history example 7",
        );
        await frame.getByRole("button", { name: "Show Details", exact: true }).click();
        const divider = frame.getByRole("separator", { name: "Resize history list" });
        await divider.focus();
        await historyWindow.keyboard.press("ArrowRight");
        await expect(divider).toHaveAttribute("aria-valuenow", "43");
        await historyWindow.keyboard.press("ArrowLeft");
        await expect(divider).toHaveAttribute("aria-valuenow", "41");
        await historyWindow.screenshot({
            path: testInfo.outputPath("file-history.png"),
            fullPage: true,
        });
    } finally {
        // Auxiliary VS Code windows can hold graceful context shutdown open after assertions.
        // Terminate only this isolated test host before disposing its Playwright connection.
        app.process().kill("SIGTERM");
        await app.close();
    }
});
