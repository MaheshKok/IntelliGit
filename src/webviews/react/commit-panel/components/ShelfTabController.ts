import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
    PerEntryResult,
    ShelfEntry,
    ShelfFileView,
} from "../../../protocol/commitPanelMessages";
import type { WorkingFile } from "../../../../types";
import { directoryKey, toggleMember } from "../../shared/treeExpansion";
import type { ShelfContextAction } from "./ShelfRow";
import { shelfRowDragStart } from "./shelfDrag";
import type { UnshelveDialogSubmit } from "./UnshelveDialog";
import type { ShelfMutationOutcome, ShelfTabProps } from "./ShelfTabTypes";

const isMacWebview =
    typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent + navigator.platform);
let shelfRequestSequence = 0;

/** Creates a client-local identifier for one shelf mutation request. */
function nextRequestId(): string {
    shelfRequestSequence += 1;
    return `shelf-mutation-${shelfRequestSequence}`;
}

/** File-tree data enriched with its immutable shelf entry. */
type ShelfDisplayFile = WorkingFile & { shelfEntry: ShelfFileView };

type CachedShelfDisplayFiles = {
    source: ShelfEntry["files"];
    files: ShelfDisplayFile[];
};

interface ShelfFileSelection {
    shelfId: string;
    changeId: string;
}

interface PendingRename {
    requestId: string;
    shelfId: string;
    name: string;
    expectedGeneration: number;
}

interface ShelfContextMenuState {
    shelf: ShelfEntry;
    targetChangeId?: string;
    x: number;
    y: number;
    returnFocusTarget: HTMLElement;
}

interface ShelfTabState {
    selectionOverride: string | null;
    fileSelection: ShelfFileSelection | null;
    showAlreadyUnshelved: boolean;
    contextMenu: ShelfContextMenuState | null;
    expandedShelfIds: ReadonlySet<string>;
    collapsedDirectories: ReadonlySet<string>;
    unshelveShelf: ShelfEntry | null;
    renamingShelfId: string | null;
    pendingRename: PendingRename | null;
    deleteShelf: ShelfEntry | null;
    isCleanUpOpen: boolean;
    lastExportRequestId: string | null;
    structuralPendingRequestId: string | null;
    renameStructuralResult: Extract<PerEntryResult, { kind: "structuralPending" }> | null;
}

type ShelfTabAction =
    | { type: "setSelectionOverride"; value: string | null }
    | { type: "setFileSelection"; value: ShelfFileSelection | null }
    | { type: "setShowAlreadyUnshelved"; value: boolean }
    | { type: "setContextMenu"; value: ShelfContextMenuState | null }
    | { type: "setExpandedShelfIds"; value: ReadonlySet<string> }
    | { type: "setCollapsedDirectories"; value: ReadonlySet<string> }
    | { type: "setUnshelveShelf"; value: ShelfEntry | null }
    | { type: "setRenamingShelfId"; value: string | null }
    | { type: "setPendingRename"; value: PendingRename | null }
    | { type: "setDeleteShelf"; value: ShelfEntry | null }
    | { type: "setIsCleanUpOpen"; value: boolean }
    | { type: "setLastExportRequestId"; value: string | null }
    | { type: "setStructuralPendingRequestId"; value: string | null }
    | {
          type: "setRenameStructuralResult";
          value: Extract<PerEntryResult, { kind: "structuralPending" }> | null;
      };

/** Creates isolated set instances for each rendered shelf tab. */
function createInitialShelfTabState(): ShelfTabState {
    return {
        selectionOverride: null,
        fileSelection: null,
        showAlreadyUnshelved: false,
        contextMenu: null,
        expandedShelfIds: new Set<string>(),
        collapsedDirectories: new Set<string>(),
        unshelveShelf: null,
        renamingShelfId: null,
        pendingRename: null,
        deleteShelf: null,
        isCleanUpOpen: false,
        lastExportRequestId: null,
        structuralPendingRequestId: null,
        renameStructuralResult: null,
    };
}

