import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import l10nBundle from "../../l10n/bundle.l10n.json";
import enCatalog from "../../src/webviews/i18n/en.json";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import { runGitRaw } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");
const PICK = "pick.txt";
const REVERT = "revert.txt";
const UNDO = "undo.txt";
const FEATURE = "history-pick";
const FEATURE_SUBJECT = "Feature only pick change";
const REVERT_SUBJECT = "Main change to revert";
const UNDO_SUBJECT = "Latest main change to undo";

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

/** Catalog template as a regex; `{short}` is any abbreviation of `hash`, other holes are given. */
function catalogPattern(
    template: string,
    hash: string,
    holes: Record<string, string> = {},
): RegExp {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let source = escape(template).replace(/\\\{short\\\}/g, `${hash.slice(0, 4)}[0-9a-f]*`);
    for (const [hole, pattern] of Object.entries(holes))
        source = source.replace(new RegExp(`\\\\\\{${hole}\\\\\\}`, "g"), pattern);
    return new RegExp(source);
}

async function git(workspace: Workspace, args: string[]): Promise<string> {
    return (await runGitRaw(workspace.root, args, workspace.env)).trim();
}

/** base; a commit only on `feature`; then two main commits (one to revert, the tip to undo). */
async function seedHistory(workspace: Workspace) {
    const main = await git(workspace, ["branch", "--show-current"]);
    const write = (file: string, text: string) => writeFile(path.join(workspace.root, file), text);
    const commit = async (subject: string, ...files: string[]) => {
        await git(workspace, ["add", "--", ...files]);
        await git(workspace, ["commit", "-m", subject]);
        return git(workspace, ["rev-parse", "HEAD"]);
    };
    await write(PICK, "one\n");
    await write(REVERT, "keep\n");
    await write(UNDO, "u0\n");
    await commit("History base", PICK, REVERT, UNDO);
    await git(workspace, ["checkout", "-b", FEATURE]);
    await write(PICK, "one\npicked\n");
    const feature = await commit(FEATURE_SUBJECT, PICK);
    await git(workspace, ["checkout", main]);
    await write(REVERT, "keep\nreverted line\n");
    const reverted = await commit(REVERT_SUBJECT, REVERT);
    await write(UNDO, "u0\nundo me\n");
    const undone = await commit(UNDO_SUBJECT, UNDO);
    return { feature, reverted, undone };
}

async function launch(fixtureWorkspace: FixtureWorkspaceFixture) {
    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(REPO_ROOT),
        repoRoot: REPO_ROOT,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    const page = await app.firstWindow();
    await dismissFirstRunDialogs(page);
    await waitForE2eChannelReady(fixtureWorkspace.channelDir);
    return { app, page };
}

/** Opens the Git Log, right-clicks `subject` and chooses `menuKey`, then accepts the modal. */
async function startHistoryAction(
    page: Page,
    options: {
        subject: string;
        hash: string;
        menuKey: keyof typeof enCatalog;
        confirmKey: string;
        confirmHoles?: Record<string, string>;
        buttonKey: string;
        branchScope?: string;
    },
): Promise<void> {
    await new Workbench(page).runCommand("IntelliGit: Show Git Log");
    const graph = await new IntelliGitView(page).revealPanel();
    // Cherry-pick is offered only while the graph is scoped to a branch other than the current one.
    if (options.branchScope)
        await graph.getByRole("button", { name: options.branchScope, exact: true }).click();
    const row = graph
        .getByTestId("commit-list-viewport")
        .getByRole("button")
        .filter({ hasText: options.subject });
    await expect(row).toHaveCount(1);
    await row.click({ button: "right" });
    await graph
        .getByRole("menu")
        .getByRole("menuitem", { name: webviewText(options.menuKey), exact: true })
        // Keyboard, as matrix.ts does: a low menu item sits under the workbench status bar.
        .press("Enter");
    const dialog = page.locator(".monaco-dialog-box");
    await expect(dialog).toContainText(
        catalogPattern(hostText(options.confirmKey), options.hash, options.confirmHoles),
    );
    await dialog.getByRole("button", { name: hostText(options.buttonKey), exact: true }).click();
}

