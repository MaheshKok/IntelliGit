import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type { ShelfFileEntry } from "../../../../shelf/model";
import type {
    OutboundMessage,
    PerEntryResult,
    ShelfEntry,
    ShelfMutationStatus,
} from "../../../protocol/commitPanelMessages";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { ShelfList } from "./ShelfList";
import { type ShelfContextAction } from "./ShelfRow";
import { ShelfToolbar } from "./ShelfToolbar";
import { UnshelveDialog, type UnshelveDialogSubmit } from "./UnshelveDialog";
import { ShelfFilePane } from "./ShelfFilePane";
import { CleanUpDialog } from "./CleanUpDialog";
import { RenameStructuralDialog, ShelfDeleteConfirmation } from "./ShelfTabDialogs";

/** Host message selecting one shelf and fetching its files. */
export type ShelfSelectMessage = Extract<OutboundMessage, { type: "shelfSelect" }>;

/** Flattened unshelve request with a non-empty whole-entry selection. */
export type ShelfUnshelveMessage = Extract<OutboundMessage, { type: "unshelve" }> & {
    changeIds: string[];
    mode: "flattened";
};

/** CAS-protected shelf rename request. */
export type ShelfRenameMessage = Extract<OutboundMessage, { type: "shelfRename" }>;
/** CAS-protected shelf deletion request. */
export type ShelfDeleteMessage = Extract<OutboundMessage, { type: "shelfDelete" }>;
/** Request for an immutable base-to-shelved comparison. */
export type ShelfDiffMessage = Extract<OutboundMessage, { type: "shelfDiff" }>;
/** Request for an immutable shelved-to-local comparison. */
export type ShelfCompareWithLocalMessage = Extract<
    OutboundMessage,
    { type: "shelfCompareWithLocal" }
>;
/** CAS-protected request restoring a completed ghost shelf. */
export type ShelfRestoreGhostMessage = Extract<OutboundMessage, { type: "shelfRestoreGhost" }>;
/** Idempotent request importing host-picked patch files as a new shelf. */
export type ShelfImportPatchMessage = Extract<OutboundMessage, { type: "shelfImportPatch" }>;
/** CAS-protected whole-shelf flattened patch export request. */
export type ShelfExportPatchMessage = Extract<OutboundMessage, { type: "shelfExportPatch" }> & {
    changeIds: string[];
};
/** Catalog-CAS deletion request for selected already-unshelved ghosts. */
export type ShelfCleanUpMessage = Extract<OutboundMessage, { type: "shelfCleanUp" }>;
/** Non-mutating request opening the host-owned shelf merge editor. */
export type ShelfOpenConflictEditorMessage = Extract<
    OutboundMessage,
    { type: "shelfOpenConflictEditor" }
>;
/** CAS-protected structural shelf-conflict resolution. */
export type ShelfResolveStructuralMessage = Extract<
    OutboundMessage,
    { type: "shelfResolveStructural" }
>;

/** Typed result rendered after one shelf mutation completes. */
export interface ShelfMutationOutcome {
    requestId: string;
    status: ShelfMutationStatus;
    entries: PerEntryResult[];
    message?: string;
    shelfId?: string;
    newGeneration?: number;
}

/** Authoritative shelf snapshot plus host-routed UI callbacks. */
export interface ShelfTabProps {
    repositoryRoot?: string;
    shelves: ShelfEntry[];
    shelfFiles: ShelfFileEntry[];
    selectedShelfId: string | null;
    catalogGeneration: number;
    outcome?: ShelfMutationOutcome;
    /** Error text returned by the host for the current rename; rendered unchanged. */
    groupByDir?: boolean;
    onSelect: (message: ShelfSelectMessage) => void;
    onUnshelve: (message: ShelfUnshelveMessage) => void;
    onUnshelveSilently?: (message: ShelfUnshelveMessage) => void;
    onRename: (message: ShelfRenameMessage) => void;
    onDelete: (message: ShelfDeleteMessage) => void;
    onShowDiff: (message: ShelfDiffMessage) => void;
    onCompareWithLocal: (message: ShelfCompareWithLocalMessage) => void;
    onRestoreGhost: (message: ShelfRestoreGhostMessage) => void;
    onImportPatch: (message: ShelfImportPatchMessage) => void;
    onExportPatch: (message: ShelfExportPatchMessage) => void;
    onCleanUp: (message: ShelfCleanUpMessage) => void;
    onOpenConflictEditor: (message: ShelfOpenConflictEditorMessage) => void;
    onResolveStructural: (message: ShelfResolveStructuralMessage) => void;
    onDragOver?: (event: React.DragEvent<HTMLElement>) => void;
    onDrop?: (event: React.DragEvent<HTMLElement>) => void;
    onShelfEntryDragStart?: (
        event: React.DragEvent<HTMLElement>,
        input: { shelfId: string; generation: number; changeIds: string[] },
    ) => void;
}

