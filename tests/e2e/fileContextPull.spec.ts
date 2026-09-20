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

test("pulls the selected file repository without changing branch, status, or selected bytes", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const originRoot = fixtureWorkspace.workspace.originRoot;
    const gitEnv = fixtureWorkspace.workspace.env;
    const selectedPath = "README.md";
    const selectedFile = path.join(workspaceRoot, selectedPath);
    const originHeadRef = `refs/heads/${FIXTURE_REFS.main}`;
    const oldOriginTip = runGit(originRoot, gitEnv, ["rev-parse", originHeadRef]);
    const originTree = runGit(originRoot, gitEnv, ["rev-parse", `${oldOriginTip}^{tree}`]);
    const newOriginTip = runGit(workspaceRoot, gitEnv, [
        `--git-dir=${originRoot}`,
        "commit-tree",
        originTree,
        "-p",
        oldOriginTip,
        "-m",
        "Advance origin for file Pull E2E",
    ]);
    runGit(workspaceRoot, gitEnv, [
        `--git-dir=${originRoot}`,
        "update-ref",
        originHeadRef,
        newOriginTip,
        oldOriginTip,
    ]);
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
        const pullAction = page.getByRole("menuitem", { name: /^Pull(?:$|\s)/ });
        await expect(pullAction).toBeVisible();
        await pullAction.hover();
        await page.keyboard.press("Enter");

        await expect
            .poll(() => runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]))
            .toBe(newOriginTip);
        expect(runGit(workspaceRoot, gitEnv, ["branch", "--show-current"])).toBe(before.branch);
        expect(runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"])).toBe(
            before.status,
        );
        expect(await readFile(selectedFile)).toEqual(before.selectedBytes);
    } finally {
        await app.close();
    }
});
