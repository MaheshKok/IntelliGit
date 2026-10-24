import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Locator, Page, TestInfo } from "@playwright/test";
import l10nBundle from "../../l10n/bundle.l10n.json";
import enCatalog from "../../src/webviews/i18n/en.json";
import { ShelfStore } from "../../src/shelf/store";
import { resolveShelfPaths } from "../../src/shelf/paths";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import { runGitRaw } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";

/**
 * Keyboard-only changelist journeys in a real VS Code window. After launch nothing is clicked:
 * focus moves with Tab/Shift+Tab/arrows and actions fire with Enter/Space/Escape/Shift+F10.
 * `tabTo` proves each control is reachable in the Tab order rather than focusing it by script.
 */

const REPO_ROOT = path.resolve(__dirname, "../..");
const MOD = process.platform === "darwin" ? "Meta" : "Control";
// 78 characters: long enough to need truncation, inside the 80-character name limit.
const LONG_NAME = `Überprüfung 名前 ${"long list name ".repeat(4)}end`;
const RENAMED = "Renamed 改名 list";

type Workspace = FixtureWorkspaceFixture["workspace"];

/** Host prompt text, read from the extension's own catalog so a reworded prompt fails loudly. */
function hostText(key: string, holes: Record<string, string> = {}): string {
    const value = (l10nBundle as Record<string, string>)[key];
    if (value === undefined) throw new Error(`l10n/bundle.l10n.json has no entry "${key}".`);
    return value.replace(/\{(\w+)\}/g, (match, hole: string) => holes[hole] ?? match);
}

function webviewText(key: keyof typeof enCatalog, holes: Record<string, string> = {}): string {
    const value = enCatalog[key];
    if (typeof value !== "string") throw new Error(`en.json has no string "${key}".`);
    return value.replace(/\{(\w+)\}/g, (match, hole: string) => holes[hole] ?? match);
}

async function git(workspace: Workspace, args: string[]): Promise<string> {
    return (await runGitRaw(workspace.root, args, workspace.env)).trim();
}

/** Two committed files, both modified in the working tree. */
async function seedTwoChangedFiles(workspace: Workspace): Promise<void> {
    await writeFile(path.join(workspace.root, "a.txt"), "a\n");
    await writeFile(path.join(workspace.root, "b.txt"), "b\n");
    await git(workspace, ["add", "--", "a.txt", "b.txt"]);
    await git(workspace, ["commit", "-m", "Keyboard base"]);
    await writeFile(path.join(workspace.root, "a.txt"), "a\nchanged\n");
    await writeFile(path.join(workspace.root, "b.txt"), "b\nchanged\n");
}

function shelfStorage(workspace: Workspace): string {
    return path.join(workspace.profileDir, "keyboard-shelf-storage");
}

async function shelves(workspace: Workspace): Promise<ShelfStore> {
    const shelfPath = path.join(shelfStorage(workspace), "shelves");
    return new ShelfStore(
        await resolveShelfPaths({
            repositoryRoot: workspace.root,
            globalStoragePath: shelfPath,
            overridePath: shelfPath,
        }),
    );
}

async function launch(fixtureWorkspace: FixtureWorkspaceFixture) {
    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(REPO_ROOT),
        repoRoot: REPO_ROOT,
        workspace: {
            ...fixtureWorkspace.workspace,
            shelfStorageRoot: shelfStorage(fixtureWorkspace.workspace),
        },
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    const page = await app.firstWindow();
    await dismissFirstRunDialogs(page);
    await waitForE2eChannelReady(fixtureWorkspace.channelDir);
    return { app, page };
}

const quickInput = (page: Page) => page.locator(".quick-input-widget");
const quickInputBox = (page: Page) => page.locator(".quick-input-widget .quick-input-box input");

