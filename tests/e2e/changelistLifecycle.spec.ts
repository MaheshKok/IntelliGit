import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Locator, Page, TestInfo } from "@playwright/test";
import l10nBundle from "../../l10n/bundle.l10n.json";
import enCatalog from "../../src/webviews/i18n/en.json";
import { RepositoryLockBusyError } from "../../src/git/repositoryLock";
import { resolveShelfPaths } from "../../src/shelf/paths";
import { ShelfStore } from "../../src/shelf/store";
import { runGitRaw } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE = "lifecycle-名前.txt";
const OTHER = "lifecycle-other.txt";
const SELECTED_REPO = "selected-repo";
const SELECTED_ONLY = "selected-only.txt";
const PICK_BRANCH = "lifecycle-pick";
// ChangeWorkflowHost replies with these literals; they have no l10n/bundle.l10n.json entry to read.
const SAVE_CANCELLED = "Save cancelled.";
const SAVED_UNCHANGED = /^Shelf (\S+) was saved\. Local changes are unchanged\.$/;

type Workspace = FixtureWorkspaceFixture["workspace"];

/** Host prompt text, read from the extension's own catalog so a reworded prompt fails loudly. */
function hostText(key: string): string {
    const value = (l10nBundle as Record<string, string>)[key];
    if (value === undefined) throw new Error(`l10n/bundle.l10n.json has no entry "${key}".`);
    return value;
}

function webviewText(key: keyof typeof enCatalog): string {
    const value = enCatalog[key];
    if (typeof value !== "string") throw new Error(`en.json has no string "${key}".`);
    return value;
}

/** Catalog template as a regex; `{short}` is any abbreviation of `hash`. */
function catalogPattern(template: string, hash: string): RegExp {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escape(template).replace(/\\\{short\\\}/g, `${hash.slice(0, 4)}[0-9a-f]*`));
}

const git = async (root: string, args: string[], workspace: Workspace) =>
    (await runGitRaw(root, args, workspace.env)).trim();

/** Commits both fixture files, then leaves an unstaged edit in each. */
async function seedChanges(root: string, workspace: Workspace, edit = "edited"): Promise<void> {
    await writeFile(path.join(root, FILE), "base\n");
    await writeFile(path.join(root, OTHER), "other\n");
    await git(root, ["add", "--", FILE, OTHER], workspace);
    await git(root, ["commit", "-m", "Lifecycle baseline"], workspace);
    await writeFile(path.join(root, FILE), `base\n${edit}\n`);
    await writeFile(path.join(root, OTHER), `other\n${edit}\n`);
}

/** Nested clone at `selected-repo/` that the workspace discovers as a second repository. */
async function addSelectedRepository(workspace: Workspace): Promise<string> {
    const exclude = path.join(workspace.root, ".git/info/exclude");
    await writeFile(exclude, `${await readFile(exclude, "utf8")}\n${SELECTED_REPO}/\n`);
    const selected = path.join(workspace.root, SELECTED_REPO);
    await git(
        workspace.root,
        ["clone", "--no-hardlinks", "--", workspace.root, selected],
        workspace,
    );
    await writeFile(path.join(selected, FILE), "base\nselected edit\n");
    await writeFile(path.join(selected, OTHER), "other\nselected edit\n");
    await writeFile(path.join(selected, SELECTED_ONLY), "only here\n");
    return selected;
}

/**
 * Puts a logging `git` first on PATH. While `armed` exists, any call whose working directory is
 * `holdRoot` waits for `release`, so a reply can be held across a lifecycle event.
 */