interface ShelfContextMenuState {
    shelf: ShelfEntry;
    x: number;
    y: number;
}

const MIN_SHELF_LIST_HEIGHT = 100;
const SHELF_LOWER_PANE_RESERVED_HEIGHT = 166;
const SHELF_SPLITTER_STEP = 10;
let shelfRequestSequence = 0;

function nextRequestId(): string {
    shelfRequestSequence += 1;
    return `shelf-mutation-${shelfRequestSequence}`;
}

function statusMessage(status: ShelfMutationStatus): string {
    return {
        ok: "Shelf mutation completed.",
        partial: "Shelf mutation partially completed.",
        conflicts: "Shelf mutation completed with conflicts.",
        staleShelf: "Shelf changed before this mutation.",
        staleCatalog: "Shelf catalog changed before this mutation.",
        busy: "Shelf mutation is busy.",
        recoveryFull: "Shelf recovery storage is full.",
        error: "Shelf mutation failed.",
    }[status];
}

function resultMessage(result: PerEntryResult): string {
    switch (result.kind) {
        case "applied":
            return "applied";
        case "conflicted":
            return "conflicted";
        case "retained":
            return `retained: ${result.reason}`;
        case "flattenedResidue":
            return "flattenedResidue";
        case "refused":
            return `refused: ${result.reason}`;
        case "structuralPending":
            return `structuralPending: ${result.reason}`;
    }
}

function shelfRowDragStart(
    onShelfEntryDragStart: ShelfTabProps["onShelfEntryDragStart"],
    selectedShelf: ShelfEntry | null,
    shelfFiles: ShelfFileEntry[],
) {
    if (
        !onShelfEntryDragStart ||
        !selectedShelf ||
        selectedShelf.metadata.lifecycle === "applied"
    ) {
        return undefined;
    }
    return (event: React.DragEvent<HTMLElement>, shelf: ShelfEntry): void => {
        onShelfEntryDragStart(event, {
            shelfId: shelf.id,
            generation: shelf.generation,
            changeIds: shelfFiles.map((entry) => entry.changeId),
        });
    };
}

function shelfFileDragStart(
    onShelfEntryDragStart: ShelfTabProps["onShelfEntryDragStart"],
    selectedShelf: ShelfEntry | null,
) {
    if (
        !onShelfEntryDragStart ||
        !selectedShelf ||
        selectedShelf.metadata.lifecycle === "applied"
    ) {
        return undefined;
    }
    return (event: React.DragEvent<HTMLElement>, entry: ShelfFileEntry): void => {
        onShelfEntryDragStart(event, {
            shelfId: selectedShelf.id,
            generation: selectedShelf.generation,
            changeIds: [entry.changeId],
        });
    };
}

function areShelfFilesCurrent(
    selectionOverride: string | null,
    selectedShelfId: string | null,
): boolean {
    return selectionOverride === null || selectionOverride === selectedShelfId;
}

function canUnshelveShelf(
    shelfFilesAreCurrent: boolean,
    selectedShelf: ShelfEntry | null,
    shelfFiles: ShelfFileEntry[],
): boolean {
    return (
        shelfFilesAreCurrent &&
        selectedShelf !== null &&
        selectedShelf.metadata.lifecycle !== "applied" &&
        shelfFiles.length > 0
    );
}

