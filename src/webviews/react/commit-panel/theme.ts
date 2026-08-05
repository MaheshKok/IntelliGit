// Chakra UI v2 theme provides consistent theming that adapts to light/dark VS Code themes.

import { extendTheme } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";

const theme = extendTheme({
    config: {
        initialColorMode: "system",
        useSystemColorMode: true,
    },
    fonts: {
        heading: SYSTEM_FONT_STACK,
        body: SYSTEM_FONT_STACK,
        mono: "var(--vscode-editor-font-family, var(--vscode-font-family))",
    },
    styles: {
        global: {
            ":root": {
                "--intelligit-pycharm-panel":
                    "var(--vscode-sideBar-background, var(--vscode-editor-background, #2b384e))",
                "--intelligit-pycharm-header":
                    "var(--vscode-sideBarSectionHeader-background, var(--vscode-editorGroupHeader-tabsBackground, var(--intelligit-pycharm-panel)))",
                "--intelligit-pycharm-border":
                    "var(--vscode-sideBar-border, var(--vscode-panel-border, #3f4c63))",
                "--intelligit-pycharm-selected":
                    "var(--vscode-list-activeSelectionBackground, #4b5e7d)",
                "--intelligit-pycharm-selected-foreground":
                    "var(--vscode-list-activeSelectionForeground, var(--intelligit-pycharm-foreground))",
                "--intelligit-pycharm-selected-hover":
                    "var(--vscode-list-hoverBackground, #556a8c)",
                "--intelligit-pycharm-input": "var(--vscode-input-background, #191c24)",
                "--intelligit-pycharm-input-border": "var(--vscode-input-border, #566176)",
                "--intelligit-pycharm-foreground": "var(--vscode-foreground, #d6dbe5)",
                "--intelligit-pycharm-muted": "var(--vscode-descriptionForeground, #9aa2af)",
                "--intelligit-pycharm-blue": "var(--vscode-focusBorder, #5f8cff)",
                "--intelligit-pycharm-primary": "var(--vscode-button-background, #5572d9)",
                "--intelligit-pycharm-primary-hover":
                    "var(--vscode-button-hoverBackground, #6382eb)",
                "--intelligit-pycharm-added":
                    "var(--vscode-gitDecoration-addedResourceForeground, #79c981)",
                "--intelligit-pycharm-deleted":
                    "var(--vscode-gitDecoration-deletedResourceForeground, #f26b51)",
                "--intelligit-pycharm-modified":
                    "var(--vscode-gitDecoration-modifiedResourceForeground, #e7bd63)",
                "--intelligit-pycharm-checkbox-unchecked-border":
                    "var(--vscode-button-background, rgba(206, 214, 230, 0.72))",
                "--intelligit-pycharm-checkbox-checked-bg":
                    "var(--vscode-checkbox-background, rgba(95, 140, 255, 0.16))",
            },
            "*, *::before, *::after": {
                boxSizing: "border-box",
                margin: 0,
                padding: 0,
            },
            "html, body, #root": {
                width: "100%",
                height: "100%",
                overflow: "hidden",
                fontFamily: SYSTEM_FONT_STACK,
                fontSize: "13px",
                color: "var(--intelligit-pycharm-foreground)",
                background: "var(--intelligit-pycharm-panel)",
            },
        },
    },
    components: {
        Button: {
            variants: {
                primary: {
                    bg: "var(--intelligit-pycharm-primary)",
                    color: "var(--vscode-button-foreground, #ffffff)",
                    fontWeight: 600,
                    borderRadius: "4px",
                    minH: "24px",
                    h: "24px",
                    px: "10px",
                    _hover: { bg: "var(--intelligit-pycharm-primary-hover)" },
                },
                secondary: {
                    bg: "var(--vscode-button-secondaryBackground, rgba(255,255,255,0.03))",
                    color: "var(--intelligit-pycharm-foreground)",
                    // The fallback is the measured one: composited over the panel it
                    // lands at 3.26:1, clearing the 3:1 that WCAG 1.4.11 asks of a
                    // control boundary. A divider color would have read as 1.39:1 —
                    // fine for a 1px rule between rows, not for the edge that tells
                    // the user where a button is.
                    border: "1px solid var(--vscode-button-border, rgba(176, 186, 205, 0.62))",
                    borderRadius: "4px",
                    minH: "24px",
                    h: "24px",
                    px: "10px",
                    // Same reason as the ghost button below: a fixed white wash
                    // lightens an already-light theme into invisibility. DESIGN.md's
                    // frontmatter already specified the host token here; only the
                    // code had drifted.
                    _hover: {
                        bg: "var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.08))",
                        borderColor: "var(--vscode-contrastActiveBorder, rgba(202, 212, 231, 0.7))",
                    },
                },
                toolbarGhost: {
                    bg: "none",
                    color: "var(--intelligit-pycharm-muted)",
                    borderRadius: "4px",
                    padding: "2px 4px",
                    minW: "24px",
                    h: "24px",
                    // Hover is the only feedback a ghost button has, so it has to
                    // survive the theme. The old `rgba(255,255,255,0.06)` lightened
                    // an already-light toolbar into invisibility; the host's own
                    // toolbar-hover token darkens or lightens as the theme requires.
                    // 120ms is under the product register's 150-250ms ceiling
                    // because a pointer sweeping a toolbar crosses several buttons.
                    transition: "background-color 120ms cubic-bezier(0.25, 1, 0.5, 1)",
                    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
                    _hover: {
                        bg: "var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06))",
                        color: "var(--intelligit-pycharm-foreground)",
                    },
                    _pressed: {
                        bg: "color-mix(in srgb, var(--vscode-button-background, #0e639c) 34%, transparent)",
                        color: "var(--intelligit-pycharm-foreground)",
                    },
                },
                danger: {
                    bg: "color-mix(in srgb, var(--intelligit-pycharm-deleted) 16%, transparent)",
                    color: "var(--intelligit-pycharm-deleted)",
                    border: "1px solid color-mix(in srgb, var(--intelligit-pycharm-deleted) 60%, transparent)",
                    borderRadius: "4px",
                    minW: "auto",
                    h: "24px",
                    px: "10px",
                    fontWeight: 600,
                    _hover: {
                        bg: "color-mix(in srgb, var(--intelligit-pycharm-deleted) 26%, transparent)",
                        borderColor: "var(--intelligit-pycharm-deleted)",
                    },
                },
            },
        },
    },
});

export default theme;
