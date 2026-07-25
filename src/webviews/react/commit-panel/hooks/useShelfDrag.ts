import { useCallback } from "react";
import type React from "react";
import type { WorkingFile } from "../../../../types";
import type { OutboundMessage } from "../../../protocol/commitPanelMessages";
import { t } from "../../shared/i18n";

/** MIME type for Commit-tab file selections dragged toward a shelf target. */
export const SHELF_FILES_DRAG_MIME = "application/x-intelligit-shelf-files";
/** MIME type for shelf entries dragged toward a Commit-tab target. */
export const SHELF_ENTRIES_DRAG_MIME = "application/x-intelligit-shelf-entries";

interface ShelfFilesDragPayload {
    repositoryRoot: string;
    paths: string[];
}

interface ShelfEntriesDragPayload {
    repositoryRoot: string;
    shelfId: string;
    generation: number;
    changeIds: string[];
}

interface ShelfEntryDragInput {
    shelfId: string;
    generation: number;
    changeIds: string[];
}

interface UseShelfDragOptions {
    repositoryRoot?: string;
    catalogGeneration: number;
    onMessage: (message: OutboundMessage) => void;
    removeOnUnshelve?: boolean;
}

let requestSequence = 0;

function nextRequestId(): string {
    requestSequence += 1;
    return `shelf-drag-${Date.now()}-${requestSequence}`;
}

function readPayload<T>(dataTransfer: DataTransfer, mime: string): T | undefined {
    const raw = dataTransfer.getData(mime);
    if (!raw) return undefined;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

function isFilesPayload(value: unknown): value is ShelfFilesDragPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const payload = value as Partial<ShelfFilesDragPayload>;
    return (
        typeof payload.repositoryRoot === "string" &&
        Array.isArray(payload.paths) &&
        payload.paths.length > 0 &&
        payload.paths.every((path) => typeof path === "string" && path.length > 0)
    );
}

function isEntriesPayload(value: unknown): value is ShelfEntriesDragPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const payload = value as Partial<ShelfEntriesDragPayload>;
    return (
        typeof payload.repositoryRoot === "string" &&
        typeof payload.shelfId === "string" &&
        Number.isSafeInteger(payload.generation) &&
        Array.isArray(payload.changeIds) &&
        payload.changeIds.length > 0 &&
        payload.changeIds.every((id) => typeof id === "string" && id.length > 0)
    );
}

/**
 * Owns root-bound Shelf drag payloads and translates accepted drops into the
 * existing webview shelf protocol. Targets reject foreign-root payloads inertly.
 */
export function useShelfDrag({
    repositoryRoot,
    catalogGeneration,
    onMessage,
    removeOnUnshelve = true,
}: UseShelfDragOptions) {
    const onCommitFileDragStart = useCallback(
        (
            event: React.DragEvent<HTMLElement>,
            file: WorkingFile,
            checkedPaths: ReadonlySet<string>,
        ): void => {
            if (!repositoryRoot) return;
            const paths = checkedPaths.has(file.path) ? Array.from(checkedPaths) : [file.path];
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setData(
                SHELF_FILES_DRAG_MIME,
                JSON.stringify({ repositoryRoot, paths } satisfies ShelfFilesDragPayload),
            );
        },
        [repositoryRoot],
    );

    const onShelfEntryDragStart = useCallback(
        (event: React.DragEvent<HTMLElement>, input: ShelfEntryDragInput): void => {
            if (!repositoryRoot || input.changeIds.length === 0) return;
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setData(
                SHELF_ENTRIES_DRAG_MIME,
                JSON.stringify({ repositoryRoot, ...input } satisfies ShelfEntriesDragPayload),
            );
        },
        [repositoryRoot],
    );

    const onShelfDragOver = useCallback((event: React.DragEvent<HTMLElement>): void => {
        if (!Array.from(event.dataTransfer.types).includes(SHELF_FILES_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = event.ctrlKey ? "copy" : "move";
    }, []);

    const onShelfDrop = useCallback(
        (event: React.DragEvent<HTMLElement>): void => {
            const payload = readPayload<unknown>(event.dataTransfer, SHELF_FILES_DRAG_MIME);
            if (!isFilesPayload(payload) || payload.repositoryRoot !== repositoryRoot) return;
            event.preventDefault();
            const requestId = nextRequestId();
            onMessage({
                type: "shelveSave",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                requestId,
                name: t("shelf.defaultName"),
                paths: payload.paths,
                silent: true,
                keepLocal: event.ctrlKey,
                idempotencyToken: requestId,
                expectedCatalogGeneration: catalogGeneration,
            });
        },
        [catalogGeneration, onMessage, repositoryRoot],
    );

    const onCommitDragOver = useCallback((event: React.DragEvent<HTMLElement>): void => {
        if (!Array.from(event.dataTransfer.types).includes(SHELF_ENTRIES_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = event.ctrlKey ? "copy" : "move";
    }, []);

    const onCommitDrop = useCallback(
        (event: React.DragEvent<HTMLElement>): void => {
            const payload = readPayload<unknown>(event.dataTransfer, SHELF_ENTRIES_DRAG_MIME);
            if (!isEntriesPayload(payload) || payload.repositoryRoot !== repositoryRoot) return;
            event.preventDefault();
            onMessage({
                type: "unshelve",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                requestId: nextRequestId(),
                shelfId: payload.shelfId,
                expectedGeneration: payload.generation,
                changeIds: payload.changeIds,
                removeFromShelf: event.ctrlKey ? false : removeOnUnshelve,
                mode: "flattened",
            });
        },
        [onMessage, removeOnUnshelve, repositoryRoot],
    );

    return {
        onCommitFileDragStart,
        onShelfEntryDragStart,
        onShelfDragOver,
        onShelfDrop,
        onCommitDragOver,
        onCommitDrop,
    };
}
