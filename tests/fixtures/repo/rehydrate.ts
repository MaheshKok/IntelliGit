/**
 * Live rehydration for `copyTemplate.ts`'s output (PLAN.md Phase 1 step 8, the second of three
 * slices -- Codex R3 #5): "Live rehydration rewrites metadata on disk to concrete per-test
 * absolute paths -- the copy's origin URL, and any absolute template path in copied config or
 * worktree metadata. A repository containing the literal string `<ROOT>` would not function."
 * This is the opposite half of `snapshotNormalize.ts`'s comparison-only rewrite: that module only
 * ever produces an in-memory value for diffing and never touches disk; this module only ever
 * writes to disk, and never writes a placeholder -- every value it writes is the copy's own real,
 * concrete path.
 *
 * ## The declared rewrite set (empirically determined, not guessed)
 *
 * A throwaway probe script (not committed) seeded a real template with `seedFixtureTemplate`, ran
 * the real `copyTemplate` against it, then `grep -rIl`'d the ENTIRE copy (workspace + bare origin)
 * for the literal template root path. Exactly one file matched: `workspace/.git/config`'s
 * `[remote "origin"] url` line -- the `file://` URL `seed.ts`'s `createBareOrigin` wires into the
 * template's own `origin.git` via `git remote add origin <file-url>`. Confirmed functionally, not
 * just textually: before rewrite, `git ls-remote --get-url origin` run inside the copy silently
 * resolved to the TEMPLATE's `origin.git` (the exact hazard PLAN.md step 8 warns about); after
 * `git config remote.origin.url <copy's own file:// URL>`, the same command resolves to the
 * copy's own `origin.git`, and a real `git fetch origin` against it succeeds.
 *
 * Two things the work order expected to also find were checked and are empirically ABSENT from
 * the current template:
 * - **Worktree admin files.** `seedFixtureTemplate` never runs `git worktree add`, so the
 *   template has exactly one (primary) worktree and no linked-worktree admin directory exists to
 *   carry an absolute path. If a future template seeds a linked worktree, {@link DECLARED_REWRITES}
 *   below must grow a matching entry -- `assertWorkspaceEquivalentToTemplate` (see
 *   `assertWorkspaceEquivalence.ts`) fails loudly rather than silently passing in the meantime,
 *   because a linked worktree's un-rewritten absolute path would show up as a real, undeclared
 *   difference in the `worktrees` / `gitDirState` sections of the normalized diff.
 * - **`objects/info/alternates`.** The template never has one (nothing in this fixture stack uses
 *   `git clone --reference` or an equivalent). Rehydration still asserts this defensively on every
 *   call via `assertAlternatesContained` (already built and tested in `snapshotObjectStore.ts`)
 *   rather than trusting that absence to hold forever.
 *
 * `tests/unit/fixtures/rehydrate.test.ts` proves the copy is functional with real `git` commands,
 * and proves both the origin-URL rewrite and the alternates guard can fail.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { runGit } from "./gitRun";
import { assertAlternatesContained, snapshotObjectStore } from "./snapshotObjectStore";

/** One entry in the declared rewrite set. Explicit data, not implicit behavior (PLAN.md step 8). */
export interface DeclaredRewrite {
    readonly id: string;
    readonly description: string;
    readonly rationale: string;
}

/**
 * The full declared rewrite set for a `copyTemplate` output, determined empirically (see the
 * module doc comment above) rather than assumed from PLAN.md's prose alone. Currently one entry;
 * extend it -- and {@link rehydrateCopy} below -- together if a future template seed introduces
 * linked worktrees or an alternates file.
 */
export const DECLARED_REWRITES: readonly DeclaredRewrite[] = [
    {
        id: "workspace-origin-remote-url",
        description: '<copyRoot>/.git/config: [remote "origin"] url',
        rationale:
            "seedFixtureTemplate wires `origin` as a file:// URL into the TEMPLATE's own bare " +
            "origin.git (seed.ts's createBareOrigin). copyTemplate copies that config verbatim, so an " +
            "un-rehydrated copy's origin still resolves into the template: push/pull/fetch would " +
            "silently operate on shared state instead of the copy's own origin.git, corrupting every " +
            "other test that also restores from the same template.",
    },
];

