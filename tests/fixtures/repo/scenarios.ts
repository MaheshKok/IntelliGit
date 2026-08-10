/**
 * The repository scenario layer (PLAN.md:101, Phase 2c-iii). `seedFixtureTemplate` produces
 * exactly one repository state -- history, branches, tag, bare origin, stash entries, and a dirty
 * working tree. Every remaining webview recorder (Phase 2c-iv) needs to record against the other
 * eight states PLAN.md:101 lists too: `clean, dirty, conflicted, mid-rebase, detached HEAD,
 * ahead/behind, empty repo, shelf-populated, shelf-conflicted`. This module builds all nine.
 *
 * Governing principle (this is the whole reason this module exists as its own layer rather than
 * inline setup in each future recorder test): a scenario builder that silently no-ops -- a merge
 * that fast-forwards instead of conflicting, a rebase that runs to completion instead of stopping
 * -- hands a consumer a workspace in the WRONG state, which then produces a type-valid fixture of
 * a screen no user ever sees, which then becomes a baseline nobody catches. So every builder below
 * asserts its own defining postcondition with a real `git` (or, for `shelf-populated`, a real
 * `ShelfStore`) read immediately after building the state, and throws if that assertion fails.
 * Each assertion is also exported on its own (`assert*Postcondition`), so
 * `tests/unit/fixtures/scenarios.test.ts` can prove the throw itself is reachable -- not just that
 * the happy path returns -- by running an assertion against a state built to violate it.
 *
 * Every non-empty scenario below reseeds its own template from scratch (`seedFixtureTemplate`)
 * rather than copying and mutating a shared one. Seeding is deterministic (pinned identity, pinned
 * dates -- see `seed.ts`), so two independent seeds produce byte-identical SHAs; reseeding per
 * scenario therefore makes cross-scenario contamination structurally impossible, at the cost of a
 * few extra git processes per scenario build. `empty-repo` is the sole exception: it has no history
 * to seed, so it builds its own empty repository directly instead (see its own doc comment below).
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";
import { ShelfService } from "../../../src/services/shelfService";

import { runGit } from "./gitRun";
import {
    createSanitizedGitEnv,
    FIXTURE_REFS,
    seedFixtureTemplate,
    type FixtureTemplate,
} from "./seed";

/** Every repository state PLAN.md:101 requires a webview recorder to be able to record against. */
export const REPOSITORY_SCENARIO_IDS = [
    "clean",
    "dirty",
    "conflicted",
    "mid-rebase",
    "detached-head",
    "ahead-behind",
    "empty-repo",
    "shelf-populated",
    "shelf-conflicted",
] as const;

export type RepositoryScenarioId = (typeof REPOSITORY_SCENARIO_IDS)[number];

/** What one `prepare()` call built, and what a caller needs to drive or dispose of it. */
export interface ScenarioWorkspace {
    readonly id: RepositoryScenarioId;
    /** Absolute path to this scenario's working-tree repository. */
    readonly root: string;
    /** Sanitized git env (scratch HOME, pinned identity/dates) for every git subprocess. */
    readonly env: NodeJS.ProcessEnv;
    /** Scratch HOME backing `env.HOME`. Caller-owned; the caller removes it. */
    readonly home: string;
    /** The seeded template this scenario was built from. Absent ONLY for `empty-repo`, which has
     * no history to build from. */
    readonly template?: FixtureTemplate;
    /** The shelf store root created by a shelf-backed scenario; absent for every other scenario. */
    readonly shelfStorageRoot?: string;
}

