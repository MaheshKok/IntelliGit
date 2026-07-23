import React from "react";
import { Box } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import { ShelfRow } from "./ShelfRow";

/** State and callbacks for the keyboard-navigable shelf row list. */
export interface ShelfListProps {
    shelves: ShelfEntry[];
    selectedShelfId: string | null;
    showAlreadyUnshelved: boolean;
    height: number;
    maxHeight: string;
    renamingShelfId: string | null;
    renameError?: string;
    onSelect: (shelfId: string) => void;
    onContextMenu: (shelf: ShelfEntry, x: number, y: number, target: HTMLElement) => void;
    onRenameSubmit: (shelf: ShelfEntry, name: string) => void;
    onRenameCancel: () => void;
    onRestore: (shelf: ShelfEntry) => void;
    onDragStart?: (event: React.DragEvent<HTMLElement>, shelf: ShelfEntry) => void;
    dragEnabledShelfId?: string | null;
}

/** Flat shelf list with roving tabindex and an optional muted ghost group. */
export function ShelfList({
    shelves,
    selectedShelfId,
    showAlreadyUnshelved,
    height,
    maxHeight,
    renamingShelfId,
    renameError,
    onSelect,
    onContextMenu,
    onRenameSubmit,
    onRenameCancel,
    onRestore,
    onDragStart,
    dragEnabledShelfId,
}: ShelfListProps): React.ReactElement {
    const activeShelves = shelves.filter((shelf) => shelf.metadata.lifecycle !== "applied");
    const ghosts = showAlreadyUnshelved
        ? shelves.filter((shelf) => shelf.metadata.lifecycle === "applied")
        : [];
    const visibleShelves = [...activeShelves, ...ghosts];
    const selected = visibleShelves.some((shelf) => shelf.id === selectedShelfId)
        ? selectedShelfId
        : (visibleShelves[0]?.id ?? null);

    const navigate = (shelfId: string, key: string, target: HTMLElement): void => {
        const index = visibleShelves.findIndex((shelf) => shelf.id === shelfId);
        if (index < 0) return;
        const next =
            key === "Home"
                ? visibleShelves[0]
                : key === "End"
                  ? visibleShelves.at(-1)
                  : key === "ArrowUp"
                    ? visibleShelves[Math.max(0, index - 1)]
                    : key === "ArrowDown"
                      ? visibleShelves[Math.min(visibleShelves.length - 1, index + 1)]
                      : undefined;
        if (!next) return;
        target.ownerDocument
            .querySelector<HTMLElement>(`[data-shelf-id="${next.id}"]`)
            ?.focus();
        onSelect(next.id);
    };

    const rows = (items: ShelfEntry[], ghost: boolean): React.ReactNode =>
        items.map((shelf) => (
            <ShelfRow
                key={shelf.id}
                shelf={shelf}
                selected={selected === shelf.id}
                isGhost={ghost}
                isRenaming={renamingShelfId === shelf.id}
                renameError={renamingShelfId === shelf.id ? renameError : undefined}
                onSelect={onSelect}
                onNavigate={navigate}
                onContextMenu={onContextMenu}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
                onRestore={onRestore}
                onDragStart={shelf.id === dragEnabledShelfId ? onDragStart : undefined}
            />
        ));

    return (
        <Box
            data-testid="shelf-list"
            role="listbox"
            aria-label="Shelves"
            style={{ height: `${height}px`, maxHeight }}
            minH="100px"
            flexShrink={0}
            overflowY="auto"
            py="6px"
            bg="var(--intelligit-pycharm-panel)"
        >
            {visibleShelves.length === 0 ? (
                <Box p="12px" textAlign="center" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    No shelves.
                </Box>
            ) : (
                <>
                    {activeShelves.length > 0 ? rows(activeShelves, false) : null}
                    {ghosts.length > 0 ? (
                        <>
                            <Box px="12px" pt="8px" pb="3px" fontSize="11px" color="var(--intelligit-pycharm-muted)">
                                Already Unshelved
                            </Box>
                            {rows(ghosts, true)}
                        </>
                    ) : null}
                </>
            )}
        </Box>
    );
}
