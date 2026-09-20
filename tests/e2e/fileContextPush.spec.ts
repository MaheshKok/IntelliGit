import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { FIXTURE_REFS } from "../fixtures/repo/seed";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "clean" });

/** Runs Git in the fixture's isolated environment and returns stdout without its final newline. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

test("pushes the selected file repository without changing branch, status, or selected bytes", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const originRoot = fixtureWorkspace.workspace.originRoot;
    const gitEnv = fixtureWorkspace.workspace.env;
    const selectedPath = "README.md";
    const selectedFile = path.join(workspaceRoot, selectedPath);
    const branchRef = `refs/heads/${FIXTURE_REFS.main}`;
    const oldLocalTip = runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]);
    const localTree = runGit(workspaceRoot, gitEnv, ["rev-parse", `${oldLocalTip}^{tree}`]);
    const newLocalTip = runGit(workspaceRoot, gitEnv, [
        "commit-tree",
        localTree,
        "-p",
        oldLocalTip,
        "-m",
        "Advance local branch for file Push E2E",
    ]);
    runGit(workspaceRoot, gitEnv, ["update-ref", branchRef, newLocalTip, oldLocalTip]);
    const before = {
        branch: runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]),
        status: runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"]),
        selectedBytes: await readFile(selectedFile),
    };

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

        await page
            .getByRole("treeitem")
            .filter({ hasText: selectedPath })
            .click({ button: "right" });
        await page.getByRole("menuitem", { name: "IntelliGit", exact: true }).hover();
        await page.keyboard.press("ArrowRight");
        const pushAction = page.getByRole("menuitem", { name: /^Push(?:$|\s)/ });
        await expect(pushAction).toBeVisible();
        await pushAction.hover();
        await page.keyboard.press("Enter");

        await expect
            .poll(() => runGit(originRoot, gitEnv, ["rev-parse", branchRef]))
            .toBe(newLocalTip);
        expect(runGit(workspaceRoot, gitEnv, ["branch", "--show-current"])).toBe(before.branch);
        expect(runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"])).toBe(
            before.status,
        );
        expect(await readFile(selectedFile)).toEqual(before.selectedBytes);
    } finally {
        await app.close();
    }
});
