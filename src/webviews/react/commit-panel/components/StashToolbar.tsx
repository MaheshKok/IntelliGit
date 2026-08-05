// Neutral file-pane toolbar between the stash list and selected-file pane.

import React from "react";
import { Box, Flex } from "@chakra-ui/react";
import { VscListTree, VscNewFile } from "react-icons/vsc";
import { CollapseAllIconGlyph, ExpandAllIconGlyph } from "../../shared/components/Icons";
import { RefreshButton } from "../../shared/components/RefreshButton";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI, TOOLBAR_ICON_ACCENTS } from "../../shared/tokens";

/** Props for selected-stash file-pane toolbar controls. */
export interface StashToolbarProps {
    selectedIndex: number | null;
    groupByDir: boolean;
    canExpandOrCollapse: boolean;
    isRefreshing: boolean;
    onRefresh: () => void;
    onShowStashDiff: () => void;
    onToggleGroupBy: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
}

/** Renders neutral selected-stash file toolbar controls. */
export function StashToolbar({
    selectedIndex,
    groupByDir,
    canExpandOrCollapse,
    isRefreshing,
    onRefresh,
    onShowStashDiff,
    onToggleGroupBy,
    onExpandAll,
    onCollapseAll,
}: StashToolbarProps): React.ReactElement {
    return (
        <Flex
            align="center"
            gap="2px"
            minH={`${JETBRAINS_UI.size.toolbarHeight}px`}
            px="6px"
            bg="var(--intelligit-pycharm-panel)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
        >
            <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
            <ToolbarIconButton
                label={t("common.showDiff")}
                onClick={onShowStashDiff}
                disabled={selectedIndex === null}
                color={TOOLBAR_ICON_ACCENTS.showDiff}
                icon={<VscNewFile size={16} />}
            />
            <ToolbarIconButton
                label={groupByDir ? t("common.ungroupFiles") : t("common.groupByDirectory")}
                onClick={onToggleGroupBy}
                pressed={groupByDir}
                color={TOOLBAR_ICON_ACCENTS.groupBy}
                icon={<VscListTree size={16} />}
            />
            <Box flex={1} />
            <ToolbarIconButton
                label={t("common.expandAll")}
                onClick={onExpandAll}
                disabled={!canExpandOrCollapse}
                color={TOOLBAR_ICON_ACCENTS.expandCollapse}
                icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                        <ExpandAllIconGlyph />
                    </svg>
                }
            />
            <ToolbarIconButton
                label={t("common.collapseAll")}
                onClick={onCollapseAll}
                disabled={!canExpandOrCollapse}
                color={TOOLBAR_ICON_ACCENTS.expandCollapse}
                icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                        <CollapseAllIconGlyph />
                    </svg>
                }
            />
        </Flex>
    );
}
