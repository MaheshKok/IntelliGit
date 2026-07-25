import React from "react";
import { Box } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import { ShelfRow } from "./ShelfRow";
import { t } from "../../shared/i18n";

/**
 * A shelf the list shows unconditionally. "applied" shelves are ghosts, hidden
 * until the user opts in, so the Shelf tab count reports active shelves only.
 */
export function isActiveShelf(shelf: ShelfEntry): boolean {
    return shelf.metadata.lifecycle !== "applied";
}

/** State and callbacks for the keyboard-navigable shelf row list. */
export interface ShelfListProps {
    shelves: ShelfEntry[];
    selectedShelfId: string | null;
    showAlreadyUnshelved: boolean;
    /** Ids of the shelves whose file subtree is currently rendered. */
    expandedShelfIds: ReadonlySet<string>;
    renamingShelfId: string | null;
    renameError?: string;
    onSelect: (shelfId: string) => void;
    onToggleExpand: (shelfId: string) => void;
    /** Renders one shelf's file rows; called only while that shelf is expanded. */
    renderSubtree: (shelf: ShelfEntry) => React.ReactNode;
    onContextMenu: (shelf: ShelfEntry, x: number, y: number, target: HTMLElement) => void;
    onRenameSubmit: (shelf: ShelfEntry, name: string) => void;
    onRenameCancel: () => void;
    onRestore: (shelf: ShelfEntry) => void;
    onDragStart?: (event: React.DragEvent<HTMLElement>, shelf: ShelfEntry) => void;
}

/** Shelf tree with roving tabindex, expandable rows and an optional ghost group. */
export function ShelfList({
    shelves,
    selectedShelfId,
    showAlreadyUnshelved,
    expandedShelfIds,
    renamingShelfId,
    renameError,
    onSelect,
    onToggleExpand,
    renderSubtree,
    onContextMenu,
    onRenameSubmit,
    onRenameCancel,
    onRestore,
    onDragStart,
}: ShelfListProps): React.ReactElement {
    const activeShelves = shelves.filter(isActiveShelf);
    const ghosts = showAlreadyUnshelved ? shelves.filter((shelf) => !isActiveShelf(shelf)) : [];
    const visibleShelves = [...activeShelves, ...ghosts];
    const selected = visibleShelves.some((shelf) => shelf.id === selectedShelfId)
        ? selectedShelfId
        : (visibleShelves[0]?.id ?? null);

    const navigate = (shelfId: string, key: string, target: HTMLElement): void => {
        const index = visibleShelves.findIndex((shelf) => shelf.id === shelfId);
        if (index < 0) return;
        if (key === "ArrowRight" || key === "ArrowLeft") {
            // Standard tree keys: right opens a closed row, left closes an open one.
            if (expandedShelfIds.has(shelfId) === (key === "ArrowLeft")) onToggleExpand(shelfId);
            return;
        }
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
        target.ownerDocument.querySelector<HTMLElement>(`[data-shelf-id="${next.id}"]`)?.focus();
        onSelect(next.id);
    };

    const rows = (items: ShelfEntry[], ghost: boolean): React.ReactNode =>
        items.map((shelf) => {
            const isExpanded = expandedShelfIds.has(shelf.id);
            return (
                <React.Fragment key={shelf.id}>
                    <ShelfRow
                        shelf={shelf}
                        selected={selected === shelf.id}
                        isGhost={ghost}
                        isExpanded={isExpanded}
                        isRenaming={renamingShelfId === shelf.id}
                        renameError={renamingShelfId === shelf.id ? renameError : undefined}
                        onSelect={onSelect}
                        onToggleExpand={onToggleExpand}
                        onNavigate={navigate}
                        onContextMenu={onContextMenu}
                        onRenameSubmit={onRenameSubmit}
                        onRenameCancel={onRenameCancel}
                        onRestore={onRestore}
                        onDragStart={onDragStart}
                    />
                    {isExpanded ? <Box role="group">{renderSubtree(shelf)}</Box> : null}
                </React.Fragment>
            );
        });

    return (
        <Box
            data-testid="shelf-list"
            role="tree"
            aria-label={t("shelf.list.label")}
            flex={1}
            minH={0}
            overflowY="auto"
            py="6px"
            bg="var(--intelligit-pycharm-panel)"
        >
            {visibleShelves.length === 0 ? (
                <Box
                    p="12px"
                    textAlign="center"
                    fontSize="12px"
                    color="var(--intelligit-pycharm-muted)"
                >
                    {t("shelf.list.empty")}
                </Box>
            ) : (
                <>
                    {activeShelves.length > 0 ? rows(activeShelves, false) : null}
                    {ghosts.length > 0 ? (
                        <>
                            <Box
                                px="12px"
                                pt="8px"
                                pb="3px"
                                fontSize="11px"
                                color="var(--intelligit-pycharm-muted)"
                            >
                                {t("shelf.list.alreadyUnshelved")}
                            </Box>
                            {rows(ghosts, true)}
                        </>
                    ) : null}
                </>
            )}
        </Box>
    );
}