/** Picks "Create New Changelist…" in the destination picker and names it. */
async function pickNewList(page: Page, name: string): Promise<void> {
    const input = page.locator(".quick-input-widget .quick-input-box input");
    await expect(input).toHaveAttribute("placeholder", hostText("Select a destination changelist"));
    await page
        .getByRole("option", { name: new RegExp(`^${hostText("Create New Changelist…")}`) })
        .click();
    await expect(page.locator(".quick-input-widget")).toContainText(
        hostText("Name the new destination changelist"),
    );
    await input.fill(name);
    await input.press("Enter");
}

async function readState(workspace: Workspace) {
    const statePath = path.join(workspace.root, ".git/intelligit/changelists/state.json");
    return JSON.parse(await readFile(statePath, "utf8")).state as {
        lists: { id: string; name: string; draft: string }[];
        files: Record<string, string>;
        changes: Record<string, { lines?: Record<string, string> } | undefined>;
    };
}

/** The file is owned by `listName` in metadata and rendered inside that list's group. */
async function expectFileInList(
    page: Page,
    workspace: Workspace,
    file: string,
    listName: string,
): Promise<string> {
    // Text paths are owned line by line; whole-file paths (every undo path) by the file entry.
    const owners = async () => {
        const state = await readState(workspace);
        const lines = Object.values(state.changes[file]?.lines ?? {});
        const names = (ids: string[]) =>
            [...new Set(ids)].map((id) => state.lists.find((list) => list.id === id)?.name ?? id);
        return names(lines.length ? lines : [state.files[file]]);
    };
    await expect.poll(owners).toEqual([listName]);
    const list = (await readState(workspace)).lists.find((item) => item.name === listName)!;
    const sidebar = await new IntelliGitView(page).reveal();
    const header = sidebar.locator(`[data-changelist-id="${list.id}"]`);
    const toggle = header.locator("button[aria-expanded]");
    await expect(toggle).toHaveAccessibleName(listName);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(
        header
            .getByRole("group", { name: listName, exact: true })
            .getByRole("checkbox", { name: file, exact: true }),
    ).toBeVisible();
    return list.id;
}

