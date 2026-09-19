import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { DIRTY_FIXTURE, FIXTURE_REFS } from "../fixtures/repo/seed";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

test.use({ scenario: "dirty" });

/** Runs Git in the fixture's isolated environment and returns stdout without its final newline. */
function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

test("fetches the selected file repository without changing local files or working-tree state", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(120_000);
    const repoRoot = path.resolve(__dirname, "../..");
    const workspaceRoot = fixtureWorkspace.workspace.root;
    const originRoot = fixtureWorkspace.workspace.originRoot;
    const gitEnv = fixtureWorkspace.workspace.env;
    const selectedPath = DIRTY_FIXTURE.mutablePath;
    const selectedFile = path.join(workspaceRoot, selectedPath);
    const originHeadRef = `refs/heads/${FIXTURE_REFS.main}`;
    const originTrackingRef = originHeadRef.replace("refs/heads/", "refs/remotes/origin/");
    const oldOriginTip = runGit(originRoot, gitEnv, ["rev-parse", originHeadRef]);
    const originTree = runGit(originRoot, gitEnv, ["rev-parse", `${oldOriginTip}^{tree}`]);
    const newOriginTip = runGit(workspaceRoot, gitEnv, [
        `--git-dir=${originRoot}`,
        "commit-tree",
        originTree,
        "-p",
        oldOriginTip,
        "-m",
        "Advance origin for file Fetch E2E",
    ]);
    runGit(workspaceRoot, gitEnv, [
        `--git-dir=${originRoot}`,
        "update-ref",
        originHeadRef,
        newOriginTip,
        oldOriginTip,
    ]);

    expect(runGit(workspaceRoot, gitEnv, ["rev-parse", originTrackingRef])).toBe(oldOriginTip);
    const before = {
        head: runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"]),
        branch: runGit(workspaceRoot, gitEnv, ["branch", "--show-current"]),
        indexTree: runGit(workspaceRoot, gitEnv, ["write-tree"]),
        status: runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"]),
        selectedBytes: await readFile(selectedFile),
        untrackedBytes: await readFile(path.join(workspaceRoot, DIRTY_FIXTURE.untrackedPath)),
        crlfBytes: await readFile(path.join(workspaceRoot, DIRTY_FIXTURE.crlfPath)),
        ignoredBytes: await readFile(path.join(workspaceRoot, DIRTY_FIXTURE.ignoredPath)),
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
        const fetchAction = page.getByRole("menuitem", { name: /^Fetch(?:$|\s)/ });
        await expect(fetchAction).toBeVisible();
        await fetchAction.hover();
        await page.keyboard.press("Enter");

        await expect
            .poll(() => runGit(workspaceRoot, gitEnv, ["rev-parse", originTrackingRef]))
            .toBe(newOriginTip);
        expect(runGit(workspaceRoot, gitEnv, ["rev-parse", "HEAD"])).toBe(before.head);
        expect(runGit(workspaceRoot, gitEnv, ["branch", "--show-current"])).toBe(before.branch);
        expect(runGit(workspaceRoot, gitEnv, ["write-tree"])).toBe(before.indexTree);
        expect(runGit(workspaceRoot, gitEnv, ["status", "--porcelain=v1", "-z"])).toBe(
            before.status,
        );
        expect(await readFile(selectedFile)).toEqual(before.selectedBytes);
        expect(await readFile(path.join(workspaceRoot, DIRTY_FIXTURE.untrackedPath))).toEqual(
            before.untrackedBytes,
        );
        expect(await readFile(path.join(workspaceRoot, DIRTY_FIXTURE.crlfPath))).toEqual(
            before.crlfBytes,
        );
        expect(await readFile(path.join(workspaceRoot, DIRTY_FIXTURE.ignoredPath))).toEqual(
            before.ignoredBytes,
        );
    } finally {
        await app.close();
    }
});