/** Command palette by keyboard only: chord, type, Enter on the exact label. */
async function keyboardCommand(page: Page, label: string): Promise<void> {
    const input = page.getByPlaceholder("Type the name of a command to run.", { exact: true });
    for (let attempt = 1; ; attempt++) {
        try {
            await page.keyboard.press(attempt % 2 ? `${MOD}+Shift+P` : "F1");
            await input.waitFor({ state: "visible", timeout: 3000 });
            await page.keyboard.type(label);
            await expect(
                quickInput(page).locator(".monaco-list-row.focused"),
                `palette highlights "${label}"`,
            ).toContainText(label, { timeout: 3000 });
            await page.keyboard.press("Enter");
            await input.waitFor({ state: "hidden", timeout: 3000 });
            return;
        } catch (error) {
            // A cold window can drop the first chord; the palette also closes when focus moves.
            if (attempt === 5) {
                const where = await page.evaluate(() => {
                    const active = document.activeElement;
                    return `${active?.tagName}.${active?.className} title=${active?.getAttribute("title")} hasFocus=${document.hasFocus()}`;
                });
                throw new Error(`Palette never opened; workbench focus: ${where}`, {
                    cause: error,
                });
            }
            await page.keyboard.press("Escape");
        }
    }
}

/** The IntelliGit webview whose document renders `marker`, found without clicking anything. */
async function frameWith(page: Page, marker: string): Promise<FrameLocator> {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        for (const outer of await page.locator("iframe.webview").all()) {
            const inner = outer.contentFrame().locator("iframe#active-frame").contentFrame();
            if (
                (await inner
                    .locator(marker)
                    .count()
                    .catch(() => 0)) > 0
            )
                return inner;
        }
        await page.waitForTimeout(250);
    }
    throw new Error(`No webview rendered ${marker}`);
}

async function openSidebar(page: Page): Promise<FrameLocator> {
    await keyboardCommand(page, "View: Show IntelliGit");
    const frame = await frameWith(page, '[data-testid="commit-panel-tab-row"]');
    // Toolbar controls are disabled until the host finishes its first reconcile.
    await expect(
        frame.getByRole("button", { name: webviewText("changes.newList"), exact: true }),
    ).toBeEnabled({ timeout: 30_000 });
    return frame;
}

const isFocused = (target: Locator) =>
    target
        .evaluateAll((elements) =>
            elements.some((element) => element === element.ownerDocument.activeElement),
        )
        .catch(() => false);

/** What holds focus in `target`'s document, named so a failure shows where focus went. */
const focusOf = (target: Locator) =>
    target
        .evaluateAll((elements) => {
            const active = elements[0]?.ownerDocument.activeElement;
            if (elements.some((element) => element === active)) return "target";
            return `${active?.tagName} ${active?.getAttribute("aria-label") ?? active?.textContent?.slice(0, 40)}`;
        })
        .catch((error: Error) => error.message);

/**
 * `toBeFocused` also demands `document.hasFocus()`, which depends on the OS window and the
 * workbench, not the webview. Keys go to the document's active element, so assert that.
 */
const expectFocused = (target: Locator, message: string) =>
    expect.poll(() => focusOf(target), { message, timeout: 5000 }).toBe("target");

/** Presses Tab (or Shift+Tab) until `target` holds focus; fails if it is not in the Tab order. */
async function tabTo(page: Page, target: Locator, backward = false): Promise<void> {
    for (let presses = 0; presses < 90; presses++) {
        if (await isFocused(target)) return;
        await page.keyboard.press(backward ? "Shift+Tab" : "Tab");
    }
    throw new Error(`Keyboard Tab order never reached ${target}`);
}

/** Presses `key` until `target` holds focus (roving focus inside lists and tab strips). */
async function arrowTo(page: Page, target: Locator, key: string, max = 8): Promise<void> {
    for (let presses = 0; presses <= max; presses++) {
        if (await isFocused(target)) return;
        await page.keyboard.press(key);
    }
    throw new Error(`${key} never reached ${target}`);
}

async function readState(workspace: Workspace) {
    const statePath = path.join(workspace.root, ".git/intelligit/changelists/state.json");
    return JSON.parse(await readFile(statePath, "utf8")).state as {
        activeId: string;
        lists: { id: string; name: string; draft: string }[];
        files: Record<string, string>;
        changes: Record<string, { lines?: Record<string, string> } | undefined>;
    };
}

/** Names of the lists that own `file`, line by line when ranges exist, else by the file entry. */
async function owners(workspace: Workspace, file: string): Promise<string[]> {
    const state = await readState(workspace);
    const lines = Object.values(state.changes[file]?.lines ?? {});
    const ids = lines.length ? lines : [state.files[file] ?? state.activeId];
    return [...new Set(ids)].map((id) => state.lists.find((list) => list.id === id)?.name ?? id);
}

