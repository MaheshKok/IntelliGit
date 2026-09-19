import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "dirty" });

test("blames an Explorer file's unsaved editor text without changing disk", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const targetPath = "annotate-git-blame-example.ts";
    const filePath = path.join(fixtureWorkspace.workspace.root, targetPath);
    const committedText = 'export const source = "committed-disk-content";\n';
    const unsavedText = 'export const source = "unsaved-buffer-content";\n';
    const gitOptions = {
        cwd: fixtureWorkspace.workspace.root,
        env: fixtureWorkspace.workspace.env,
    };

    await writeFile(filePath, committedText);
    execFileSync("git", ["add", targetPath], gitOptions);
    execFileSync("git", ["commit", "--only", targetPath, "-m", "Seed blame example"], gitOptions);

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

        const editor = page.locator(".monaco-editor:visible").first();
        await editor.click();
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
        await page.keyboard.type(unsavedText);
        await expect(
            editor.locator(".view-line").filter({ hasText: "unsaved-buffer-content" }),
        ).toBeVisible();

        await page.getByRole("treeitem").filter({ hasText: targetPath }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        const action = page.getByRole("menuitem", { name: /^Annotate with Git Blame(?:$|\s)/ });
        await expect(action).toBeVisible();
        await action.hover();
        await page.keyboard.press("Enter");

        const blameLines = page.locator(".monaco-editor:visible .view-line");
        await expect(blameLines.filter({ hasText: "unsaved-buffer-content" }).last()).toBeVisible();
        expect(await readFile(filePath, "utf8")).toBe(committedText);
    } finally {
        await app.close();
    }
});