/** Updates related shelf selection, expansion, dialog, and mutation UI state. */
function shelfTabReducer(state: ShelfTabState, action: ShelfTabAction): ShelfTabState {
    switch (action.type) {
        case "setSelectionOverride":
            return { ...state, selectionOverride: action.value };
        case "setFileSelection":
            return { ...state, fileSelection: action.value };
        case "setShowAlreadyUnshelved":
            return { ...state, showAlreadyUnshelved: action.value };
        case "setContextMenu":
            return { ...state, contextMenu: action.value };
        case "setExpandedShelfIds":
            return { ...state, expandedShelfIds: action.value };
        case "setCollapsedDirectories":
            return { ...state, collapsedDirectories: action.value };
        case "setUnshelveShelf":
            return { ...state, unshelveShelf: action.value };
        case "setRenamingShelfId":
            return { ...state, renamingShelfId: action.value };
        case "setPendingRename":
            return { ...state, pendingRename: action.value };
        case "setDeleteShelf":
            return { ...state, deleteShelf: action.value };
        case "setIsCleanUpOpen":
            return { ...state, isCleanUpOpen: action.value };
        case "setLastExportRequestId":
            return { ...state, lastExportRequestId: action.value };
        case "setStructuralPendingRequestId":
            return { ...state, structuralPendingRequestId: action.value };
        case "setRenameStructuralResult":
            return { ...state, renameStructuralResult: action.value };
    }
}

/** Maps one immutable shelf file into the shared working-file tree shape. */
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

/** Returns a selected file only while its shelf is expanded and still contains it. */
function liveFileSelection(
    selection: ShelfFileSelection | null,
    shelves: readonly ShelfEntry[],
    expandedShelfIds: ReadonlySet<string>,
): ShelfFileSelection | null {
    if (selection === null || !expandedShelfIds.has(selection.shelfId)) return null;
    const shelf = shelves.find((entry) => entry.id === selection.shelfId);
    return shelf?.files.some((file) => file.changeId === selection.changeId) === true
        ? selection
        : null;
}

/** Hides routine successful outcomes while retaining failures and flattening notices. */
function reportableOutcome(
    outcome: ShelfMutationOutcome | undefined,
    lastExportRequestId: string | null,
): ShelfMutationOutcome | undefined {
    if (outcome === undefined) return undefined;
    if (outcome.status !== "ok") return outcome;
    if (outcome.entries.some((entry) => entry.kind !== "applied")) return outcome;
    return outcome.requestId === lastExportRequestId && !outcome.message ? outcome : undefined;
}

/** All local state, derived values, and callbacks consumed by the shelf tab view. */
export interface ShelfTabController {
    canUnshelve: boolean;
    collapsedDirectories: ReadonlySet<string>;
    contextMenu: ShelfContextMenuState | null;
    dialogFocusTargetRef: React.MutableRefObject<HTMLElement | null>;
    displayedSelectedShelfId: string | null;
    expandedShelfIds: ReadonlySet<string>;
    isCleanUpOpen: boolean;
    isMacWebview: boolean;
    lastExportRequestId: string | null;
    outcomeShelf: ShelfEntry | null;
    renameError: string | undefined;
    renameStructuralResult: Extract<PerEntryResult, { kind: "structuralPending" }> | null;
    renamingShelfId: string | null;
    reportedOutcome: ShelfMutationOutcome | undefined;
    selectedFile: ShelfFileSelection | null;
    shelfDisplayFilesById: Map<string, CachedShelfDisplayFiles>;
    showAlreadyUnshelved: boolean;
    structuralPendingRequestId: string | null;
    unshelveShelf: ShelfEntry | null;
    deleteShelf: ShelfEntry | null;
    selectShelf: (shelfId: string) => void;
    toggleShelfExpansion: (shelfId: string) => void;
    toggleDirectory: (shelfId: string, dirPath: string) => void;
    expandAll: () => void;
    collapseAll: () => void;
    toggleAlreadyUnshelved: () => void;
    openCleanUp: () => void;
    onFileSelect: (shelf: ShelfEntry, file: ShelfDisplayFile) => void;
    onFileActivate: (shelf: ShelfEntry, file: ShelfDisplayFile) => void;
    onFileContextMenu: (
        shelf: ShelfEntry,
        file: ShelfDisplayFile,
        x: number,
        y: number,
        target: HTMLElement,
    ) => void;
    openContextMenu: (shelf: ShelfEntry, x: number, y: number, target: HTMLElement) => void;
    closeContextMenu: () => void;
    handleContextAction: (
        shelf: ShelfEntry,
        action: ShelfContextAction,
        targetChangeId?: string,
    ) => void;
    onRenameSubmit: (shelf: ShelfEntry, name: string) => void;
    onRenameCancel: () => void;
    handleShelfRowDragStart: ReturnType<typeof shelfRowDragStart>;
    handleShelfShortcut: (event: React.KeyboardEvent<HTMLElement>) => void;
    closeUnshelve: () => void;
    submitUnshelve: (input: UnshelveDialogSubmit) => void;
    closeDelete: () => void;
    confirmDelete: () => void;
    closeCleanUp: () => void;
    submitCleanUp: (shelfIds: string[]) => void;
    closeRenameStructural: () => void;
    openRenameStructural: (result: Extract<PerEntryResult, { kind: "structuralPending" }>) => void;
    confirmRenameStructural: (targetPath: string) => void;
    resolveStructural: (
        result: Extract<PerEntryResult, { kind: "structuralPending" }>,
        action: Extract<
            import("../../../protocol/commitPanelMessages").OutboundMessage,
            { type: "shelfResolveStructural" }
        >["action"],
        targetPath?: string,
    ) => void;
}

