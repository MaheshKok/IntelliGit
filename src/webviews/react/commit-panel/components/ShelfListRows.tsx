import React, { useMemo } from "react";
import { Box } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import { ShelfRow } from "./ShelfRow";

interface ShelfListRowsProps {
    shelves: ShelfEntry[];
    selectedShelfId: string | null;
    focusedShelfId: string | null;
    isGhost: boolean;
    hasSelectedFile: boolean;
    expandedShelfIds: ReadonlySet<string>;
    renamingShelfId: string | null;
    renameError?: string;
    onSelect: (shelfId: string) => void;
    onToggleExpand: (shelfId: string) => void;
    onNavigate: (shelfId: string, key: string, target: HTMLElement) => void;
    renderSubtree: (shelf: ShelfEntry) => React.ReactNode;
    onContextMenu: (shelf: ShelfEntry, x: number, y: number, target: HTMLElement) => void;
    onRenameSubmit: (shelf: ShelfEntry, name: string) => void;
    onRenameCancel: () => void;
    onRestore: (shelf: ShelfEntry) => void;
    onDragStart?: (event: React.DragEvent<HTMLElement>, shelf: ShelfEntry) => void;
}

/** Renders one active or ghost shelf group without recreating a component during list render. */
export function ShelfListRows({
    shelves,
    selectedShelfId,
    focusedShelfId,
    isGhost,
    hasSelectedFile,
    expandedShelfIds,
    renamingShelfId,
    renameError,
    onSelect,
    onToggleExpand,
    onNavigate,
    renderSubtree,
    onContextMenu,
    onRenameSubmit,
    onRenameCancel,
    onRestore,
    onDragStart,
}: ShelfListRowsProps): React.ReactElement {
    const renderedSubtreesById = useMemo(() => {
        const subtrees = new Map<string, React.ReactNode>();
        for (const shelf of shelves) {
            if (expandedShelfIds.has(shelf.id)) subtrees.set(shelf.id, renderSubtree(shelf));
        }
        return subtrees;
    }, [expandedShelfIds, renderSubtree, shelves]);

    return (
        <>
            {shelves.map((shelf) => {
                const isExpanded = expandedShelfIds.has(shelf.id);
                const isRenaming = renamingShelfId === shelf.id;
                return (
                    <React.Fragment key={shelf.id}>
                        <ShelfRow
                            shelf={shelf}
                            state={{
                                selected: !hasSelectedFile && selectedShelfId === shelf.id,
                                isFocusTarget: focusedShelfId === shelf.id,
                                isGhost,
                                isExpanded,
                                isRenaming,
                                renameError: isRenaming ? renameError : undefined,
                            }}
                            onSelect={onSelect}
                            onToggleExpand={onToggleExpand}
                            onNavigate={onNavigate}
                            onContextMenu={onContextMenu}
                            onRenameSubmit={onRenameSubmit}
                            onRenameCancel={onRenameCancel}
                            onRestore={onRestore}
                            onDragStart={onDragStart}
                        />
                        {isExpanded ? (
                            <Box role="group">{renderedSubtreesById.get(shelf.id)}</Box>
                        ) : null}
                    </React.Fragment>
                );
            })}
        </>
    );
}
