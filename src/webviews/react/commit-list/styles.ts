import type { CSSProperties } from "react";
import { ROW_HEIGHT } from "../graph";

export const AUTHOR_COL_WIDTH = 104;
export const DATE_COL_WIDTH = 118;
export const ROW_SIDE_PADDING = 8;

export const ROOT_STYLE: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
};

export const FILTER_BAR_STYLE: CSSProperties = {
    minHeight: 22,
    padding: "1px 8px",
    borderBottom: "1px solid var(--vscode-panel-border)",
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
    height: 18,
    padding: "0 22px 0 8px",
    background: "var(--vscode-input-background)",
    color: "var(--vscode-input-foreground)",
    border: "1px solid var(--vscode-input-border)",
    borderRadius: "3px",
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

export function headerRowStyle(graphWidth: number): CSSProperties {
    return {
        display: "flex",
        alignItems: "center",
        height: 22,
        fontSize: "11px",
        borderBottom: "1px solid var(--vscode-panel-border)",
        opacity: 0.5,
        paddingLeft: graphWidth,
        paddingRight: ROW_SIDE_PADDING,
        flexShrink: 0,
    };
}

export const SCROLL_VIEWPORT_STYLE: CSSProperties = {
    flex: 1,
    overflow: "auto",
};

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

export const REF_CONTAINER_STYLE: CSSProperties = {
    display: "flex",
    gap: "3px",
    marginLeft: 8,
    flexShrink: 0,
};

export const REF_LABEL_STYLE: CSSProperties = {
    padding: "1px 6px",
    borderRadius: "3px",
    fontSize: "10px",
    lineHeight: "16px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 160,
    display: "inline-block",
};
