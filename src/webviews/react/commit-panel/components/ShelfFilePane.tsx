import React, { useMemo, useState } from "react";
import { Box } from "@chakra-ui/react";
import type { ShelfFileEntry } from "../../../../shelf/model";
import type { WorkingFile } from "../../../../types";
import { buildFileTree, countFiles, type TreeEntry } from "../../shared/fileTree";
import { FileRow } from "./FileRow";
import { FolderRow } from "./FolderRow";
import { SectionHeader } from "./SectionHeader";
import { t } from "../../shared/i18n";

interface ShelfFilePaneProps {
    entries: ShelfFileEntry[];
    groupByDir: boolean;
    onFileActivate: (entry: ShelfFileEntry) => void;
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

/** Read-only file rows for the selected shelf; activation always opens its base-to-shelved diff. */
export function ShelfFilePane({
    entries,
    groupByDir,
    onFileActivate,
    onDragStart,
}: ShelfFilePaneProps): React.ReactElement {
    const [isOpen, setIsOpen] = useState(true);
    const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
    const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
    const files = useMemo(() => entries.map(displayFile), [entries]);
    const tree = useMemo(() => buildFileTree(files), [files]);

    const renderFile = (file: ShelfDisplayFile, depth: number): React.ReactElement => {
        const entry = file.shelfEntry;
        return (
            <FileRow
                key={entry.changeId}
                file={file}
                depth={depth}
                isChecked={false}
                isDragSelected={selectedChangeId === entry.changeId}
                groupByDir={groupByDir}
                onToggle={() => undefined}
                onClick={() => {
                    setSelectedChangeId(entry.changeId);
                    onFileActivate(entry);
                }}
                onActivate={() => onFileActivate(entry)}
                dataShelfFile={entry.changeId}
                isCurrent={selectedChangeId === entry.changeId}
                contextMenuEnabled={false}
                checkboxVisibility="none"
                draggable={Boolean(onDragStart)}
                onDragStart={(event) => onDragStart?.(event, entry)}
            />
        );
    };
    const renderTree = (nodes: TreeEntry<ShelfDisplayFile>[], depth = 0): React.ReactNode =>
        nodes.map((node) => {
            if (node.type === "file") return renderFile(node.file, depth);
            const isExpanded = !collapsedDirectories.has(node.path);
            return (
                <React.Fragment key={node.path}>
                    <FolderRow
                        name={node.name}
                        dirPath={node.path}
                        depth={depth}
                        isExpanded={isExpanded}
                        fileCount={countFiles(node.children)}
                        isAllChecked={false}
                        isSomeChecked={false}
                        onToggleExpand={(path) =>
                            setCollapsedDirectories((current) => {
                                const next = new Set(current);
                                if (next.has(path)) next.delete(path);
                                else next.add(path);
                                return next;
                            })
                        }
                        onToggleCheck={() => undefined}
                        checkboxVisibility="none"
                        interactive
                    />
                    {isExpanded ? renderTree(node.children, depth + 1) : null}
                </React.Fragment>
            );
        });

    return (
        <Box
            data-testid="shelf-file-pane"
            role="region"
            aria-label={t("shelf.filePane.label")}
            flex={1}
            minH="80px"
            overflowY="auto"
            py="6px"
            bg="var(--intelligit-pycharm-panel)"
        >
            <SectionHeader
                label={t("shelf.filePane.label")}
                count={files.length}
                stats={{ additions: 0, deletions: 0 }}
                isOpen={isOpen}
                isAllChecked={false}
                isSomeChecked={false}
                onToggleOpen={() => setIsOpen((current) => !current)}
                onToggleCheck={() => undefined}
                checkboxVisibility="none"
            />
            {isOpen
                ? groupByDir
                    ? renderTree(tree)
                    : files.map((file) => renderFile(file, 0))
                : null}
            {entries.length === 0 ? (
                <Box px="12px" py="6px" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    {t("shelf.filePane.empty")}
                </Box>
            ) : null}
        </Box>
    );
}
