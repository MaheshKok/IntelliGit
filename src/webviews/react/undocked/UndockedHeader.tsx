import React from "react";
import { Box } from "@chakra-ui/react";
import { t } from "../shared/i18n";
import { resolveIconColor } from "../shared/settings";

interface UndockedHeaderProps {
    onDock: () => void;
}

const DOCK_BUTTON_STYLE: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 24,
    border: "1px solid var(--vscode-button-border, transparent)",
    borderRadius: 3,
    padding: "0 8px",
    color: "var(--vscode-button-foreground)",
    background: "var(--vscode-button-secondaryBackground)",
    font: "inherit",
    cursor: "pointer",
};
const STANDARD_DOCK_ICON_COLOR = "var(--vscode-button-foreground)";
const COLOR_DOCK_ICON_COLOR = "#8fd5ff";

/** Renders the undocked editor-tab header and invokes the dock callback. */
export function UndockedHeader({ onDock }: UndockedHeaderProps): React.ReactElement {
    const dockIconColor = resolveIconColor(COLOR_DOCK_ICON_COLOR, STANDARD_DOCK_ICON_COLOR);

    return (
        <Box
            as="header"
            height="32px"
            flexShrink={0}
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            px="10px"
            bg="var(--vscode-sideBar-background)"
            borderBottom="1px solid var(--vscode-panel-border)"
            color="var(--vscode-foreground)"
            fontSize="12px"
            fontFamily="var(--vscode-font-family)"
        >
            <Box fontWeight={600}>IntelliGit</Box>
            <button
                type="button"
                onClick={onDock}
                title={t("common.dockIntelliGit")}
                aria-label={t("common.dockIntelliGit")}
                style={DOCK_BUTTON_STYLE}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    aria-hidden
                    style={{ color: dockIconColor }}
                >
                    <path
                        fill="currentColor"
                        d="M2 3h12v10H2V3zm1 1v8h10V4H3zm1 1h3v6H4V5zm4 0h4v2H8V5z"
                    />
                </svg>
                {t("common.dock")}
            </button>
        </Box>
    );
}
