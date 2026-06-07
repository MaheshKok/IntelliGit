import type { CSSProperties } from "react";
import { ROW_HEIGHT } from "../graph";
import { JETBRAINS_UI } from "../shared/tokens";

export const AUTHOR_COL_WIDTH = 104;
export const DATE_COL_WIDTH = 118;
export const ROW_SIDE_PADDING = 8;

export const ROOT_STYLE: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: JETBRAINS_UI.color.editor,
    color: JETBRAINS_UI.color.foreground,
};

export const FILTER_BAR_STYLE: CSSProperties = {
    minHeight: JETBRAINS_UI.size.toolbarHeight,
    padding: "4px 8px",
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
    flex: "0 1 420px",
    minWidth: 170,
    maxWidth: 460,
};

export const FILTER_INPUT_STYLE: CSSProperties = {
    width: "100%",
    height: 22,
    padding: "0 22px 0 8px",
    background: JETBRAINS_UI.color.input,
    color: "var(--vscode-input-foreground)",
    border: `1px solid ${JETBRAINS_UI.color.inputBorder}`,
    borderRadius: `${JETBRAINS_UI.size.radius}px`,
    fontSize: "12px",
    outline: "none",
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
    opacity: 0.82,
    fontSize: "11px",
    marginLeft: 6,
    flexShrink: 0,
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
    zIndex: 1,
};

export const LOADING_MORE_STYLE: CSSProperties = {
    padding: "8px",
    textAlign: "center",
    fontSize: "11px",
    opacity: 0.5,
};
