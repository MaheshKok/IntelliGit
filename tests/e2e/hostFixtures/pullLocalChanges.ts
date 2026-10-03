import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { FixtureWorkspace } from "../../fixtures/repo/harness";
import type { FixtureWorkspaceFixture } from "../fixtureWorkspace";
import { expect } from "../fixtureWorkspace";
import { waitForE2eChannelReady } from "../controlChannelClient";
import { dismissFirstRunDialogs, launchFixtureWorkspace } from "./electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./resolveVSCodeExecutable";

const LOCAL_PATH = "pull-local.txt";
const INCOMING_PATH = "pull-incoming.txt";
const BASE = "first\nsecond\nthird\nfourth\nfifth\nsixth\n";
const STAGED = BASE.replace("first", "staged first");
const WORKTREE = STAGED.replace("sixth", "unstaged sixth");
const UNTRACKED = "saved local untracked bytes\n";
const INCOMING = "changed upstream bytes\n";

/** Runs Git only inside a disposable fixture, preserving exact stdout for content assertions. */
export function pullFixtureGit(
    workspace: FixtureWorkspace,
    args: string[],
    cwd = workspace.root,
): string {
    return execFileSync("git", args, { cwd, env: workspace.env, encoding: "utf8" });
}

/** Creates incoming commits and split local edits, optionally diverging history or colliding paths. */
export async function prepareDirtyPull(
    workspace: FixtureWorkspace,
    collision = false,
    divergent = false,
) {
    const git = (args: string[], cwd?: string) => pullFixtureGit(workspace, args, cwd);
    await writeFile(path.join(workspace.root, LOCAL_PATH), BASE);
    git(["add", "--", LOCAL_PATH]);
    git(["commit", "-m", "Seed split staging for native Pull"]);
    git(["push", "origin", "HEAD:refs/heads/main"]);
    const author = path.join(path.dirname(workspace.profileDir), "pull-author");
    git(["clone", "--quiet", "--branch", "main", workspace.originRoot, author]);
    await writeFile(path.join(author, INCOMING_PATH), INCOMING);
    git(["add", "--", INCOMING_PATH], author);
    git(["commit", "-m", "Change incoming content for native Pull"], author);
    git(["push", "origin", "HEAD:refs/heads/main"], author);
    const incomingHead = git(["rev-parse", "HEAD"], author).trim();

    if (divergent) {
        await writeFile(
            path.join(workspace.root, "pull-local-commit.txt"),
            "local committed bytes\n",
        );
        git(["add", "--", "pull-local-commit.txt"]);
        git(["commit", "-m", "Local divergent commit for native Pull"]);
    }
    const localHead = git(["rev-parse", "HEAD"]).trim();

    await writeFile(path.join(workspace.root, LOCAL_PATH), STAGED);
    git(["add", "--", LOCAL_PATH]);
    await writeFile(path.join(workspace.root, LOCAL_PATH), WORKTREE);
    const untrackedPath = collision ? INCOMING_PATH : "pull-untracked.txt";
    await writeFile(path.join(workspace.root, untrackedPath), UNTRACKED);
    const before = await readPullState(workspace, untrackedPath);
    return { incomingHead, localHead, untrackedPath, before };
}

/** Captures Git ownership and exact user bytes so cancellation cannot pass after hidden mutation. */
export async function readPullState(workspace: FixtureWorkspace, untrackedPath: string) {
    const git = (args: string[], cwd?: string) => pullFixtureGit(workspace, args, cwd);
    return {
        head: git(["rev-parse", "HEAD"]),
        branch: git(["branch", "--show-current"]),
        upstream: git(["rev-parse", "--symbolic-full-name", "@{upstream}"]),
        status: git(["status", "--porcelain=v1", "-z"]),
        index: git(["ls-files", "--stage", "-z"]),
        stashes: git(["stash", "list", "--format=%H"]),
        originRefs: git(["show-ref"], workspace.originRoot),
        trackedBytes: await readFile(path.join(workspace.root, LOCAL_PATH)),
        untrackedBytes: await readFile(path.join(workspace.root, untrackedPath)),
    };
}

/** Launches the real extension and closes it if initialization fails before the caller receives it. */
export async function launchPullFixture(fixture: FixtureWorkspaceFixture) {
    const repoRoot = path.resolve(__dirname, "../../..");
    const app = await launchFixtureWorkspace({
        executablePath: await resolveVSCodeExecutable(repoRoot),
        repoRoot,
        workspace: fixture.workspace,
        channelDir: fixture.channelDir,
        timeout: 60_000,
    });
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        await waitForE2eChannelReady(fixture.channelDir);
        return { app, page };
    } catch (error) {
        await app.close().catch(() => undefined);
        throw error;
    }
}

/** Chooses the existing Pull command from the native Explorer context menu. */
export async function chooseFilePull(page: Page): Promise<void> {
    await page.getByRole("treeitem").filter({ hasText: "README.md" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
    await page.keyboard.press("ArrowRight");
    const action = page.getByRole("menuitem", { name: /^Pull(?:$|\s)/ });
    await expect(action).toBeVisible();
    await action.hover();
    await page.keyboard.press("Enter");
}

/** Requires a visible consent action before approving or cancelling any dirty update. */
export async function expectPullConsent(page: Page): Promise<void> {
    await expect(
        page.getByRole("button", { name: "Save Changes and Pull", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Pull with local changes?", { exact: true })).toBeVisible();
}

/** Proves the selected history and exact local staging/content, with one retained operation backup. */
export async function expectRestoredPull(
    workspace: FixtureWorkspace,
    prepared: Awaited<ReturnType<typeof prepareDirtyPull>>,
    strategy?: "rebase" | "merge",
) {
    const git = (args: string[], cwd?: string) => pullFixtureGit(workspace, args, cwd);
    if (strategy) {
        await expect
            .poll(() => git(["show", "-s", "--format=%P", "HEAD"]).trim().split(" "))
            .toEqual(
                strategy === "merge"
                    ? [prepared.localHead, prepared.incomingHead]
                    : [prepared.incomingHead],
            );
        expect(await readFile(path.join(workspace.root, "pull-local-commit.txt"), "utf8")).toBe(
            "local committed bytes\n",
        );
    } else {
        await expect.poll(() => git(["rev-parse", "HEAD"]).trim()).toBe(prepared.incomingHead);
    }
    await expect.poll(() => git(["show", `:${LOCAL_PATH}`])).toBe(STAGED);
    await expect.poll(() => readFile(path.join(workspace.root, LOCAL_PATH), "utf8")).toBe(WORKTREE);
    expect(await readFile(path.join(workspace.root, prepared.untrackedPath), "utf8")).toBe(
        UNTRACKED,
    );
    expect(await readFile(path.join(workspace.root, INCOMING_PATH), "utf8")).toBe(INCOMING);
    expect(git(["branch", "--show-current"])).toBe(prepared.before.branch);
    expect(git(["rev-parse", "--symbolic-full-name", "@{upstream}"])).toBe(
        prepared.before.upstream,
    );
    expect(git(["status", "--porcelain=v1", "-z"])).toBe(prepared.before.status);
    expect(git(["show-ref"], workspace.originRoot)).toBe(prepared.before.originRefs);
    const before = prepared.before.stashes.trim().split("\n").filter(Boolean);
    const after = git(["stash", "list", "--format=%H"]).trim().split("\n").filter(Boolean);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(1)).toEqual(before);
    expect(git(["stash", "list", "--format=%s"]).split("\n")[0]).toContain("IntelliGit update:");
    return after[0];
}
