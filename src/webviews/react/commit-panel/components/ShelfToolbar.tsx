import React, { useState } from "react";
import { Flex } from "@chakra-ui/react";
import { ContextMenu } from "../../shared/components/ContextMenu";
import {
    CollapseAllIconGlyph,
    ExpandAllIconGlyph,
    GroupByDirectoryIconGlyph,
    MoreOptionsIconGlyph,
} from "../../shared/components/Icons";
import { RefreshButton } from "../../shared/components/RefreshButton";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { t } from "../../shared/i18n";

/** Callbacks and state for the compact Shelf toolbar. */
export interface ShelfToolbarProps {
    canExpandOrCollapse: boolean;
    groupByDir: boolean;
    showAlreadyUnshelved: boolean;
    isRefreshing: boolean;
    onRefresh: () => void;
    onToggleGroupBy: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    onCleanUp: () => void;
    onToggleAlreadyUnshelved: () => void;
}

function icon(path: React.ReactNode): React.ReactElement {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            {path}
        </svg>
    );
}

/** PyCharm-parity Shelf controls: three icon actions and one overflow trigger. */
export function ShelfToolbar({
    canExpandOrCollapse,
    groupByDir,
    showAlreadyUnshelved,
    isRefreshing,
    onRefresh,
    onToggleGroupBy,
    onExpandAll,
    onCollapseAll,
    onCleanUp,
    onToggleAlreadyUnshelved,
}: ShelfToolbarProps): React.ReactElement {
    const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null);
    const overflowItems = [
        {
            label: showAlreadyUnshelved
                ? t("shelf.action.hideAlreadyUnshelved")
                : t("shelf.action.showAlreadyUnshelved"),
            action: "toggleAlreadyUnshelved",
        },
        { label: t("shelf.action.cleanUp"), action: "cleanUp" },
    ];

    const selectOverflow = (action: string): void => {
        if (action === "toggleAlreadyUnshelved") onToggleAlreadyUnshelved();
        else onCleanUp();
    };

    return (
        <Flex
            data-testid="shelf-toolbar"
            align="center"
            minH="30px"
            px="6px"
            gap="2px"
            bg="var(--intelligit-pycharm-header)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
        >
            <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
            <ToolbarIconButton
                label={t("shelf.action.groupBy")}
                icon={icon(<GroupByDirectoryIconGlyph />)}
                onClick={onToggleGroupBy}
                pressed={groupByDir}
            />
            <ToolbarIconButton
                label={t("shelf.action.expandAll")}
                icon={icon(<ExpandAllIconGlyph />)}
                onClick={onExpandAll}
                disabled={!canExpandOrCollapse}
            />
            <ToolbarIconButton
                label={t("shelf.action.collapseAll")}
                icon={icon(<CollapseAllIconGlyph />)}
                onClick={onCollapseAll}
                disabled={!canExpandOrCollapse}
            />
            <ToolbarIconButton
                label={t("shelf.action.moreOptions")}
                icon={icon(<MoreOptionsIconGlyph />)}
                onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setOverflow({ x: rect.left, y: rect.bottom });
                }}
            />
            {overflow ? (
                <ContextMenu
                    x={overflow.x}
                    y={overflow.y}
                    items={overflowItems}
                    minWidth={220}
                    onSelect={selectOverflow}
                    onClose={() => setOverflow(null)}
                />
            ) : null}
        </Flex>
    );
}
