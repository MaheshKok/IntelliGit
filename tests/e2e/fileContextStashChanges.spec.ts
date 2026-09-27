import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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

/** Runs Git against a disposable fixture repository. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Captures Git identity and content that a wrong-repository stash would change. */
async function snapshot(cwd: string, env: NodeJS.ProcessEnv, files: string[]) {
    return {
        head: runGit(cwd, env, ["rev-parse", "HEAD"]),
        refs: runGit(cwd, env, ["for-each-ref", "--format=%(refname) %(objectname)"]),
        index: runGit(cwd, env, ["ls-files", "--stage", "-z"]),
        status: runGit(cwd, env, ["status", "--porcelain"]),
        contents: await Promise.all(files.map((file) => readFile(path.join(cwd, file), "utf8"))),
    };
}

/** Opens Stash Changes through the visible native IntelliGit submenu. */
async function chooseStash(page: Page): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await parent.click();
    const reset = page.getByRole("menuitem", { name: /^Reset HEAD(?:\.\.\.|…)/ });
    const action = page.getByRole("menuitem", { name: /^Stash Changes(?:\.\.\.|…)/ });
    if (!(await action.count())) {
        await parent.hover();
        await page.keyboard.press("ArrowRight");
    }
    await expect(reset).toBeVisible();
    await expect(action).toBeVisible();
    const labels = await page.getByRole("menuitem").allTextContents();
    expect(labels.findIndex((label) => label.startsWith("Stash Changes"))).toBeGreaterThan(
        labels.findIndex((label) => label.startsWith("Reset HEAD")),
    );
    await action.hover();
    await page.keyboard.press("Enter");
}

