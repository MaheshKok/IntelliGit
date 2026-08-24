import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIFF_VIEWER_CSS = resolve(
    __dirname,
    "../../../src/webviews/react/diff-viewer/diff-viewer.css",
);

/**
 * Returns one rule's declaration block, or null when the selector is absent.
 * The viewer stylesheet contains no nested at-rules around these selectors, so a
 * first-closing-brace scan is exact.
 */
function ruleBlock(css: string, selector: string): string | null {
    const at = css.indexOf(`${selector} {`);
    if (at === -1) return null;
    const close = css.indexOf("}", at);
    if (close === -1) return null;
    return css.slice(css.indexOf("{", at) + 1, close);
}

/**
 * The sticky viewport is the half of the two-pane scroll model that no pixel
 * baseline can witness: at scrollTop 0 a pinned viewport and an unpinned one
 * render identically, and the harness never scrolls. These assertions are the
 * only gate over it, so they read the shipped stylesheet rather than a copy.
 */
describe("diff viewer sticky viewport", () => {
    const css = readFileSync(DIFF_VIEWER_CSS, "utf8");

    it("pins the viewport to the top of its scroller", () => {
        const block = ruleBlock(css, ".diff-viewport");
        expect(block, ".diff-viewport is no longer declared").toBeTruthy();
        expect(block).toMatch(/position:\s*sticky/);
        expect(
            block,
            "a sticky box with no inset never sticks — it scrolls away with the content, so the columns leave the viewport instead of being translated inside it",
        ).toMatch(/\btop:\s*0/);
    });

    it("cancels exactly its own height, in pixels rather than as a percentage", () => {
        const block = ruleBlock(css, ".diff-viewport");
        expect(
            block,
            "the viewport height must come from the measured --diff-viewport-h so the margin below can cancel the same number of pixels",
        ).toMatch(/height:\s*var\(--diff-viewport-h/);
        expect(
            block,
            "the margin must SUBTRACT the measured height: `calc(1 * var(--diff-viewport-h))` has the same shape as the fix and is its exact inverse, adding a second viewport of flow instead of removing the one already there",
        ).toMatch(/margin-bottom:\s*calc\(\s*-1\s*\*\s*var\(--diff-viewport-h/);
        expect(
            block,
            "a percentage margin resolves against the containing block's WIDTH (CSS 2.1 §8.3), so a percentage here cancels an unrelated number of pixels and collapses the scroll range",
        ).not.toMatch(/margin-bottom:[^;]*%/);
    });
});
