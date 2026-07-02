// Recursive tree-entry renderer for the commit-panel file tree.
// Renders file rows and folder rows from a flat TreeEntry list. Stateless -
// all expansion and selection state is passed in as props from FileTree.

import React from "react";
import type { ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import type { TreeEntry } from "../types";
import { FileRow } from "./FileRow";
import { FolderRow } from "./FolderRow";

/** Props for stateless recursive file-tree row rendering. */
export interface TreeEntriesProps {
    entries: TreeEntry[];
    depth: number;
    groupByDir: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    expandedDirs: Set<string>;
    checkedPaths: Set<string>;
    dragSelectedPaths: Set<string>;
    onToggleFile: (path: string) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onToggleDir: (dirPath: string) => void;
    onFileClick: (event: React.MouseEvent<HTMLElement>, file: WorkingFile) => void;
    onFileDragStart?: (event: React.DragEvent<HTMLElement>, file: WorkingFile) => void;
    onFileDragEnd?: () => void;
    checkboxVisibility?: "visible" | "hidden";
}

/** Renders file and folder rows recursively from prepared tree entries. */
export function TreeEntries({
    entries,
    depth,
    groupByDir,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    expandedDirs,
    checkedPaths,
    dragSelectedPaths,
    onToggleFile,
    onToggleFolder,
    isAllChecked,
    isSomeChecked,
    onToggleDir,
    onFileClick,
    onFileDragStart,
    onFileDragEnd,
    checkboxVisibility = "visible",
}: TreeEntriesProps): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    return (
                        <FileRow
                            key={`${entry.file.path}:${entry.file.staged ? "staged" : "unstaged"}`}
                            file={entry.file}
                            depth={depth}
                            isChecked={checkedPaths.has(entry.file.path)}
                            isDragSelected={
                                entry.file.status === "?" && dragSelectedPaths.has(entry.file.path)
                            }
                            groupByDir={groupByDir}
                            onToggle={onToggleFile}
                            onClick={onFileClick}
                            draggable={entry.file.status === "?"}
                            onDragStart={onFileDragStart}
                            onDragEnd={onFileDragEnd}
                            checkboxVisibility={checkboxVisibility}
                        />
                    );
                }

                const isExpanded = expandedDirs.has(entry.path);
                const dirFiles = entry.descendantFiles;

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
                            fileCount={dirFiles.length}
                            isAllChecked={isAllChecked(dirFiles)}
                            isSomeChecked={isSomeChecked(dirFiles)}
                            onToggleExpand={onToggleDir}
                            onToggleCheck={() => onToggleFolder(dirFiles)}
                            checkboxVisibility={checkboxVisibility}
                        />
                        {isExpanded && (
                            <TreeEntries
                                entries={entry.children}
                                depth={depth + 1}
                                groupByDir={groupByDir}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                expandedDirs={expandedDirs}
                                checkedPaths={checkedPaths}
                                dragSelectedPaths={dragSelectedPaths}
                                onToggleFile={onToggleFile}
                                onToggleFolder={onToggleFolder}
                                isAllChecked={isAllChecked}
                                isSomeChecked={isSomeChecked}
                                onToggleDir={onToggleDir}
                                onFileClick={onFileClick}
                                onFileDragStart={onFileDragStart}
                                onFileDragEnd={onFileDragEnd}
                                checkboxVisibility={checkboxVisibility}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}
