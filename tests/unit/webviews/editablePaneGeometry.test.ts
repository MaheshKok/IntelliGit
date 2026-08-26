import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The editable pane's geometry is a cross-file agreement that nothing else can catch. jsdom never
 * loads a stylesheet, so the integration suite renders these elements with no geometry at all,
 * and the pixel gate only covers views it has baselines for. What is asserted here is the
 * agreement itself — the editable pane against the rows it has to line up with, and the CSS floor
 * against the custom property the app actually publishes — so either side drifting reds, rather
 * than a literal being restated in a second place.
 */
const ROOT = path.resolve(__dirname, "../../..");
/**
 * Comments are stripped, because every matcher below reads declarations. A comment explaining
 * why a rule does NOT use some property otherwise reads as the rule using it, and a comment
 * containing a brace ends the rule early for `ruleBody`.
 */
const read = (rel: string): string =>
    fs.readFileSync(path.join(ROOT, rel), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

const CORE_CSS = read("src/webviews/react/diff-core/diff-core.css");
const VIEWER_CSS = read("src/webviews/react/diff-viewer/diff-viewer.css");
const LAYOUT_TS = read("src/webviews/react/diff-core/mergeScrollLayout.ts");

/** The declaration block of a top-level rule, by exact selector. */
function ruleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`no rule for ${selector}`);
    return match[1];
}

function declaration(css: string, selector: string, property: string): string {
    const match = new RegExp(`(?:^|;|\\n)\\s*${property}:\\s*([^;]+);`).exec(
        ruleBody(css, selector),
    );
    if (!match) throw new Error(`no ${property} on ${selector}`);
    return match[1].trim();
}

/** Top and bottom of a shorthand `padding`, in px. */
function verticalPadding(shorthand: string): [number, number] {
    const parts = shorthand.split(/\s+/).map((part) => {
        const value = Number.parseFloat(part);
        if (Number.isNaN(value)) throw new Error(`non-numeric padding component ${part}`);
        return value;
    });
    return [parts[0], parts.length >= 3 ? parts[2] : parts[0]];
}

/** Left and right of a shorthand `padding`, in px. */
function horizontalPadding(shorthand: string): [number, number] {
    const parts = shorthand.split(/\s+/).map((part) => {
        const value = Number.parseFloat(part);
        if (Number.isNaN(value)) throw new Error(`non-numeric padding component ${part}`);
        return value;
    });
    return [parts.length === 1 ? parts[0] : (parts[3] ?? parts[1]), parts[1]];
}

