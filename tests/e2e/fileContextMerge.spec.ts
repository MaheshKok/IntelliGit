import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "clean" });

/** Runs Git using the disposable workspace's isolated author and configuration environment. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

/** Invokes Merge from the real Explorer submenu and waits for its native branch picker. */
async function openMerge(page: Page, selectedPath: string): Promise<void> {
    await page.getByRole("treeitem").filter({ hasText: selectedPath }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
    await page.keyboard.press("ArrowRight");
    const action = page.getByRole("menuitem", { name: /^Merge(?:\.\.\.|…)/ });
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
    await expect(
        page.getByPlaceholder("Select a branch to merge into the current branch", { exact: true }),
    ).toBeVisible();
}

test("cancels native Merge without mutation, then merges the selected branch into the file's repository", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const selectedPath = "README.md";
    const target = runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]).trim();
    const source = "native-merge-e2e";
    runGit(workspaceRoot, gitEnv, ["checkout", "-b", source]);
    await writeFile(path.join(workspaceRoot, "merged-e2e.txt"), "Native Merge incoming content\n");
    runGit(workspaceRoot, gitEnv, ["add", "merged-e2e.txt"]);
    runGit(workspaceRoot, gitEnv, ["commit", "-m", "Native Merge incoming commit"]);
    const sourceHead = runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]);
    runGit(workspaceRoot, gitEnv, ["checkout", target]);
    const beforeHead = runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]);
    const beforeIndex = runGit(workspaceRoot, gitEnv, ["ls-files", "--stage", "-z"]);
    const beforeStatus = runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"]);
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
        await openMerge(page, selectedPath);
        await page.screenshot({ path: testInfo.outputPath("merge-native-picker.png") });
        await page.keyboard.press("Escape");
        await expect(
            page.getByPlaceholder("Select a branch to merge into the current branch", {
                exact: true,
            }),
        ).toBeHidden();
        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(runGit(workspaceRoot, gitEnv, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);
        expect(runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"])).toBe(
            beforeStatus,
        );
        await openMerge(page, selectedPath);
        await page
            .getByPlaceholder("Select a branch to merge into the current branch", { exact: true })
            .fill(source);
        await page.keyboard.press("Enter");
        await expect(
            page.getByText(`Merge ${source} into current branch?`, { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("merge-native-confirmation.png") });
        await page.getByRole("button", { name: "Merge", exact: true }).click();
        await expect
            .poll(() => runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]))
            .toBe(sourceHead);
        expect(runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]).trim()).toBe(target);
        expect(await readFile(path.join(workspaceRoot, "merged-e2e.txt"), "utf8")).toBe(
            "Native Merge incoming content\n",
        );
        expect(runGit(workspaceRoot, gitEnv, ["show", "HEAD:merged-e2e.txt"])).toBe(
            "Native Merge incoming content\n",
        );
        await expect(page.getByText(`IntelliGit: Merged ${source}`, { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("merge-native-success.png") });
    } finally {
        await app.close();
    }
});
