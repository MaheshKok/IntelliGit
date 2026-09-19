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

test("compares an Explorer file with an exact same-name tag in the shared diff viewer", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const targetPath = "compare-branch-tag-example.ts";
    const filePath = path.join(fixtureWorkspace.workspace.root, targetPath);
    const sharedName = "same-name-ref";
    const gitOptions = {
        cwd: fixtureWorkspace.workspace.root,
        env: fixtureWorkspace.workspace.env,
    };

    await writeFile(filePath, 'export const source = "tag-target";\n');
    execFileSync("git", ["add", targetPath], gitOptions);
    execFileSync("git", ["commit", "--only", targetPath, "-m", "Seed tag target"], gitOptions);
    execFileSync("git", ["tag", sharedName], gitOptions);
    await writeFile(filePath, 'export const source = "branch-target";\n');
    execFileSync("git", ["commit", "--only", targetPath, "-m", "Seed branch target"], gitOptions);
    execFileSync("git", ["branch", sharedName], gitOptions);
    await writeFile(filePath, 'export const source = "working-tree";\n');

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
        const compareAction = page.getByRole("menuitem", {
            name: /^Compare with Branch or Tag(?:$|\s)/,
        });
        await expect(compareAction).toBeVisible();
        await compareAction.hover();
        await page.keyboard.press("Enter");

        const tag = page
            .getByRole("option")
            .filter({ hasText: sharedName })
            .filter({ hasText: "tag" });
        await expect(tag).toBeVisible();
        await tag.click();

        const diffFrame = await new IntelliGitView(page).revealDiffViewer();
        await expect(diffFrame.getByTestId("diff-pane-left")).toContainText("tag-target");
        await expect(diffFrame.getByTestId("diff-pane-left")).not.toContainText("branch-target");
        await expect(diffFrame.getByTestId("diff-pane-right")).toContainText("working-tree");
    } finally {
        await app.close();
    }
});
