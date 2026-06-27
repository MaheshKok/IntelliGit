// Shelf tab with selectable shelved entries, changed-file preview, and
// bottom Apply/Pop/Delete actions.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex, Button } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { ShelfStashList } from "./ShelfStashList";
import { ShelfToolbar } from "./ShelfToolbar";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { getSettings } from "../../shared/settings";
import { ContextMenu } from "../../shared/components/ContextMenu";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { TreeEntry } from "../types";
import { t } from "../../shared/i18n";

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

interface ExpansionOverride {
    selectedIndex: number | null;
    expandedIndex: number | null;
    isLoading: boolean;
}

interface ExpandedDirsState {
    tree: TreeEntry[];
    dirs: Set<string>;
}

/**
 * Renders stash/shelf entries and the selected shelf file preview.
 *
 * The tab sends shelf select/apply/pop/delete/diff messages to the extension,
 * keeps optimistic local expansion/loading state for clicked stash rows, and
 * renders the preview tree with the shared grouping preference, and owns
 * directory expansion, context menu, and drag-to-resize state.
 */
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
    const { hoverDelay, tooltipsEnabled, iconStyle } = getSettings();
    const tree = useFileTree(shelfFiles, groupByDir);
    const allDirPaths = useMemo(() => collectAllDirPaths(tree), [tree]);
    const [expandedDirsState, setExpandedDirsState] = useState<ExpandedDirsState>(() => ({
        tree,
        dirs: new Set(allDirPaths),
    }));
    const expandedDirs = useMemo(
        () => (expandedDirsState.tree === tree ? expandedDirsState.dirs : new Set(allDirPaths)),
        [allDirPaths, expandedDirsState, tree],
    );
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(
        null,
    );
    // expandedIndex tracks which stash entry the user has toggled open locally.
    // It is set optimistically on click (before files arrive from the extension host).
    // selectedIndex (prop) updates once the host responds with loaded files.
    // Collapsing only clears local state — no host message needed since no files to load.
    // Store the selectedIndex that produced the local override so parent-driven
    // changes (e.g. after apply/pop/delete removes the selected stash) evict stale
    // local expansion/loading state during render without a prop-sync effect.
    const [expansionOverride, setExpansionOverride] = useState<ExpansionOverride | null>(null);
    const hasCurrentExpansionOverride = expansionOverride?.selectedIndex === selectedIndex;
    const expandedIndex = hasCurrentExpansionOverride
        ? expansionOverride.expandedIndex
        : selectedIndex;
    const isLoading = hasCurrentExpansionOverride ? expansionOverride.isLoading : false;

    const setLocalExpansion = useCallback(
        (nextExpandedIndex: number | null, nextIsLoading: boolean) => {
            setExpansionOverride({
                selectedIndex,
                expandedIndex: nextExpandedIndex,
                isLoading: nextIsLoading,
            });
        },
        [selectedIndex],
    );

    const handleStashClick = useCallback(
        (index: number) => {
            if (expandedIndex === index) {
                setLocalExpansion(null, false);
            } else {
                setLocalExpansion(index, true);
                vscode.postMessage({ type: "shelfSelect", index });
            }
        },
        [expandedIndex, setLocalExpansion, vscode],
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

    const toggleDir = useCallback(
        (path: string) => {
            setExpandedDirsState((prev) => {
                const next = new Set(prev.tree === tree ? prev.dirs : allDirPaths);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return { tree, dirs: next };
            });
        },
        [allDirPaths, tree],
    );

    const expandAll = useCallback(() => {
        setExpandedDirsState({ tree, dirs: new Set(allDirPaths) });
    }, [allDirPaths, tree]);

    const collapseAll = useCallback(() => {
        setExpandedDirsState({ tree, dirs: new Set() });
    }, [tree]);

    const handleShowSelectedDiff = useCallback(() => {
        handleShelfAction(selectedIndex, "showDiff");
    }, [handleShelfAction, selectedIndex]);

    const handleShowShelfDiff = useCallback(
        (index: number, path: string) => {
            vscode.postMessage({ type: "showShelfDiff", index, path });
        },
        [vscode],
    );

    const handleStashContextMenu = useCallback(
        (event: React.MouseEvent, index: number) => {
            event.preventDefault();
            event.stopPropagation();
            if (expandedIndex !== index) {
                setLocalExpansion(index, true);
                vscode.postMessage({ type: "shelfSelect", index });
            }
            setContextMenu({ x: event.clientX, y: event.clientY, index });
        },
        [expandedIndex, setLocalExpansion, vscode],
    );

    const [fileTreeHeight, setFileTreeHeight] = useState(150);
    const fileTreeHeightRef = useRef(fileTreeHeight);
    useEffect(() => {
        fileTreeHeightRef.current = fileTreeHeight;
    }, [fileTreeHeight]);

    const dragCleanupRef = useRef<(() => void) | null>(null);

    const cleanupFileTreeDrag = useCallback(() => {
        dragCleanupRef.current?.();
    }, []);

    useEffect(() => cleanupFileTreeDrag, [cleanupFileTreeDrag]);

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
        <Flex
            direction="column"
            flex={1}
            overflow="hidden"
            bg="var(--intelligit-pycharm-panel)"
            color="var(--intelligit-pycharm-foreground)"
        >
            <ShelfToolbar
                selectedIndex={selectedIndex}
                shelfFilesLength={shelfFiles.length}
                groupByDir={groupByDir}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
                onShowSelectedDiff={handleShowSelectedDiff}
                onToggleGroupBy={onToggleGroupBy}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
            />

            <ShelfStashList
                stashes={stashes}
                shelfFiles={shelfFiles}
                selectedIndex={selectedIndex}
                expandedIndex={expandedIndex}
                isLoading={isLoading}
                tree={tree}
                expandedDirs={expandedDirs}
                folderIcon={folderIcon}
                folderExpandedIcon={folderExpandedIcon}
                folderIconsByName={folderIconsByName}
                fileTreeHeight={fileTreeHeight}
                iconStyle={iconStyle}
                onStashClick={handleStashClick}
                onStashContextMenu={handleStashContextMenu}
                onToggleDir={toggleDir}
                onShowShelfDiff={handleShowShelfDiff}
                onFileTreeDragStart={handleFileTreeDragStart}
            />

            <Flex
                align="center"
                gap="10px"
                px="30px"
                py="12px"
                borderTop="1px solid var(--intelligit-pycharm-border)"
                bg="var(--intelligit-pycharm-panel)"
            >
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "apply")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                >
                    {t("common.apply")}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "pop")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                >
                    {t("common.pop")}
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
                        { label: t("common.pop"), action: "pop" },
                        { label: t("common.apply"), action: "apply" },
                        { label: t("shelf.action.unstash"), action: "unstash", disabled: true },
                        { label: t("common.drop"), action: "drop" },
                        { label: t("common.clear"), action: "clear", disabled: true },
                        { label: "", action: "sep-1", separator: true },
                        {
                            label: t("common.showDiff"),
                            action: "showDiff",
                            disabled:
                                selectedIndex !== contextMenu.index || shelfFiles.length === 0,
                            hint: "⌘D",
                            icon: <DiffIcon />,
                        },
                        {
                            label: t("shelf.action.showDiffNewTab"),
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
