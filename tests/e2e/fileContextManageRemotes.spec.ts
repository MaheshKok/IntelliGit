import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
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

/** Runs Git against only the disposable test workspace. */
function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Reads a configured URL without making a missing key fail the polling assertion. */
function configuredUrl(cwd: string, env: NodeJS.ProcessEnv, name: string): string | null {
    try {
        return git(cwd, env, ["config", "--get", `remote.${name}.url`]);
    } catch {
        return null;
    }
}

/** Invokes the visible native entry and confirms it follows GitHub in the file menu. */
async function openManageRemotes(page: Page): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await parent.hover();
    const action = page.getByRole("menuitem", { name: /^Manage Remotes(?:\.\.\.|…)/ });
    if (!(await action.isVisible())) await page.keyboard.press("ArrowRight");
    await expect(action).toBeVisible();
    const labels = (await page.getByRole("menuitem").allTextContents()).map((value) =>
        value.trim(),
    );
    const github = labels.findIndex((label) => label === "GitHub");
    const manage = labels.findIndex((label) => label.startsWith("Manage Remotes"));
    expect(manage, "Manage Remotes follows the GitHub submenu").toBe(github + 1);
    await action.hover();
    await page.keyboard.press("Enter");
}

/** Finds the real Manage Remotes webview document after its React handshake. */
async function remotesFrame(page: Page): Promise<Frame> {
    await expect
        .poll(async () => {
            for (const frame of page.frames()) {
                if (await frame.getByRole("heading", { name: "Git Remotes" }).count()) return true;
            }
            return false;
        })
        .toBe(true);
    for (const frame of page.frames()) {
        if (await frame.getByRole("heading", { name: "Git Remotes" }).count()) return frame;
    }
    throw new Error("Git Remotes webview frame disappeared");
}

test("Explorer, editor tab, and editor content mutate clicked B while selected A stays A", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(300_000);
    const extensionRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const canonicalA = await realpath(a);
    const env = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-manage-remotes-b");
    await mkdir(b);
    git(b, env, ["init", "-b", "main"]);
    await writeFile(path.join(b, "selected.txt"), "B baseline\n");
    git(b, env, ["add", "selected.txt"]);
    git(b, env, [
        "-c",
        "user.name=Native Remotes Test",
        "-c",
        "user.email=remotes@example.invalid",
        "commit",
        "-m",
        "B baseline",
    ]);
    git(a, env, ["remote", "add", "a-proof", "../a-only.git"]);
    const aBefore = git(a, env, ["config", "--local", "--get-regexp", "^remote\\."]);
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
        /** Reads the persisted selection without changing it or masking a mutation bug. */
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
        /** Restores A after opening B's editor before the next clicked-file dispatch. */
        const selectActiveA = async (): Promise<void> => {
            await page.keyboard.press("ControlOrMeta+Shift+P");
            await page.keyboard.type("IntelliGit: Select Repository");
            await page.keyboard.press("Enter");
            const picker = page.getByPlaceholder("Select IntelliGit repository", { exact: true });
            await expect(picker).toBeVisible();
            await picker.fill(path.basename(a));
            await page.keyboard.press("Enter");
            await assertActiveA();
        };
        await page.getByRole("treeitem").filter({ hasText: "README.md" }).dblclick();
        await page.getByRole("treeitem").filter({ hasText: "native-manage-remotes-b" }).click();
        const file = page.locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]');

        for (const surface of ["explorer", "tab", "editor"] as const) {
            if (surface !== "explorer") await file.dblclick();
            await selectActiveA();
            if (surface === "explorer") await file.click({ button: "right" });
            else if (surface === "tab")
                await page.getByRole("tab", { name: /selected\.txt/ }).click({ button: "right" });
            else
                await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
            await openManageRemotes(page);
            const frame = await remotesFrame(page);
            await expect(frame.getByText(await realpath(b), { exact: true })).toBeVisible();
            if (surface === "explorer") {
                await expect(
                    frame.getByText("No remotes configured.", { exact: false }),
                ).toBeVisible();
                await page.screenshot({ path: testInfo.outputPath("manage-remotes-table.png") });
                await frame.getByRole("button", { name: "Add remote" }).click();
                await page.screenshot({ path: testInfo.outputPath("define-remote-form.png") });
                await frame.getByLabel("Name").fill("bad/name");
                await frame.getByLabel("URL").fill("../bad.git");
                await expect(frame.getByRole("button", { name: "Save" })).toBeDisabled();
                await page.keyboard.press("Escape");
                await expect(frame.getByRole("heading", { name: "Define Remote" })).toBeHidden();
            }

            const name = `stage-${surface}`;
            const renamed = `renamed-${surface}`;
            await frame.getByRole("button", { name: "Add remote" }).click();
            await frame.getByLabel("Name").fill(name);
            await frame.getByLabel("URL").fill(`../${name}.git`);
            await frame.getByRole("button", { name: "Save" }).click();
            await expect.poll(() => configuredUrl(b, env, name)).toBe(`../${name}.git`);
            expect(git(a, env, ["config", "--local", "--get-regexp", "^remote\\."])).toBe(aBefore);
            await assertActiveA();
            if (surface === "explorer") {
                await page.screenshot({
                    path: testInfo.outputPath("manage-remotes-populated.png"),
                });
                await frame.getByRole("button", { name: "Add remote" }).click();
                await frame.getByLabel("Name").fill(name);
                await frame.getByLabel("URL").fill("../duplicate.git");
                await frame.getByRole("button", { name: "Save" }).click();
                await expect(frame.getByRole("alert")).toContainText(
                    `Remote ${name} already exists.`,
                );
                expect(configuredUrl(b, env, name)).toBe(`../${name}.git`);
                await frame.getByRole("button", { name: "Cancel" }).click();
            }

            await frame.locator(`tr[data-remote="${name}"]`).click();
            await frame.getByRole("button", { name: "Edit remote" }).click();
            await frame.getByLabel("Name").fill(renamed);
            await frame.getByLabel("URL").fill(`../${renamed}.git`);
            await frame.getByRole("button", { name: "Save" }).click();
            await expect.poll(() => configuredUrl(b, env, renamed)).toBe(`../${renamed}.git`);
            expect(configuredUrl(b, env, name)).toBeNull();
            expect(git(a, env, ["config", "--local", "--get-regexp", "^remote\\."])).toBe(aBefore);
            await assertActiveA();

            await frame.locator(`tr[data-remote="${renamed}"]`).click();
            await frame.getByRole("button", { name: "Remove remote" }).click();
            const confirmation = page.getByRole("dialog", { name: "Warning" });
            await expect(confirmation.getByText(`Remove remote ${renamed}?`)).toBeVisible();
            await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
            await expect.poll(() => configuredUrl(b, env, renamed)).toBeNull();
            expect(git(a, env, ["config", "--local", "--get-regexp", "^remote\\."])).toBe(aBefore);
            await assertActiveA();
            await frame.getByRole("button", { name: "Close" }).click();
        }
    } finally {
        await app.close();
    }
});
