import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, FrameLocator, Page } from "@playwright/test";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "clean" });

/** Runs Git with the disposable workspace's isolated author and configuration environment. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

/** Invokes Rebase from a real native Git file menu and waits for the branch picker. */
async function chooseRebaseFromMenu(page: Page): Promise<void> {
    await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).click();
    const action = page.getByRole("menuitem", { name: /^Rebase(?:\.\.\.|…)/ });
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
    await expect(
        page.getByPlaceholder("Select a branch to rebase the current branch onto", { exact: true }),
    ).toBeVisible();
}

test("cancels native Rebase, then rebases the selected file's branch in the real Explorer menu", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const target = runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]).trim();
    const source = "native-rebase-e2e";
    runGit(workspaceRoot, gitEnv, ["checkout", "-b", source]);
    await writeFile(path.join(workspaceRoot, "feature-e2e.txt"), "Native Rebase target content\n");
    runGit(workspaceRoot, gitEnv, ["add", "feature-e2e.txt"]);
    runGit(workspaceRoot, gitEnv, ["commit", "-m", "Native Rebase target commit"]);
    const sourceHead = runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]).trim();
    runGit(workspaceRoot, gitEnv, ["checkout", target]);
    await writeFile(path.join(workspaceRoot, "current-e2e.txt"), "Current branch content\n");
    runGit(workspaceRoot, gitEnv, ["add", "current-e2e.txt"]);
    runGit(workspaceRoot, gitEnv, ["commit", "-m", "Current branch commit"]);
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
        await chooseRebaseFromMenu(page);
        await page.screenshot({ path: testInfo.outputPath("rebase-native-picker.png") });
        await page.keyboard.press("Escape");
        await expect(
            page.getByPlaceholder("Select a branch to rebase the current branch onto", {
                exact: true,
            }),
        ).toBeHidden();
        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(runGit(workspaceRoot, gitEnv, ["ls-files", "--stage", "-z"])).toBe(beforeIndex);

        await page
            .getByRole("treeitem")
            .filter({ hasText: "README.md" })
            .click({ button: "right" });
        await chooseRebaseFromMenu(page);
        await page
            .getByPlaceholder("Select a branch to rebase the current branch onto", { exact: true })
            .fill(source);
        await page.keyboard.press("Enter");
        await expect(
            page.getByText(`Rebase current branch ${target} onto ${source}?`, { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("rebase-native-confirmation.png") });
        await page.getByRole("button", { name: "Rebase", exact: true }).click();
        await expect
            .poll(() => runGit(workspaceRoot, gitEnv, ["merge-base", source, target]).trim())
            .toBe(sourceHead);
        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
        expect(runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]).trim()).toBe(target);
        expect(await readFile(path.join(workspaceRoot, "feature-e2e.txt"), "utf8")).toBe(
            "Native Rebase target content\n",
        );
        expect(await readFile(path.join(workspaceRoot, "current-e2e.txt"), "utf8")).toBe(
            "Current branch content\n",
        );
        await expect(
            page.getByText(`IntelliGit: Rebased onto ${source}`, { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("rebase-native-success.png") });

        await page.getByRole("treeitem").filter({ hasText: "README.md" }).dblclick();
        await page.getByRole("tab", { name: /README\.md/ }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: /^Rebase(?:\.\.\.|…)/ })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("rebase-native-tab-menu.png") });
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");

        await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: /^Rebase(?:\.\.\.|…)/ })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("rebase-native-editor-menu.png") });
    } finally {
        await app.close();
    }
});

