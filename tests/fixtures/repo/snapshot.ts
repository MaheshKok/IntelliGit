/**
 * The canonical fixture-workspace snapshot (PLAN.md Phase 1 step 9): `snapshotWorkspace()`
 * captures the full restorable domain for both the seeded workspace and its bare `origin`. The
 * normalization helpers the step 8 harness (`tests/fixtures/repo/harness.ts`, not this file) needs
 * in order to produce a normalized diff against the template are imported from `snapshotNormalize.ts`
 * directly -- see the note above the re-export block at the bottom of this file.
 *
 * Governing principle (binding on every section below, restated from PLAN.md's own governing
 * principle: "every oracle in this system must be proven able to fail"): a section is either
 * `captured`, carrying real data read from the repository, or explicitly `not-captured`, carrying
 * a reason -- there is no third state, and nothing here ever falls back to a silent empty value
 * on a read failure. A `not-captured` section can never compare equal to a captured-but-empty one,
 * because the two are structurally different shapes (`{status:"not-captured", reason}` vs.
 * `{status:"captured", data}`); `tests/unit/fixtures/snapshot.test.ts` proves this directly. The
 * only place this snapshot uses `not-captured` at all is durable VS Code state without a caller-
 * supplied provider (see `snapshotDurableState.ts`) -- every git-domain section either succeeds
 * with real data or the underlying git process throws, which propagates rather than being caught
 * into an empty result.
 *
 * Deliberate exclusions, and why each is safe (the "written rationale" PLAN.md step 9 requires):
 * - `.git/hooks/*.sample` and `.git/description` -- git-installation boilerplate, not seeded or
 *   restorable domain state; see `snapshotGitDirState.ts` for the full reasoning.
 * - Raw `packed-refs` bytes and the raw loose-vs-packed layout of `objects/` -- both are storage
 *   representation, already covered by representation-independent captures (`for-each-ref`,
 *   `cat-file --batch-all-objects`); see `snapshotGitDirState.ts` and `snapshotObjectStore.ts`.
 * - `git fsck` does not run per snapshot call -- PLAN.md step 9's own scope for it is "once per
 *   suite, and inside the Phase 6 harness tests," which is a harness-level (step 8) concern, not
 *   this module's.
 *
 * Module map (kept small and focused per file, per this repo's own file-size convention):
 * `gitRun.ts` (sanitized git subprocess seam), `fsInventory.ts` (generic recursive digest walk),
 * `snapshotWorkingTree.ts`, `snapshotIndex.ts`, `snapshotRefs.ts` (refs + HEAD + reflogs),
 * `snapshotWorktrees.ts`, `snapshotGitDirState.ts` (private admin-file state),
 * `snapshotObjectStore.ts`, `snapshotRepository.ts` (per-repository orchestration),
 * `snapshotDurableState.ts` (the VS Code seam), `snapshotNormalize.ts` (comparison-only rewrite),
 * `snapshotTypes.ts` (every shared type).
 */

import { snapshotDurableState } from "./snapshotDurableState";
import { snapshotRepository } from "./snapshotRepository";
import type { DurableStateProvider, WorkspaceSnapshot } from "./snapshotTypes";

/** Inputs for one full workspace snapshot -- matches step 8's `createFixtureWorkspace()` result shape. */
export interface SnapshotWorkspaceOptions {
    /** Absolute path to the workspace's working-tree repository root. Normalizes to `<ROOT>`. */
    readonly root: string;
    /** Absolute path to the bare `origin` repository. Normalizes to `<ORIGIN>`. */
    readonly originRoot: string;
    /** Absolute path to the per-test VS Code profile root. Normalizes to `<PROFILE>`; never walked directly. */
    readonly profileDir: string;
    /** Sanitized git environment (e.g. from `seed.ts`'s `createSanitizedGitEnv()`), used for every git subprocess this call spawns. */
    readonly env: NodeJS.ProcessEnv;
    /** Optional seam into a running extension host's durable state; see `snapshotDurableState.ts`. */
    readonly durableState?: DurableStateProvider;
}

/**
 * Captures the full restorable domain of one fixture workspace: the working-tree repository at
 * `options.root`, the bare repository at `options.originRoot`, and durable VS Code state if
 * `options.durableState` is supplied. The result is the oracle `createFixtureWorkspace()`'s
 * initial call captures once and every later comparison (normalized via {@link normalizeSnapshot})
 * diffs against.
 */
export async function snapshotWorkspace(
    options: SnapshotWorkspaceOptions,
): Promise<WorkspaceSnapshot> {
    const [workspace, origin, durableState] = await Promise.all([
        snapshotRepository(options.root, options.env),
        snapshotRepository(options.originRoot, options.env),
        snapshotDurableState(options.durableState),
    ]);
    return { workspace, origin, durableState };
}

// Re-exported here only where a consumer actually routes through this barrel rather than
// importing the owning module directly. Everything else -- `normalizeSnapshot`,
// `assertAlternatesContained`, `notCaptured`, and the per-section types -- stays exported from its
// own module (`snapshotNormalize.ts`, `snapshotObjectStore.ts`, `snapshotTypes.ts`), which is where
// every current consumer imports it from. A barrel line that duplicates a path nobody takes is dead
// surface: it survives a `knip` pass only by being re-exported, and it hides the next genuinely
// dead export behind the noise.
export type { PlaceholderRoots } from "./snapshotNormalize";
export { captured } from "./snapshotTypes";
export type {
    DurableStateProvider,
    DurableStateSnapshot,
    WorkspaceSnapshot,
} from "./snapshotTypes";
