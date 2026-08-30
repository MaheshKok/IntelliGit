import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";

/**
 * Whether the commit-info pane agrees with the graph about a selection existing.
 *
 * Opening either surface runs one flow: the host sends `loadCommits` with no `selectedHash` of its
 * own (UndockedViewProvider.ts:1483-1489, and the same shape on the docked provider), the webview
 * auto-selects the newest commit -- `data.commits[0]?.hash ?? null` at useUnifiedMessages.ts:146
 * and useCommitGraphMessages.ts:67 -- marks that row `aria-current="true"` (CommitRow.tsx:466), and
 * posts `selectCommit` to fetch its detail (useUnifiedMessages.ts:162). What it never does is say
 * the detail is on its way, so `commitDetailLoading` stays false while `selectedDetail` is still
 * null, and `CommitInfoPane` takes its third branch: `loading ? <CommitInfoLoadingPane/> :
 * <NoCommitSelection/>` (CommitInfoPane.tsx:178-184). The pane renders "No commit selected" beside
 * a row the same screen is drawing as selected. Measured in `undocked` at 1200px: one row with
 * `aria-current="true"` inside `commit-list-viewport`, and one `data-pane-state="empty"` pane.
 *
 * The host makes it worse rather than causing it: `postCommitDetailState` posts a bare
 * `clearCommitDetail` when nothing is loaded and nothing is loading (UndockedViewProvider.ts:1952-
 * 1957), which lands AFTER the webview has already auto-selected. So a fix that only sets a
 * transient loading flag at the moment of auto-selection races that message and loses. The
 * invariant asserted here is deliberately order-independent: it reads the two rendered facts and
 * requires them to agree, whatever sequence produced them.
 *
 * The pane is not asserted to be in any particular non-empty state. A loading skeleton and real
 * detail are both honest answers to "a commit is selected"; only the denial is the defect.
 *
 * No gate saw it: the pixel baselines froze the empty pane as correct, and the unit tests mount
 * `CommitInfoPane` with explicit props rather than replaying the message order that produces the
 * disagreement.
 */

/**
 * The two contexts that mount a commit list and a commit-info pane on one screen.
 *
 * `commit-graph-compact` mounts the list without the pane and `commit-info` mounts the pane without
 * a list, so in both the invariant has nothing to compare and would pass without measuring
 * anything. They are excluded rather than skipped so the count below stays meaningful.
 *
 * Measured across the eight projects, the four NARROW ones do not render the pane at all in either
 * context -- `undocked` drops the whole info section under width pressure (sectionWidths.ts:34-39
 * lists `infoWidth` first in the drop order) and `commit-graph-card` does not lay the pane out at
 * 320px. Those four are kept in the matrix anyway: `paneMounted` is reported, so a regression that
 * hides the pane at a width where it used to show reads as a changed precondition rather than as a
 * silent pass. The four WIDE projects are the ones that can witness the defect.
 */
const CONTEXTS = ["undocked", "commit-graph-card"] as const;

/**
 * The width at or above which both contexts lay the pane out, measured: at 1200px `undocked` and
 * `commit-graph-card` each mount it, and at 320px neither does. Any value strictly between the
 * two project widths separates them; 1000 is far enough from both that a small change to either
 * does not silently reclassify a project.
 */
const PANE_IS_LAID_OUT_ABOVE = 1000;

interface Agreement {
    readonly innerWidth: number;
    readonly currentRows: number;
    readonly paneMounted: boolean;
    readonly paneState: string | null;
}

async function readAgreement(page: import("@playwright/test").Page): Promise<Agreement> {
    return page.evaluate(() => {
        // Scoped to the commit list's own viewport: `aria-current` is also used by the repository
        // row (`undocked-repository-row`), so counting it document-wide would call a selection
        // present on a screen whose graph has none.
        const viewport = document.querySelector("[data-testid='commit-list-viewport']");
        const pane = document.querySelector("[data-testid='commit-info-pane']");
        return {
            innerWidth: window.innerWidth,
            currentRows: viewport ? viewport.querySelectorAll("[aria-current='true']").length : 0,
            paneMounted: pane !== null,
            paneState: pane?.getAttribute("data-pane-state") ?? null,
        };
    });
}

test.describe("commit-info selection agreement", () => {
    for (const context of CONTEXTS) {
        test(`${context}: the commit-info pane does not deny a selection the graph is showing`, async ({
            mountHarness,
            page,
        }) => {
            await mountHarness(context, { webviewFixture: HOST_CONTEXT_FIXTURES[context] });
            const found = await readAgreement(page);

            // Not an assertion about the defect -- an assertion that this surface still auto-selects
            // at all. If the auto-selection ever stops, the invariant below becomes unfalsifiable,
            // and this line says so instead of reporting a pass.
            expect(
                found.currentRows,
                `${context} marks no commit row aria-current, so the agreement below asserts nothing`,
            ).toBe(1);

            // Without this, deleting the pane would turn the agreement below green: `denies` is
            // false when nothing is mounted, so "no pane at all" and "a pane that agrees" would be
            // the same result. Asserted only where the pane is laid out, because the narrow
            // projects drop it legitimately.
            if (found.innerWidth >= PANE_IS_LAID_OUT_ABOVE) {
                expect(
                    found.paneMounted,
                    `${context} lays out no commit-info pane at ${found.innerWidth}px, so the ` +
                        `agreement below cannot fail: ${JSON.stringify(found)}`,
                ).toBe(true);
            }

            const denies = found.paneMounted && found.paneState === "empty";
            expect(
                denies,
                `${context}: the graph marks a row selected while the commit-info pane renders its ` +
                    `"no commit selected" state: ${JSON.stringify(found)}`,
            ).toBe(false);
        });
    }
});
