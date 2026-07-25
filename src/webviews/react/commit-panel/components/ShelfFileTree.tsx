// File rows for one shelf, rendered as a subtree beneath that shelf's row.

import React, { useMemo, useState } from "react";
import { Box } from "@chakra-ui/react";
import type { ShelfFileEntry } from "../../../../shelf/model";
import type { WorkingFile } from "../../../../types";
import { buildFileTree, countFiles, type TreeEntry } from "../../shared/fileTree";
import { FileRow } from "./FileRow";
import { FolderRow } from "./FolderRow";
import { t } from "../../shared/i18n";

interface ShelfFileTreeProps {
    entries: readonly ShelfFileEntry[];
    groupByDir: boolean;
    /** Indent level of the file rows; one level deeper than the owning shelf row. */
    depth: number;
    isDirectoryCollapsed: (path: string) => boolean;
    onToggleDirectory: (path: string) => void;
    onFileActivate: (entry: ShelfFileEntry) => void;
    onContextMenu?: (
        entry: ShelfFileEntry,
        x: number,
        y: number,
        returnFocusTarget: HTMLElement,
    ) => void;
    onDragStart?: (event: React.DragEvent<HTMLElement>, entry: ShelfFileEntry) => void;
}

type ShelfDisplayFile = WorkingFile & { shelfEntry: ShelfFileEntry };

function displayFile(entry: ShelfFileEntry): ShelfDisplayFile {
    const block = entry.worktreeBlock ?? entry.indexBlock;
    const status = block?.status === "T" ? "M" : (block?.status ?? (entry.untracked ? "?" : "M"));
    return {
        path: block?.path ?? entry.changeId,
        status,
        staged: entry.indexBlock !== undefined,
        additions: 0,
        deletions: 0,
        shelfEntry: entry,
    };
}

/** Read-only file rows for one shelf; activation always opens its base-to-shelved diff. */
export function ShelfFileTree({
    entries,
    groupByDir,
    depth,
    isDirectoryCollapsed,
    onToggleDirectory,
    onFileActivate,
    onContextMenu,
    onDragStart,
}: ShelfFileTreeProps): React.ReactElement {
    const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
    const files = useMemo(() => entries.map(displayFile), [entries]);
    const tree = useMemo(() => buildFileTree(files), [files]);

    const renderFile = (file: ShelfDisplayFile, fileDepth: number): React.ReactElement => {
        const entry = file.shelfEntry;
        return (
            <FileRow
                key={entry.changeId}
                file={file}
                depth={fileDepth}
                isChecked={false}
                isDragSelected={selectedChangeId === entry.changeId}
                groupByDir={groupByDir}
                onToggle={() => undefined}
                onClick={() => {
                    setSelectedChangeId(entry.changeId);
                    onFileActivate(entry);
                }}
                onActivate={() => onFileActivate(entry)}
                onOpenContextMenu={(_, x, y, returnFocusTarget) => {
                    setSelectedChangeId(entry.changeId);
                    onContextMenu?.(entry, x, y, returnFocusTarget);
                }}
                dataShelfFile={entry.changeId}
                isCurrent={selectedChangeId === entry.changeId}
                contextMenuEnabled={false}
                checkboxVisibility="none"
                draggable={Boolean(onDragStart)}
                onDragStart={(event) => onDragStart?.(event, entry)}
            />
        );
    };
    const renderTree = (nodes: TreeEntry<ShelfDisplayFile>[], nodeDepth: number): React.ReactNode =>
        nodes.map((node) => {
            if (node.type === "file") return renderFile(node.file, nodeDepth);
            const isExpanded = !isDirectoryCollapsed(node.path);
            return (
                <React.Fragment key={node.path}>
                    <FolderRow
                        name={node.name}
                        dirPath={node.path}
                        depth={nodeDepth}
                        isExpanded={isExpanded}
                        fileCount={countFiles(node.children)}
                        isAllChecked={false}
                        isSomeChecked={false}
                        onToggleExpand={onToggleDirectory}
                        onToggleCheck={() => undefined}
                        checkboxVisibility="none"
                        interactive
                    />
                    {isExpanded ? renderTree(node.children, nodeDepth + 1) : null}
                </React.Fragment>
            );
        });

    if (entries.length === 0) {
        return (
            <Box px="12px" py="6px" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                {t("shelf.filePane.empty")}
            </Box>
        );
    }
    return (
        <>{groupByDir ? renderTree(tree, depth) : files.map((file) => renderFile(file, depth))}</>
    );
}
