// Main file tree component for the commit panel. Renders tracked changes
// and unversioned files as collapsible sections with directory grouping.

import React, { useState, useMemo, useCallback, useRef } from "react";
import { Box } from "@chakra-ui/react";
import { SectionHeader } from "./SectionHeader";
import { FolderRow } from "./FolderRow";
import { FileRow } from "./FileRow";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import type { TreeEntry } from "../types";
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
    const [changesOpen, setChangesOpen] = useState(true);
    const [unversionedOpen, setUnversionedOpen] = useState(true);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
    const [isDragOverChanges, setIsDragOverChanges] = useState(false);
    const lastExpandSignal = useRef(0);
    const lastCollapseSignal = useRef(0);
    const seenDirsRef = useRef<Set<string>>(new Set());
    const dragCounterRef = useRef(0);

    const tracked = useMemo(() => files.filter((f) => f.status !== "?"), [files]);
    const unversioned = useMemo(() => files.filter((f) => f.status === "?"), [files]);
    const trackedUniqueCount = useMemo(() => new Set(tracked.map((f) => f.path)).size, [tracked]);
    const unversionedUniqueCount = useMemo(
        () => new Set(unversioned.map((f) => f.path)).size,
        [unversioned],
    );

    const trackedTree = useFileTree(tracked, groupByDir);
    const unversionedTree = useFileTree(unversioned, groupByDir);
    const unversionedPaths = useMemo(
        () => new Set(unversioned.map((file) => file.path)),
        [unversioned],
    );

    const getUnversionedDragPaths = useCallback(
        (file: WorkingFile): string[] => {
            if (file.status !== "?") return [];
            if (!checkedPaths.has(file.path)) return [file.path];
            const selectedUnversioned = Array.from(checkedPaths).filter((path) =>
                unversionedPaths.has(path),
            );
            return selectedUnversioned.length > 0 ? selectedUnversioned : [file.path];
        },
        [checkedPaths, unversionedPaths],
    );

    const handleFileDragStart = useCallback(
        (event: React.DragEvent<HTMLElement>, file: WorkingFile) => {
            const paths = getUnversionedDragPaths(file);
            if (paths.length === 0) {
                event.preventDefault();
                return;
            }
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(
                "application/vnd.intelligit.unversioned-files",
                JSON.stringify(paths),
            );
            event.dataTransfer.setData("text/plain", paths.join("\n"));

            // Show file count on the drag cursor.
            if (paths.length > 1 && typeof event.dataTransfer.setDragImage === "function") {
                const badge = document.createElement("div");
                badge.textContent = String(paths.length);
                badge.style.cssText =
                    "position:absolute;left:-9999px;background:var(--intelligit-pycharm-blue,#3b82f6);color:#fff;font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 5px;line-height:1";
                document.body.appendChild(badge);
                event.dataTransfer.setDragImage(badge, 0, 0);
                requestAnimationFrame(() => badge.remove());
            }
        },
        [getUnversionedDragPaths],
    );

    const readDraggedUnversionedPaths = useCallback(
        (dataTransfer: DataTransfer): string[] => {
            const raw = dataTransfer.getData("application/vnd.intelligit.unversioned-files");
            if (!raw) return [];
            try {
                const parsed: unknown = JSON.parse(raw);
                if (!Array.isArray(parsed)) return [];
                return parsed.filter(
                    (path): path is string =>
                        typeof path === "string" && unversionedPaths.has(path),
                );
            } catch {
                return [];
            }
        },
        [unversionedPaths],
    );

    const handleChangesDragEnter = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            if (readDraggedUnversionedPaths(event.dataTransfer).length === 0) return;
            event.preventDefault();
            dragCounterRef.current += 1;
            setIsDragOverChanges(true);
        },
        [readDraggedUnversionedPaths],
    );

    const handleChangesDragOver = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            if (readDraggedUnversionedPaths(event.dataTransfer).length === 0) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
        },
        [readDraggedUnversionedPaths],
    );

    const handleChangesDragLeave = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            if (readDraggedUnversionedPaths(event.dataTransfer).length === 0) return;
            dragCounterRef.current -= 1;
            if (dragCounterRef.current <= 0) {
                dragCounterRef.current = 0;
                setIsDragOverChanges(false);
            }
        },
        [readDraggedUnversionedPaths],
    );

    const handleChangesDrop = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            const paths = readDraggedUnversionedPaths(event.dataTransfer);
            dragCounterRef.current = 0;
            setIsDragOverChanges(false);
            if (paths.length === 0) return;
            event.preventDefault();
            onTrackUnversionedFiles?.(paths);
        },
        [onTrackUnversionedFiles, readDraggedUnversionedPaths],
    );

    // Respond to expand/collapse all signals
    React.useEffect(() => {
        if (expandAllSignal === 0 || expandAllSignal === lastExpandSignal.current) return;
        lastExpandSignal.current = expandAllSignal;
        // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
        setChangesOpen(true);
        // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
        setUnversionedOpen(true);
        const allDirs = [
            ...collectAllDirPaths(trackedTree),
            ...collectAllDirPaths(unversionedTree),
        ];
        for (const dir of allDirs) {
            seenDirsRef.current.add(dir);
        }
        setExpandedDirs(new Set(allDirs));
    }, [expandAllSignal, trackedTree, unversionedTree]);

    React.useEffect(() => {
        if (collapseAllSignal === 0 || collapseAllSignal === lastCollapseSignal.current) return;
        lastCollapseSignal.current = collapseAllSignal;
        // Keep top-level sections visible; collapse only nested directory expansion state.
        // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
        setChangesOpen(true);
        // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
        setUnversionedOpen(true);
        // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
        setExpandedDirs(new Set());
    }, [collapseAllSignal]);

    // Auto-expand new dirs when files come in and sections are open
    React.useEffect(() => {
        if (!changesOpen && !unversionedOpen) return;
        const allDirs = [
            ...collectAllDirPaths(trackedTree),
            ...collectAllDirPaths(unversionedTree),
        ];
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            let changed = false;
            for (const d of allDirs) {
                // Auto-expand only directories that appear for the first time.
                if (!seenDirsRef.current.has(d)) {
                    seenDirsRef.current.add(d);
                    next.add(d);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [trackedTree, unversionedTree, changesOpen, unversionedOpen]);

    const toggleDir = useCallback((dirPath: string) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(dirPath)) next.delete(dirPath);
            else next.add(dirPath);
            return next;
        });
    }, []);

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
                        onToggleOpen={() => setChangesOpen((o) => !o)}
                        onToggleCheck={() => onToggleSection(tracked)}
                        onDragOver={handleChangesDragOver}
                        onDragLeave={handleChangesDragLeave}
                        onDrop={handleChangesDrop}
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
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={onFileClick}
                            onFileDragStart={handleFileDragStart}
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
                        onToggleOpen={() => setUnversionedOpen((o) => !o)}
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
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={onFileClick}
                            onFileDragStart={handleFileDragStart}
                        />
                    )}
                </>
            )}
        </>
    );
}

interface TreeEntriesProps {
    entries: TreeEntry[];
    depth: number;
    groupByDir: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    expandedDirs: Set<string>;
    checkedPaths: Set<string>;
    onToggleFile: (path: string) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onToggleDir: (dirPath: string) => void;
    onFileClick: (path: string) => void;
    onFileDragStart?: (event: React.DragEvent<HTMLElement>, file: WorkingFile) => void;
}

function TreeEntries({
    entries,
    depth,
    groupByDir,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    expandedDirs,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    isAllChecked,
    isSomeChecked,
    onToggleDir,
    onFileClick,
    onFileDragStart,
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
                            groupByDir={groupByDir}
                            onToggle={onToggleFile}
                            onClick={onFileClick}
                            draggable={entry.file.status === "?"}
                            onDragStart={onFileDragStart}
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
                                onToggleFile={onToggleFile}
                                onToggleFolder={onToggleFolder}
                                isAllChecked={isAllChecked}
                                isSomeChecked={isSomeChecked}
                                onToggleDir={onToggleDir}
                                onFileClick={onFileClick}
                                onFileDragStart={onFileDragStart}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}
