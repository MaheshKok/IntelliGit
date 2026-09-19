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

test.use({ scenario: "dirty" });

test("opens an Explorer file's immutable HEAD revision", async ({ fixtureWorkspace }) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const targetPath = "show-current-revision-example.ts";
    const filePath = path.join(fixtureWorkspace.workspace.root, targetPath);
    const gitOptions = {
        cwd: fixtureWorkspace.workspace.root,
        env: fixtureWorkspace.workspace.env,
    };

    await writeFile(filePath, 'export const source = "committed-head-content";\n');
    execFileSync("git", ["add", targetPath], gitOptions);
    execFileSync(
        "git",
        ["commit", "--only", targetPath, "-m", "Seed current revision example"],
        gitOptions,
    );
    await writeFile(filePath, 'export const source = "differing-working-content";\n');

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
        const action = page.getByRole("menuitem", { name: /^Show Current Revision(?:$|\s)/ });
        await expect(action).toBeVisible();
        await action.hover();
        await page.keyboard.press("Enter");

        const currentLines = page.locator(".monaco-editor:visible .view-line");
        await expect(
            currentLines.filter({ hasText: "committed-head-content" }).last(),
        ).toBeVisible();
        await expect(currentLines.filter({ hasText: "differing-working-content" })).toHaveCount(0);
    } finally {
        await app.close();
    }
});
