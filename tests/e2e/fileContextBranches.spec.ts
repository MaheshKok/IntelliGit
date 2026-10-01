import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** Reads or changes only disposable fixture Git state using its isolated configuration. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

/** Opens the native Branches picker from an already open IntelliGit file submenu. */
async function chooseBranches(page: Page): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await parent.click();
    const action = page.getByRole("menuitem", { name: /^Branches(?:\.\.\.|…)/ });
    if (!(await action.count())) {
        await parent.hover();
        await page.keyboard.press("ArrowRight");
    }
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
    await expect(
        page.getByPlaceholder("Select a branch to check out", { exact: true }),
    ).toBeVisible();
}

test("shows Branches in three native menus and cancels without Git mutation before checkout", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const current = runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]).trim();
    const selected = "native-branches-e2e";
    runGit(workspaceRoot, gitEnv, ["branch", selected]);
    const beforeHead = runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]);
    const beforeIndex = runGit(workspaceRoot, gitEnv, ["ls-files", "--stage", "-z"]);
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
            .filter({ hasText: "README.md" })
            .click({ button: "right" });
        await chooseBranches(page);
        await page.screenshot({ path: testInfo.outputPath("branches-explorer-picker.png") });
        await page.keyboard.press("Escape");
        expect(runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]).trim()).toBe(current);
        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(runGit(workspaceRoot, gitEnv, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);

        await page
            .getByRole("treeitem")
            .filter({ hasText: "README.md" })
            .click({ button: "right" });
        await chooseBranches(page);
        await page.getByPlaceholder("Select a branch to check out", { exact: true }).fill(selected);
        await page.keyboard.press("Enter");
        await expect
            .poll(() => runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]).trim())
            .toBe(selected);
        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(beforeHead);
        await page.screenshot({ path: testInfo.outputPath("branches-explorer-checked-out.png") });

        await page.getByRole("treeitem").filter({ hasText: "README.md" }).dblclick();
        await page.getByRole("tab", { name: /README\.md/ }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).click();
        const branchMenuItem = page.getByRole("menuitem", { name: /^Branches(?:\.\.\.|…)/ });
        await expect(branchMenuItem).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("branches-tab-menu.png") });
        // Move off the parent so its hover cannot reopen the submenu after Escape.
        await branchMenuItem.hover();
        await branchMenuItem.press("Escape");
        await expect(branchMenuItem).toBeHidden();
        await expect(page.getByRole("menuitem", { name: "IntelliGit", exact: true })).toBeVisible();
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).press("Escape");
        await expect(page.getByRole("menuitem", { name: "IntelliGit", exact: true })).toBeHidden();

        await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: /^Branches(?:\.\.\.|…)/ })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("branches-editor-menu.png") });
    } finally {
        await app.close();
    }
});

