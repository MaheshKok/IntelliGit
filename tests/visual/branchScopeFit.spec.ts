import { FILTER_INPUT_WRAP_STYLE } from "../../src/webviews/react/commit-list/styles";
import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";

/**
 * Where the branch-scope label's text actually goes when the filter bar runs out of room.
 *
 * The label declares the whole truncation trio -- `overflow: hidden`, `text-overflow: ellipsis`,
 * `white-space: nowrap` -- and none of it fires, because it is also `flex-shrink: 0`. An element
 * that is never squeezed below its content width never overflows ITSELF, so the ellipsis has
 * nothing to act on: the span keeps its full ~108px, extends past the filter bar, and the undocked
 * pane's own `overflow: hidden` cuts it mid-glyph. Measured at 1200px before the fix, the label's
 * box ended at 744px inside a pane ending at 684px, so 60 of its 108 pixels were gone and
 * "Branch: All branches" read "Branch: A".
 *
 * No gate could see it. jsdom has no flex layout, so the integration suite reads every box as zero
 * wide. The clipping oracle skips the element by construction: collectOracleInputs.ts:381 drops
 * anything that DECLARES `text-overflow: ellipsis` from collection outright, so the one property
 * that makes this element look safe is the property that hides it from the oracle -- which is why
 * knownFindings.json carries `clipping: []` for undocked in all eight projects while the defect
 * shipped. The pixel baselines then froze the cut label as correct.
 */

/** The label, and the search field whose floor decides when the label is allowed to shrink. */
const LABEL = '[data-testid="commit-branch-scope"]';
const FIELD = ".commit-filter-input";

interface Fit {
    readonly text: string;
    readonly title: string;
    readonly labelLeft: number;
    readonly labelRight: number;
    readonly truncated: boolean;
    readonly scrollWidth: number;
    readonly clientWidth: number;
    readonly textOverflow: string;
    readonly clipper: { readonly testid: string | null; left: number; right: number } | null;
    readonly fieldWidth: number;
}

/**
 * Reads the label, its nearest clipping ancestor and the search field in ONE evaluate.
 *
 * They only mean anything together: three round trips could straddle a resize and compare a label
 * from one layout against a pane from another.
 */
async function measure(page: import("@playwright/test").Page, label: string, field: string) {
    return page.evaluate(
        ([labelSelector, fieldSelector]) => {
            const element = document.querySelector<HTMLElement>(labelSelector);
            if (element === null) throw new Error(`no element matched ${labelSelector}`);
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();

            let clipper: { testid: string | null; left: number; right: number } | null = null;
            for (let node = element.parentElement; node !== null; node = node.parentElement) {
                const ancestor = getComputedStyle(node);
                if (ancestor.overflowX === "visible" && ancestor.overflowY === "visible") continue;
                const ancestorBox = node.getBoundingClientRect();
                clipper = {
                    testid: node.dataset.testid ?? null,
                    left: ancestorBox.left,
                    right: ancestorBox.right,
                };
                break;
            }

            // The wrapper, not the input: `flex` and `min-width` live on the wrapper, and the
            // input inside it is `width: 100%`.
            const wrapper = document.querySelector<HTMLElement>(fieldSelector)?.parentElement;

            return {
                text: element.textContent ?? "",
                title: element.title,
                labelLeft: box.left,
                labelRight: box.right,
                // The browser's own report that it had to cut the text, which is exactly the
                // condition under which it paints the ellipsis.
                truncated: element.scrollWidth > element.clientWidth,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                textOverflow: style.textOverflow,
                clipper,
                fieldWidth: wrapper?.getBoundingClientRect().width ?? -1,
            };
        },
        [label, field] as const,
    );
}

