import type React from "react";
import type { ShelfFileEntry } from "../../../../shelf/model";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";

type ShelfEntryDragStart = (
    event: React.DragEvent<HTMLElement>,
    input: { shelfId: string; generation: number; changeIds: string[] },
) => void;

/** Returns a whole-shelf drag handler only for a current non-applied shelf. */
export function shelfRowDragStart(
    onShelfEntryDragStart: ShelfEntryDragStart | undefined,
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

/** Returns a single-entry drag handler only for a current non-applied shelf. */
export function shelfFileDragStart(
    onShelfEntryDragStart: ShelfEntryDragStart | undefined,
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
