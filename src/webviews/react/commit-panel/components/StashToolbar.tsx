// Neutral file-pane toolbar between the stash list and selected-file pane.

import React from "react";
import { Box, Flex, IconButton, Tooltip } from "@chakra-ui/react";
import { CollapseAllIconGlyph, ExpandAllIconGlyph } from "../../shared/components/Icons";
import { t } from "../../shared/i18n";

/** Props for selected-stash file-pane toolbar controls. */
export interface StashToolbarProps {
    selectedIndex: number | null;
    groupByDir: boolean;
    hasGroupedDirectories: boolean;
    hoverDelay: number;
    tooltipsEnabled: boolean;
    onShowStashDiff: () => void;
    onToggleGroupBy: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
}

/** Renders neutral selected-stash file toolbar controls. */
export function StashToolbar({
    selectedIndex,
    groupByDir,
    hasGroupedDirectories,
    hoverDelay,
    tooltipsEnabled,
    onShowStashDiff,
    onToggleGroupBy,
    onExpandAll,
    onCollapseAll,
}: StashToolbarProps): React.ReactElement {
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
                onClick={onShowStashDiff}
                isDisabled={selectedIndex === null}
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
                onClick={onExpandAll}
                isDisabled={selectedIndex === null || !hasGroupedDirectories}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            >
                <ExpandAllIconGlyph />
            </StashToolbarButton>
            <StashToolbarButton
                label={t("common.collapseAll")}
                onClick={onCollapseAll}
                isDisabled={selectedIndex === null || !hasGroupedDirectories}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            >
                <CollapseAllIconGlyph />
            </StashToolbarButton>
        </Flex>
    );
}

/** Renders one theme-neutral stash toolbar icon button. */
function StashToolbarButton({
    label,
    onClick,
    isDisabled,
    hoverDelay,
    tooltipsEnabled,
    children,
}: {
    label: string;
    onClick: () => void;
    isDisabled?: boolean;
    hoverDelay: number;
    tooltipsEnabled: boolean;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <Tooltip label={label} fontSize="11px" openDelay={hoverDelay} isDisabled={!tooltipsEnabled}>
            <IconButton
                aria-label={label}
                icon={
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        aria-hidden
                        style={{ color: "var(--vscode-icon-foreground)" }}
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
