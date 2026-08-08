/**
 * Private git-dir state: one recursive digest-walk of a git directory, applied to the common
 * directory and to every resolved worktree admin directory (PLAN.md step 9's "per-worktree and
 * common-directory private state -- inventoried recursively, with a documented exclusion list
 * rather than a hand-written include list").
 *
 * A single walk with a short, justified exclusion list is the whole point: naming files
 * individually is exactly the approach the plan calls out as having already missed `commondir`,
 * `config.worktree`, per-worktree `FETCH_HEAD`, `COMMIT_EDITMSG`, and per-worktree logs. This walk
 * cannot repeat that mistake, because nothing is named to walk *toward* -- everything not
 * excluded is included automatically. That also means every special-file bullet in step 9
 * (`.git/config`, `FETCH_HEAD`, `ORIG_HEAD`, `REBASE_HEAD`, `AUTO_MERGE`, `MERGE_HEAD`,
 * `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_MSG`, `SQUASH_MSG`, `sequencer/`, `rebase-merge/`,
 * `rebase-apply/`, rerere data, `BISECT_*`, `$GIT_COMMON_DIR/intelligit/*`) is covered by this one
 * walk without being named here either -- each is just a file or directory that sits directly in
 * a git directory and is not on the exclusion list. Confirmed empirically against a real
 * mid-bisect repository: `BISECT_LOG`, `BISECT_START`, `BISECT_TERMS`, `BISECT_NAMES`,
 * `BISECT_EXPECTED_REV`, and `BISECT_ANCESTORS_OK` all sit directly in the git directory root.
 *
 * Two exclusion tiers, not one -- confirmed empirically with a real linked worktree, and this
 * distinction is load-bearing:
 * - Excluded from every walk, common or per-worktree, because the concept simply never exists
 *   under a worktree's own admin directory (excluding it there is a no-op) and is redundant with
 *   a dedicated section when it does exist, under the common directory:
 *     - `objects` -- covered by `snapshotObjectStore.ts`, which inventories every object git knows
 *       about rather than every file the object-store implementation happens to use.
 *     - `packed-refs` -- representation detail of the refs `for-each-ref` already covers
 *       independently of loose-vs-packed layout.
 *     - `worktrees` -- each linked worktree's private admin directory is walked separately, keyed
 *       by worktree identity (see `snapshotWorktrees.ts`); folding it into the common walk would
 *       double-report it under two keys.
 *     - `hooks` -- git's own installation-provided sample hooks (`*.sample`), never activated by
 *       this suite; pinning git-version-provided template bytes would make determinism depend on
 *       which git version built the template.
 *     - `description` -- the same git-installation boilerplate, for the same reason.
 * - Excluded **only** from the common-directory walk, because it is redundant there with a
 *   dedicated section that itself reads from the common directory -- but is emphatically **not**
 *   excluded from a per-worktree walk, where no such dedicated section exists:
 *     - `refs` -- covered, for the common directory, by `snapshotRefs.ts`'s `for-each-ref`
 *       enumeration. Confirmed empirically that a linked worktree's own `refs/` is genuinely empty
 *       in this suite's git usage (regular branch/tag refs are always shared through the common
 *       directory), so excluding it there costs nothing -- but nothing *proves* that in general,
 *       so the exclusion is scoped to the directory where it is actually redundant rather than
 *       applied everywhere on an unverified assumption.
 *     - `logs` -- covered, for the common directory, by `snapshotRefs.ts`'s dedicated reflog walk
 *       (also rooted at the common directory). A linked worktree's own `logs/HEAD` is **not** the
 *       same bytes: confirmed empirically that committing inside a linked worktree appends to that
 *       worktree's private `logs/HEAD` while the common directory's `logs/HEAD` is untouched. This
 *       is exactly the "per-worktree logs" PLAN.md step 9 names as a previously-missed item -- an
 *       earlier version of this file excluded `logs` unconditionally and silently reproduced that
 *       exact miss for every linked worktree. `tests/unit/fixtures/snapshotRefsAndWorktrees.test.ts`
 *       proves a per-worktree commit's reflog line is captured, and that removing the linked
 *       worktree makes that capture disappear.
 */

import { inventoryDirectory } from "./fsInventory";
import type { ExcludePredicate } from "./fsInventory";
import type { FsEntry, GitDirStateByRoot, Section } from "./snapshotTypes";
import { captured } from "./snapshotTypes";

/** Never walked in ANY git directory: the concept only ever exists under the common directory, so
 * excluding it from a per-worktree walk is a no-op there. See the module doc comment. */
const EXCLUDED_EVERYWHERE_NAMES: ReadonlySet<string> = new Set([
    "objects",
    "packed-refs",
    "worktrees",
    "hooks",
    "description",
]);

/** Excluded only from the COMMON directory's own walk, because a dedicated section already reads
 * it from there. Must never apply to a per-worktree walk -- see the module doc comment. */
const COMMON_DIR_ONLY_REDUNDANT_NAMES: ReadonlySet<string> = new Set(["refs", "logs"]);

/** Builds the exclusion predicate for one git directory, common or per-worktree. */
function buildExcludePredicate(isCommonDir: boolean): ExcludePredicate {
    return (relativePath) => {
        const [firstSegment] = relativePath.split("/");
        if (EXCLUDED_EVERYWHERE_NAMES.has(firstSegment)) return true;
        return isCommonDir && COMMON_DIR_ONLY_REDUNDANT_NAMES.has(firstSegment);
    };
}

/** Walks one git directory's private state, keyed by `key` (`"common"`, or a worktree's own path). */
async function snapshotOneGitDir(
    key: string,
    gitDir: string,
    isCommonDir: boolean,
): Promise<readonly [key: string, entries: readonly FsEntry[]]> {
    const entries = await inventoryDirectory({
        root: gitDir,
        exclude: buildExcludePredicate(isCommonDir),
    });
    return [key, entries];
}

/**
 * Walks the common directory plus every entry in `worktreeGitDirs` (worktree path -> its resolved,
 * already-absolute admin directory from `snapshotWorktrees.ts`), returning one keyed section.
 * `"common"` is reserved for the common directory; every other key is the worktree's own
 * working-directory path, matching {@link WorktreeInfo.path}.
 */
export async function snapshotGitDirState(
    commonDir: string,
    worktreeGitDirs: ReadonlyMap<string, string>,
): Promise<Section<GitDirStateByRoot>> {
    const pairs = await Promise.all([
        snapshotOneGitDir("common", commonDir, true),
        // A linked worktree's admin directory lives under the common directory's own `worktrees/`,
        // which the common-directory walk above excludes -- so this is genuinely additional
        // coverage, not a re-walk of the same bytes under a second key.
        ...Array.from(worktreeGitDirs, ([worktreePath, gitDir]) => snapshotOneGitDir(worktreePath, gitDir, false)),
    ]);
    return captured(Object.fromEntries(pairs));
}
