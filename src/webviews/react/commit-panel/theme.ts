// Chakra UI v2 theme provides consistent theming that adapts to light/dark VS Code themes.

import { extendTheme } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";
import { JETBRAINS_UI } from "../shared/tokens";

const { color, size } = JETBRAINS_UI;

/**
 * The `--intelligit-pycharm-*` custom properties, derived from `tokens.ts`.
 *
 * These used to be authored here as a second set of literals, which made the
 * webview carry two answers for every color it paints. Both sets resolved
 * through the same `--vscode-*` tokens, so a themed host hid the split — but the
 * fallbacks had drifted apart in ten roles (panel `#2b384e` here against
 * `#2f3848` there, deleted `#f26b51` against `#c74e39`, and so on), so on a host
 * that supplies no tokens the commit panel and the commit graph rendered as two
 * different products. DESIGN.md documents one column of fallbacks; this is now
 * the only place that column is written down, and Chakra emits it verbatim.
 */
const HOST_TOKENS = {
    "--intelligit-pycharm-panel": color.panel,
    "--intelligit-pycharm-header": color.sectionHeader,
    "--intelligit-pycharm-border": color.sidebarBorder,
    "--intelligit-pycharm-selected": color.selected,
    "--intelligit-pycharm-selected-foreground": color.selectedForeground,
    "--intelligit-pycharm-selected-hover": color.hover,
    "--intelligit-pycharm-hover": color.hover,
    "--intelligit-pycharm-toolbar-hover": color.toolbarHover,
    "--intelligit-pycharm-input": color.input,
    "--intelligit-pycharm-input-border": color.inputBorder,
    "--intelligit-pycharm-foreground": color.foreground,
    "--intelligit-pycharm-muted": color.muted,
    "--intelligit-pycharm-disabled": color.disabled,
    "--intelligit-pycharm-blue": color.focus,
    "--intelligit-pycharm-primary": color.primary,
    "--intelligit-pycharm-primary-hover": color.primaryHover,
    "--intelligit-pycharm-added": color.added,
    "--intelligit-pycharm-deleted": color.deleted,
    "--intelligit-pycharm-modified": color.modified,
    "--intelligit-pycharm-checkbox-unchecked-border": color.checkboxUncheckedBorder,
    "--intelligit-pycharm-checkbox-checked-bg": color.checkboxCheckedBackground,
} as const;

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
            ":root": HOST_TOKENS,
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
                    color: color.primaryForeground,
                    fontWeight: 600,
                    borderRadius: `${size.radius}px`,
                    minH: `${size.rowHeight}px`,
                    h: `${size.rowHeight}px`,
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
                    borderRadius: `${size.radius}px`,
                    minH: `${size.rowHeight}px`,
                    h: `${size.rowHeight}px`,
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
                    borderRadius: `${size.radius}px`,
                    padding: "2px 4px",
                    minW: `${size.rowHeight}px`,
                    h: `${size.rowHeight}px`,
                    // Hover is the only feedback a ghost button has, so it has to
                    // survive the theme. The old `rgba(255,255,255,0.06)` lightened
                    // an already-light toolbar into invisibility; the host's own
                    // toolbar-hover token darkens or lightens as the theme requires.
                    // 120ms is under the product register's 150-250ms ceiling
                    // because a pointer sweeping a toolbar crosses several buttons.
                    transition: "background-color 120ms cubic-bezier(0.25, 1, 0.5, 1)",
                    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
                    _hover: {
                        bg: "var(--intelligit-pycharm-toolbar-hover)",
                        color: "var(--intelligit-pycharm-foreground)",
                    },
                    _pressed: {
                        bg: `color-mix(in srgb, ${color.primary} 34%, transparent)`,
                        color: "var(--intelligit-pycharm-foreground)",
                    },
                    // A ghost button at rest is transparent, so a disabled one has
                    // nothing to dim — the glyph alone carries the state. The white
                    // wash that used to sit here read as a raised chip on a light
                    // theme, which is the opposite of disabled.
                    _disabled: {
                        bg: "transparent",
                        color: "var(--intelligit-pycharm-disabled)",
                        cursor: "default",
                        opacity: 1,
                    },
                },
                danger: {
                    bg: "color-mix(in srgb, var(--intelligit-pycharm-deleted) 16%, transparent)",
                    // The label deliberately does NOT use `deleted`, even though the
                    // tint and border do. Tinting the backdrop with the same colour as
                    // the text is self-defeating: the two move together, so no theme's
                    // red can be guaranteed against it. Measured across the four host
                    // fixtures, `deleted` lands at 3.06:1 (Dark Modern) and 4.09:1
                    // (HC Black), and every other red VS Code exposes -- errorForeground,
                    // charts.red, testing.iconFailed -- fails on at least one theme too.
                    // The pane's own foreground is contrast-checked against the pane by
                    // definition, and a <=26% tint barely moves it, so it clears 4.5:1
                    // everywhere by construction (worst case 6.78:1, Light Modern hover).
                    // The destructive signal still has two channels: the red wash and
                    // the red border.
                    color: "var(--vscode-foreground)",
                    border: "1px solid color-mix(in srgb, var(--intelligit-pycharm-deleted) 60%, transparent)",
                    borderRadius: `${size.radius}px`,
                    minW: "auto",
                    h: `${size.rowHeight}px`,
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
