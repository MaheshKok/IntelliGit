import type { CSSProperties } from "react";
import { ROW_HEIGHT } from "../graph";
import { JETBRAINS_UI, Z_INDEX } from "../shared/tokens";

export const AUTHOR_COL_WIDTH = 104;
export const DATE_COL_WIDTH = 118;
export const CHECKS_COL_WIDTH = 28;
/** Gap between the fixed metadata columns in rows and their header. */
export const METADATA_COLUMN_MARGIN = 4;
/** Minimum width reserved for readable commit-message text before metadata. */
const MESSAGE_MIN_WIDTH = 120;
export const ROW_SIDE_PADDING = 8;

/**
 * Chooses the metadata columns that fit beside the minimum readable commit message.
 *
 * The thresholds are derived from the fixed metadata widths and their shared margin,
 * including the optional checks column, so a width change cannot silently make
 * the message cell collapse again.
 */
export function visibleMetaColumns(
    availableWidth: number,
    showChecks: boolean,
): { author: boolean; date: boolean } {
    const checksWidth = showChecks ? CHECKS_COL_WIDTH + METADATA_COLUMN_MARGIN : 0;
    const authorThreshold =
        MESSAGE_MIN_WIDTH + AUTHOR_COL_WIDTH + METADATA_COLUMN_MARGIN + checksWidth;
    const bothColumnsThreshold = authorThreshold + DATE_COL_WIDTH + METADATA_COLUMN_MARGIN;

    return {
        author: availableWidth >= authorThreshold,
        date: availableWidth >= bothColumnsThreshold,
    };
}

export const ROOT_STYLE: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: JETBRAINS_UI.color.editor,
    color: JETBRAINS_UI.color.foreground,
};

export const FILTER_BAR_STYLE: CSSProperties = {
    minHeight: 30,
    padding: "3px 8px",
    borderBottom: `1px solid ${JETBRAINS_UI.color.border}`,
    background: JETBRAINS_UI.color.toolbar,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexShrink: 0,
};

export const FILTER_ICON_STYLE: CSSProperties = {
    opacity: 0.95,
    flexShrink: 0,
};

export const FILTER_INPUT_WRAP_STYLE: CSSProperties = {
    position: "relative",
    // The field, not the branch-scope label beside it, yields first. Flex shrink is
    // weighted by flex-basis, so a 420px basis against the label's ~108px would take
    // a fifth of any deficit out of the label while the field still had 250px to
    // give — truncating the label on panes that fit it today. Basing the field at its
    // own floor and letting it grow makes it the last item to freeze. The 420px cap
    // is the width `0 1 420px` already resolved to whenever there was room (grow was
    // 0, so the old 460px cap was unreachable), so every layout that fits renders
    // identically.
    flex: "1 1 170px",
    minWidth: 170,
    maxWidth: 420,
};

/**
 * Focus ring for the commit filter, matching the branch search input beside it.
 *
 * The field previously set `outline: none` and defined no focus style, so a
 * keyboard user tabbing into the commit graph had no way to see where focus
 * had landed — WCAG 2.4.7. The transparent outline reserves the ring's space so
 * focusing does not shift the 20px-tall field, and `:focus-visible` only paints
 * it for keyboard entry, never for a click.
 */
export const FILTER_INPUT_CLASS = "commit-filter-input";

export const FILTER_INPUT_CLASS_CSS = `
    .${FILTER_INPUT_CLASS}:focus-visible {
        outline-color: var(--vscode-focusBorder, #007acc);
    }
`;

export const FILTER_INPUT_STYLE: CSSProperties = {
    width: "100%",
    height: 20,
    padding: "0 22px 0 8px",
    background: JETBRAINS_UI.color.input,
    color: "var(--vscode-input-foreground)",
    border: `1px solid ${JETBRAINS_UI.color.inputBorder}`,
    borderRadius: `${JETBRAINS_UI.size.radius}px`,
    fontSize: "12px",
    outline: "2px solid transparent",
    outlineOffset: "-1px",
};

export const FILTER_CLEAR_BUTTON_STYLE: CSSProperties = {
    position: "absolute",
    right: 4,
    top: "50%",
    transform: "translateY(-50%)",
    width: 14,
    height: 14,
    border: "none",
    background: "transparent",
    color: "var(--vscode-descriptionForeground)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    cursor: "pointer",
    lineHeight: "14px",
};

export const BRANCH_SCOPE_STYLE: CSSProperties = {
    maxWidth: 300,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    // No `opacity` and no `marginLeft`: this label is already painted in the muted
    // foreground, and fading muted text a further 18% pushed it under the 4.5:1 that
    // WCAG 1.4.3 asks of body text. The 6px margin sat on top of the filter bar's own
    // 6px flex gap, so this one chip stood 12px off its neighbour while everything
    // else in the row sat at 6px.
    color: JETBRAINS_UI.color.muted,
    fontSize: "11px",
    // Shrinkable on purpose. `flex-shrink: 0` held this label at its full content
    // width, so once the filter bar ran out of room the span extended past the bar and
    // the pane's own `overflow: hidden` cut it mid-glyph — the `text-overflow:
    // ellipsis` above never fired, because an element that is never shrunk never
    // overflows ITSELF. The `title` on the span still carries the full string.
    //
    // `min-width: 0` is inert today and no test covers it — removing it keeps the
    // suite green, measured. It is here because the automatic minimum size is only 0
    // while `overflow` stays non-visible: setting `overflow: visible` above would
    // restore `min-width: auto` and this whole defect with it, silently.
    minWidth: 0,
};

/** Creates a header row offset that keeps text columns aligned after the graph lanes. */
export function headerRowStyle(graphWidth: number): CSSProperties {
    return {
        display: "flex",
        alignItems: "center",
        height: 22,
        fontSize: "11px",
        borderBottom: `1px solid ${JETBRAINS_UI.color.border}`,
        background: "color-mix(in srgb, var(--vscode-editor-background, #2b3342) 86%, #000 14%)",
        color: JETBRAINS_UI.color.muted,
        opacity: 0.88,
        paddingLeft: graphWidth,
        paddingRight: ROW_SIDE_PADDING,
        flexShrink: 0,
    };
}

export const SCROLL_VIEWPORT_STYLE: CSSProperties = {
    flex: 1,
    overflow: "auto",
};

/** Sizes the virtualized commit-list content to the total number of fixed-height rows. */
export function contentContainerStyle(rowCount: number): CSSProperties {
    return {
        position: "relative",
        height: rowCount * ROW_HEIGHT,
    };
}

export const CANVAS_STYLE: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    pointerEvents: "none",
    zIndex: Z_INDEX.raised,
};

export const LOADING_MORE_STYLE: CSSProperties = {
    padding: "8px",
    textAlign: "center",
    fontSize: "11px",
    opacity: 0.5,
};