describe("editable diff pane geometry", () => {
    it("gives the editable pane the same vertical padding as the rows it aligns with", () => {
        // Any vertical padding offsets every line in this pane against its counterpart in the
        // opposite one AND against the ribbons, which are drawn from pane offsets that are
        // 0-based multiples of the line height. It also eats into a border-box height that is
        // exactly `lines x line-height`, pushing the last rows into a scrollbar of the
        // textarea's own inside a viewport that clips it.
        expect(
            verticalPadding(
                declaration(VIEWER_CSS, ".diff-editing-block .diff-edit-textarea", "padding"),
            ),
        ).toEqual(verticalPadding(declaration(CORE_CSS, ".code-line", "padding")));
    });

    it("gives the editable pane the same horizontal padding as the rows it aligns with", () => {
        expect(
            horizontalPadding(
                declaration(VIEWER_CSS, ".diff-editing-block .diff-edit-textarea", "padding"),
            ),
        ).toEqual(horizontalPadding(declaration(CORE_CSS, ".code-line", "padding")));
    });

    it("draws the editable pane's line boxes at the height the layout math assumes", () => {
        // Three files have to agree on this one number and none of them can see the others. The
        // pane's height is computed as `lines x LINE_HEIGHT_PX` and the scroll spacer, the
        // ribbons, and the opposite pane's rows are all placed on the same multiple — so a
        // textarea whose line boxes are any other height drifts one row further out of
        // alignment per line, and is either short enough to scroll itself or tall enough to
        // stretch the whole column. The literal is deliberate: the previous
        // `var(--diff-line-height, 20px)` named a property nothing in the repo ever defines,
        // which reads as configurable while being a constant, and would silently break this
        // agreement the day someone did define it.
        const paneLineHeight = declaration(
            VIEWER_CSS,
            ".diff-editing-block .diff-edit-textarea",
            "line-height",
        );
        const rowLineHeight = declaration(CORE_CSS, ".code-line", "line-height");
        const layoutPx = /LINE_HEIGHT_PX\s*=\s*(\d+)/.exec(LAYOUT_TS)?.[1];

        expect(paneLineHeight, "the pane's rows must match the immutable side's rows").toBe(
            rowLineHeight,
        );
        expect(
            paneLineHeight,
            "and both must match the constant the pane's own height is computed from",
        ).toBe(`${layoutPx}px`);
    });

    it("keeps the active block textarea out of its own scroll range", () => {
        // The app sizes this pane to hold every line box it renders, so any scrolling it does
        // is scrolling the driver cannot see — it translates the column, never the textarea —
        // and one wheel tick shifts every row against the opposite pane with nothing to put
        // them back. `hidden` on both axes, not `overflow-y`: a classic horizontal scrollbar
        // takes its ~15px out of a border-box height that is exactly lines x line-height,
        // which re-creates the vertical overflow the exact height was supposed to remove.
        expect(declaration(VIEWER_CSS, ".diff-editing-block .diff-edit-textarea", "overflow")).toBe(
            "hidden",
        );
    });

    it("insets the editable pane from the code block's named gutter contract", () => {
        const leftInset = declaration(
            VIEWER_CSS,
            ".diff-editing-block .diff-edit-textarea",
            "left",
        );
        const rightInset = declaration(
            VIEWER_CSS,
            ".diff-editing-block.line-numbers-right .diff-edit-textarea",
            "right",
        );

        expect(leftInset).toBe("var(--diff-line-number-gutter)");
        expect(rightInset).toContain("var(--diff-line-number-gutter)");
        expect(rightInset).toContain("var(--diff-action-gutter)");
        expect(rightInset).not.toMatch(/\d+px/);
    });

    it("never sizes the interaction layer to the shared scroll extent", () => {
        // `--diff-line-min-width` is the widest line across BOTH panes, and every `.code-lines`
        // grid track is sized to it so the panes scroll in lockstep. Sizing this layer to it as
        // well looks like the same contract and is the opposite of it: a textarea wide enough
        // to hold its own content has a `scrollLeft` pinned at 0, so `syncHorizontalScroll`
        // cannot move it while the code scrolls underneath. Measured in a browser: 400px of
        // drift, a click landing five characters from the glyph under the pointer. It also
        // removes the browser's own caret-follow, because a textarea with nothing to scroll
        // has no way to bring a long line's caret back into view.
        //
        // Left at the visible width the layer is a real scroll container, and the part of the
        // shared position it cannot reach is carried as a translation instead — see the
        // `shortfall` in `syncHorizontalScroll`. Asserted over the whole declaration block
        // rather than one property because the failure is "sized to the extent", which
        // `min-width`, `width`, and `padding-right` can each express.
        expect(ruleBody(VIEWER_CSS, ".diff-editing-block .diff-edit-textarea")).not.toContain(
            "--diff-line-min-width",
        );
    });

    it("puts the focus ring on the block rather than on the translated text layer", () => {
        // The text layer is translated horizontally to stay level with the code beneath it, so a
        // ring drawn on that layer slides out of the block it is marking as active. The block
        // itself never moves.
        expect(declaration(VIEWER_CSS, ".diff-editing-block .diff-edit-textarea", "outline")).toBe(
            "0",
        );
        expect(declaration(VIEWER_CSS, ".diff-editing-block.editing", "outline")).toContain(
            "--vscode-focusBorder",
        );
    });

    it("keeps the native interaction layer transparent over the shared highlighted scroll plane", () => {
        const textarea = ".diff-editing-block .diff-edit-textarea";

        expect(declaration(VIEWER_CSS, textarea, "color")).toBe("transparent");
        expect(declaration(VIEWER_CSS, textarea, "-webkit-text-fill-color")).toBe("transparent");
        expect(declaration(VIEWER_CSS, textarea, "caret-color")).toContain(
            "--vscode-editorCursor-foreground",
        );
        expect(declaration(VIEWER_CSS, ".diff-editing-block .code-block", "pointer-events")).toBe(
            "none",
        );
        expect(declaration(VIEWER_CSS, `${textarea}::selection`, "background")).toContain(
            "--vscode-editor-selectionBackground",
        );
    });
});