test("Explorer, tab, and editor stash clicked B repository while active A stays unchanged", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(210_000);
    const extensionRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const canonicalA = await realpath(a);
    const env = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-stash-changes-b");
    await writeFile(path.join(a, "a-proof.txt"), "A committed\n");
    runGit(a, env, ["add", "a-proof.txt"]);
    runGit(a, env, ["commit", "-m", "A proof"]);
    await writeFile(path.join(a, "a-proof.txt"), "A local change\n");
    await writeFile(path.join(a, "a-untracked.txt"), "A untracked\n");
    await mkdir(b);
    runGit(b, env, ["init", "-b", "main"]);
    runGit(b, env, ["config", "user.name", "Native Stash Test"]);
    runGit(b, env, ["config", "user.email", "native-stash@example.invalid"]);
    await writeFile(path.join(b, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(b, "selected.txt"), "B committed selected\n");
    await writeFile(path.join(b, "second.txt"), "B committed second\n");
    runGit(b, env, ["add", ".gitignore", "selected.txt", "second.txt"]);
    runGit(b, env, ["commit", "-m", "B baseline"]);
    const bHead = runGit(b, env, ["rev-parse", "HEAD"]);
    const bCommittedIndex = runGit(b, env, ["ls-files", "--stage", "-z"]);
    const ignored = path.join(b, "ignored.log");
    await writeFile(ignored, "B ignored stays\n");
    const aFiles = ["a-proof.txt", "a-untracked.txt"];
    const bFiles = ["selected.txt", "second.txt", "untracked.txt", "ignored.log"];
    const aBefore = await snapshot(a, env, aFiles);

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
        const picker = page.getByPlaceholder("Select IntelliGit repository", { exact: true });
        await expect(picker).toBeVisible();
        await picker.fill(path.basename(a));
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

        await page.getByRole("treeitem").filter({ hasText: "native-stash-changes-b" }).click();
        const file = page.locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]');
        for (const [index, surface] of ["explorer", "tab", "editor"].entries()) {
            const staged = `B staged selected ${index}\n`;
            const final = `B worktree selected ${index}\n`;
            const second = `B second tracked ${index}\n`;
            const untracked = `B untracked ${index}\n`;
            await writeFile(path.join(b, "selected.txt"), staged);
            runGit(b, env, ["add", "selected.txt"]);
            await writeFile(path.join(b, "selected.txt"), final);
            await writeFile(path.join(b, "second.txt"), second);
            await writeFile(path.join(b, "untracked.txt"), untracked);
            const before = await snapshot(b, env, bFiles);
            const priorStashes = runGit(b, env, ["stash", "list", "--format=%H"])
                .split("\n")
                .filter(Boolean);
            if (surface === "explorer") await file.click({ button: "right" });
            if (surface === "tab") {
                await file.dblclick();
                await page.getByRole("tab", { name: /selected\.txt/ }).click({ button: "right" });
            }
            if (surface === "editor") {
                await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
            }
            await chooseStash(page);
            const input = page.locator(".quick-input-widget input").first();
            await expect(input).toHaveValue("Stashed changes");
            await expect(page.locator(".quick-input-widget")).toContainText(
                "native-stash-changes-b",
            );
            const message = index === 0 ? "" : `native stash ${surface}`;
            await input.fill(message);
            await page.keyboard.press("Enter");
            await expect
                .poll(
                    () =>
                        runGit(b, env, ["stash", "list", "--format=%H"]).split("\n").filter(Boolean)
                            .length,
                )
                .toBe(priorStashes.length + 1);
            expect(
                runGit(b, env, ["stash", "list", "--format=%H"])
                    .split("\n")
                    .filter(Boolean)
                    .slice(1),
            ).toEqual(priorStashes);
            expect(runGit(b, env, ["rev-parse", "stash@{0}^1"])).toBe(bHead);
            expect(runGit(b, env, ["show", "stash@{0}^2:selected.txt"])).toBe(staged.trim());
            expect(runGit(b, env, ["show", "stash@{0}:selected.txt"])).toBe(final.trim());
            expect(runGit(b, env, ["show", "stash@{0}:second.txt"])).toBe(second.trim());
            expect(runGit(b, env, ["show", "stash@{0}^3:untracked.txt"])).toBe(untracked.trim());
            expect(runGit(b, env, ["ls-tree", "-r", "--name-only", "stash@{0}^3"])).not.toContain(
                "ignored.log",
            );
            expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(before.head);
            await expect
                .poll(() => ({
                    status: runGit(b, env, ["status", "--porcelain"]),
                    index: runGit(b, env, ["ls-files", "--stage", "-z"]),
                }))
                .toEqual({ status: "", index: bCommittedIndex });
            expect(await readFile(ignored, "utf8")).toBe("B ignored stays\n");
            expect(await snapshot(a, env, aFiles)).toEqual(aBefore);
        }

        await writeFile(path.join(b, "selected.txt"), "B cancel staged\n");
        runGit(b, env, ["add", "selected.txt"]);
        await writeFile(path.join(b, "selected.txt"), "B cancel worktree\n");
        await writeFile(path.join(b, "second.txt"), "B cancel second\n");
        await writeFile(path.join(b, "untracked.txt"), "B cancel untracked\n");
        const beforeCancel = await snapshot(b, env, bFiles);
        await file.click({ button: "right" });
        await chooseStash(page);
        await expect(page.locator(".quick-input-widget input").first()).toHaveValue(
            "Stashed changes",
        );
        await page.keyboard.press("Escape");
        await expect(page.locator(".quick-input-widget input").first()).toBeHidden();
        expect(await snapshot(b, env, bFiles)).toEqual(beforeCancel);

        await writeFile(path.join(b, "selected.txt"), "B guard staged\n");
        runGit(b, env, ["add", "selected.txt"]);
        await writeFile(path.join(b, "selected.txt"), "B guard worktree\n");
        await writeFile(path.join(b, "second.txt"), "B guard second\n");
        await writeFile(path.join(b, "untracked.txt"), "B guard untracked\n");
        await writeFile(path.join(b, ".git/MERGE_HEAD"), `${bHead}\n`);
        const beforeGuard = await snapshot(b, env, bFiles);
        await file.click({ button: "right" });
        await chooseStash(page);
        await expect(page.getByRole("dialog", { name: /A merge is in progress/ })).toBeVisible();
        await page.keyboard.press("Escape");
        expect(await snapshot(b, env, bFiles)).toEqual(beforeGuard);
        expect(await snapshot(a, env, aFiles)).toEqual(aBefore);
    } finally {
        await app.close();
    }
});
