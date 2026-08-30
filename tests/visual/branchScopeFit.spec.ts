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
                textOverflow: style.textOverflow,
                clipper,
                fieldWidth: wrapper?.getBoundingClientRect().width ?? -1,
            };
        },
        [label, field] as const,
    );
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
        const fit: Fit = await measure(page, LABEL, FIELD);

        // Separate from the test above on purpose. Making the label shrinkable is what stops the
        // hard cut, and it is also what could hide the text with no affordance at all; the two
        // failures are different edits and must not collapse into one count.
        if (!fit.truncated) return;
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
        const fit: Fit = await measure(page, LABEL, FIELD);

        // The regression guard for the fix, and the reason the fix is two edits rather than one.
        // Flex shrink is weighted by flex-basis, so simply dropping `flex-shrink: 0` would let a
        // 420px-basis search field take a fifth of any deficit out of a ~108px label -- truncating
        // it on panes that fit it today while the field still had 250px to give. Stated without a
        // viewport number so it holds at every pane width the user can drag to.
        if (!fit.truncated) return;
        const floor = FILTER_INPUT_WRAP_STYLE.minWidth as number;
        expect(
            Math.round(fit.fieldWidth),
            `"${fit.title}" was truncated while the search field still measured ` +
                `${Math.round(fit.fieldWidth)}px against its ${floor}px floor, so the label gave ` +
                `up width the field should have given first`,
        ).toBeLessThanOrEqual(floor);
    });
});
