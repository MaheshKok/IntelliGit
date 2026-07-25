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
import { t } from "../../shared/i18n";
import { ShelfList } from "./ShelfList";
import { resultMessage, statusMessage } from "./ShelfMessages";
import { type ShelfContextAction } from "./ShelfRow";
import { ShelfToolbar } from "./ShelfToolbar";
import { UnshelveDialog, type UnshelveDialogSubmit } from "./UnshelveDialog";
import { ShelfFilePane, shelfDirectoryPaths } from "./ShelfFilePane";
import { CleanUpDialog } from "./CleanUpDialog";
import {
    RenameStructuralDialog,
    ShelfDeleteConfirmation,
    ShelfHealthWarningBanner,
} from "./ShelfTabDialogs";
import { getShelfMenuItems } from "./shelfMenu";
import { shelfFileDragStart, shelfRowDragStart } from "./shelfDrag";

/** Selects one shelf and requests its associated file entries. */
export type ShelfSelectMessage = Extract<OutboundMessage, { type: "shelfSelect" }>;

/** Applies a non-empty flattened shelf-entry selection. */
export type ShelfUnshelveMessage = Extract<OutboundMessage, { type: "unshelve" }> & {
    changeIds: string[];
    mode: "flattened";
};

/** Renames a shelf with its expected immutable generation. */
export type ShelfRenameMessage = Extract<OutboundMessage, { type: "shelfRename" }>;
/** Deletes a shelf with its expected immutable generation. */
export type ShelfDeleteMessage = Extract<OutboundMessage, { type: "shelfDelete" }>;
/** Opens the immutable base-to-shelved diff. */
export type ShelfDiffMessage = Extract<OutboundMessage, { type: "shelfDiff" }>;
/** Opens the immutable shelved-to-local comparison. */
export type ShelfCompareWithLocalMessage = Extract<
    OutboundMessage,
    { type: "shelfCompareWithLocal" }
>;
/** Restores an applied shelf with its expected immutable generation. */
export type ShelfRestoreGhostMessage = Extract<OutboundMessage, { type: "shelfRestoreGhost" }>;
/** Idempotent request importing host-picked patch files as a new shelf. */
export type ShelfImportPatchMessage = Extract<OutboundMessage, { type: "shelfImportPatch" }>;
/** CAS-protected whole-shelf flattened patch export request. */
export type ShelfExportPatchMessage = Extract<OutboundMessage, { type: "shelfExportPatch" }> & {
    changeIds: string[];
};
/** Copies a scoped flattened shelf patch through the extension host. */
export type ShelfCopyPatchMessage = Extract<
    OutboundMessage,
    { type: "shelfCopyPatchToClipboard" }
> & { changeIds: string[] };
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
    shelfRemoveOnUnshelve?: boolean;
    shelfHealth?: import("../../../protocol/commitPanelMessages").ShelfHealthWarning[];
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
    onCopyPatch: (message: ShelfCopyPatchMessage) => void;
    onCleanUp: (message: ShelfCleanUpMessage) => void;
    onToggleGroupBy: () => void;
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
    targetChangeId?: string;
    x: number;
    y: number;
    returnFocusTarget: HTMLElement;
}
const isMacWebview =
    typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent + navigator.platform);