async function installGitProbe(workspace: Workspace, holdRoot = workspace.root) {
    const directory = path.join(path.dirname(workspace.profileDir), "lifecycle-git-probe");
    const held = path.join(directory, "held");
    await mkdir(held, { recursive: true });
    const log = path.join(directory, "calls.log");
    const armed = path.join(directory, "armed");
    const release = path.join(directory, "release");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(directory, "git");
    await writeFile(
        wrapper,
        `#!/bin/sh
here=$(pwd -P)
printf '%s\\t%s\\n' "$here" "$*" >> "${log}"
if [ -f "${armed}" ] && [ "$here" = "${await realpath(holdRoot)}" ]; then
    : > "${held}/$$"
    while [ ! -f "${release}" ]; do /bin/sleep 0.02; done
    rm -f "${held}/$$"
fi
exec "${realGit}" "$@"
`,
    );
    await chmod(wrapper, 0o755);
    workspace.env.PATH = `${directory}:${workspace.env.PATH ?? ""}`;
    return {
        arm: () => writeFile(armed, ""),
        release: () => writeFile(release, ""),
        heldCount: async () => (await readdir(held)).length,
        /** Working-tree `git apply` runs (not `--check`, not a scratch `-C` directory). */
        applies: async () =>
            (await readFile(log, "utf8").catch(() => ""))
                .split("\n")
                .map((line) => line.split("\t")[1]?.split(" ") ?? [])
                .filter(
                    (args) =>
                        args[0] === "apply" && !args.includes("--check") && !args.includes("-C"),
                ),
    };
}

async function launch(
    fixtureWorkspace: FixtureWorkspaceFixture,
    workspace: Workspace = fixtureWorkspace.workspace,
    channelDir = fixtureWorkspace.channelDir,
) {
    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(REPO_ROOT),
        repoRoot: REPO_ROOT,
        workspace,
        channelDir,
        timeout: 60_000,
    });
    const page = await app.firstWindow();
    await dismissFirstRunDialogs(page);
    await waitForE2eChannelReady(channelDir);
    return { app, page };
}

async function readState(root: string) {
    const statePath = path.join(root, ".git/intelligit/changelists/state.json");
    return JSON.parse(await readFile(statePath, "utf8")).state as {
        activeId: string;
        lists: { id: string; name: string }[];
        files: Record<string, string>;
        pendingTargetOperation?: unknown;
    };
}

const listNames = async (root: string) => (await readState(root)).lists.map((list) => list.name);

async function shelvesOf(root: string, shelfPath: string) {
    const store = new ShelfStore(
        await resolveShelfPaths({
            repositoryRoot: root,
            globalStoragePath: shelfPath,
            overridePath: shelfPath,
        }),
    );
    // The store lock is shared with the running extension; wait out its mutations, never fail on one.
    const deadline = Date.now() + 30_000;
    let shelfIds: readonly string[] | undefined;
    while (!shelfIds) {
        try {
            ({ shelfIds } = await store.listShelves());
        } catch (error) {
            if (!(error instanceof RepositoryLockBusyError) || Date.now() > deadline) throw error;
        }
    }
    return Promise.all(
        shelfIds.map(async (id) => ({ id, ...(await store.readCurrentShelfManifest(id)) })),
    );
}

const quickInput = (page: Page) => page.locator(".quick-input-widget .quick-input-box input");

/** A webview document or one section of it. */
type Scope = FrameLocator | Locator;

const listCombobox = (frame: Scope) =>
    frame.getByRole("combobox", { name: webviewText("changes.changelists"), exact: true });

/** The list action's result notice; row statistics share `role=status`, so match its text. */
const notice = (frame: Scope, text: string | RegExp) =>
    frame.getByRole("status").filter({ hasText: text });

/** Creates a list through the host prompts, keeping the current active list. */
async function createList(page: Page, frame: Scope, name: string): Promise<void> {
    await frame.getByRole("button", { name: webviewText("changes.newList"), exact: true }).click();
    const input = quickInput(page);
    await expect(page.locator(".quick-input-title")).toContainText(hostText("New changelist"));
    await input.fill(name);
    await input.press("Enter");
    await expect(page.locator(".quick-input-title")).toContainText(
        hostText("Changelist description"),
    );
    await input.press("Enter");
    await page.getByText(hostText("Keep the current active changelist"), { exact: true }).click();
    await expect(listCombobox(frame).locator("option")).toContainText([name]);
}

