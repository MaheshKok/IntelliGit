import { expect, test } from "./fixtureWorkspace";
import {
    expectPullConsent,
    expectRestoredPull,
    launchPullFixture,
    prepareDirtyPull,
} from "./hostFixtures/pullLocalChanges";
import { IntelliGitView } from "./pageObjects/intelliGitView";
import { Workbench } from "./pageObjects/workbench";

test.use({ scenario: "clean" });

test("current branch Update requests consent and restores local work after changed upstream", async ({
    fixtureWorkspace,
}, testInfo) => {
    test.setTimeout(120_000);
    const prepared = await prepareDirtyPull(fixtureWorkspace.workspace);
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
        await expectRestoredPull(fixtureWorkspace.workspace, prepared);
    } finally {
        await app.close();
    }
});
