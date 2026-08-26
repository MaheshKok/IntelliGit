// Smoke test for the read-only two-pane diff viewer: clicking a changed file in the sidebar
// opens the viewer with both the HEAD and working-tree panes populated.
//
// This does not use flows/matrix.ts's FlowRow contract: FlowRow's four oracle legs
// (uiOracle/localGitOracle/originOracle/durableStateOracle) exist to prove a *mutation* against
// local git, origin, and durable state, and IMPLEMENTED_FLOW_IDS is a closed union pinned to ten
// canonical flows. Viewing a diff mutates nothing, so it is neither a candidate for that closed set
// nor a fit for oracles that would have nothing to assert. packageSmoke.spec.ts and
// controlChannelRoundTrip.spec.ts establish the precedent for a standalone spec with its own launch
// sequence outside that matrix.

import path from "node:path";

import { DIRTY_FIXTURE } from "../fixtures/repo/scenarios";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { ChangesPanel } from "./pageObjects/changesPanel";
import { IntelliGitView } from "./pageObjects/intelliGitView";

const REPO_ROOT = path.resolve(__dirname, "../..");

test.describe("diff viewer", () => {
    test.use({ scenario: "dirty" });

    test("opens a read-only two-pane diff when a changed file is clicked", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(120_000);
        const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
        const electronApp = await launchFixtureWorkspace({
            executablePath,
            repoRoot: REPO_ROOT,
            workspace: fixtureWorkspace.workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });

        try {
            const page = await electronApp.firstWindow();
            await page.waitForLoadState("domcontentloaded");
            await dismissFirstRunDialogs(page);
            // See runFlow's identical wait in flows/matrix.ts: the marker proves the palette
            // knows IntelliGit's commands before the first interaction depends on it.
            await waitForE2eChannelReady(fixtureWorkspace.channelDir);

            const intelliGitView = new IntelliGitView(page);
            const sidebarFrame = await intelliGitView.reveal();
            const changesPanel = new ChangesPanel(sidebarFrame);

            const changedRow = changesPanel.changedFileRow(DIRTY_FIXTURE.mutablePath);
            await expect(changedRow).toBeVisible();
            await changedRow.click();

            // The diff viewer opens as its own editor-tab panel (DiffViewerPanel.ts), not inside
            // the sidebar or graph-panel frames, so it needs its own marker-based reveal.
            const diffFrame = await intelliGitView.revealDiffViewer();
            await expect(diffFrame.locator('[data-testid="diff-viewer-root"]')).toBeVisible();

            const leftPane = diffFrame.locator('[data-testid="diff-pane-left"]');
            const rightPane = diffFrame.locator('[data-testid="diff-pane-right"]');
            await expect(leftPane).toBeVisible();
            await expect(rightPane).toBeVisible();
            // A mounted pane with no rendered lines is indistinguishable from one that silently
            // received zero segments, so "populated" is proven by counting `.code-lines` blocks
            // (DiffViewerApp.tsx's own scroll-sync code targets this same class), not merely by
            // the pane container's visibility.
            await expect.poll(() => leftPane.locator(".code-lines").count()).toBeGreaterThan(0);
            await expect.poll(() => rightPane.locator(".code-lines").count()).toBeGreaterThan(0);

            // The two panes must disagree: this file's HEAD content and its working-tree content
            // are different (tests/fixtures/repo/seed.ts stages one edit, then leaves a second
            // unstaged on top), so an oracle that only checked non-empty panes would still pass
            // if both sides accidentally rendered the same text.
            const [leftText, rightText] = await Promise.all([
                leftPane.innerText(),
                rightPane.innerText(),
            ]);
            expect(leftText).not.toBe(rightText);
        } finally {
            await electronApp.close();
        }
    });
});