/** Opens a list header's action menu and starts its Save to Shelf prompt. */
async function startListSave(page: Page, frame: Scope, listName: string): Promise<void> {
    await frame
        .getByRole("button", {
            name: webviewText("changes.listActions").replace("{name}", listName),
            exact: true,
        })
        .click();
    await frame
        .getByRole("menuitem", { name: webviewText("shelf.action.save"), exact: true })
        .click();
    await expect(page.locator(".quick-input-title")).toContainText(hostText("Save to Shelf"));
    await expect(quickInput(page)).toHaveValue(listName);
}

/** Records every text the frame's `role=status` regions ever show, so a brief stale reply is seen. */
async function recordStatuses(frame: FrameLocator): Promise<() => Promise<string[]>> {
    const body = frame.locator("body");
    await body.evaluate((element) => {
        const seen: string[] = [];
        const sample = () => {
            for (const status of element.querySelectorAll('[role="status"]')) {
                const text = status.textContent ?? "";
                if (text && seen.at(-1) !== text) seen.push(text);
            }
        };
        new MutationObserver(sample).observe(element, {
            subtree: true,
            childList: true,
            characterData: true,
        });
        (window as unknown as { lifecycleStatuses: string[] }).lifecycleStatuses = seen;
    });
    return () =>
        body.evaluate(
            () => (window as unknown as { lifecycleStatuses: string[] }).lifecycleStatuses,
        );
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

test.describe("Changelist lifecycle", () => {
    test.use({ scenario: "clean" });

    test("close and reopen keeps lists and leaves an in-flight save terminal", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await seedChanges(workspace.root, workspace);
        const probe = await installGitProbe(workspace);
        const shelfStorageRoot = path.join(workspace.profileDir, "lifecycle-shelves");
        const shelfPath = path.join(shelfStorageRoot, "shelves");
        const { app, page } = await launch(fixtureWorkspace, { ...workspace, shelfStorageRoot });
        try {
            const view = new IntelliGitView(page);
            let frame = await view.reveal();
            await createList(page, frame, "Kept 名前 list");
            const before = await readState(workspace.root);
            const active = before.lists.find((list) => list.id === before.activeId)!.name;

            await startListSave(page, frame, active);
            await probe.arm();
            await quickInput(page).press("Enter");
            await expect
                .poll(probe.heldCount, { message: "save reached Git and is held" })
                .toBeGreaterThan(0);
            await page.getByRole("button", { name: /^Toggle Primary Side Bar/ }).click();
            await expect(page.locator('[id="workbench.parts.sidebar"]')).toBeHidden();
            await probe.release();
            await expect
                .poll(async () => (await shelvesOf(workspace.root, shelfPath)).length, {
                    message: "the held save finishes while its panel is closed",
                    // Measured over 5 s here once the held Git calls are released together.
                    timeout: 30_000,
                })
                .toBe(1);

            frame = await view.reveal();
            await expect(listCombobox(frame).locator("option")).toContainText(["Kept 名前 list"]);
            expect((await readState(workspace.root)).lists).toEqual(before.lists);
            await expect(
                frame.getByRole("button", { name: webviewText("changes.newList"), exact: true }),
                "a reply delivered while closed must not leave the reopened panel busy",
            ).toBeEnabled();
            await startListSave(page, frame, active);
            await quickInput(page).press("Escape");
            await expect(notice(frame, SAVE_CANCELLED)).toBeVisible();
            expect(await shelvesOf(workspace.root, shelfPath)).toHaveLength(1);
            await attachScreenshot(page, testInfo, "close-reopen.png");
        } finally {
            await probe.release();
            await app.close();
        }
    });

    test("rapid double activation of Save to Shelf creates exactly one shelf", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await seedChanges(workspace.root, workspace);
        const shelfStorageRoot = path.join(workspace.profileDir, "lifecycle-shelves");
        const shelfPath = path.join(shelfStorageRoot, "shelves");
        const { app, page } = await launch(fixtureWorkspace, { ...workspace, shelfStorageRoot });
        try {
            const frame = await new IntelliGitView(page).reveal();
            // Whole-file shelf buttons render only once a second list exists.
            await createList(page, frame, "Second list");
            await expect(listCombobox(frame)).toBeVisible();
            await frame.getByRole("checkbox", { name: OTHER, exact: true }).first().uncheck();
            await frame.getByRole("checkbox", { name: FILE, exact: true }).first().check();
            await frame
                .getByRole("button", {
                    name: webviewText("changes.saveSelectedWholeFiles"),
                    exact: true,
                })
                .dblclick();
            await expect(quickInput(page)).toBeVisible();
            await quickInput(page).fill("Double click 名前");
            await quickInput(page).press("Enter");
            await expect(notice(frame, SAVED_UNCHANGED)).toBeVisible();
            await expect(
                frame.getByRole("alert"),
                "the second activation must not surface a refused duplicate",
            ).toHaveCount(0);
            const shelves = await shelvesOf(workspace.root, shelfPath);
            expect(shelves.map((shelf) => shelf.metadata.name)).toEqual(["Double click 名前"]);
            expect(shelves[0]!.files.map((file) => file.worktreeBlock?.path)).toEqual([FILE]);
            await attachScreenshot(page, testInfo, "double-save.png");
        } finally {
            await app.close();
        }
    });

    test("docked and undocked panels share lists and keep their own Save prompts", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await seedChanges(workspace.root, workspace);
        const shelfStorageRoot = path.join(workspace.profileDir, "lifecycle-shelves");
        const shelfPath = path.join(shelfStorageRoot, "shelves");
        const { app, page } = await launch(fixtureWorkspace, { ...workspace, shelfStorageRoot });
        try {
            const view = new IntelliGitView(page);
            const docked = await view.revealDocked();
            await createList(page, docked, "Second list");
            await docked.getByRole("checkbox", { name: FILE, exact: true }).first().uncheck();
            await docked.getByRole("checkbox", { name: OTHER, exact: true }).first().check();
            await docked
                .getByRole("button", { name: webviewText("changes.moveSelected"), exact: true })
                .click();
            await page
                .locator(".quick-input-widget")
                .getByText("Second list", { exact: true })
                .click();
            const second = async () =>
                (await readState(workspace.root)).lists.find((list) => list.name === "Second list")
                    ?.id;
            await expect
                .poll(async () => (await readState(workspace.root)).files[OTHER])
                .toBe(await second());
            const state = await readState(workspace.root);
            const active = state.lists.find((list) => list.id === state.activeId)!.name;

            await new Workbench(page).runCommand("IntelliGit: Undock...");
            await page.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
            // Menus portal to the document body, so the whole undocked document is the scope.
            const undocked = await view.revealUndocked();
            await expect(
                listCombobox(undocked).locator("option"),
                "the undocked panel reads the docked panel's lists",
            ).toContainText(["Second list"]);
            await createList(page, undocked, "Undocked list");
            const dockedAgain = await view.revealDocked();
            await expect(
                listCombobox(dockedAgain).locator("option"),
                "the docked panel reads the undocked panel's list",
            ).toContainText(["Undocked list"]);
            expect(await listNames(workspace.root)).toEqual(
                expect.arrayContaining(["Second list", "Undocked list"]),
            );

            await startListSave(page, dockedAgain, active);
            const undockedActions = undocked.getByRole("button", {
                name: webviewText("changes.listActions").replace("{name}", "Second list"),
                exact: true,
            });
            await undockedActions.click();
            await expect(
                notice(dockedAgain, SAVE_CANCELLED),
                "the docked prompt is cancelled by focus moving away, not completed by the other panel",
            ).toBeVisible();
            // Known: a cancelled prompt pulls focus back to its own view (PLAN.md), closing this menu.
            await undockedActions.click();
            await undocked
                .getByRole("menuitem", { name: webviewText("shelf.action.save"), exact: true })
                .click();
            await expect(quickInput(page)).toHaveValue("Second list");
            await quickInput(page).press("Enter");
            await expect(notice(undocked, SAVED_UNCHANGED)).toBeVisible();
            await expect(notice(dockedAgain, SAVE_CANCELLED)).toBeVisible();
            await expect(notice(dockedAgain, SAVED_UNCHANGED)).toHaveCount(0);
            const shelves = await shelvesOf(workspace.root, shelfPath);
            expect(shelves.map((shelf) => shelf.metadata.name)).toEqual(["Second list"]);
            expect(shelves[0]!.metadata.selection?.scope).toBe("list");
            expect(shelves[0]!.files.map((file) => file.worktreeBlock?.path)).toEqual([OTHER]);
            await attachScreenshot(page, testInfo, "dock-undock-prompts.png");
        } finally {
            await app.close();
        }
    });

    test("repository switch keeps lists, replies, and shelves with the captured repository", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        await seedChanges(workspace.root, workspace);
        const selected = await addSelectedRepository(workspace);
        const probe = await installGitProbe(workspace);
        const shelfStorageRoot = path.join(workspace.profileDir, "lifecycle-shelves");
        const shelfPath = path.join(shelfStorageRoot, "shelves");
        const { app, page } = await launch(fixtureWorkspace, { ...workspace, shelfStorageRoot });
        try {
            // The undocked view is the one surface with a single selected repository to switch.
            const hostWindow = await app.browserWindow(page);
            await hostWindow.evaluate((browserWindow) => browserWindow.setContentSize(1280, 900));
            await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
            for (const name of [/^Toggle Primary Side Bar/, /^Toggle Secondary Side Bar/]) {
                const toggle = page.getByRole("button", { name });
                if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
            }
            await new Workbench(page).runCommand("IntelliGit: Undock...");
            await page.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
            const frame = await new IntelliGitView(page).revealUndocked();
            const switchTo = async (root: string) => {
                const row = frame.locator(
                    `[data-testid="undocked-repository-row"][data-repository-root=${JSON.stringify(await realpath(root))}]`,
                );
                await row.click();
                await expect(row).toHaveAttribute("aria-current", "true");
                await expect(frame.getByTitle(SELECTED_ONLY, { exact: true })).toHaveCount(
                    root === selected ? 1 : 0,
                );
            };

            await switchTo(workspace.root);
            await createList(page, frame, "Alpha list");
            await switchTo(selected);
            await expect(
                listCombobox(frame).locator("option"),
                "the selected repository never shows the workspace's list",
            ).not.toContainText(["Alpha list"]);
            await createList(page, frame, "Beta list");
            expect(await listNames(workspace.root)).toContain("Alpha list");
            expect(await listNames(workspace.root)).not.toContain("Beta list");
            expect(await listNames(selected)).toContain("Beta list");
            expect(await listNames(selected)).not.toContain("Alpha list");

            await switchTo(workspace.root);
            await expect(listCombobox(frame).locator("option")).toContainText(["Alpha list"]);
            const alpha = await readState(workspace.root);
            const alphaActive = alpha.lists.find((list) => list.id === alpha.activeId)!.name;
            await startListSave(page, frame, alphaActive);
            await probe.arm();
            await quickInput(page).press("Enter");
            await expect
                .poll(probe.heldCount, { message: "the workspace save is held in Git" })
                .toBeGreaterThan(0);
            await switchTo(selected);
            await expect(listCombobox(frame).locator("option")).toContainText(["Beta list"]);
            const statuses = await recordStatuses(frame);
            await probe.release();
            await expect
                .poll(async () => (await shelvesOf(workspace.root, shelfPath)).length, {
                    message: "the held save completes in the repository that started it",
                    // Measured over 5 s here; the switch also reloads the graph and branches.
                    timeout: 30_000,
                })
                .toBe(1);
            const [alphaShelf] = await shelvesOf(workspace.root, shelfPath);
            expect(alphaShelf!.metadata.name).toBe(alphaActive);
            expect(await shelvesOf(selected, shelfPath)).toEqual([]);

            const beta = await readState(selected);
            await startListSave(
                page,
                frame,
                beta.lists.find((list) => list.id === beta.activeId)!.name,
            );
            await quickInput(page).press("Enter");
            await expect(notice(frame, SAVED_UNCHANGED)).toBeVisible({ timeout: 30_000 });
            const [betaShelf] = await shelvesOf(selected, shelfPath);
            expect(
                betaShelf!.files.map((file) => file.worktreeBlock?.path ?? file.indexBlock?.path),
            ).toEqual(expect.arrayContaining([FILE, OTHER]));
            const shown = (await statuses()).filter((text) => SAVED_UNCHANGED.test(text));
            expect(
                shown,
                "the selected repository displays only its own reply, never the workspace's late one",
            ).toEqual([expect.stringContaining(betaShelf!.id)]);
            expect(await readFile(path.join(selected, FILE), "utf8")).toBe("base\nselected edit\n");
            await attachScreenshot(page, testInfo, "repository-switch.png");
        } finally {
            await probe.release();
            await app.close();
        }
    });
});

