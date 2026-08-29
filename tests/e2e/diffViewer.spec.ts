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

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ElectronApplication, FrameLocator } from "@playwright/test";

import { runGit } from "../fixtures/repo/gitRun";
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
    targetPath: string = DIRTY_FIXTURE.mutablePath,
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

    const changedRow = changesPanel.changedFileRow(targetPath);
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

    test("scrolls the focused right editor horizontally without drawing a control box", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(120_000);
        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace);

        try {
            const block = diffFrame
                .locator(
                    '[data-testid="diff-pane-right"] .diff-editable-block.diff-segment-changed:not(.diff-segment-empty)',
                )
                .first();
            await expect(block).toBeVisible();
            await block.click();

            const textarea = diffFrame.locator('[data-testid="diff-pane-right-editable"]');
            await expect(textarea).toBeFocused();
            await textarea.fill(`horizontal-${"0123456789".repeat(80)}`);
            await expect
                .poll(() =>
                    textarea.evaluate((element) => element.scrollWidth > element.clientWidth),
                )
                .toBe(true);

            const focusedStyle = await textarea.evaluate((element) => {
                const style = getComputedStyle(element);
                return {
                    borderTopWidth: style.borderTopWidth,
                    outlineStyle: style.outlineStyle,
                    outlineWidth: style.outlineWidth,
                    overflowX: style.overflowX,
                    overflowY: style.overflowY,
                };
            });
            expect(focusedStyle).toEqual({
                borderTopWidth: "0px",
                outlineStyle: "none",
                outlineWidth: "0px",
                overflowX: "auto",
                overflowY: "hidden",
            });

            // Filling moves the caret to the long line's end and may scroll there by itself.
            // Return every synchronized surface to zero before the real wheel gesture so the
            // assertion proves the textarea can START a horizontal scroll, not merely mirror one.
            await textarea.evaluate((element) => {
                const control = element as HTMLTextAreaElement;
                control.setSelectionRange(0, 0);
                control.scrollLeft = 0;
                control.dispatchEvent(new Event("scroll", { bubbles: true }));
            });
            await expect.poll(() => textarea.evaluate((element) => element.scrollLeft)).toBe(0);

            const box = await textarea.boundingBox();
            expect(box, "the focused textarea must have a wheel target").not.toBeNull();
            const page = await electronApp.firstWindow();
            await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 10);
            await page.mouse.wheel(420, 0);

            const textareaScrollLeft = () =>
                textarea.evaluate((element) => Math.round(element.scrollLeft));
            await expect.poll(textareaScrollLeft).toBeGreaterThan(0);
            const peerCodeLines = diffFrame
                .locator('[data-testid="diff-pane-left"] .code-lines')
                .first();
            const sharedScrollbar = diffFrame.locator(".diff-horizontal-scroll");
            await expect
                .poll(() => peerCodeLines.evaluate((element) => Math.round(element.scrollLeft)))
                .toBe(await textareaScrollLeft());
            await expect
                .poll(() => sharedScrollbar.evaluate((element) => Math.round(element.scrollLeft)))
                .toBe(await textareaScrollLeft());
        } finally {
            await electronApp.close();
        }
    });

    test("paints only the changed part of the active block after the live re-diff", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(120_000);
        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace);
        const filePath = path.join(fixtureWorkspace.workspace.root, DIRTY_FIXTURE.mutablePath);

        try {
            const block = diffFrame
                .locator(
                    '[data-testid="diff-pane-right"] .diff-editable-block.diff-segment-changed:not(.diff-segment-empty)',
                )
                .first();
            await expect(block).toBeVisible();
            const visibleArrows = diffFrame.locator(".diff-hunk-revert:visible");
            const arrowsBefore = await visibleArrows.count();
            expect(
                arrowsBefore,
                "the fixture's changed hunk must expose a revert arrow",
            ).toBeGreaterThan(0);
            const visibleArrowTestIds = () =>
                visibleArrows.evaluateAll((arrows) =>
                    arrows
                        .map((arrow) => arrow.getAttribute("data-testid"))
                        .filter((testId): testId is string => testId !== null),
                );
            const arrowTestIdsBefore = await visibleArrowTestIds();
            await block.click();

            const textarea = diffFrame.locator('[data-testid="diff-pane-right-editable"]');
            await expect(textarea).toBeFocused();
            const activeBlock = diffFrame.locator(
                '[data-testid="diff-pane-right"] .diff-editing-block',
            );
            // `diff-segment-changed` is the paint itself -- it declares --diff-word-wash and
            // --diff-hunk-bracket (diff-viewer.css:389), and those cascade, so an ancestor
            // carrying it washes every row beneath. One host segment means one changed block,
            // and the paint belongs on the block itself.
            await expect(activeBlock).toBeVisible();
            await expect(activeBlock).toHaveClass(/diff-segment-changed/);
            await expect(visibleArrows).toHaveCount(arrowsBefore);

            const headText = (
                await diffFrame
                    .locator(
                        '[data-testid="diff-pane-left"] .diff-segment-changed:not(.diff-segment-empty) .code-lines',
                    )
                    .first()
                    .innerText()
            ).trim();
            expect(headText, "the corresponding HEAD hunk must carry text").not.toBe("");
            const typed = `${headText}\nlive-echo-visual-state`;
            await textarea.fill(typed);

            // The draft renders immediately, but its revert-action identity can only change after
            // the returned host payload re-segments this hunk into its common HEAD prefix and the
            // added line. That payload must preserve the active surface without another-pane click.
            await expect
                .poll(visibleArrowTestIds, { timeout: 20_000 })
                .not.toEqual(arrowTestIdsBefore);
            await expect
                .poll(() => readFile(filePath, "utf-8"), { timeout: 30_000 })
                .toContain(typed);
            // The echo cuts this run into the HEAD line it now shares and the line that was
            // added, and each keeps its own paint. Three separate claims because they fail
            // separately: the wash returning to the wrapper, the changed child losing its
            // paint, and the run re-coalescing so the shared line has no unpainted block of
            // its own. Asserting only "something is painted changed" would pass all three.
            await expect(activeBlock).toBeVisible();
            await expect(activeBlock).not.toHaveClass(/diff-segment-changed/);
            await expect(
                activeBlock.locator(".diff-editable-block.diff-segment-changed"),
            ).toHaveCount(1);
            await expect(
                activeBlock.locator(".diff-editable-block:not(.diff-segment-changed)"),
            ).toHaveCount(1);
            await expect(textarea).toBeFocused();
            await expect(textarea).toHaveValue(typed);
            await expect(activeBlock.locator(".line-number")).toHaveCount(typed.split("\n").length);
            await expect(visibleArrows).not.toHaveCount(0);
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

    // `scrollRangePx` is unit-proven, but the arithmetic being right says nothing about it
    // reaching the spacer that sizes the scroller: a call site passing a hardcoded 0 typechecks
    // and ships the old range. Only a real window has a viewport height at all — jsdom reports
    // `clientHeight` 0 for everything, so the integration suite cannot tell the two apart.
    test("scrolls the last line of a diff out of sight", async ({ fixtureWorkspace }) => {
        test.setTimeout(120_000);
        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace);

        try {
            const content = diffFrame.locator(".diff-content");
            const lastLine = diffFrame
                .locator('[data-testid="diff-pane-left"] .real-code-line')
                .last();
            await expect(lastLine).toBeVisible();

            // Drive the scroller the way the user's wheel does and let it settle, rather than
            // computing a target here — a target derived from `scrollRangePx` would be the same
            // arithmetic the assertion is meant to be independent of.
            await content.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
            });

            // "Out of sight" as the user means it: the last line has travelled past the top edge
            // of the scrolling viewport, not merely lifted off the bottom one. Three trailing
            // rows leave it parked just above the bottom edge, well inside the box.
            await expect
                .poll(async () => {
                    const [lineBox, contentBox] = await Promise.all([
                        lastLine.boundingBox(),
                        content.boundingBox(),
                    ]);
                    if (!lineBox || !contentBox) return null;
                    return lineBox.y + lineBox.height - contentBox.y;
                })
                .toBeLessThanOrEqual(0);
        } finally {
            await electronApp.close();
        }
    });

    // The caret dragging the viewport back to a block the user has scrolled away from. Every
    // layer below this one is structurally blind to it: jsdom implements neither focus scrolling
    // nor `setSelectionRange`'s scroll-into-view, so the integration suite cannot observe a
    // viewport move at all, and the route-based visual harness has a real engine but a stubbed
    // host, so nothing there moves a draft between two blocks a full screen apart.
    //
    // The fixture is built here rather than in `scenarios.ts` because the defect needs a file
    // tall enough to scroll the first draft entirely out of view -- the dirty fixture's one-line
    // file is always on screen, where a scroll restore is a no-op and the bug cannot show.
    test("keeps the viewport on the block just clicked, not the one the caret came from", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(180_000);
        const scrollPath = "scroll-fixture.txt";
        const workspaceRoot = fixtureWorkspace.workspace.root;
        const gitEnv = fixtureWorkspace.workspace.env;
        const filePath = path.join(workspaceRoot, scrollPath);

        // HEAD side: tall enough that a block near the top leaves the viewport entirely.
        const headLines = Array.from({ length: 140 }, (_, index) => `line ${index + 1};`);
        await writeFile(filePath, `${headLines.join("\n")}\n`, "utf-8");
        await runGit(workspaceRoot, ["add", scrollPath], gitEnv);
        await runGit(workspaceRoot, ["commit", "-m", "seed a scrollable file"], gitEnv);

        // Working-tree side: three separated one-line changes, so the diff is several blocks and
        // the first of them sits near the top -- the user's "line 18".
        const workingLines = [...headLines];
        workingLines[17] = "line 18; edited";
        workingLines[74] = "line 75; edited";
        workingLines[119] = "line 120; edited";
        await writeFile(filePath, `${workingLines.join("\n")}\n`, "utf-8");

        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace, scrollPath);

        try {
            const content = diffFrame.locator(".diff-content");
            const block = diffFrame
                .locator(
                    '[data-testid="diff-pane-right"] .diff-editable-block.diff-segment-changed:not(.diff-segment-empty)',
                )
                .first();
            await expect(block).toBeVisible();

            // Step 1 -- "put cursor at line 18".
            await block.click();
            const textarea = diffFrame.locator('[data-testid="diff-pane-right-editable"]');
            await expect(textarea).toBeFocused();
            const firstDraftTop = await textarea.evaluate((element) =>
                Math.round(element.getBoundingClientRect().top),
            );

            // Step 2 -- "scroll the screen all the way to line 75". Scrolled by bringing the
            // target block into view rather than to `scrollHeight`: the scroller carries a
            // trailing spacer (see "scrolls the last line of a diff out of sight"), so parking at
            // the very bottom leaves NOTHING on screen, and Playwright's click would then scroll
            // the block into view itself -- a viewport move by the test harness, indistinguishable
            // from the one this test exists to catch.
            const lastBlock = diffFrame
                .locator(
                    '[data-testid="diff-pane-right"] .diff-editable-block.diff-segment-changed:not(.diff-segment-empty)',
                )
                .last();
            // Centred by arithmetic against `.diff-content` itself rather than
            // `scrollIntoViewIfNeeded`, which picks the nearest scrollable ancestor and here
            // scrolled something else entirely, leaving `.diff-content` at 0.
            await lastBlock.evaluate((element) => {
                const scroller = element.closest<HTMLElement>(".diff-content");
                if (scroller === null) throw new Error("no .diff-content ancestor to scroll");
                const delta =
                    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
                scroller.scrollTop += delta - scroller.clientHeight / 2;
            });
            const parked = await content.evaluate((element) => Math.round(element.scrollTop));
            expect(
                parked,
                "the fixture must be tall enough to scroll the first draft out of view",
            ).toBeGreaterThan(400);
            const parkedDraftTop = await textarea.evaluate((element) =>
                Math.round(element.getBoundingClientRect().bottom),
            );
            const contentTop = await content.evaluate((element) =>
                Math.round(element.getBoundingClientRect().top),
            );
            expect(
                parkedDraftTop,
                "the precondition is that the first draft is now off-screen above the fold",
            ).toBeLessThan(contentTop);

            // Step 3 -- "try to put cursor" down there. The click moves the draft to a block the
            // first one is nowhere near: the overlay textarea is unmounted from one block and
            // mounted into another, and `autoFocus` plus the selection-restore effect
            // (DiffViewerApp.tsx:601) both fire against the new node.
            await expect(lastBlock).toBeVisible();
            await lastBlock.click();
            await expect(textarea).toBeFocused();

            const settled = await content.evaluate((element) => Math.round(element.scrollTop));
            const secondDraftTop = await textarea.evaluate((element) =>
                Math.round(element.getBoundingClientRect().top),
            );
            expect(
                settled,
                `clicking a block near the bottom must leave the viewport there, not scroll back to the block the caret came from (parked at ${parked}, settled at ${settled}, first draft top ${firstDraftTop}, second draft top ${secondDraftTop})`,
            ).toBeGreaterThan(parked - 100);
        } finally {
            await electronApp.close();
        }
    });

    // The same complaint against the other topology: ONE tall changed block, so the second click
    // lands INSIDE the draft that is already open instead of moving it to a different block. The
    // caret then moves without React ever unmounting the textarea, which is the only path where a
    // stale `setSelectionRange` (DiffViewerApp.tsx:601) could pull the caret -- and the viewport
    // with it -- back to where the caret started. The case above cannot reach that path.
    test("moves the caret down a tall block instead of snapping it back", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(180_000);
        const scrollPath = "tall-block.txt";
        const workspaceRoot = fixtureWorkspace.workspace.root;
        const gitEnv = fixtureWorkspace.workspace.env;
        const filePath = path.join(workspaceRoot, scrollPath);

        const headLines = Array.from({ length: 140 }, (_, index) => `line ${index + 1};`);
        await writeFile(filePath, `${headLines.join("\n")}\n`, "utf-8");
        await runGit(workspaceRoot, ["add", scrollPath], gitEnv);
        await runGit(workspaceRoot, ["commit", "-m", "seed a tall-block file"], gitEnv);

        // One contiguous changed region, taller than the viewport: every line from 10 to 130.
        const workingLines = headLines.map((line, index) =>
            index >= 9 && index < 130 ? `${line} edited` : line,
        );
        await writeFile(filePath, `${workingLines.join("\n")}\n`, "utf-8");

        const { electronApp, diffFrame } = await openDiffViewer(fixtureWorkspace, scrollPath);
        const page = await electronApp.firstWindow();

        try {
            const content = diffFrame.locator(".diff-content");
            const block = diffFrame
                .locator(
                    '[data-testid="diff-pane-right"] .diff-editable-block.diff-segment-changed:not(.diff-segment-empty)',
                )
                .first();
            await expect(block).toBeVisible();
            await block.click({ position: { x: 60, y: 30 } });

            const textarea = diffFrame.locator('[data-testid="diff-pane-right-editable"]');
            await expect(textarea).toBeFocused();
            const caretBefore = await textarea.evaluate(
                (element) => (element as HTMLTextAreaElement).selectionStart,
            );

            // Scroll well down the block, still inside it.
            await content.evaluate((element) => {
                element.scrollTop += 1200;
            });
            const parked = await content.evaluate((element) => Math.round(element.scrollTop));
            expect(parked, "the block must be taller than one viewport").toBeGreaterThan(1000);

            // Clicked by page coordinate rather than by locator: a locator click auto-scrolls the
            // element into view, and the element here is a textarea taller than the viewport, so
            // the harness would move the very scroll position under measurement.
            const [contentBox, textareaBox] = await Promise.all([
                content.boundingBox(),
                textarea.boundingBox(),
            ]);
            expect(contentBox, "the scroller must have a box to click into").not.toBeNull();
            expect(textareaBox, "the open draft must have a box to click into").not.toBeNull();
            // Aimed at the textarea's OWN box, clipped to the part of it currently on screen: the
            // draft is taller than the viewport, so its box midpoint is off-screen, and a guess at
            // the pane's left edge lands in the line-number gutter rather than the editing surface.
            const clickX = (textareaBox?.x ?? 0) + 40;
            const visibleTop = Math.max(textareaBox?.y ?? 0, contentBox?.y ?? 0);
            const visibleBottom = Math.min(
                (textareaBox?.y ?? 0) + (textareaBox?.height ?? 0),
                (contentBox?.y ?? 0) + (contentBox?.height ?? 0),
            );
            expect(
                visibleBottom - visibleTop,
                "part of the draft must be on screen to click into",
            ).toBeGreaterThan(40);
            await page.mouse.click(clickX, (visibleTop + visibleBottom) / 2);
            await expect(
                textarea,
                "clicking inside the open draft must keep it open, not dismiss it",
            ).toBeFocused();

            const settled = await content.evaluate((element) => Math.round(element.scrollTop));
            const caretAfter = await textarea.evaluate(
                (element) => (element as HTMLTextAreaElement).selectionStart,
            );
            expect(
                caretAfter,
                `clicking further down the same draft must move the caret forward, not restore where it started (before ${caretBefore}, after ${caretAfter})`,
            ).toBeGreaterThan(caretBefore);
            expect(
                settled,
                `the caret moved within one draft, so nothing may scroll the viewport back (parked at ${parked}, settled at ${settled})`,
            ).toBeGreaterThan(parked - 100);
        } finally {
            await electronApp.close();
        }
    });
});
