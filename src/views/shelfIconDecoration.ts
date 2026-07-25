// Attaches active-theme file icons to shelf manifest entries so the Shelf tree
// renders the same icons as the commit and stash trees.

import type { ShelfFileEntry } from "../shelf/model";
import type { ThemeTreeIcon } from "../types";
import type { ShelfEntry } from "../webviews/protocol/commitPanelMessages";
import type { IconThemeService } from "./shared/IconThemeService";

/**
 * Repository-relative path a shelf entry displays under.
 *
 * Mirrors the Shelf tree's own resolution: the worktree block wins, the index block covers
 * staged-only captures, and the change id remains as the last resort so a row always has a label.
 */
export function shelfFilePath(file: ShelfFileEntry): string {
    return (file.worktreeBlock ?? file.indexBlock)?.path ?? file.changeId;
}

/** Every path the shelf list can display, for folder-icon resolution. */
export function shelfFilePaths(shelves: readonly ShelfEntry[]): string[] {
    return shelves.flatMap((shelf) => shelf.files.map(shelfFilePath));
}

/** Copies each shelf with its files carrying the icon their path resolves to. */
export async function decorateShelfFiles(
    iconTheme: IconThemeService,
    shelves: readonly ShelfEntry[],
): Promise<ShelfEntry[]> {
    const decorated = await iconTheme.decorateFilePaths(
        shelfFilePaths(shelves).map((path): { path: string; icon?: ThemeTreeIcon } => ({ path })),
    );
    const iconByPath = new Map(decorated.map((item) => [item.path, item.icon]));
    return shelves.map((shelf) => ({
        ...shelf,
        files: shelf.files.map((file) => ({
            ...file,
            icon: iconByPath.get(shelfFilePath(file)),
        })),
    }));
}
