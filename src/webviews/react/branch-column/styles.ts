import type { CSSProperties } from "react";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";

export const TREE_INDENT_STEP = 18;
export const NODE_ICON_SIZE = 14;

export const BRANCH_ROW_CLASS_CSS = `
    .branch-row:hover {
        background: var(--vscode-list-hoverBackground) !important;
    }
    .branch-row.selected {
        background: var(--vscode-list-activeSelectionBackground) !important;
        color: var(--vscode-list-activeSelectionForeground) !important;
        border-radius: 7px;
    }
    .branch-row.selected:hover {
        background: var(--vscode-list-activeSelectionBackground) !important;
        color: var(--vscode-list-activeSelectionForeground) !important;
    }
    .branch-track-push {
        color: var(--vscode-gitDecoration-addedResourceForeground, #73c991) !important;
    }
    .branch-track-pull {
        color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39) !important;
    }
    .branch-search-input:focus-visible {
        outline-color: var(--vscode-focusBorder, #007acc);
    }
`;

export const PANEL_STYLE: CSSProperties = {
    height: "100%",
    overflow: "auto",
    fontSize: "13px",
    fontFamily: SYSTEM_FONT_STACK,
    borderRight: "1px solid var(--vscode-panel-border)",
    userSelect: "none",
};

export const SEARCH_CONTAINER_STYLE: CSSProperties = {
    minHeight: 22,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "1px 8px",
    color: "var(--vscode-icon-foreground)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
};

export const SEARCH_INPUT_STYLE: CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: 18,
    borderRadius: 3,
    border: "1px solid var(--vscode-input-border, rgba(255,255,255,0.15))",
    background: "var(--vscode-input-background, rgba(0,0,0,0.22))",
    color: "var(--vscode-input-foreground, #d8dbe2)",
    padding: "0 6px",
    fontSize: 12,
    fontFamily: SYSTEM_FONT_STACK,
    outline: "2px solid transparent",
};

export const SEARCH_CLEAR_BUTTON_STYLE: CSSProperties = {
    width: 16,
    height: 16,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--vscode-descriptionForeground, #9ea4b3)",
    background: "transparent",
    border: "none",
    padding: 0,
    cursor: "pointer",
    flexShrink: 0,
    lineHeight: "14px",
};

export const HEAD_WRAPPER_STYLE: CSSProperties = {
    padding: "2px 10px 1px",
};

export const TREE_SECTION_STYLE: CSSProperties = {
    paddingLeft: 4,
};

export const NO_MATCH_STYLE: CSSProperties = {
    padding: "6px 12px",
    fontSize: 11,
    opacity: 0.7,
};

export const ROW_STYLE: CSSProperties = {
    display: "flex",
    alignItems: "center",
    padding: "2px 8px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
    lineHeight: "20px",
};

export const HEAD_ROW_STYLE: CSSProperties = {
    ...ROW_STYLE,
    fontWeight: 600,
    fontSize: "13px",
    paddingLeft: 8,
};

export const SECTION_HEADER_STYLE: CSSProperties = {
    ...ROW_STYLE,
    fontWeight: 600,
    fontSize: "11px",
    opacity: 0.82,
    paddingLeft: 8,
    marginTop: 1,
    marginBottom: 0,
};

export const HEAD_LABEL_STYLE: CSSProperties = {
    opacity: 0.95,
};

export const NODE_LABEL_STYLE: CSSProperties = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
};

export const TRACKING_BADGE_STYLE: CSSProperties = {
    marginLeft: 6,
    fontSize: "11px",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
};

export const TRACKING_PUSH_STYLE: CSSProperties = {
    color: "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
    opacity: 0.95,
    fontWeight: 700,
};

export const TRACKING_PULL_STYLE: CSSProperties = {
    color: "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)",
    opacity: 0.95,
    fontWeight: 700,
};

export const BRANCH_HIGHLIGHT_STYLE: CSSProperties = {
    background: "var(--vscode-editor-findMatchHighlightBackground, rgba(227, 196, 93, 0.95))",
    color: "var(--vscode-editor-foreground, #1b1b1b)",
    borderRadius: 3,
    padding: "0 1px",
};

export const BASE_ICON_STYLE: CSSProperties = {
    flexShrink: 0,
    marginRight: 4,
    opacity: 0.92,
};

export function getChevronIconStyle(expanded: boolean): CSSProperties {
    return {
        ...BASE_ICON_STYLE,
        opacity: 0.68,
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.1s",
    };
}
