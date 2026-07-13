// Stash tab with selectable stashed entries, changed-file preview, and
// bottom Apply/Pop/Delete actions.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex, Button } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { StashList } from "./StashList";
import { StashToolbar } from "./StashToolbar";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { getSettings, resolveIconColor } from "../../shared/settings";
import { ContextMenu } from "../../shared/components/ContextMenu";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { TreeEntry } from "../types";
import { t } from "../../shared/i18n";

interface Props {
    repositoryRoot?: string;
    stashes: StashEntry[];
    stashFiles: WorkingFile[];
    selectedIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    groupByDir: boolean;
    onToggleGroupBy: () => void;
}

type StashActionKind = "apply" | "pop" | "delete" | "showDiff";

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
 * Renders stash entries and the selected stash file preview.
 *
 * The tab sends stash select/apply/pop/delete/diff messages to the extension,
 * keeps optimistic local expansion/loading state for clicked stash rows, and
 * renders the preview tree with the shared grouping preference, and owns
 * directory expansion, context menu, and drag-to-resize state.
 */
// react-doctor-disable-next-line react-doctor/no-giant-component
export function StashTab({
    repositoryRoot,
    stashes,
    stashFiles,
    selectedIndex,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    groupByDir,
    onToggleGroupBy,
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const { hoverDelay, tooltipsEnabled, iconStyle } = getSettings();
    const tree = useFileTree(stashFiles, groupByDir);
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
                vscode.postMessage({
                    type: "stashSelect",
                    ...(repositoryRoot ? { repositoryRoot } : {}),
                    index,
                });
            }
        },
        [expandedIndex, repositoryRoot, setLocalExpansion, vscode],
    );

    const handleStashAction = useCallback(
        (index: number | null, kind: StashActionKind) => {
            if (index === null) return;
            switch (kind) {
                case "apply":
                    vscode.postMessage({
                        type: "stashApply",
                        ...(repositoryRoot ? { repositoryRoot } : {}),
                        index,
                    });
                    return;
                case "pop":
                    vscode.postMessage({
                        type: "stashPop",
                        ...(repositoryRoot ? { repositoryRoot } : {}),
                        index,
                    });
                    return;
                case "delete":
                    vscode.postMessage({
                        type: "stashDelete",
                        ...(repositoryRoot ? { repositoryRoot } : {}),
                        index,
                    });
                    return;
                case "showDiff": {
                    const firstFile = selectedIndex === index ? stashFiles[0]?.path : undefined;
                    if (firstFile) {
                        vscode.postMessage({
                            type: "showStashDiff",
                            ...(repositoryRoot ? { repositoryRoot } : {}),
                            index,
                            path: firstFile,
                        });
                    }
                    return;
                }
                default: {
                    const exhaustive: never = kind;
                    throw new Error(`Unhandled stash action: ${String(exhaustive)}`);
                }
            }
        },
        [repositoryRoot, selectedIndex, stashFiles, vscode],
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
        handleStashAction(selectedIndex, "showDiff");
    }, [handleStashAction, selectedIndex]);

    const handleShowStashDiff = useCallback(
        (index: number, path: string) => {
            vscode.postMessage({
                type: "showStashDiff",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                index,
                path,
            });
        },
        [repositoryRoot, vscode],
    );

    const handleStashContextMenu = useCallback(
        (event: React.MouseEvent, index: number) => {
            event.preventDefault();
            event.stopPropagation();
            if (expandedIndex !== index) {
                setLocalExpansion(index, true);
                vscode.postMessage({
                    type: "stashSelect",
                    ...(repositoryRoot ? { repositoryRoot } : {}),
                    index,
                });
            }
            setContextMenu({ x: event.clientX, y: event.clientY, index });
        },
        [expandedIndex, repositoryRoot, setLocalExpansion, vscode],
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
            <StashToolbar
                selectedIndex={selectedIndex}
                stashFilesLength={stashFiles.length}
                groupByDir={groupByDir}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
                onShowSelectedDiff={handleShowSelectedDiff}
                onToggleGroupBy={onToggleGroupBy}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
            />

            <StashList
                stashes={stashes}
                stashFiles={stashFiles}
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
                onShowStashDiff={handleShowStashDiff}
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
                    onClick={() => handleStashAction(selectedIndex, "apply")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                >
                    {t("common.apply")}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleStashAction(selectedIndex, "pop")}
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
                        if (action === "apply") handleStashAction(contextMenu.index, "apply");
                        if (action === "pop") handleStashAction(contextMenu.index, "pop");
                        if (action === "drop") handleStashAction(contextMenu.index, "delete");
                        if (action === "showDiff") handleStashAction(contextMenu.index, "showDiff");
                    }}
                    items={[
                        { label: t("common.pop"), action: "pop" },
                        { label: t("common.apply"), action: "apply" },
                        { label: t("stash.action.unstash"), action: "unstash", disabled: true },
                        { label: t("common.drop"), action: "drop" },
                        { label: t("common.clear"), action: "clear", disabled: true },
                        { label: "", action: "sep-1", separator: true },
                        {
                            label: t("common.showDiff"),
                            action: "showDiff",
                            disabled:
                                selectedIndex !== contextMenu.index || stashFiles.length === 0,
                            hint: "⌘D",
                            icon: <DiffIcon />,
                        },
                        {
                            label: t("stash.action.showDiffNewTab"),
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
    const color = resolveIconColor(
        "#8fd5ff",
        "var(--vscode-menu-foreground, var(--vscode-icon-foreground))",
    );

    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden style={{ color }}>
            <path
                fill="currentColor"
                d="M2.5 1.5h4v13h-4v-13zm7 0h4v13h-4v-13zM5.25 4.75 7.5 7 5.25 9.25l-.7-.7L5.6 7 4.55 5.45l.7-.7zm5.5 0 .7.7L10.4 7l1.05 1.55-.7.7L8.5 7l2.25-2.25z"
            />
        </svg>
    );
}
