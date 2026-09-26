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

/** Runs Git in the fixture's isolated environment without normalizing its output bytes. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

/** Invokes Add to VCS from the native Explorer context menu for one selected file. */
async function addToVcsFromExplorer(page: Page, selectedPath: string): Promise<void> {
    await page.getByRole("treeitem").filter({ hasText: selectedPath }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
    await page.keyboard.press("ArrowRight");
    const addAction = page.getByRole("menuitem", { name: "Add to VCS", exact: true });
    await expect(addAction).toBeVisible();
    await addAction.hover();
    await page.keyboard.press("Enter");
}

test("intent-adds only the Explorer file and preserves unrelated staged and worktree bytes", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const selectedPath = "native-add-to-vcs.txt";
    const selectedFile = path.join(workspaceRoot, selectedPath);
    const unrelatedPath = "README.md";
    const selectedBytes = "UNTRACKED CONTENT\n";
    await writeFile(selectedFile, selectedBytes);
    await writeFile(path.join(workspaceRoot, unrelatedPath), "STAGED\n");
    runGit(workspaceRoot, gitEnv, ["add", "--", unrelatedPath]);
    await writeFile(path.join(workspaceRoot, unrelatedPath), "WORKTREE\n");
    const beforeHead = runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]);
    const beforeUnrelatedIndex = runGit(workspaceRoot, gitEnv, ["show", `:${unrelatedPath}`]);

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

        await addToVcsFromExplorer(page, selectedPath);
        await expect(
            page.getByText(`IntelliGit: Added ${selectedPath} to VCS.`, { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("add-to-vcs-native-success.png") });

        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(runGit(workspaceRoot, gitEnv, ["status", "--porcelain"])).toContain(
            ` A ${selectedPath}`,
        );
        expect(runGit(workspaceRoot, gitEnv, ["diff", "--cached", "--", selectedPath])).toBe("");
        expect(runGit(workspaceRoot, gitEnv, ["show", `:${unrelatedPath}`])).toBe(
            beforeUnrelatedIndex,
        );
        expect(await readFile(selectedFile, "utf8")).toBe(selectedBytes);
        expect(await readFile(path.join(workspaceRoot, unrelatedPath), "utf8")).toBe("WORKTREE\n");
    } finally {
        await app.close();
    }
});
