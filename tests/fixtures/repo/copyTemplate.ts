/**
 * Recursive template copier (PLAN.md Phase 1 step 8 -- this file covers only the copy-and-inventory
 * slice; live rehydration/origin-URL rewriting and the Playwright per-run manifest are later
 * slices of the same step, built on top of this one). Copies a seeded fixture template wholesale
 * to a fresh destination and returns an inventory of the copy, built with `fsInventory.ts`'s
 * `inventoryDirectory` -- the same primitive every other section of this package's snapshot
 * already uses, so the copy's inventory and a later workspace snapshot are directly comparable.
 *
 * Deliberately generic over two absolute directory paths rather than coupled to `seed.ts`'s
 * `FixtureTemplate` shape: `seedFixtureTemplate` writes both the working-tree repository and the
 * bare `origin` under one common `destination` directory, so a single `copyTemplate` call over
 * that whole directory copies both in one pass.
 *
 * The copy is **not** byte-exact by construction -- a recursive copy has no inherent contract for
 * symlinks or inode separation on its own (PLAN.md step 8's own caveat). What makes the stated
 * contract hold is:
 * - copier options pinned explicitly below, never left to `fs.cp`'s defaults;
 * - no regular file in the copy may share an inode with the template -- see `copyInodeGuard.ts`;
 * - every symlink resolves inside the copy, or the whole copy is rejected -- see
 *   `copySymlinkContainment.ts`.
 */

import { cp } from "node:fs/promises";
import type { CopyOptions } from "node:fs";
import { assertNoSharedInodes } from "./copyInodeGuard";
import { enforceSymlinkContainment } from "./copySymlinkContainment";
import { inventoryDirectory } from "./fsInventory";
import type { FsEntry } from "./snapshotTypes";

/**
 * Pinned explicitly per PLAN.md step 8 -- never left to `fs.cp`'s defaults, every one of which is
 * wrong for this use: `recursive` and `preserveTimestamps` both default to `false`; `dereference`
 * already defaults to `false`, but `verbatimSymlinks` also defaults to `false`, which has `fs.cp`
 * resolve each symlink's target into an absolute path *anchored at the template*, even for a
 * plain relative, self-contained link -- confirmed empirically on this machine: a relative
 * symlink copied with `verbatimSymlinks: false` comes out the other side as an absolute path
 * pointing back into the source tree, not the copy. `dereference: true` cannot be combined with
 * `verbatimSymlinks` at all -- Node throws `ERR_INCOMPATIBLE_OPTION_PAIR` -- so this exact pair is
 * the only combination that both preserves symlinks as links and copies their target text
 * unresolved.
 */
const COPY_OPTIONS: CopyOptions = {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    dereference: false,
    verbatimSymlinks: true,
};

export interface CopyTemplateResult {
    /** The copy's full inventory, post symlink-containment rebase -- see `copySymlinkContainment.ts`.
     * Relative paths are recorded exactly as `readdir` returns them (case-sensitive), so a
     * case-only rename in the copy shows up as a different `relativePath`, never silently. */
    readonly inventory: readonly FsEntry[];
}

/**
 * Recursively copies `sourceRoot` to `destinationRoot` with the pinned {@link COPY_OPTIONS},
 * enforces symlink containment (rebasing template-contained absolute targets, rejecting anything
 * else), asserts no regular file shares an inode with the template, and returns the copy's
 * inventory.
 *
 * `destinationRoot` need not exist yet -- `fs.cp` creates it. Throws, leaving whatever `fs.cp`
 * already wrote to `destinationRoot` on disk, if any symlink fails containment or any regular
 * file shares an inode with the template -- this function does not attempt cleanup on failure,
 * matching `seedFixtureTemplate`'s own fail-fast-and-leave-evidence convention (a caller building
 * a real per-test harness on top of this owns retry/cleanup policy, not this primitive).
 */
export async function copyTemplate(sourceRoot: string, destinationRoot: string): Promise<CopyTemplateResult> {
    await cp(sourceRoot, destinationRoot, COPY_OPTIONS);

    const copiedInventory = await inventoryDirectory({ root: destinationRoot });

    const rebasedPaths = await enforceSymlinkContainment(sourceRoot, destinationRoot, copiedInventory);
    await assertNoSharedInodes(sourceRoot, destinationRoot, copiedInventory);

    // A rebase mutates the on-disk symlink target, which makes `copiedInventory`'s `symlinkTarget`
    // field for that entry stale -- re-walk only when at least one rebase actually happened, since
    // inode-sharing and simple, well-behaved symlinks never invalidate the first walk.
    const finalInventory = rebasedPaths.length > 0 ? await inventoryDirectory({ root: destinationRoot }) : copiedInventory;

    return { inventory: finalInventory };
}
