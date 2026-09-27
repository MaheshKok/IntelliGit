import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
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

/** Runs Git only in the disposable fixture repository. */
function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Opens the nested native GitHub submenu, asserting its visible screenshot order. */
async function openGitHubMenu(page: Page): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await parent.hover();
    const github = page.getByRole("menuitem", { name: "GitHub", exact: true });
    if (!(await github.isVisible())) await page.keyboard.press("ArrowRight");
    await expect(github).toBeVisible();
    await github.hover();
    const firstAction = page.getByRole("menuitem", { name: /^Create Pull Request/ });
    if (!(await firstAction.isVisible())) await page.keyboard.press("ArrowRight");
    await expect(firstAction).toBeVisible();
    const githubMenu = page.locator(".monaco-menu:visible").last();
    await expect(
        githubMenu.locator(".separator"),
        "GitHub groups have two native separators",
    ).toHaveCount(2);
    const labels = [
        "Create Pull Request...",
        "View Pull Requests",
        "Sync Fork",
        "Create Gist...",
        "View in Browser",
        "Share Project on GitHub",
        "Clone Repository from GitHub...",
        "Manage GitHub Accounts...",
    ];
    const visibleItems = page.getByRole("menuitem");
    const text = (await visibleItems.allTextContents()).map((value) => value.trim());
    let previous = -1;
    for (const label of labels) {
        const index = text.findIndex(
            (value, position) => position > previous && value.startsWith(label),
        );
        expect(index, `${label} follows the previous GitHub action`).toBeGreaterThan(previous);
        previous = index;
    }
}

/** Executes the Gist entry only up to its source-naming prompt, then cancels before HTTP/auth. */
async function inspectAndCancelGist(page: Page): Promise<void> {
    const action = page.getByRole("menuitem", { name: /^Create Gist(?:\.\.\.|…)/ });
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
    const input = page.locator(".quick-input-widget input").first();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("selected.txt");
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();
}

test("GitHub native submenu is ordered on Explorer, tab, and editor and captures clicked B", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(180_000);
    const extensionRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const canonicalA = await realpath(a);
    const b = path.join(a, "native-github-b");
    const gitEnv = fixtureWorkspace.workspace.env;
    await mkdir(b);
    git(b, gitEnv, ["init", "-b", "main"]);
    await writeFile(path.join(b, "selected.txt"), "Synthetic B content\n");
    git(b, gitEnv, ["add", "selected.txt"]);
    git(b, gitEnv, [
        "-c",
        "user.name=Native GitHub Test",
        "-c",
        "user.email=github@example.invalid",
        "commit",
        "-m",
        "B baseline",
    ]);
    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(extensionRoot),
        repoRoot: extensionRoot,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        const channel = new E2eControlChannelClient(fixtureWorkspace.channelDir);
        /** Proves the persisted IntelliGit repository selection still points at unrelated A. */
        const assertActiveA = async (): Promise<void> => {
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
        };
        /** Restores A after opening B's editor so clicked-file dispatch must override it. */
        const selectActiveA = async (): Promise<void> => {
            await page.keyboard.press("ControlOrMeta+Shift+P");
            await page.keyboard.type("IntelliGit: Select Repository");
            await page.keyboard.press("Enter");
            const repositoryPicker = page.getByPlaceholder("Select IntelliGit repository", {
                exact: true,
            });
            await expect(repositoryPicker).toBeVisible();
            await repositoryPicker.fill(path.basename(a));
            await page.keyboard.press("Enter");
            await assertActiveA();
        };
        await page.getByRole("treeitem").filter({ hasText: "README.md" }).dblclick();
        await page.getByRole("treeitem").filter({ hasText: "native-github-b" }).click();
        const selected = page.locator(
            '[role="treeitem"][aria-label="selected.txt"][aria-level="2"]',
        );
        await selectActiveA();
        await selected.click({ button: "right" });
        await openGitHubMenu(page);
        await page.screenshot({ path: testInfo.outputPath("github-explorer-menu.png") });
        await inspectAndCancelGist(page);
        await assertActiveA();

        await selected.dblclick();
        await selectActiveA();
        await page.getByRole("tab", { name: /selected\.txt/ }).click({ button: "right" });
        await openGitHubMenu(page);
        await page.screenshot({ path: testInfo.outputPath("github-tab-menu.png") });
        await inspectAndCancelGist(page);
        await assertActiveA();

        await selectActiveA();
        await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
        await openGitHubMenu(page);
        await page.screenshot({ path: testInfo.outputPath("github-editor-menu.png") });
        await inspectAndCancelGist(page);
        await assertActiveA();
    } finally {
        await app.close();
    }
});
