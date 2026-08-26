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

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ElectronApplication, FrameLocator } from "@playwright/test";

import { DIRTY_FIXTURE } from "../fixtures/repo/scenarios";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { ChangesPanel } from "./pageObjects/changesPanel";
import { IntelliGitView } from "./pageObjects/intelliGitView";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Launches the workspace, clicks the changed file, and returns the revealed viewer frame. */
async function openDiffViewer(
    fixtureWorkspace: FixtureWorkspaceFixture,
): Promise<{ electronApp: ElectronApplication; diffFrame: FrameLocator }> {
    const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
    const electronApp = await launchFixtureWorkspace({
        executablePath,
        repoRoot: REPO_ROOT,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });

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

    return { electronApp, diffFrame };
}

test.describe("diff viewer", () => {
    test.use({ scenario: "dirty" });

    test("opens a read-only two-pane diff when a changed file is clicked", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(120_000);
        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace);

        try {
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

    // The one leg the unit and integration suites structurally cannot cover. Each is proven on its
    // own side of the wall: the webview posts a delta a second after the last keystroke and
    // re-bases when the payload returns (diff-viewer.integration.test.tsx), and the host applies
    // it and re-renders without minting a fresh reseed token
    // (editableDiffEditorProvider.test.ts). Neither executes the trip, and both stub the half they
    // do not own -- so a webview that posted into nothing, or a host that answered a message
    // nobody sent, would leave both suites green.
    test("re-diffs an edited block a second after the typing stops", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(120_000);
        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace);

        try {
            const ribbons = diffFrame.locator(".diff-ribbon-layer .diff-ribbon");
            const hunksBefore = await ribbons.count();
            expect(hunksBefore, "the dirty fixture must open on at least one hunk").toBeGreaterThan(
                0,
            );

            // A hunk both panes hold rows for, so typing one side's text into the other can
            // settle it. `.code-lines` and not the block: the block's own text includes the
            // line-number gutter rendered beside it.
            const twoSided = ".diff-segment-changed:not(.diff-segment-empty)";
            const headText = (
                await diffFrame
                    .locator(`[data-testid="diff-pane-left"] .segment${twoSided} .code-lines`)
                    .first()
                    .innerText()
            ).trim();
            expect(headText, "a two-sided hunk must carry text on its HEAD side").not.toBe("");

            const block = diffFrame
                .locator(`[data-testid="diff-pane-right"] .diff-editable-block${twoSided}`)
                .first();
            await block.click();

            const textarea = diffFrame.locator('[data-testid="diff-pane-right-editable"]');
            await expect(textarea).toBeFocused();
            await textarea.fill(headText);

            // The typed text itself proves nothing: the block under the caret paints the draft
            // immediately, before any of it has reached the document. What only the round trip
            // can produce is a re-segmentation -- the working-tree side now matching HEAD, so
            // this stops being a difference and loses its connector. Polled rather than slept on
            // because the wait covers the debounce, the host's edit, and a re-render.
            await expect.poll(() => ribbons.count(), { timeout: 20_000 }).toBeLessThan(hunksBefore);

            // The user's other half of the bargain: the draft it was typed into is still open,
            // still focused, and still holds what was typed.
            await expect(textarea).toBeFocused();
            await expect(textarea).toHaveValue(headText);
        } finally {
            await electronApp.close();
        }
    });

    // Auto-save's own assembled leg, and the same gap the case above closes for the re-diff. The
    // unit suite proves a timer fires and calls `document.save()` against a mocked document; a
    // mock cannot say whether the bytes reached the filesystem, and every failure this feature
    // exists to survive — a refused save, a document that was never dirty, a session disposed
    // first — is a question about a real editor holding a real file. Its own launch rather than
    // an extra assertion on the case above, so a broken save reds auto-save alone instead of
    // muddying which of the two features regressed.
    test("saves the edited file to disk after the typing stops", async ({ fixtureWorkspace }) => {
        test.setTimeout(120_000);
        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace);
        const filePath = path.join(fixtureWorkspace.workspace.root, DIRTY_FIXTURE.mutablePath);

        try {
            // The oracle is the file, so it has to start out NOT holding what we type — the dirty
            // fixture leaves an unstaged edit here, and asserting `toContain` against text that
            // was already present would pass with the feature removed.
            const typed = "autosaved by the diff viewer";
            expect(await readFile(filePath, "utf-8")).not.toContain(typed);

            const block = diffFrame
                .locator('[data-testid="diff-pane-right"] .diff-editable-block')
                .first();
            await block.click();

            const textarea = diffFrame.locator('[data-testid="diff-pane-right-editable"]');
            await expect(textarea).toBeFocused();
            await textarea.fill(typed);

            // Covers the whole chain and nothing shorter: the webview's 1 s post, the host's
            // WorkspaceEdit, the 2 s auto-save timer armed by it, and VS Code writing the buffer
            // out. Read from disk directly rather than through the control channel, which has no
            // operation for file contents.
            await expect
                .poll(() => readFile(filePath, "utf-8"), { timeout: 30_000 })
                .toContain(typed);
        } finally {
            await electronApp.close();
        }
    });
});
