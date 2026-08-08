/**
 * Inode-sharing guard for `copyTemplate.ts` (PLAN.md step 8: "No regular file in a copy may
 * share an inode with the template -- asserted, because a hardlinked copy lets one test's
 * mutation corrupt every other").
 *
 * Deliberately a separate, independently callable function rather than inlined into
 * `copyTemplate`, following the same shape `snapshotObjectStore.ts`'s `assertAlternatesContained`
 * already establishes in this package: capture/copy stays mechanical, and the assertion is
 * callable directly by a test with a deliberately hardlinked pair of files, which is what proves
 * it can fail.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import type { FsEntry } from "./snapshotTypes";

/**
 * Asserts that no `"file"` entry in `entries` (relative paths, resolved against both
 * `sourceRoot` and `destinationRoot`) shares an inode -- same device *and* same inode number,
 * which is what actually identifies a hardlink -- between the template and the copy. Throws once,
 * listing every offending relative path, rather than on the first match, so a failing test's
 * message is self-explanatory (mirrors `assertAlternatesContained`'s error style).
 */
export async function assertNoSharedInodes(
    sourceRoot: string,
    destinationRoot: string,
    entries: readonly FsEntry[],
): Promise<void> {
    const fileEntries = entries.filter((entry) => entry.type === "file");
    const offending = (
        await Promise.all(
            fileEntries.map(async (entry) => {
                const shared = await sharesInode(sourceRoot, destinationRoot, entry.relativePath);
                return shared ? entry.relativePath : null;
            }),
        )
    ).filter((relativePath): relativePath is string => relativePath !== null);

    if (offending.length > 0) {
        throw new Error(
            `copyTemplate: copy shares an inode with the template for ${offending.length} file(s) ` +
                `(a hardlinked copy lets one test's mutation corrupt every other): ${offending.join(", ")}`,
        );
    }
}

/** `dev` scopes the inode-number comparison: inode numbers are only unique per device, so two
 * files on different filesystems could coincidentally share a raw `ino` without being linked. */
async function sharesInode(
    sourceRoot: string,
    destinationRoot: string,
    relativePath: string,
): Promise<boolean> {
    const [sourceStats, destinationStats] = await Promise.all([
        lstat(path.join(sourceRoot, relativePath)),
        lstat(path.join(destinationRoot, relativePath)),
    ]);
    return sourceStats.dev === destinationStats.dev && sourceStats.ino === destinationStats.ino;
}
