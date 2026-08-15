/**
 * Scratch-path bookkeeping for the recorder tests' `beforeAll`/`afterAll` pair.
 *
 * Every recorder test seeds TWO independent workspaces so its byte-equality test exercises
 * canonicalization instead of vacuously comparing a recording against itself. Seeding is a real
 * `git` build against a real temp directory, so it can fail -- and the obvious shapes for that pair
 * both leak a directory on exactly the run whose failure most needed to be legible:
 *
 * 1. **Reading the paths back off the workspace handles in `afterAll`.** A rejected `beforeAll`
 *    leaves those handles unassigned, so `workspaceA.home` throws a `TypeError` that REPLACES the
 *    real seeding error in the report and skips every remaining removal. Paths are registered here
 *    the moment they exist instead, never re-derived from a handle that may not be there.
 *
 * 2. **`Promise.all` over the two seeds.** It rejects the instant one fails, while its sibling is
 *    still running. Vitest then starts `afterAll`, which reads the registered paths BEFORE the
 *    sibling finishes registering its own -- leaking that one -- and removes the shared parent
 *    directory out from under a `git` process still writing into it. `seedPair` settles both before
 *    propagating, so every path that will ever exist is registered by the time cleanup reads them.
 *
 * Both failure modes are invisible on a green run, which is why this is one shared helper with its
 * own tests rather than seven hand-maintained copies -- three of which had already drifted from the
 * other four.
 */

import { rm } from "node:fs/promises";

/** The one thing this module needs from a seeded workspace: the temp `HOME` it owns. */
interface ScratchWorkspace {
    readonly home: string;
}

export interface ScratchWorkspaces {
    /** Registers a path for removal. Use for directories allocated outside `seedPair`. */
    register(scratchPath: string): void;
    /**
     * Runs both seeds concurrently and registers each one's `home` as soon as it exists. Rejects
     * with the first seed's reason if it failed, otherwise the second's -- but only after BOTH have
     * settled, so a slow sibling can never register its path after cleanup has already read them.
     */
    seedPair<T extends ScratchWorkspace>(
        seedA: () => Promise<T>,
        seedB: () => Promise<T>,
    ): Promise<[T, T]>;
    /**
     * Removes every registered path. Safe to call after a partial or fully failed `seedPair`, and
     * safe to register the same path twice: duplicates are collapsed rather than removed
     * concurrently.
     */
    removeAll(): Promise<void>;
}

export function createScratchWorkspaces(): ScratchWorkspaces {
    const scratchPaths: string[] = [];

    return {
        register(scratchPath: string): void {
            scratchPaths.push(scratchPath);
        },

        async seedPair<T extends ScratchWorkspace>(
            seedA: () => Promise<T>,
            seedB: () => Promise<T>,
        ): Promise<[T, T]> {
            const track = async (seed: () => Promise<T>): Promise<T> => {
                const workspace = await seed();
                scratchPaths.push(workspace.home);
                return workspace;
            };

            const [a, b] = await Promise.allSettled([track(seedA), track(seedB)]);
            if (a.status === "rejected") throw a.reason;
            if (b.status === "rejected") throw b.reason;
            return [a.value, b.value];
        },

        async removeAll(): Promise<void> {
            // Deduped because a caller may legitimately register a path that `seedPair` then
            // registers again -- `prepareDirtyWorkspace` does exactly that so a FAILED postcondition
            // still cleans up. Two concurrent recursive removals of the same tree do NOT currently
            // fail (measured: 24 concurrent removals of a 480-directory tree on node v24, zero
            // rejections -- its rimraf tolerates `ENOENT` at every level), but `force` is documented
            // only as "ignored if path does not exist", i.e. the top level. This does not depend on
            // the undocumented part.
            await Promise.all(
                [...new Set(scratchPaths)].map((scratchPath) =>
                    rm(scratchPath, { recursive: true, force: true }),
                ),
            );
        },
    };
}
