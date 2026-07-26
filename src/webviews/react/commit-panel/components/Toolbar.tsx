// Toolbar with commit-view Git and file actions.

import React, { useCallback, useMemo, useState } from "react";
import { Button, Flex, Tooltip } from "@chakra-ui/react";
import { IoMdRefresh } from "react-icons/io";
import { LuEye } from "react-icons/lu";
import { getSettings } from "../../shared/settings";
import {
    CollapseAllIconGlyph,
    ExpandAllIconGlyph,
    ShowDiffIconGlyph,
} from "../../shared/components/Icons";
import { ContextMenu, type MenuItem } from "../../shared/components/ContextMenu";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { SPIN_KEYFRAMES } from "../../shared/components/iconStyles";
import { t } from "../../shared/i18n";

interface Props {
    onRefresh: () => void;
    isRefreshing?: boolean;
    groupByDir: boolean;
    showIgnoredFiles: boolean;
    onRollback: () => void;
    onToggleGroupBy: () => void;
    onToggleShowIgnoredFiles: () => void;
    onStash: () => void;
    onOpenShelfMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    onShowDiff: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    showAbortMerge: boolean;
    onAbortMerge: () => void;
}

/**
 * Renders commit-panel toolbar actions without owning repository state.
 *
 * Button callbacks are supplied by `CommitTab`, while this component handles
 * PyCharm-style icon coloring, tooltip labels, the view-options menu, and the
 * temporary refresh spinner affordance.
 */
export function Toolbar({
    onRefresh,
    isRefreshing,
    groupByDir,
    showIgnoredFiles,
    onRollback,
    onToggleGroupBy,
    onToggleShowIgnoredFiles,
    onStash,
    onOpenShelfMenu,
    onShowDiff,
    onExpandAll,
    onCollapseAll,
    showAbortMerge,
    onAbortMerge,
}: Props): React.ReactElement {
    const [viewMenuPosition, setViewMenuPosition] = useState<{ x: number; y: number } | null>(null);
    const viewMenuItems = useMemo<MenuItem[]>(
        () => [
            { label: t("common.groupBy"), action: "groupBy", disabled: true },
            {
                label: t("common.directory"),
                action: "toggleGroupBy",
                icon: groupByDir ? <CheckMark /> : undefined,
            },
            { label: "", action: "viewOptionsSeparator", separator: true },
            { label: t("common.show"), action: "show", disabled: true },
            {
                label: t("commitPanel.ignoredFiles"),
                action: "toggleIgnoredFiles",
                icon: showIgnoredFiles ? <CheckMark /> : undefined,
            },
        ],
        [groupByDir, showIgnoredFiles],
    );
    const handleOpenViewMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setViewMenuPosition({ x: rect.left, y: rect.bottom + 4 });
    }, []);
    const handleSelectViewMenuItem = useCallback(
        (action: string) => {
            if (action === "toggleGroupBy") onToggleGroupBy();
            if (action === "toggleIgnoredFiles") onToggleShowIgnoredFiles();
        },
        [onToggleGroupBy, onToggleShowIgnoredFiles],
    );

    return (
        <Flex
            align="center"
            gap="12px"
            px="8px"
            py="2px"
            minH="28px"
            bg="var(--intelligit-pycharm-header)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
            w="100%"
        >
            {isRefreshing && <style>{SPIN_KEYFRAMES}</style>}
            <ToolbarIconButton
                label={isRefreshing ? t("common.refreshing") : t("common.refresh")}
                onClick={onRefresh}
                color="#4ec7d6"
                spin={isRefreshing}
                disabled={isRefreshing}
                icon={<IoMdRefresh size={16} />}
            />
            <ToolbarIconButton
                label={t("common.rollback")}
                onClick={onRollback}
                color="#b8adff"
                icon={toolbarIcon(
                    <path
                        fill="currentColor"
                        d="M2.5 2l3.068 3.069L4.856 5.78l.707-.707L3.594 3.1H7A4.505 4.505 0 0 1 11.5 7.609 4.505 4.505 0 0 1 7 12.109H3.5v1H7a5.506 5.506 0 0 0 5.5-5.5A5.506 5.506 0 0 0 7 2.109H3.594l1.97-1.97-.708-.707L1.788 2.5z"
                    />,
                )}
            />
            <ToolbarIconButton
                label={t("common.viewOptions")}
                onClick={handleOpenViewMenu}
                color="#8fd5ff"
                icon={<LuEye size={16} />}
            />
            {viewMenuPosition && (
                <ContextMenu
                    x={viewMenuPosition.x}
                    y={viewMenuPosition.y}
                    minWidth={190}
                    items={viewMenuItems}
                    onSelect={handleSelectViewMenuItem}
                    onClose={() => setViewMenuPosition(null)}
                />
            )}
            <ToolbarIconButton
                label={t("common.stashChanges")}
                onClick={onStash}
                color="#ea8fb3"
                icon={toolbarIcon(
                    <path
                        fill="currentColor"
                        d="M14.5 1h-13A1.5 1.5 0 0 0 0 2.5v2A1.5 1.5 0 0 0 1 5.95V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.95A1.5 1.5 0 0 0 16 4.5v-2A1.5 1.5 0 0 0 14.5 1zM14 13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6h12v7.5zm1-9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v2zM6 9h4v1H6V9z"
                    />,
                )}
            />
            {onOpenShelfMenu ? (
                <ToolbarIconButton
                    label={t("shelf.action.toolbar")}
                    onClick={onOpenShelfMenu}
                    color="#ea8fb3"
                    icon={toolbarIcon(
                        <path
                            fill="currentColor"
                            d="M1.5 3.5h13v9h-13zM3 1.5h10v2H3zm1.5 5h7v1h-7zm-2 4h11v1h-11z"
                        />,
                    )}
                />
            ) : null}
            <ToolbarIconButton
                label={t("common.showDiffPreview")}
                onClick={onShowDiff}
                color="#8fd5ff"
                icon={toolbarIcon(<ShowDiffIconGlyph />)}
            />
            <ToolbarIconButton
                label={t("common.expandAll")}
                onClick={onExpandAll}
                color="#f3b1cf"
                icon={toolbarIcon(<ExpandAllIconGlyph />)}
            />
            <ToolbarIconButton
                label={t("common.collapseAll")}
                onClick={onCollapseAll}
                color="#f3b1cf"
                icon={toolbarIcon(<CollapseAllIconGlyph />)}
            />
            {showAbortMerge ? (
                <ToolbarButton label={t("merge.action.abortMerge")} onClick={onAbortMerge}>
                    <path fill="currentColor" d="M4 4h8v8H4z" />
                </ToolbarButton>
            ) : null}
        </Flex>
    );
}

function CheckMark(): React.ReactElement {
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
                d="M10 3.25 4.7 8.45 2.2 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function toolbarIcon(glyph: React.ReactNode): React.ReactElement {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16">
            {glyph}
        </svg>
    );
}

function ToolbarButton({
    label,
    onClick,
    children,
}: {
    label: string;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    children?: React.ReactNode;
}): React.ReactElement {
    const { hoverDelay, tooltipsEnabled } = getSettings();
    return (
        <Tooltip
            label={label}
            fontSize="11px"
            placement="bottom"
            openDelay={hoverDelay}
            isDisabled={!tooltipsEnabled}
        >
            <Button
                variant="danger"
                size="sm"
                onClick={onClick}
                leftIcon={toolbarIcon(children)}
                minW="auto"
                h="26px"
                px="8px"
                fontSize="12px"
                fontWeight={600}
            >
                {label}
            </Button>
        </Tooltip>
    );
}
