import { execFileSync } from "node:child_process";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

const REPO_ROOT = path.resolve(__dirname, "../..");

test.use({ scenario: "clean" });

/** Reads or changes only disposable fixture Git state using its isolated configuration. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

/** Opens the Git Log and returns the webview that renders the branch column for `surface`. */
async function openGitLog(page: Page, surface: "docked" | "undocked"): Promise<FrameLocator> {
    const workbench = new Workbench(page);
    const view = new IntelliGitView(page);
    await workbench.runCommand("IntelliGit: Show Git Log");
    if (surface === "docked") return view.revealPanel();
    // The undocked tab drops its branch column below about 668 px, so give the editor the width.
    await workbench.runCommand("View: Close Primary Side Bar");
    // Chat opens in the secondary side bar at launch, so one toggle closes it.
    await workbench.runCommand("View: Toggle Secondary Side Bar Visibility");
    const undock = page.getByRole("button", { name: "Undock...", exact: true });
    await undock.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
    const frame = await view.revealUndocked();
    await expect(frame.getByTestId("undocked-branch-section")).toBeVisible();
    return frame;
}

for (const surface of ["docked", "undocked"] as const) {
    // #264: deleting a worktree from its own row left that row listed until a reload.
    test(`removes a worktree row deleted from its context menu (${surface} Git Log)`, async ({
        fixtureWorkspace,
    }, testInfo) => {
        test.setTimeout(120_000);
        const root = fixtureWorkspace.workspace.root;
        const gitEnv = fixtureWorkspace.workspace.env;
        const linked = `${root}-linked-${surface}`;
        runGit(root, gitEnv, ["worktree", "add", "-b", `linked-${surface}`, linked]);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace: fixtureWorkspace.workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        try {
            const page = await app.firstWindow();
            await page.waitForLoadState("domcontentloaded");
            await dismissFirstRunDialogs(page);
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);
            const frame = await openGitLog(page, surface);

            const row = frame.locator(`[data-worktree-path=${JSON.stringify(linked)}]`);
            const section = frame.getByRole("button", { name: /Worktrees/ });
            await expect(section, "the Worktrees section never appeared").toBeVisible();
            if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
            await expect(row, "the linked worktree was never listed").toBeVisible();
            await row.click({ button: "right" });
            await frame.getByRole("menuitem", { name: "Delete Worktree", exact: true }).click();
            await page.getByRole("button", { name: "Delete Worktree", exact: true }).click();
            await expect
                .poll(() => runGit(root, gitEnv, ["worktree", "list", "--porcelain"]))
                .not.toContain(linked);
            console.info(`[worktree-delete] ${surface}: Git no longer lists ${linked}`);

            await expect(
                row,
                `the ${surface} Git Log still lists a worktree Git has deleted`,
            ).toHaveCount(0, { timeout: 15_000 });
            console.info(`[worktree-delete] ${surface}: row removed`);
        } finally {
            await (
                await app.firstWindow()
            )
                .screenshot({ path: testInfo.outputPath(`worktree-delete-${surface}.png`) })
                .catch(() => undefined);
            await app.close();
        }
    });
}
