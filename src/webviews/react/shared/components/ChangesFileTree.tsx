import React, { useCallback, useMemo } from "react";
import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { buildFileTree, type TreeEntry } from "../fileTree";
import { ENTRY_ROW_GUIDE_LEFT, FileTreeRows, type TreeRowFile } from "./FileTreeRows";

/** Caller-owned identity, actions, and presentation for a generic changes tree. */
export interface ChangesFileTreeProps<F extends TreeRowFile> {
    files: F[];
    groupByDir: boolean;
    depth: number;
    selectedId: string | null;
    getId: (file: F) => string;
    isDirectoryCollapsed: (path: string) => boolean;
    onToggleDirectory: (path: string) => void;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onSelect: (file: F) => void;
    onActivate?: (file: F) => void;
    onContextMenu?: (file: F, x: number, y: number, returnFocusTarget: HTMLElement) => void;
    onDragStart?: (event: React.DragEvent<HTMLElement>, file: F) => void;
    dataAttributes: (file: F) => Record<string, string> | undefined;
    emptyState?: React.ReactNode;
}

/** Generic changes-tree adapter; callers own domain identity, actions, and empty UI. */
export function ChangesFileTree<F extends TreeRowFile>({
    files,
    groupByDir,
    depth,
    selectedId,
    getId,
    isDirectoryCollapsed,
    onToggleDirectory,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onSelect,
    onActivate,
    onContextMenu,
    onDragStart,
    dataAttributes,
    emptyState,
}: ChangesFileTreeProps<F>): React.ReactNode {
    const tree = useMemo<TreeEntry<F>[]>(
        () =>
            groupByDir
                ? buildFileTree(files)
                : files.map((file) => ({ type: "file" as const, file })),
        [files, groupByDir],
    );
    const isDirectoryExpanded = useCallback(
        (path: string): boolean => !isDirectoryCollapsed(path),
        [isDirectoryCollapsed],
    );
    const fileWiring = useCallback(
        (file: F) => ({
            isSelected: selectedId === getId(file),
            onSelect: () => onSelect(file),
            onActivate: onActivate ? () => onActivate(file) : undefined,
            onContextMenu: onContextMenu
                ? (x: number, y: number, returnFocusTarget: HTMLElement) =>
                      onContextMenu(file, x, y, returnFocusTarget)
                : undefined,
            dataAttributes: dataAttributes(file),
            draggable: Boolean(onDragStart),
            onDragStart: onDragStart
                ? (event: React.DragEvent<HTMLElement>) => onDragStart(event, file)
                : undefined,
        }),
        [selectedId, getId, onSelect, onActivate, onContextMenu, dataAttributes, onDragStart],
    );

    if (files.length === 0) return <>{emptyState}</>;

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
            isDirectoryExpanded={isDirectoryExpanded}
            onToggleDirectory={onToggleDirectory}
            fileWiring={fileWiring}
        />
    );
}