/**
 * Both guards below are conditional invariants: they only say anything about a label the pane
 * actually had to cut. Expressing that as `if (!fit.truncated) return` put the early exit BEFORE
 * the only `expect()` in each test, which is indistinguishable from passing -- a fixture that
 * stopped overflowing would turn both green while measuring nothing, and the ellipsis and
 * shrink-order regressions they exist for would ship behind a green suite.
 *
 * Requiring truncation instead is what `measureTruncated` below exists to guarantee, because the
 * precondition does NOT hold everywhere on its own. It was first written as a property of the
 * fixture, on a measurement taken only on macOS: 108px of text in a 106px box at 320px. That is a
 * margin of two pixels, and the Linux container draws the same string at 101px in a 101px box, so
 * all four narrow projects failed there on a label that genuinely fits. The claim was true; the
 * font it was measured in was not the only one.
 */
function requireTruncated(fit: Fit): void {
    expect(
        fit.truncated,
        `"${fit.title}" is not truncated at this pane width (${fit.scrollWidth}px of text in ` +
            `${fit.clientWidth}px of box), so the guard below measures nothing. Either the fixture ` +
            `stopped overflowing or the label was given room; both need a look before this test is ` +
            `trusted again.`,
    ).toBe(true);
}

/** How far the pane may be narrowed hunting for truncation, and in what steps. */
const SHRINK_FLOOR_PX = 240;
const SHRINK_STEP_PX = 20;

/**
 * Measures the label at a pane width that actually had to cut it, narrowing the pane until it does.
 *
 * The room the label gets is not monotonic in the pane width, so no single number is safe to pin.
 * Measured on this fixture: 62px of overflow at 1200px, 91px at 700px, then NONE at 420px and
 * 360px -- widths where the search field still sits above its floor and the label keeps its full
 * 108px -- then 2px at 320px and 42px again at 280px. Wide panes squeeze hardest because the field
 * claims its 420px basis first, and 320px, the narrow projects' own width, lands on the far lip of
 * that trough with almost nothing to spare. Shrinking walks off the lip in whatever font is
 * rendering, which is the part a fixed width cannot do. A pane that still will not truncate by the
 * floor falls through to the same guard, so losing the precondition stays a failure, not a skip.
 */
async function measureTruncated(
    page: import("@playwright/test").Page,
    label: string,
    field: string,
): Promise<Fit> {
    const viewport = page.viewportSize();
    let fit: Fit = await measure(page, label, field);
    for (
        let width = (viewport?.width ?? SHRINK_FLOOR_PX) - SHRINK_STEP_PX;
        !fit.truncated && width >= SHRINK_FLOOR_PX;
        width -= SHRINK_STEP_PX
    ) {
        await page.setViewportSize({ width, height: viewport?.height ?? 720 });
        fit = await measureAfterResize(page, label, field, width);
    }
    requireTruncated(fit);
    return fit;
}

/**
 * Measures only once the pane has actually re-laid-out at `width`.
 *
 * `setViewportSize` resolves when the BROWSER has resized, which is not the moment the page has
 * laid out against the new size. The pane's width follows a resize listener, so a measurement
 * taken in the same tick can still describe the layout before the resize -- reporting the new
 * viewport width and the old pane width together, and with them a label that "fits" only because
 * nothing has moved yet.
 *
 * That race is the best available explanation for what broke the `visual` job, and it is NOT
 * proven. CI failed all four narrow projects at the shrink floor quoting "101px of text in 101px
 * of box" -- the reading from 320px, a width the loop had already left -- which is what a loop
 * that never sees its own resizes would report. Two of the four lost only one of their two tests,
 * which is the shape of a race rather than of a fixture that stopped overflowing.
 *
 * What is NOT established is the race occurring here. Instrumented in the pinned container on an
 * emulated `linux/amd64` host, a step to 300px reports the clipping pane ALREADY at 300px and
 * already truncating, before any settling -- so this guard changes nothing locally, and reverting
 * it leaves the whole suite green (516 passed, both ways). That host runs the suite in 24 minutes
 * against CI's 4.8, and a resize the renderer has that much longer to apply is one it always wins.
 * A slower box is not a weaker CI here; it is a different experiment, and it cannot host the bug.
 *
 * So CI was the only prover, and it has since ruled: run 33390003000 on 75e091f3 passed `visual`,
 * with this guard the only change to this spec. Weigh that for what it is -- the red was seven
 * failures across all four narrow projects, the green is one run, so this is confirmation rather
 * than proof, and a single future red here is a reason to reopen the diagnosis, not to retry.
 * A green LOCAL run remains worth nothing either way, for the reason in the paragraph above.
 *
 * Polling the CLIPPING ANCESTOR is the point: it is the box whose staleness produced the wrong
 * answer, and `window.innerWidth` cannot stand in for it because that updates with the viewport,
 * before the layout it is being used to vouch for. Failing to settle fails the test rather than
 * measuring anyway -- a pane that never adopts the width is a broken harness, and measuring it
 * regardless is precisely how the stale reading came to be blamed on the fixture.
 */
