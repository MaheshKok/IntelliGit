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
                "--intelligit-pycharm-panel": "#2b384e",
                "--intelligit-pycharm-header": "#2c394f",
                "--intelligit-pycharm-border": "#3f4c63",
                "--intelligit-pycharm-selected": "#4b5e7d",
                "--intelligit-pycharm-selected-hover": "#556a8c",
                "--intelligit-pycharm-input": "#191c24",
                "--intelligit-pycharm-input-border": "#566176",
                "--intelligit-pycharm-foreground": "#d6dbe5",
                "--intelligit-pycharm-muted": "#9aa2af",
                "--intelligit-pycharm-blue": "#5f8cff",
                "--intelligit-pycharm-primary": "#5572d9",
                "--intelligit-pycharm-primary-hover": "#6382eb",
                "--intelligit-pycharm-added": "#79c981",
                "--intelligit-pycharm-deleted": "#f26b51",
                "--intelligit-pycharm-modified": "#e7bd63",
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
                    color: "#fff",
                    fontWeight: 600,
                    borderRadius: "4px",
                    minH: "24px",
                    h: "24px",
                    px: "10px",
                    _hover: { bg: "var(--intelligit-pycharm-primary-hover)" },
                },
                secondary: {
                    bg: "rgba(255,255,255,0.03)",
                    color: "var(--intelligit-pycharm-foreground)",
                    border: "1px solid rgba(176, 186, 205, 0.62)",
                    borderRadius: "4px",
                    minH: "24px",
                    h: "24px",
                    px: "10px",
                    _hover: {
                        bg: "rgba(255,255,255,0.08)",
                        borderColor: "rgba(202, 212, 231, 0.7)",
                    },
                },
                toolbarGhost: {
                    bg: "none",
                    color: "var(--intelligit-pycharm-muted)",
                    borderRadius: "3px",
                    padding: "2px 4px",
                    minW: "auto",
                    h: "22px",
                    _hover: {
                        bg: "rgba(255,255,255,0.06)",
                        color: "var(--intelligit-pycharm-foreground)",
                    },
                },
            },
        },
    },
});

export default theme;
