// Stash tree rows and the file subtree rendered beneath an expanded row.

import React, { useMemo } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { buildFileTree, type TreeEntry } from "../../shared/fileTree";
import { ChevronIcon } from "../../shared/components/Icons";
import { FileTreeRows, ENTRY_ROW_GUIDE_LEFT } from "../../shared/components/FileTreeRows";
import { t } from "../../shared/i18n";
import { formatDateTime } from "../../shared/date";

type StashFileContextMenuHandler = (
    path: string,
    x: number,
    y: number,
    returnFocusTarget: HTMLElement,
) => void;

/** State and callbacks for the keyboard-navigable stash row tree. */
export interface StashListProps {
    stashes: StashEntry[];
    selectedIndex: number | null;
    /** Hashes of the stashes whose file subtree is currently rendered. */
    expandedHashes: ReadonlySet<string>;
    /** Files already loaded, by stash hash; a missing hash means "still loading". */
    filesByHash: Readonly<Record<string, WorkingFile[]>>;
    onStashClick: (index: number) => void;
    onToggleExpand: (stash: StashEntry) => void;
    onStashContextMenu: (index: number, x: number, y: number) => void;
    /** Renders one stash's file rows; called only once that stash's files are cached. */
    renderSubtree: (stash: StashEntry, files: WorkingFile[]) => React.ReactNode;
}

/**
 * PyCharm's stash meta line: `2 files, 2/22/26, 8:55 AM`. The count only appears
 * once the stash has been expanded, since its files load one entry at a time.
 */
function stashMetaText(fileCount: number | undefined, date: string): string | null {
    const files = fileCount === undefined ? null : t("common.fileCount", { count: fileCount });
    const formatted = date ? formatDateTime(date) : null;
    if (files !== null && formatted !== null) {
        return t("common.filesAndDate", { files, date: formatted });
    }
    return files ?? formatted;
}