test.describe("Changelist lifecycle with a seeded shelf", () => {
    test.use({ scenario: "shelf-populated" });

    test("rapid double activation of Unshelve runs exactly one Git apply", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const probe = await installGitProbe(workspace);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            const frame = await new IntelliGitView(page).reveal();
            await frame
                .getByRole("tab", {
                    name: new RegExp(`^${webviewText("commit.tab.shelf")}(?: \\(\\d+\\))?$`),
                })
                .click();
            const shelf = frame
                .getByTestId("shelf-list")
                .getByRole("treeitem")
                .filter({ hasText: "scenario-seeded-shelf" });
            await expect(shelf).toHaveCount(1);
            await shelf.click({ button: "right" });
            await frame
                .getByRole("menu")
                .getByRole("menuitem", { name: webviewText("shelf.action.unshelveMenu") })
                .click();
            const dialog = frame.getByRole("dialog");
            await expect(
                dialog.getByRole("heading", { name: webviewText("shelf.dialog.unshelve.title") }),
            ).toBeVisible();
            const before = (await probe.applies()).length;
            await dialog
                .getByRole("button", { name: webviewText("shelf.action.unshelve"), exact: true })
                .dblclick();
            await expect(quickInput(page)).toHaveAttribute(
                "placeholder",
                hostText("Select a destination changelist"),
            );
            await page
                .locator(".quick-input-widget")
                .getByRole("option", { name: /^Changes\b/ })
                .click();
            await expect
                .poll(() =>
                    readFile(path.join(workspace.root, "untracked.txt"), "utf8").catch(() => null),
                )
                .toBe("untracked content\n");
            await expect(frame.getByRole("dialog")).toHaveCount(0);
            await expect.poll(async () => (await probe.applies()).length - before).toBe(1);
            await expect(frame.getByRole("alert")).toHaveCount(0);
            await attachScreenshot(page, testInfo, "double-unshelve.png");
        } finally {
            await app.close();
        }
    });
});

