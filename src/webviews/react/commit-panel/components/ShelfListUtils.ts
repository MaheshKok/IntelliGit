import type { ShelfEntry } from "../../../protocol/commitPanelMessages";

/** Returns whether a shelf remains active rather than an already-applied ghost. */
export function isActiveShelf(shelf: ShelfEntry): boolean {
    return shelf.metadata.lifecycle !== "applied";
}
