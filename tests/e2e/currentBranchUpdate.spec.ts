import { expect, test } from "./fixtureWorkspace";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    expectPullConsent,
    expectRestoredPull,
    launchPullFixture,
    prepareDirtyPull,
    pullFixtureGit,
} from "./hostFixtures/pullLocalChanges";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

test.use({ scenario: "clean" });

test("current branch Update uses the workspace Merge setting and restores local work", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const workspace = fixtureWorkspace.workspace;
    await mkdir(path.join(workspace.root, ".vscode"), { recursive: true });
    await writeFile(
        path.join(workspace.root, ".vscode/settings.json"),
        JSON.stringify({ "intelligit.updateStrategy": "merge" }),
    );
    pullFixtureGit(workspace, ["add", "--", ".vscode/settings.json"]);
    pullFixtureGit(workspace, ["commit", "-m", "Set native workspace update strategy"]);
    const prepared = await prepareDirtyPull(workspace, false, true);
    const { app, page } = await launchPullFixture(fixtureWorkspace);
    try {
        await new Workbench(page).runCommand("IntelliGit: Show Git Log");
        const frame = await new IntelliGitView(page).revealPanel();
        await frame
            .locator(".branch-row")
            .filter({ has: frame.getByText("main", { exact: true }) })
            .first()
            .click({ button: "right" });
        await frame.getByRole("menuitem", { name: "Update", exact: true }).click();
        await expectPullConsent(page);
        await page.screenshot({ path: testInfo.outputPath("current-update-consent.png") });
        await page.getByRole("button", { name: "Save Changes and Pull", exact: true }).click();
        await expect(page.locator(".notifications-toasts")).toContainText(
            /local changes were restored/i,
        );
        await expectRestoredPull(workspace, prepared, "merge");
    } finally {
        await app.close();
    }
});
