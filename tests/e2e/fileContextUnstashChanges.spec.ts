import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "@playwright/test";
import { E2eControlChannelClient, waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "clean" });

/** Runs Git in one disposable fixture repository. */
function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Captures the unrelated active repository's refs, index, status and file contents. */
async function snapshot(cwd: string, env: NodeJS.ProcessEnv) {
    return {
        head: git(cwd, env, ["rev-parse", "HEAD"]),
        refs: git(cwd, env, ["for-each-ref", "--format=%(refname) %(objectname)"]),
        index: git(cwd, env, ["ls-files", "--stage", "-z"]),
        status: git(cwd, env, ["status", "--porcelain"]),
        content: await readFile(path.join(cwd, "a-proof.txt"), "utf8"),
    };
}

/** Opens Unstash Changes through a visible native IntelliGit file submenu. */
async function chooseUnstash(page: Page, reopen?: () => Promise<void>): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    try {
        await parent.hover({ timeout: 2000 });
    } catch (error) {
        if (!reopen) throw error;
        await reopen();
        await parent.hover();
    }
    const previous = page.getByRole("menuitem", { name: /^Stash Changes(?:\.\.\.|…)/ });
    const action = page.getByRole("menuitem", { name: /^Unstash Changes(?:\.\.\.|…)/ });
    if (!(await action.isVisible())) {
        await page.keyboard.press("ArrowRight");
    }
    await expect(previous).toBeVisible();
    await expect(action).toBeVisible();
    const labels = await page.getByRole("menuitem").allTextContents();
    expect(labels.findIndex((label) => label.startsWith("Unstash Changes"))).toBe(
        labels.findIndex((label) => label.startsWith("Stash Changes")) + 1,
    );
    await action.hover();
    await page.keyboard.press("Enter");
}

/** Opens the native Explorer context menu after QuickPick focus has settled. */
async function openExplorerMenu(page: Page, file: ReturnType<Page["locator"]>): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await file.click({ button: "right" });
    try {
        await expect(parent).toBeVisible({ timeout: 1000 });
    } catch {
        await file.click({ button: "right" });
        await expect(parent).toBeVisible();
    }
}

/** Reopens an Explorer menu once if VS Code detaches it during focus transition. */
async function chooseExplorerUnstash(page: Page, file: ReturnType<Page["locator"]>): Promise<void> {
    await openExplorerMenu(page, file);
    await chooseUnstash(page, () => openExplorerMenu(page, file));
}

/** Explicitly selects an item from the currently visible native QuickPick. */
async function pick(page: Page, value: string): Promise<void> {
    const input = page.locator(".quick-input-widget input").first();
    await expect(input).toBeVisible();
    await input.fill(value);
    await page.keyboard.press("Enter");
}

