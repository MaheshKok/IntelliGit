// Main file tree component for the commit panel. Renders tracked, unversioned,
// and optionally ignored files as collapsible sections with directory grouping.

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Box } from "@chakra-ui/react";
import { SectionHeader } from "./SectionHeader";
import { TreeEntries } from "./FileTreeEntries";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import { useFileDrag } from "../hooks/useFileDrag";
import type { ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { t } from "../../shared/i18n";
import type { TreeEntry } from "../types";

interface Props {
    files: WorkingFile[];
    groupByDir: boolean;
    showIgnoredFiles: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    checkedPaths: Set<string>;
    onToggleFile: (path: string) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    onToggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onFileClick: (path: string) => void;
    onTrackUnversionedFiles?: (paths: string[]) => void;
    expandAllSignal: number;
    collapseAllSignal: number;
}

interface FileTreeExpansionState {
    changesOpen: boolean;
    unversionedOpen: boolean;
    ignoredOpen: boolean;
    expandedDirs: Set<string>;
}

interface FileBuckets {
    tracked: WorkingFile[];
    unversioned: WorkingFile[];
    ignored: WorkingFile[];
}

interface TreeRenderOptions {
    groupByDir: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
}

interface FileSectionProps {
    label: string;
    count: number;
    stats?: { additions: number; deletions: number };
    files: WorkingFile[];
    entries: TreeEntry[];
    isOpen: boolean;
    isDragOver?: boolean;
    treeOptions: TreeRenderOptions;
    expandedDirs: Set<string>;
    checkedPaths: Set<string>;
    dragSelectedPaths: Set<string>;
    onToggleOpen: () => void;
    onToggleCheck: () => void;
    onToggleFile: (path: string) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    getAllChecked: (files: WorkingFile[]) => boolean;
    getSomeChecked: (files: WorkingFile[]) => boolean;
    onToggleDir: (dirPath: string) => void;
    onFileClick: (event: React.MouseEvent<HTMLElement>, file: WorkingFile) => void;
    onFileDragStart?: (event: React.DragEvent<HTMLElement>, file: WorkingFile) => void;
    onFileDragEnd?: () => void;
    checkboxVisibility?: "visible" | "hidden";
}

function splitVisibleFiles(files: WorkingFile[], showIgnoredFiles: boolean): FileBuckets {
    const tracked: WorkingFile[] = [];
    const unversioned: WorkingFile[] = [];
    const ignored: WorkingFile[] = [];

    for (const file of files) {
        if (file.status === "?") {
            unversioned.push(file);
        } else if (file.status === "!") {
            if (showIgnoredFiles) ignored.push(file);
        } else {
            tracked.push(file);
        }
    }

    return { tracked, unversioned, ignored };
}

function countUniquePaths(files: WorkingFile[]): number {
    const paths = new Set<string>();
    for (const file of files) paths.add(file.path);
    return paths.size;
}

function sumStats(
    files: WorkingFile[],
    includeDeletions: boolean,
): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
        additions += file.additions;
        if (includeDeletions) deletions += file.deletions;
    }
    return { additions, deletions };
}

function FileSection({
    label,
    count,
    stats,
    files,
    entries,
    isOpen,
    isDragOver,
    treeOptions,
    expandedDirs,
    checkedPaths,
    dragSelectedPaths,
    onToggleOpen,
    onToggleCheck,
    onToggleFile,
    onToggleFolder,
    getAllChecked,
    getSomeChecked,
    onToggleDir,
    onFileClick,
    onFileDragStart,
    onFileDragEnd,
    checkboxVisibility = "visible",
}: FileSectionProps): React.ReactElement {
    return (
        <>
            <SectionHeader
                label={label}
                count={count}
                stats={stats}
                isOpen={isOpen}
                isAllChecked={getAllChecked(files)}
                isSomeChecked={getSomeChecked(files)}
                onToggleOpen={onToggleOpen}
                onToggleCheck={onToggleCheck}
                isDragOver={isDragOver}
                checkboxVisibility={checkboxVisibility}
            />
            {isOpen && (
                <TreeEntries
                    entries={entries}
                    depth={0}
                    groupByDir={treeOptions.groupByDir}
                    folderIcon={treeOptions.folderIcon}
                    folderExpandedIcon={treeOptions.folderExpandedIcon}
                    folderIconsByName={treeOptions.folderIconsByName}
                    expandedDirs={expandedDirs}
                    checkedPaths={checkedPaths}
                    dragSelectedPaths={dragSelectedPaths}
                    onToggleFile={onToggleFile}
                    onToggleFolder={onToggleFolder}
                    isAllChecked={getAllChecked}
                    isSomeChecked={getSomeChecked}
                    onToggleDir={onToggleDir}
                    onFileClick={onFileClick}
                    onFileDragStart={onFileDragStart}
                    onFileDragEnd={onFileDragEnd}
                    checkboxVisibility={checkboxVisibility}
                />
            )}
        </>
    );
}

