import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtureWorkspace";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";

const FILE_NAME = "context-actions-example.ts";
const COMMITTED = "export const revision = 1;\n";
const SAVED = "export const revision = 2;\n";
const UNSAVED = "// unsaved-context-action\n";
const ACTIONS = [
    "Show Diff",
    "Compare with Revision",
    "Compare with Branch or Tag",
    "Show File History",
    "Show Current Revision",
    "Annotate with Git Blame",
    "Rollback",
    "Fetch",
    "Pull",
    "Push",
];

/** Opens the real source document through Quick Open, preserving any unsaved editor buffer. */
async function openSource(page: Page, filePath: string): Promise<void> {
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+P`);
    const input = page.locator(".quick-input-widget .quick-input-box input").first();
    await expect(input).toBeVisible();
    await input.fill(filePath);
    await page.getByRole("option").filter({ hasText: FILE_NAME }).first().click();
    await expect(input).toBeHidden();
}

/** Opens the native IntelliGit submenu from the requested file surface, without dispatching commands. */
async function openMenu(page: Page, surface: "explorer" | "tab" | "editor"): Promise<void> {
    const target =
        surface === "explorer"
            ? page.getByRole("treeitem").filter({ hasText: FILE_NAME })
            : surface === "tab"
              ? page.locator(".tab.active")
              : page.locator(".monaco-editor .view-lines:visible").first();
    await target.click({ button: "right" });
    await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
}

/** Invokes one visible native menu entry; keyboard shortcuts may follow the accessible label. */
async function clickAction(page: Page, label: string): Promise<void> {
    await openMenu(page, "explorer");
    const item = page.getByRole("menuitem", { name: new RegExp(`^${label}(?:$|\\s)`) });
    await item.hover();
    await item.focus();
    await page.keyboard.press("Enter");
}

test.use({ scenario: "dirty" });
test("offers highlighted file actions and preserves unsaved content across readonly views", async ({
    fixtureWorkspace,
}, testInfo) => {
    const repoRoot = path.resolve(__dirname, "../..");
    const filePath = path.join(fixtureWorkspace.workspace.root, FILE_NAME);
    const gitOptions = {
        cwd: fixtureWorkspace.workspace.root,
        env: fixtureWorkspace.workspace.env,
    };
    await writeFile(filePath, COMMITTED);
    execFileSync("git", ["add", "--", FILE_NAME], gitOptions);
    execFileSync(
        "git",
        ["commit", "--only", FILE_NAME, "-m", "Seed context action file"],
        gitOptions,
    );
    await writeFile(filePath, SAVED);
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
        await openSource(page, filePath);
        for (const surface of ["explorer", "tab", "editor"] as const) {
            await openMenu(page, surface);
            for (const label of ACTIONS) {
                await expect(
                    page.getByRole("menuitem", { name: new RegExp(`^${label}(?:$|\\s)`) }),
                ).toBeVisible();
            }
            await page.screenshot({ path: testInfo.outputPath(`context-actions-${surface}.png`) });
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
        }

        await clickAction(page, "Rollback");
        const dialog = page.locator(".monaco-dialog-box");
        await expect(dialog).toContainText(`Rollback ${FILE_NAME}?`);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toBeHidden();
        expect(await readFile(filePath, "utf8")).toBe(SAVED);

        const sourceLines = page.locator(".monaco-editor .view-lines:visible").first();
        await sourceLines.click();
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Home`);
        await page.keyboard.insertText(UNSAVED);
        await expect(sourceLines).toContainText("unsaved-context-action");

        await clickAction(page, "Show Current Revision");
        const snapshotLines = page.locator(".monaco-editor .view-lines:visible").first();
        await expect(snapshotLines).toContainText("revision = 1");
        await expect(snapshotLines).not.toContainText("unsaved-context-action");
        const snapshotText = await snapshotLines.textContent();
        await snapshotLines.click();
        await page.keyboard.insertText("readonly-probe");
        await expect(snapshotLines).toHaveText(snapshotText ?? "");
        await openSource(page, filePath);
        await expect(page.locator(".monaco-editor .view-lines:visible").first()).toContainText(
            "unsaved-context-action",
        );

        await clickAction(page, "Annotate with Git Blame");
        const blameLines = page.locator(".monaco-editor .view-lines:visible").first();
        await expect(blameLines).toContainText("unsaved-context-action");
        await expect(blameLines).toContainText("00000000");
        expect(await readFile(filePath, "utf8")).toBe(SAVED);

        await clickAction(page, "Show Diff");
        const diff = await new IntelliGitView(page).revealDiffViewer();
        await expect(diff.getByTestId("diff-pane-left")).toContainText("revision = 1");
        await expect(diff.getByTestId("diff-pane-right")).toContainText("unsaved-context-action");
        await page.screenshot({ path: testInfo.outputPath("context-actions-diff.png") });
    } catch (error) {
        await (
            await app.firstWindow()
        ).screenshot({ path: testInfo.outputPath("context-actions-failure.png") });
        throw error;
    } finally {
        app.process().kill("SIGTERM");
        await app.close();
    }
});

test.describe("file context repository operations", () => {
    test.use({ scenario: "clean" });

    test("fetches, rebases, and pushes through native menus against a disposable local origin", async ({
        fixtureWorkspace,
    }) => {
        const repoRoot = path.resolve(__dirname, "../..");
        const workspace = fixtureWorkspace.workspace;
        /** Executes Git only inside this disposable fixture and its owned bare origin. */
        const git = (args: string[]): string =>
            execFileSync("git", args, {
                cwd: workspace.root,
                env: workspace.env,
                encoding: "utf8",
            }).trim();
        expect(fileURLToPath(git(["remote", "get-url", "origin"]))).toBe(workspace.originRoot);
        await writeFile(path.join(workspace.root, FILE_NAME), COMMITTED);
        git(["add", "--", FILE_NAME]);
        git(["commit", "--only", FILE_NAME, "-m", "Seed native network action file"]);
        const branch = git(["branch", "--show-current"]);
        const beforeFetchHead = git(["rev-parse", "HEAD"]);
        const remoteRef = `refs/heads/${branch}`;
        const originArgs = ["--git-dir", workspace.originRoot];
        const remoteHead = git([...originArgs, "rev-parse", remoteRef]);
        const remoteTree = git([...originArgs, "rev-parse", `${remoteHead}^{tree}`]);
        const advancedRemote = git([
            ...originArgs,
            "commit-tree",
            remoteTree,
            "-p",
            remoteHead,
            "-m",
            "Advance disposable origin",
        ]);
        git([...originArgs, "update-ref", remoteRef, advancedRemote]);

        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(repoRoot),
            repoRoot,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await page.waitForLoadState("domcontentloaded");
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            await openSource(page, path.join(workspace.root, FILE_NAME));
            await clickAction(page, "Fetch");
            await expect.poll(() => git(["rev-parse", "@{upstream}"])).toBe(advancedRemote);
            expect(git(["rev-parse", "HEAD"])).toBe(beforeFetchHead);

            await clickAction(page, "Pull");
            await expect
                .poll(() => git(["merge-base", "HEAD", advancedRemote]))
                .toBe(advancedRemote);
            expect(await readFile(path.join(workspace.root, FILE_NAME), "utf8")).toBe(COMMITTED);
            expect(git(["status", "--porcelain"])).toBe("");

            await clickAction(page, "Push");
            await expect
                .poll(() => git([...originArgs, "rev-parse", remoteRef]))
                .toBe(git(["rev-parse", "HEAD"]));
        } finally {
            app.process().kill("SIGTERM");
            await app.close();
        }
    });
});