test("Explorer, tab and editor unstash clicked B by OID while active A stays unchanged", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(300_000);
    const extensionRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const canonicalA = await realpath(a);
    const env = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-unstash-changes-b");
    await writeFile(path.join(a, "a-proof.txt"), "A committed\n");
    git(a, env, ["add", "a-proof.txt"]);
    git(a, env, ["commit", "-m", "A proof"]);
    await writeFile(path.join(a, "a-proof.txt"), "A local change\n");
    await mkdir(b);
    git(b, env, ["init", "-b", "main"]);
    git(b, env, ["config", "user.name", "Native Unstash Test"]);
    git(b, env, ["config", "user.email", "native-unstash@example.invalid"]);
    await writeFile(path.join(b, "selected.txt"), "B baseline\n");
    await writeFile(path.join(b, "shift.txt"), "shift baseline\n");
    git(b, env, ["add", "selected.txt", "shift.txt"]);
    git(b, env, ["commit", "-m", "B baseline"]);
    const bBase = git(b, env, ["rev-parse", "HEAD"]);
    for (const label of ["oldest", "middle", "newest"]) {
        await writeFile(path.join(b, "selected.txt"), `${label} staged\n`);
        git(b, env, ["add", "selected.txt"]);
        await writeFile(path.join(b, "selected.txt"), `${label} worktree\n`);
        git(b, env, ["stash", "push", "-m", label]);
    }
    const ids = git(b, env, ["stash", "list", "--format=%H"]).split("\n");
    const aBefore = await snapshot(a, env);
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
                const selected = await channel.request({
                    store: "memento",
                    scope: "workspace",
                    key: "intelligit.selectedRepositoryRoot",
                    operation: "snapshot",
                });
                return selected.ok && selected.result;
            })
            .toMatchObject({ kind: "value", value: canonicalA });

        await page.getByRole("treeitem").filter({ hasText: "native-unstash-changes-b" }).click();
        const file = page.locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]');
        const scenarios = [
            {
                surface: "explorer",
                selector: "stash@{2}",
                action: "Apply",
                index: "Do Not Reinstate Index",
                content: "oldest worktree\n",
                retained: ids,
            },
            {
                surface: "tab",
                selector: "stash@{1}",
                action: "Apply",
                index: "Reinstate Index",
                content: "middle worktree\n",
                retained: ids,
            },
            {
                surface: "editor",
                selector: "stash@{0}",
                action: "Pop",
                index: "Do Not Reinstate Index",
                content: "newest worktree\n",
                retained: ids.slice(1),
            },
        ] as const;
        for (const scenario of scenarios) {
            if (scenario.surface === "explorer") await openExplorerMenu(page, file);
            if (scenario.surface === "tab") {
                await file.dblclick();
                await page.getByRole("tab", { name: /selected\.txt/ }).click({ button: "right" });
            }
            if (scenario.surface === "editor")
                await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
            await chooseUnstash(
                page,
                scenario.surface === "explorer" ? () => openExplorerMenu(page, file) : undefined,
            );
            await expect(page.locator(".quick-input-widget")).toContainText(
                "native-unstash-changes-b",
            );
            await pick(page, scenario.selector);
            await pick(page, scenario.action);
            await pick(page, scenario.index);
            await expect
                .poll(() => readFile(path.join(b, "selected.txt"), "utf8"))
                .toBe(scenario.content);
            await expect
                .poll(() => git(b, env, ["stash", "list", "--format=%H"]).split("\n"))
                .toEqual(scenario.retained);
            expect(git(b, env, ["rev-parse", "HEAD"])).toBe(bBase);
            if (scenario.index === "Reinstate Index")
                expect(git(b, env, ["show", ":selected.txt"])).toBe("middle staged");
            else expect(git(b, env, ["show", ":selected.txt"])).toBe("B baseline");
            expect(await snapshot(a, env)).toEqual(aBefore);
            git(b, env, ["reset", "--hard", "HEAD"]);
        }

        await writeFile(path.join(b, "selected.txt"), "branch staged\n");
        git(b, env, ["add", "selected.txt"]);
        await writeFile(path.join(b, "selected.txt"), "branch worktree\n");
        git(b, env, ["stash", "push", "-m", "branch"]);
        const branchOid = git(b, env, ["rev-parse", "stash@{0}"]);
        await chooseExplorerUnstash(page, file);
        await pick(page, "stash@{0}");
        await pick(page, "As New Branch");
        const branchInput = page.locator(".quick-input-widget input").first();
        await expect(branchInput).toBeVisible();
        await branchInput.fill("feature/native-unstash");
        await page.keyboard.press("Enter");
        await expect
            .poll(() => git(b, env, ["branch", "--show-current"]))
            .toBe("feature/native-unstash");
        expect(git(b, env, ["rev-parse", "HEAD"])).toBe(bBase);
        await expect
            .poll(() => readFile(path.join(b, "selected.txt"), "utf8"))
            .toBe("branch worktree\n");
        expect(git(b, env, ["show", ":selected.txt"])).toBe("branch staged");
        await expect
            .poll(() => git(b, env, ["stash", "list", "--format=%H"]).split("\n"))
            .not.toContain(branchOid);
        expect(await snapshot(a, env)).toEqual(aBefore);

        await page.getByRole("tab", { name: /selected\.txt/ }).click();
        await page.keyboard.press("ControlOrMeta+W");
        await expect(page.getByRole("tab", { name: /selected\.txt/ })).toBeHidden();

        const dirtyBefore = git(b, env, ["status", "--porcelain=v1", "-z"]);
        await chooseExplorerUnstash(page, file);
        await expect(
            page.getByRole("dialog", { name: /requires a clean working tree/ }),
        ).toBeVisible();
        expect(git(b, env, ["status", "--porcelain=v1", "-z"])).toBe(dirtyBefore);
        expect(await snapshot(a, env)).toEqual(aBefore);

        git(b, env, ["reset", "--hard", "HEAD"]);
        git(b, env, ["stash", "clear"]);
        const emptyHead = git(b, env, ["rev-parse", "HEAD"]);
        await chooseExplorerUnstash(page, file);
        await expect(page.getByRole("dialog", { name: /No stashes found in/ })).toBeVisible();
        expect(git(b, env, ["rev-parse", "HEAD"])).toBe(emptyHead);
        expect(git(b, env, ["stash", "list", "--format=%H"])).toBe("");

        await writeFile(path.join(b, "selected.txt"), "older selected\n");
        git(b, env, ["stash", "push", "-m", "older selected"]);
        const olderOid = git(b, env, ["rev-parse", "stash@{0}"]);
        expect(git(b, env, ["show", `${olderOid}:selected.txt`])).toBe("older selected");
        await writeFile(path.join(b, "shift.txt"), "newer selected\n");
        git(b, env, ["stash", "push", "-m", "newer selected", "--", "shift.txt"]);
        const newerOid = git(b, env, ["rev-parse", "stash@{0}"]);
        git(b, env, ["stash", "drop", "stash@{0}"]);
        await chooseExplorerUnstash(page, file);
        await page.keyboard.press("Escape");
        await expect(page.locator(".quick-input-widget input").first()).toBeHidden();
        expect(git(b, env, ["stash", "list", "--format=%H"])).toBe(olderOid);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B baseline\n");

        await chooseExplorerUnstash(page, file);
        await expect(page.locator(".quick-input-widget")).toContainText("older selected");
        await expect(page.locator(".quick-input-widget")).toContainText(olderOid.slice(0, 8));
        await expect(page.locator(".quick-input-widget")).not.toContainText(newerOid.slice(0, 8));
        git(b, env, ["stash", "store", "-m", "newer selected", newerOid]);
        expect(git(b, env, ["status", "--porcelain"]), "external stash left B clean").toBe("");
        await expect(page.locator(".quick-input-widget")).toContainText(olderOid.slice(0, 8));
        await expect(page.locator(".quick-input-widget")).not.toContainText(newerOid.slice(0, 8));
        const olderRow = page
            .locator(".quick-input-list .monaco-list-row")
            .filter({ hasText: olderOid.slice(0, 8) });
        await expect(olderRow).toHaveCount(1);
        await olderRow.click();
        await pick(page, "Apply");
        await pick(page, "Do Not Reinstate Index");
        await expect
            .poll(() => readFile(path.join(b, "selected.txt"), "utf8"))
            .toBe("older selected\n");
        expect(git(b, env, ["stash", "list", "--format=%H"]).split("\n")).toEqual([
            newerOid,
            olderOid,
        ]);
        expect(await snapshot(a, env)).toEqual(aBefore);

        git(b, env, ["reset", "--hard", "HEAD"]);
        const beforeRemovedSelection = git(b, env, ["status", "--porcelain=v1", "-z"]);
        await chooseExplorerUnstash(page, file);
        await expect(page.locator(".quick-input-widget")).toContainText("newer selected");
        git(b, env, ["stash", "drop", "stash@{0}"]);
        await pick(page, "stash@{0}");
        await pick(page, "Apply");
        await pick(page, "Do Not Reinstate Index");
        await expect(page.getByRole("dialog", { name: /selected stash changed/ })).toBeVisible();
        expect(git(b, env, ["status", "--porcelain=v1", "-z"])).toBe(beforeRemovedSelection);
        expect(git(b, env, ["stash", "list", "--format=%H"])).toBe(olderOid);
        expect(await snapshot(a, env)).toEqual(aBefore);

        git(b, env, ["stash", "clear"]);
        await writeFile(path.join(b, "selected.txt"), "stash conflict\n");
        git(b, env, ["stash", "push", "-m", "conflict"]);
        const conflictOid = git(b, env, ["rev-parse", "stash@{0}"]);
        await writeFile(path.join(b, "selected.txt"), "committed conflict\n");
        git(b, env, ["add", "selected.txt"]);
        git(b, env, ["commit", "-m", "B conflicting change"]);
        await page.keyboard.press("ControlOrMeta+Shift+P");
        await page.keyboard.type("IntelliGit: Select Repository");
        await page.keyboard.press("Enter");
        await expect(repositoryPicker).toBeVisible();
        await repositoryPicker.fill(path.basename(a));
        await page.keyboard.press("Enter");
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
        await chooseExplorerUnstash(page, file);
        await pick(page, "stash@{0}");
        await pick(page, "Apply");
        await pick(page, "Do Not Reinstate Index");
        await expect
            .poll(() => git(b, env, ["status", "--porcelain"]))
            .toContain("UU selected.txt");
        expect(git(b, env, ["stash", "list", "--format=%H"])).toBe(conflictOid);
        await expect(page.getByRole("tab", { name: "Conflicts", exact: true })).toBeVisible();
        let conflictFrame: Frame | undefined;
        await expect
            .poll(async () => {
                for (const frame of page.frames()) {
                    if (await frame.getByRole("button", { name: "Merge…", exact: true }).count()) {
                        conflictFrame = frame;
                        return true;
                    }
                }
                return false;
            })
            .toBe(true);
        await expect(conflictFrame!.getByText("selected.txt", { exact: true })).toBeVisible();
        await conflictFrame!.getByRole("button", { name: "Merge…", exact: true }).click();
        let mergeFrame: Frame | undefined;
        await expect
            .poll(async () => {
                for (const frame of page.frames()) {
                    if (await frame.locator(".merge-editor").count()) {
                        mergeFrame = frame;
                        return true;
                    }
                }
                return false;
            })
            .toBe(true);
        await expect(mergeFrame!.locator(".merge-editor")).toContainText("committed conflict");
        await expect(mergeFrame!.locator(".merge-editor")).toContainText("stash conflict");
        await mergeFrame!.getByRole("button", { name: "Use File Theirs", exact: true }).click();
        await expect.poll(() => git(b, env, ["ls-files", "-u", "selected.txt"])).toBe("");
        expect(git(b, env, ["show", ":selected.txt"])).toBe("stash conflict");
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("stash conflict\n");
        expect(await snapshot(a, env)).toEqual(aBefore);

        await writeFile(path.join(b, ".git/MERGE_HEAD"), `${git(b, env, ["rev-parse", "HEAD"])}\n`);
        const conflictedBeforeGuard = git(b, env, ["status", "--porcelain=v1", "-z"]);
        await chooseExplorerUnstash(page, file);
        await expect(page.getByRole("dialog", { name: /A merge is in progress/ })).toBeVisible();
        expect(git(b, env, ["status", "--porcelain=v1", "-z"])).toBe(conflictedBeforeGuard);
        expect(await snapshot(a, env)).toEqual(aBefore);
    } finally {
        await app.close();
    }
});
