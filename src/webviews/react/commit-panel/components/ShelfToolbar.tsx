// Renders the shelf tab toolbar controls for diff, grouping, and tree expansion.
// The parent owns all state changes and passes stable command callbacks.
// Keeping the toolbar presentational avoids changing shelf action behavior.

import React from "react";
import { Box, Flex, IconButton, Tooltip } from "@chakra-ui/react";
import { CollapseAllIconGlyph, ExpandAllIconGlyph } from "../../shared/components/Icons";
import { getSettings } from "../../shared/settings";
import { t } from "../../shared/i18n";

/** Props for shelf toolbar command buttons and tooltip timing. */
export interface ShelfToolbarProps {
    selectedIndex: number | null;
    shelfFilesLength: number;
    groupByDir: boolean;
    hoverDelay: number;
    tooltipsEnabled: boolean;
    onShowSelectedDiff: () => void;
    onToggleGroupBy: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
}

/** Renders the shelf tab's compact toolbar buttons. */
export function ShelfToolbar({
    selectedIndex,
    shelfFilesLength,
    groupByDir,
    hoverDelay,
    tooltipsEnabled,
    onShowSelectedDiff,
    onToggleGroupBy,
    onExpandAll,
    onCollapseAll,
}: ShelfToolbarProps): React.ReactElement {
    return (
        <Flex
            align="center"
            minH="34px"
            px="8px"
            bg="var(--intelligit-pycharm-header)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
        >
            <StashToolbarButton
                label={t("common.showDiff")}
                color="#ff736d"
                onClick={onShowSelectedDiff}
                isDisabled={selectedIndex === null || shelfFilesLength === 0}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            >
                <path
                    fill="currentColor"
                    d="M2.5 1.5h4v13h-4v-13zm7 0h4v13h-4v-13zM5.25 4.75 7.5 7 5.25 9.25l-.7-.7L5.6 7 4.55 5.45l.7-.7zm5.5 0 .7.7L10.4 7l1.05 1.55-.7.7L8.5 7l2.25-2.25z"
                />
            </StashToolbarButton>
            <StashToolbarButton
                label={groupByDir ? t("common.ungroupFiles") : t("common.groupByDirectory")}
                color="#b77dff"
                onClick={onToggleGroupBy}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            >
                <path
                    fill="currentColor"
                    d="M2 2h4v4H2V2zm8 0h4v4h-4V2zM2 10h4v4H2v-4zm8 0h4v4h-4v-4z"
                />
            </StashToolbarButton>
            <Box flex={1} />
            <StashToolbarButton
                label={t("common.expandAll")}
                color="#f3b1cf"
                onClick={onExpandAll}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            >
                <ExpandAllIconGlyph />
            </StashToolbarButton>
            <StashToolbarButton
                label={t("common.collapseAll")}
                color="#f3b1cf"
                onClick={onCollapseAll}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            >
                <CollapseAllIconGlyph />
            </StashToolbarButton>
        </Flex>
    );
}

function StashToolbarButton({
    label,
    color,
    onClick,
    isDisabled,
    hoverDelay,
    tooltipsEnabled,
    children,
}: {
    label: string;
    color: string;
    onClick: () => void;
    isDisabled?: boolean;
    hoverDelay: number;
    tooltipsEnabled: boolean;
    children: React.ReactNode;
}): React.ReactElement {
    const { iconStyle } = getSettings();
    const resolvedColor = iconStyle === "standard" ? "var(--vscode-icon-foreground)" : color;
    return (
        <Tooltip label={label} fontSize="11px" openDelay={hoverDelay} isDisabled={!tooltipsEnabled}>
            <IconButton
                aria-label={label}
                icon={
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        style={{ color: resolvedColor }}
                    >
                        {children}
                    </svg>
                }
                variant="toolbarGhost"
                size="sm"
                minW="26px"
                h="26px"
                onClick={onClick}
                isDisabled={isDisabled}
            />
        </Tooltip>
    );
}
