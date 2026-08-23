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
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const CORE_CSS = read("src/webviews/react/diff-core/diff-core.css");
const VIEWER_CSS = read("src/webviews/react/diff-viewer/diff-viewer.css");
const APP_TSX = read("src/webviews/react/diff-viewer/DiffViewerApp.tsx");
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

describe("editable diff pane geometry", () => {
    it("gives the editable pane the same vertical padding as the rows it aligns with", () => {
        // Any vertical padding offsets every line in this pane against its counterpart in the
        // opposite one AND against the ribbons, which are drawn from pane offsets that are
        // 0-based multiples of the line height. It also eats into a border-box height that is
        // exactly `lines x line-height`, pushing the last rows into a scrollbar of the
        // textarea's own inside a viewport that clips it.
        expect(verticalPadding(declaration(VIEWER_CSS, ".diff-edit-textarea", "padding"))).toEqual(
            verticalPadding(declaration(CORE_CSS, ".code-line", "padding")),
        );
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
        const paneLineHeight = declaration(VIEWER_CSS, ".diff-edit-textarea", "line-height");
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

    it("never lets the editable pane become a scroll container of its own", () => {
        // The app sizes this pane to hold every line box it renders, so any scrolling it does
        // is scrolling the driver cannot see — it translates the column, never the textarea —
        // and one wheel tick shifts every row against the opposite pane with nothing to put
        // them back. `hidden` on both axes, not `overflow-y`: a classic horizontal scrollbar
        // takes its ~15px out of a border-box height that is exactly lines x line-height,
        // which re-creates the vertical overflow the exact height was supposed to remove.
        expect(declaration(VIEWER_CSS, ".diff-edit-textarea", "overflow")).toBe("hidden");
    });

    it("floors the editable pane at the viewport height the app actually publishes", () => {
        // An empty file has no segments, so its canonical extent is 0 and the inline height is
        // 0px. Without this floor the pane collapses to a textarea's two-row default.
        const floor = declaration(VIEWER_CSS, ".diff-edit-textarea", "min-height");
        const property = /var\((--[a-z-]+)/.exec(floor)?.[1];

        expect(property, "the floor must come from a custom property, not a fixed guess").toBe(
            "--diff-viewport-h",
        );
        expect(
            APP_TSX,
            "and the app has to be the one setting it, or the floor is always the fallback",
        ).toContain(`setProperty("${property}"`);
    });
});
