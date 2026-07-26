import type React from "react";
import type { ShelfFileEntry } from "../../../../shelf/model";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";

type ShelfEntryDragStart = (
    event: React.DragEvent<HTMLElement>,
    input: { shelfId: string; generation: number; changeIds: string[] },
) => void;

/** Returns a whole-shelf drag handler; every shelf carries its own files, so any of them drags. */
export function shelfRowDragStart(onShelfEntryDragStart: ShelfEntryDragStart | undefined) {
    if (!onShelfEntryDragStart) return undefined;
    return (event: React.DragEvent<HTMLElement>, shelf: ShelfEntry): void => {
        if (shelf.metadata.lifecycle === "applied") return;
        onShelfEntryDragStart(event, {
            shelfId: shelf.id,
            generation: shelf.generation,
            changeIds: shelf.files.map((entry) => entry.changeId),
        });
    };
}

/** Returns a single-entry drag handler only for a non-applied shelf. */
export function shelfFileDragStart(
    onShelfEntryDragStart: ShelfEntryDragStart | undefined,
    shelf: ShelfEntry | null,
) {
    if (!onShelfEntryDragStart || !shelf || shelf.metadata.lifecycle === "applied") {
        return undefined;
    }
    return (event: React.DragEvent<HTMLElement>, entry: ShelfFileEntry): void => {
        onShelfEntryDragStart(event, {
            shelfId: shelf.id,
            generation: shelf.generation,
            changeIds: [entry.changeId],
        });
    };
}
