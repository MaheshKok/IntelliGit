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

/** Runs Git only inside an isolated fixture repository. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Selects the actual Reset HEAD entry in an open native IntelliGit file submenu. */
async function chooseReset(page: Page): Promise<void> {
    const parent = page.getByRole("menuitem", { name: "IntelliGit", exact: true });
    await parent.click();
    const action = page.getByRole("menuitem", { name: /^Reset HEAD(?:\.\.\.|…)/ });
    if (!(await action.count())) {
        await parent.hover();
        await page.keyboard.press("ArrowRight");
    }
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
    await expect(page.locator(".quick-input-widget input").first()).toHaveValue("HEAD");
}

/** Completes native target, mode, and modal prompts and checks B's final HEAD. */
async function resetTo(
    page: Page,
    b: string,
    env: NodeJS.ProcessEnv,
    target: string,
    mode: string,
    oid: string,
): Promise<void> {
    const input = page.locator(".quick-input-widget input").first();
    await input.fill(target);
    await page.keyboard.press("Enter");
    await expect(input).toBeVisible();
    await input.fill(mode);
    await page.keyboard.press("Enter");
    await expect(
        page.getByRole("dialog", { name: new RegExp(`${mode} reset`, "i") }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(() => runGit(b, env, ["rev-parse", "HEAD"])).toBe(oid);
}

test("three native file menus reset clicked B in every mode while A is unchanged", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(210_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const a = fixtureWorkspace.workspace.root;
    const canonicalA = await realpath(a);
    const env = fixtureWorkspace.workspace.env;
    const b = path.join(a, "native-reset-head-b");
    await mkdir(b);
    runGit(b, env, ["init", "-b", "main"]);
    runGit(b, env, ["config", "user.name", "Native Reset Test"]);
    runGit(b, env, ["config", "user.email", "native-reset@example.invalid"]);
    await writeFile(path.join(b, "selected.txt"), "B zero\n");
    await writeFile(path.join(b, "preserved.txt"), "B preserved\n");
    runGit(b, env, ["add", "selected.txt", "preserved.txt"]);
    runGit(b, env, ["commit", "-m", "B zero"]);
    const zero = runGit(b, env, ["rev-parse", "HEAD"]);
    await writeFile(path.join(b, "selected.txt"), "B one\n");
    runGit(b, env, ["commit", "-am", "B one"]);
    const one = runGit(b, env, ["rev-parse", "HEAD"]);
    runGit(b, env, ["tag", "-a", "native-annotated-one", "-m", "annotated target", one]);
    await writeFile(path.join(b, "selected.txt"), "B two\n");
    runGit(b, env, ["commit", "-am", "B two"]);
    const two = runGit(b, env, ["rev-parse", "HEAD"]);
    const indexAtTwo = runGit(b, env, ["ls-files", "--stage", "-z"]);
    await writeFile(path.join(b, "untracked.txt"), "B untracked\n");
    const aHead = runGit(a, env, ["rev-parse", "HEAD"]);
    const aIndex = runGit(a, env, ["ls-files", "--stage", "-z"]);
    const aRefs = runGit(a, env, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const aStatus = runGit(a, env, ["status", "--porcelain"]);

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

        await page.getByRole("treeitem").filter({ hasText: "native-reset-head-b" }).click();
        const file = page.locator('[role="treeitem"][aria-label="selected.txt"][aria-level="2"]');
        await file.click({ button: "right" });
        await chooseReset(page);
        await page.keyboard.press("Escape");
        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(two);

        await file.click({ button: "right" });
        await chooseReset(page);
        await resetTo(page, b, env, "native-annotated-one", "soft", one);
        expect(runGit(b, env, ["ls-files", "--stage", "-z"])).toBe(indexAtTwo);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B two\n");

        await file.dblclick();
        await page.getByRole("tab", { name: /selected\.txt/ }).click({ button: "right" });
        await chooseReset(page);
        await resetTo(page, b, env, zero, "mixed", zero);
        expect(runGit(b, env, ["rev-parse", ":selected.txt"])).toBe(
            runGit(b, env, ["rev-parse", `${zero}:selected.txt`]),
        );
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B two\n");

        await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
        await chooseReset(page);
        await resetTo(page, b, env, two, "hard", two);
        expect(runGit(b, env, ["ls-files", "--stage", "-z"])).toBe(indexAtTwo);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B two\n");

        await writeFile(path.join(b, "preserved.txt"), "B local tracked change\n");
        await file.click({ button: "right" });
        await chooseReset(page);
        await resetTo(page, b, env, one, "merge", one);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B one\n");
        expect(await readFile(path.join(b, "preserved.txt"), "utf8")).toBe(
            "B local tracked change\n",
        );

        await file.click({ button: "right" });
        await chooseReset(page);
        await resetTo(page, b, env, two, "keep", two);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("B two\n");
        expect(await readFile(path.join(b, "preserved.txt"), "utf8")).toBe(
            "B local tracked change\n",
        );
        expect(await readFile(path.join(b, "untracked.txt"), "utf8")).toBe("B untracked\n");

        await writeFile(path.join(b, "selected.txt"), "B conflicting local change\n");
        await file.click({ button: "right" });
        await chooseReset(page);
        const conflictInput = page.locator(".quick-input-widget input").first();
        await conflictInput.fill(zero);
        await page.keyboard.press("Enter");
        await conflictInput.fill("keep");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await expect(page.getByRole("dialog", { name: /Reset failed:/ })).toBeVisible();
        await page.keyboard.press("Escape");
        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(two);
        expect(runGit(b, env, ["ls-files", "--stage", "-z"])).toBe(indexAtTwo);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe(
            "B conflicting local change\n",
        );
        runGit(b, env, ["checkout", "--", "selected.txt"]);

        runGit(b, env, ["branch", "moving", one]);
        await file.click({ button: "right" });
        await chooseReset(page);
        const input = page.locator(".quick-input-widget input").first();
        await input.fill("moving");
        await page.keyboard.press("Enter");
        await input.fill("soft");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: /Soft reset main/ })).toBeVisible();
        runGit(b, env, ["update-ref", "refs/heads/moving", zero, one]);
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await expect.poll(() => runGit(b, env, ["rev-parse", "HEAD"])).toBe(one);
        expect(runGit(b, env, ["rev-parse", "moving"])).toBe(zero);

        const indexBeforeDenial = runGit(b, env, ["ls-files", "--stage", "-z"]);
        await file.click({ button: "right" });
        await chooseReset(page);
        await input.fill("-bad");
        await page.keyboard.press("Enter");
        await expect(
            page.getByRole("dialog", { name: /Invalid reset target '-bad'/ }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(one);

        await file.click({ button: "right" });
        await chooseReset(page);
        await input.fill(two);
        await page.keyboard.press("Enter");
        await input.fill("hard");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: /Hard reset main/ })).toBeVisible();
        await page.keyboard.press("Escape");
        expect(runGit(b, env, ["rev-parse", "HEAD"])).toBe(one);
        expect(runGit(b, env, ["ls-files", "--stage", "-z"])).toBe(indexBeforeDenial);

        expect(runGit(a, env, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(runGit(a, env, ["ls-files", "--stage", "-z"])).toBe(aIndex);
        expect(runGit(a, env, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(aRefs);
        expect(runGit(a, env, ["status", "--porcelain"])).toBe(aStatus);
    } finally {
        await app.close();
    }
});
