import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, test } from "./fixtureWorkspace";
import { runGitRaw as runGit } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    launchFixtureWorkspace,
    dismissFirstRunDialogs,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Opens the real command and row rather than injecting merge payloads. */
async function openMerge(page: Page, reuseVisibleSession = false): Promise<FrameLocator> {
    const view = new IntelliGitView(page);
    if (!reuseVisibleSession) await new Workbench(page).runCommand("Open Conflict Session");
    const session = await view.revealConflictSession();
    await expect(session.locator(".session-root")).toBeVisible();
    await expect(session.locator("tbody tr.row")).toHaveCount(1);
    // Rows open on one click; a double click can land its second click on the revealed tab.
    await session.locator("tbody tr.row").click();
    const frame = await view.revealMergeWorkbench();
    await expect(frame.locator(".merge-workbench")).toBeVisible();
    return frame;
}

/** Resolves each original change through visible per-change navigation and side decisions. */
async function acceptOurs(frame: FrameLocator): Promise<void> {
    const changes = frame.locator("select.mw-hunks");
    for (let i = 0; i < (await changes.locator("option").count()); i++) {
        await changes.selectOption(String(i));
        await frame
            .locator(".mw-toolbar")
            .getByRole("button", { name: "Accept left change", exact: true })
            .click();
    }
}

