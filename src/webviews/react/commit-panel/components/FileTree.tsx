// Main file tree component for the commit panel. Renders tracked changes
// and unversioned files as collapsible sections with directory grouping.

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Box } from "@chakra-ui/react";
import { SectionHeader } from "./SectionHeader";
import { TreeEntries } from "./FileTreeEntries";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import { useFileDrag } from "../hooks/useFileDrag";
import type { ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { t } from "../../shared/i18n";

interface Props {
    files: WorkingFile[];
    groupByDir: boolean;
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
    expandedDirs: Set<string>;
}

/**
 * Renders tracked and unversioned working-tree files with optional directory grouping.
 *
 * The tree owns only UI expansion state. Selection and diff requests are routed
 * through callbacks so the parent can keep checked paths stable across refreshes
 * and send host messages for file opens.
 */
export function FileTree({
    files,
    groupByDir,
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
        expandedDirs: new Set(),
    }));
    // Parent expand/collapse signals are reconciled after commit in the effect below.
    // react-doctor-disable-next-line react-doctor/no-event-handler
    const { changesOpen, unversionedOpen, expandedDirs } = expansion;
    const lastExpandSignal = useRef(0);
    const lastCollapseSignal = useRef(0);
    // Small local set tracks first-seen directories without altering effect dependencies.
    // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init
    const seenDirsRef = useRef<Set<string>>(new Set());

    // react-doctor-disable-next-line react-doctor/no-event-handler
    const tracked = useMemo(() => files.filter((f) => f.status !== "?"), [files]);
    const unversioned = useMemo(() => files.filter((f) => f.status === "?"), [files]);
    const trackedUniqueCount = useMemo(() => new Set(tracked.map((f) => f.path)).size, [tracked]);
    const unversionedUniqueCount = useMemo(
        () => new Set(unversioned.map((f) => f.path)).size,
        [unversioned],
    );

    // react-doctor-disable-next-line react-doctor/no-event-handler
    const trackedTree = useFileTree(tracked, groupByDir);
    const unversionedTree = useFileTree(unversioned, groupByDir);
    const allDirPaths = useMemo(
        () => [...collectAllDirPaths(trackedTree), ...collectAllDirPaths(unversionedTree)],
        [trackedTree, unversionedTree],
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
            changesOpen || unversionedOpen
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
                    expandedDirs: new Set(allDirPaths),
                };
            }
            if (shouldCollapseAll) {
                lastCollapseSignal.current = collapseAllSignal;
                nextExpansion = {
                    ...nextExpansion,
                    changesOpen: false,
                    unversionedOpen: false,
                    expandedDirs: new Set(),
                };
            }
            return nextExpansion;
        });
    }, [allDirPaths, changesOpen, collapseAllSignal, expandAllSignal, unversionedOpen]);

    if (files.length === 0) {
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
                    <SectionHeader
                        label={t("commitPanel.changes")}
                        count={trackedUniqueCount}
                        isOpen={changesOpen}
                        isAllChecked={isAllChecked(tracked)}
                        isSomeChecked={isSomeChecked(tracked)}
                        onToggleOpen={() =>
                            setExpansion((prev) => ({ ...prev, changesOpen: !prev.changesOpen }))
                        }
                        onToggleCheck={() => onToggleSection(tracked)}
                        isDragOver={isDragOverChanges}
                    />
                    {changesOpen && (
                        <TreeEntries
                            entries={trackedTree}
                            depth={0}
                            groupByDir={groupByDir}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            expandedDirs={expandedDirs}
                            checkedPaths={checkedPaths}
                            dragSelectedPaths={visibleDragSelectedUnversionedPaths}
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={handleTreeFileClick}
                            onFileDragStart={handleFileDragStart}
                            onFileDragEnd={handleFileDragEnd}
                        />
                    )}
                </Box>
            )}
            {unversioned.length > 0 && (
                <>
                    <SectionHeader
                        label={t("commitPanel.unversionedFiles")}
                        count={unversionedUniqueCount}
                        isOpen={unversionedOpen}
                        isAllChecked={isAllChecked(unversioned)}
                        isSomeChecked={isSomeChecked(unversioned)}
                        onToggleOpen={() =>
                            setExpansion((prev) => ({
                                ...prev,
                                unversionedOpen: !prev.unversionedOpen,
                            }))
                        }
                        onToggleCheck={() => onToggleSection(unversioned)}
                    />
                    {unversionedOpen && (
                        <TreeEntries
                            entries={unversionedTree}
                            depth={0}
                            groupByDir={groupByDir}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            expandedDirs={expandedDirs}
                            checkedPaths={checkedPaths}
                            dragSelectedPaths={visibleDragSelectedUnversionedPaths}
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={handleTreeFileClick}
                            onFileDragStart={handleFileDragStart}
                            onFileDragEnd={handleFileDragEnd}
                        />
                    )}
                </>
            )}
        </>
    );
}
