// File rows for one shelf, rendered as a subtree beneath that shelf's row using
// the same tree the commit-info pane draws for a commit's Changed Files.

import React, { useMemo, useState } from "react";
import { Box } from "@chakra-ui/react";
import type { ShelfFileView } from "../../../protocol/commitPanelMessages";
import type { ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { buildFileTree, type TreeEntry } from "../../shared/fileTree";
import { FileTreeRows, ENTRY_ROW_GUIDE_LEFT } from "../../shared/components/FileTreeRows";
import { t } from "../../shared/i18n";

interface ShelfFileTreeProps {
    entries: readonly ShelfFileView[];
    groupByDir: boolean;
    /** Indent level of the file rows; the owning shelf row acts as their header. */
    depth: number;
    isDirectoryCollapsed: (path: string) => boolean;
    onToggleDirectory: (path: string) => void;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onFileActivate: (entry: ShelfFileView) => void;
    onContextMenu?: (
        entry: ShelfFileView,
        x: number,
        y: number,
        returnFocusTarget: HTMLElement,
    ) => void;
    onDragStart?: (event: React.DragEvent<HTMLElement>, entry: ShelfFileView) => void;
}

type ShelfDisplayFile = WorkingFile & { shelfEntry: ShelfFileView };

function displayFile(entry: ShelfFileView): ShelfDisplayFile {
    const block = entry.worktreeBlock ?? entry.indexBlock;
    const status = block?.status === "T" ? "M" : (block?.status ?? (entry.untracked ? "?" : "M"));
    return {
        path: block?.path ?? entry.changeId,
        status,
        staged: entry.indexBlock !== undefined,
        additions: 0,
        deletions: 0,
        icon: entry.icon,
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
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onFileActivate,
    onContextMenu,
    onDragStart,
}: ShelfFileTreeProps): React.ReactElement {
    const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
    const files = useMemo(() => entries.map(displayFile), [entries]);
    const tree = useMemo<TreeEntry<ShelfDisplayFile>[]>(
        () =>
            groupByDir
                ? buildFileTree(files)
                : files.map((file) => ({ type: "file" as const, file })),
        [files, groupByDir],
    );

    if (entries.length === 0) {
        return (
            <Box px="12px" py="6px" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                {t("shelf.filePane.empty")}
            </Box>
        );
    }
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
            isDirectoryExpanded={(path) => !isDirectoryCollapsed(path)}
            onToggleDirectory={onToggleDirectory}
            fileWiring={(file) => {
                const entry = file.shelfEntry;
                return {
                    isSelected: selectedChangeId === entry.changeId,
                    onSelect: () => {
                        setSelectedChangeId(entry.changeId);
                        onFileActivate(entry);
                    },
                    onActivate: () => onFileActivate(entry),
                    onContextMenu: onContextMenu
                        ? (x, y, returnFocusTarget) => {
                              setSelectedChangeId(entry.changeId);
                              onContextMenu(entry, x, y, returnFocusTarget);
                          }
                        : undefined,
                    dataAttributes: { "shelf-file": entry.changeId },
                    draggable: Boolean(onDragStart),
                    onDragStart: onDragStart ? (event) => onDragStart(event, entry) : undefined,
                };
            }}
        />
    );
}
