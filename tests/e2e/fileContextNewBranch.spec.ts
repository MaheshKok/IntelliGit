import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "clean" });

/** Reads or changes only disposable fixture Git state using its isolated configuration. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Opens the native New Branch input from an already open IntelliGit file submenu. */
async function chooseNewBranch(page: Page): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await parent.click();
    const action = page.getByRole("menuitem", { name: /^New Branch(?:\.\.\.|…)/ });
    if (!(await action.count())) {
        await parent.hover();
        await page.keyboard.press("ArrowRight");
    }
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("branch-name", { exact: true })).toBeVisible();
}

/** Completes branch creation and verifies both the ref and active checkout against pre-click HEAD. */
async function createBranch(
    page: Page,
    cwd: string,
    env: NodeJS.ProcessEnv,
    name: string,
): Promise<void> {
    const head = runGit(cwd, env, ["rev-parse", "HEAD"]);
    await page.getByPlaceholder("branch-name", { exact: true }).fill(name);
    await page.keyboard.press("Enter");
    await expect.poll(() => runGit(cwd, env, ["symbolic-ref", "--short", "HEAD"])).toBe(name);
    expect(runGit(cwd, env, ["rev-parse", `refs/heads/${name}`])).toBe(head);
    expect(runGit(cwd, env, ["rev-parse", "HEAD"])).toBe(head);
}

test("creates from HEAD through Explorer, editor tab, and editor menus; cancellation and duplicate are inert", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const cwd = fixtureWorkspace.workspace.root;
    const env = fixtureWorkspace.workspace.env;
    const originalHead = runGit(cwd, env, ["rev-parse", "HEAD"]);
    const originalBranch = runGit(cwd, env, ["symbolic-ref", "--short", "HEAD"]);
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
        await chooseNewBranch(page);
        await page.screenshot({ path: testInfo.outputPath("new-branch-explorer-input.png") });
        await page.keyboard.press("Escape");
        expect(runGit(cwd, env, ["symbolic-ref", "--short", "HEAD"])).toBe(originalBranch);
        expect(runGit(cwd, env, ["rev-parse", "HEAD"])).toBe(originalHead);

        await page
            .getByRole("treeitem")
            .filter({ hasText: "README.md" })
            .click({ button: "right" });
        await chooseNewBranch(page);
        await createBranch(page, cwd, env, "native-new-branch-explorer");
        await page.screenshot({ path: testInfo.outputPath("new-branch-explorer-created.png") });

        await page.getByRole("treeitem").filter({ hasText: "README.md" }).dblclick();
        await page.getByRole("tab", { name: /README\.md/ }).click({ button: "right" });
        await chooseNewBranch(page);
        await createBranch(page, cwd, env, "native-new-branch-tab");
        await page.screenshot({ path: testInfo.outputPath("new-branch-tab-created.png") });

        await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
        await chooseNewBranch(page);
        await createBranch(page, cwd, env, "native-new-branch-editor");
        await page.screenshot({ path: testInfo.outputPath("new-branch-editor-created.png") });

        await page
            .getByRole("treeitem")
            .filter({ hasText: "README.md" })
            .click({ button: "right" });
        await chooseNewBranch(page);
        await page
            .getByPlaceholder("branch-name", { exact: true })
            .fill("native-new-branch-editor");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: /Failed to create branch:/ })).toBeVisible();
        expect(runGit(cwd, env, ["symbolic-ref", "--short", "HEAD"])).toBe(
            "native-new-branch-editor",
        );
        expect(runGit(cwd, env, ["rev-parse", "refs/heads/native-new-branch-editor"])).toBe(
            originalHead,
        );
    } finally {
        await app.close();
    }
});

test("creates in clicked nested B while active A stays unchanged and dirty B content survives", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const canonicalA = await realpath(a);
    const env = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-new-branch-b");
    await mkdir(b);
    runGit(b, env, ["init", "-b", "main"]);
    runGit(b, env, ["config", "user.name", "Native New Branch Test"]);
    runGit(b, env, ["config", "user.email", "native-new-branch@example.invalid"]);
    await writeFile(path.join(b, "selected.txt"), "B main\n");
    runGit(b, env, ["add", "selected.txt"]);
    runGit(b, env, ["commit", "-m", "B main"]);
    await writeFile(path.join(b, "selected.txt"), "B dirty\n");
    const aHead = runGit(a, env, ["rev-parse", "HEAD"]);
    const aBranch = runGit(a, env, ["symbolic-ref", "--short", "HEAD"]);
    const aIndex = runGit(a, env, ["ls-files", "--stage", "-z"]);
    const aRefs = runGit(a, env, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const bHead = runGit(b, env, ["rev-parse", "HEAD"]);
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
        await page.keyboard.press("ControlOrMeta+Shift+P");
        await page.keyboard.type("IntelliGit: Select Repository");
        await page.keyboard.press("Enter");
        const repositoryPicker = page.getByPlaceholder("Select IntelliGit repository", {
            exact: true,
        });
        await expect(repositoryPicker).toBeVisible();
        await repositoryPicker.fill(path.basename(a));
        await page.keyboard.press("Enter");
        const channel = new E2eControlChannelClient(fixtureWorkspace.channelDir);
        await expect
            .poll(async () => {
                const selectedBefore = await channel.request({
                    store: "memento",
                    scope: "workspace",
                    key: "intelligit.selectedRepositoryRoot",
                    operation: "snapshot",
                });
                return selectedBefore.ok && selectedBefore.result;
            })
            .toMatchObject({ kind: "value", value: canonicalA });
        await page.getByRole("treeitem").filter({ hasText: "native-new-branch-b" }).click();
        await page
            .locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]')
            .click({ button: "right" });
        await chooseNewBranch(page);
        await createBranch(page, b, env, "native-new-branch-in-b");
        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(bHead);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B dirty\n");
        expect(runGit(b, env, ["status", "--short"])).toContain("M selected.txt");
        expect(runGit(a, env, ["symbolic-ref", "--short", "HEAD"])).toBe(aBranch);
        expect(runGit(a, env, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(runGit(a, env, ["ls-files", "--stage", "-z"])).toBe(aIndex);
        expect(runGit(a, env, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(aRefs);
        const selectedAfter = await channel.request({
            store: "memento",
            scope: "workspace",
            key: "intelligit.selectedRepositoryRoot",
            operation: "snapshot",
        });
        expect(selectedAfter.ok && selectedAfter.result).toMatchObject({
            kind: "value",
            value: canonicalA,
        });
        await page.screenshot({ path: testInfo.outputPath("new-branch-clicked-b.png") });
    } finally {
        await app.close();
    }
});