/** Standalone Shelf surface. Parent owns host messages and authoritative snapshots. */
export function ShelfTab({
    shelves,
    shelfFiles,
    selectedShelfId,
    catalogGeneration,
    outcome,
    groupByDir = false,
    onSelect,
    onUnshelve,
    onUnshelveSilently,
    onRename,
    onDelete,
    onShowDiff,
    onCompareWithLocal,
    onRestoreGhost,
    onImportPatch,
    onExportPatch,
    onCleanUp,
    repositoryRoot,
    onOpenConflictEditor,
    onResolveStructural,
    onDragOver,
    onDrop,
    onShelfEntryDragStart,
}: ShelfTabProps): React.ReactElement {
    const tabRef = useRef<HTMLDivElement>(null);
    const [selectionOverride, setSelectionOverride] = useState<string | null>(null);
    const [showAlreadyUnshelved, setShowAlreadyUnshelved] = useState(false);
    const [contextMenu, setContextMenu] = useState<ShelfContextMenuState | null>(null);
    const [unshelveShelf, setUnshelveShelf] = useState<ShelfEntry | null>(null);
    const [renamingShelfId, setRenamingShelfId] = useState<string | null>(null);
    const [pendingRename, setPendingRename] = useState<{
        requestId: string;
        shelfId: string;
        name: string;
        expectedGeneration: number;
    } | null>(null);
    const [deleteShelf, setDeleteShelf] = useState<ShelfEntry | null>(null);
    const [isCleanUpOpen, setIsCleanUpOpen] = useState(false);
    const [lastExportRequestId, setLastExportRequestId] = useState<string | null>(null);
    const [structuralPendingRequestId, setStructuralPendingRequestId] = useState<string | null>(
        null,
    );
    const [renameStructuralResult, setRenameStructuralResult] = useState<Extract<
        PerEntryResult,
        { kind: "structuralPending" }
    > | null>(null);
    const [listHeight, setListHeight] = useState(220);
    const [listMaxHeight, setListMaxHeight] = useState(220);
    const listHeightRef = useRef(listHeight);

    const displayedSelectedShelfId = selectionOverride ?? selectedShelfId;
    const selectedShelf = useMemo(
        () => shelves.find((shelf) => shelf.id === displayedSelectedShelfId) ?? null,
        [displayedSelectedShelfId, shelves],
    );
    const shelfFilesAreCurrent = areShelfFilesCurrent(selectionOverride, selectedShelfId);
    const canUnshelve = canUnshelveShelf(shelfFilesAreCurrent, selectedShelf, shelfFiles);
    const outcomeShelf = useMemo(
        () =>
            outcome?.shelfId
                ? (shelves.find((shelf) => shelf.id === outcome.shelfId) ?? null)
                : null,
        [outcome?.shelfId, shelves],
    );

    useEffect(() => {
        if (!pendingRename) return;
        const shelf = shelves.find((item) => item.id === pendingRename.shelfId);
        if (
            shelf &&
            (shelf.metadata.name === pendingRename.name ||
                shelf.generation > pendingRename.expectedGeneration)
        ) {
            setRenamingShelfId(null);
            setPendingRename(null);
        }
    }, [pendingRename, shelves]);

    useEffect(() => {
        if (structuralPendingRequestId && outcome?.requestId === structuralPendingRequestId) {
            setStructuralPendingRequestId(null);
        }
    }, [outcome?.requestId, structuralPendingRequestId]);

    const renameError =
        pendingRename && outcome?.requestId === pendingRename.requestId
            ? outcome.message
            : undefined;

    const constrainListHeight = useCallback((requestedHeight: number): void => {
        const containerHeight = tabRef.current?.clientHeight ?? 0;
        const maximum =
            containerHeight > 0
                ? Math.max(
                      MIN_SHELF_LIST_HEIGHT,
                      containerHeight - SHELF_LOWER_PANE_RESERVED_HEIGHT,
                  )
                : 220;
        const next = Math.max(MIN_SHELF_LIST_HEIGHT, Math.min(requestedHeight, maximum));
        listHeightRef.current = next;
        setListMaxHeight(maximum);
        setListHeight(next);
    }, []);

    useLayoutEffect(() => {
        const element = tabRef.current;
        if (!element) return;
        const syncBounds = (): void => constrainListHeight(listHeightRef.current);
        syncBounds();
        window.addEventListener("resize", syncBounds);
        const observer =
            typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncBounds);
        observer?.observe(element);
        return () => {
            window.removeEventListener("resize", syncBounds);
            observer?.disconnect();
        };
    }, [constrainListHeight]);

    const selectShelf = useCallback(
        (shelfId: string): void => {
            setSelectionOverride(shelfId);
            onSelect({ type: "shelfSelect", shelfId });
        },
        [onSelect],
    );

    const requestUnshelve = useCallback(
        (shelf: ShelfEntry, input: UnshelveDialogSubmit, silently = false): void => {
            if (input.changeIds.length === 0) return;
            const message: ShelfUnshelveMessage = {
                type: "unshelve",
                requestId: nextRequestId(),
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeIds: input.changeIds,
                removeFromShelf: input.removeFromShelf,
                mode: "flattened",
            };
            if (silently) (onUnshelveSilently ?? onUnshelve)(message);
            else onUnshelve(message);
        },
        [onUnshelve, onUnshelveSilently],
    );

    const importPatch = useCallback((): void => {
        onImportPatch({
            type: "shelfImportPatch",
            requestId: nextRequestId(),
            idempotencyToken: nextRequestId(),
            expectedCatalogGeneration: catalogGeneration,
        });
    }, [catalogGeneration, onImportPatch]);

    const exportPatch = useCallback((): void => {
        if (!selectedShelf) return;
        const requestId = nextRequestId();
        setLastExportRequestId(requestId);
        onExportPatch({
            type: "shelfExportPatch",
            requestId,
            shelfId: selectedShelf.id,
            expectedGeneration: selectedShelf.generation,
            changeIds: shelfFiles.map((entry) => entry.changeId),
        });
    }, [onExportPatch, selectedShelf, shelfFiles]);

    const resolveStructural = useCallback(
        (
            result: Extract<PerEntryResult, { kind: "structuralPending" }>,
            action: ShelfResolveStructuralMessage["action"],
            targetPath?: string,
        ): void => {
            if (!outcomeShelf || structuralPendingRequestId) return;
            const requestId = nextRequestId();
            setStructuralPendingRequestId(requestId);
            onResolveStructural({
                type: "shelfResolveStructural",
                repositoryRoot,
                requestId,
                shelfId: outcomeShelf.id,
                expectedGeneration: outcomeShelf.generation,
                changeId: result.changeId,
                expectedPathFingerprint: result.pathFingerprint,
                action,
                ...(targetPath ? { targetPath } : {}),
            });
        },
        [onResolveStructural, outcomeShelf, repositoryRoot, structuralPendingRequestId],
    );

    const openContextMenu = useCallback(
        (shelf: ShelfEntry, x: number, y: number): void => {
            selectShelf(shelf.id);
            setContextMenu({ shelf, x, y });
        },
        [selectShelf],
    );

    const handleContextAction = useCallback(
        (shelf: ShelfEntry, action: ShelfContextAction): void => {
            if (!shelfFilesAreCurrent && (action === "unshelve" || action === "unshelveSilently")) {
                return;
            }
            if (action === "unshelve") {
                setUnshelveShelf(shelf);
                return;
            }
            if (action === "unshelveSilently") {
                requestUnshelve(
                    shelf,
                    { changeIds: shelfFiles.map((entry) => entry.changeId), removeFromShelf: true },
                    true,
                );
                return;
            }
            if (action === "rename") {
                setRenamingShelfId(shelf.id);
                return;
            }
            if (action === "delete") {
                setDeleteShelf(shelf);
                return;
            }
            if (action === "showDiff") {
                onShowDiff({
                    type: "shelfDiff",
                    shelfId: shelf.id,
                    expectedGeneration: shelf.generation,
                });
                return;
            }
            if (action === "compareWithLocal") {
                onCompareWithLocal({
                    type: "shelfCompareWithLocal",
                    shelfId: shelf.id,
                    expectedGeneration: shelf.generation,
                });
                return;
            }
            onRestoreGhost({
                type: "shelfRestoreGhost",
                requestId: nextRequestId(),
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
            });
        },
        [
            onCompareWithLocal,
            onRestoreGhost,
            onShowDiff,
            requestUnshelve,
            shelfFiles,
            shelfFilesAreCurrent,
        ],
    );

    const handleShelfRowDragStart = shelfRowDragStart(
        onShelfEntryDragStart,
        selectedShelf,
        shelfFiles,
    );
    const handleShelfFileDragStart = shelfFileDragStart(onShelfEntryDragStart, selectedShelf);

    const activeContextItems = [
        { label: "Unshelve…", action: "unshelve", disabled: !shelfFilesAreCurrent },
        {
            label: "Unshelve Silently",
            action: "unshelveSilently",
            disabled: !shelfFilesAreCurrent,
        },
        { label: "Rename", action: "rename" },
        { label: "Delete", action: "delete" },
        { label: "", action: "shelf-divider", separator: true },
        { label: "Show Diff", action: "showDiff" },
        { label: "Compare with Local", action: "compareWithLocal" },
    ];

    return (
        <Flex
            ref={tabRef}
            data-testid="shelf-tab"
            direction="column"
            flex={1}
            minH={0}
            overflow="hidden"
            bg="var(--intelligit-pycharm-panel)"
            color="var(--intelligit-pycharm-foreground)"
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            <ShelfList
                shelves={shelves}
                selectedShelfId={displayedSelectedShelfId}
                showAlreadyUnshelved={showAlreadyUnshelved}
                height={listHeight}
                maxHeight={`calc(100% - ${SHELF_LOWER_PANE_RESERVED_HEIGHT}px)`}
                renamingShelfId={renamingShelfId}
                renameError={renameError}
                onSelect={selectShelf}
                onContextMenu={(shelf, x, y) => openContextMenu(shelf, x, y)}
                onRenameSubmit={(shelf, name) => {
                    const requestId = nextRequestId();
                    setPendingRename({
                        requestId,
                        shelfId: shelf.id,
                        name,
                        expectedGeneration: shelf.generation,
                    });
                    onRename({
                        type: "shelfRename",
                        requestId,
                        shelfId: shelf.id,
                        expectedGeneration: shelf.generation,
                        name,
                    });
                }}
                onRenameCancel={() => {
                    setRenamingShelfId(null);
                    setPendingRename(null);
                }}
                onRestore={(shelf) => handleContextAction(shelf, "restore")}
                dragEnabledShelfId={
                    shelfFilesAreCurrent && selectedShelf?.metadata.lifecycle !== "applied"
                        ? selectedShelf?.id
                        : null
                }
                onDragStart={handleShelfRowDragStart}
            />
            <Box
                data-testid="shelf-splitter"
                role="separator"
                aria-label="Resize shelf list"
                aria-orientation="horizontal"
                aria-valuemin={MIN_SHELF_LIST_HEIGHT}
                aria-valuemax={listMaxHeight}
                aria-valuenow={listHeight}
                tabIndex={0}
                h="4px"
                flexShrink={0}
                cursor="row-resize"
                bg="var(--intelligit-pycharm-border)"
                onKeyDown={(event) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    constrainListHeight(
                        listHeightRef.current +
                            (event.key === "ArrowDown"
                                ? SHELF_SPLITTER_STEP
                                : -SHELF_SPLITTER_STEP),
                    );
                }}
            />
            <ShelfToolbar
                canUnshelve={canUnshelve}
                hasSelectedShelf={selectedShelf !== null}
                canExportPatch={selectedShelf !== null && shelfFilesAreCurrent}
                showAlreadyUnshelved={showAlreadyUnshelved}
                onUnshelve={() => selectedShelf && setUnshelveShelf(selectedShelf)}
                onUnshelveSilently={() => {
                    if (!selectedShelf) return;
                    requestUnshelve(
                        selectedShelf,
                        {
                            changeIds: shelfFiles.map((entry) => entry.changeId),
                            removeFromShelf: true,
                        },
                        true,
                    );
                }}
                onShowDiff={() => selectedShelf && handleContextAction(selectedShelf, "showDiff")}
                onCompareWithLocal={() =>
                    selectedShelf && handleContextAction(selectedShelf, "compareWithLocal")
                }
                onRename={() => selectedShelf && setRenamingShelfId(selectedShelf.id)}
                onDelete={() => selectedShelf && setDeleteShelf(selectedShelf)}
                onToggleAlreadyUnshelved={() => setShowAlreadyUnshelved((value) => !value)}
                onImportPatch={importPatch}
                onExportPatch={exportPatch}
                onCleanUp={() => setIsCleanUpOpen(true)}
            />
            <Box
                role="region"
                aria-label="Shelf mutation outcome"
                flex={1}
                minH="80px"
                overflowY="auto"
                p="10px"
                fontSize="12px"
            >
                {outcome ? (
                    <>
                        <Box data-testid="shelf-mutation-status" fontWeight={600}>
                            {outcome.status}: {statusMessage(outcome.status)}
                        </Box>
                        {outcome.entries.map((result) => (
                            <Box key={`${result.changeId}-${result.kind}`} mt="3px">
                                {result.changeId}: {resultMessage(result)}
                                {result.kind === "conflicted" && outcomeShelf ? (
                                    <Button
                                        ml="6px"
                                        size="xs"
                                        variant="secondary"
                                        onClick={() =>
                                            onOpenConflictEditor({
                                                type: "shelfOpenConflictEditor",
                                                repositoryRoot,
                                                shelfId: outcomeShelf.id,
                                                changeId: result.changeId,
                                            })
                                        }
                                    >
                                        Merge…
                                    </Button>
                                ) : null}
                                {result.kind === "structuralPending" && outcomeShelf ? (
                                    <Flex as="span" display="inline-flex" gap="4px" ml="6px">
                                        <Button
                                            size="xs"
                                            variant="secondary"
                                            isDisabled={structuralPendingRequestId !== null}
                                            onClick={() => resolveStructural(result, "keepLocal")}
                                        >
                                            Keep Local
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="secondary"
                                            isDisabled={structuralPendingRequestId !== null}
                                            onClick={() => resolveStructural(result, "useShelved")}
                                        >
                                            Use Shelved
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="secondary"
                                            isDisabled={structuralPendingRequestId !== null}
                                            onClick={() => resolveStructural(result, "deleteLocal")}
                                        >
                                            Delete Local
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="secondary"
                                            isDisabled={structuralPendingRequestId !== null}
                                            onClick={() => setRenameStructuralResult(result)}
                                        >
                                            Rename Local…
                                        </Button>
                                    </Flex>
                                ) : null}
                            </Box>
                        ))}
                        {outcome.requestId === lastExportRequestId &&
                        outcome.status === "ok" &&
                        !outcome.message ? (
                            <Box mt="3px">
                                Exported patch is flattened; staging metadata is not preserved.
                            </Box>
                        ) : null}
                    </>
                ) : (
                    <Box color="var(--intelligit-pycharm-muted)">Select a shelf action.</Box>
                )}
            </Box>
            {shelfFilesAreCurrent ? (
                <ShelfFilePane
                    entries={shelfFiles}
                    groupByDir={groupByDir}
                    onFileActivate={(entry) => {
                        if (!selectedShelf) return;
                        onShowDiff({
                            type: "shelfDiff",
                            shelfId: selectedShelf.id,
                            expectedGeneration: selectedShelf.generation,
                            changeId: entry.changeId,
                        });
                    }}
                    onDragStart={handleShelfFileDragStart}
                />
            ) : (
                <Box
                    role="status"
                    flex={1}
                    minH="80px"
                    px="12px"
                    py="6px"
                    fontSize="12px"
                    color="var(--intelligit-pycharm-muted)"
                >
                    Loading shelf files…
                </Box>
            )}
            {contextMenu ? (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    minWidth={220}
                    onClose={() => setContextMenu(null)}
                    onSelect={(action) =>
                        handleContextAction(contextMenu.shelf, action as ShelfContextAction)
                    }
                    items={
                        contextMenu.shelf.metadata.lifecycle === "applied"
                            ? [
                                  { label: "Restore", action: "restore" },
                                  { label: "Show Diff", action: "showDiff" },
                                  { label: "Compare with Local", action: "compareWithLocal" },
                                  { label: "Delete", action: "delete" },
                              ]
                            : activeContextItems
                    }
                />
            ) : null}
            {unshelveShelf ? (
                <UnshelveDialog
                    entries={shelfFiles}
                    onClose={() => setUnshelveShelf(null)}
                    onSubmit={(input) => {
                        requestUnshelve(unshelveShelf, input);
                        setUnshelveShelf(null);
                    }}
                />
            ) : null}
            {deleteShelf ? (
                <ShelfDeleteConfirmation
                    shelf={deleteShelf}
                    onClose={() => setDeleteShelf(null)}
                    onConfirm={() => {
                        onDelete({
                            type: "shelfDelete",
                            requestId: nextRequestId(),
                            shelfId: deleteShelf.id,
                            expectedGeneration: deleteShelf.generation,
                        });
                        setDeleteShelf(null);
                    }}
                />
            ) : null}
            {isCleanUpOpen ? (
                <CleanUpDialog
                    shelves={shelves}
                    onClose={() => setIsCleanUpOpen(false)}
                    onSubmit={(shelfIds) => {
                        onCleanUp({
                            type: "shelfCleanUp",
                            requestId: nextRequestId(),
                            shelfIds,
                            expectedCatalogGeneration: catalogGeneration,
                        });
                        setIsCleanUpOpen(false);
                    }}
                />
            ) : null}
            {renameStructuralResult ? (
                <RenameStructuralDialog
                    path={renameStructuralResult.path}
                    onClose={() => setRenameStructuralResult(null)}
                    onConfirm={(targetPath) => {
                        resolveStructural(renameStructuralResult, "renameLocal", targetPath);
                        setRenameStructuralResult(null);
                    }}
                />
            ) : null}
        </Flex>
    );
}
