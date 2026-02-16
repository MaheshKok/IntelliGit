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
        Checkbox: {
            baseStyle: {
                control: {
                    borderColor: "var(--vscode-checkbox-border, #6b6b6b)",
                    _checked: {
                        bg: "var(--vscode-checkbox-background, #4a6edb)",
                        borderColor: "var(--vscode-checkbox-border, #4a6edb)",
                    },
                },
            },
        },
        Textarea: {
            variants: {
                vscode: {
                    bg: "var(--vscode-input-background)",
                    color: "var(--vscode-input-foreground)",
                    border: "1px solid",
                    borderColor: "var(--vscode-input-border, var(--vscode-panel-border, #444))",
                    borderRadius: "3px",
                    fontFamily: "var(--vscode-font-family)",
                    fontSize: "var(--vscode-font-size)",
                    _placeholder: { color: "var(--vscode-input-placeholderForeground)" },
                    _focus: { borderColor: "var(--vscode-focusBorder)" },
                },
            },
        },
        Tabs: {
            variants: {
                vscode: {
                    tab: {
                        fontWeight: 600,
                        fontSize: "12px",
                        opacity: 0.6,
                        borderBottom: "2px solid transparent",
                        _selected: {
                            opacity: 1,
                            borderBottomColor: "var(--vscode-focusBorder, #007acc)",
                        },
                        _hover: { opacity: 0.85 },
                    },
                    tablist: {
                        borderBottom: "1px solid var(--vscode-panel-border, #444)",
                    },
                },
            },
        },
    },
});

export default theme;