/** The workbench notification toast whose text matches `pattern`. */
function toast(page: Page, pattern: RegExp) {
    return page.locator(".notifications-toasts .notification-toast").filter({ hasText: pattern });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

const fileText = (workspace: Workspace, file: string) =>
    readFile(path.join(workspace.root, file), "utf8");

test.describe("History into a changelist", () => {
    test.use({ scenario: "clean" });

    test("Cherry-Pick to Changelist applies another branch's commit without committing", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const { feature } = await seedHistory(workspace);
        const head = await git(workspace, ["rev-parse", "HEAD"]);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            await startHistoryAction(page, {
                subject: FEATURE_SUBJECT,
                hash: feature,
                menuKey: "commit.menu.cherryPickToChangelist",
                confirmKey:
                    "Cherry-pick commit {short} into a changelist? The result stays uncommitted.",
                buttonKey: "Cherry-pick Without Committing",
                branchScope: FEATURE,
            });
            await pickNewList(page, "Picked work");
            await expect(
                toast(
                    page,
                    catalogPattern(
                        hostText("Cherry-picked {short} into the changelist without committing."),
                        feature,
                    ),
                ),
            ).toBeVisible();
            await expectFileInList(page, workspace, PICK, "Picked work");
            expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(head);
            expect(await fileText(workspace, PICK)).toBe("one\npicked\n");
            await attachScreenshot(page, testInfo, "cherry-pick-to-changelist.png");
        } finally {
            await app.close();
        }
    });

    test("Revert to Changelist leaves the inverse change uncommitted in the chosen list", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const { reverted } = await seedHistory(workspace);
        const head = await git(workspace, ["rev-parse", "HEAD"]);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            await startHistoryAction(page, {
                subject: REVERT_SUBJECT,
                hash: reverted,
                menuKey: "commit.menu.revertToChangelist",
                confirmKey:
                    "Revert commit {short} into a changelist? The result stays uncommitted.",
                buttonKey: "Revert Without Committing",
            });
            await pickNewList(page, "Reverted work");
            await expect(
                toast(
                    page,
                    catalogPattern(
                        hostText("Reverted {short} into the changelist without committing."),
                        reverted,
                    ),
                ),
            ).toBeVisible();
            await expectFileInList(page, workspace, REVERT, "Reverted work");
            expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(head);
            expect(await fileText(workspace, REVERT)).toBe("keep\n");
            await attachScreenshot(page, testInfo, "revert-to-changelist.png");
        } finally {
            await app.close();
        }
    });

    test("Undo Commit moves HEAD to its parent and keeps the change in the chosen list", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const { undone } = await seedHistory(workspace);
        const parent = await git(workspace, ["rev-parse", `${undone}^`]);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            await startHistoryAction(page, {
                subject: UNDO_SUBJECT,
                hash: undone,
                menuKey: "commit.menu.undoCommit",
                confirmKey: "Undo {count} commit(s) up to {short} (soft reset)?",
                confirmHoles: { count: "1" },
                buttonKey: "Undo",
            });
            await pickNewList(page, "Undone work");
            const input = page.locator(".quick-input-widget .quick-input-box input");
            await expect(input).toHaveAttribute(
                "placeholder",
                hostText("Choose how to handle the destination draft"),
            );
            const copyLabel = hostText("Copy Draft from {name}").replace(
                "{name}",
                hostText("Commit {short}"),
            );
            await page.getByRole("option", { name: catalogPattern(copyLabel, undone) }).click();
            await expect
                .poll(() => git(workspace, ["rev-parse", "HEAD"]), {
                    message: "HEAD moved to its parent",
                })
                .toBe(parent);
            await expect(
                toast(
                    page,
                    catalogPattern(hostText("Undid {count} commit(s) up to {short}."), undone, {
                        count: "1",
                    }),
                ),
            ).toBeVisible();
            const listId = await expectFileInList(page, workspace, UNDO, "Undone work");
            expect(await fileText(workspace, UNDO)).toBe("u0\nundo me\n");
            const draft = (await readState(workspace)).lists.find(
                (list) => list.id === listId,
            )?.draft;
            expect(draft).toBe(UNDO_SUBJECT);
            await attachScreenshot(page, testInfo, "undo-commit-to-changelist.png");
        } finally {
            await app.close();
        }
    });

    test("Undo Commit refuses when an affected file has an unstaged edit", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const { undone } = await seedHistory(workspace);
        const dirty = "u0\nundo me\nunstaged edit\n";
        await writeFile(path.join(workspace.root, UNDO), dirty);
        const { app, page } = await launch(fixtureWorkspace);
        try {
            await startHistoryAction(page, {
                subject: UNDO_SUBJECT,
                hash: undone,
                menuKey: "commit.menu.undoCommit",
                confirmKey: "Undo {count} commit(s) up to {short} (soft reset)?",
                confirmHoles: { count: "1" },
                buttonKey: "Undo",
            });
            await pickNewList(page, "Refused work");
            const input = page.locator(".quick-input-widget .quick-input-box input");
            await expect(input).toHaveAttribute(
                "placeholder",
                hostText("Choose how to handle the destination draft"),
            );
            await page
                .getByRole("option", {
                    name: new RegExp(`^${hostText("Keep Destination Draft")}`),
                })
                .click();
            await expect(
                toast(
                    page,
                    catalogPattern(hostText("Nothing was applied for {short}: {reason}"), undone, {
                        reason: `.*"${UNDO}"`,
                    }),
                ),
            ).toBeVisible();
            expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(undone);
            expect(await fileText(workspace, UNDO)).toBe(dirty);
            expect((await readState(workspace)).lists.map((list) => list.name)).not.toContain(
                "Refused work",
            );
            await attachScreenshot(page, testInfo, "undo-commit-refused.png");
        } finally {
            await app.close();
        }
    });
});
