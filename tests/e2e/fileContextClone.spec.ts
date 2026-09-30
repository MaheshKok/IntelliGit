import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "clean" });

const CLONE_URL = "git@intelligit-clone.invalid:fixture.git";
const MISSING_URL = "git@intelligit-clone.invalid:missing.git";

/** Runs real Git under this test's isolated configuration. */
function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Captures source repository state that Clone must leave unchanged. */
function sourceState(cwd: string, env: NodeJS.ProcessEnv): string[] {
    return [
        git(cwd, env, "rev-parse", "HEAD"),
        git(cwd, env, "status", "--porcelain"),
        git(cwd, env, "remote", "-v"),
    ];
}

/** Opens the real native menu and checks Clone follows Manage Remotes. */
async function openClone(page: Page, surface: "explorer" | "tab" | "editor"): Promise<void> {
    if (surface === "explorer") {
        await page
            .getByRole("treeitem")
            .filter({ hasText: "README.md" })
            .click({ button: "right" });
    } else if (surface === "tab") {
        await page.getByRole("tab", { name: /README\.md/ }).click({ button: "right" });
    } else {
        await page.locator(".monaco-editor .view-lines").first().click({ button: "right" });
    }
    await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
    const clone = page.getByRole("menuitem", { name: "Clone Repository", exact: true });
    if (!(await clone.isVisible())) await page.keyboard.press("ArrowRight");
    await expect(clone).toBeVisible();
    const labels = (await page.getByRole("menuitem").allTextContents()).map((label) =>
        label.trim(),
    );
    const manage = labels.findIndex((label) => label.startsWith("Manage Remotes"));
    expect(manage, `${surface}: Manage Remotes is visible`).toBeGreaterThanOrEqual(0);
    expect(labels[manage + 1], `${surface}: Clone immediately follows Manage Remotes`).toBe(
        "Clone Repository",
    );
    await clone.hover();
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("Choose how to clone a repository")).toBeVisible();
}

/** Selects the existing SSH route and enters a fixture-owned URL. */
async function enterCloneUrl(page: Page, url = CLONE_URL): Promise<void> {
    await page.getByPlaceholder("Choose how to clone a repository").fill("SSH");
    await page.keyboard.press("Enter");
    const input = page.getByPlaceholder("git@github.com:user/repo.git");
    await expect(input).toBeVisible();
    await input.fill(url);
    await page.keyboard.press("Enter");
}

/** Drives VS Code's real simple folder dialog to a disposable parent. */
async function chooseDestination(page: Page, parent: string): Promise<void> {
    await expect(page.getByText("Choose where to clone the repository")).toBeVisible();
    await page.locator(".quick-input-widget input").first().fill(parent);
    await page.getByRole("button", { name: "Select Destination" }).click();
}

/** Creates a committed source, bare remote, and isolated SSH-shaped Git transport. */
async function prepareCloneFixture(workspace: FixtureWorkspaceFixture["workspace"]) {
    const ownedRoot = path.dirname(workspace.profileDir);
    const source = path.join(ownedRoot, "clone-source");
    const remote = path.join(ownedRoot, "clone-remote.git");
    const globalConfig = path.join(ownedRoot, "clone-global.gitconfig");
    const workspaceSettings = path.join(workspace.root, ".vscode", "settings.json");
    await mkdir(path.dirname(workspaceSettings), { recursive: true });
    const existingSettings = existsSync(workspaceSettings)
        ? (JSON.parse(await readFile(workspaceSettings, "utf8")) as Record<string, unknown>)
        : {};
    await writeFile(
        workspaceSettings,
        `${JSON.stringify({ ...existingSettings, "files.simpleDialog.enable": true })}\n`,
    );
    await mkdir(source);
    git(source, workspace.env, "init", "-b", "main");
    await writeFile(path.join(source, "proof.txt"), "native clone proof\n");
    git(source, workspace.env, "add", "proof.txt");
    git(
        source,
        workspace.env,
        "-c",
        "user.name=Clone Fixture",
        "-c",
        "user.email=clone@example.invalid",
        "commit",
        "-m",
        "proof",
    );
    git(ownedRoot, workspace.env, "clone", "--bare", source, remote);
    git(
        ownedRoot,
        workspace.env,
        "config",
        "--file",
        globalConfig,
        `url.${remote}.insteadOf`,
        CLONE_URL,
    );
    git(
        ownedRoot,
        workspace.env,
        "config",
        "--file",
        globalConfig,
        `url.${path.join(ownedRoot, "nonexistent-remote.git")}.insteadOf`,
        MISSING_URL,
    );

    const env = { ...workspace.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("GIT_CONFIG_") || key === "GIT_CONFIG_PARAMETERS") delete env[key];
    }
    Object.assign(env, {
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_SSH_COMMAND: "false",
    });
    return {
        ownedRoot,
        source,
        env,
        workspace: { ...workspace, env },
        workspaceBefore: sourceState(workspace.root, env),
        sourceBefore: sourceState(source, env),
    };
}

