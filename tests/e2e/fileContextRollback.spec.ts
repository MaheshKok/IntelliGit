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

test("rolls back one Explorer file while preserving unrelated tracked, staged-new, and untracked files", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const trackedPath = "rollback-context-example.ts";
    const otherTrackedPath = "rollback-other-modified-example.ts";
    const stagedNewPath = "rollback-staged-new-example.ts";
    const untrackedPath = "rollback-untracked-example.ts";
    const trackedFile = path.join(fixtureWorkspace.workspace.root, trackedPath);
    const otherTrackedFile = path.join(fixtureWorkspace.workspace.root, otherTrackedPath);
    const stagedNewFile = path.join(fixtureWorkspace.workspace.root, stagedNewPath);
    const untrackedFile = path.join(fixtureWorkspace.workspace.root, untrackedPath);
    const committedText = 'export const source = "committed";\n';
    const changedText = 'export const source = "changed";\n';
    const otherChangedText = 'export const source = "other-changed";\n';
    const stagedNewText = 'export const source = "staged-new";\n';
    const untrackedText = 'export const source = "untracked";\n';
    const gitOptions = {
        cwd: fixtureWorkspace.workspace.root,
        env: fixtureWorkspace.workspace.env,
    };

    await writeFile(trackedFile, committedText);
    await writeFile(otherTrackedFile, committedText);
    execFileSync("git", ["add", trackedPath, otherTrackedPath], gitOptions);
    execFileSync(
        "git",
        ["commit", "--only", trackedPath, otherTrackedPath, "-m", "Seed rollback example"],
        gitOptions,
    );
    await writeFile(trackedFile, changedText);
    await writeFile(otherTrackedFile, otherChangedText);
    await writeFile(stagedNewFile, stagedNewText);
    await writeFile(untrackedFile, untrackedText);
    execFileSync("git", ["add", stagedNewPath], gitOptions);

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

        await page
            .getByRole("treeitem")
            .filter({ hasText: stagedNewPath })
            .click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        await page.getByRole("menuitem", { name: /^Rollback(?:$|\s)/ }).hover();
        await page.keyboard.press("Enter");
        await expect(page.locator(".monaco-dialog-box")).toHaveCount(0);
        await expect.poll(async () => readFile(stagedNewFile, "utf8")).toBe(stagedNewText);
        await page.keyboard.press("Escape");

        await page
            .getByRole("treeitem")
            .filter({ hasText: trackedPath })
            .click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        await page.getByRole("menuitem", { name: /^Rollback(?:$|\s)/ }).hover();
        await page.keyboard.press("Enter");

        const dialog = page.locator(".monaco-dialog-box");
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(`Rollback ${trackedPath}?`);
        await dialog.getByRole("button", { name: "Rollback", exact: true }).click();

        await expect.poll(async () => readFile(trackedFile, "utf8")).toBe(committedText);
        await expect.poll(async () => readFile(otherTrackedFile, "utf8")).toBe(otherChangedText);
        await expect.poll(async () => readFile(stagedNewFile, "utf8")).toBe(stagedNewText);
        await expect.poll(async () => readFile(untrackedFile, "utf8")).toBe(untrackedText);
    } finally {
        await app.close();
    }
});
