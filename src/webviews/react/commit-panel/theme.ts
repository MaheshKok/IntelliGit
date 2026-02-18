// Chakra UI v2 theme provides consistent theming that adapts to light/dark VS Code themes.

import { extendTheme } from "@chakra-ui/react";

const theme = extendTheme({
    config: {
        initialColorMode: "system",
        useSystemColorMode: true,
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
                    bg: "#4f6fd6",
                    color: "#fff",
                    fontWeight: 600,
                    borderRadius: "4px",
                    minH: "24px",
                    h: "24px",
                    px: "10px",
                    _hover: { bg: "#5d7fe6" },
                },
                secondary: {
                    bg: "rgba(255,255,255,0.04)",
                    color: "var(--vscode-foreground)",
                    border: "1px solid rgba(176, 186, 205, 0.5)",
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
                    color: "var(--vscode-icon-foreground, #b9c0cf)",
                    borderRadius: "3px",
                    padding: "2px 4px",
                    minW: "auto",
                    h: "22px",
                    _hover: {
                        bg: "rgba(255,255,255,0.06)",
                        color: "var(--vscode-foreground)",
                    },
                },
            },
        },
    },
});

export default theme;
