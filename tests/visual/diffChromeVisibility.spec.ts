import { HOST_CONTEXT_FIXTURES } from "./hostContextFixtures";
import { expect, test } from "./playwright/harnessPage";

/**
 * The two pieces of diff chrome that tell a reader where the code stops.
 *
 * Both fail the same way -- space is reserved, nothing is painted into it -- and both only
 * become legibility defects once a line is wider than its pane, which is every line at 320px.
 *
 * The scrollbar: `.diff-horizontal-scroll` is the one bar that drives every pane's shared
 * scroll extent, and diff-viewer.css declares `::-webkit-scrollbar` for it and nothing else.
 * In Chromium, styling `::-webkit-scrollbar` at all opts the scroller out of the default
 * appearance, so the parts left undeclared -- `-thumb`, `-track` -- paint nothing. The bar is
 * mounted, 9px tall and scrollable (measured `scrollWidth - clientWidth === 43` at 320px), and
 * completely invisible. The merge editor's byte-parallel `.merge-horizontal-scroll` declares
 * all three (merge-editor.css:715-726) and reads a real colour, which is why it is asserted
 * here beside the diff viewer: it is the control that proves this oracle can pass.
 *
 * The seam: `.line-number` reserves `border-left: 1px solid transparent` and no rule ever gives
 * it a colour, so the gutter and the code it numbers meet with nothing between them. When a line
 * overflows, `.code-lines` clips it mid-glyph exactly at that meeting point, and a half-drawn
 * character sits flush against a line number. Which side faces the code is a property of the
 * block, not a constant -- `.code-block` puts the gutter left, `.code-block.line-numbers-right`
 * puts it right -- so a single-sided rule paints the seam on one and the pane's outer edge on
 * the other. The side is therefore derived here from measured geometry rather than from the
 * class, and the outer side is asserted unpainted so that painting both cannot pass.
 *
 * No existing gate sees either one. The pixel baselines froze both as correct; jsdom has no
 * layout and no scrollbar pseudo-elements; and the contrast and clipping oracles read elements,
 * not the chrome drawn around them.
 */

/** Each surface with the shared scroll bar that drives its panes. */
const SURFACES = [
    { surface: "diff-viewer", bar: ".diff-horizontal-scroll" },
    { surface: "merge-editor", bar: ".merge-horizontal-scroll" },
] as const;

interface BlockChrome {
    /** The gutter edge that meets the code, derived from the two boxes' positions. */
    readonly codeFacing: "left" | "right";
    readonly facingWidth: number;
    readonly facingAlpha: number;
    readonly outerWidth: number;
    readonly outerAlpha: number;
}

interface Chrome {
    readonly barFound: boolean;
    readonly barMaxScroll: number;
    readonly thumbAlpha: number;
    readonly blocks: readonly BlockChrome[];
}

/**
 * Reads the scroll bar's thumb and every code block's gutter borders in ONE evaluate.
 *
 * Alpha is resolved through a canvas rather than by matching the computed string, because the
 * values arrive in three different syntaxes (`rgba()`, `rgb()`, `color(srgb ... / a)`) and a
 * regex over them is a silent false pass waiting for the next colour function.
 */
async function readChrome(
    page: import("@playwright/test").Page,
    barSelector: string,
): Promise<Chrome> {
    return page.evaluate((selector) => {
        // Canvas normalises every colour syntax to 8-bit RGBA. An unparseable value leaves
        // `fillStyle` at whatever it held, so a sentinel goes in first: if the assignment is
        // rejected the sentinel survives and this throws, instead of reporting the sentinel's
        // own opaque alpha and passing an assertion that never measured anything.
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

        const bar = document.querySelector<HTMLElement>(selector);
        const blocks = [...document.querySelectorAll<HTMLElement>(".code-block")].flatMap(
            (block) => {
                const gutter = block.querySelector<HTMLElement>(".line-numbers");
                const code = block.querySelector<HTMLElement>(".code-lines");
                const number = block.querySelector<HTMLElement>(".line-number");
                if (gutter === null || code === null || number === null) return [];
                const gutterBox = gutter.getBoundingClientRect();
                const codeBox = code.getBoundingClientRect();
                const style = getComputedStyle(number);
                const codeFacing = (
                    codeBox.left < gutterBox.left ? "left" : "right"
                ) as BlockChrome["codeFacing"];
                const facing =
                    codeFacing === "left"
                        ? { width: style.borderLeftWidth, color: style.borderLeftColor }
                        : { width: style.borderRightWidth, color: style.borderRightColor };
                const outer =
                    codeFacing === "left"
                        ? { width: style.borderRightWidth, color: style.borderRightColor }
                        : { width: style.borderLeftWidth, color: style.borderLeftColor };
                return [
                    {
                        codeFacing,
                        facingWidth: parseFloat(facing.width),
                        facingAlpha: alphaOf(facing.color),
                        outerWidth: parseFloat(outer.width),
                        outerAlpha: alphaOf(outer.color),
                    },
                ];
            },
        );

        return {
            barFound: bar !== null,
            barMaxScroll: bar === null ? 0 : Math.round(bar.scrollWidth - bar.clientWidth),
            thumbAlpha:
                bar === null
                    ? 0
                    : alphaOf(getComputedStyle(bar, "::-webkit-scrollbar-thumb").backgroundColor),
            blocks,
        };
    }, barSelector);
}

test.describe("diff chrome visibility", () => {
    for (const { surface, bar } of SURFACES) {
        test(`${surface}: the shared horizontal scrollbar draws a thumb`, async ({
            mountHarness,
            page,
        }) => {
            await mountHarness(surface, { webviewFixture: HOST_CONTEXT_FIXTURES[surface] });
            const chrome = await readChrome(page, bar);

            expect(chrome.barFound, `${bar} is not mounted, so nothing was measured`).toBe(true);
            expect(
                chrome.thumbAlpha,
                `${bar} paints no thumb: the bar scrolls ${chrome.barMaxScroll}px and the user ` +
                    `cannot see or grab it`,
            ).toBeGreaterThan(0);
        });

        test(`${surface}: the line-number gutter is separated from the code it numbers`, async ({
            mountHarness,
            page,
        }) => {
            await mountHarness(surface, { webviewFixture: HOST_CONTEXT_FIXTURES[surface] });
            const chrome = await readChrome(page, bar);

            expect(chrome.blocks.length, "no code blocks were measured").toBeGreaterThan(0);

            const unpainted = chrome.blocks.filter(
                (block) => block.facingAlpha === 0 || block.facingWidth < 1,
            );
            expect(
                unpainted.length,
                `${unpainted.length}/${chrome.blocks.length} code blocks let the gutter meet the ` +
                    `code with no seam, first: ${JSON.stringify(unpainted[0])}`,
            ).toBe(0);

            // Width AND alpha: a zero-width border still reports whatever colour it inherited,
            // so alpha alone would flag every block that simply has no border on that side.
            const outerPainted = chrome.blocks.filter(
                (block) => block.outerAlpha > 0 && block.outerWidth >= 1,
            );
            expect(
                outerPainted.length,
                `${outerPainted.length}/${chrome.blocks.length} code blocks paint the gutter's ` +
                    `outer edge, which doubles the pane boundary beside it, first: ` +
                    `${JSON.stringify(outerPainted[0])}`,
            ).toBe(0);
        });
    }
});
