import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Removes scratch directories a test created, retrying past writes the test does not control.
 *
 * Git keeps writing into `.git/objects/pack` after the command that triggered it has returned,
 * and the shelf store flushes on its own schedule, so a file can appear between a recursive
 * rm's readdir and its rmdir and surface as `ENOTEMPTY: directory not empty`. It fails whichever
 * row happens to be executing rather than the row that caused it, which is why it moves between
 * rows: it took the build red twice on two unrelated integration tests, each time on a row whose
 * own assertions had all passed. `maxRetries`/`retryDelay` are Node's documented remedy for that
 * error class (EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM), with linear backoff.
 *
 * Retrying is safe only because these directories are scratch the caller owns outright and
 * nothing recreates them once teardown has begun. Do not reach for this to paper over a
 * directory something else is still legitimately using.
 */
export async function removeScratchDirectories(...directories: readonly string[]): Promise<void> {
    await Promise.all(
        directories.map((directory) =>
            rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
        ),
    );
}

/**
 * Synchronous sibling of {@link removeScratchDirectories}, for teardown that cannot await.
 *
 * The retry contract is identical because the hazard is: `rmSync` fails on the same
 * EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM class and accepts the same `maxRetries`/`retryDelay`. The
 * options stay spelled out at both call sites rather than hoisted to a shared constant so the
 * `no-restricted-syntax` guard in `eslint.config.mjs`, which matches an inline options object,
 * demonstrably covers this file too instead of being evaded by the one module that defines it.
 */
export function removeScratchDirectoriesSync(...directories: readonly string[]): void {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
}
