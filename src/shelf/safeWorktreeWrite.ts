import type { Stats } from "node:fs";
import { chmod, lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateShelfManifestPath } from "./importValidation";
import { ensureContainedParent, resolveRepositoryPath } from "./recoveryPaths";

/**
 * Writes raw shelf bytes only to an existing regular file contained by the repository.
 *
 * **Why the payload never goes to `target` directly.** This used to open `target` and write into
 * it, with `assertRegularTarget` lstatting before and after. Between those two syscalls the path
 * can be replaced by a symlink, and the open then follows it -- so the "after" check detected an
 * escape that had *already been written*. `O_NOFOLLOW` closed that window on POSIX, but Windows
 * does not honour the flag (see `./noFollowFlag`), which is exactly where the pre/post lstat pair
 * degrades from a guard into a report. The payload now goes to an exclusively created sibling
 * (`wx`, so it cannot land on anything that already exists, symlink included) and is renamed over
 * `target`. `rename` acts on the directory entry and never follows a final-component symlink, so a
 * path swapped in mid-flight is *replaced* rather than written through, on every platform and
 * without depending on a flag one of them ignores.
 *
 * This is the same shape as `writeAtomic` in `./store`, which already writes every shelf artifact
 * this way. The difference is `chmod` below: that helper creates files IntelliGit owns, whereas
 * this one replaces a file the user owns and has to carry its permissions across.
 *
 * **History.** #223: the previous flag word was `O_WRONLY | O_TRUNC` with no `O_CREAT`, which
 * libuv maps to the Win32 `TRUNCATE_EXISTING` disposition. Windows rejects it, and all 32 `EINVAL`
 * failures on that run came from this one call -- shelf raw-apply was broken for every Windows
 * user. Neither flag exists here any more, so neither can regress.
 */
export async function replaceRegularWorktreeFile(
    repositoryRoot: string,
    relativePath: string,
    bytes: Uint8Array,
): Promise<void> {
    const target = resolveRepositoryPath(repositoryRoot, validateShelfManifestPath(relativePath));
    await ensureContainedParent(repositoryRoot, target);
    const existing = await assertRegularTarget(target);

    const temporary = path.join(
        path.dirname(target),
        "." + path.basename(target) + "." + randomUUID() + ".tmp",
    );
    let renamed = false;
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(bytes);
            await file.sync();
        } finally {
            await file.close();
        }
        // Permission bits only. `wx` creates at 0o600, so without this an executable script comes
        // back non-executable and owner-only -- a silent change to a file the user owns. Masked to
        // `0o777` rather than `0o7777` deliberately: setuid, setgid and the sticky bit are not
        // carried onto content that has just been replaced.
        await chmod(temporary, existing.mode & 0o777);
        // The last look before the swap. Everything after this is a directory-entry operation, so
        // this is the final point at which a replaced `target` can still be refused.
        await assertRegularTarget(target);
        await rename(temporary, target);
        renamed = true;
    } finally {
        // Never allowed to displace the failure it is cleaning up after: a bare `rm` here would
        // throw its own error out of the `finally` and discard the reason the write failed.
        if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
    }
    await ensureContainedParent(repositoryRoot, target);
    await assertRegularTarget(target);
}

async function assertRegularTarget(target: string): Promise<Stats> {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error("Raw shelf write requires an existing regular file.");
    }
    return details;
}