/** One buildable repository state and the builder that produces it. */
export interface RepositoryScenario {
    readonly id: RepositoryScenarioId;
    /** One line: what state this leaves the repository in. */
    readonly summary: string;
    /** Builds this scenario into `destination` (must be empty or non-existent). THROWS if the
     * resulting repository does not satisfy this scenario's defining postcondition. */
    prepare(destination: string): Promise<ScenarioWorkspace>;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Runs `git` and reports whether it exited zero, without throwing either way -- used where a
 * scenario builder must attempt an operation that is EXPECTED to fail (a conflicting merge or
 * rebase) without the attempt itself aborting the build. The real postcondition check that follows
 * every call site below is what actually decides whether the scenario succeeded; this only decides
 * whether to keep going. */
async function gitSucceeds(
    root: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
): Promise<boolean> {
    try {
        await runGit(root, [...args], env);
        return true;
    } catch {
        return false;
    }
}

/** Fails fast rather than building a scenario on top of leftover files. Mirrors `seed.ts`'s
 * private `ensureEmptyDestination` in miniature -- not imported, since `seed.ts`'s own doc comment
 * establishes that the dependency between this fixture stack's modules runs FROM consumers TOWARD
 * `seed.ts`, never the reverse; adding an export the other direction would invert that. */
async function ensureEmptyScenarioDestination(destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(destination);
    if (entries.length > 0) {
        throw new Error(
            `scenarios: destination "${destination}" is not empty (found ${entries.length} ` +
                `existing entries). Prepare into a fresh directory.`,
        );
    }
}

/** Wraps a freshly seeded template into the shape every non-empty scenario returns. */
function toWorkspace(
    id: RepositoryScenarioId,
    template: FixtureTemplate,
    shelfStorageRoot?: string,
): ScenarioWorkspace {
    return shelfStorageRoot === undefined
        ? { id, root: template.root, env: template.env, home: template.home, template }
        : {
              id,
              root: template.root,
              env: template.env,
              home: template.home,
              template,
              shelfStorageRoot,
          };
}

// ---------------------------------------------------------------------------------------------
// Postcondition assertions -- each exported so scenarios.test.ts can prove the throw is reachable
// by running it directly against a state built to violate it.
// ---------------------------------------------------------------------------------------------

/** `clean`: no modified tracked files, no untracked files. Stash entries are deliberately outside
 * this check's scope -- `git status --porcelain` never reports `refs/stash` either. */
export async function assertCleanPostcondition(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const status = await runGit(root, ["status", "--porcelain"], env);
    if (status.length > 0) {
        throw new Error(
            `clean scenario postcondition violated: expected an empty "git status --porcelain", ` +
                `got:\n${status}`,
        );
    }
}

/** `dirty`: at least one modified tracked path AND at least one untracked path. */
export async function assertDirtyPostcondition(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const status = await runGit(root, ["status", "--porcelain"], env);
    const lines = status.length > 0 ? status.split("\n") : [];
    const hasUntracked = lines.some((line) => line.startsWith("??"));
    const hasModified = lines.some((line) => !line.startsWith("??") && /M/.test(line.slice(0, 2)));
    if (!hasUntracked || !hasModified) {
        throw new Error(
            `dirty scenario postcondition violated: expected at least one untracked ("??") and ` +
                `one modified ("M") path in "git status --porcelain", got:\n${status || "(empty)"}`,
        );
    }
}

/** `conflicted`: an in-progress merge with real conflict markers -- `.git/MERGE_HEAD` exists AND
 * `git status --porcelain` reports at least one unmerged entry. A merge that fast-forwarded or
 * auto-resolved leaves neither, which is exactly the false-green this checks for. */
export async function assertConflictedPostcondition(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const hasMergeHead = existsSync(path.join(root, ".git", "MERGE_HEAD"));
    const status = await runGit(root, ["status", "--porcelain"], env);
    const hasUnmergedEntry = status
        .split("\n")
        .some((line) => /^(UU|AA|DD|AU|UA|UD|DU)/.test(line));
    if (!hasMergeHead || !hasUnmergedEntry) {
        throw new Error(
            `conflicted scenario postcondition violated: MERGE_HEAD present=${hasMergeHead}, ` +
                `unmerged entry present=${hasUnmergedEntry}. "git status --porcelain":\n${status || "(empty)"}`,
        );
    }
}

/** `mid-rebase`: a rebase stopped on a conflict -- `.git/rebase-merge/` or `.git/rebase-apply/`
 * exists AND plain `git status` reports a rebase in progress. A rebase that ran to completion
 * leaves neither. */
export async function assertMidRebasePostcondition(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const rebaseMergeExists = existsSync(path.join(root, ".git", "rebase-merge"));
    const rebaseApplyExists = existsSync(path.join(root, ".git", "rebase-apply"));
    const status = await runGit(root, ["status"], env);
    const mentionsRebase = /rebas/i.test(status);
    if ((!rebaseMergeExists && !rebaseApplyExists) || !mentionsRebase) {
        throw new Error(
            `mid-rebase scenario postcondition violated: rebase-merge=${rebaseMergeExists}, ` +
                `rebase-apply=${rebaseApplyExists}, status mentions a rebase=${mentionsRebase}. ` +
                `"git status":\n${status}`,
        );
    }
}

/** `detached-head`: `git symbolic-ref -q HEAD` fails (no branch owns HEAD) AND `git rev-parse
 * HEAD` equals the commit this scenario detached at. */
export async function assertDetachedHeadPostcondition(
    root: string,
    env: NodeJS.ProcessEnv,
    expectedSha: string,
): Promise<void> {
    const isOnABranch = await gitSucceeds(root, ["symbolic-ref", "-q", "HEAD"], env);
    const headSha = await runGit(root, ["rev-parse", "HEAD"], env);
    if (isOnABranch || headSha !== expectedSha) {
        throw new Error(
            `detached-head scenario postcondition violated: "symbolic-ref -q HEAD" succeeded=` +
                `${isOnABranch} (should fail), HEAD=${headSha}, expected=${expectedSha}.`,
        );
    }
}

/** `ahead-behind`: local `main` both ahead of and behind its upstream -- BOTH
 * `rev-list --left-right --count` numbers must be greater than zero. Checking only one side would
 * still pass a builder that advanced just one side of the pair. */
export async function assertAheadBehindPostcondition(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const counts = await runGit(
        root,
        ["rev-list", "--left-right", "--count", `${FIXTURE_REFS.main}...@{upstream}`],
        env,
    );
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (!(ahead > 0) || !(behind > 0)) {
        throw new Error(
            `ahead-behind scenario postcondition violated: ahead=${ahead}, behind=${behind} ` +
                `(both must be > 0). Raw "rev-list --left-right --count" output: "${counts}".`,
        );
    }
}

/** `empty-repo`: `git rev-parse --verify HEAD` fails (no commits) AND `git status --porcelain` is
 * empty (nothing to report on a repository with no history and no files). */
export async function assertEmptyRepoPostcondition(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const headResolves = await gitSucceeds(root, ["rev-parse", "--verify", "HEAD"], env);
    const status = await runGit(root, ["status", "--porcelain"], env);
    if (headResolves || status.length > 0) {
        throw new Error(
            `empty-repo scenario postcondition violated: "rev-parse --verify HEAD" succeeded=` +
                `${headResolves} (should fail), "git status --porcelain" length=${status.length}.`,
        );
    }
}

/** `shelf-populated`: the shelf store reports at least one entry. Reads back through a fresh
 * `ShelfStore.listShelves()` call rather than trusting whatever `ShelfService.shelve()` returned. */
export async function assertShelfPopulatedPostcondition(store: ShelfStore): Promise<void> {
    const { shelfIds } = await store.listShelves();
    if (shelfIds.length < 1) {
        throw new Error(
            `shelf-populated scenario postcondition violated: expected >= 1 shelf entry, found ` +
                `${shelfIds.length}.`,
        );
    }
}

/**
 * `shelf-conflicted`: opens the content-backed production conflict session for the shelved
 * `mutable.txt` entry and proves its base, local, and shelved sides are all non-empty and pairwise
 * distinct. Reading a fresh manifest and then opening through `ShelfService` is deliberate:
 * `ShelfService.shelve()` reports an empty `entries` array even when the manifest contains a real
 * file, and an entry-only assertion would also miss an ineligible ADD or an unchanged worktree.
 */
export async function assertShelfConflictedPostcondition(
    store: ShelfStore,
    service: Pick<ShelfService, "openShelfConflictSession">,
): Promise<void> {
    const { shelfIds } = await store.listShelves();
    if (shelfIds.length !== 1) {
        throw new Error(
            `shelf-conflicted scenario postcondition violated: expected exactly one shelf entry ` +
                `container, found ${shelfIds.length} shelf(s).`,
        );
    }
    const shelfId = shelfIds[0];
    const manifest = await store.readCurrentShelfManifest(shelfId);
    const entries = manifest.files.filter((entry) => entry.worktreeBlock?.path === "mutable.txt");
    if (entries.length !== 1) {
        throw new Error(
            `shelf-conflicted scenario postcondition violated: expected exactly one mutable.txt ` +
                `shelf entry, found ${entries.length}.`,
        );
    }
    const payload = await service.openShelfConflictSession(shelfId, entries[0].changeId);
    const sides = [payload.base, payload.current, payload.patchedBase];
    if (sides.some((side) => side.length === 0) || new Set(sides).size !== sides.length) {
        throw new Error(
            `shelf-conflicted scenario postcondition violated: expected non-empty, pairwise ` +
                `distinct base/current/patchedBase sides, got ${JSON.stringify(sides)}.`,
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Scenario builders, in REPOSITORY_SCENARIO_IDS order.
// ---------------------------------------------------------------------------------------------

/** `clean`: reverts the seeded dirty layer -- `reset --hard` discards every staged/unstaged
 * tracked change (including the staged rename and the staged binary file, neither of which are in
 * HEAD), then `clean -fdx` removes every untracked AND ignored path the dirty layer left behind. */
async function prepareClean(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    const { root, env } = template;
    await runGit(root, ["reset", "--hard", "HEAD"], env);
    await runGit(root, ["clean", "-fdx", "--quiet"], env);
    await assertCleanPostcondition(root, env);
    return toWorkspace("clean", template);
}

/** `dirty`: the template exactly as seeded -- `seedFixtureTemplate` already builds this state, so
 * this builder's only job is to assert it actually holds. */
async function prepareDirty(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    await assertDirtyPostcondition(template.root, template.env);
    return toWorkspace("dirty", template);
}

/** `conflicted`: merges `conflict/with-main` into `main`. Both branches edit the same line of
 * `conflict.txt` from the same ancestor (`buildConflictingBranch`'s own doc comment in `seed.ts`),
 * so this is a real, mergeable-only-with-conflict-markers divergence -- not a synthetic label.
 * The `reset --hard` + `clean -fdx` pair (identical to `prepareClean`'s own technique) runs first
 * because the seeded template's dirty layer stages an unrelated rename and a new binary file --
 * confirmed by running this scenario without it: git's `ort` merge strategy refuses outright
 * ("Your local changes ... would be overwritten by merge") rather than merging cleanly around
 * them, so the working tree must start clean for the merge to actually reach `conflict.txt` and
 * conflict on it. `--no-edit` and a `GIT_EDITOR=true` override are both belt-and-suspenders
 * against a merge that unexpectedly succeeds and would otherwise try to open an editor for a
 * merge commit message. */
async function prepareConflicted(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    const { root, env } = template;
    await runGit(root, ["reset", "--hard", "HEAD"], env);
    await runGit(root, ["clean", "-fdx", "--quiet"], env);
    const mergeEnv = { ...env, GIT_EDITOR: "true" };
    await gitSucceeds(root, ["merge", "--no-edit", FIXTURE_REFS.conflicting], mergeEnv);
    await assertConflictedPostcondition(root, env);
    return toWorkspace("conflicted", template);
}

/** `mid-rebase`: checks out `conflict/with-main` and rebases it onto `main`'s tip -- replaying its
 * one commit (which edits `conflict.txt`) on top of `main`'s own edit to the same line stops the
 * rebase on a real conflict, the same divergence `conflicted` above merges instead of rebases.
 * Cleaned first for the same reason `prepareConflicted` cleans first: `git rebase` refuses to
 * start while the seeded dirty layer's staged rename and binary file sit in the index, regardless
 * of `conflict.txt` itself being untouched by that layer. */
async function prepareMidRebase(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    const { root, env } = template;
    await runGit(root, ["reset", "--hard", "HEAD"], env);
    await runGit(root, ["clean", "-fdx", "--quiet"], env);
    const rebaseEnv = { ...env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
    await runGit(root, ["checkout", "--quiet", FIXTURE_REFS.conflicting], env);
    await gitSucceeds(root, ["rebase", FIXTURE_REFS.main], rebaseEnv);
    await assertMidRebasePostcondition(root, env);
    return toWorkspace("mid-rebase", template);
}

/** `detached-head`: detaches at `feature/awesome`'s third commit -- a real commit off every branch
 * tip, not the tip of whatever branch happened to be checked out already. */
async function prepareDetachedHead(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    const { root, env, commits } = template;
    await runGit(root, ["checkout", "--quiet", "--detach", commits.featureCommit3], env);
    await assertDetachedHeadPostcondition(root, env, commits.featureCommit3);
    return toWorkspace("detached-head", template);
}

/** `ahead-behind`: advances origin's `main` by one real commit pushed from a throwaway clone (so
 * local `main` is fetched-but-not-merged behind it), then adds one local commit on `main` that is
 * never pushed (so local `main` is ahead too). Both sides are real objects with real history --
 * never a hand-rolled ref pointing at nothing.
 *
 * Reverts the seeded dirty layer first (the same `reset --hard` + `clean -fdx` pair `prepareClean`,
 * `prepareConflicted`, and `prepareMidRebase` use) and then stages only `local-ahead.txt` by name.
 * This scenario exists to isolate ONE axis -- divergence from upstream -- and `dirty` already
 * covers dirtiness; a local commit built with `add -A` would instead sweep the dirty layer's staged
 * rename and binary file into it, making the commit an arbitrary grab-bag and leaving a working
 * tree that is clean only as a side effect nobody declared. Every non-`dirty` scenario in this
 * module therefore starts from a clean tree, and this one asserts that it ends on one too. */
async function prepareAheadBehind(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    const { root, env, originRoot } = template;
    await runGit(root, ["reset", "--hard", "HEAD"], env);
    await runGit(root, ["clean", "-fdx", "--quiet"], env);

    const advanceClone = path.join(destination, "origin-advance-clone");
    await runGit(
        destination,
        ["clone", "--quiet", "--branch", FIXTURE_REFS.main, originRoot, advanceClone],
        env,
    );
    await writeFile(
        path.join(advanceClone, "origin-advance.txt"),
        "origin advanced main\n",
        "utf8",
    );
    await runGit(advanceClone, ["add", "-A"], env);
    await runGit(advanceClone, ["commit", "--quiet", "-m", "Advance origin main"], env);
    await runGit(advanceClone, ["push", "--quiet", "origin", FIXTURE_REFS.main], env);
    await rm(advanceClone, { recursive: true, force: true });

    // Fetches (never merges) origin's new commit: local `main` stays put, so it becomes "behind".
    await runGit(root, ["fetch", "--quiet", FIXTURE_REFS.remote, FIXTURE_REFS.main], env);

    await writeFile(path.join(root, "local-ahead.txt"), "local main advanced\n", "utf8");
    await runGit(root, ["add", "local-ahead.txt"], env);
    await runGit(root, ["commit", "--quiet", "-m", "Local-only commit"], env);

    await assertCleanPostcondition(root, env);
    await assertAheadBehindPostcondition(root, env);
    return toWorkspace("ahead-behind", template);
}

/**
 * `empty-repo`: the one scenario that does NOT call `seedFixtureTemplate` -- there is no history
 * to build here at all. `ensureEmptyScenarioDestination` (the local equivalent of `seed.ts`'s own
 * emptiness guard) plus `createSanitizedGitEnv` plus a bare `git init` give this scenario the same
 * `env`/`home` shape every other scenario has, with `template` left `undefined` (the interface
 * already types it optional for exactly this case).
 */
async function prepareEmptyRepo(destination: string): Promise<ScenarioWorkspace> {
    await ensureEmptyScenarioDestination(destination);
    const { env, home } = await createSanitizedGitEnv();
    const root = path.join(destination, "workspace");
    await mkdir(root, { recursive: true });
    await runGit(root, ["init", "--quiet", "-b", FIXTURE_REFS.main], env);
    await assertEmptyRepoPostcondition(root, env);
    return { id: "empty-repo", root, env, home, template: undefined };
}

/**
 * Drops unset variables so a scenario env satisfies `GitExecutor`'s `Record<string, string>`
 * contract. The scenario env is a `NodeJS.ProcessEnv` because it spreads `process.env`, whose
 * values are typed `string | undefined`; every key present at runtime does hold a string, but
 * that is a runtime guarantee the type cannot express, so it is narrowed here explicitly rather
 * than asserted away at the call site.
 */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
}

/**
 * `shelf-populated`: shelves the seeded dirty layer's untracked `untracked.txt` through the real
 * production `ShelfService` -- the same `GitExecutor` / `RepositoryMutationGate` /
 * `RepositoryLock` / `ShelfStore` collaborators `tests/integration/shelf/shelfTestHarness.ts`
 * wires up. `shelfService.ts` does reach `require("vscode")` transitively, through
 * `GitOps` -> `src/git/operationSupport.ts`'s `getVsCodeApi()` -- but that call is wrapped in its
 * own `try/catch` and degrades to a `console.warn` fallback specifically so parser/operation-
 * support code can run outside the extension host (`operationSupport.ts:23-34`), which is exactly
 * this case. No `vscode` double or `throwingDouble.ts` was needed: the production code already
 * has its own escape hatch for a non-extension environment, so the Phase 2c-iii spec's Electron
 * escape hatch does not apply here. Shelf storage lives in its own directory beside the workspace
 * (`<destination>/shelf-storage`), mirroring where the real extension keeps it -- host-global
 * storage, never inside the repository working tree, so it never shows up in `git status`.
 */
async function prepareShelfPopulated(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    const { root, env } = template;

    const storageRoot = path.join(destination, "shelf-storage");
    const shelfPaths = await resolveShelfPaths({
        repositoryRoot: root,
        globalStoragePath: storageRoot,
    });
    const store = new ShelfStore(shelfPaths);
    // Third argument is the scenario's sanitized environment, not a convenience: without it this
    // builder's git subprocesses inherit the developer's global Git configuration, the exact defect
    // `recordingGitEnvironment.ts` documents. Added in Phase 2c-v-d alongside `shelf-conflicted`,
    // which had it from the start -- the two shelf builders must not disagree about this.
    const executor = new GitExecutor(root, undefined, definedEnv(env));
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const service = new ShelfService({ repositoryRoot: root, executor, store, gate });

    await service.shelve({
        name: "scenario-seeded-shelf",
        paths: ["untracked.txt"],
        silent: true,
        keepLocal: false,
    });

    await assertShelfPopulatedPostcondition(store);
    return toWorkspace("shelf-populated", template, storageRoot);
}

/**
 * `shelf-conflicted`: captures only the seeded dirty layer's `mutable.txt` through the real
 * `ShelfService`, then rewrites the worktree file so the production conflict-session opener sees
 * three distinct text sides. This builder intentionally does NOT run `reset --hard` or
 * `clean -fdx`: the dirty staged and unstaged layers are the shelf content that makes the
 * three-way session possible. The shelf root is carried on `ScenarioWorkspace` so a recorder uses
 * this exact store rather than reconstructing it from `path.dirname(workspace.root)`.
 */
async function prepareShelfConflicted(destination: string): Promise<ScenarioWorkspace> {
    const template = await seedFixtureTemplate(destination);
    const { root, env } = template;
    const storageRoot = path.join(destination, "shelf-storage");
    const shelfPaths = await resolveShelfPaths({
        repositoryRoot: root,
        globalStoragePath: storageRoot,
    });
    const store = new ShelfStore(shelfPaths);
    const executor = new GitExecutor(root, undefined, definedEnv(env));
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const service = new ShelfService({ repositoryRoot: root, executor, store, gate });

    await service.shelve({
        name: "scenario-seeded-conflict-shelf",
        paths: ["mutable.txt"],
        silent: true,
        keepLocal: false,
    });
    await writeFile(path.join(root, "mutable.txt"), "locally rewritten line\n", "utf8");

    await assertShelfConflictedPostcondition(store, service);
    return toWorkspace("shelf-conflicted", template, storageRoot);
}

// ---------------------------------------------------------------------------------------------

export const REPOSITORY_SCENARIOS: readonly RepositoryScenario[] = [
    {
        id: "clean",
        summary:
            "Seeded template with the dirty layer fully reverted: no modified or untracked paths.",
        prepare: prepareClean,
    },
    {
        id: "dirty",
        summary:
            "Seeded template exactly as built: staged, unstaged, untracked, binary, CRLF, and " +
            "renamed changes all present.",
        prepare: prepareDirty,
    },
    {
        id: "conflicted",
        summary:
            "An in-progress merge of conflict/with-main into main, stopped on a real content conflict.",
        prepare: prepareConflicted,
    },
    {
        id: "mid-rebase",
        summary: "A rebase of conflict/with-main onto main, stopped on a real content conflict.",
        prepare: prepareMidRebase,
    },
    {
        id: "detached-head",
        summary: "HEAD detached at feature/awesome's third commit, off every branch tip.",
        prepare: prepareDetachedHead,
    },
    {
        id: "ahead-behind",
        summary:
            "Clean tree, with local main both ahead of and behind origin/main by one real, " +
            "unpushed/unfetched commit each.",
        prepare: prepareAheadBehind,
    },
    {
        id: "empty-repo",
        summary: "A brand-new `git init` with no commits and no origin.",
        prepare: prepareEmptyRepo,
    },
    {
        id: "shelf-populated",
        summary:
            "Seeded template with one real IntelliGit shelf entry captured through the " +
            "production ShelfService.",
        prepare: prepareShelfPopulated,
    },
    {
        id: "shelf-conflicted",
        summary:
            "Seeded mutable.txt shelf content plus a divergent local rewrite that opens a real " +
            "three-way shelf conflict session.",
        prepare: prepareShelfConflicted,
    },
];