async function measureAfterResize(
    page: import("@playwright/test").Page,
    label: string,
    field: string,
    width: number,
): Promise<Fit> {
    await expect
        .poll(
            async () => {
                const seen = await measure(page, label, field);
                return Math.round((seen.clipper?.right ?? 0) - (seen.clipper?.left ?? 0));
            },
            {
                message:
                    `the ancestor clipping ${label} never re-laid-out at ${width}px, so every ` +
                    `measurement taken here would describe the layout before the resize`,
            },
        )
        .toBe(width);
    return measure(page, label, field);
}

test.describe("branch-scope label fit", () => {
    test("loses width to its own ellipsis, never to the pane's edge", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("undocked", { webviewFixture: HOST_CONTEXT_FIXTURES.undocked });
        const fit: Fit = await measure(page, LABEL, FIELD);

        expect(fit.title, "the label under test").toContain(fit.text.replace(/…$/u, ""));
        expect(fit.clipper, `${LABEL} has no clipping ancestor to be cut by`).not.toBeNull();

        // The defect. A pixel of the label outside this box is a pixel the pane removed with no
        // affordance -- not an ellipsis, just a glyph sliced in half at the pane edge.
        const overhang = fit.labelRight - fit.clipper!.right;
        expect(
            Math.round(overhang),
            `"${fit.title}" runs ${Math.round(overhang)}px past the right edge of its clipping ` +
                `ancestor [data-testid="${fit.clipper?.testid}"], so it is hard-cut rather than ` +
                `ellipsized. Label ${fit.labelLeft}..${fit.labelRight}, clipper ` +
                `${fit.clipper?.left}..${fit.clipper?.right}`,
        ).toBeLessThanOrEqual(0);
        expect(
            Math.round(fit.clipper!.left - fit.labelLeft),
            `"${fit.title}" starts left of its clipping ancestor`,
        ).toBeLessThanOrEqual(0);
    });

    test("shows an ellipsis whenever it is truncated", async ({ mountHarness, page }) => {
        await mountHarness("undocked", { webviewFixture: HOST_CONTEXT_FIXTURES.undocked });
        // Separate from the test above on purpose. Making the label shrinkable is what stops the
        // hard cut, and it is also what could hide the text with no affordance at all; the two
        // failures are different edits and must not collapse into one count.
        const fit: Fit = await measureTruncated(page, LABEL, FIELD);
        expect(
            fit.textOverflow,
            `"${fit.title}" is truncated but paints no ellipsis, so the text just stops`,
        ).toBe("ellipsis");
    });

    test("yields width only after the search field has hit its floor", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("undocked", { webviewFixture: HOST_CONTEXT_FIXTURES.undocked });
        // The regression guard for the fix, and the reason the fix is two edits rather than one.
        // Flex shrink is weighted by flex-basis, so simply dropping `flex-shrink: 0` would let a
        // 420px-basis search field take a fifth of any deficit out of a ~108px label -- truncating
        // it on panes that fit it today while the field still had 250px to give. Stated without a
        // viewport number so it holds at every pane width the user can drag to.
        const fit: Fit = await measureTruncated(page, LABEL, FIELD);
        const floor = FILTER_INPUT_WRAP_STYLE.minWidth as number;
        expect(
            Math.round(fit.fieldWidth),
            `"${fit.title}" was truncated while the search field still measured ` +
                `${Math.round(fit.fieldWidth)}px against its ${floor}px floor, so the label gave ` +
                `up width the field should have given first`,
        ).toBeLessThanOrEqual(floor);
    });
});