test("keeps a clicked nested repository's rebase conflict and Abort in that repository", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const gitEnv = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-rebase-b");
    await mkdir(b);
    runGit(b, gitEnv, ["init", "-b", "main"]);
    runGit(b, gitEnv, ["config", "user.name", "Native Rebase Test"]);
    runGit(b, gitEnv, ["config", "user.email", "native-rebase@example.invalid"]);
    await writeFile(path.join(b, "selected.txt"), "BASE\n");
    runGit(b, gitEnv, ["add", "."]);
    runGit(b, gitEnv, ["commit", "-m", "base"]);
    runGit(b, gitEnv, ["checkout", "-b", "feature"]);
    await writeFile(path.join(b, "selected.txt"), "FEATURE\n");
    runGit(b, gitEnv, ["commit", "-am", "feature"]);
    runGit(b, gitEnv, ["checkout", "main"]);
    await writeFile(path.join(b, "selected.txt"), "MAIN\n");
    runGit(b, gitEnv, ["commit", "-am", "main"]);
    await writeFile(path.join(a, "selected.txt"), "A_REPOSITORY\n");
    runGit(a, gitEnv, ["add", "selected.txt"]);
    runGit(a, gitEnv, ["commit", "-m", "A same-name file"]);
    const aHead = runGit(a, gitEnv, ["rev-parse", "HEAD"]);
    const aIndex = runGit(a, gitEnv, ["ls-files", "--stage", "-z"]);
    const bHead = runGit(b, gitEnv, ["rev-parse", "HEAD"]);
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
        await page.getByRole("treeitem").filter({ hasText: "native-rebase-b" }).click();
        await page
            .locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]')
            .click({ button: "right" });
        await chooseRebaseFromMenu(page);
        await page
            .getByPlaceholder("Select a branch to rebase the current branch onto", { exact: true })
            .fill("feature");
        await page.keyboard.press("Enter");
        await expect(
            page.getByText("Rebase current branch main onto feature?", { exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Rebase", exact: true }).click();
        await expect
            .poll(() => runGit(b, gitEnv, ["status", "--porcelain"]))
            .toContain("UU selected.txt");
        await expect
            .poll(async () => {
                for (const frame of page.frames()) {
                    if (await frame.getByRole("button", { name: "Abort Rebase" }).count())
                        return true;
                }
                return false;
            })
            .toBe(true);
        await page.screenshot({ path: testInfo.outputPath("rebase-b-conflict-session.png") });
        let conflictFrame: Frame | undefined;
        for (const frame of page.frames()) {
            if (await frame.getByRole("button", { name: "Abort Rebase" }).count()) {
                conflictFrame = frame;
                break;
            }
        }
        expect(conflictFrame, "conflict session webview opens").toBeDefined();
        await expect(
            conflictFrame!.getByText("Rebasing main onto feature", { exact: true }),
        ).toBeVisible();
        await expect(
            conflictFrame!.getByRole("columnheader", { name: "Yours (feature)" }),
        ).toBeVisible();
        await expect(
            conflictFrame!.getByRole("columnheader", { name: "Theirs (main)" }),
        ).toBeVisible();
        expect(runGit(b, gitEnv, ["show", ":2:selected.txt"])).toBe("FEATURE\n");
        expect(runGit(b, gitEnv, ["show", ":3:selected.txt"])).toBe("MAIN\n");

        await page.getByRole("treeitem").filter({ hasText: "README.md" }).dblclick();
        await page.getByRole("tab", { name: "Conflicts", exact: true }).click();
        await conflictFrame!.getByRole("button", { name: "Merge…", exact: true }).click();
        await expect
            .poll(async () => {
                for (const outer of await page.locator("iframe.webview").all()) {
                    const document = outer
                        .contentFrame()
                        .locator("iframe#active-frame")
                        .contentFrame();
                    if (await document.locator(".merge-editor").count()) return true;
                }
                return false;
            })
            .toBe(true);
        let editorFrame: FrameLocator | undefined;
        for (const outer of await page.locator("iframe.webview").all()) {
            const document = outer.contentFrame().locator("iframe#active-frame").contentFrame();
            if (await document.locator(".merge-editor").count()) {
                editorFrame = document;
                break;
            }
        }
        expect(editorFrame, "B's merge editor opens after focusing A").toBeDefined();
        await expect(editorFrame!.locator(".merge-col.col-left")).toContainText("FEATURE");
        await expect(editorFrame!.locator(".merge-col.col-right")).toContainText("MAIN");
        await expect(editorFrame!.locator(".merge-editor")).not.toContainText("A_REPOSITORY");
        await page.screenshot({ path: testInfo.outputPath("rebase-b-scoped-editor.png") });

        await page
            .locator(".activitybar .action-item")
            .filter({ has: page.getByLabel(/^IntelliGit/) })
            .first()
            .click();
        let changesFrame: FrameLocator | undefined;
        await expect
            .poll(async () => {
                for (const outer of await page.locator("iframe.webview").all()) {
                    const document = outer
                        .contentFrame()
                        .locator("iframe#active-frame")
                        .contentFrame();
                    if (await document.getByTestId("commit-panel-tab-row").count()) {
                        changesFrame = document;
                        return true;
                    }
                }
                return false;
            })
            .toBe(true);
        await expect(changesFrame!.getByTestId("commit-panel-tab-row")).toBeVisible();
        const continueRebase = changesFrame!.getByRole("button", {
            name: "Continue Rebase",
            exact: true,
        });
        await expect(continueRebase).toHaveCount(1);
        await expect(continueRebase).toBeVisible();
        await page.getByRole("tab", { name: "Conflicts", exact: true }).click();
        await conflictFrame!.getByRole("button", { name: "Abort Rebase" }).click();
        await expect(
            page.getByText(
                "Abort the current rebase? Local conflict resolutions will be discarded.",
                {
                    exact: true,
                },
            ),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("rebase-b-abort-confirmation.png") });
        await page.getByRole("button", { name: "Abort Rebase", exact: true }).click();
        await expect.poll(() => runGit(b, gitEnv, ["status", "--porcelain"])).toBe("");
        expect(runGit(b, gitEnv, ["rev-parse", "HEAD"])).toBe(bHead);
        expect(runGit(b, gitEnv, ["branch", "--show-current"]).trim()).toBe("main");
        expect(runGit(a, gitEnv, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(runGit(a, gitEnv, ["ls-files", "--stage", "-z"])).toBe(aIndex);
    } finally {
        await app.close();
    }
});
