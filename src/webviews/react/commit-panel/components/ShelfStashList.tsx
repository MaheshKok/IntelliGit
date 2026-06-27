// Renders shelf entries and the selected stash file tree preview.
// ShelfTab keeps selection, expansion, and VS Code postMessage ownership.
// This component only maps current stash state into rows, loading text, and file tree nodes.

import React from "react";
import { Box, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import type { TreeEntry } from "../types";
import { FileTypeIcon } from "./FileTypeIcon";
import { TreeFolderIcon } from "./TreeIcons";
import { ChevronIcon } from "../../shared/components/Icons";
import type { IntelligitSettings } from "../../shared/settings";
import { resolveFolderIcon } from "../../shared/utils/folderIcons";
import { getLeafName } from "../../shared/utils/path";
import { t } from "../../shared/i18n";

/** Props for rendering stash rows, their preview files, and row-level callbacks. */
export interface ShelfStashListProps {
    stashes: StashEntry[];
    shelfFiles: WorkingFile[];
    selectedIndex: number | null;
    expandedIndex: number | null;
    isLoading: boolean;
    tree: TreeEntry[];
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    fileTreeHeight: number;
    iconStyle: IntelligitSettings["iconStyle"];
    onStashClick: (index: number) => void;
    onStashContextMenu: (event: React.MouseEvent, index: number) => void;
    onToggleDir: (path: string) => void;
    onShowShelfDiff: (index: number, path: string) => void;
    onFileTreeDragStart: (event: React.MouseEvent) => void;
}

/** Renders the scrollable shelf stash list and expanded file preview. */
export function ShelfStashList({
    stashes,
    shelfFiles,
    selectedIndex,
    expandedIndex,
    isLoading,
    tree,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    fileTreeHeight,
    iconStyle,
    onStashClick,
    onStashContextMenu,
    onToggleDir,
    onShowShelfDiff,
    onFileTreeDragStart,
}: ShelfStashListProps): React.ReactElement {
    return (
        <Box flex="1 1 auto" overflowY="auto" pt="1px" bg="var(--intelligit-pycharm-panel)">
            {stashes.length === 0 ? (
                <Box
                    color="var(--intelligit-pycharm-muted)"
                    fontSize="12px"
                    p="12px"
                    textAlign="center"
                >
                    {t("shelf.empty")}
                </Box>
            ) : (
                stashes.map((stash) => {
                    const parsed = parseShelfMessage(stash.message);
                    const isExpanded = expandedIndex === stash.index;
                    const hasFiles = isExpanded && selectedIndex === stash.index;
                    return (
                        <React.Fragment key={stash.index}>
                            <Flex
                                align="center"
                                px="9px"
                                py="2px"
                                minH="32px"
                                fontSize="13px"
                                fontFamily={SYSTEM_FONT_STACK}
                                cursor="pointer"
                                bg={
                                    isExpanded
                                        ? "var(--intelligit-pycharm-selected)"
                                        : "transparent"
                                }
                                color={
                                    isExpanded
                                        ? "var(--intelligit-pycharm-selected-foreground, var(--vscode-list-activeSelectionForeground))"
                                        : "var(--intelligit-pycharm-foreground)"
                                }
                                _hover={{
                                    bg: isExpanded
                                        ? "var(--intelligit-pycharm-selected)"
                                        : "var(--intelligit-pycharm-selected-hover)",
                                }}
                                onClick={() => onStashClick(stash.index)}
                                onContextMenu={(event) => onStashContextMenu(event, stash.index)}
                                title={stash.message}
                                borderRadius={isExpanded ? "6px" : 0}
                                mx="8px"
                                my="1px"
                            >
                                <ChevronIcon expanded={isExpanded} />
                                <Box
                                    as="span"
                                    flex={1}
                                    minW={0}
                                    overflow="hidden"
                                    textOverflow="ellipsis"
                                    whiteSpace="nowrap"
                                >
                                    {parsed.title}
                                </Box>
                                {parsed.branch && (
                                    <Box
                                        as="span"
                                        ml="10px"
                                        display="inline-flex"
                                        alignItems="center"
                                        fontSize="13px"
                                        gap="4px"
                                        color="var(--intelligit-pycharm-foreground)"
                                        px="7px"
                                        py="1px"
                                        borderRadius="5px"
                                        bg="var(--intelligit-pycharm-header, var(--vscode-badge-background))"
                                        flexShrink={0}
                                    >
                                        <Box
                                            as="svg"
                                            w="12px"
                                            h="12px"
                                            viewBox="0 0 16 16"
                                            opacity={0.95}
                                            color={
                                                iconStyle === "standard"
                                                    ? "var(--vscode-icon-foreground)"
                                                    : "var(--vscode-charts-green, #35D46A)"
                                            }
                                        >
                                            <path
                                                fill="currentColor"
                                                d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6.5a.5.5 0 0 1-.5.5H9.25a1.75 1.75 0 0 0-1.75 1.75v.872a2.25 2.25 0 1 1-1.5 0V4.372a2.25 2.25 0 1 1 1.5 0v3.256A3.25 3.25 0 0 1 9.25 6.5H12V5.372a2.25 2.25 0 0 1-2.5-2.122zM4.25 3.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5zM4.25 14a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"
                                            />
                                        </Box>
                                        {parsed.branch}
                                    </Box>
                                )}
                            </Flex>
                            {isExpanded && !hasFiles && isLoading && (
                                <Box
                                    pl="28px"
                                    py="4px"
                                    fontSize="12px"
                                    color="var(--intelligit-pycharm-muted)"
                                >
                                    {t("common.loading")}
                                </Box>
                            )}
                            {hasFiles && (
                                <>
                                    <Box h={`${fileTreeHeight}px`} overflowY="auto">
                                        {shelfFiles.length > 0 ? (
                                            <ShelfFileTree
                                                entries={tree}
                                                expandedDirs={expandedDirs}
                                                folderIcon={folderIcon}
                                                folderExpandedIcon={folderExpandedIcon}
                                                folderIconsByName={folderIconsByName}
                                                onToggleDir={onToggleDir}
                                                onFileClick={(path) =>
                                                    onShowShelfDiff(stash.index, path)
                                                }
                                                depth={1}
                                            />
                                        ) : (
                                            <Box
                                                pl="28px"
                                                py="2px"
                                                fontSize="12px"
                                                color="var(--intelligit-pycharm-muted)"
                                            >
                                                {t("shelf.noFiles")}
                                            </Box>
                                        )}
                                    </Box>
                                    <Box
                                        h="4px"
                                        flexShrink={0}
                                        cursor="row-resize"
                                        bg="var(--intelligit-pycharm-border)"
                                        onMouseDown={onFileTreeDragStart}
                                        _hover={{
                                            bg: "var(--intelligit-pycharm-blue)",
                                        }}
                                    />
                                </>
                            )}
                        </React.Fragment>
                    );
                })
            )}
        </Box>
    );
}

function parseShelfMessage(message: string): { title: string; branch: string | null } {
    const trimmed = message.trim();
    const match = trimmed.match(/^On\s+([^:]+):\s*(.*)$/i);
    if (!match) return { title: trimmed || t("shelf.defaultTitle"), branch: null };
    return {
        title: match[2]?.trim() || t("shelf.defaultTitle"),
        branch: match[1]?.trim() || null,
    };
}

function ShelfFileTree({
    entries,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDir,
    onFileClick,
    depth = 0,
}: {
    entries: TreeEntry[];
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleDir: (path: string) => void;
    onFileClick: (path: string) => void;
    depth?: number;
}): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    const fileName = getLeafName(entry.file.path);
                    return (
                        <Flex
                            key={entry.file.path}
                            align="center"
                            pl={`${10 + depth * 16}px`}
                            pr="8px"
                            minH="20px"
                            gap="4px"
                            fontSize="12px"
                            fontFamily={SYSTEM_FONT_STACK}
                            cursor="pointer"
                            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                            onClick={() => onFileClick(entry.file.path)}
                            title={entry.file.path}
                        >
                            <Box as="span" w="11px" />
                            <FileTypeIcon status={entry.file.status} icon={entry.file.icon} />
                            <Box
                                as="span"
                                flex={1}
                                minW={0}
                                whiteSpace="nowrap"
                                overflow="hidden"
                                textOverflow="ellipsis"
                            >
                                {fileName}
                            </Box>
                        </Flex>
                    );
                }

                const isExpanded = expandedDirs.has(entry.path);
                const fileCount = entry.descendantFiles.length;
                const resolvedIcon = resolveFolderIcon(
                    entry.path || entry.name,
                    isExpanded,
                    folderIconsByName,
                    folderIcon,
                    folderExpandedIcon,
                );
                return (
                    <React.Fragment key={entry.path}>
                        <Flex
                            align="center"
                            pl={`${10 + depth * 16}px`}
                            pr="8px"
                            minH="20px"
                            gap="4px"
                            fontSize="12px"
                            fontFamily={SYSTEM_FONT_STACK}
                            cursor="pointer"
                            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                            onClick={() => onToggleDir(entry.path)}
                        >
                            <ChevronIcon expanded={isExpanded} />
                            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
                            <Box
                                as="span"
                                flex={1}
                                minW={0}
                                whiteSpace="nowrap"
                                overflow="hidden"
                                textOverflow="ellipsis"
                            >
                                {entry.name}
                            </Box>
                            <Box
                                as="span"
                                fontSize="11px"
                                color="var(--vscode-descriptionForeground)"
                                flexShrink={0}
                            >
                                {t("common.fileCount", { count: fileCount })}
                            </Box>
                        </Flex>
                        {isExpanded && (
                            <ShelfFileTree
                                entries={entry.children}
                                expandedDirs={expandedDirs}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                onToggleDir={onToggleDir}
                                onFileClick={onFileClick}
                                depth={depth + 1}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}