test("checks out the clicked nested repository while the outer repository stays on its branch", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-branches-b");
    await mkdir(b);
    runGit(b, gitEnv, ["init", "-b", "main"]);
    runGit(b, gitEnv, ["config", "user.name", "Native Branches Test"]);
    runGit(b, gitEnv, ["config", "user.email", "native-branches@example.invalid"]);
    await writeFile(path.join(b, "selected.txt"), "B main\n");
    runGit(b, gitEnv, ["add", "selected.txt"]);
    runGit(b, gitEnv, ["commit", "-m", "B main"]);
    runGit(b, gitEnv, ["branch", "feature"]);
    runGit(b, gitEnv, ["checkout", "-b", "remote-target"]);
    await writeFile(path.join(b, "selected.txt"), "B remote\n");
    runGit(b, gitEnv, ["commit", "-am", "B remote"]);
    const remote = path.join(a, "native-branches-remote.git");
    runGit(a, gitEnv, ["init", "--bare", remote]);
    runGit(b, gitEnv, ["remote", "add", "origin", remote]);
    runGit(b, gitEnv, ["push", "origin", "remote-target"]);
    runGit(b, gitEnv, ["checkout", "-b", "remote-conflict", "main"]);
    await writeFile(path.join(b, "selected.txt"), "B conflict\n");
    runGit(b, gitEnv, ["commit", "-am", "B conflict"]);
    runGit(b, gitEnv, ["push", "origin", "remote-conflict"]);
    runGit(b, gitEnv, ["checkout", "main"]);
    runGit(b, gitEnv, ["branch", "-D", "remote-target"]);
    runGit(b, gitEnv, ["branch", "-D", "remote-conflict"]);
    await writeFile(path.join(b, "selected.txt"), "B compatible dirty\n");
    const aRoot = runGit(a, gitEnv, ["rev-parse", "--show-toplevel"]).trim();
    const bRoot = runGit(b, gitEnv, ["rev-parse", "--show-toplevel"]).trim();
    const aBranch = runGit(a, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim();
    const aHead = runGit(a, gitEnv, ["rev-parse", "HEAD"]);
    const aIndex = runGit(a, gitEnv, ["ls-files", "--stage", "-z"]);
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
        await page.getByRole("treeitem").filter({ hasText: "native-branches-b" }).click();
        await page
            .locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]')
            .click({ button: "right" });
        await chooseBranches(page);
        await expect(page.getByPlaceholder("Select a branch to check out")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("branches-b-picker.png") });
        await page
            .getByPlaceholder("Select a branch to check out", { exact: true })
            .fill("feature");
        await page.keyboard.press("Enter");
        await expect
            .poll(() => runGit(bRoot, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim())
            .toBe("feature");
        expect(runGit(aRoot, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(aBranch);
        expect(runGit(aRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(runGit(aRoot, gitEnv, ["ls-files", "--stage", "-z"])).toBe(aIndex);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B compatible dirty\n");
        await page.screenshot({ path: testInfo.outputPath("branches-b-checked-out.png") });

        await writeFile(path.join(b, "selected.txt"), "B main\n");
        await page
            .locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]')
            .click({ button: "right" });
        await chooseBranches(page);
        await page
            .getByPlaceholder("Select a branch to check out", { exact: true })
            .fill("origin/remote-target");
        await page.keyboard.press("Enter");
        await expect
            .poll(() => runGit(bRoot, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim())
            .toBe("remote-target");
        expect(
            runGit(bRoot, gitEnv, [
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ]).trim(),
        ).toBe("origin/remote-target");
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B remote\n");

        await writeFile(path.join(b, "selected.txt"), "B dirty\n");
        await page
            .locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]')
            .click({ button: "right" });
        await chooseBranches(page);
        await page
            .getByPlaceholder("Select a branch to check out", { exact: true })
            .fill("origin/remote-conflict");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: /Checkout failed:/ })).toBeVisible();
        expect(runGit(bRoot, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(
            "remote-target",
        );
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B dirty\n");
        expect(runGit(aRoot, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(aBranch);
        expect(runGit(aRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(runGit(aRoot, gitEnv, ["ls-files", "--stage", "-z"])).toBe(aIndex);
    } finally {
        await app.close();
    }
});

test("offers the selected repository's linked worktree and leaves both checkouts unchanged on cancellation", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-branches-worktree-b");
    const linked = path.join(a, "native-branches-linked");
    await mkdir(b);
    runGit(b, gitEnv, ["init", "-b", "main"]);
    runGit(b, gitEnv, ["config", "user.name", "Native Branches Test"]);
    runGit(b, gitEnv, ["config", "user.email", "native-branches@example.invalid"]);
    await writeFile(path.join(b, "selected.txt"), "B main\n");
    runGit(b, gitEnv, ["add", "selected.txt"]);
    runGit(b, gitEnv, ["commit", "-m", "B main"]);
    runGit(b, gitEnv, ["worktree", "add", "-b", "linked", linked]);
    const aBranch = runGit(a, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim();
    const bBranch = runGit(b, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim();
    const linkedBranch = runGit(linked, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim();
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
        await page.getByRole("treeitem").filter({ hasText: "native-branches-worktree-b" }).click();
        await page
            .locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]')
            .click({ button: "right" });
        await chooseBranches(page);
        await page.getByPlaceholder("Select a branch to check out", { exact: true }).fill("linked");
        await page.keyboard.press("Enter");
        await expect(
            page.getByPlaceholder("Open worktree for linked", { exact: true }),
        ).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath("branches-b-linked-worktree-prompt.png"),
        });
        await page.keyboard.press("Escape");
        expect(runGit(a, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(aBranch);
        expect(runGit(b, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(bBranch);
        expect(runGit(linked, gitEnv, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(
            linkedBranch,
        );
    } finally {
        await app.close();
    }
});
