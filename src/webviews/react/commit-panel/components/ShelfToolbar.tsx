import React, { useState } from "react";
import { Flex } from "@chakra-ui/react";
import { VscKebabVertical, VscListTree } from "react-icons/vsc";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { CollapseAllIconGlyph, ExpandAllIconGlyph } from "../../shared/components/Icons";
import { RefreshButton } from "../../shared/components/RefreshButton";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI, TOOLBAR_ICON_ACCENTS } from "../../shared/tokens";

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
            minH={`${JETBRAINS_UI.size.toolbarHeight}px`}
            px="6px"
            gap="2px"
            bg="var(--intelligit-pycharm-panel)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
        >
            <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
            <ToolbarIconButton
                label={t("shelf.action.groupBy")}
                icon={<VscListTree size={16} />}
                onClick={onToggleGroupBy}
                pressed={groupByDir}
                color={TOOLBAR_ICON_ACCENTS.groupBy}
            />
            <ToolbarIconButton
                label={t("shelf.action.expandAll")}
                icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                        <ExpandAllIconGlyph />
                    </svg>
                }
                onClick={onExpandAll}
                disabled={!canExpandOrCollapse}
                color={TOOLBAR_ICON_ACCENTS.expandCollapse}
            />
            <ToolbarIconButton
                label={t("shelf.action.collapseAll")}
                icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                        <CollapseAllIconGlyph />
                    </svg>
                }
                onClick={onCollapseAll}
                disabled={!canExpandOrCollapse}
                color={TOOLBAR_ICON_ACCENTS.expandCollapse}
            />
            <ToolbarIconButton
                label={t("shelf.action.moreOptions")}
                icon={<VscKebabVertical size={16} />}
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