/** One rewrite `rehydrateCopy` actually applied, for a caller (or a test) to assert against. */
interface AppliedRewrite {
    readonly id: string;
    readonly newValue: string;
}

/** What {@link rehydrateCopy} did to one copy. */
export interface RehydrationResult {
    readonly rewrites: readonly AppliedRewrite[];
}

/**
 * Rehydrates one `copyTemplate` output in place: rewrites every entry in
 * {@link DECLARED_REWRITES} to the copy's own concrete, functional value, then defensively
 * verifies both the rewrite itself and `objects/info/alternates` containment for both
 * repositories. Never writes a placeholder -- see the module doc comment's "opposite half of
 * normalization" framing.
 *
 * Mirrors `copyTemplate(sourceRoot, destinationRoot)`'s own two-argument shape and the
 * `<destination>/workspace` + `<destination>/origin.git` layout `seedFixtureTemplate` and
 * `copyTemplate`'s own doc comment both already establish -- this module does not invent a new
 * layout convention.
 *
 * Throws, leaving whatever was already written on disk, if the rewrite does not verifiably take
 * effect or if either repository's `objects/info/alternates` resolves outside the copy --
 * matching `copyTemplate`'s own fail-fast-and-leave-evidence convention.
 */
export async function rehydrateCopy(
    copyDestinationRoot: string,
    env: NodeJS.ProcessEnv,
): Promise<RehydrationResult> {
    const copyRoot = path.join(copyDestinationRoot, "workspace");
    const copyOriginRoot = path.join(copyDestinationRoot, "origin.git");
    const copyOriginUrl = pathToFileURL(copyOriginRoot).href;

    await runGit(copyRoot, ["config", "remote.origin.url", copyOriginUrl], env);
    await verifyOriginRewrite(copyRoot, copyOriginUrl, env);
    await verifyAlternatesContained(copyRoot, copyOriginRoot, env);

    return { rewrites: [{ id: "workspace-origin-remote-url", newValue: copyOriginUrl }] };
}

/**
 * Cheap self-check scoped to exactly the one declared rewrite -- reads the value back through
 * `git config` itself (not a raw file read), so a git-version quirk in how `config` writes the
 * file cannot silently defeat this check.
 */
async function verifyOriginRewrite(
    copyRoot: string,
    expectedUrl: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const readBack = await runGit(copyRoot, ["config", "--get", "remote.origin.url"], env);
    if (readBack !== expectedUrl) {
        throw new Error(
            `rehydrateCopy: "workspace-origin-remote-url" rewrite did not take effect -- ` +
                `expected "${expectedUrl}", git config reports "${readBack}"`,
        );
    }
}

/**
 * Defensive alternates check for both repositories (see the module doc comment) -- cheap:
 * `snapshotObjectStore` issues one `cat-file --batch-all-objects` per repository, with no
 * per-object subprocesses and no content hashing, so this is safe to run on every rehydration
 * despite PLAN.md step 9's own "fsck does not run per copy" cost concern, which is about a much
 * heavier operation (`fsck` walks and verifies every object's content).
 */
async function verifyAlternatesContained(
    copyRoot: string,
    copyOriginRoot: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const [workspaceCommonDir, originCommonDir] = await Promise.all([
        resolveCommonDir(copyRoot, env),
        resolveCommonDir(copyOriginRoot, env),
    ]);
    const [workspaceObjectStore, originObjectStore] = await Promise.all([
        snapshotObjectStore(copyRoot, workspaceCommonDir, env),
        snapshotObjectStore(copyOriginRoot, originCommonDir, env),
    ]);

    const allowedRoots = [copyRoot, copyOriginRoot];
    if (workspaceObjectStore.status === "captured") {
        assertAlternatesContained(workspaceObjectStore.data.alternates, allowedRoots);
    }
    if (originObjectStore.status === "captured") {
        assertAlternatesContained(originObjectStore.data.alternates, allowedRoots);
    }
}

async function resolveCommonDir(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
    const raw = await runGit(repoRoot, ["rev-parse", "--git-common-dir"], env);
    return path.resolve(repoRoot, raw);
}