test.describe("Full-document Git merge workbench", () => {
    test.use({ scenario: "conflicted" });
    test("stages a cherry-pick resolution without automatically continuing it", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await runGit(workspace.root, ["merge", "--abort"], workspace.env);
        await runGit(workspace.root, ["cherry-pick", "conflict/with-main"], workspace.env).catch(
            () => undefined,
        );
        expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).not.toBe("");
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await acceptOurs(frame);
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["ls-files", "-u"], workspace.env))
                .toBe("");
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect(
                await runGit(workspace.root, ["rev-parse", "CHERRY_PICK_HEAD"], workspace.env),
            ).not.toBe("");
        } finally {
            await app.close();
        }
    });
    test("keeps typing, decisions, history and durable drafts through theme changes and reopen", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const settingsPath = path.join(workspace.root, ".vscode/settings.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(
            settingsPath,
            JSON.stringify({ "workbench.colorTheme": "Default Dark Modern" }),
        );
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            let frame = await openMerge(page);
            const result = () => frame.locator('[data-testid="merge-editor-1"] .cm-content');
            await expect(result()).toHaveAttribute("contenteditable", "true");
            await expect(
                frame.locator('[data-testid="merge-editor-0"] .cm-content'),
            ).toHaveAttribute("contenteditable", "false");
            const original = await result().innerText();
            await frame
                .locator(".mw-connectors")
                .first()
                .getByRole("button", { name: "Accept left change", exact: true })
                .first()
                .click();
            const chosen = await result().innerText();
            expect(chosen).not.toBe(original);
            await frame.getByRole("button", { name: "Undo", exact: true }).click();
            await expect.poll(() => result().innerText()).toBe(original);
            await frame.getByRole("button", { name: "Redo", exact: true }).click();
            await expect.poll(() => result().innerText()).toBe(chosen);
            await result().click();
            await result().press("Control+End");
            await result().press("End");
            await result().press("Enter");
            await result().pressSequentially("manual draft");
            await expect(result()).toContainText("manual draft");
            await expect(frame.locator(".mw-footer")).toContainText("Draft saved");
            const draft = await result().innerText();
            await frame.getByRole("button", { name: "Base", exact: true }).click();
            await expect(frame.locator(".mw-base .cm-content")).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath("merge-dark.png") });
            await writeFile(
                settingsPath,
                JSON.stringify({ "workbench.colorTheme": "Default Light Modern" }),
            );
            await expect(frame.locator("body")).toHaveAttribute(
                "data-vscode-theme-kind",
                "vscode-light",
            );
            await expect.poll(() => result().innerText()).toBe(draft);
            await expect(frame.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
            await page.screenshot({ path: testInfo.outputPath("merge-light.png") });
            // Close immediately after typing; the 250 ms draft timer must not lose this edit.
            await result().click();
            await result().press("Control+End");
            await result().press("End");
            await result().press("Enter");
            await result().pressSequentially("last-second draft");
            const finalDraft = await result().innerText();
            await frame.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect(
                page.getByRole("tab").filter({ hasText: "Merge: conflict.txt" }),
            ).toHaveCount(0);
            // Cancel reveals the existing chooser; no redundant async command may reveal it later.
            frame = await openMerge(page, true);
            await expect.poll(() => result().innerText()).toBe(finalDraft);
            await acceptOurs(frame);
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["ls-files", "-u"], workspace.env))
                .toBe("");
            expect(await runGit(workspace.root, ["show", ":conflict.txt"], workspace.env)).toBe(
                await readFile(path.join(workspace.root, "conflict.txt"), "utf8"),
            );
        } finally {
            await app.close();
        }
    });

    test("refuses an externally changed file while retaining the editable draft", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await acceptOurs(frame);
            const result = frame.locator('[data-testid="merge-editor-1"] .cm-content');
            const draft = await result.innerText();
            await writeFile(path.join(workspace.root, "conflict.txt"), "external change\n");
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect(frame.locator(".mw-error")).toContainText("changed");
            await expect.poll(() => result.innerText()).toBe(draft);
            await expect(result).toHaveAttribute("contenteditable", "true");
            expect(await readFile(path.join(workspace.root, "conflict.txt"), "utf8")).toBe(
                "external change\n",
            );
            expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).not.toBe("");
        } finally {
            await app.close();
        }
    });

    test("retains the saved result, draft and Git error when staging is locked", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const stages = await runGit(workspace.root, ["ls-files", "-u"], workspace.env);
        const mergeErrors: string[] = [];
        const ours = await runGit(workspace.root, ["show", ":2:conflict.txt"], workspace.env);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await acceptOurs(frame);
            await expect(frame.locator(".mw-footer")).toContainText("Draft saved");
            page.on("console", (message) => {
                if (message.text().includes("[IntelliGit] Merge editor operation failed:")) {
                    mergeErrors.push(message.text());
                }
            });
            const lockPath = path.join(workspace.root, ".git/index.lock");
            await writeFile(lockPath, "owned by test", { flag: "wx" });
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect(frame.locator(".mw-error")).toContainText("staging failed");
            await expect(frame.locator(".mw-footer")).toContainText("Draft saved");
            await expect(
                frame.locator('[data-testid="merge-editor-1"] .cm-content'),
            ).toHaveAttribute("contenteditable", "true");
            expect(await readFile(path.join(workspace.root, "conflict.txt"), "utf8")).toBe(ours);
            expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).toBe(stages);
            expect(await readFile(lockPath, "utf8")).toBe("owned by test");
            await expect.poll(() => mergeErrors.join("\n")).toContain("index.lock");
            await testInfo.attach("merge-operation-errors.log", {
                body: mergeErrors.join("\n"),
                contentType: "text/plain",
            });
            await page.screenshot({ path: testInfo.outputPath("merge-stage-failure.png") });
        } finally {
            await app.close();
        }
    });

    test("refuses Apply over unsaved native editor changes", async ({ fixtureWorkspace }) => {
        const { workspace } = fixtureWorkspace;
        const settingsPath = path.join(workspace.root, ".vscode/settings.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ "git.mergeEditor": false }));
        const before = await readFile(path.join(workspace.root, "conflict.txt"), "utf8");
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            let frame = await openMerge(page);
            await acceptOurs(frame);
            const modifier = process.platform === "darwin" ? "Meta" : "Control";
            await page.keyboard.press(`${modifier}+P`);
            const input = page.locator(".quick-input-widget .quick-input-box input").first();
            await expect(input).toBeVisible();
            await input.fill(path.join(workspace.root, "conflict.txt"));
            await page.getByRole("option").filter({ hasText: "conflict.txt" }).first().click();
            await expect(input).toBeHidden();
            const editor = page.locator(".editor-group-container .monaco-editor:visible").first();
            await editor.click();
            await page.keyboard.press(`${modifier}+A`);
            await page.keyboard.type("unsaved native edit");
            await expect(editor.locator(".view-lines")).toContainText("unsaved native edit");
            await page.getByRole("tab").filter({ hasText: "Merge: conflict.txt" }).click();
            frame = await new IntelliGitView(page).revealMergeWorkbench();
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect(frame.locator(".mw-error")).toContainText("unsaved editor changes");
            expect(await readFile(path.join(workspace.root, "conflict.txt"), "utf8")).toBe(before);
            expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).not.toBe("");
            await expect(
                frame.locator('[data-testid="merge-editor-1"] .cm-content'),
            ).toHaveAttribute("contenteditable", "true");
        } finally {
            await app.close();
        }
    });

    test("preserves multiple unequal changes, scroll and syntax through high-contrast switches", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await runGit(workspace.root, ["merge", "--abort"], workspace.env);
        const file = "merge-theme.ts";
        const filePath = path.join(workspace.root, file);
        const base =
            Array.from({ length: 100 }, (_, index) => `const item${index} = "base"; // theme`).join(
                "\n",
            ) + "\n";
        await writeFile(filePath, base);
        await runGit(workspace.root, ["add", "--", file], workspace.env);
        await runGit(workspace.root, ["commit", "-m", "Merge theme base"], workspace.env);
        const branch = (
            await runGit(workspace.root, ["branch", "--show-current"], workspace.env)
        ).trim();
        await runGit(workspace.root, ["checkout", "-b", "merge-theme-incoming"], workspace.env);
        const change = (text: string, side: string) =>
            [5, 45, 85].reduce(
                (value, index) =>
                    value.replace(`item${index} = "base"`, `item${index} = "${side}"`),
                text,
            );
        await writeFile(filePath, change(base, "theirs"));
        await runGit(workspace.root, ["commit", "-am", "Incoming changes"], workspace.env);
        await runGit(workspace.root, ["checkout", branch], workspace.env);
        await writeFile(
            filePath,
            change(base, "ours").replace(
                "// theme\nconst item6",
                '// theme\nconst extra = "ours";\nconst item6',
            ),
        );
        await runGit(workspace.root, ["commit", "-am", "Local changes"], workspace.env);
        await runGit(workspace.root, ["merge", "merge-theme-incoming"], workspace.env).catch(
            () => undefined,
        );
        expect(await runGit(workspace.root, ["ls-files", "-u"], workspace.env)).toContain(file);
        const settingsPath = path.join(workspace.root, ".vscode/settings.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        const settings = {
            "editor.tokenColorCustomizations": {
                textMateRules: [
                    { scope: "comment", settings: { foreground: "#33bb77", fontStyle: "italic" } },
                ],
            },
            "workbench.colorCustomizations": { "diffEditor.removedTextBorder": "#eeaa11" },
        };
        await writeFile(
            settingsPath,
            JSON.stringify({ ...settings, "workbench.colorTheme": "Default Dark Modern" }),
        );
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await expect(frame.locator("select.mw-hunks option")).toHaveCount(3);
            const result = frame.locator('[data-testid="merge-editor-1"] .cm-content');
            await frame
                .getByRole("combobox", { name: "Resolve change" })
                .selectOption("both-reversed");
            await expect(result).toContainText('item5 = "theirs"');
            await expect(result).toContainText('item5 = "ours"');
            const sourceScroll = frame.locator('[data-testid="merge-editor-0"] .cm-scroller');
            const resultScroll = frame.locator('[data-testid="merge-editor-1"] .cm-scroller');
            await sourceScroll.evaluate((element) => {
                element.scrollTop = 600;
            });
            await expect
                .poll(() => resultScroll.evaluate((element) => element.scrollTop))
                .toBeGreaterThan(300);
            const scroll = await resultScroll.evaluate((element) => element.scrollTop);
            const draft = await result.innerText();
            const comment = frame
                .locator('[data-testid="merge-editor-1"] span[style*="color"]')
                .filter({ hasText: /^\/\/ theme$/ })
                .first();
            await expect(comment).toHaveCSS("color", "rgb(51, 187, 119)");
            await expect(comment).toHaveCSS("font-style", "italic");
            for (const [theme, kind] of [
                ["Default High Contrast", "vscode-high-contrast"],
                ["Default High Contrast Light", "vscode-high-contrast-light"],
            ]) {
                await writeFile(
                    settingsPath,
                    JSON.stringify({ ...settings, "workbench.colorTheme": theme }),
                );
                await expect(frame.locator("body")).toHaveAttribute("data-vscode-theme-kind", kind);
                await expect(comment).toHaveCSS("color", "rgb(51, 187, 119)");
                await expect(frame.locator(".merge-word-change").first()).toHaveCSS(
                    "outline-color",
                    "rgb(238, 170, 17)",
                );
                expect(await resultScroll.evaluate((element) => element.scrollTop)).toBe(scroll);
                expect(await result.innerText()).toBe(draft);
                await expect(
                    frame.getByRole("button", { name: "Undo", exact: true }),
                ).toBeEnabled();
                await page.screenshot({ path: testInfo.outputPath(`${kind}.png`) });
            }
            await frame.getByRole("button", { name: "Find in result" }).click();
            await expect(frame.locator(".cm-search")).toBeVisible();
        } finally {
            await app.close();
        }
    });
});

test.describe("Rebase conflict workbench", () => {
    test.use({ scenario: "mid-rebase" });
    test("resolves index stages without committing or continuing the rebase", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openMerge(page);
            await expect(frame.locator(".mw-headings")).toContainText("Result");
            await acceptOurs(frame);
            await frame.getByRole("button", { name: "Apply", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["ls-files", "-u"], workspace.env))
                .toBe("");
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect((await stat(path.join(workspace.root, ".git/rebase-merge"))).isDirectory()).toBe(
                true,
            );
        } finally {
            await app.close();
        }
    });
});
