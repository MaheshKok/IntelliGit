import { ShelfStore } from "../../src/shelf/store";
import { resolveShelfPaths } from "../../src/shelf/paths";
import { readFile, readdir, writeFile, mkdir, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, test } from "./fixtureWorkspace";
import { runGitRaw as runGit } from "../fixtures/repo/gitRun";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import {
    launchFixtureWorkspace,
    dismissFirstRunDialogs,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE = "partial-target.ts";
const OTHER = "preserve.txt";
const context = Array.from({ length: 12 }, (_, index) => `// context ${index}\n`).join("");
const base = `${context}export const first = 1;\n${context}export const second = 2;\n${context}`;
const working = base.replace("first = 1", "first = 3").replace("second = 2", "second = 4");

async function createFiles(root: string, env: NodeJS.ProcessEnv): Promise<void> {
    await writeFile(path.join(root, FILE), base);
    await writeFile(path.join(root, OTHER), "base\n");
    await runGit(root, ["add", "--", FILE, OTHER], env);
    await runGit(root, ["commit", "-m", "Partial baseline", "--only", "--", FILE, OTHER], env);
    await writeFile(path.join(root, FILE), working);
    await writeFile(path.join(root, OTHER), "user staged\n");
    await runGit(root, ["add", "--", OTHER], env);
}

async function chooseFile(frame: FrameLocator): Promise<void> {
    await frame.getByRole("checkbox", { name: OTHER, exact: true }).first().uncheck();
    await frame.getByRole("checkbox", { name: FILE, exact: true }).first().check();
}

async function createList(page: Page, frame: FrameLocator, name: string): Promise<void> {
    await frame.getByRole("button", { name: "New changelist", exact: true }).click();
    const input = page.locator(".quick-input-widget .quick-input-box input");
    await expect(input).toBeVisible();
    await input.fill(name);
    await input.press("Enter");
    await expect(page.locator(".quick-input-title")).toContainText("Changelist description");
    await input.press("Enter");
    await page.getByText("Keep the current active changelist", { exact: true }).click();
    await expect(
        frame.getByRole("combobox", { name: "Changelists", exact: true }).locator("option"),
    ).toContainText([name]);
}

/** The list picker, list headers and the Partial changes action render only once a second list exists. */
async function revealLists(page: Page, frame: FrameLocator): Promise<void> {
    await createList(page, frame, "Second list");
}

test.describe("Selected changes and changelists", () => {
    test.use({ scenario: "clean" });

    test("native partial entry routes editor menus and palette to a linked worktree without Git changes", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const unsupported = "native-long-line.txt";
        await writeFile(path.join(workspace.root, unsupported), "baseline\n");
        await runGit(workspace.root, ["add", "--", unsupported], workspace.env);
        await runGit(
            workspace.root,
            ["commit", "-m", "Unsupported content baseline", "--only", "--", unsupported],
            workspace.env,
        );
        const a = await realpath(workspace.root);
        const b = path.join(a, "native-partial-b");
        await runGit(a, ["worktree", "add", "-b", "native-partial-b", b], workspace.env);
        const bWorking = base.replace("first = 1", "first = 7").replace("second = 2", "second = 8");
        await writeFile(path.join(b, FILE), base.replace("first = 1", "first = 7"));
        await runGit(b, ["add", "--", FILE], workspace.env);
        await writeFile(path.join(b, FILE), bWorking);
        const unsupportedBytes = `long line starts ${"x".repeat(17_000)}\n`;
        await writeFile(path.join(b, unsupported), unsupportedBytes);
        const gitDirB = (
            await runGit(b, ["rev-parse", "--absolute-git-dir"], workspace.env)
        ).trim();
        const metadataB = path.join(gitDirB, "intelligit/changelists/state.json");
        const settingsPath = path.join(workspace.root, ".vscode/settings.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(
            settingsPath,
            JSON.stringify({
                "diffEditor.renderSideBySide": true,
                "diffEditor.useInlineViewWhenSpaceIsLimited": false,
            }),
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
            const workbench = new Workbench(page);
            const view = new IntelliGitView(page);
            const channel = new E2eControlChannelClient(fixtureWorkspace.channelDir);
            const chooseRepository = async (name: string) => {
                await workbench.runCommand("IntelliGit: Select Repository");
                const input = page.getByPlaceholder("Select IntelliGit repository", {
                    exact: true,
                });
                await expect(input).toBeVisible();
                await input.fill(name);
                await input.press("Enter");
            };
            const selectedRepository = async () => {
                const result = await channel.request({
                    store: "memento",
                    scope: "workspace",
                    key: "intelligit.selectedRepositoryRoot",
                    operation: "snapshot",
                });
                return result.ok && result.result;
            };
            const openB = async () => {
                await page.keyboard.press("ControlOrMeta+P");
                const input = page.locator(".quick-input-widget .quick-input-box input").first();
                await input.fill(path.join(workspace.root, "native-partial-b", FILE));
                await input.press("Enter");
                await expect(
                    page
                        .locator(".editor-group-container .monaco-editor:visible .view-lines")
                        .first(),
                ).toContainText("first = 7");
            };
            const snapshot = async (root: string) => ({
                head: await runGit(root, ["rev-parse", "HEAD"], workspace.env),
                index: await readFile(
                    path.resolve(
                        root,
                        (
                            await runGit(root, ["rev-parse", "--git-path", "index"], workspace.env)
                        ).trim(),
                    ),
                ),
                worktree: await readFile(path.join(root, FILE)),
                staged: await runGit(root, ["diff", "--cached", "--binary"], workspace.env),
                unstaged: await runGit(root, ["diff", "--binary"], workspace.env),
            });
            const choosePartialSubmenu = async () => {
                const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
                await parent.click();
                const action = page.getByRole("menuitem", {
                    name: "Open Partial Changes",
                    exact: true,
                });
                if (!(await action.count())) {
                    await parent.hover();
                    await page.keyboard.press("ArrowRight");
                }
                await expect(action).toBeVisible();
                await action.hover();
                await page.keyboard.press("Enter");
            };
            await chooseRepository(path.basename(a));
            await expect.poll(selectedRepository).toMatchObject({ kind: "value", value: a });
            await openB();
            await chooseRepository("native-partial-b");
            await expect.poll(selectedRepository).toMatchObject({ kind: "value", value: b });
            await chooseRepository(path.basename(a));
            await expect.poll(selectedRepository).toMatchObject({ kind: "value", value: a });
            // Selection confirms discovery; fresh metadata stays lazy until its first workflow opens.
            const beforeA = await snapshot(a);
            const beforeB = await snapshot(b);
            for (const surface of ["title", "body", "palette", "working-diff"] as const) {
                if (surface !== "title") {
                    await openB();
                    await chooseRepository(path.basename(a));
                    await expect
                        .poll(selectedRepository)
                        .toMatchObject({ kind: "value", value: a });
                }
                if (surface === "title") {
                    await page
                        .getByRole("tab", { name: new RegExp(FILE.replace(".", "\\.")) })
                        .last()
                        .click({ button: "right" });
                    await expect(
                        page.getByRole("menuitem", { name: "IntelliGit", exact: true }),
                    ).toBeVisible();
                    await page
                        .getByRole("menuitem", { name: "Open Partial Changes", exact: true })
                        .hover();
                    await page.keyboard.press("Enter");
                } else if (surface === "body") {
                    await page
                        .locator(".editor-group-container .monaco-editor:visible .view-lines")
                        .first()
                        .click({ button: "right" });
                    await choosePartialSubmenu();
                } else if (surface === "palette") {
                    await workbench.runCommand("IntelliGit: Open Partial Changes");
                } else {
                    await page.keyboard.press("ControlOrMeta+Shift+P");
                    await page
                        .getByPlaceholder("Type the name of a command to run.", { exact: true })
                        .fill(">Git: Open Changes");
                    await page
                        .getByRole("option", { name: "Git: Open Changes", exact: true })
                        .filter({ hasText: "git.openChange" })
                        .click();
                    const workingEditor = page.locator(
                        ".monaco-diff-editor .editor.modified .view-lines:visible",
                    );
                    await expect(workingEditor).toContainText("first = 7");
                    const originalEditor = page.locator(
                        ".monaco-diff-editor .editor.original .view-lines:visible",
                    );
                    // A right-click straight from the modified side can build the menu from that
                    // side's context (it then shows Stage Selected Ranges), so settle focus first.
                    await originalEditor.click();
                    await expect(
                        page.locator(".monaco-diff-editor .editor.original .monaco-editor.focused"),
                    ).toHaveCount(1);
                    await originalEditor.click({ button: "right" });
                    const originalSubmenu = page.getByRole("menuitem", {
                        name: "IntelliGit",
                        exact: true,
                    });
                    if (await originalSubmenu.count()) await originalSubmenu.click();
                    await expect(
                        page.getByRole("menuitem", { name: "Open Partial Changes", exact: true }),
                    ).toHaveCount(0);
                    await page.keyboard.press("Escape");
                    await workbench.runCommand("IntelliGit: Open Partial Changes");
                    await expect(
                        page.getByText("Open Partial Changes is only available for local files.", {
                            exact: true,
                        }),
                    ).toBeVisible();
                    await workingEditor.click();
                    await chooseRepository(path.basename(a));
                    await expect
                        .poll(selectedRepository)
                        .toMatchObject({ kind: "value", value: a });
                    await workingEditor.click({ button: "right" });
                    await choosePartialSubmenu();
                }
                const editor = await view.revealPartialChanges(FILE);
                await expect(editor.locator(".partial-block")).toHaveCount(2);
                await expect(editor.locator(".partial-changes")).toContainText("first = 7");
                await expect(editor.locator(".partial-changes")).toContainText("second = 8");
                expect(await snapshot(a), `${surface}: selected A Git bytes`).toEqual(beforeA);
                expect(await snapshot(b), `${surface}: addressed B Git bytes`).toEqual(beforeB);
                expect(await selectedRepository()).toMatchObject({ kind: "value", value: a });
                await page.screenshot({
                    path: testInfo.outputPath(`native-partial-${surface}.png`),
                });
                const partialTab = page.getByRole("tab", { name: /Selected changes:/ });
                await partialTab.click({ button: "middle" });
                await expect(partialTab).toHaveCount(0);
            }
            await chooseRepository("native-partial-b");
            const sidebar = await view.reveal();
            await createList(page, sidebar, "Native assignment");
            await sidebar
                .getByRole("combobox", { name: "Changelists", exact: true })
                .selectOption({ label: "Native assignment" });
            await sidebar.locator("#commit-area-message").fill("preserved native draft");
            await expect
                .poll(
                    async () =>
                        JSON.parse(await readFile(metadataB, "utf8")).state.lists.find(
                            (list: { name: string }) => list.name === "Native assignment",
                        )?.draft,
                )
                .toBe("preserved native draft");
            const beforeState = JSON.parse(await readFile(metadataB, "utf8")).state;
            await openB();
            await chooseRepository(path.basename(a));
            await expect.poll(selectedRepository).toMatchObject({ kind: "value", value: a });
            await workbench.runCommand("IntelliGit: Open Partial Changes");
            const editor = await view.revealPartialChanges(FILE);
            await expect(editor.locator(".partial-block")).toHaveCount(2);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            await editor
                .getByRole("combobox", { name: "Target changelist", exact: true })
                .selectOption({ label: "Native assignment" });
            await editor.getByRole("button", { name: "Assign selected", exact: true }).click();
            await expect
                .poll(async () =>
                    Object.values(
                        JSON.parse(await readFile(metadataB, "utf8")).state.changes[FILE].lines,
                    ),
                )
                .toContain(
                    beforeState.lists.find(
                        (list: { name: string }) => list.name === "Native assignment",
                    ).id,
                );
            const afterState = JSON.parse(await readFile(metadataB, "utf8")).state;
            expect(afterState.activeId).toBe(beforeState.activeId);
            expect(afterState.lists).toEqual(beforeState.lists);
            expect(afterState.allDraft).toBe(beforeState.allDraft);
            expect(await snapshot(a)).toEqual(beforeA);
            expect(await snapshot(b)).toEqual(beforeB);
            await page.screenshot({ path: testInfo.outputPath("native-partial-assignment.png") });
            await page.getByRole("tab", { name: /Selected changes:/ }).click({ button: "middle" });
            await page.keyboard.press("ControlOrMeta+P");
            const input = page.locator(".quick-input-widget .quick-input-box input").first();
            await input.fill(path.join(b, unsupported));
            await input.press("Enter");
            await expect(
                page.locator(".editor-group-container .monaco-editor:visible .view-lines").first(),
            ).toContainText("long line starts");
            await chooseRepository(path.basename(a));
            await expect.poll(selectedRepository).toMatchObject({ kind: "value", value: a });
            await workbench.runCommand("IntelliGit: Open Partial Changes");
            // Failed loads have no file snapshot, so only the panel's generic marker exists.
            const unsupportedPanel = await view.revealPartialChanges();
            await expect(unsupportedPanel.getByRole("alert")).toHaveText(
                "Selected changes failed: Very long lines and large line counts require whole-file handling.",
            );
            await expect(unsupportedPanel.locator(".partial-block")).toHaveCount(0);
            expect(await snapshot(a), "unsupported content: selected A Git bytes").toEqual(beforeA);
            expect(await snapshot(b), "unsupported content: addressed B Git bytes").toEqual(
                beforeB,
            );
            expect(await readFile(path.join(b, unsupported), "utf8")).toBe(unsupportedBytes);
            await page.screenshot({ path: testInfo.outputPath("native-partial-unsupported.png") });
        } finally {
            await app.close();
        }
    });

    test("attributes new edits to the active list and preserves earlier ownership through reload", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const firstOnly = base.replace("first = 1", "first = 3");
        await writeFile(path.join(workspace.root, FILE), firstOnly);
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
            let sidebar = await new IntelliGitView(page).reveal();
            await createList(page, sidebar, "Later edits");
            await sidebar
                .getByRole("combobox", { name: "Changelists", exact: true })
                .selectOption({ label: "Later edits" });
            await sidebar.getByRole("button", { name: "Make active", exact: true }).click();
            await expect(
                sidebar
                    .getByRole("combobox", { name: "Changelists", exact: true })
                    .locator("option:checked"),
            ).toHaveText("Later edits (Active)");
            const shifted = `// independent header\n${working}`;
            await writeFile(path.join(workspace.root, FILE), shifted);
            await sidebar.getByTestId("commit-tab").getByTestId("refresh-button").click();
            await expect(
                sidebar.getByRole("checkbox", { name: FILE, exact: true }).first(),
            ).toBeVisible();
            await Promise.all([
                page.waitForEvent("domcontentloaded"),
                new Workbench(page).runCommand("Developer: Reload Window"),
            ]);
            sidebar = await new IntelliGitView(page).reveal();
            await sidebar
                .getByRole("combobox", { name: "Changelists", exact: true })
                .selectOption({ label: "Changes" });
            await chooseFile(sidebar);
            await sidebar.locator("#commit-area-message").fill("Earlier edit only");
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(firstOnly);
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(shifted);
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
        } finally {
            await app.close();
        }
    });

    test("amends only the All message while preserving staged and working changes", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const tree = await runGit(workspace.root, ["rev-parse", "HEAD^{tree}"], workspace.env);
        const indexTree = await runGit(workspace.root, ["write-tree"], workspace.env);
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
            const sidebar = await new IntelliGitView(page).reveal();
            await revealLists(page, sidebar);
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toHaveValue("all");
            await sidebar
                .getByRole("checkbox", { name: "Include Changes in commit", exact: true })
                .uncheck();
            await expect(
                sidebar.getByRole("checkbox", { name: FILE, exact: true }).first(),
            ).not.toBeChecked();
            await expect(
                sidebar.getByRole("checkbox", { name: OTHER, exact: true }).first(),
            ).not.toBeChecked();
            await sidebar.getByTestId("amend-checkbox").check();
            await expect(sidebar.locator("#commit-area-message")).toHaveValue("Partial baseline");
            await sidebar.locator("#commit-area-message").fill("Reviewed message-only amend");
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["log", "-1", "--format=%s"], workspace.env))
                .toBe("Reviewed message-only amend\n");
            // The subject lands before the amend's progress and index refresh finish.
            await expect(
                page.locator(".notifications-toasts .notification-toast").filter({
                    hasText: "Committing...",
                }),
            ).toHaveCount(0);
            expect(await runGit(workspace.root, ["rev-parse", "HEAD^{tree}"], workspace.env)).toBe(
                tree,
            );
            await expect
                .poll(() =>
                    runGit(workspace.root, ["write-tree"], workspace.env).catch((error: Error) => {
                        // Git still holds index.lock until the amend's refresh ends.
                        if (/index\.lock': File exists/.test(error.message)) return undefined;
                        throw error;
                    }),
                )
                .toBe(indexTree);
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            expect(await readFile(path.join(workspace.root, OTHER), "utf8")).toBe("user staged\n");
        } finally {
            await app.close();
        }
    });

    test("reviews a tracked deletion before whole-file commit and preserves unrelated staging", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const gitDir = (
            await runGit(workspace.root, ["rev-parse", "--absolute-git-dir"], workspace.env)
        ).trim();
        const metadata = path.join(gitDir, "intelligit", "changelists", "state.json");
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
            const sidebar = await new IntelliGitView(page).reveal();
            await expect
                .poll(async () =>
                    Boolean(
                        JSON.parse(await readFile(metadata, "utf8")).state.changes[FILE]?.tracking,
                    ),
                )
                .toBe(true);
            await runGit(workspace.root, ["rm", "-f", "--", FILE], workspace.env);
            await sidebar.getByTestId("commit-tab").getByTestId("refresh-button").click();
            await expect
                .poll(
                    async () =>
                        JSON.parse(await readFile(metadata, "utf8")).state.changes[FILE]?.stale,
                )
                .toBe(true);
            await chooseFile(sidebar);
            await sidebar.locator("#commit-area-message").fill("Reviewed whole-file deletion");
            const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
            const index = await runGit(workspace.root, ["ls-files", "--stage"], workspace.env);
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            const dialog = page.locator(".monaco-dialog-box");
            await expect(dialog).toContainText("stale change assignments");
            await expect(dialog).toContainText(FILE);
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect(await runGit(workspace.root, ["ls-files", "--stage"], workspace.env)).toBe(
                index,
            );
            await expect(sidebar.locator("#commit-area-message")).toHaveValue(
                "Reviewed whole-file deletion",
            );
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await dialog.getByRole("button", { name: "Commit Whole Files", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["log", "-1", "--format=%s"], workspace.env))
                .toBe("Reviewed whole-file deletion\n");
            expect(
                await runGit(workspace.root, ["ls-tree", "HEAD", "--", FILE], workspace.env),
            ).toBe("");
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
        } finally {
            await app.close();
        }
    });

    test("keeps the sidebar open when revealed twice", async ({ fixtureWorkspace }) => {
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
            const view = new IntelliGitView(page);
            const first = await view.reveal();
            await first.getByTestId("commit-panel-tab-row").click();
            const sidebar = await view.reveal();
            await expect(sidebar.getByTestId("commit-panel-tab-row")).toBeVisible();
            const item = page
                .locator(".activitybar .action-item")
                .filter({ has: page.getByLabel("IntelliGit", { exact: true }) });
            await expect(item).toHaveAttribute("aria-expanded", "true");
            await page.getByRole("button", { name: /^Toggle Primary Side Bar/ }).click();
            await expect(item).toHaveAttribute("aria-expanded", "false");
            const reopened = await view.reveal();
            await expect(reopened.getByTestId("commit-panel-tab-row")).toBeVisible();
            await expect(item).toHaveAttribute("aria-expanded", "true");
        } finally {
            await app.close();
        }
    });

    test("restores sidebar inclusion after native dirty-buffer staging refusal", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const index = await readFile(path.join(workspace.root, ".git/index"));
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
            const view = new IntelliGitView(page);
            const sidebar = await view.reveal();
            await revealLists(page, sidebar);
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await chooseFile(sidebar);
            const workbench = new Workbench(page);
            await workbench.openFile(FILE);
            const native = page.locator(".editor-group-container .monaco-editor:visible").first();
            await native.click();
            await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
            await page.keyboard.type("unsaved native draft");
            await expect(native.locator(".view-lines")).toContainText("unsaved native draft");
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await expect(editor.locator(".partial-block")).toHaveCount(2);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            await editor.getByRole("button", { name: "Stage selected", exact: true }).click();
            await expect(editor.getByRole("alert")).toContainText("Save the native editor");
            expect(await readFile(path.join(workspace.root, ".git/index"))).toEqual(index);
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            await workbench.openFile(FILE);
            await workbench.runCommand("File: Revert File");
            await expect(native.locator(".view-lines")).not.toContainText("unsaved native draft");
            await sidebar.locator("#commit-area-message").fill("Whole file after refused staging");
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(working);
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            expect(await runGit(workspace.root, ["show", `HEAD:${OTHER}`], workspace.env)).toBe(
                "base\n",
            );
        } finally {
            await app.close();
        }
    });

    test("saves selected lines to a shelf without removal and keeps cancellation harmless", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const shelfStorageRoot = path.join(workspace.profileDir, "partial-shelf-storage");
        const shelfPath = path.join(shelfStorageRoot, "shelves");
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace: { ...workspace, shelfStorageRoot },
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const view = new IntelliGitView(page);
            const sidebar = await view.reveal();
            await revealLists(page, sidebar);
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await chooseFile(sidebar);
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await expect(editor.locator(".partial-block")).toHaveCount(2);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            for (const name of [
                "Save to Shelf",
                "Save and Remove",
                "Rollback Selected Changes",
                "Export Patch",
            ])
                await expect(editor.getByRole("button", { name, exact: true })).toBeEnabled();
            const indexBefore = await readFile(path.join(workspace.root, ".git/index"));
            const headBefore = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
            const statePath = path.join(workspace.root, ".git/intelligit/changelists/state.json");
            const metadataBefore = JSON.parse(await readFile(statePath, "utf8")).state;
            const store = new ShelfStore(
                await resolveShelfPaths({
                    repositoryRoot: workspace.root,
                    globalStoragePath: shelfPath,
                    overridePath: shelfPath,
                }),
            );
            const save = editor.getByRole("button", { name: "Save to Shelf", exact: true });
            const input = page.locator(".quick-input-widget .quick-input-box input");
            await save.focus();
            await page.keyboard.press("Enter");
            await expect(input).toBeVisible();
            await input.press("Escape");
            await expect(
                editor.getByRole("status").filter({ hasText: "Save cancelled." }),
            ).toBeVisible();
            expect((await store.listShelves()).shelfIds).toHaveLength(0);
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            await save.focus();
            await page.keyboard.press("Enter");
            await expect(input).toBeVisible();
            await input.fill("Selected first edit");
            await input.press("Enter");
            await expect(
                editor.getByRole("status").filter({ hasText: "Selected changes saved in shelf" }),
            ).toBeVisible();
            const ids = (await store.listShelves()).shelfIds;
            expect(ids).toHaveLength(1);
            const manifest = await store.readCurrentShelfManifest(ids[0]);
            expect(manifest.metadata.name).toBe("Selected first edit");
            expect(manifest.files).toHaveLength(1);
            const patch = await store.readObject(
                ids[0],
                manifest.files[0].worktreeBlock!.patchObjectHash!,
            );
            expect(patch.toString()).toContain("+export const first = 3;");
            expect(patch.toString()).not.toContain("+export const second = 4;");
            expect(await readFile(path.join(workspace.root, ".git/index"))).toEqual(indexBefore);
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(
                headBefore,
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            expect(await readFile(path.join(workspace.root, OTHER), "utf8")).toBe("user staged\n");
            const metadataAfter = JSON.parse(await readFile(statePath, "utf8")).state;
            expect(metadataAfter.lists).toEqual(metadataBefore.lists);
            expect(metadataAfter.activeId).toBe(metadataBefore.activeId);
            expect(metadataAfter.changes).toEqual(metadataBefore.changes);
            await page.screenshot({ path: testInfo.outputPath("selected-shelf-saved.png") });
        } finally {
            await app.close();
        }
    });

    test("stages a block and commits the same selection from the sidebar without including other content", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
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
            const view = new IntelliGitView(page);
            const sidebar = await view.reveal();
            await revealLists(page, sidebar);
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await chooseFile(sidebar);
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await expect(editor.locator(".partial-block")).toHaveCount(2);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            await editor
                .getByRole("button", { name: "Show selection preview", exact: true })
                .click();
            await expect(editor.getByLabel("Selection preview", { exact: true })).toContainText(
                "first = 3",
            );
            await editor.getByRole("button", { name: "Stage selected", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `:${FILE}`], workspace.env))
                .toBe(base.replace("first = 1", "first = 3"));
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            await sidebar.locator("#commit-area-message").fill("Selected first block");
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(base.replace("first = 1", "first = 3"));
            expect(await runGit(workspace.root, ["show", `HEAD:${OTHER}`], workspace.env)).toBe(
                "base\n",
            );
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            await page.screenshot({ path: testInfo.outputPath("partial-sidebar-committed.png") });
        } finally {
            await app.close();
        }
    });

    test("persists named lists and split-file ownership through reload and commits only the selected list", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
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
            let view = new IntelliGitView(page);
            let sidebar = await view.reveal();
            // The list picker renders only once a second list exists.
            await createList(page, sidebar, "Feature");
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await createList(page, sidebar, "Bug");
            await chooseFile(sidebar);
            await sidebar
                .getByRole("button", { name: "Move selected changes", exact: true })
                .click();
            await page.locator(".quick-input-widget").getByText("Feature", { exact: true }).click();
            await sidebar
                .getByRole("combobox", { name: "Changelists", exact: true })
                .selectOption({ label: "Feature" });
            await sidebar.getByRole("checkbox", { name: FILE, exact: true }).first().check();
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await editor.getByRole("checkbox", { name: "Select block 0", exact: true }).uncheck();
            await editor
                .getByRole("combobox", { name: "Target changelist", exact: true })
                .selectOption({ label: "Bug" });
            await editor.getByRole("button", { name: "Assign selected", exact: true }).click();
            await expect(
                editor.getByRole("button", { name: "Assign selected", exact: true }),
            ).toBeEnabled();
            await Promise.all([
                page.waitForEvent("domcontentloaded"),
                new Workbench(page).runCommand("Developer: Reload Window"),
            ]);
            view = new IntelliGitView(page);
            sidebar = await view.reveal();
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await sidebar
                .getByRole("combobox", { name: "Changelists", exact: true })
                .selectOption({ label: "Bug" });
            await sidebar.getByRole("checkbox", { name: FILE, exact: true }).first().check();
            await expect(sidebar.getByRole("checkbox", { name: OTHER, exact: true })).toHaveCount(
                0,
            );
            await sidebar.locator("#commit-area-message").fill("Bug changelist only");
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(base.replace("second = 2", "second = 4"));
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            await page.screenshot({ path: testInfo.outputPath("changelist-after-reload.png") });
        } finally {
            await app.close();
        }
    });

    test("uses the standalone commit action and keeps syntax preview read-only", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
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
            const view = new IntelliGitView(page);
            const sidebar = await view.reveal();
            await revealLists(page, sidebar);
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await chooseFile(sidebar);
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            await editor
                .getByRole("button", { name: "Use selection for commit", exact: true })
                .click();
            await expect(
                editor.getByRole("button", { name: "Use selection for commit", exact: true }),
            ).toBeEnabled();
            await editor
                .getByRole("button", { name: "Show selection preview", exact: true })
                .click();
            const preview = editor.getByLabel("Selection preview", { exact: true });
            await expect(preview.locator('span[style*="color"]')).not.toHaveCount(0);
            await expect(preview).toHaveAttribute("contenteditable", "false");
            await editor
                .getByRole("textbox", { name: "Commit message", exact: true })
                .fill("Standalone first block");
            await editor.getByRole("button", { name: "Commit selected", exact: true }).click();
            await expect(editor.locator(".partial-commit [role=status]")).toContainText(
                "Committed",
            );
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(base.replace("first = 1", "first = 3"));
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
        } finally {
            await app.close();
        }
    });

    test("unstages indexed lines without losing a working-tree sidebar selection", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        await runGit(workspace.root, ["add", "--", FILE], workspace.env);
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
            const view = new IntelliGitView(page);
            const sidebar = await view.reveal();
            await revealLists(page, sidebar);
            await expect(
                sidebar.getByRole("combobox", { name: "Changelists", exact: true }),
            ).toBeVisible();
            await chooseFile(sidebar);
            await sidebar.getByRole("button", { name: "Partial changes", exact: true }).click();
            const editor = await view.revealPartialChanges(FILE);
            await editor.getByRole("checkbox", { name: "Select block 1", exact: true }).uncheck();
            await editor
                .getByRole("button", { name: "Use selection for commit", exact: true })
                .click();
            await expect(
                editor.getByRole("button", { name: "Use selection for commit", exact: true }),
            ).toBeEnabled();
            await editor
                .getByRole("combobox", { name: "Change source", exact: true })
                .selectOption("index");
            await expect(
                editor.getByRole("button", { name: "Unstage selected", exact: true }),
            ).toBeEnabled();
            await editor.getByRole("button", { name: "Unstage selected", exact: true }).click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `:${FILE}`], workspace.env))
                .toBe(base.replace("second = 2", "second = 4"));
            await sidebar
                .locator("#commit-area-message")
                .fill("Working inclusion survives unstage");
            await expect(sidebar.getByTestId("commit-action-commit")).toBeEnabled();
            await sidebar.getByTestId("commit-action-commit").click();
            await expect
                .poll(() => runGit(workspace.root, ["show", `HEAD:${FILE}`], workspace.env))
                .toBe(base.replace("first = 1", "first = 3"));
            expect(await runGit(workspace.root, ["show", `:${OTHER}`], workspace.env)).toBe(
                "user staged\n",
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
        } finally {
            await app.close();
        }
    });

    test("reviews and explicitly dismisses quarantined recovery without changing Git content", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const script = `
            import { execFileSync } from "node:child_process";
            import { GitExecutor } from "./src/git/executor.ts";
            import { PartialChanges } from "./src/git/partialChanges.ts";
            import { changeIds } from "./src/changes/selection.ts";
            const root = ${JSON.stringify(workspace.root)};
            const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
            const partial = new PartialChanges(new GitExecutor(root), root);
            const view = await partial.open(${JSON.stringify(FILE)});
            try {
                await partial.commit([{snapshotId:view.snapshotId,lineIds:changeIds(view.blocks.slice(0,1))}], "Interrupted selected commit", () => undefined, {
                    afterPublish: async () => {
                        const head = git(["rev-parse","HEAD"]);
                        const tree = git(["rev-parse","HEAD^{tree}"]);
                        const advanced = git(["commit-tree",tree,"-p",head,"-m","External ref movement"]);
                        git(["update-ref","HEAD",advanced,head]);
                    }
                });
                throw new Error("Publication must require recovery");
            } catch (error) {
                if (!error.message.includes("commit succeeded")) throw error;
            }
        `;
        execFileSync("bun", ["-e", script], {
            cwd: REPO_ROOT,
            env: workspace.env,
            encoding: "utf8",
        });
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const entries = await runGit(workspace.root, ["ls-files", "--stage", "-z"], workspace.env);
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
            const sidebar = await new IntelliGitView(page).reveal();
            const review = sidebar.getByRole("button", {
                name: "Review partial-index recovery",
                exact: true,
            });
            await expect(review).toBeVisible();
            const directory = path.join(workspace.root, ".git/intelligit/partial-index-quarantine");
            const [id] = await readdir(directory);
            await review.click();
            await page.locator(".quick-input-widget").getByText(id, { exact: true }).click();
            await page
                .getByRole("button", { name: "Discard recovery record", exact: true })
                .click();
            await expect(review).toHaveCount(0);
            expect(await readdir(directory)).toEqual([]);
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect(await runGit(workspace.root, ["ls-files", "--stage", "-z"], workspace.env)).toBe(
                entries,
            );
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
            await runGit(workspace.root, ["add", "--", OTHER], workspace.env);
        } finally {
            await app.close();
        }
    });

    test("reviews an unreadable recovery record without deleting a foreign index lock", async ({
        fixtureWorkspace,
    }) => {
        const { workspace } = fixtureWorkspace;
        await createFiles(workspace.root, workspace.env);
        const id = "00000000-0000-4000-8000-000000000001";
        const directory = path.join(workspace.root, ".git/intelligit/partial-index", id);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "journal.json"), "{bad json");
        const lock = path.join(workspace.root, ".git/index.lock");
        await writeFile(lock, "foreign lock preserved");
        const head = await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env);
        const index = await readFile(path.join(workspace.root, ".git/index"));
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
            const sidebar = await new IntelliGitView(page).reveal();
            const review = sidebar.getByRole("button", {
                name: "Review partial-index recovery",
                exact: true,
            });
            await expect(review).toBeVisible();
            await review.click();
            await page.locator(".quick-input-widget").getByText(id, { exact: true }).click();
            await page
                .getByRole("button", { name: "Discard recovery record", exact: true })
                .click();
            await expect(review).toHaveCount(0);
            expect(await readFile(lock, "utf8")).toBe("foreign lock preserved");
            expect(await runGit(workspace.root, ["rev-parse", "HEAD"], workspace.env)).toBe(head);
            expect(await readFile(path.join(workspace.root, ".git/index"))).toEqual(index);
            expect(await readFile(path.join(workspace.root, FILE), "utf8")).toBe(working);
        } finally {
            await app.close();
        }
    });
});