test.describe("Changelists in two windows", () => {
    test.use({ scenario: "clean" });

    test("a second window sees the first window's list and refuses a mutation while a targeted operation is pending", async ({
        fixtureWorkspace,
    }, testInfo) => {
        test.setTimeout(300_000);
        const { workspace } = fixtureWorkspace;
        const main = await git(workspace.root, ["branch", "--show-current"], workspace);
        const conflict = "conflict.txt";
        await writeFile(path.join(workspace.root, conflict), "base\n");
        await git(workspace.root, ["add", "--", conflict], workspace);
        await git(workspace.root, ["commit", "-m", "Conflict base"], workspace);
        await git(workspace.root, ["checkout", "-b", PICK_BRANCH], workspace);
        await writeFile(path.join(workspace.root, conflict), "feature\n");
        await git(workspace.root, ["commit", "-am", "Feature conflict"], workspace);
        const feature = await git(workspace.root, ["rev-parse", "HEAD"], workspace);
        await git(workspace.root, ["checkout", main], workspace);
        await writeFile(path.join(workspace.root, conflict), "main\n");
        await git(workspace.root, ["commit", "-am", "Main conflict"], workspace);

        // Same launcher, second isolated profile: a separate VS Code instance on the same repository.
        const secondRoot = path.join(path.dirname(workspace.profileDir), "second-window");
        const secondChannel = path.join(secondRoot, "channel");
        await mkdir(secondChannel, { recursive: true });
        const first = await launch(fixtureWorkspace);
        const second = await launch(
            fixtureWorkspace,
            { ...workspace, profileDir: path.join(secondRoot, "profile") },
            secondChannel,
        );
        try {
            const secondFrame = await new IntelliGitView(second.page).reveal();
            // The list picker renders only once a second list exists.
            await createList(second.page, secondFrame, "Second window list");
            await expect(listCombobox(secondFrame)).toBeVisible();
            // The first window never reveals its sidebar: its Graph pane would also match revealPanel.
            await new Workbench(first.page).runCommand("IntelliGit: Show Git Log");
            const graph = await new IntelliGitView(first.page).revealPanel();
            await graph.getByRole("button", { name: PICK_BRANCH, exact: true }).click();
            const row = graph
                .getByTestId("commit-list-viewport")
                .getByRole("button")
                .filter({ hasText: "Feature conflict" });
            await row.click({ button: "right" });
            await graph
                .getByRole("menu")
                .getByRole("menuitem", {
                    name: webviewText("commit.menu.cherryPickToChangelist"),
                    exact: true,
                })
                .press("Enter");
            const dialog = first.page.locator(".monaco-dialog-box");
            await dialog
                .getByRole("button", {
                    name: hostText("Cherry-pick Without Committing"),
                    exact: true,
                })
                .click();
            await first.page
                .getByRole("option", { name: new RegExp(`^${hostText("Create New Changelist…")}`) })
                .click();
            await quickInput(first.page).fill("Picked 名前 conflict");
            await quickInput(first.page).press("Enter");
            await expect(
                first.page.locator(".notifications-toasts .notification-toast").filter({
                    hasText: catalogPattern(
                        hostText(
                            "Applying {short} stopped with conflicts. Resolve them, then continue or abort. Nothing will be committed.",
                        ),
                        feature,
                    ),
                }),
            ).toBeVisible();
            await expect
                .poll(async () => (await readState(workspace.root)).pendingTargetOperation)
                .toBeDefined();
            const listsDuringPending = await listNames(workspace.root);
            expect(listsDuringPending).toContain("Picked 名前 conflict");
            await expect(
                listCombobox(secondFrame).locator("option"),
                "the second window reads the first window's list from disk",
            ).toContainText(["Picked 名前 conflict"]);

            await secondFrame
                .getByRole("button", { name: webviewText("changes.newList"), exact: true })
                .click();
            const input = quickInput(second.page);
            await expect(input).toBeVisible();
            await input.fill("Refused in second window");
            await input.press("Enter");
            await expect(second.page.locator(".quick-input-title")).toContainText(
                hostText("Changelist description"),
            );
            await input.press("Enter");
            await second.page
                .getByText(hostText("Keep the current active changelist"), { exact: true })
                .click();
            await expect(
                secondFrame.getByRole("alert"),
                "the second window must refuse a list mutation during the pending operation",
            ).toContainText("A targeted operation is pending review.");
            await expect(second.page.locator(".quick-input-widget")).toBeHidden();
            expect(await listNames(workspace.root)).toEqual(listsDuringPending);
            await attachScreenshot(first.page, testInfo, "first-window-pending.png");
            await attachScreenshot(second.page, testInfo, "second-window-refused.png");
        } finally {
            await second.app.close();
            await first.app.close();
        }
    });
});
