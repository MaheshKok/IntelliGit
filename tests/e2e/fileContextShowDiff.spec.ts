import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";

test.use({ scenario: "dirty" });

test("shows an Explorer file diff from HEAD to its working document", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const targetPath = "show-diff-example.ts";
    const filePath = path.join(fixtureWorkspace.workspace.root, targetPath);
    const gitOptions = {
        cwd: fixtureWorkspace.workspace.root,
        env: fixtureWorkspace.workspace.env,
    };

    await writeFile(filePath, "export const revision = 1;\n");
    execFileSync("git", ["add", targetPath], gitOptions);
    execFileSync(
        "git",
        ["commit", "--only", targetPath, "-m", "Seed Show Diff example"],
        gitOptions,
    );
    await writeFile(filePath, "export const revision = 2;\n");

    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(repoRoot),
        repoRoot,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);

        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+P`);
        const input = page.locator(".quick-input-widget .quick-input-box input").first();
        await expect(input).toBeVisible();
        await input.fill(targetPath);
        await page.getByRole("option").filter({ hasText: targetPath }).first().click();
        await expect(input).toBeHidden();

        await page.getByRole("treeitem").filter({ hasText: targetPath }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        const showDiffAction = page.getByRole("menuitem", { name: /^Show Diff(?:$|\s)/ });
        await expect(showDiffAction).toBeVisible();
        await showDiffAction.hover();
        await page.keyboard.press("Enter");

        const diffFrame = await new IntelliGitView(page).revealDiffViewer();
        await expect(diffFrame.getByTestId("diff-pane-left")).toContainText("revision = 1");
        await expect(diffFrame.getByTestId("diff-pane-right")).toContainText("revision = 2");
    } finally {
        await app.close();
    }
});
