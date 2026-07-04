// Toolbar with commit-view Git and file actions.

import React, { useCallback, useMemo, useState } from "react";
import { Button, Flex, IconButton, Tooltip } from "@chakra-ui/react";
import { IoMdRefresh } from "react-icons/io";
import { LuEye } from "react-icons/lu";
import { getSettings } from "../../shared/settings";
import { CollapseAllIconGlyph, ExpandAllIconGlyph } from "../../shared/components/Icons";
import { ContextMenu, type MenuItem } from "../../shared/components/ContextMenu";
import { t } from "../../shared/i18n";

interface Props {
    onRefresh: () => void;
    isRefreshing?: boolean;
    groupByDir: boolean;
    showIgnoredFiles: boolean;
    onRollback: () => void;
    onToggleGroupBy: () => void;
    onToggleShowIgnoredFiles: () => void;
    onShelve: () => void;
    onShowDiff: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    showAbortMerge: boolean;
    onAbortMerge: () => void;
}

const SPIN_KEYFRAMES = `@keyframes intelligit-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;

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
    onShelve,
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
            <ToolbarButton
                label={isRefreshing ? t("common.refreshing") : t("common.refresh")}
                onClick={onRefresh}
                color="#4ec7d6"
                spin={isRefreshing}
                disabled={isRefreshing}
                icon={<IoMdRefresh size={16} />}
            />
            <ToolbarButton label={t("common.rollback")} onClick={onRollback} color="#b8adff">
                <path
                    fill="currentColor"
                    d="M2.5 2l3.068 3.069L4.856 5.78l.707-.707L3.594 3.1H7A4.505 4.505 0 0 1 11.5 7.609 4.505 4.505 0 0 1 7 12.109H3.5v1H7a5.506 5.506 0 0 0 5.5-5.5A5.506 5.506 0 0 0 7 2.109H3.594l1.97-1.97-.708-.707L1.788 2.5z"
                />
            </ToolbarButton>
            <ToolbarButton
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
            <ToolbarButton label={t("common.shelveChanges")} onClick={onShelve} color="#ea8fb3">
                <path
                    fill="currentColor"
                    d="M14.5 1h-13A1.5 1.5 0 0 0 0 2.5v2A1.5 1.5 0 0 0 1 5.95V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.95A1.5 1.5 0 0 0 16 4.5v-2A1.5 1.5 0 0 0 14.5 1zM14 13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6h12v7.5zm1-9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v2zM6 9h4v1H6V9z"
                />
            </ToolbarButton>
            <ToolbarButton label={t("common.showDiffPreview")} onClick={onShowDiff} color="#8fd5ff">
                <path
                    fill="currentColor"
                    d="M2 3.5A1.5 1.5 0 0 1 3.5 2h5.586a1.5 1.5 0 0 1 1.06.44l2.415 2.414A1.5 1.5 0 0 1 13 5.914V12.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12.5v-9zm1.5-.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V5.914L9.086 2.5H3.5zM7 7V5h1v2h2v1H8v2H7V8H5V7h2z"
                />
            </ToolbarButton>
            <ToolbarButton label={t("common.expandAll")} onClick={onExpandAll} color="#f3b1cf">
                <ExpandAllIconGlyph />
            </ToolbarButton>
            <ToolbarButton label={t("common.collapseAll")} onClick={onCollapseAll} color="#f3b1cf">
                <CollapseAllIconGlyph />
            </ToolbarButton>
            {showAbortMerge ? (
                <ToolbarButton
                    label={t("merge.action.abortMerge")}
                    onClick={onAbortMerge}
                    color="#ff6b6b"
                    showLabel
                >
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

function ToolbarButton({
    label,
    onClick,
    color,
    spin,
    disabled,
    showLabel,
    icon,
    children,
}: {
    label: string;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    color?: string;
    spin?: boolean;
    disabled?: boolean;
    showLabel?: boolean;
    icon?: React.ReactElement<{
        "aria-hidden"?: boolean;
        focusable?: string | boolean;
        style?: React.CSSProperties;
    }>;
    children?: React.ReactNode;
}): React.ReactElement {
    const { hoverDelay, tooltipsEnabled, iconStyle } = getSettings();
    const resolvedColor = disabled
        ? "var(--vscode-disabledForeground)"
        : iconStyle === "standard"
          ? "var(--vscode-icon-foreground)"
          : (color ?? undefined);
    const svgStyle: React.CSSProperties = {
        ...(resolvedColor ? { color: resolvedColor } : {}),
        ...(spin
            ? {
                  animation: "intelligit-spin 0.8s linear infinite",
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  willChange: "transform",
              }
            : {}),
    };
    const renderedIcon = icon ? (
        React.cloneElement(icon, {
            "aria-hidden": true,
            focusable: "false",
            style: { ...svgStyle, ...(icon.props.style ?? {}) },
        })
    ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" style={svgStyle}>
            {children}
        </svg>
    );
    return (
        <Tooltip
            label={label}
            fontSize="11px"
            placement="bottom"
            openDelay={hoverDelay}
            isDisabled={!tooltipsEnabled}
        >
            {showLabel ? (
                <Button
                    aria-label={label}
                    variant="toolbarGhost"
                    size="sm"
                    onClick={disabled ? undefined : onClick}
                    isDisabled={disabled}
                    _disabled={{
                        bg: "rgba(255,255,255,0.03)",
                        color: "var(--vscode-disabledForeground)",
                        cursor: "default",
                        opacity: 0.55,
                    }}
                    data-refreshing={spin ? "true" : undefined}
                    leftIcon={renderedIcon}
                    minW="auto"
                    h="26px"
                    px="8px"
                    fontSize="12px"
                    fontWeight={600}
                    color={resolvedColor}
                >
                    {label}
                </Button>
            ) : (
                <IconButton
                    aria-label={label}
                    variant="toolbarGhost"
                    size="sm"
                    onClick={disabled ? undefined : onClick}
                    isDisabled={disabled}
                    _disabled={{
                        bg: "rgba(255,255,255,0.03)",
                        color: "var(--vscode-disabledForeground)",
                        cursor: "default",
                        opacity: 0.55,
                    }}
                    data-refreshing={spin ? "true" : undefined}
                    icon={renderedIcon}
                />
            )}
        </Tooltip>
    );
}
