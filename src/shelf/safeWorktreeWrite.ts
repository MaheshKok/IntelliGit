import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { validateShelfManifestPath } from "./importValidation";
import { resolveNoFollowFlag } from "./noFollowFlag";
import { ensureContainedParent, resolveRepositoryPath } from "./recoveryPaths";

/**
 * Writes raw shelf bytes only to an existing regular file contained by the repository.
 *
 * The truncation is a separate `truncate(0)` rather than an `O_TRUNC` flag because Windows rejects
 * that flag combination outright (#223). libuv maps the open flags to a Win32 `CreateFileW`
 * disposition, and `O_WRONLY | O_TRUNC` with no `O_CREAT` becomes `TRUNCATE_EXISTING`, which failed
 * for every shelf raw-apply on the Windows leg:
 *
 * ```text
 * EINVAL: invalid argument, open 'C:\Users\RUNNER~1\...\tracked.txt'
 *   at replaceRegularWorktreeFile (src/shelf/safeWorktreeWrite.ts)
 * ```
 *
 * All 32 EINVALs in that run came from this one call, while the sibling raw-write in
 * `recovery.ts` -- same helper, same platform, but `O_CREAT | O_EXCL`, so disposition
 * `CREATE_NEW` -- never failed. This was a real user-facing defect, not a test artifact: shelf
 * raw-apply was broken for every Windows user of the extension.
 *
 * Dropping `O_TRUNC` leaves `O_WRONLY`, i.e. `OPEN_EXISTING`, which preserves the property the
 * flags were chosen for in the first place: open must fail when the target does not already exist.
 * `O_CREAT | O_TRUNC` would also satisfy Windows, and `assertRegularTarget` below would still
 * reject a missing target before the open is even reached -- so that swap is invisible to every
 * test in `tests/unit/shelf/safeWorktreeWrite.test.ts` (measured). It is still the wrong flag set:
 * the lstat and the open are two separate syscalls, and `O_CREAT` is what decides the outcome if
 * the target is unlinked in between.
 */
export async function replaceRegularWorktreeFile(
    repositoryRoot: string,
    relativePath: string,
    bytes: Uint8Array,
): Promise<void> {
    const target = resolveRepositoryPath(repositoryRoot, validateShelfManifestPath(relativePath));
    await ensureContainedParent(repositoryRoot, target);
    await assertRegularTarget(target);
    const file = await open(target, constants.O_WRONLY | resolveNoFollowFlag());
    try {
        // Without O_TRUNC the file keeps its old length, so a shorter payload would leave the tail
        // of the previous contents behind. Truncating before the write is what `O_TRUNC` was doing.
        await file.truncate(0);
        await file.writeFile(bytes);
        await file.sync();
    } finally {
        await file.close();
    }
    await ensureContainedParent(repositoryRoot, target);
    await assertRegularTarget(target);
}

async function assertRegularTarget(target: string): Promise<void> {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error("Raw shelf write requires an existing regular file.");
    }
}