/** Stash tree with roving tabindex and rows that expand in place into their files. */
export function StashList({
    stashes,
    selectedIndex,
    expandedHashes,
    filesByHash,
    onStashClick,
    onToggleExpand,
    onStashContextMenu,
    renderSubtree,
}: StashListProps): React.ReactElement {
    return (
        <Box
            data-testid="stash-list"
            role="tree"
            aria-label={t("stash.defaultTitle")}
            flex={1}
            minH={0}
            overflowY="auto"
            py="6px"
            bg="var(--intelligit-pycharm-panel)"
        >
            {stashes.length === 0 ? (
                <Box
                    color="var(--intelligit-pycharm-muted)"
                    fontSize="12px"
                    p="12px"
                    textAlign="center"
                >
                    {t("stash.empty")}
                </Box>
            ) : (
                stashes.map((stash) => {
                    const parsed = parseStashMessage(stash.message);
                    const isSelected = selectedIndex === stash.index;
                    const isExpanded = expandedHashes.has(stash.hash);
                    const files = filesByHash[stash.hash];
                    const meta = stashMetaText(files?.length, stash.date);
                    return (
                        <React.Fragment key={stash.index}>
                            <Flex
                                role="treeitem"
                                data-stash-index={stash.index}
                                aria-selected={isSelected}
                                aria-expanded={isExpanded}
                                aria-level={1}
                                tabIndex={
                                    isSelected ||
                                    (selectedIndex === null && stash.index === stashes[0]?.index)
                                        ? 0
                                        : -1
                                }
                                align="center"
                                w="calc(100% - 16px)"
                                minH="26px"
                                mx="8px"
                                px="6px"
                                gap="6px"
                                borderRadius="3px"
                                cursor="pointer"
                                fontFamily={SYSTEM_FONT_STACK}
                                fontSize="13px"
                                textAlign="left"
                                color={
                                    isSelected
                                        ? "var(--intelligit-pycharm-selected-foreground)"
                                        : "var(--intelligit-pycharm-foreground)"
                                }
                                bg={
                                    isSelected
                                        ? "var(--intelligit-pycharm-selected)"
                                        : "transparent"
                                }
                                _hover={{
                                    bg: isSelected
                                        ? "var(--intelligit-pycharm-selected)"
                                        : "var(--intelligit-pycharm-selected-hover)",
                                }}
                                onClick={() => onStashClick(stash.index)}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    onStashContextMenu(stash.index, event.clientX, event.clientY);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                                        // Standard tree keys: right opens a closed row, left closes an open one.
                                        event.preventDefault();
                                        if (isExpanded === (event.key === "ArrowLeft")) {
                                            onToggleExpand(stash);
                                        }
                                        return;
                                    }
                                    const adjacentIndex = adjacentStashIndex(
                                        stashes,
                                        stash.index,
                                        event.key,
                                    );
                                    if (adjacentIndex !== null) {
                                        event.preventDefault();
                                        onStashClick(adjacentIndex);
                                        event.currentTarget
                                            .closest('[role="tree"]')
                                            ?.querySelector<HTMLElement>(
                                                `[data-stash-index="${adjacentIndex}"]`,
                                            )
                                            ?.focus();
                                        return;
                                    }
                                    if (
                                        event.key !== "ContextMenu" &&
                                        !(event.shiftKey && event.key === "F10")
                                    ) {
                                        return;
                                    }
                                    event.preventDefault();
                                    const rect = event.currentTarget.getBoundingClientRect();
                                    onStashContextMenu(stash.index, rect.left, rect.bottom);
                                }}
                                title={stash.message}
                            >
                                <Box
                                    as="span"
                                    display="inline-flex"
                                    alignItems="center"
                                    flexShrink={0}
                                    aria-hidden
                                    onClick={() => onToggleExpand(stash)}
                                >
                                    <ChevronIcon expanded={isExpanded} />
                                </Box>
                                <Box
                                    as="span"
                                    minW={0}
                                    overflow="hidden"
                                    textOverflow="ellipsis"
                                    whiteSpace="nowrap"
                                >
                                    {parsed.title}
                                </Box>
                                {meta ? (
                                    <Box
                                        as="span"
                                        data-stash-meta
                                        flexShrink={0}
                                        fontSize="11px"
                                        color={
                                            isSelected
                                                ? "var(--intelligit-pycharm-selected-foreground)"
                                                : "var(--intelligit-pycharm-muted)"
                                        }
                                        opacity={isSelected ? 0.8 : 1}
                                    >
                                        {meta}
                                    </Box>
                                ) : null}
                                <Box flex={1} minW={0} />
                                {parsed.branch ? <StashBranchLabel branch={parsed.branch} /> : null}
                            </Flex>
                            {isExpanded ? (
                                <Box role="group">
                                    {files === undefined ? (
                                        <Box
                                            px="12px"
                                            py="6px"
                                            fontSize="12px"
                                            color="var(--intelligit-pycharm-muted)"
                                        >
                                            {t("common.loading")}
                                        </Box>
                                    ) : (
                                        renderSubtree(stash, files)
                                    )}
                                </Box>
                            ) : null}
                        </React.Fragment>
                    );
                })
            )}
        </Box>
    );
}

/** Returns the next row selected by the standard tree navigation keys. */
function adjacentStashIndex(
    stashes: StashEntry[],
    currentIndex: number,
    key: string,
): number | null {
    const currentPosition = stashes.findIndex((stash) => stash.index === currentIndex);
    if (currentPosition < 0) return null;
    if (key === "Home") return stashes[0]?.index ?? null;
    if (key === "End") return stashes.at(-1)?.index ?? null;
    if (key === "ArrowUp") return stashes[Math.max(0, currentPosition - 1)]?.index ?? null;
    if (key === "ArrowDown") {
        return stashes[Math.min(stashes.length - 1, currentPosition + 1)]?.index ?? null;
    }
    return null;
}

