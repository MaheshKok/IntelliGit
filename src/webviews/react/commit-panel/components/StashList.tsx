// Flat stash rows and the selected stash's file list.

import React from "react";
import { Box, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import type { TreeEntry } from "../types";
import { FileRow } from "./FileRow";
import { FolderRow } from "./FolderRow";
import { SectionHeader } from "./SectionHeader";
import { t } from "../../shared/i18n";

/** Props for the flat stash row list. */
export interface StashListProps {
    stashes: StashEntry[];
    selectedIndex: number | null;
    height: number;
    maxHeight: string;
    onStashClick: (index: number) => void;
    onStashContextMenu: (index: number, x: number, y: number) => void;
}

/** Props for the selected stash's lower file pane. */
export interface StashFilePaneProps {
    stashFiles: WorkingFile[];
    selectedIndex: number | null;
    isLoading: boolean;
    groupByDir: boolean;
    selectedFilePath: string | null;
    changesSection: StashFileSection;
    unversionedSection: StashFileSection;
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleDir: (path: string) => void;
    onFileSelect: (path: string) => void;
    onFileActivate: (path: string) => void;
}

/** Derived state for one non-selectable stash file section. */
export interface StashFileSection {
    files: WorkingFile[];
    tree: TreeEntry[];
    count: number;
    stats: { additions: number; deletions: number };
    isOpen: boolean;
    onToggleOpen: () => void;
}

/** Renders one flat, selectable stash row list without nested file previews. */
export function StashList({
    stashes,
    selectedIndex,
    height,
    maxHeight,
    onStashClick,
    onStashContextMenu,
}: StashListProps): React.ReactElement {
    return (
        <Box
            data-testid="stash-list"
            role="listbox"
            aria-label={t("stash.defaultTitle")}
            style={{ height: `${height}px`, maxHeight }}
            minH="100px"
            flexShrink={0}
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
                    return (
                        <Flex
                            as="button"
                            type="button"
                            key={stash.index}
                            role="option"
                            data-stash-index={stash.index}
                            aria-selected={isSelected}
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
                            border="0"
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
                            bg={isSelected ? "var(--intelligit-pycharm-selected)" : "transparent"}
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
                                const adjacentIndex = adjacentStashIndex(
                                    stashes,
                                    stash.index,
                                    event.key,
                                );
                                if (adjacentIndex !== null) {
                                    event.preventDefault();
                                    onStashClick(adjacentIndex);
                                    event.currentTarget
                                        .closest('[role="listbox"]')
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
                                minW={0}
                                overflow="hidden"
                                textOverflow="ellipsis"
                                whiteSpace="nowrap"
                            >
                                {parsed.title}
                            </Box>
                            {stash.date ? (
                                <Box
                                    as="span"
                                    flexShrink={0}
                                    color={
                                        isSelected
                                            ? "var(--intelligit-pycharm-selected-foreground)"
                                            : "var(--intelligit-pycharm-muted)"
                                    }
                                    opacity={isSelected ? 0.8 : 1}
                                >
                                    {stash.date}
                                </Box>
                            ) : null}
                            <Box flex={1} minW={0} />
                            {parsed.branch ? <StashBranchLabel branch={parsed.branch} /> : null}
                        </Flex>
                    );
                })
            )}
        </Box>
    );
}

/** Returns the next row selected by the standard listbox navigation keys. */
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

/** Renders the selected stash's one lower file region without incomplete listbox semantics. */
export function StashFilePane({
    stashFiles,
    selectedIndex,
    isLoading,
    groupByDir,
    selectedFilePath,
    changesSection,
    unversionedSection,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDir,
    onFileSelect,
    onFileActivate,
}: StashFilePaneProps): React.ReactElement {
    return (
        <Box
            data-testid="stash-file-pane"
            role="region"
            aria-label={t("stash.files")}
            aria-busy={isLoading || undefined}
            flex={1}
            minH="80px"
            overflowY="auto"
            py="6px"
            bg="var(--intelligit-pycharm-panel)"
        >
            {selectedIndex === null ? null : isLoading ? (
                <Box px="12px" py="6px" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    {t("common.loading")}
                </Box>
            ) : stashFiles.length > 0 ? (
                <>
                    <StashFilePaneSection
                        label={t("commitPanel.changes")}
                        section={changesSection}
                        groupByDir={groupByDir}
                        selectedFilePath={selectedFilePath}
                        expandedDirs={expandedDirs}
                        folderIcon={folderIcon}
                        folderExpandedIcon={folderExpandedIcon}
                        folderIconsByName={folderIconsByName}
                        onToggleDir={onToggleDir}
                        onFileSelect={onFileSelect}
                        onFileActivate={onFileActivate}
                    />
                    {unversionedSection.files.length > 0 ? (
                        <StashFilePaneSection
                            label={t("commitPanel.unversionedFiles")}
                            section={unversionedSection}
                            groupByDir={groupByDir}
                            selectedFilePath={selectedFilePath}
                            expandedDirs={expandedDirs}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            onToggleDir={onToggleDir}
                            onFileSelect={onFileSelect}
                            onFileActivate={onFileActivate}
                        />
                    ) : null}
                </>
            ) : (
                <Box px="12px" py="6px" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    {t("stash.noFiles")}
                </Box>
            )}
        </Box>
    );
}