/**
 * Renders tracked, unversioned, and optionally ignored working-tree files with directory grouping.
 *
 * The tree owns only UI expansion state. Selection and diff requests are routed
 * through callbacks so the parent can keep checked paths stable across refreshes
 * and send host messages for file opens.
 */
export function FileTree({
    files,
    groupByDir,
    showIgnoredFiles,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    onToggleSection,
    isAllChecked,
    isSomeChecked,
    onFileClick,
    onTrackUnversionedFiles,
    expandAllSignal,
    collapseAllSignal,
}: Props): React.ReactElement {
    const [expansion, setExpansion] = useState<FileTreeExpansionState>(() => ({
        changesOpen: true,
        unversionedOpen: true,
        ignoredOpen: true,
        expandedDirs: new Set(),
    }));
    // react-doctor-disable-next-line react-doctor/no-event-handler
    const { changesOpen, unversionedOpen, ignoredOpen, expandedDirs } = expansion;
    const lastExpandSignal = useRef(0);
    const lastCollapseSignal = useRef(0);
    // Small local set tracks first-seen directories without altering effect dependencies.
    // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init
    const seenDirsRef = useRef<Set<string>>(new Set());

    const { tracked, unversioned, ignored } = useMemo(
        // react-doctor-disable-next-line react-doctor/no-event-handler
        () => splitVisibleFiles(files, showIgnoredFiles),
        [files, showIgnoredFiles],
    );
    const trackedUniqueCount = useMemo(() => countUniquePaths(tracked), [tracked]);
    const unversionedUniqueCount = useMemo(() => countUniquePaths(unversioned), [unversioned]);
    const ignoredUniqueCount = useMemo(() => countUniquePaths(ignored), [ignored]);
    const trackedStats = useMemo(() => sumStats(tracked, true), [tracked]);
    const unversionedStats = useMemo(() => sumStats(unversioned, false), [unversioned]);

    // react-doctor-disable-next-line react-doctor/no-event-handler
    const trackedTree = useFileTree(tracked, groupByDir);
    const unversionedTree = useFileTree(unversioned, groupByDir);
    const ignoredTree = useFileTree(ignored, groupByDir);
    const allDirPaths = useMemo(
        () => [
            ...collectAllDirPaths(trackedTree),
            ...collectAllDirPaths(unversionedTree),
            ...collectAllDirPaths(ignoredTree),
        ],
        [ignoredTree, trackedTree, unversionedTree],
    );
    const treeOptions = useMemo(
        () => ({ groupByDir, folderIcon, folderExpandedIcon, folderIconsByName }),
        [folderExpandedIcon, folderIcon, folderIconsByName, groupByDir],
    );
    const {
        visibleDragSelectedUnversionedPaths,
        isDragOverChanges,
        handleTreeFileClick,
        handleFileDragStart,
        handleFileDragEnd,
        handleChangesDragEnter,
        handleChangesDragOver,
        handleChangesDragLeave,
        handleChangesDrop,
    } = useFileDrag({ unversioned, onFileClick, onTrackUnversionedFiles });

    const toggleDir = useCallback((dirPath: string) => {
        setExpansion((prev) => {
            const next = new Set(prev.expandedDirs);
            if (next.has(dirPath)) next.delete(dirPath);
            else next.add(dirPath);
            return { ...prev, expandedDirs: next };
        });
    }, []);

    useEffect(() => {
        const newAutoExpandedDirs =
            changesOpen || unversionedOpen || ignoredOpen
                ? allDirPaths.filter((dirPath) => !seenDirsRef.current.has(dirPath))
                : [];
        // react-doctor-disable-next-line react-doctor/no-event-handler
        const expandSignalChanged = expandAllSignal !== lastExpandSignal.current;
        // react-doctor-disable-next-line react-doctor/no-event-handler
        const collapseSignalChanged = collapseAllSignal !== lastCollapseSignal.current;
        // react-doctor-disable-next-line react-doctor/no-event-handler
        const shouldExpandAll = expandAllSignal !== 0 && expandSignalChanged;
        // react-doctor-disable-next-line react-doctor/no-event-handler
        const shouldCollapseAll = collapseAllSignal !== 0 && collapseSignalChanged;
        if (newAutoExpandedDirs.length === 0 && !shouldExpandAll && !shouldCollapseAll) return;

        // Expansion signals come from parent toolbar events and must reconcile after render commit.
        // react-doctor-disable-next-line react-doctor/no-derived-state
        setExpansion((prev) => {
            let nextExpansion = prev;
            if (newAutoExpandedDirs.length > 0) {
                const nextExpandedDirs = new Set(nextExpansion.expandedDirs);
                for (const dirPath of newAutoExpandedDirs) {
                    seenDirsRef.current.add(dirPath);
                    nextExpandedDirs.add(dirPath);
                }
                nextExpansion = { ...nextExpansion, expandedDirs: nextExpandedDirs };
            }
            if (shouldExpandAll) {
                lastExpandSignal.current = expandAllSignal;
                for (const dir of allDirPaths) {
                    seenDirsRef.current.add(dir);
                }
                nextExpansion = {
                    ...nextExpansion,
                    changesOpen: true,
                    unversionedOpen: true,
                    ignoredOpen: true,
                    expandedDirs: new Set(allDirPaths),
                };
            }
            if (shouldCollapseAll) {
                lastCollapseSignal.current = collapseAllSignal;
                nextExpansion = {
                    ...nextExpansion,
                    changesOpen: false,
                    unversionedOpen: false,
                    ignoredOpen: false,
                    expandedDirs: new Set(),
                };
            }
            return nextExpansion;
        });
    }, [
        allDirPaths,
        changesOpen,
        collapseAllSignal,
        expandAllSignal,
        ignoredOpen,
        unversionedOpen,
    ]);

    if (tracked.length + unversioned.length + ignored.length === 0) {
        return (
            <Box
                color="var(--intelligit-pycharm-muted)"
                fontSize="12px"
                p="8px 12px"
                textAlign="center"
            >
                {t("commitPanel.noChanges")}
            </Box>
        );
    }

    return (
        <>
            {(tracked.length > 0 || unversioned.length > 0) && (
                <Box
                    onDragEnter={handleChangesDragEnter}
                    onDragOver={handleChangesDragOver}
                    onDragLeave={handleChangesDragLeave}
                    onDrop={handleChangesDrop}
                >
                    <FileSection
                        label={t("commitPanel.changes")}
                        count={trackedUniqueCount}
                        stats={trackedStats}
                        files={tracked}
                        entries={trackedTree}
                        isOpen={changesOpen}
                        onToggleOpen={() =>
                            setExpansion((prev) => ({ ...prev, changesOpen: !prev.changesOpen }))
                        }
                        onToggleCheck={() => onToggleSection(tracked)}
                        isDragOver={isDragOverChanges}
                        treeOptions={treeOptions}
                        expandedDirs={expandedDirs}
                        checkedPaths={checkedPaths}
                        dragSelectedPaths={visibleDragSelectedUnversionedPaths}
                        onToggleFile={onToggleFile}
                        onToggleFolder={onToggleFolder}
                        getAllChecked={isAllChecked}
                        getSomeChecked={isSomeChecked}
                        onToggleDir={toggleDir}
                        onFileClick={handleTreeFileClick}
                        onFileDragStart={handleFileDragStart}
                        onFileDragEnd={handleFileDragEnd}
                    />
                </Box>
            )}
            {unversioned.length > 0 && (
                <FileSection
                    label={t("commitPanel.unversionedFiles")}
                    count={unversionedUniqueCount}
                    stats={unversionedStats}
                    files={unversioned}
                    entries={unversionedTree}
                    isOpen={unversionedOpen}
                    onToggleOpen={() =>
                        setExpansion((prev) => ({
                            ...prev,
                            unversionedOpen: !prev.unversionedOpen,
                        }))
                    }
                    onToggleCheck={() => onToggleSection(unversioned)}
                    treeOptions={treeOptions}
                    expandedDirs={expandedDirs}
                    checkedPaths={checkedPaths}
                    dragSelectedPaths={visibleDragSelectedUnversionedPaths}
                    onToggleFile={onToggleFile}
                    onToggleFolder={onToggleFolder}
                    getAllChecked={isAllChecked}
                    getSomeChecked={isSomeChecked}
                    onToggleDir={toggleDir}
                    onFileClick={handleTreeFileClick}
                    onFileDragStart={handleFileDragStart}
                    onFileDragEnd={handleFileDragEnd}
                />
            )}
            {ignored.length > 0 && (
                <FileSection
                    label={t("commitPanel.ignoredFiles")}
                    count={ignoredUniqueCount}
                    files={ignored}
                    entries={ignoredTree}
                    isOpen={ignoredOpen}
                    onToggleOpen={() =>
                        setExpansion((prev) => ({
                            ...prev,
                            ignoredOpen: !prev.ignoredOpen,
                        }))
                    }
                    onToggleCheck={() => onToggleSection(ignored)}
                    treeOptions={treeOptions}
                    expandedDirs={expandedDirs}
                    checkedPaths={checkedPaths}
                    dragSelectedPaths={visibleDragSelectedUnversionedPaths}
                    onToggleFile={onToggleFile}
                    onToggleFolder={onToggleFolder}
                    getAllChecked={isAllChecked}
                    getSomeChecked={isSomeChecked}
                    onToggleDir={toggleDir}
                    onFileClick={handleTreeFileClick}
                    onFileDragStart={handleFileDragStart}
                    onFileDragEnd={handleFileDragEnd}
                    checkboxVisibility="hidden"
                />
            )}
        </>
    );
}