async function listId(workspace: Workspace, name: string): Promise<string> {
    let id: string | undefined;
    await expect
        .poll(
            async () => {
                id = (await readState(workspace)).lists.find((list) => list.name === name)?.id;
                return id;
            },
            { message: `metadata has a list named ${name}` },
        )
        .toBeTruthy();
    return id!;
}

const header = (frame: FrameLocator, id: string) => frame.locator(`[data-changelist-id="${id}"]`);
const fileCheckbox = (frame: FrameLocator, file: string) =>
    frame.getByRole("checkbox", { name: file, exact: true }).first();

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    const file = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(name, { path: file, contentType: "image/png" });
}

test.describe("Changelists by keyboard only", () => {
    test.use({ scenario: "clean" });

    test("create, rename, activate, move, open diff and delete with accessible states", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await seedTwoChangedFiles(workspace);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            const frame = await openSidebar(page);
            const defaultList = (await readState(workspace)).lists[0]!;
            await expect(
                header(frame, defaultList.id),
                "active list carries a text label, not colour alone",
            ).toContainText(webviewText("changes.active"));

            // Create: name dialog, description dialog, active-choice picker.
            await tabTo(
                page,
                frame.getByRole("button", { name: webviewText("changes.newList"), exact: true }),
            );
            await page.keyboard.press("Enter");
            await expect(quickInput(page)).toContainText(hostText("New changelist"));
            await page.keyboard.type(LONG_NAME);
            await page.keyboard.press("Enter");
            await expect(quickInput(page)).toContainText(hostText("Changelist description"));
            await page.keyboard.press("Enter");
            await expect(quickInput(page).locator(".monaco-list-row.focused")).toContainText(
                hostText("Keep the current active changelist"),
            );
            await page.keyboard.press("Enter");
            const created = await listId(workspace, LONG_NAME);
            const createdHeader = header(frame, created);
            const toggle = createdHeader.locator("button[aria-expanded]");
            await expect(
                toggle,
                "long Unicode name is the group's accessible name",
            ).toHaveAccessibleName(LONG_NAME);
            await expect(createdHeader.locator("button[aria-pressed]")).toHaveText(LONG_NAME);
            await expect(createdHeader).not.toContainText(webviewText("changes.active"));
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await tabTo(page, toggle);
            await page.keyboard.press("Enter");
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            await expect(
                createdHeader.getByRole("group", { name: LONG_NAME, exact: true }),
                "empty group renders its empty-state text",
            ).toHaveText(webviewText("changes.emptyList"));
            await expect(
                createdHeader.getByRole("checkbox", {
                    name: webviewText("changes.includeList", { name: LONG_NAME }),
                }),
            ).toBeDisabled();
            await shot(page, testInfo, "keyboard-created-empty-unicode-list");

            // Tri-state: one of two files checked leaves the group checkbox mixed.
            const defaultBox = header(frame, defaultList.id).getByRole("checkbox", {
                name: webviewText("changes.includeList", { name: defaultList.name }),
            });
            await expect(defaultBox).toBeChecked({ checked: false });
            await tabTo(page, fileCheckbox(frame, "a.txt"));
            await page.keyboard.press("Space");
            await expect(fileCheckbox(frame, "a.txt")).toBeChecked();
            await expect(defaultBox, "partial group inclusion is announced as mixed").toBeChecked({
                indeterminate: true,
            });
            await expect(
                header(frame, defaultList.id),
                "partial inclusion carries a text label, not the mixed glyph alone",
            ).toContainText(webviewText("changes.partialInclusion"));

            // Move the checked file through the native picker.
            await tabTo(
                page,
                frame.getByRole("button", {
                    name: webviewText("changes.moveSelected"),
                    exact: true,
                }),
            );
            await page.keyboard.press("Enter");
            await expect(quickInput(page)).toContainText(hostText("Move selected changes"));
            await page.keyboard.type("Überprüfung");
            await expect(quickInput(page).locator(".monaco-list-row.focused")).toContainText(
                LONG_NAME,
            );
            await page.keyboard.press("Enter");
            await expect.poll(() => owners(workspace, "a.txt")).toEqual([LONG_NAME]);
            await expect(
                header(frame, created).getByRole("checkbox", {
                    name: webviewText("changes.includeList", { name: LONG_NAME }),
                }),
            ).toBeChecked();
            await expect(defaultBox, "remaining unchecked group is unchecked").toBeChecked({
                checked: false,
            });
            await expect(header(frame, defaultList.id)).not.toContainText(
                webviewText("changes.partialInclusion"),
            );
            await shot(page, testInfo, "keyboard-moved-file-tri-state");

            // Rename from the list's action menu.
            const actions = frame.getByRole("button", {
                name: webviewText("changes.listActions", { name: LONG_NAME }),
                exact: true,
            });
            await tabTo(page, actions);
            await page.keyboard.press("Enter");
            await expect(frame.getByRole("menu")).toBeVisible();
            const edit = frame.getByRole("menuitem", {
                name: webviewText("changes.editList"),
                exact: true,
            });
            await tabTo(page, edit);
            await page.keyboard.press("Enter");
            await expect(quickInput(page)).toContainText(hostText("Rename changelist"));
            await expect(quickInputBox(page)).toHaveValue(LONG_NAME);
            await page.keyboard.press(`${MOD}+A`);
            await page.keyboard.type(RENAMED);
            await page.keyboard.press("Enter");
            await expect(quickInput(page)).toContainText(hostText("Changelist description"));
            await page.keyboard.press("Enter");
            await expect
                .poll(async () => (await readState(workspace)).lists.map((l) => l.name))
                .toContain(RENAMED);

            // Activate: select the list's scope, then Make active.
            const scope = header(frame, created).locator("button[aria-pressed]");
            await tabTo(page, scope);
            await page.keyboard.press("Enter");
            await expect(scope).toHaveAttribute("aria-pressed", "true");
            await tabTo(
                page,
                frame.getByRole("button", { name: webviewText("changes.makeActive"), exact: true }),
            );
            await page.keyboard.press("Enter");
            await expect.poll(async () => (await readState(workspace)).activeId).toBe(created);
            await expect(header(frame, created)).toContainText(webviewText("changes.active"));
            await expect(header(frame, defaultList.id)).not.toContainText(
                webviewText("changes.active"),
            );
            await shot(page, testInfo, "keyboard-renamed-active-list");

            // Open the file's change view: check it in this list's scope, then Partial changes.
            // Enter on the checkbox toggles nothing and opens nothing, so the toolbar is the path.
            const scoped = fileCheckbox(frame, "a.txt");
            if (!(await scoped.isChecked())) {
                await tabTo(page, scoped);
                await page.keyboard.press("Space");
            }
            await expect(scoped).toBeChecked();
            await tabTo(
                page,
                frame.getByRole("button", { name: webviewText("changes.partial"), exact: true }),
            );
            await page.keyboard.press("Enter");
            const editor = await new IntelliGitView(page).revealPartialChanges("a.txt");
            await expect(editor.locator(".partial-toolbar strong")).toHaveText("a.txt");
            // VS Code can park focus on the new webview's host page before the editor renders;
            // workbench keys (the palette) are dropped there until focus reaches a control.
            await tabTo(
                page,
                editor.getByRole("combobox", { name: webviewText("changes.source"), exact: true }),
            );
            await shot(page, testInfo, "keyboard-opened-file-changes");

            // Delete: survivor picker, then the modal confirmation.
            const sidebar = await openSidebar(page);
            await expect(header(sidebar, created).locator("button[aria-pressed]")).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await tabTo(
                page,
                sidebar.getByRole("button", {
                    name: webviewText("changes.removeList"),
                    exact: true,
                }),
            );
            await page.keyboard.press("Enter");
            await expect(quickInput(page)).toContainText(
                hostText("Move remaining changes to changelist"),
            );
            await expect(quickInput(page).locator(".monaco-list-row.focused")).toContainText(
                defaultList.name,
            );
            await page.keyboard.press("Enter");
            const dialog = page.locator(".monaco-dialog-box");
            await expect(dialog).toContainText(
                hostText(
                    "Remove {source} and move its changes to {target}? File content and staging are preserved.",
                    { source: RENAMED, target: defaultList.name },
                ),
            );
            await tabTo(
                page,
                dialog.getByRole("button", { name: hostText("Remove"), exact: true }),
            );
            await page.keyboard.press("Enter");
            await expect
                .poll(async () => (await readState(workspace)).lists.map((list) => list.name))
                .toEqual([defaultList.name]);
            await expect.poll(() => owners(workspace, "a.txt")).toEqual([defaultList.name]);
            expect(await readFile(path.join(workspace.root, "a.txt"), "utf8")).toBe("a\nchanged\n");
            await expect(header(sidebar, created)).toHaveCount(0);
            await shot(page, testInfo, "keyboard-deleted-list");
        } finally {
            await app.close();
        }
    });

    test("cancelling list and file Save to Shelf creates nothing; the list menu keeps focus", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await seedTwoChangedFiles(workspace);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            const frame = await openSidebar(page);
            const store = await shelves(workspace);
            const before = await readState(workspace);
            await tabTo(page, fileCheckbox(frame, "a.txt"));
            await page.keyboard.press("Space");
            await expect(fileCheckbox(frame, "a.txt")).toBeChecked();

            const whole = frame.getByRole("button", {
                name: webviewText("changes.saveSelectedWholeFiles"),
                exact: true,
            });
            await tabTo(page, whole);
            await page.keyboard.press("Enter");
            await expect(quickInputBox(page)).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(quickInputBox(page)).toBeHidden();
            await expect(whole, "a cancelled file save leaves the button usable").toBeEnabled();
            await shot(page, testInfo, "keyboard-file-save-cancelled");

            // Focus is back on the Save button, so the list menu is reached from there.
            const actions = frame.getByRole("button", {
                name: webviewText("changes.listActions", { name: before.lists[0]!.name }),
                exact: true,
            });
            const save = frame.getByRole("menuitem", {
                name: webviewText("changes.saveToShelf"),
                exact: true,
            });
            await tabTo(page, actions);
            await page.keyboard.press("Enter");
            await expectFocused(save, "opening the menu moves focus to its first action");
            await page.keyboard.press("Escape");
            await expect(frame.getByRole("menu")).toHaveCount(0);
            await expectFocused(actions, "Escape on the menu returns focus to its button");
            // Focus is real: Enter on the returned focus reopens the same list's menu.
            await page.keyboard.press("Enter");
            await expectFocused(save, "reopened menu focuses its first action");
            await page.keyboard.press("Enter");
            await expect(quickInputBox(page)).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(quickInputBox(page)).toBeHidden();
            await expect(frame.getByRole("menu")).toHaveCount(0);
            await shot(page, testInfo, "keyboard-list-save-cancelled");

            expect((await store.listShelves()).shelfIds, "cancelled saves create no shelf").toEqual(
                [],
            );
            const after = await readState(workspace);
            expect(after.lists).toEqual(before.lists);
            expect(after.files).toEqual(before.files);
        } finally {
            await app.close();
        }
    });

    test("a cancelled Save to Shelf prompt returns focus to the control that opened it", async ({
        fixtureWorkspace,
    }) => {
        // On its own VS Code 1.137 leaves workbench focus on the editor group after Escape, and the
        // disabled button drops to <body>; the host refocuses the view and the webview its opener.
        const { workspace } = fixtureWorkspace;
        await seedTwoChangedFiles(workspace);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            const frame = await openSidebar(page);
            await tabTo(page, fileCheckbox(frame, "a.txt"));
            await page.keyboard.press("Space");
            const whole = frame.getByRole("button", {
                name: webviewText("changes.saveSelectedWholeFiles"),
                exact: true,
            });
            await tabTo(page, whole);
            await page.keyboard.press("Enter");
            await expect(quickInputBox(page)).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(quickInputBox(page)).toBeHidden();
            await expect(whole, "the opener holds focus in a focused webview").toBeFocused();
            // Keys reach it: Enter reopens the same prompt without any script focus.
            await page.keyboard.press("Enter");
            await expect(quickInputBox(page)).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(whole).toBeFocused();
        } finally {
            await app.close();
        }
    });

    // One window per destination: after a restore the shelf can stay open for review and refuse
    // a second mutation as busy, which would couple the two journeys.
    for (const newList of [undefined, "Restored 新しい list"]) {
        test(`restore a shelf into ${newList ? "a new" : "an existing"} list`, async ({
            fixtureWorkspace,
        }, testInfo) => {
            const { workspace } = fixtureWorkspace;
            await seedTwoChangedFiles(workspace);
            const { app, page } = await launch(fixtureWorkspace);
            try {
                const frame = await openSidebar(page);
                const defaultName = (await readState(workspace)).lists[0]!.name;
                // An existing destination must not be the active list, or ownership cannot
                // tell a targeted restore from the default assignment.
                const destination = newList ?? "Target リスト";
                if (!newList) {
                    await tabTo(
                        page,
                        frame.getByRole("button", {
                            name: webviewText("changes.newList"),
                            exact: true,
                        }),
                    );
                    await page.keyboard.press("Enter");
                    await expect(quickInput(page)).toContainText(hostText("New changelist"));
                    await page.keyboard.type(destination);
                    await page.keyboard.press("Enter");
                    await expect(quickInput(page)).toContainText(
                        hostText("Changelist description"),
                    );
                    await page.keyboard.press("Enter");
                    await expect(
                        quickInput(page).locator(".monaco-list-row.focused"),
                    ).toContainText(hostText("Keep the current active changelist"));
                    await page.keyboard.press("Enter");
                    await listId(workspace, destination);
                }
                await tabTo(page, fileCheckbox(frame, "a.txt"));
                await page.keyboard.press("Space");
                await expect(fileCheckbox(frame, "a.txt")).toBeChecked();
                const whole = frame.getByRole("button", {
                    name: webviewText("changes.saveSelectedWholeFiles"),
                    exact: true,
                });
                await tabTo(page, whole);
                await page.keyboard.press("Enter");
                await expect(quickInputBox(page)).toBeVisible();
                await page.keyboard.type("Alpha shelf");
                await page.keyboard.press("Enter");
                // The webview re-enables the button when the host replies. The store is not read
                // here: a store read takes the shelf lock the extension needs.
                await expect(whole, "the save finished").toBeEnabled({ timeout: 30_000 });
                // Clean the worktree outside the UI so restored content is unambiguous.
                await git(workspace, ["checkout", "--", "a.txt"]);

                const shelfTab = frame.getByRole("tab", {
                    name: webviewText("commit.tab.shelf"),
                });
                await tabTo(page, frame.getByRole("tab", { selected: true }));
                await arrowTo(page, shelfTab, "ArrowRight");
                if ((await shelfTab.getAttribute("aria-selected")) !== "true")
                    await page.keyboard.press("Enter");
                await expect(shelfTab).toHaveAttribute("aria-selected", "true");

                const shelfRow = frame.locator('[aria-level="1"][title="Alpha shelf"]');
                await expect(shelfRow, "the saved shelf is listed").toHaveCount(1);
                await tabTo(page, shelfRow);
                // Not the Unshelve chord: Cmd/Ctrl+Shift+U also toggles VS Code's Output panel,
                // which takes focus away from the dialog. The row's own menu is the keyboard path.
                await page.keyboard.press("Shift+F10");
                const unshelveItem = frame.getByRole("menuitem", {
                    name: webviewText("shelf.action.unshelveMenu"),
                });
                await expect(unshelveItem).toBeVisible();
                await tabTo(page, unshelveItem);
                await page.keyboard.press("Enter");
                const dialog = frame.getByRole("dialog", {
                    name: webviewText("shelf.dialog.unshelve.title"),
                });
                await expect(dialog).toBeVisible();
                await expectFocused(
                    dialog.getByRole("button", { name: webviewText("common.cancel"), exact: true }),
                    "Unshelve dialog opens with focus on Cancel",
                );
                await tabTo(
                    page,
                    dialog.getByRole("button", {
                        name: webviewText("shelf.action.unshelve"),
                        exact: true,
                    }),
                );
                await page.keyboard.press("Enter");
                await expect(quickInputBox(page)).toHaveAttribute(
                    "placeholder",
                    hostText("Select a destination changelist"),
                );
                if (newList) {
                    await page.keyboard.type(hostText("Create New Changelist…").slice(0, 10));
                    await expect(
                        quickInput(page).locator(".monaco-list-row.focused"),
                    ).toContainText(hostText("Create New Changelist…"));
                    await page.keyboard.press("Enter");
                    await expect(quickInput(page)).toContainText(
                        hostText("Name the new destination changelist"),
                    );
                    await page.keyboard.press(`${MOD}+A`);
                    await page.keyboard.type(newList);
                } else {
                    await page.keyboard.type(destination.slice(0, 6));
                    await expect(
                        quickInput(page).locator(".monaco-list-row.focused"),
                    ).toContainText(destination);
                }
                await page.keyboard.press("Enter");
                // Whole-file shelves record their source list, so the draft choice follows.
                await expect(quickInputBox(page)).toHaveAttribute(
                    "placeholder",
                    hostText("Choose how to handle the destination draft"),
                );
                await expect(quickInput(page).locator(".monaco-list-row.focused")).toContainText(
                    hostText("Keep Destination Draft"),
                );
                await page.keyboard.press("Enter");

                await expect
                    .poll(() => readFile(path.join(workspace.root, "a.txt"), "utf8"))
                    .toBe("a\nchanged\n");
                await expect.poll(() => owners(workspace, "a.txt")).toEqual([destination]);
                expect((await readState(workspace)).lists.map((list) => list.name)).toEqual([
                    defaultName,
                    destination,
                ]);
                expect((await readState(workspace)).activeId).toBe(
                    (await readState(workspace)).lists[0]!.id,
                );
                await shot(
                    page,
                    testInfo,
                    newList
                        ? "keyboard-restored-to-new-list"
                        : "keyboard-restored-to-existing-list",
                );
            } finally {
                await app.close();
            }
        });
    }

    test("undo a commit into a new list from the Git Log", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const subject = "Keyboard undo target";
        await writeFile(path.join(workspace.root, "u.txt"), "u0\n");
        await git(workspace, ["add", "--", "u.txt"]);
        await git(workspace, ["commit", "-m", "Keyboard undo base"]);
        await writeFile(path.join(workspace.root, "u.txt"), "u0\nundo me\n");
        await git(workspace, ["add", "--", "u.txt"]);
        await git(workspace, ["commit", "-m", subject]);
        const undone = await git(workspace, ["rev-parse", "HEAD"]);
        const parent = await git(workspace, ["rev-parse", "HEAD^"]);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            await keyboardCommand(page, "IntelliGit: Show Git Log");
            const graph = await frameWith(page, '[data-testid="commit-list-viewport"]');
            const row = graph
                .getByTestId("commit-list-viewport")
                .getByRole("button")
                .filter({ hasText: subject });
            await expect(row).toHaveCount(1);
            await tabTo(page, row);
            await page.keyboard.press("Shift+F10");
            const undo = graph.getByRole("menuitem", {
                name: webviewText("commit.menu.undoCommit"),
                exact: true,
            });
            await expect(undo, "Shift+F10 opens the commit menu from the keyboard").toBeVisible();
            await tabTo(page, undo);
            await page.keyboard.press("Enter");
            const dialog = page.locator(".monaco-dialog-box");
            await expect(dialog).toBeVisible();
            await tabTo(page, dialog.getByRole("button", { name: hostText("Undo"), exact: true }));
            await page.keyboard.press("Enter");
            await expect(quickInputBox(page)).toHaveAttribute(
                "placeholder",
                hostText("Select a destination changelist"),
            );
            await page.keyboard.type(hostText("Create New Changelist…").slice(0, 10));
            await page.keyboard.press("Enter");
            await expect(quickInput(page)).toContainText(
                hostText("Name the new destination changelist"),
            );
            await page.keyboard.type("Undone 取消");
            await page.keyboard.press("Enter");
            await expect(quickInputBox(page)).toHaveAttribute(
                "placeholder",
                hostText("Choose how to handle the destination draft"),
            );
            await expect(quickInput(page).locator(".monaco-list-row.focused")).toContainText(
                hostText("Keep Destination Draft"),
            );
            await page.keyboard.press("Enter");
            await expect.poll(() => git(workspace, ["rev-parse", "HEAD"])).toBe(parent);
            await expect.poll(() => owners(workspace, "u.txt")).toEqual(["Undone 取消"]);
            expect(await readFile(path.join(workspace.root, "u.txt"), "utf8")).toBe(
                "u0\nundo me\n",
            );
            expect(undone).not.toBe(parent);
            await shot(page, testInfo, "keyboard-undo-commit-to-list");
        } finally {
            await app.close();
        }
    });
});
