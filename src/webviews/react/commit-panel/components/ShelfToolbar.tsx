import React, { useState } from "react";
import { Button, Flex, Tooltip } from "@chakra-ui/react";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { getSettings } from "../../shared/settings";
import { t } from "../../shared/i18n";

/** Callbacks and state for the compact Shelf toolbar. */
export interface ShelfToolbarProps {
    canUnshelve: boolean;
    canExpandOrCollapse: boolean;
    groupByDir: boolean;
    showAlreadyUnshelved: boolean;
    onUnshelve: () => void;
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

function unshelveIcon(): React.ReactElement {
    return icon(
        <path fill="currentColor" d="M8 1l4 4H9v5H7V5H4l4-4zm-5 9h10v5H3v-5zm1 1v3h8v-3H4z" />,
    );
}

function groupIcon(): React.ReactElement {
    return icon(
        <path
            fill="currentColor"
            d="M2 2h5v2H2V2zm0 4h5v2H2V6zm0 4h5v2H2v-2zm7-6h5v2H9V4zm0 4h5v2H9V8zm0 4h5v2H9v-2z"
        />,
    );
}

function expandIcon(): React.ReactElement {
    return icon(
        <path
            fill="currentColor"
            d="M2 2h5v1H3v4H2V2zm7 0h5v5h-1V3H9V2zM3 9h4v1H3v3h4v1H2V9h1zm10 0h1v5H9v-1h4V9z"
        />,
    );
}

function collapseIcon(): React.ReactElement {
    return icon(
        <path
            fill="currentColor"
            d="M3 2h4v1H3v4H2V2h1zm6 0h5v5h-1V3H9V2zM2 9h5v1H3v4H2V9zm7 0h5v5H9v-1h4v-3H9V9z"
        />,
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

/** PyCharm-parity Shelf controls: four icon actions and one overflow trigger. */
export function ShelfToolbar({
    canUnshelve,
    canExpandOrCollapse,
    groupByDir,
    showAlreadyUnshelved,
    onUnshelve,
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
            <ShelfToolbarIconButton
                label={t("shelf.action.unshelve")}
                icon={unshelveIcon()}
                onClick={onUnshelve}
                disabled={!canUnshelve}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarIconButton
                label={t("shelf.action.groupBy")}
                icon={groupIcon()}
                onClick={onToggleGroupBy}
                pressed={groupByDir}
                disabled={false}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarIconButton
                label={t("shelf.action.expandAll")}
                icon={expandIcon()}
                onClick={onExpandAll}
                disabled={!canExpandOrCollapse}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarIconButton
                label={t("shelf.action.collapseAll")}
                icon={collapseIcon()}
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
