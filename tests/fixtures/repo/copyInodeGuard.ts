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
import type { Stats } from "node:fs";
import path from "node:path";
import type { FsEntry } from "./snapshotTypes";

/** The three `lstat` fields that decide whether two paths name one underlying file. */
export type FileIdentity = Pick<Stats, "dev" | "ino" | "nlink">;

/** One file whose template and copy sides could not be told apart, with the evidence. */
interface SharedStorageOffender {
    readonly relativePath: string;
    readonly source: FileIdentity;
    readonly destination: FileIdentity;
}

/**
 * Whether `source` and `destination` name the same underlying file.
 *
 * Extracted from the walk so the decision is assertable on its own: the values a filesystem
 * reports for a pair that is *not* linked cannot be produced on demand by creating files, and a
 * predicate that only runs against whatever the host happens to hand it is a predicate no test
 * can pin.
 */
export function sharesStorage(source: FileIdentity, destination: FileIdentity): boolean {
    // A hardlink is one file wearing two names, so both sides must report at least two. `dev` and
    // `ino` alone were enough until this ran on Windows, where they matched for a pair `fs.cp` had
    // just written separately -- `fs.cp` copies through the platform's file-copy call and has no
    // mechanism that could link them. `nlink` is reported independently of the ids, so it survives
    // whatever made them agree, and it is the property the guard actually cares about: a file with
    // one name cannot be corrupted through another.
    if (source.nlink < 2 || destination.nlink < 2) return false;
    return source.dev === destination.dev && source.ino === destination.ino;
}

/**
 * Asserts that no `"file"` entry in `entries` (relative paths, resolved against both
 * `sourceRoot` and `destinationRoot`) shares storage between the template and the copy. Throws
 * once, listing every offending relative path together with the `lstat` fields that condemned it,
 * rather than on the first match, so a failing test's message is self-explanatory (mirrors
 * `assertAlternatesContained`'s error style).
 */
export async function assertNoSharedInodes(
    sourceRoot: string,
    destinationRoot: string,
    entries: readonly FsEntry[],
): Promise<void> {
    const fileEntries = entries.filter((entry) => entry.type === "file");
    const offending = (
        await Promise.all(
            fileEntries.map((entry) =>
                inspectPair(sourceRoot, destinationRoot, entry.relativePath),
            ),
        )
    ).filter((offender): offender is SharedStorageOffender => offender !== null);

    if (offending.length > 0) {
        throw new Error(
            `copyTemplate: copy shares an inode with the template for ${offending.length} file(s) ` +
                `(a hardlinked copy lets one test's mutation corrupt every other): ` +
                offending.map(describeOffender).join(", "),
        );
    }
}

/** The numbers are in the message because they are the only way to tell a real hardlink from a
 * platform that declined to identify the file -- and reading them off a CI log costs nothing,
 * where reproducing the run costs half an hour. */
function describeOffender(offender: SharedStorageOffender): string {
    return (
        `${offender.relativePath} ` +
        `(template ${describeIdentity(offender.source)}; copy ${describeIdentity(offender.destination)})`
    );
}

function describeIdentity(identity: FileIdentity): string {
    return `dev=${identity.dev} ino=${identity.ino} nlink=${identity.nlink}`;
}

/** `dev` scopes the inode-number comparison: inode numbers are only unique per device, so two
 * files on different filesystems could coincidentally share a raw `ino` without being linked. */
async function inspectPair(
    sourceRoot: string,
    destinationRoot: string,
    relativePath: string,
): Promise<SharedStorageOffender | null> {
    const [source, destination] = await Promise.all([
        lstat(path.join(sourceRoot, relativePath)),
        lstat(path.join(destinationRoot, relativePath)),
    ]);
    return sharesStorage(source, destination) ? { relativePath, source, destination } : null;
}