/** Launches the extension against the isolated fixture and closes it before cleanup. */
async function withCloneApp(
    fixtureWorkspace: FixtureWorkspaceFixture,
    run: (page: Page, fixture: Awaited<ReturnType<typeof prepareCloneFixture>>) => Promise<void>,
): Promise<void> {
    const extensionRoot = path.resolve(__dirname, "../..");
    const fixture = await prepareCloneFixture(fixtureWorkspace.workspace);
    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(extensionRoot),
        repoRoot: extensionRoot,
        workspace: fixture.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixtureWorkspace.channelDir);
        await page.getByRole("treeitem").filter({ hasText: "README.md" }).dblclick();
        await run(page, fixture);
        expect(sourceState(fixture.workspace.root, fixture.env)).toEqual(fixture.workspaceBefore);
        expect(sourceState(fixture.source, fixture.env)).toEqual(fixture.sourceBefore);
        expect(await readFile(path.join(fixture.source, "proof.txt"), "utf8")).toBe(
            "native clone proof\n",
        );
    } finally {
        await app.close();
    }
}

for (const surface of ["explorer", "tab", "editor"] as const) {
    test(`${surface} Clone creates a real repository in the chosen parent`, async ({
        fixtureWorkspace,
    }) => {
        await withCloneApp(fixtureWorkspace, async (page, fixture) => {
            const parent = path.join(fixture.ownedRoot, `destination-${surface}`);
            await mkdir(parent);
            await openClone(page, surface);
            await enterCloneUrl(page);
            await chooseDestination(page, parent);
            const target = path.join(parent, "fixture");
            await expect(
                page.getByText("Cloned fixture successfully.", { exact: true }),
            ).toBeVisible();
            await expect.poll(() => existsSync(path.join(target, "proof.txt"))).toBe(true);
            expect(git(target, fixture.env, "rev-parse", "HEAD")).toBe(
                git(fixture.source, fixture.env, "rev-parse", "HEAD"),
            );
            expect(await readFile(path.join(target, "proof.txt"), "utf8")).toBe(
                "native clone proof\n",
            );
            expect(git(target, fixture.env, "config", "--local", "remote.origin.url")).toBe(
                CLONE_URL,
            );
            expect(existsSync(path.join(fixture.workspace.root, "fixture"))).toBe(false);
        });
    });
}

test("Clone cancellation leaves destination and source unchanged", async ({ fixtureWorkspace }) => {
    await withCloneApp(fixtureWorkspace, async (page, fixture) => {
        const parent = path.join(fixture.ownedRoot, "destination-cancel");
        await mkdir(parent);
        await openClone(page, "explorer");
        await page.keyboard.press("Escape");
        await expect(page.getByPlaceholder("Choose how to clone a repository")).toBeHidden();
        await openClone(page, "explorer");
        await enterCloneUrl(page);
        await expect(page.getByText("Choose where to clone the repository")).toBeVisible();
        await page.locator(".quick-input-widget input").first().fill(parent);
        await page.keyboard.press("Escape");
        await expect(page.getByText("Choose where to clone the repository")).toBeHidden();
        expect(await readdir(parent)).toEqual([]);
        expect(existsSync(path.join(parent, "fixture"))).toBe(false);
    });
});

test("Clone failure reports an error without a completed repository", async ({
    fixtureWorkspace,
}) => {
    await withCloneApp(fixtureWorkspace, async (page, fixture) => {
        const parent = path.join(fixture.ownedRoot, "destination-failure");
        await mkdir(parent);
        await openClone(page, "explorer");
        await enterCloneUrl(page, MISSING_URL);
        await chooseDestination(page, parent);
        const error = page.getByRole("dialog", { name: /Error: SSH clone failed/ });
        await expect(error).toBeVisible();
        await expect(error).toContainText("nonexistent-remote.git");
        expect(existsSync(path.join(parent, "missing", ".git"))).toBe(false);
        await expect(page.getByText(/Cloned missing successfully/)).toBeHidden();
    });
});

test("Clone overwrite refusal keeps the existing target", async ({ fixtureWorkspace }) => {
    await withCloneApp(fixtureWorkspace, async (page, fixture) => {
        const parent = path.join(fixture.ownedRoot, "destination-existing");
        const target = path.join(parent, "fixture");
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "sentinel.txt"), "keep this\n");
        await openClone(page, "explorer");
        await enterCloneUrl(page);
        await chooseDestination(page, parent);
        const warning = page.getByRole("dialog", { name: "Warning" });
        await expect(
            warning.getByText('Directory "fixture" already exists. Overwrite?'),
        ).toBeVisible();
        await warning.getByRole("button", { name: "Cancel" }).click();
        expect(await readFile(path.join(target, "sentinel.txt"), "utf8")).toBe("keep this\n");
        expect(existsSync(path.join(target, ".git"))).toBe(false);
    });
});
