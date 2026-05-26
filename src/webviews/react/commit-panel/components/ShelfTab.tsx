// Shelf tab with selectable shelved entries, changed-file preview, and
// bottom Apply/Pop/Delete actions.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Flex, Box, Button, IconButton, Tooltip } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { FileTypeIcon } from "./FileTypeIcon";
import { TreeFolderIcon } from "./TreeIcons";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { getSettings } from "../../shared/settings";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { CollapseAllIconGlyph, ExpandAllIconGlyph } from "../../shared/components";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { TreeEntry } from "../types";
import { getLeafName, resolveFolderIcon } from "../../shared/utils";

interface Props {
    stashes: StashEntry[];
    shelfFiles: WorkingFile[];
    selectedIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    groupByDir: boolean;
    onToggleGroupBy: () => void;
}

type ShelfActionKind = "apply" | "pop" | "delete" | "showDiff";

export function ShelfTab({
    stashes,
    shelfFiles,
    selectedIndex,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    groupByDir,
    onToggleGroupBy,
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const { hoverDelay, tooltipsEnabled } = getSettings();
    const tree = useFileTree(shelfFiles, groupByDir);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(
        null,
    );
    // expandedIndex tracks which stash entry the user has toggled open locally.
    // It is set optimistically on click (before files arrive from the extension host).
    // selectedIndex (prop) updates once the host responds with loaded files.
    // Collapsing only clears local state — no host message needed since no files to load.
    // The useEffect below re-syncs expandedIndex from selectedIndex on parent-driven
    // changes (e.g. after apply/pop/delete removes the selected stash).
    const [expandedIndex, setExpandedIndex] = useState<number | null>(selectedIndex);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        setExpandedIndex(selectedIndex);
        setIsLoading(false);
    }, [selectedIndex]);

    const handleStashClick = useCallback(
        (index: number) => {
            if (expandedIndex === index) {
                setExpandedIndex(null);
                setIsLoading(false);
            } else {
                setExpandedIndex(index);
                setIsLoading(true);
                vscode.postMessage({ type: "shelfSelect", index });
            }
        },
        [expandedIndex, vscode],
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
                case "showDiff": {
                    const firstFile = selectedIndex === index ? shelfFiles[0]?.path : undefined;
                    if (firstFile) {
                        vscode.postMessage({ type: "showShelfDiff", index, path: firstFile });
                    }
                    return;
                }
                default: {
                    const exhaustive: never = kind;
                    throw new Error(`Unhandled shelf action: ${String(exhaustive)}`);
                }
            }
        },
        [selectedIndex, shelfFiles, vscode],
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

    const expandAll = useCallback(() => {
        setExpandedDirs(new Set(collectAllDirPaths(tree)));
    }, [tree]);

    const collapseAll = useCallback(() => {
        setExpandedDirs(new Set());
    }, []);

    const handleShowSelectedDiff = useCallback(() => {
        handleShelfAction(selectedIndex, "showDiff");
    }, [handleShelfAction, selectedIndex]);

    const handleStashContextMenu = useCallback(
        (event: React.MouseEvent, index: number) => {
            event.preventDefault();
            event.stopPropagation();
            if (expandedIndex !== index) {
                setExpandedIndex(index);
                setIsLoading(true);
                vscode.postMessage({ type: "shelfSelect", index });
            }
            setContextMenu({ x: event.clientX, y: event.clientY, index });
        },
        [expandedIndex, vscode],
    );

    const [fileTreeHeight, setFileTreeHeight] = useState(150);
    const fileTreeHeightRef = useRef(fileTreeHeight);
    useEffect(() => {
        fileTreeHeightRef.current = fileTreeHeight;
    }, [fileTreeHeight]);

    const dragCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        return () => {
            dragCleanupRef.current?.();
        };
    }, []);

    const handleFileTreeDragStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = fileTreeHeightRef.current;

        const onMouseMove = (ev: MouseEvent) => {
            const delta = ev.clientY - startY;
            setFileTreeHeight(Math.max(60, startH + delta));
        };
        const cleanup = () => {
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            dragCleanupRef.current = null;
        };
        const onMouseUp = () => {
            cleanup();
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
        dragCleanupRef.current = cleanup;
    }, []);

    return (
        <Flex direction="column" flex={1} overflow="hidden">
            <Flex
                align="center"
                minH="34px"
                px="8px"
                borderBottom="1px solid var(--vscode-panel-border, #444)"
                flexShrink={0}
            >
                <StashToolbarButton
                    label="Show Diff"
                    color="#ff736d"
                    onClick={handleShowSelectedDiff}
                    isDisabled={selectedIndex === null || shelfFiles.length === 0}
                    hoverDelay={hoverDelay}
                    tooltipsEnabled={tooltipsEnabled}
                >
                    <path
                        fill="currentColor"
                        d="M2.5 1.5h4v13h-4v-13zm7 0h4v13h-4v-13zM5.25 4.75 7.5 7 5.25 9.25l-.7-.7L5.6 7 4.55 5.45l.7-.7zm5.5 0 .7.7L10.4 7l1.05 1.55-.7.7L8.5 7l2.25-2.25z"
                    />
                </StashToolbarButton>
                <StashToolbarButton
                    label={groupByDir ? "Ungroup Files" : "Group by Directory"}
                    color="#b77dff"
                    onClick={onToggleGroupBy}
                    hoverDelay={hoverDelay}
                    tooltipsEnabled={tooltipsEnabled}
                >
                    <path
                        fill="currentColor"
                        d="M2 2h4v4H2V2zm8 0h4v4h-4V2zM2 10h4v4H2v-4zm8 0h4v4h-4v-4z"
                    />
                </StashToolbarButton>
                <Box flex={1} />
                <StashToolbarButton
                    label="Expand All"
                    color="#f3b1cf"
                    onClick={expandAll}
                    hoverDelay={hoverDelay}
                    tooltipsEnabled={tooltipsEnabled}
                >
                    <ExpandAllIconGlyph />
                </StashToolbarButton>
                <StashToolbarButton
                    label="Collapse All"
                    color="#f3b1cf"
                    onClick={collapseAll}
                    hoverDelay={hoverDelay}
                    tooltipsEnabled={tooltipsEnabled}
                >
                    <CollapseAllIconGlyph />
                </StashToolbarButton>
            </Flex>

            <Box flex="1 1 auto" overflowY="auto" pt="1px" bg="#343D4D">
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
                                            ? "var(--vscode-list-activeSelectionBackground, #53627a)"
                                            : "transparent"
                                    }
                                    color={
                                        isExpanded
                                            ? "var(--vscode-list-activeSelectionForeground)"
                                            : "var(--vscode-foreground)"
                                    }
                                    _hover={{
                                        bg: isExpanded
                                            ? "var(--vscode-list-activeSelectionBackground)"
                                            : "var(--vscode-list-hoverBackground)",
                                    }}
                                    onClick={() => handleStashClick(stash.index)}
                                    onContextMenu={(event) =>
                                        handleStashContextMenu(event, stash.index)
                                    }
                                    title={stash.message}
                                    borderRadius={isExpanded ? "6px" : 0}
                                    mx="8px"
                                    my="1px"
                                >
                                    <Box
                                        as="span"
                                        w="14px"
                                        textAlign="center"
                                        fontSize="10px"
                                        opacity={0.7}
                                        flexShrink={0}
                                        transform={isExpanded ? "rotate(90deg)" : undefined}
                                        transition="transform 0.15s"
                                    >
                                        &#9654;
                                    </Box>
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
                                            color="#C8CDD7"
                                            px="7px"
                                            py="1px"
                                            borderRadius="5px"
                                            bg="rgba(130, 150, 184, 0.28)"
                                            flexShrink={0}
                                        >
                                            <Box
                                                as="svg"
                                                w="12px"
                                                h="12px"
                                                viewBox="0 0 16 16"
                                                opacity={0.95}
                                                color="#35D46A"
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
                                        color="var(--vscode-descriptionForeground)"
                                    >
                                        Loading...
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
                                                    onToggleDir={toggleDir}
                                                    onFileClick={(path) =>
                                                        vscode.postMessage({
                                                            type: "showShelfDiff",
                                                            index: stash.index,
                                                            path,
                                                        })
                                                    }
                                                    depth={1}
                                                />
                                            ) : (
                                                <Box
                                                    pl="28px"
                                                    py="2px"
                                                    fontSize="12px"
                                                    color="var(--vscode-descriptionForeground)"
                                                >
                                                    No files in this shelved change.
                                                </Box>
                                            )}
                                        </Box>
                                        <Box
                                            h="4px"
                                            flexShrink={0}
                                            cursor="row-resize"
                                            bg="var(--vscode-panel-border)"
                                            onMouseDown={handleFileTreeDragStart}
                                            _hover={{
                                                bg: "var(--vscode-focusBorder, #007acc)",
                                            }}
                                        />
                                    </>
                                )}
                            </React.Fragment>
                        );
                    })
                )}
            </Box>

            <Flex
                align="center"
                gap="10px"
                px="30px"
                py="12px"
                borderTop="1px solid rgba(72, 82, 101, 0.9)"
                bg="#343D4D"
            >
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "apply")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="32px"
                    minW="144px"
                    px="12px"
                    bg="#4B566B"
                    borderColor="#566176"
                    borderRadius="2px"
                    _hover={{ bg: "#566176" }}
                >
                    Apply
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "pop")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="32px"
                    minW="144px"
                    px="12px"
                    bg="#4B566B"
                    borderColor="#566176"
                    borderRadius="2px"
                    _hover={{ bg: "#566176" }}
                >
                    Pop
                </Button>
            </Flex>
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    minWidth={300}
                    onClose={() => setContextMenu(null)}
                    onSelect={(action) => {
                        if (action === "apply") handleShelfAction(contextMenu.index, "apply");
                        if (action === "pop") handleShelfAction(contextMenu.index, "pop");
                        if (action === "drop") handleShelfAction(contextMenu.index, "delete");
                        if (action === "showDiff") handleShelfAction(contextMenu.index, "showDiff");
                    }}
                    items={[
                        { label: "Pop", action: "pop" },
                        { label: "Apply", action: "apply" },
                        { label: "Unstash...", action: "unstash", disabled: true },
                        { label: "Drop", action: "drop" },
                        { label: "Clear", action: "clear", disabled: true },
                        { label: "", action: "sep-1", separator: true },
                        {
                            label: "Show Diff",
                            action: "showDiff",
                            disabled:
                                selectedIndex !== contextMenu.index || shelfFiles.length === 0,
                            hint: "⌘D",
                            icon: <DiffIcon />,
                        },
                        {
                            label: "Show Diff in a New Tab",
                            action: "showDiffNewTab",
                            disabled: true,
                            icon: <DiffIcon />,
                        },
                    ]}
                />
            )}
        </Flex>
    );
}

function StashToolbarButton({
    label,
    color,
    onClick,
    isDisabled,
    hoverDelay,
    tooltipsEnabled,
    children,
}: {
    label: string;
    color: string;
    onClick: () => void;
    isDisabled?: boolean;
    hoverDelay: number;
    tooltipsEnabled: boolean;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <Tooltip label={label} fontSize="11px" openDelay={hoverDelay} isDisabled={!tooltipsEnabled}>
            <IconButton
                aria-label={label}
                icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" style={{ color }}>
                        {children}
                    </svg>
                }
                variant="toolbarGhost"
                size="sm"
                minW="26px"
                h="26px"
                onClick={onClick}
                isDisabled={isDisabled}
            />
        </Tooltip>
    );
}

function DiffIcon(): React.ReactElement {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M2.5 1.5h4v13h-4v-13zm7 0h4v13h-4v-13zM5.25 4.75 7.5 7 5.25 9.25l-.7-.7L5.6 7 4.55 5.45l.7-.7zm5.5 0 .7.7L10.4 7l1.05 1.55-.7.7L8.5 7l2.25-2.25z"
            />
        </svg>
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
