/**
 * Symlink-containment guard and rebase for `copyTemplate.ts` (PLAN.md step 8, Codex R3 #6):
 * `verbatimSymlinks: true` faithfully preserves a symlink whose target is absolute or escapes
 * upward, which means a copied link can still resolve into the template or elsewhere outside the
 * copy -- passing both the inventory and a later diff, while writes through it corrupt shared
 * state. So every symlink in the copy is audited after `fs.cp` has already run, verbatim:
 *
 * - an absolute target that resolves inside the template is REBASED onto the copy (the symlink is
 *   recreated pointing at the equivalent absolute path under the destination root, so it now
 *   resolves inside the copy instead of back into the template);
 * - a relative target that already resolves inside the destination root is left untouched -- the
 *   common, well-behaved case, since copying preserves relative directory structure automatically;
 * - anything else (an absolute target outside the template, or a relative target that escapes the
 *   destination root once resolved from its new location) is REJECTED: the whole copy throws,
 *   listing every offending link, rather than silently leaving a dangerous link in place.
 */

import { readlink, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import type { FsEntry } from "./snapshotTypes";

interface OffendingSymlink {
    readonly relativePath: string;
    readonly target: string;
    readonly reason: string;
}

interface PlannedRebase {
    readonly relativePath: string;
    readonly linkPath: string;
    readonly newTarget: string;
}

/**
 * Audits every `"symlink"` entry in `entries` (already copied into `destinationRoot`, verbatim,
 * by `fs.cp`). Rebases template-contained absolute targets onto the copy in place; throws once,
 * listing every symlink that is neither template-contained-absolute nor copy-contained-relative.
 * Returns the relative paths of every symlink that was rebased, so a caller can tell whether an
 * inventory taken before this call is now stale.
 */
export async function enforceSymlinkContainment(
    sourceRoot: string,
    destinationRoot: string,
    entries: readonly FsEntry[],
): Promise<readonly string[]> {
    const symlinkEntries = entries.filter((entry) => entry.type === "symlink");
    const { offending, rebases } = planSymlinkAudit(sourceRoot, destinationRoot, symlinkEntries);

    if (offending.length > 0) {
        throw new Error(
            `copyTemplate: symlink containment violated for ${offending.length} link(s) ` +
                `(every symlink must resolve inside the copy): ` +
                offending.map((entry) => `${entry.relativePath} -> ${entry.target} (${entry.reason})`).join("; "),
        );
    }

    // Applied only after every symlink passed the audit above -- a partially rebased copy left
    // behind by a thrown error would be a worse state than an untouched, fully verbatim one.
    for (const rebase of rebases) {
        // eslint-disable-next-line no-await-in-loop -- each rebase replaces one symlink; sequential keeps a failure attributable to a specific link.
        await rebaseSymlink(rebase.linkPath, rebase.newTarget);
    }
    return rebases.map((rebase) => rebase.relativePath);
}

/** Pure classification pass over every symlink entry -- no filesystem writes -- so the audit and
 * the mutation it authorizes stay clearly separated (see the comment above the apply loop). */
function planSymlinkAudit(
    sourceRoot: string,
    destinationRoot: string,
    symlinkEntries: readonly FsEntry[],
): { readonly offending: readonly OffendingSymlink[]; readonly rebases: readonly PlannedRebase[] } {
    const offending: OffendingSymlink[] = [];
    const rebases: PlannedRebase[] = [];

    for (const entry of symlinkEntries) {
        const target = entry.symlinkTarget;
        const linkPath = path.join(destinationRoot, entry.relativePath);

        if (target === null) {
            // Guarded by FsEntry's own contract (only "symlink" entries carry a non-null target),
            // but the field type is nullable, so fail loudly here rather than silently skip the audit.
            offending.push({ relativePath: entry.relativePath, target: "", reason: "symlink entry has a null target" });
            continue;
        }

        if (path.isAbsolute(target)) {
            if (isWithin(sourceRoot, target)) {
                const newTarget = path.join(destinationRoot, path.relative(sourceRoot, target));
                rebases.push({ relativePath: entry.relativePath, linkPath, newTarget });
                continue;
            }
            offending.push({ relativePath: entry.relativePath, target, reason: "absolute target outside the template" });
            continue;
        }

        const resolved = path.resolve(path.dirname(linkPath), target);
        if (!isWithin(destinationRoot, resolved)) {
            offending.push({ relativePath: entry.relativePath, target, reason: "relative target escapes the copy" });
        }
    }

    return { offending, rebases };
}

/** Recreates the symlink at `linkPath` pointing at `newTarget`, unless it already does. */
async function rebaseSymlink(linkPath: string, newTarget: string): Promise<void> {
    const current = await readlink(linkPath);
    if (current === newTarget) return;
    await unlink(linkPath);
    await symlink(newTarget, linkPath);
}

/** Returns `true` when `candidate` is `root` itself or lies inside it, purely by path text --
 * mirrors `snapshotObjectStore.ts`'s private `isWithin`, duplicated per this package's existing
 * convention of small duplicated private predicates rather than a shared import. */
function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