/** Renders one stash-file section without exposing any file-selection controls. */
function StashFilePaneSection({
    label,
    section,
    groupByDir,
    selectedFilePath,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDir,
    onFileSelect,
    onFileActivate,
}: {
    label: string;
    section: StashFileSection;
    groupByDir: boolean;
    selectedFilePath: string | null;
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleDir: (path: string) => void;
    onFileSelect: (path: string) => void;
    onFileActivate: (path: string) => void;
}): React.ReactElement {
    return (
        <>
            <SectionHeader
                label={label}
                count={section.count}
                stats={section.stats}
                isOpen={section.isOpen}
                isAllChecked={false}
                isSomeChecked={false}
                onToggleOpen={section.onToggleOpen}
                onToggleCheck={() => undefined}
                checkboxVisibility="hidden"
            />
            {section.isOpen ? (
                <StashFileTree
                    entries={section.tree}
                    groupByDir={groupByDir}
                    selectedFilePath={selectedFilePath}
                    expandedDirs={expandedDirs}
                    folderIcon={folderIcon}
                    folderExpandedIcon={folderExpandedIcon}
                    folderIconsByName={folderIconsByName}
                    onToggleDir={onToggleDir}
                    onFileSelect={onFileSelect}
                    onFileActivate={onFileActivate}
                />
            ) : null}
        </>
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

/** Renders nested folders only within the selected stash's single lower file pane. */
function StashFileTree({
    entries,
    groupByDir,
    selectedFilePath,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDir,
    onFileSelect,
    onFileActivate,
    depth = 0,
}: {
    entries: TreeEntry[];
    groupByDir: boolean;
    selectedFilePath: string | null;
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleDir: (path: string) => void;
    onFileSelect: (path: string) => void;
    onFileActivate: (path: string) => void;
    depth?: number;
}): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    const isSelected = selectedFilePath === entry.file.path;
                    return (
                        <FileRow
                            key={entry.file.path}
                            file={entry.file}
                            depth={depth}
                            isChecked={false}
                            isDragSelected={isSelected}
                            groupByDir={groupByDir}
                            onToggle={() => undefined}
                            onClick={() => onFileSelect(entry.file.path)}
                            onActivate={onFileActivate}
                            dataStashFile={entry.file.path}
                            isCurrent={isSelected}
                            contextMenuEnabled={false}
                            checkboxVisibility="hidden"
                        />
                    );
                }

                const isExpanded = expandedDirs.has(entry.path);
                return (
                    <React.Fragment key={entry.path}>
                        <FolderRow
                            name={entry.name}
                            dirPath={entry.path}
                            depth={depth}
                            isExpanded={isExpanded}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            fileCount={entry.descendantFiles.length}
                            isAllChecked={false}
                            isSomeChecked={false}
                            onToggleExpand={onToggleDir}
                            onToggleCheck={() => undefined}
                            checkboxVisibility="hidden"
                            interactive
                        />
                        {isExpanded ? (
                            <StashFileTree
                                entries={entry.children}
                                groupByDir={groupByDir}
                                selectedFilePath={selectedFilePath}
                                expandedDirs={expandedDirs}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                onToggleDir={onToggleDir}
                                onFileSelect={onFileSelect}
                                onFileActivate={onFileActivate}
                                depth={depth + 1}
                            />
                        ) : null}
                    </React.Fragment>
                );
            })}
        </>
    );
}