/** Owns local shelf UI workflow state while preserving host-owned snapshots and mutations. */
export function useShelfTabController(props: ShelfTabProps): ShelfTabController {
    const [state, dispatch] = useReducer(shelfTabReducer, undefined, createInitialShelfTabState);
    const dialogFocusTargetRef = useRef<HTMLElement | null>(null);
    const shelfDisplayFilesCacheRef = useRef<Map<string, CachedShelfDisplayFiles> | null>(null);
    if (shelfDisplayFilesCacheRef.current === null) {
        shelfDisplayFilesCacheRef.current = new Map<string, CachedShelfDisplayFiles>();
    }
    const shelfDisplayFilesCache = shelfDisplayFilesCacheRef.current;
    const displayedSelectedShelfId = state.selectionOverride ?? props.selectedShelfId;
    const selectedFile = liveFileSelection(
        state.fileSelection,
        props.shelves,
        state.expandedShelfIds,
    );
    const shelfDisplayFilesById = useMemo(() => {
        const next = new Map<string, CachedShelfDisplayFiles>();
        for (const shelf of props.shelves) {
            const cached = shelfDisplayFilesCache.get(shelf.id);
            next.set(
                shelf.id,
                cached?.source === shelf.files
                    ? cached
                    : { source: shelf.files, files: shelf.files.map(displayFile) },
            );
        }
        return next;
    }, [props.shelves, shelfDisplayFilesCache]);
    useEffect(() => {
        shelfDisplayFilesCacheRef.current = shelfDisplayFilesById;
    }, [shelfDisplayFilesById]);
    const selectedShelf = useMemo(
        () => props.shelves.find((shelf) => shelf.id === displayedSelectedShelfId) ?? null,
        [displayedSelectedShelfId, props.shelves],
    );
    const outcomeShelfId = props.outcome?.shelfId;
    const outcomeShelf = useMemo(
        () =>
            outcomeShelfId
                ? (props.shelves.find((shelf) => shelf.id === outcomeShelfId) ?? null)
                : null,
        [outcomeShelfId, props.shelves],
    );
    const canUnshelve = selectedShelf !== null && selectedShelf.metadata.lifecycle !== "applied";
    const renameError =
        state.pendingRename && props.outcome?.requestId === state.pendingRename.requestId
            ? props.outcome.message
            : undefined;
    const reportedOutcome = reportableOutcome(props.outcome, state.lastExportRequestId);

    if (
        state.pendingRename !== null &&
        props.shelves.some(
            (shelf) =>
                shelf.id === state.pendingRename?.shelfId &&
                (shelf.metadata.name === state.pendingRename?.name ||
                    shelf.generation > state.pendingRename.expectedGeneration),
        )
    ) {
        dispatch({ type: "setRenamingShelfId", value: null });
        dispatch({ type: "setPendingRename", value: null });
    }
    if (
        state.structuralPendingRequestId !== null &&
        props.outcome?.requestId === state.structuralPendingRequestId
    ) {
        dispatch({ type: "setStructuralPendingRequestId", value: null });
    }

    const selectShelf = useCallback(
        (shelfId: string): void => {
            dispatch({ type: "setFileSelection", value: null });
            dispatch({ type: "setSelectionOverride", value: shelfId });
            props.onSelect({ type: "shelfSelect", shelfId });
        },
        [props],
    );
    const toggleShelfExpansion = useCallback(
        (shelfId: string): void => {
            dispatch({
                type: "setExpandedShelfIds",
                value: toggleMember(state.expandedShelfIds, shelfId),
            });
        },
        [state.expandedShelfIds],
    );
    const toggleDirectory = useCallback(
        (shelfId: string, dirPath: string): void => {
            dispatch({
                type: "setCollapsedDirectories",
                value: toggleMember(state.collapsedDirectories, directoryKey(shelfId, dirPath)),
            });
        },
        [state.collapsedDirectories],
    );
    const requestUnshelve = useCallback(
        (shelf: ShelfEntry, input: UnshelveDialogSubmit, silently = false): void => {
            if (input.changeIds.length === 0) return;
            const message = {
                type: "unshelve" as const,
                requestId: nextRequestId(),
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeIds: input.changeIds,
                removeFromShelf: input.removeFromShelf,
                mode: "flattened" as const,
            };
            if (silently) (props.onUnshelveSilently ?? props.onUnshelve)(message);
            else props.onUnshelve(message);
        },
        [props],
    );
    const importPatch = useCallback((): void => {
        props.onImportPatch({
            type: "shelfImportPatch",
            requestId: nextRequestId(),
            idempotencyToken: nextRequestId(),
            expectedCatalogGeneration: props.catalogGeneration,
        });
    }, [props]);
    const exportPatch = useCallback(
        (
            shelf: ShelfEntry = selectedShelf!,
            changeIds = shelf?.files.map((entry) => entry.changeId) ?? [],
        ): void => {
            if (!shelf || changeIds.length === 0) return;
            const requestId = nextRequestId();
            dispatch({ type: "setLastExportRequestId", value: requestId });
            props.onExportPatch({
                type: "shelfExportPatch",
                requestId,
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeIds,
            });
        },
        [props, selectedShelf],
    );
    const copyPatch = useCallback(
        (shelf: ShelfEntry, changeIds: string[]): void => {
            if (changeIds.length === 0) return;
            props.onCopyPatch({
                type: "shelfCopyPatchToClipboard",
                requestId: nextRequestId(),
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeIds,
            });
        },
        [props],
    );
    const resolveStructural = useCallback(
        (
            result: Extract<PerEntryResult, { kind: "structuralPending" }>,
            action: Extract<
                import("../../../protocol/commitPanelMessages").OutboundMessage,
                { type: "shelfResolveStructural" }
            >["action"],
            targetPath?: string,
        ): void => {
            if (!outcomeShelf || state.structuralPendingRequestId) return;
            const requestId = nextRequestId();
            dispatch({ type: "setStructuralPendingRequestId", value: requestId });
            props.onResolveStructural({
                type: "shelfResolveStructural",
                repositoryRoot: props.repositoryRoot,
                requestId,
                shelfId: outcomeShelf.id,
                expectedGeneration: outcomeShelf.generation,
                changeId: result.changeId,
                expectedPathFingerprint: result.pathFingerprint,
                action,
                ...(targetPath ? { targetPath } : {}),
            });
        },
        [outcomeShelf, props, state.structuralPendingRequestId],
    );
    const openContextMenu = useCallback(
        (
            shelf: ShelfEntry,
            x: number,
            y: number,
            returnFocusTarget: HTMLElement,
            targetChangeId?: string,
        ): void => {
            if (targetChangeId === undefined) selectShelf(shelf.id);
            dialogFocusTargetRef.current = returnFocusTarget;
            dispatch({
                type: "setContextMenu",
                value: { shelf, targetChangeId, x, y, returnFocusTarget },
            });
        },
        [selectShelf],
    );
    const handleContextAction = useCallback(
        (shelf: ShelfEntry, action: ShelfContextAction, targetChangeId?: string): void => {
            const scopedChangeIds = targetChangeId
                ? [targetChangeId]
                : shelf.files.map((entry) => entry.changeId);
            if (action === "unshelve") {
                if (canUnshelve) dispatch({ type: "setUnshelveShelf", value: shelf });
                return;
            }
            if (action === "unshelveSilently") {
                if (canUnshelve)
                    requestUnshelve(
                        shelf,
                        {
                            changeIds: shelf.files.map((entry) => entry.changeId),
                            removeFromShelf: props.shelfRemoveOnUnshelve ?? true,
                        },
                        true,
                    );
                return;
            }
            if (action === "rename")
                return void dispatch({ type: "setRenamingShelfId", value: shelf.id });
            if (action === "delete") return void dispatch({ type: "setDeleteShelf", value: shelf });
            if (action === "showDiff" || action === "showDiffNewTab") {
                props.onShowDiff({
                    type: "shelfDiff",
                    shelfId: shelf.id,
                    expectedGeneration: shelf.generation,
                    ...(targetChangeId ? { changeId: targetChangeId } : {}),
                    ...(action === "showDiffNewTab" ? { newTab: true } : {}),
                });
                return;
            }
            if (action === "compareWithLocal") {
                props.onCompareWithLocal({
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
            if (shelf.metadata.lifecycle === "applied") {
                props.onRestoreGhost({
                    type: "shelfRestoreGhost",
                    requestId: nextRequestId(),
                    shelfId: shelf.id,
                    expectedGeneration: shelf.generation,
                });
            }
        },
        [canUnshelve, copyPatch, exportPatch, importPatch, props, requestUnshelve],
    );
    const handleShelfShortcut = useCallback(
        (event: React.KeyboardEvent<HTMLElement>): void => {
            const target = event.target as HTMLElement;
            if (
                !selectedShelf ||
                state.renamingShelfId ||
                state.unshelveShelf ||
                state.deleteShelf ||
                state.isCleanUpOpen ||
                state.renameStructuralResult ||
                state.contextMenu ||
                target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') ||
                target.closest("input, textarea, select, [contenteditable='true']") ||
                target.isContentEditable
            ) {
                return;
            }
            const modifier = isMacWebview ? event.metaKey : event.ctrlKey;
            if (event.key === "F2") {
                event.preventDefault();
                dispatch({ type: "setRenamingShelfId", value: selectedShelf.id });
            } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                dialogFocusTargetRef.current = document.activeElement as HTMLElement;
                dispatch({ type: "setDeleteShelf", value: selectedShelf });
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
                dispatch({ type: "setUnshelveShelf", value: selectedShelf });
            }
        },
        [canUnshelve, handleContextAction, selectedShelf, state],
    );
    const onFileSelect = useCallback(
        (shelf: ShelfEntry, file: ShelfDisplayFile): void => {
            const entry = file.shelfEntry;
            dispatch({
                type: "setFileSelection",
                value: { shelfId: shelf.id, changeId: entry.changeId },
            });
            props.onShowDiff({
                type: "shelfDiff",
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeId: entry.changeId,
            });
        },
        [props],
    );
    const onFileActivate = useCallback(
        (shelf: ShelfEntry, file: ShelfDisplayFile): void => {
            const entry = file.shelfEntry;
            props.onShowDiff({
                type: "shelfDiff",
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                changeId: entry.changeId,
            });
        },
        [props],
    );
    const onFileContextMenu = useCallback(
        (
            shelf: ShelfEntry,
            file: ShelfDisplayFile,
            x: number,
            y: number,
            target: HTMLElement,
        ): void => {
            const entry = file.shelfEntry;
            dispatch({
                type: "setFileSelection",
                value: { shelfId: shelf.id, changeId: entry.changeId },
            });
            openContextMenu(shelf, x, y, target, entry.changeId);
        },
        [openContextMenu],
    );
    const onRenameSubmit = useCallback(
        (shelf: ShelfEntry, name: string): void => {
            const requestId = nextRequestId();
            dispatch({
                type: "setPendingRename",
                value: { requestId, shelfId: shelf.id, name, expectedGeneration: shelf.generation },
            });
            props.onRename({
                type: "shelfRename",
                requestId,
                shelfId: shelf.id,
                expectedGeneration: shelf.generation,
                name,
            });
        },
        [props],
    );

    return {
        ...state,
        canUnshelve,
        dialogFocusTargetRef,
        displayedSelectedShelfId,
        isMacWebview,
        outcomeShelf,
        renameError,
        reportedOutcome,
        selectedFile,
        shelfDisplayFilesById,
        selectShelf,
        toggleShelfExpansion,
        toggleDirectory,
        expandAll: () => {
            dispatch({
                type: "setExpandedShelfIds",
                value: new Set(props.shelves.map((shelf) => shelf.id)),
            });
            dispatch({ type: "setCollapsedDirectories", value: new Set() });
        },
        collapseAll: () => {
            dispatch({ type: "setExpandedShelfIds", value: new Set() });
            dispatch({ type: "setCollapsedDirectories", value: new Set() });
        },
        toggleAlreadyUnshelved: () =>
            dispatch({ type: "setShowAlreadyUnshelved", value: !state.showAlreadyUnshelved }),
        openCleanUp: () => {
            dialogFocusTargetRef.current = document.activeElement as HTMLElement;
            dispatch({ type: "setIsCleanUpOpen", value: true });
        },
        onFileSelect,
        onFileActivate,
        onFileContextMenu,
        openContextMenu: (shelf, x, y, target) => openContextMenu(shelf, x, y, target),
        closeContextMenu: () => dispatch({ type: "setContextMenu", value: null }),
        handleContextAction,
        onRenameSubmit,
        onRenameCancel: () => {
            dispatch({ type: "setRenamingShelfId", value: null });
            dispatch({ type: "setPendingRename", value: null });
        },
        handleShelfRowDragStart: shelfRowDragStart(props.onShelfEntryDragStart),
        handleShelfShortcut,
        closeUnshelve: () => dispatch({ type: "setUnshelveShelf", value: null }),
        submitUnshelve: (input) => {
            if (state.unshelveShelf) requestUnshelve(state.unshelveShelf, input);
            dispatch({ type: "setUnshelveShelf", value: null });
        },
        closeDelete: () => dispatch({ type: "setDeleteShelf", value: null }),
        confirmDelete: () => {
            if (state.deleteShelf) {
                props.onDelete({
                    type: "shelfDelete",
                    requestId: nextRequestId(),
                    shelfId: state.deleteShelf.id,
                    expectedGeneration: state.deleteShelf.generation,
                });
            }
            dispatch({ type: "setDeleteShelf", value: null });
        },
        closeCleanUp: () => dispatch({ type: "setIsCleanUpOpen", value: false }),
        submitCleanUp: (shelfIds) => {
            props.onCleanUp({
                type: "shelfCleanUp",
                requestId: nextRequestId(),
                shelfIds,
                expectedCatalogGeneration: props.catalogGeneration,
            });
            dispatch({ type: "setIsCleanUpOpen", value: false });
        },
        closeRenameStructural: () => dispatch({ type: "setRenameStructuralResult", value: null }),
        openRenameStructural: (result) => {
            dialogFocusTargetRef.current = document.activeElement as HTMLElement;
            dispatch({ type: "setRenameStructuralResult", value: result });
        },
        confirmRenameStructural: (targetPath) => {
            if (state.renameStructuralResult) {
                resolveStructural(state.renameStructuralResult, "renameLocal", targetPath);
            }
            dispatch({ type: "setRenameStructuralResult", value: null });
        },
        resolveStructural,
    };
}
