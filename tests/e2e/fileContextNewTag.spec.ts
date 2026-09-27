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

/** Runs Git only against an isolated fixture repository and returns its exact output. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Chooses New Tag through the visible native IntelliGit file submenu. */
async function chooseNewTag(page: Page): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await parent.click();
    const action = page.getByRole("menuitem", { name: /^New Tag(?:\.\.\.|…)/ });
    if (!(await action.count())) {
        await parent.hover();
        await page.keyboard.press("ArrowRight");
    }
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("v1.0.0", { exact: true })).toBeVisible();
}

/** Submits one tag and independently checks its lightweight ref against the captured commit. */
async function createTag(
    page: Page,
    cwd: string,
    env: NodeJS.ProcessEnv,
    name: string,
    target: string,
): Promise<void> {
    await page.getByPlaceholder("v1.0.0", { exact: true }).fill(name);
    await page.keyboard.press("Enter");
    await expect
        .poll(() =>
            runGit(cwd, env, ["for-each-ref", "--format=%(objectname)", `refs/tags/${name}`]),
        )
        .toBe(target);
    expect(runGit(cwd, env, ["cat-file", "-t", `refs/tags/${name}`])).toBe("commit");
}

test("Explorer, editor tab, and editor content create lightweight tags in clicked B without changing either worktree", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(150_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const canonicalA = await realpath(a);
    const env = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-new-tag-b");
    await mkdir(b);
    runGit(b, env, ["init", "-b", "main"]);
    runGit(b, env, ["config", "user.name", "Native New Tag Test"]);
    runGit(b, env, ["config", "user.email", "native-new-tag@example.invalid"]);
    await writeFile(path.join(b, "selected.txt"), "B committed\n");
    runGit(b, env, ["add", "selected.txt"]);
    runGit(b, env, ["commit", "-m", "B initial"]);
    const bHead = runGit(b, env, ["rev-parse", "HEAD"]);
    await writeFile(path.join(b, "staged.txt"), "B staged\n");
    runGit(b, env, ["add", "staged.txt"]);
    await writeFile(path.join(b, "selected.txt"), "B unstaged\n");
    await writeFile(path.join(b, "untracked.txt"), "B untracked\n");
    const aHead = runGit(a, env, ["rev-parse", "HEAD"]);
    const aIndex = runGit(a, env, ["ls-files", "--stage", "-z"]);
    const aRefs = runGit(a, env, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const bIndex = runGit(b, env, ["ls-files", "--stage", "-z"]);
    const bStatus = runGit(b, env, ["status", "--porcelain"]);
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
        const picker = page.getByPlaceholder("Select IntelliGit repository", { exact: true });
        await expect(picker).toBeVisible();
        await picker.fill(path.basename(a));
        await page.keyboard.press("Enter");
        const channel = new E2eControlChannelClient(fixtureWorkspace.channelDir);
        await expect
            .poll(async () => {
                const selected = await channel.request({
                    store: "memento",
                    scope: "workspace",
                    key: "intelligit.selectedRepositoryRoot",
                    operation: "snapshot",
                });
                return selected.ok && selected.result;
            })
            .toMatchObject({ kind: "value", value: canonicalA });

        await page.getByRole("treeitem").filter({ hasText: "native-new-tag-b" }).click();
        const file = page.locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]');
        await file.click({ button: "right" });
        await chooseNewTag(page);
        await page.screenshot({ path: testInfo.outputPath("new-tag-explorer-prompt.png") });
        await page.keyboard.press("Escape");
        expect(runGit(b, env, ["tag", "--list"])).toBe("");

        await file.click({ button: "right" });
        await chooseNewTag(page);
        await createTag(page, b, env, "native-tag-explorer", bHead);

        await file.dblclick();
        await page.getByRole("tab", { name: /selected\.txt/ }).click({ button: "right" });
        await chooseNewTag(page);
        await page.screenshot({ path: testInfo.outputPath("new-tag-tab-prompt.png") });
        await createTag(page, b, env, "native-tag-tab", bHead);

        await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
        await chooseNewTag(page);
        await page.screenshot({ path: testInfo.outputPath("new-tag-editor-prompt.png") });
        await createTag(page, b, env, "native-tag-editor", bHead);

        await file.click({ button: "right" });
        await chooseNewTag(page);
        await page.getByPlaceholder("v1.0.0", { exact: true }).fill("-bad");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: /Invalid tag name '-bad'/ })).toBeVisible();
        await page.keyboard.press("Escape");

        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(bHead);
        expect(runGit(b, env, ["ls-files", "--stage", "-z"])).toBe(bIndex);
        expect(runGit(b, env, ["status", "--porcelain"])).toBe(bStatus);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B unstaged\n");
        expect(await readFile(path.join(b, "staged.txt"), "utf8")).toBe("B staged\n");
        expect(await readFile(path.join(b, "untracked.txt"), "utf8")).toBe("B untracked\n");
        expect(runGit(a, env, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(runGit(a, env, ["ls-files", "--stage", "-z"])).toBe(aIndex);
        expect(runGit(a, env, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(aRefs);

        // Move B's HEAD only after the prompt opens: the tag must retain the pre-prompt commit.
        await file.click({ button: "right" });
        await chooseNewTag(page);
        const tree = runGit(b, env, ["rev-parse", "HEAD^{tree}"]);
        const advancedHead = runGit(b, env, [
            "commit-tree",
            tree,
            "-p",
            bHead,
            "-m",
            "Advance B HEAD",
        ]);
        runGit(b, env, ["update-ref", "refs/heads/main", advancedHead, bHead]);
        await createTag(page, b, env, "native-tag-head-drift", bHead);
        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(advancedHead);
        expect(runGit(b, env, ["ls-files", "--stage", "-z"])).toBe(bIndex);
        expect(runGit(b, env, ["status", "--porcelain"])).toBe(bStatus);

        // A duplicate with a different original target exposes accidental force replacement.
        runGit(b, env, ["tag", "native-tag-duplicate", bHead]);
        await file.click({ button: "right" });
        await chooseNewTag(page);
        await page.getByPlaceholder("v1.0.0", { exact: true }).fill("native-tag-duplicate");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: /Failed to create tag:/ })).toBeVisible();
        expect(runGit(b, env, ["rev-parse", "refs/tags/native-tag-duplicate"])).toBe(bHead);
        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(advancedHead);
        expect(runGit(a, env, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(aRefs);
    } finally {
        await app.close();
    }
});
