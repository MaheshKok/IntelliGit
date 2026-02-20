// Shelf tab with selectable shelved entries, changed-file preview, and
// bottom Apply/Pop/Delete actions.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Flex, Box, Button } from "@chakra-ui/react";
import { FileTypeIcon } from "./FileTypeIcon";
import { TreeFolderIcon } from "./TreeIcons";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { TreeEntry } from "../types";
import { resolveFolderIcon } from "../../shared/utils";

interface Props {
    stashes: StashEntry[];
    shelfFiles: WorkingFile[];
    selectedIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
}

type ShelfActionKind = "apply" | "pop" | "delete";

export function ShelfTab({
    stashes,
    shelfFiles,
    selectedIndex,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const tree = useFileTree(shelfFiles, true);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

    const handleSelect = useCallback(
        (index: number) => {
            vscode.postMessage({ type: "shelfSelect", index });
        },
        [vscode],
    );

    const handleShelfAction = useCallback(
        (index: number | null, kind: ShelfActionKind) => {
            if (index === null) return;
            switch (kind) {
                case "apply":
                    vscode.postMessage({ type: "shelfApply", index });
                    return;
                case "pop":
                    vscode.postMessage({ type: "shelfPop", index });
                    return;
                case "delete":
                    vscode.postMessage({ type: "shelfDelete", index });
                    return;
                default: {
                    const exhaustive: never = kind;
                    throw new Error(`Unhandled shelf action: ${String(exhaustive)}`);
                }
            }
        },
        [vscode],
    );

    const toggleDir = useCallback((path: string) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    useEffect(() => {
        setExpandedDirs(new Set(collectAllDirPaths(tree)));
    }, [tree]);

    const selectedEntry = useMemo(
        () => stashes.find((entry) => entry.index === selectedIndex) ?? null,
        [stashes, selectedIndex],
    );

    return (
        <Flex direction="column" flex={1} overflow="hidden">
            <Box
                flexShrink={0}
                maxH="100px"
                overflowY="auto"
                borderBottom="1px solid var(--vscode-panel-border)"
                pt="1px"
            >
                {stashes.length === 0 ? (
                    <Box
                        color="var(--vscode-descriptionForeground)"
                        fontSize="12px"
                        p="12px"
                        textAlign="center"
                    >
                        No shelved changes
                    </Box>
                ) : (
                    stashes.map((stash) => {
                        const parsed = parseShelfMessage(stash.message);
                        const isSelected = selectedIndex === stash.index;
                        return (
                            <Flex
                                key={stash.index}
                                align="center"
                                px="9px"
                                py="2px"
                                minH="24px"
                                fontSize="12px"
                                fontFamily="var(--vscode-font-family)"
                                cursor="pointer"
                                bg={
                                    isSelected
                                        ? "var(--vscode-list-activeSelectionBackground)"
                                        : "transparent"
                                }
                                color={
                                    isSelected
                                        ? "var(--vscode-list-activeSelectionForeground)"
                                        : "var(--vscode-foreground)"
                                }
                                _hover={{
                                    bg: isSelected
                                        ? "var(--vscode-list-activeSelectionBackground)"
                                        : "var(--vscode-list-hoverBackground)",
                                }}
                                onClick={() => handleSelect(stash.index)}
                                title={stash.message}
                            >
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
                                        fontSize="10.5px"
                                        gap="4px"
                                        color="#d8ca64"
                                        flexShrink={0}
                                    >
                                        <Box
                                            as="svg"
                                            w="12px"
                                            h="12px"
                                            viewBox="0 0 16 16"
                                            opacity={0.95}
                                        >
                                            <path
                                                fill="currentColor"
                                                d="M9.28 1.5H5.5A2.5 2.5 0 0 0 3 4v8a2.5 2.5 0 0 0 2.5 2.5h3.78a1.5 1.5 0 0 0 1.06-.44l3.72-3.72a1.5 1.5 0 0 0 0-2.12L10.34 1.94a1.5 1.5 0 0 0-1.06-.44zM5.5 3h3.78l3.72 3.72-3.72 3.72H5.5A1 1 0 0 1 4.5 9.44V4A1 1 0 0 1 5.5 3zm1.25 2a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
                                            />
                                        </Box>
                                        {parsed.branch}
                                    </Box>
                                )}
                            </Flex>
                        );
                    })
                )}
            </Box>

            <Box flex="1 1 auto" overflowY="auto">
                {selectedEntry ? (
                    shelfFiles.length > 0 ? (
                        <ShelfFileTree
                            entries={tree}
                            expandedDirs={expandedDirs}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            onToggleDir={toggleDir}
                            onFileClick={(path) =>
                                vscode.postMessage({
                                    type: "showShelfDiff",
                                    index: selectedEntry.index,
                                    path,
                                })
                            }
                        />
                    ) : (
                        <Box p="10px" fontSize="12px" color="var(--vscode-descriptionForeground)">
                            No files in this shelved change.
                        </Box>
                    )
                ) : (
                    <Box p="10px" fontSize="12px" color="var(--vscode-descriptionForeground)">
                        Select a shelved change.
                    </Box>
                )}
            </Box>

            <Flex
                align="center"
                gap="8px"
                px="8px"
                py="8px"
                borderTop="1px solid var(--vscode-panel-border)"
            >
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "apply")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="28px"
                    minW="86px"
                    px="12px"
                    bg="rgba(255,255,255,0.07)"
                    borderColor="rgba(184, 194, 214, 0.5)"
                >
                    Apply
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "pop")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="28px"
                    minW="68px"
                    px="12px"
                    bg="rgba(255,255,255,0.07)"
                    borderColor="rgba(184, 194, 214, 0.5)"
                >
                    Pop
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "delete")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="28px"
                    minW="78px"
                    px="12px"
                    bg="rgba(255,255,255,0.07)"
                    borderColor="rgba(184, 194, 214, 0.5)"
                >
                    Delete
                </Button>
            </Flex>
        </Flex>
    );
}

function parseShelfMessage(message: string): { title: string; branch: string | null } {
    const trimmed = message.trim();
    const match = trimmed.match(/^On\s+([^:]+):\s*(.*)$/i);
    if (!match) return { title: trimmed || "Shelved changes", branch: null };
    return {
        title: match[2]?.trim() || "Shelved changes",
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
                    const fileName = entry.file.path.split("/").pop() ?? entry.file.path;
                    return (
                        <Flex
                            key={entry.file.path}
                            align="center"
                            pl={`${10 + depth * 16}px`}
                            pr="8px"
                            minH="20px"
                            gap="4px"
                            fontSize="12px"
                            fontFamily="var(--vscode-font-family)"
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
                            fontFamily="var(--vscode-font-family)"
                            cursor="pointer"
                            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                            onClick={() => onToggleDir(entry.path)}
                        >
                            <Box
                                as="span"
                                w="11px"
                                textAlign="center"
                                opacity={0.7}
                                transform={isExpanded ? "rotate(90deg)" : undefined}
                            >
                                &#9654;
                            </Box>
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
                                {fileCount} {fileCount === 1 ? "file" : "files"}
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