/** Props for the file rows nested beneath one expanded stash row. */
export interface StashFileTreeProps {
    files: WorkingFile[];
    groupByDir: boolean;
    /** Indent level of the file rows; one level deeper than the owning stash row. */
    depth: number;
    selectedFilePath: string | null;
    isDirectoryCollapsed: (path: string) => boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleDirectory: (path: string) => void;
    onFileSelect: (path: string) => void;
    onFileActivate: (path: string) => void;
    onFileContextMenu: StashFileContextMenuHandler;
}

/** Read-only file rows for one stash; activation always opens that file's stash diff. */
export function StashFileTree({
    files,
    groupByDir,
    depth,
    selectedFilePath,
    isDirectoryCollapsed,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDirectory,
    onFileSelect,
    onFileActivate,
    onFileContextMenu,
}: StashFileTreeProps): React.ReactElement {
    const tree = useMemo<TreeEntry<WorkingFile>[]>(
        () =>
            groupByDir
                ? buildFileTree(files)
                : files.map((file) => ({ type: "file" as const, file })),
        [files, groupByDir],
    );

    if (files.length === 0) {
        return (
            <Box px="12px" py="6px" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                {t("stash.noFiles")}
            </Box>
        );
    }
    return (
        <FileTreeRows
            entries={tree}
            depth={depth}
            ariaLevel={depth + 2}
            sectionGuideLeft={ENTRY_ROW_GUIDE_LEFT}
            showParentPath={!groupByDir}
            folderIcon={folderIcon}
            folderExpandedIcon={folderExpandedIcon}
            folderIconsByName={folderIconsByName}
            isDirectoryExpanded={(path) => !isDirectoryCollapsed(path)}
            onToggleDirectory={onToggleDirectory}
            fileWiring={(file) => ({
                isSelected: selectedFilePath === file.path,
                onSelect: () => onFileSelect(file.path),
                onActivate: () => onFileActivate(file.path),
                onContextMenu: (x, y, returnFocusTarget) =>
                    onFileContextMenu(file.path, x, y, returnFocusTarget),
                dataAttributes: { "stash-file": file.path },
            })}
        />
    );
}

/** Renders a semantic branch tag icon and adjacent plain branch label. */
function StashBranchLabel({ branch }: { branch: string }): React.ReactElement {
    return (
        <Box as="span" display="inline-flex" alignItems="center" gap="4px" flexShrink={0}>
            <Box
                as="svg"
                w="14px"
                h="14px"
                viewBox="0 0 16 16"
                aria-hidden
                color="var(--vscode-charts-yellow, var(--intelligit-pycharm-modified))"
            >
                <path
                    fill="currentColor"
                    d="M8.4 1.5H3.8L1.5 3.8v4.6l6.1 6.1 6.9-6.9L8.4 1.5zm-4 1.5h3.4l4.6 4.6-4.8 4.8-4.6-4.6V4.4L4.4 3zm1.5 1.1a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3z"
                />
            </Box>
            <Box
                as="span"
                maxW="160px"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
            >
                {branch}
            </Box>
        </Box>
    );
}

/** Splits Git's standard or WIP stash message into subject and optional source branch. */
function parseStashMessage(message: string): { title: string; branch: string | null } {
    const trimmed = message.trim();
    const wipMatch = trimmed.match(/^WIP on\s+([^:]+):\s*(?:[0-9a-f]{7,64}\s+)?(.*)$/i);
    const standardMatch = trimmed.match(/^On\s+([^:]+):\s*(.*)$/i);
    const match = wipMatch ?? standardMatch;
    if (!match) return { title: trimmed || t("stash.defaultTitle"), branch: null };
    const branch = match[1]?.trim() ?? "";
    return {
        title: match[2]?.trim() || t("stash.defaultTitle"),
        branch: branch && branch.toLowerCase() !== "(no branch)" ? branch : null,
    };
}
