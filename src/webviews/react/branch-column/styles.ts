import type { CSSProperties } from "react";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";
import { BASE_ICON_STYLE } from "../shared/components/Icons";
import { JETBRAINS_UI } from "../shared/tokens";

export const TREE_INDENT_STEP = JETBRAINS_UI.size.treeIndent;
export const BRANCH_TREE_INDENT_BASE = 18;
export const BRANCH_TREE_INDENT_STEP = 14;
export const BRANCH_TREE_GUIDE_BASE = 23;

export const BRANCH_ROW_CLASS_CSS = `
    .branch-row:hover {
        background: ${JETBRAINS_UI.color.hover} !important;
    }
    button.branch-row {
        width: 100%;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
    }
    .branch-row.selected {
        background: ${JETBRAINS_UI.color.selected} !important;
        color: ${JETBRAINS_UI.color.selectedForeground} !important;
        border-radius: ${JETBRAINS_UI.size.selectedRadius}px;
    }
    .branch-row.selected:hover {
        background: ${JETBRAINS_UI.color.selected} !important;
        color: ${JETBRAINS_UI.color.selectedForeground} !important;
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
    background: JETBRAINS_UI.color.panel,
    color: JETBRAINS_UI.color.foreground,
    borderRight: `1px solid ${JETBRAINS_UI.color.border}`,
    userSelect: "none",
};

export const SEARCH_CONTAINER_STYLE: CSSProperties = {
    minHeight: 22,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "1px 8px",
    color: JETBRAINS_UI.color.muted,
    background: JETBRAINS_UI.color.toolbar,
    borderBottom: `1px solid ${JETBRAINS_UI.color.border}`,
};

export const SEARCH_INPUT_STYLE: CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: 18,
    borderRadius: JETBRAINS_UI.size.radius,
    border: `1px solid ${JETBRAINS_UI.color.inputBorder}`,
    background: JETBRAINS_UI.color.input,
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
    position: "relative",
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "1px 8px",
    border: "none",
    cursor: "pointer",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    whiteSpace: "nowrap",
    overflow: "hidden",
    lineHeight: "20px",
};

export const INDENT_GUIDE_STYLE: CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    background: "var(--vscode-tree-indentGuidesStroke, rgba(154, 169, 198, 0.22))",
    pointerEvents: "none",
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
    fontSize: "13px",
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

export const WORKTREE_BADGE_STYLE: CSSProperties = {
    width: 8,
    height: 8,
    marginLeft: 6,
    borderRadius: 2,
    border: "1px solid var(--vscode-charts-blue, #3794ff)",
    background: "var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff)",
    boxSizing: "border-box",
    flexShrink: 0,
};

export const TRACKING_PUSH_STYLE: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    color: "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
    opacity: 0.95,
    fontWeight: 700,
};

export const TRACKING_PULL_STYLE: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
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

/** Rotates the shared chevron glyph without changing its base icon metrics. */
export function getChevronIconStyle(expanded: boolean): CSSProperties {
    return {
        ...BASE_ICON_STYLE,
        opacity: 0.68,
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.1s",
    };
}
