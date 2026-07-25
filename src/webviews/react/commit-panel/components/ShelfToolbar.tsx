import React, { useState } from "react";
import { Button, Flex, Tooltip } from "@chakra-ui/react";
import { ContextMenu } from "../../shared/components/ContextMenu";
import {
    CollapseAllIconGlyph,
    ExpandAllIconGlyph,
    GroupByDirectoryIconGlyph,
} from "../../shared/components/Icons";
import { RefreshButton } from "../../shared/components/RefreshButton";
import { getSettings } from "../../shared/settings";
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
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            {path}
        </svg>
    );
}

function moreIcon(): React.ReactElement {
    return icon(
        <path
            fill="currentColor"
            d="M8 3a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 8 3zm0 6.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zm0 6.25a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 8 15.5z"
        />,
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
    const { hoverDelay, tooltipsEnabled } = getSettings();
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
            minH="34px"
            px="8px"
            gap="4px"
            bg="var(--intelligit-pycharm-header)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
        >
            <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
            <ShelfToolbarIconButton
                label={t("shelf.action.groupBy")}
                icon={icon(<GroupByDirectoryIconGlyph />)}
                onClick={onToggleGroupBy}
                pressed={groupByDir}
                disabled={false}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarIconButton
                label={t("shelf.action.expandAll")}
                icon={icon(<ExpandAllIconGlyph />)}
                onClick={onExpandAll}
                disabled={!canExpandOrCollapse}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarIconButton
                label={t("shelf.action.collapseAll")}
                icon={icon(<CollapseAllIconGlyph />)}
                onClick={onCollapseAll}
                disabled={!canExpandOrCollapse}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarIconButton
                label={t("shelf.action.moreOptions")}
                icon={moreIcon()}
                onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setOverflow({ x: rect.left, y: rect.bottom });
                }}
                disabled={false}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
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

function ShelfToolbarIconButton({
    label,
    icon,
    onClick,
    pressed,
    disabled,
    hoverDelay,
    tooltipsEnabled,
}: {
    label: string;
    icon: React.ReactElement;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    pressed?: boolean;
    disabled: boolean;
    hoverDelay: number;
    tooltipsEnabled: boolean;
}): React.ReactElement {
    return (
        <Tooltip label={label} fontSize="11px" openDelay={hoverDelay} isDisabled={!tooltipsEnabled}>
            <Button
                variant="toolbarGhost"
                size="xs"
                aria-label={label}
                aria-pressed={pressed}
                onClick={onClick}
                isDisabled={disabled}
            >
                {icon}
            </Button>
        </Tooltip>
    );
}
