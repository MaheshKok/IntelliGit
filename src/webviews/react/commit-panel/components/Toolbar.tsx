// Toolbar with commit-view Git and file actions.

import React, { useCallback, useMemo, useState } from "react";
import { Box, Button, Flex, Tooltip } from "@chakra-ui/react";
import { VscArchive, VscDiscard, VscEye, VscLibrary, VscNewFile } from "react-icons/vsc";
import { CollapseAllIconGlyph, ExpandAllIconGlyph } from "../../shared/components/Icons";
import { getSettings } from "../../shared/settings";
import { ContextMenu, type MenuItem } from "../../shared/components/ContextMenu";
import { RefreshButton } from "../../shared/components/RefreshButton";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI, TOOLBAR_ICON_ACCENTS } from "../../shared/tokens";
import type { CommitPanelActiveOperation, CommitPanelRebaseControl } from "./operationTypes";

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
    /**
     * Whether the file tree has anything to act on.
     *
     * Expand, collapse and show-diff are no-ops on an empty tree, and the
     * commit toolbar was the only one of the three panel toolbars that left
     * them live anyway — the shelf and stash toolbars have always gated theirs.
     * A control that looks clickable and does nothing costs the user a click to
     * learn that.
     */
    hasFiles: boolean;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    showAbortMerge: boolean;
    onAbortMerge: () => void;
    activeOperation?: CommitPanelActiveOperation;
    rebaseControl?: CommitPanelRebaseControl;
    onContinueRebase: () => void;
    onAbortRebase: () => void;
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
    hasFiles,
    onExpandAll,
    onCollapseAll,
    showAbortMerge,
    onAbortMerge,
    activeOperation,
    rebaseControl,
    onContinueRebase,
    onAbortRebase,
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
            gap="2px"
            px="6px"
            minH={`${JETBRAINS_UI.size.toolbarHeight}px`}
            bg="var(--intelligit-pycharm-panel)"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
            flexShrink={0}
            w="100%"
        >
            <RefreshButton
                isRefreshing={isRefreshing ?? false}
                holdFeedback={false}
                onRefresh={onRefresh}
            />
            <ToolbarIconButton
                label={t("common.rollback")}
                onClick={onRollback}
                color={TOOLBAR_ICON_ACCENTS.rollback}
                icon={<VscDiscard size={16} />}
            />
            <ToolbarIconButton
                label={t("common.viewOptions")}
                onClick={handleOpenViewMenu}
                color={TOOLBAR_ICON_ACCENTS.viewOptions}
                icon={<VscEye size={16} />}
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
            <ToolbarSeparator />
            <ToolbarIconButton
                label={t("common.stashChanges")}
                onClick={onStash}
                color={TOOLBAR_ICON_ACCENTS.stash}
                icon={<VscArchive size={16} />}
            />
            {onOpenShelfMenu ? (
                <ToolbarIconButton
                    label={t("shelf.action.toolbar")}
                    onClick={onOpenShelfMenu}
                    color={TOOLBAR_ICON_ACCENTS.shelf}
                    icon={<VscLibrary size={16} />}
                />
            ) : null}
            <ToolbarSeparator />
            <ToolbarIconButton
                label={t("common.showDiffPreview")}
                onClick={onShowDiff}
                disabled={!hasFiles}
                color={TOOLBAR_ICON_ACCENTS.showDiff}
                icon={<VscNewFile size={16} />}
            />
            <ToolbarIconButton
                label={t("common.expandAll")}
                onClick={onExpandAll}
                disabled={!hasFiles}
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
                disabled={!hasFiles}
                color={TOOLBAR_ICON_ACCENTS.expandCollapse}
                icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                        <CollapseAllIconGlyph />
                    </svg>
                }
            />
            {activeOperation === "rebase" && rebaseControl ? (
                <>
                    <ToolbarSeparator />
                    {rebaseControl !== "foreign" ? (
                        <>
                            <ToolbarButton
                                label={t("rebase.action.continueRebase")}
                                onClick={onContinueRebase}
                                variant="secondary"
                            >
                                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                                    <path
                                        fill="currentColor"
                                        d="m4 8 3 3 5-6-1.5-1.25L7 8 5.5 6.5z"
                                    />
                                </svg>
                            </ToolbarButton>
                            <ToolbarButton
                                label={t("rebase.action.abortRebase")}
                                onClick={onAbortRebase}
                            >
                                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                                    <path fill="currentColor" d="M4 4h8v8H4z" />
                                </svg>
                            </ToolbarButton>
                        </>
                    ) : null}
                </>
            ) : null}
            {showAbortMerge && activeOperation !== "rebase" ? (
                <>
                    <ToolbarSeparator />
                    <ToolbarButton label={t("merge.action.abortMerge")} onClick={onAbortMerge}>
                        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                            <path fill="currentColor" d="M4 4h8v8H4z" />
                        </svg>
                    </ToolbarButton>
                </>
            ) : null}
        </Flex>
    );
}

/** Hairline divider between commit-toolbar action groups. */
function ToolbarSeparator(): React.ReactElement {
    return (
        <Box
            aria-hidden
            w="1px"
            h="16px"
            mx="4px"
            flexShrink={0}
            bg="var(--intelligit-pycharm-border)"
        />
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

/** Renders a compact toolbar action with an explicit semantic visual treatment. */
function ToolbarButton({
    label,
    onClick,
    children,
    variant = "danger",
}: {
    label: string;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    children?: React.ReactElement;
    variant?: "danger" | "secondary";
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
                variant={variant}
                size="sm"
                onClick={onClick}
                leftIcon={children}
                minW="auto"
                h="24px"
                px="8px"
                fontSize="12px"
                fontWeight={600}
            >
                {label}
            </Button>
        </Tooltip>
    );
}
