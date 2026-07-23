import React from "react";
import { Box, Button, Flex, Tooltip } from "@chakra-ui/react";
import { getSettings } from "../../shared/settings";

/** Actions enabled for the currently selected shelf. */
export interface ShelfToolbarProps {
    canUnshelve: boolean;
    hasSelectedShelf: boolean;
    showAlreadyUnshelved: boolean;
    onUnshelve: () => void;
    onUnshelveSilently: () => void;
    onShowDiff: () => void;
    onCompareWithLocal: () => void;
    onRename: () => void;
    onDelete: () => void;
    onToggleAlreadyUnshelved: () => void;
}

/** Selected-shelf commands plus the persisted-ghost visibility control. */
export function ShelfToolbar({
    canUnshelve,
    hasSelectedShelf,
    showAlreadyUnshelved,
    onUnshelve,
    onUnshelveSilently,
    onShowDiff,
    onCompareWithLocal,
    onRename,
    onDelete,
    onToggleAlreadyUnshelved,
}: ShelfToolbarProps): React.ReactElement {
    const { hoverDelay, tooltipsEnabled } = getSettings();
    return (
        <Flex
            align="center"
            minH="34px"
            px="8px"
            gap="4px"
            bg="var(--intelligit-pycharm-header)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
        >
            <ShelfToolbarButton label="Unshelve" onClick={onUnshelve} disabled={!canUnshelve} hoverDelay={hoverDelay} tooltipsEnabled={tooltipsEnabled} />
            <ShelfToolbarButton label="Unshelve Silently" onClick={onUnshelveSilently} disabled={!canUnshelve} hoverDelay={hoverDelay} tooltipsEnabled={tooltipsEnabled} />
            <ShelfToolbarButton label="Show Diff" onClick={onShowDiff} disabled={!hasSelectedShelf} hoverDelay={hoverDelay} tooltipsEnabled={tooltipsEnabled} />
            <ShelfToolbarButton label="Compare with Local" onClick={onCompareWithLocal} disabled={!hasSelectedShelf} hoverDelay={hoverDelay} tooltipsEnabled={tooltipsEnabled} />
            <ShelfToolbarButton label="Rename" onClick={onRename} disabled={!hasSelectedShelf} hoverDelay={hoverDelay} tooltipsEnabled={tooltipsEnabled} />
            <ShelfToolbarButton label="Delete" onClick={onDelete} disabled={!hasSelectedShelf} hoverDelay={hoverDelay} tooltipsEnabled={tooltipsEnabled} />
            <Box flex={1} />
            <Button variant="toolbarGhost" size="xs" onClick={onToggleAlreadyUnshelved}>
                {showAlreadyUnshelved ? "Hide Already Unshelved" : "Show Already Unshelved"}
            </Button>
        </Flex>
    );
}

function ShelfToolbarButton({
    label,
    onClick,
    disabled,
    hoverDelay,
    tooltipsEnabled,
}: {
    label: string;
    onClick: () => void;
    disabled: boolean;
    hoverDelay: number;
    tooltipsEnabled: boolean;
}): React.ReactElement {
    return (
        <Tooltip label={label} fontSize="11px" openDelay={hoverDelay} isDisabled={!tooltipsEnabled}>
            <Button variant="toolbarGhost" size="xs" onClick={onClick} isDisabled={disabled}>
                {label}
            </Button>
        </Tooltip>
    );
}