const MIN_SHELF_LIST_HEIGHT = 100;
const SHELF_LOWER_PANE_RESERVED_HEIGHT = 166;
const SHELF_SPLITTER_STEP = 10;
let shelfRequestSequence = 0;
function nextRequestId(): string {
    shelfRequestSequence += 1;
    return `shelf-mutation-${shelfRequestSequence}`;
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
): boolean {
    return (
        shelfFilesAreCurrent &&
        selectedShelf !== null &&
        selectedShelf.metadata.lifecycle !== "applied"
    );
}
/** Standalone Shelf surface. Parent owns host messages and authoritative snapshots. */
// eslint-disable-next-line complexity -- existing shelf action surface is intentionally kept in one host-routed component.
export function ShelfTab({
    shelves,
    shelfFiles,
    selectedShelfId,
    catalogGeneration,
    shelfRemoveOnUnshelve = true,
    shelfHealth = [],
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
    onCopyPatch,
    onCleanUp,
    onToggleGroupBy,
    repositoryRoot,
    onOpenConflictEditor,
    onResolveStructural,
    onDragOver,
    onDrop,
    onShelfEntryDragStart,
}: ShelfTabProps): React.ReactElement {
    const tabRef = useRef<HTMLDivElement>(null);
    const dialogFocusTargetRef = useRef<HTMLElement | null>(null);
    const [selectionOverride, setSelectionOverride] = useState<string | null>(null);
    const [showAlreadyUnshelved, setShowAlreadyUnshelved] = useState(false);
    const [contextMenu, setContextMenu] = useState<ShelfContextMenuState | null>(null);
    const [isFilePaneOpen, setIsFilePaneOpen] = useState(true);
    const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
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
    const canUnshelve = canUnshelveShelf(shelfFilesAreCurrent, selectedShelf);
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

    const exportPatch = useCallback(
        (
            shelf: ShelfEntry = selectedShelf!,
            changeIds = shelfFiles.map((entry) => entry.changeId),
        ): void => {
            if (!shelf || changeIds.length === 0) return;
            const requestId = nextRequestId();
            setLastExportRequestId(requestId);
            onExportPatch({
                type: "shelfExportPatch",
                requestId,
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeIds,
            });
        },
        [onExportPatch, selectedShelf, shelfFiles],
    );

    const copyPatch = useCallback(
        (shelf: ShelfEntry, changeIds: string[]): void => {
            if (changeIds.length === 0) return;
            onCopyPatch({
                type: "shelfCopyPatchToClipboard",
                requestId: nextRequestId(),
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeIds,
            });
        },
        [onCopyPatch],
    );

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
        (
            shelf: ShelfEntry,
            x: number,
            y: number,
            returnFocusTarget: HTMLElement,
            targetChangeId?: string,
        ): void => {
            selectShelf(shelf.id);
            dialogFocusTargetRef.current = returnFocusTarget;
            setContextMenu({ shelf, targetChangeId, x, y, returnFocusTarget });
        },
        [selectShelf],
    );

    const handleContextAction = useCallback(
        (shelf: ShelfEntry, action: ShelfContextAction, targetChangeId?: string): void => {
            const scopedChangeIds = targetChangeId
                ? [targetChangeId]
                : shelfFiles.map((entry) => entry.changeId);
            if (action === "unshelve") {
                if (canUnshelve) setUnshelveShelf(shelf);
                return;
            }
            if (action === "unshelveSilently") {
                if (canUnshelve)
                    requestUnshelve(
                        shelf,
                        {
                            changeIds: shelfFiles.map((entry) => entry.changeId),
                            removeFromShelf: shelfRemoveOnUnshelve,
                        },
                        true,
                    );
                return;
            }
            if (action === "rename") return void setRenamingShelfId(shelf.id);
            if (action === "delete") return void setDeleteShelf(shelf);
            if (action === "showDiff" || action === "showDiffNewTab") {
                onShowDiff({
                    type: "shelfDiff",
                    shelfId: shelf.id,
                    expectedGeneration: shelf.generation,
                    ...(targetChangeId ? { changeId: targetChangeId } : {}),
                    ...(action === "showDiffNewTab" ? { newTab: true } : {}),
                });
                return;
            }
            if (action === "compareWithLocal") {
                onCompareWithLocal({
                    type: "shelfCompareWithLocal",
                    shelfId: shelf.id,
                    expectedGeneration: shelf.generation,
                    ...(targetChangeId ? { changeId: targetChangeId } : {}),
                });
                return;
            }
            if (action === "createPatch") return void exportPatch(shelf, scopedChangeIds);
            if (action === "copyPatchToClipboard") return void copyPatch(shelf, scopedChangeIds);
            if (action === "importPatches") return void importPatch();
            if (shelf.metadata.lifecycle === "applied")
                onRestoreGhost({
                    type: "shelfRestoreGhost",
                    requestId: nextRequestId(),
                    shelfId: shelf.id,
                    expectedGeneration: shelf.generation,
                });
        },
        [
            canUnshelve,
            copyPatch,
            exportPatch,
            importPatch,
            onCompareWithLocal,
            onRestoreGhost,
            onShowDiff,
            requestUnshelve,
            shelfFiles,
            shelfRemoveOnUnshelve,
        ],
    );

    const handleShelfRowDragStart = shelfRowDragStart(
        onShelfEntryDragStart,
        selectedShelf,
        shelfFiles,
    );
    const handleShelfFileDragStart = shelfFileDragStart(onShelfEntryDragStart, selectedShelf);

    const handleShelfShortcut = useCallback(
        (event: React.KeyboardEvent<HTMLElement>): void => {
            const target = event.target as HTMLElement;
            if (
                !selectedShelf ||
                renamingShelfId ||
                unshelveShelf ||
                deleteShelf ||
                isCleanUpOpen ||
                renameStructuralResult ||
                contextMenu ||
                target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') ||
                target.closest("input, textarea, select, [contenteditable='true']") ||
                target.isContentEditable
            ) {
                return;
            }
            const modifier = isMacWebview ? event.metaKey : event.ctrlKey;
            if (event.key === "F2") {
                event.preventDefault();
                setRenamingShelfId(selectedShelf.id);
            } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                dialogFocusTargetRef.current = document.activeElement as HTMLElement;
                setDeleteShelf(selectedShelf);
            } else if (modifier && event.key.toLowerCase() === "d") {
                event.preventDefault();
                handleContextAction(selectedShelf, "showDiff");
            } else if (
                modifier &&
                event.shiftKey &&
                event.key.toLowerCase() === "u" &&
                canUnshelve
            ) {
                event.preventDefault();
                dialogFocusTargetRef.current = document.activeElement as HTMLElement;
                setUnshelveShelf(selectedShelf);
            }
        },
        [
            canUnshelve,
            contextMenu,
            deleteShelf,
            handleContextAction,
            isCleanUpOpen,
            renameStructuralResult,
            renamingShelfId,
            selectedShelf,
            unshelveShelf,
        ],
    );

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
            onKeyDown={handleShelfShortcut}
        >
            <ShelfHealthWarningBanner warnings={shelfHealth} />
            <ShelfList
                shelves={shelves}
                selectedShelfId={displayedSelectedShelfId}
                showAlreadyUnshelved={showAlreadyUnshelved}
                height={listHeight}
                maxHeight={`calc(100% - ${SHELF_LOWER_PANE_RESERVED_HEIGHT}px)`}
                renamingShelfId={renamingShelfId}
                renameError={renameError}
                onSelect={selectShelf}
                onContextMenu={(shelf, x, y, target) => openContextMenu(shelf, x, y, target)}
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
                aria-label={t("a11y.resizeShelfList")}
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
                canExpandOrCollapse={shelfFilesAreCurrent && shelfFiles.length > 0}
                groupByDir={groupByDir}
                showAlreadyUnshelved={showAlreadyUnshelved}
                onUnshelve={() => {
                    dialogFocusTargetRef.current = document.activeElement as HTMLElement;
                    if (selectedShelf) setUnshelveShelf(selectedShelf);
                }}
                onToggleGroupBy={onToggleGroupBy}
                onExpandAll={() => {
                    setIsFilePaneOpen(true);
                    setCollapsedDirectories(new Set());
                }}
                onCollapseAll={() => {
                    setIsFilePaneOpen(false);
                    setCollapsedDirectories(shelfDirectoryPaths(shelfFiles));
                }}
                onToggleAlreadyUnshelved={() => setShowAlreadyUnshelved((value) => !value)}
                onCleanUp={() => {
                    dialogFocusTargetRef.current = document.activeElement as HTMLElement;
                    setIsCleanUpOpen(true);
                }}
            />
            <Box
                role="region"
                aria-label={t("a11y.shelfMutationOutcome")}
                aria-live="polite"
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
                                        {t("shelf.action.merge")}
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
                                            {t("shelf.action.keepLocal")}
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="secondary"
                                            isDisabled={structuralPendingRequestId !== null}
                                            onClick={() => resolveStructural(result, "useShelved")}
                                        >
                                            {t("shelf.action.useShelved")}
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="secondary"
                                            isDisabled={structuralPendingRequestId !== null}
                                            onClick={() => resolveStructural(result, "deleteLocal")}
                                        >
                                            {t("shelf.action.deleteLocal")}
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="secondary"
                                            isDisabled={structuralPendingRequestId !== null}
                                            onClick={() => {
                                                dialogFocusTargetRef.current =
                                                    document.activeElement as HTMLElement;
                                                setRenameStructuralResult(result);
                                            }}
                                        >
                                            {t("shelf.action.renameLocalMenu")}
                                        </Button>
                                    </Flex>
                                ) : null}
                            </Box>
                        ))}
                        {outcome.requestId === lastExportRequestId &&
                        outcome.status === "ok" &&
                        !outcome.message ? (
                            <Box mt="3px">{t("shelf.status.exportFlattened")}</Box>
                        ) : null}
                    </>
                ) : (
                    <Box color="var(--intelligit-pycharm-muted)">
                        {t("shelf.status.selectAction")}
                    </Box>
                )}
            </Box>
            {shelfFilesAreCurrent ? (
                <ShelfFilePane
                    entries={shelfFiles}
                    groupByDir={groupByDir}
                    isOpen={isFilePaneOpen}
                    onOpenChange={setIsFilePaneOpen}
                    collapsedDirectories={collapsedDirectories}
                    onCollapsedDirectoriesChange={setCollapsedDirectories}
                    onFileActivate={(entry) => {
                        if (!selectedShelf) return;
                        onShowDiff({
                            type: "shelfDiff",
                            shelfId: selectedShelf.id,
                            expectedGeneration: selectedShelf.generation,
                            changeId: entry.changeId,
                        });
                    }}
                    onContextMenu={(entry, x, y, target) => {
                        if (selectedShelf)
                            openContextMenu(selectedShelf, x, y, target, entry.changeId);
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
                    {t("shelf.filePane.loading")}
                </Box>
            )}
            {contextMenu ? (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    minWidth={220}
                    onClose={() => setContextMenu(null)}
                    onSelect={(action) =>
                        handleContextAction(
                            contextMenu.shelf,
                            action as ShelfContextAction,
                            contextMenu.targetChangeId,
                        )
                    }
                    items={getShelfMenuItems({
                        shelf: contextMenu.shelf,
                        targetChangeId: contextMenu.targetChangeId,
                        shelfFilesAreCurrent,
                        canUnshelve,
                        canExportPatch:
                            shelfFilesAreCurrent &&
                            (contextMenu.targetChangeId !== undefined || shelfFiles.length > 0),
                        isMac: isMacWebview,
                    })}
                />
            ) : null}
            {unshelveShelf ? (
                <UnshelveDialog
                    entries={shelfFiles}
                    defaultRemoveFromShelf={shelfRemoveOnUnshelve}
                    returnFocusTarget={dialogFocusTargetRef.current}
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
                    returnFocusTarget={dialogFocusTargetRef.current}
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
                    returnFocusTarget={dialogFocusTargetRef.current}
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
                    returnFocusTarget={dialogFocusTargetRef.current}
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
