import type { DragEvent } from "react";
import type {
    OutboundMessage,
    PerEntryResult,
    ShelfEntry,
    ShelfHealthWarning,
    ShelfMutationStatus,
} from "../../../protocol/commitPanelMessages";
import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";

type ShelfSelectMessage = Extract<OutboundMessage, { type: "shelfSelect" }>;
type ShelfUnshelveMessage = Extract<OutboundMessage, { type: "unshelve" }> & {
    changeIds: string[];
    mode: "flattened";
};
type ShelfRenameMessage = Extract<OutboundMessage, { type: "shelfRename" }>;
type ShelfDeleteMessage = Extract<OutboundMessage, { type: "shelfDelete" }>;
type ShelfDiffMessage = Extract<OutboundMessage, { type: "shelfDiff" }>;
type ShelfCompareWithLocalMessage = Extract<OutboundMessage, { type: "shelfCompareWithLocal" }>;
type ShelfRestoreGhostMessage = Extract<OutboundMessage, { type: "shelfRestoreGhost" }>;
type ShelfImportPatchMessage = Extract<OutboundMessage, { type: "shelfImportPatch" }>;
type ShelfExportPatchMessage = Extract<OutboundMessage, { type: "shelfExportPatch" }> & {
    changeIds: string[];
};
type ShelfCopyPatchMessage = Extract<OutboundMessage, { type: "shelfCopyPatchToClipboard" }> & {
    changeIds: string[];
};
type ShelfCleanUpMessage = Extract<OutboundMessage, { type: "shelfCleanUp" }>;
type ShelfOpenConflictEditorMessage = Extract<OutboundMessage, { type: "shelfOpenConflictEditor" }>;
type ShelfResolveStructuralMessage = Extract<OutboundMessage, { type: "shelfResolveStructural" }>;

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
    selectedShelfId: string | null;
    catalogGeneration: number;
    shelfRemoveOnUnshelve?: boolean;
    shelfHealth?: ShelfHealthWarning[];
    outcome?: ShelfMutationOutcome;
    groupByDir?: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    isRefreshing?: boolean;
    onRefresh: () => void;
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
    onDragOver?: (event: DragEvent<HTMLElement>) => void;
    onDrop?: (event: DragEvent<HTMLElement>) => void;
    onShelfEntryDragStart?: (
        event: DragEvent<HTMLElement>,
        input: { shelfId: string; generation: number; changeIds: string[] },
    ) => void;
}
