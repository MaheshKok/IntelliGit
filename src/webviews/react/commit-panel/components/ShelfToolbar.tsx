import React from "react";
import { Box, Button, Flex, Tooltip } from "@chakra-ui/react";
import { getSettings } from "../../shared/settings";
import { t } from "../../shared/i18n";

/** Actions enabled for the currently selected shelf. */
export interface ShelfToolbarProps {
    canUnshelve: boolean;
    hasSelectedShelf: boolean;
    canExportPatch: boolean;
    showAlreadyUnshelved: boolean;
    onUnshelve: () => void;
    onUnshelveSilently: () => void;
    onShowDiff: () => void;
    onCompareWithLocal: () => void;
    onRename: () => void;
    onDelete: () => void;
    onImportPatch: () => void;
    onExportPatch: () => void;
    onCleanUp: () => void;
    onToggleAlreadyUnshelved: () => void;
}

/** Selected-shelf commands plus the persisted-ghost visibility control. */
export function ShelfToolbar({
    canUnshelve,
    hasSelectedShelf,
    canExportPatch,
    showAlreadyUnshelved,
    onUnshelve,
    onUnshelveSilently,
    onShowDiff,
    onCompareWithLocal,
    onRename,
    onDelete,
    onImportPatch,
    onExportPatch,
    onCleanUp,
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
            <ShelfToolbarButton
                label={t("shelf.action.importPatches")}
                onClick={onImportPatch}
                disabled={false}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarButton
                label={t("shelf.action.createPatch")}
                onClick={onExportPatch}
                disabled={!canExportPatch}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarButton
                label={t("shelf.action.unshelve")}
                onClick={onUnshelve}
                disabled={!canUnshelve}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarButton
                label={t("shelf.action.unshelveSilently")}
                onClick={onUnshelveSilently}
                disabled={!canUnshelve}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarButton
                label={t("common.showDiff")}
                onClick={onShowDiff}
                disabled={!hasSelectedShelf}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarButton
                label={t("shelf.action.compareWithLocal")}
                onClick={onCompareWithLocal}
                disabled={!hasSelectedShelf}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarButton
                label={t("shelf.action.rename")}
                onClick={onRename}
                disabled={!hasSelectedShelf}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <ShelfToolbarButton
                label={t("shelf.action.delete")}
                onClick={onDelete}
                disabled={!hasSelectedShelf}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
            />
            <Box flex={1} />
            <Button variant="toolbarGhost" size="xs" onClick={onToggleAlreadyUnshelved}>
                {showAlreadyUnshelved
                    ? t("shelf.action.hideAlreadyUnshelved")
                    : t("shelf.action.showAlreadyUnshelved")}
            </Button>
            <Button variant="toolbarGhost" size="xs" onClick={onCleanUp}>
                {t("shelf.action.cleanUp")}
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
