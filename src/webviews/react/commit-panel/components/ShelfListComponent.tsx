import React from "react";
import { Box } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import { ShelfListRows } from "./ShelfListRows";
import { isActiveShelf } from "./ShelfListUtils";
import { t } from "../../shared/i18n";

/** State and callbacks for the keyboard-navigable shelf row list. */
export interface ShelfListProps {
    shelves: ShelfEntry[];
    selectedShelfId: string | null;
    /** True while a file row owns the tree's single selection. */
    hasSelectedFile: boolean;
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
    hasSelectedFile,
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
    const focused = visibleShelves.some((shelf) => shelf.id === selectedShelfId)
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
        target.ownerDocument
            .querySelector<HTMLElement>(`[data-shelf-id="${CSS.escape(next.id)}"]`)
            ?.focus();
        onSelect(next.id);
    };

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
                    <Box
                        color="var(--intelligit-pycharm-foreground)"
                        fontSize="13px"
                        fontWeight={500}
                    >
                        {t("shelf.list.empty")}
                    </Box>
                    <Box mt="2px">{t("shelf.list.empty.hint")}</Box>
                </Box>
            ) : (
                <>
                    {activeShelves.length > 0 ? (
                        <ShelfListRows
                            shelves={activeShelves}
                            selectedShelfId={selectedShelfId}
                            focusedShelfId={focused}
                            isGhost={false}
                            hasSelectedFile={hasSelectedFile}
                            expandedShelfIds={expandedShelfIds}
                            renamingShelfId={renamingShelfId}
                            renameError={renameError}
                            onSelect={onSelect}
                            onToggleExpand={onToggleExpand}
                            onNavigate={navigate}
                            renderSubtree={renderSubtree}
                            onContextMenu={onContextMenu}
                            onRenameSubmit={onRenameSubmit}
                            onRenameCancel={onRenameCancel}
                            onRestore={onRestore}
                            onDragStart={onDragStart}
                        />
                    ) : null}
                    {ghosts.length > 0 ? (
                        <>
                            <Box
                                px="10px"
                                pt="10px"
                                pb="4px"
                                fontSize="11px"
                                fontWeight={600}
                                color="var(--intelligit-pycharm-muted)"
                            >
                                {t("shelf.list.alreadyUnshelved")}
                            </Box>
                            <ShelfListRows
                                shelves={ghosts}
                                selectedShelfId={selectedShelfId}
                                focusedShelfId={focused}
                                isGhost
                                hasSelectedFile={hasSelectedFile}
                                expandedShelfIds={expandedShelfIds}
                                renamingShelfId={renamingShelfId}
                                renameError={renameError}
                                onSelect={onSelect}
                                onToggleExpand={onToggleExpand}
                                onNavigate={navigate}
                                renderSubtree={renderSubtree}
                                onContextMenu={onContextMenu}
                                onRenameSubmit={onRenameSubmit}
                                onRenameCancel={onRenameCancel}
                                onRestore={onRestore}
                                onDragStart={onDragStart}
                            />
                        </>
                    ) : null}
                </>
            )}
        </Box>
    );
}
