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

/** Runs Git in the fixture's isolated environment without altering stdout bytes. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

/** Opens the actual Explorer IntelliGit submenu and invokes its native Commit File action. */
async function openCommitFile(page: Page, selectedPath: string): Promise<void> {
    await page.getByRole("treeitem").filter({ hasText: selectedPath }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
    await page.keyboard.press("ArrowRight");
    const commitAction = page.getByRole("menuitem", { name: /^Commit File(?:\.\.\.|…)/ });
    await expect(commitAction).toBeVisible();
    await commitAction.hover();
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("Enter a commit message.", { exact: true })).toBeVisible();
}

test("cancels without mutation, then commits only the clicked file and preserves unrelated staged bytes", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const selectedPath = "README.md";
    const selectedFile = path.join(workspaceRoot, selectedPath);
    const selectedBytes = `${await readFile(selectedFile, "utf8")}\nSaved Commit File E2E change.\n`;
    const otherPath = "other-staged.txt";
    await writeFile(selectedFile, selectedBytes);
    await writeFile(path.join(workspaceRoot, otherPath), "STAGED\n");
    runGit(workspaceRoot, gitEnv, ["add", "--", otherPath]);
    await writeFile(path.join(workspaceRoot, otherPath), "WORKTREE\n");
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

        await openCommitFile(page, selectedPath);
        await expect(page.getByText("Commit File: README.md", { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("commit-file-native-prompt.png") });
        await page.keyboard.press("Escape");
        await expect(
            page.getByPlaceholder("Enter a commit message.", { exact: true }),
        ).toBeHidden();
        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(runGit(workspaceRoot, gitEnv, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);
        expect(runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"])).toBe(
            beforeStatus,
        );

        await openCommitFile(page, selectedPath);
        await page
            .getByPlaceholder("Enter a commit message.", { exact: true })
            .fill("Commit selected README");
        await page.keyboard.press("Enter");
        await expect
            .poll(() => runGit(workspaceRoot, gitEnv, ["log", "-1", "--format=%s"]).trim())
            .toBe("Commit selected README");
        expect(
            runGit(workspaceRoot, gitEnv, [
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                "HEAD",
            ]),
        ).toBe("README.md\n");
        expect(runGit(workspaceRoot, gitEnv, ["show", "HEAD:README.md"])).toBe(selectedBytes);
        expect(runGit(workspaceRoot, gitEnv, ["show", `:${otherPath}`])).toBe("STAGED\n");
        expect(await readFile(path.join(workspaceRoot, otherPath), "utf8")).toBe("WORKTREE\n");
        expect(runGit(workspaceRoot, gitEnv, ["diff", "--cached", "--name-only"])).toBe(
            `${otherPath}\n`,
        );
        await expect(
            page.getByText("IntelliGit: Committed successfully.", { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("commit-file-success.png") });
    } finally {
        await app.close();
    }
});
