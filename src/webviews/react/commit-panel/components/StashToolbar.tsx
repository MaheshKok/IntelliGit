// Neutral file-pane toolbar between the stash list and selected-file pane.

import React from "react";
import { Box, Flex } from "@chakra-ui/react";
import {
    CollapseAllIconGlyph,
    ExpandAllIconGlyph,
    GroupByDirectoryIconGlyph,
    ShowDiffIconGlyph,
} from "../../shared/components/Icons";
import { RefreshButton } from "../../shared/components/RefreshButton";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { t } from "../../shared/i18n";

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
            minH="30px"
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
                icon={icon(<ShowDiffIconGlyph />)}
            />
            <ToolbarIconButton
                label={groupByDir ? t("common.ungroupFiles") : t("common.groupByDirectory")}
                onClick={onToggleGroupBy}
                pressed={groupByDir}
                icon={icon(<GroupByDirectoryIconGlyph />)}
            />
            <Box flex={1} />
            <ToolbarIconButton
                label={t("common.expandAll")}
                onClick={onExpandAll}
                disabled={!canExpandOrCollapse}
                icon={icon(<ExpandAllIconGlyph />)}
            />
            <ToolbarIconButton
                label={t("common.collapseAll")}
                onClick={onCollapseAll}
                disabled={!canExpandOrCollapse}
                icon={icon(<CollapseAllIconGlyph />)}
            />
        </Flex>
    );
}

/** Keeps the stash toolbar's 16px standard-color SVG wrapper intact. */
function icon(glyph: React.ReactNode): React.ReactElement {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16">
            {glyph}
        </svg>
    );
}
