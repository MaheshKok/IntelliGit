import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";

/**
 * Whether a disabled primary action still looks like a button at all.
 *
 * `CommitArea` renders Commit and Push as `variant="primary"`, which fills them with
 * `--intelligit-pycharm-primary` and white text (commit-panel/theme.ts:82-91). Disabling one
 * swaps that for `disabledButtonStyles`, whose comment says the button "keeps its shape and
 * loses its voice" -- transparent ground, dimmed text, "with the border tinted from that same
 * token". The border is where it fails: the style sets `borderColor` and never sets a width or
 * a style, and the primary variant declares no border of its own, so the computed border stays
 * `0px` and the tint has nothing to paint into. Measured in the commit panel: background
 * `rgba(0, 0, 0, 0)`, border `0px solid color(srgb 0.8 0.8 0.8 / 0.225882)`, text at 50% alpha.
 * No fill, no edge, dim text -- the control the user is waiting to become available reads as a
 * line of grey text, and the shape the comment promises does not exist.
 *
 * The same repo already argues this case for the `secondary` variant, whose border is called
 * "the edge that tells the user where a button is" (commit-panel/theme.ts:95-100).
 *
 * The assertion deliberately accepts EITHER a visible fill or a visible edge, because those are
 * the two ways a control can own its footprint and the fix should not be pinned to one of them:
 * the merge editor's disabled Apply keeps its blue fill instead, and would pass this same oracle.
 * What it rejects is having neither.
 *
 * Contrast is not asserted. WCAG 1.4.11 exempts an inactive component from the 3:1 it asks of a
 * control boundary, so the 45% tint is a legitimate "present but muted" choice; only its absence
 * is the defect.
 *
 * No gate saw it: jsdom computes no border for a class-based emotion rule, the contrast oracle
 * reads text against its background rather than the chrome around it, and the pixel baselines
 * froze the flat rendering as correct.
 */

/**
 * The two primary actions, and the one context asserted over.
 *
 * `undocked` mounts the same `CommitArea` and shows the same defect at wide widths, but it is not
 * listed here: measured, all four NARROW projects drop the commit pane entirely, so neither button
 * exists there and the test would be vacuous on half the matrix -- or need an absence branch that
 * passes for the wrong reason. `commit-panel` renders both buttons in all eight projects, and it
 * is the same component, so nothing is lost by asserting there alone.
 */
const BUTTONS = ['[data-testid="commit-action-commit"]', '[data-testid="commit-action-push"]'];
const CONTEXTS = ["commit-panel"] as const;

interface Affordance {
    readonly selector: string;
    readonly text: string;
    readonly disabled: boolean;
    readonly borderWidth: number;
    readonly borderAlpha: number;
    readonly backgroundAlpha: number;
}

/**
 * Reads both buttons in ONE evaluate.
 *
 * Alpha goes through a canvas rather than a string match: these values arrive as `rgba()`,
 * `color(srgb ... / a)` and `color-mix()` results, and a regex over them is a false pass waiting
 * for the next colour function.
 */
async function readAffordances(
    page: import("@playwright/test").Page,
    selectors: readonly string[],
): Promise<readonly Affordance[]> {
    return page.evaluate((list) => {
        // An unparseable value leaves `fillStyle` untouched, so a sentinel goes in first: if the
        // assignment is rejected the sentinel survives and this throws, rather than reporting the
        // sentinel's own opaque alpha and passing an assertion that measured nothing.
        const SENTINEL = "rgba(1, 2, 3, 0.5)";
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("no 2d canvas context");
        const alphaOf = (color: string): number => {
            context.fillStyle = SENTINEL;
            context.fillStyle = color;
            if (context.fillStyle === SENTINEL) throw new Error(`canvas cannot parse ${color}`);
            context.clearRect(0, 0, 1, 1);
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255;
        };

        return list.flatMap((selector) => {
            const element = document.querySelector<HTMLButtonElement>(selector);
            if (element === null) return [];
            const style = getComputedStyle(element);
            return [
                {
                    selector,
                    text: (element.textContent ?? "").trim().slice(0, 24),
                    // Chakra marks a disabled Button three ways and styles all of them; any one
                    // of them means the user cannot press it.
                    disabled:
                        element.disabled ||
                        element.getAttribute("aria-disabled") === "true" ||
                        element.hasAttribute("data-disabled"),
                    borderWidth: parseFloat(style.borderTopWidth),
                    borderAlpha: alphaOf(style.borderTopColor),
                    backgroundAlpha: alphaOf(style.backgroundColor),
                },
            ];
        });
    }, selectors as string[]);
}

test.describe("disabled button affordance", () => {
    for (const context of CONTEXTS) {
        test(`${context}: a disabled primary action still owns a visible footprint`, async ({
            mountHarness,
            page,
        }) => {
            await mountHarness(context, { webviewFixture: HOST_CONTEXT_FIXTURES[context] });
            const found = await readAffordances(page, BUTTONS);

            expect(found.length, `neither primary action was found in ${context}`).toBe(
                BUTTONS.length,
            );

            const disabled = found.filter((button) => button.disabled);
            expect(
                disabled.length,
                `${context} renders no disabled primary action, so this asserts nothing`,
            ).toBeGreaterThan(0);

            // A fill OR an edge. Neither means the control has no footprint of its own and is
            // indistinguishable from the dimmed text of a label.
            const flat = disabled.filter(
                (button) =>
                    button.backgroundAlpha === 0 &&
                    (button.borderWidth < 1 || button.borderAlpha === 0),
            );
            expect(
                flat.length,
                `${flat.length}/${disabled.length} disabled primary actions read as plain text ` +
                    `(no fill and no edge): ${JSON.stringify(flat)}`,
            ).toBe(0);
        });
    }
});
