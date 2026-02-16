// Main file tree component for the commit panel. Renders tracked changes
// and unversioned files as collapsible sections with directory grouping.

import React, { useState, useMemo, useCallback, useRef } from "react";
import { Box } from "@chakra-ui/react";
import { SectionHeader } from "./SectionHeader";
import { FolderRow } from "./FolderRow";
import { FileRow } from "./FileRow";
import { useFileTree, collectTreeFiles, collectAllDirPaths } from "../hooks/useFileTree";
import type { WorkingFile } from "../../../../types";
import type { TreeEntry } from "../types";

interface Props {
    files: WorkingFile[];
    groupByDir: boolean;
    checkedPaths: Set<string>;
    onToggleFile: (path: string) => void;
    onToggleFolder: (dirPrefix: string, files: WorkingFile[]) => void;
    onToggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onFileClick: (path: string) => void;
    expandAllSignal: number;
    collapseAllSignal: number;
}

export function FileTree({
    files,
    groupByDir,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    onToggleSection,
    isAllChecked,
    isSomeChecked,
    onFileClick,
    expandAllSignal,
    collapseAllSignal,
}: Props): React.ReactElement {
    const [changesOpen, setChangesOpen] = useState(true);
    const [unversionedOpen, setUnversionedOpen] = useState(true);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
    const lastExpandSignal = useRef(0);
    const lastCollapseSignal = useRef(0);
    const seenDirsRef = useRef<Set<string>>(new Set());

    const tracked = useMemo(() => files.filter((f) => f.status !== "?"), [files]);
    const unversioned = useMemo(() => files.filter((f) => f.status === "?"), [files]);

    const trackedTree = useFileTree(tracked, groupByDir);
    const unversionedTree = useFileTree(unversioned, groupByDir);

    // Respond to expand/collapse all signals
    React.useEffect(() => {
        if (expandAllSignal === 0 || expandAllSignal === lastExpandSignal.current) return;
        lastExpandSignal.current = expandAllSignal;
        setChangesOpen(true);
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
        setChangesOpen(true);
        setUnversionedOpen(true);
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
                color="var(--vscode-descriptionForeground)"
                fontSize="12px"
                p="8px 12px"
                textAlign="center"
            >
                No changes
            </Box>
        );
    }

    return (
        <>
            {tracked.length > 0 && (
                <>
                    <SectionHeader
                        label="Changes"
                        count={tracked.length}
                        isOpen={changesOpen}
                        isAllChecked={isAllChecked(tracked)}
                        isSomeChecked={isSomeChecked(tracked)}
                        onToggleOpen={() => setChangesOpen((o) => !o)}
                        onToggleCheck={() => onToggleSection(tracked)}
                    />
                    {changesOpen && (
                        <TreeEntries
                            entries={trackedTree}
                            depth={0}
                            groupByDir={groupByDir}
                            expandedDirs={expandedDirs}
                            checkedPaths={checkedPaths}
                            allFiles={tracked}
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={onFileClick}
                        />
                    )}
                </>
            )}
            {unversioned.length > 0 && (
                <>
                    <SectionHeader
                        label="Unversioned Files"
                        count={unversioned.length}
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
                            expandedDirs={expandedDirs}
                            checkedPaths={checkedPaths}
                            allFiles={unversioned}
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={onFileClick}
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
    expandedDirs: Set<string>;
    checkedPaths: Set<string>;
    allFiles: WorkingFile[];
    onToggleFile: (path: string) => void;
    onToggleFolder: (dirPrefix: string, files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onToggleDir: (dirPath: string) => void;
    onFileClick: (path: string) => void;
}

function TreeEntries({
    entries,
    depth,
    groupByDir,
    expandedDirs,
    checkedPaths,
    allFiles,
    onToggleFile,
    onToggleFolder,
    isAllChecked,
    isSomeChecked,
    onToggleDir,
    onFileClick,
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
                        />
                    );
                }

                const dirFiles = collectTreeFiles(entry.children);
                const isExpanded = expandedDirs.has(entry.path);

                return (
                    <React.Fragment key={entry.path}>
                        <FolderRow
                            name={entry.name}
                            dirPath={entry.path}
                            depth={depth}
                            isExpanded={isExpanded}
                            fileCount={dirFiles.length}
                            isAllChecked={isAllChecked(dirFiles)}
                            isSomeChecked={isSomeChecked(dirFiles)}
                            onToggleExpand={onToggleDir}
                            onToggleCheck={() => onToggleFolder(entry.path, allFiles)}
                        />
                        {isExpanded && (
                            <TreeEntries
                                entries={entry.children}
                                depth={depth + 1}
                                groupByDir={groupByDir}
                                expandedDirs={expandedDirs}
                                checkedPaths={checkedPaths}
                                allFiles={allFiles}
                                onToggleFile={onToggleFile}
                                onToggleFolder={onToggleFolder}
                                isAllChecked={isAllChecked}
                                isSomeChecked={isSomeChecked}
                                onToggleDir={onToggleDir}
                                onFileClick={onFileClick}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}
