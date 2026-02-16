// Chakra UI v2 theme mapped to VS Code CSS custom properties.
// Provides consistent theming that adapts to light/dark VS Code themes.

import { extendTheme } from "@chakra-ui/react";

const theme = extendTheme({
    config: {
        initialColorMode: "dark",
        useSystemColorMode: false,
    },
    styles: {
        global: {
            "*, *::before, *::after": {
                boxSizing: "border-box",
                margin: 0,
                padding: 0,
            },
            "html, body, #root": {
                width: "100%",
                height: "100%",
                overflow: "hidden",
                fontFamily: "var(--vscode-font-family)",
                fontSize: "var(--vscode-font-size)",
                color: "var(--vscode-foreground)",
                background: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
            },
        },
    },
    components: {
        Button: {
            variants: {
                primary: {
                    bg: "#4a6edb",
                    color: "#fff",
                    fontWeight: 600,
                    borderRadius: "4px",
                    _hover: { bg: "#5a7ee8" },
                },
                secondary: {
                    bg: "transparent",
                    color: "var(--vscode-foreground)",
                    border: "1px solid #6b6b6b",
                    borderRadius: "4px",
                    _hover: {
                        bg: "rgba(255,255,255,0.06)",
                        borderColor: "#999",
                    },
                },
                toolbarGhost: {
                    bg: "none",
                    color: "#abb2bf",
                    borderRadius: "3px",
                    padding: "4px 6px",
                    minW: "auto",
                    h: "auto",
                    _hover: {
                        bg: "var(--vscode-list-hoverBackground)",
                        color: "#d4d8e0",
                    },
                },
            },
        },
    },
});

export default theme;
