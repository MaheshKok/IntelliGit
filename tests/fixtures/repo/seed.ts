/**
 * Builds the deterministic fixture git repository template that every visual- and E2E-testing
 * layer restores from (PLAN.md Phase 1, step 7). The template this file writes is copied
 * wholesale per test by the Phase 1 step 8 harness -- never mutated in place -- so everything
 * seeded here must be reproducible byte-for-byte across machines and across repeated seed calls:
 * identical content, committed at a fixed identity and fixed dates, always yields identical
 * object SHAs. `tests/unit/fixtures/seed.test.ts` proves this by seeding into two independent
 * destinations and diffing their full ref/SHA lists.
 *
 * Sanitization technique: the fixed-identity/fixed-date half of
 * `tests/integration/rebase/rebaseTestHarness.ts`'s `deterministicGitEnvironment`, extended with
 * the scratch-`HOME` plus nulled global/system config half of
 * `tests/e2e/hostFixtures/electronLaunchHelpers.ts`'s `createSanitizedGitEnv`. Reproduced here
 * rather than imported from either: this module is the foundational one in the fixture stack (the
 * Phase 1 step 8 harness and the Phase 2 recorder both build on it), so the dependency should run
 * from those files toward this one, never the reverse.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Fixed identity for every commit, merge, tag, and stash entry this seed creates. */
const FIXTURE_GIT_IDENTITY = {
    GIT_AUTHOR_NAME: "IntelliGit Fixture Repo",
    GIT_AUTHOR_EMAIL: "intelligit-fixture@example.invalid",
    GIT_COMMITTER_NAME: "IntelliGit Fixture Repo",
    GIT_COMMITTER_EMAIL: "intelligit-fixture@example.invalid",
} as const;

/**
 * Default date baked into the exported sanitized environment, matching the exact instant
 * `rebaseTestHarness.ts` and `electronLaunchHelpers.ts` both use. Callers who reuse `env` directly
 * (the extension's own subprocesses, the Phase 2 recorder) get this fixed date unless they override
 * it themselves; the seed's own history below overrides it per commit via `createDeterministicClock`.
 */
const EPOCH_DATE = "2000-01-01T00:00:00 +0000";

/**
 * Branch, tag, and remote names used throughout the seeded history, exported so tests and future
 * consumers (the Phase 1 step 8 harness, the Phase 2 recorder) reference one shared name instead of
 * a duplicated string literal.
 */
export const FIXTURE_REFS = {
    main: "main",
    feature: "feature/awesome",
    conflicting: "conflict/with-main",
    topic: "topic/mergeable",
    tag: "v1.0.0",
    remote: "origin",
} as const;

/** Bytes 0-255 in order: guarantees a NUL byte, which is git's own binary-content heuristic, without
 * depending on a real image or archive fixture. */
const BINARY_FIXTURE_CONTENT = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));

/** A sanitized, deterministic git environment plus the scratch `HOME` backing it. */
export interface SanitizedGitEnv {
    /** Pass as `env` to every git process that must touch this fixture deterministically. */
    readonly env: NodeJS.ProcessEnv;
    /** Scratch `HOME` backing `env.HOME`. Caller-owned: nothing in this module removes it, since
     * `env` is meant to keep working after the call that created it returns. */
    readonly home: string;
}

/** Deterministic commit SHAs a consuming test can assert against directly, without re-deriving them
 * by walking history. */
interface FixtureCommits {
    /** `Initial commit` -- README, `.gitignore`, and the two files the dirty layer/stash entries reuse. */
    readonly initial: string;
    /** `Add conflict target` -- the merge-base every side of the conflicting branch diverges from. */
    readonly conflictBase: string;
    /** `Modify conflict target on main` -- main's own edit of the file `conflict/with-main` conflicts on. */
    readonly mainConflictEdit: string;
    /** `Add feature fork file` -- the merge-base `feature/awesome` and `topic/mergeable` both diverge from. */
    readonly featureBase: string;
    /** `Add topic file`, on `topic/mergeable` before it is merged into `main`. */
    readonly topicCommit: string;
    /** The `--no-ff` merge of `topic/mergeable` into `main`; `main`'s tip. */
    readonly mergeCommit: string;
    /** `Feature commit 3`; `feature/awesome`'s tip. */
    readonly featureCommit3: string;
    /** `Conflicting edit`; `conflict/with-main`'s tip. */
    readonly conflictCommit: string;
}

/** Everything `seedFixtureTemplate` built, and what a caller needs in order to use or dispose of it. */
export interface FixtureTemplate extends SanitizedGitEnv {
    /** Absolute path to the seeded working-tree repository. */
    readonly root: string;
    /** Absolute path to the bare `origin` repository. */
    readonly originRoot: string;
    /** Named commit SHAs; see {@link FixtureCommits}. */
    readonly commits: FixtureCommits;
}

/**
 * Builds a sanitized, deterministic git environment: a scratch `HOME`, both global and system git
 * config pointed at `/dev/null`, and a fixed author/committer identity -- so no developer's real
 * `~/.gitconfig`, credential helper, or ambient date can reach a git process run with this env, and
 * two processes run with it produce identical objects for identical content. Mirrors
 * `tests/e2e/hostFixtures/electronLaunchHelpers.ts`'s `createSanitizedGitEnv` (same technique, same
 * rigor) so every layer of the fixture stack shares one convention.
 *
 * Returns the scratch `HOME` rather than deleting it, and returns it instead of pushing it onto a
 * caller-supplied cleanup array: the returned `env` must keep working for as long as the caller
 * needs it, so disposal has to happen on the caller's own schedule, and returning a plain value
 * keeps this function from mutating anything it does not own.
 *
 * `options.homeParent` overrides the parent directory the scratch `HOME` is created under
 * (defaulting to `tmpdir()`, this module's own one-time template build). PLAN.md line 92 requires
 * the Phase 1 step 8 harness to root per-test HOME/TMPDIR/TMP/TEMP beneath a FIXTURE-OWNED root
 * rather than the OS temp dir, so that per-test caller passes its own root here instead.
 *
 * `LC_ALL`/`LANG` are pinned to `C` for the same reason the identity and dates are: git's porcelain
 * output is translated, and this env is what scenario postconditions run their `git status` through
 * (`scenarios.ts`'s `assertMidRebasePostcondition` matches `/rebas/i` on that output). A developer
 * or CI runner with a non-English locale installed would get translated text, and the postcondition
 * would report a scenario as un-built when it built correctly. They come AFTER the `process.env`
 * spread deliberately -- an ambient `LC_ALL` must be overridden here, not inherited.
 */
export async function createSanitizedGitEnv(options?: {
    readonly homeParent?: string;
}): Promise<SanitizedGitEnv> {
    const homeParent = options?.homeParent ?? tmpdir();
    const home = await mkdtemp(path.join(homeParent, "intelligit-fixture-home-"));
    return {
        home,
        env: {
            ...process.env,
            HOME: home,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            LC_ALL: "C",
            LANG: "C",
            ...FIXTURE_GIT_IDENTITY,
            GIT_AUTHOR_DATE: EPOCH_DATE,
            GIT_COMMITTER_DATE: EPOCH_DATE,
        },
    };
}

/**
 * Removes a scratch path allocated before a failure, then rethrows that failure.
 *
 * The rethrow is the whole point, and the `try` around the removal is what protects it. `rm` can
 * reject on its own account -- a path the filesystem refuses, a permission change, a busy handle --
 * and a bare `await rm(...)` inside a `catch` block lets that rejection REPLACE the error being
 * handled. The caller is then told the cleanup failed and never learns why the seed failed, which
 * is precisely the defect the recorder tests' teardown used to have: a `TypeError` thrown while
 * removing directories displaced the seeding error it existed to report. A cleanup failure is
 * strictly less informative than the failure that caused it, so it is reported on the side and
 * never propagated.
 */
export async function cleanUpThenRethrow(scratchPath: string, error: unknown): Promise<never> {
    try {
        await rm(scratchPath, { recursive: true, force: true });
    } catch (cleanupError) {
        // Reported, not swallowed: a leaked scratch directory is worth knowing about, but not at
        // the cost of the error below, which is the one that explains the failure.
        console.warn(
            `Failed to remove the scratch path ${scratchPath} after an error; ` +
                `it has been leaked. Cleanup failure: ${String(cleanupError)}`,
        );
    }
    throw error;
}

/**
 * Builds the fixture repository template into `destination`: a working-tree repository at
 * `<destination>/workspace` with the history, branches, tag, dirty working tree, and stash entries
 * PLAN.md Phase 1 step 7 requires, plus a bare `origin` at `<destination>/origin.git` that `main`
 * tracks. `destination` must be empty (or not yet exist) -- seeding on top of leftover files would
 * risk silently passing with stale content instead of failing loudly.
 *
 * `options.homeParent` is forwarded to `createSanitizedGitEnv`; it defaults to the OS temp root,
 * which is what every production caller wants. Pass it to keep the sanitized `HOME` inside a
 * directory the caller already owns -- the cleanup test below needs a parent it can assert is
 * empty, and scanning the shared OS temp root cannot do that while sibling test files are seeding
 * their own homes concurrently.
 */
export async function seedFixtureTemplate(
    destination: string,
    options?: { readonly homeParent?: string },
): Promise<FixtureTemplate> {
    await ensureEmptyDestination(destination);

    const { env, home } = await createSanitizedGitEnv({ homeParent: options?.homeParent });
    try {
        const root = path.join(destination, "workspace");
        await initializeWorkingRepository(root, env);

        const history: HistoryEnv = { root, env, nextDate: createDeterministicClock() };
        const { initial, conflictBase, mainConflictEdit, featureBase, topicCommit, mergeCommit } =
            await buildMainAndTopicHistory(history);
        const featureCommit3 = await buildFeatureBranch(history, featureBase);
        const conflictCommit = await buildConflictingBranch(history, conflictBase);
        await createReleaseTag(history);

        const originRoot = await createBareOrigin(destination, root, env);

        // Dirty state is seeded last, after history/tag/origin are all in place on a clean `main`
        // checkout, so nothing below has to account for it existing any earlier.
        await seedStashEntries(history);
        await seedDirtyWorkingTree(history);

        return {
            root,
            originRoot,
            env,
            home,
            commits: {
                initial,
                conflictBase,
                mainConflictEdit,
                featureBase,
                topicCommit,
                mergeCommit,
                featureCommit3,
                conflictCommit,
            },
        };
    } catch (error) {
        // `home` lives OUTSIDE `destination` -- it is `mkdtemp`'d in `homeParent`, the OS temp root
        // by default. A caller cleaning up after this rejection therefore cannot reach it, and it
        // has not been handed the path either: the only reference dies with this frame. Remove it
        // here or every failed seed leaks a directory for the lifetime of the machine.
        return await cleanUpThenRethrow(home, error);
    }
}

/** Threaded through every history-building helper below: where to write, which env to run git
 * with, and the next deterministic date to stamp on the object about to be created. */
interface HistoryEnv {
    readonly root: string;
    readonly env: NodeJS.ProcessEnv;
    readonly nextDate: () => string;
}

/** Fails fast rather than seeding on top of leftover files, which could pass by accident instead
 * of by construction. Creates `destination` if it does not exist yet. */
async function ensureEmptyDestination(destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(destination);
    if (entries.length > 0) {
        throw new Error(
            `seedFixtureTemplate: destination "${destination}" is not empty ` +
                `(found ${entries.length} existing entries). Seed into a fresh directory.`,
        );
    }
}

/**
 * Produces a monotonically increasing, fully deterministic date string for each successive git
 * object this seed creates (one call per commit, merge, tag, or stash push). A single shared
 * instant -- the convention `rebaseTestHarness.ts` and `electronLaunchHelpers.ts` both use -- would
 * be exactly as reproducible, but this fixture's multi-branch history feeds graph lane colouring,
 * where a real chronological order removes date-based tie-breaking ambiguity a renderer might
 * otherwise hit. The counter is process-local, not wall-clock-derived, so determinism is unaffected.
 */
function createDeterministicClock(): () => string {
    const epochMs = Date.parse("2000-01-01T00:00:00Z");
    const stepMs = 60 * 60 * 1000;
    let tick = 0;
    return () => {
        const isoInstant = new Date(epochMs + tick * stepMs).toISOString().slice(0, 19);
        tick += 1;
        return `${isoInstant} +0000`;
    };
}

/** Runs one git process against `cwd` with `env`, returning trimmed stdout as UTF-8. Every seed
 * operation goes through this single seam so the deterministic environment can never be bypassed
 * by a stray direct `execFile` call. Reads stdout as a buffer, then decodes explicitly -- the
 * proven-working pattern already used by `rebaseTestHarness.ts`, avoiding `promisify(execFile)`'s
 * awkward overload resolution when an `encoding` string is passed directly. */
async function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8").trim();
}

/** Runs `git` with `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` overridden to `when`, for the one call
 * that actually creates the dated object (a commit, merge, tag, or stash push). */
async function gitAt(
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    when: string,
): Promise<string> {
    return git(cwd, args, { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
}

/** Stages every pending change and commits it at the next deterministic date, returning the new
 * commit's SHA. */
async function commitAll(history: HistoryEnv, message: string): Promise<string> {
    const when = history.nextDate();
    await gitAt(history.root, ["add", "-A"], history.env, when);
    await gitAt(history.root, ["commit", "--quiet", "-m", message], history.env, when);
    return git(history.root, ["rev-parse", "HEAD"], history.env);
}

async function writeTrackedFile(
    root: string,
    relativePath: string,
    content: string,
): Promise<void> {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
}

async function writeBinaryFile(root: string, relativePath: string, content: Buffer): Promise<void> {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
}

/** `git init`s the working tree and pins every repo-local config value PLAN.md step 7 requires, in
 * addition to the global/system config `createSanitizedGitEnv` already nulled out -- so the repo
 * behaves identically regardless of which machine or git version built or later reads it. */
async function initializeWorkingRepository(root: string, env: NodeJS.ProcessEnv): Promise<void> {
    await mkdir(root, { recursive: true });
    await git(root, ["init", "--quiet", "-b", FIXTURE_REFS.main], env);

    const repoConfig: ReadonlyArray<readonly [key: string, value: string]> = [
        ["core.autocrlf", "false"],
        ["core.ignorecase", "false"],
        ["init.defaultBranch", FIXTURE_REFS.main],
        ["gc.auto", "0"],
        ["commit.gpgsign", "false"],
        // Pinned, and pinned to a REALISTIC width. Git's default abbreviation auto-scales with
        // object count, so leaving it unset would let `%h` silently change as later phases add
        // commits to this template -- that is why it is pinned at all. But pinning it to the full
        // 40 buys determinism by making every abbreviated hash stop being abbreviated: `%h` then
        // equals `%H`, and every recorded payload and baseline screenshot renders a 40-character
        // string in a chip no user ever sees hold more than ~8. Later phases pixel-compare those
        // baselines, so the unrealistic width would be baked into the truncation and layout they
        // assert on. An explicit small width is equally deterministic and actually resembles what
        // the extension renders.
        ["core.abbrev", "8"],
    ];
    for (const [key, value] of repoConfig) {
        await git(root, ["config", key, value], env);
    }
}

/**
 * Builds the linear part of `main`'s history plus the `topic/mergeable` branch merged into it,
 * establishing `conflictBase` (where the conflicting branch diverges) and `featureBase` (where both
 * `feature/awesome` and `topic/mergeable` diverge -- the multi-lane region: three branches share
 * this ancestry before `topic/mergeable` merges back and `feature/awesome` stays open).
 */
async function buildMainAndTopicHistory(history: HistoryEnv): Promise<{
    readonly initial: string;
    readonly conflictBase: string;
    readonly mainConflictEdit: string;
    readonly featureBase: string;
    readonly topicCommit: string;
    readonly mergeCommit: string;
}> {
    const { root, env } = history;

    await writeTrackedFile(root, "README.md", "# IntelliGit Fixture Repo\n");
    await writeTrackedFile(root, ".gitignore", "*.log\nignored/\n");
    // Reused later: `mutable.txt` by stash entry one and the staged-and-unstaged dirty file;
    // `stash-target.txt` by stash entry two. Committing them now keeps both untouched by history.
    await writeTrackedFile(root, "mutable.txt", "mutable original\n");
    await writeTrackedFile(root, "stash-target.txt", "stash target original\n");
    const initial = await commitAll(history, "Initial commit");

    await writeTrackedFile(root, "conflict.txt", "one\ntwo\nthree\n");
    const conflictBase = await commitAll(history, "Add conflict target");

    await writeTrackedFile(root, "conflict.txt", "one\nTWO-MAIN\nthree\n");
    const mainConflictEdit = await commitAll(history, "Modify conflict target on main");

    await writeTrackedFile(root, "fork.txt", "fork\n");
    const featureBase = await commitAll(history, "Add feature fork file");

    await git(root, ["branch", FIXTURE_REFS.topic, featureBase], env);
    await git(root, ["checkout", "--quiet", FIXTURE_REFS.topic], env);
    await writeTrackedFile(root, "topic.txt", "topic\n");
    const topicCommit = await commitAll(history, "Add topic file");

    await git(root, ["checkout", "--quiet", FIXTURE_REFS.main], env);
    const mergeWhen = history.nextDate();
    await gitAt(
        root,
        [
            "merge",
            "--no-ff",
            "--quiet",
            "-m",
            `Merge branch '${FIXTURE_REFS.topic}'`,
            FIXTURE_REFS.topic,
        ],
        env,
        mergeWhen,
    );
    const mergeCommit = await git(root, ["rev-parse", "HEAD"], env);

    return { initial, conflictBase, mainConflictEdit, featureBase, topicCommit, mergeCommit };
}

/** Branches `feature/awesome` from `featureBase` with three commits, then returns to `main`.
 * Ahead/behind of `main` is a consequence of topology, not asserted here -- see
 * `tests/unit/fixtures/seed.test.ts`, which checks it with real `rev-list --count` calls. */
async function buildFeatureBranch(history: HistoryEnv, featureBase: string): Promise<string> {
    const { root, env } = history;
    await git(root, ["branch", FIXTURE_REFS.feature, featureBase], env);
    await git(root, ["checkout", "--quiet", FIXTURE_REFS.feature], env);
    await writeTrackedFile(root, "feature1.txt", "f1\n");
    await commitAll(history, "Feature commit 1");
    await writeTrackedFile(root, "feature2.txt", "f2\n");
    await commitAll(history, "Feature commit 2");
    await writeTrackedFile(root, "feature3.txt", "f3\n");
    const featureCommit3 = await commitAll(history, "Feature commit 3");
    await git(root, ["checkout", "--quiet", FIXTURE_REFS.main], env);
    return featureCommit3;
}

/** Branches `conflict/with-main` from `conflictBase` and edits the same line of `conflict.txt`
 * that `main`'s own `mainConflictEdit` commit touched, from the same ancestor -- a real,
 * mergeable-only-with-conflict-markers divergence, not a synthetic label. */
async function buildConflictingBranch(history: HistoryEnv, conflictBase: string): Promise<string> {
    const { root, env } = history;
    await git(root, ["branch", FIXTURE_REFS.conflicting, conflictBase], env);
    await git(root, ["checkout", "--quiet", FIXTURE_REFS.conflicting], env);
    await writeTrackedFile(root, "conflict.txt", "one\nTWO-CONFLICT\nthree\n");
    const conflictCommit = await commitAll(history, "Conflicting edit");
    await git(root, ["checkout", "--quiet", FIXTURE_REFS.main], env);
    return conflictCommit;
}

async function createReleaseTag(history: HistoryEnv): Promise<void> {
    const when = history.nextDate();
    await gitAt(
        history.root,
        ["tag", "-a", FIXTURE_REFS.tag, "-m", `Release ${FIXTURE_REFS.tag}`],
        history.env,
        when,
    );
}

/** Initializes a bare repository at `<destination>/origin.git`, wires it as `main`'s upstream over
 * a `file://` URL, and pushes `main` plus the release tag -- so push, pull, fetch, publish-branch,
 * force-push-with-lease, and ahead/behind all have a real other side to act against. */
async function createBareOrigin(
    destination: string,
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<string> {
    const originRoot = path.join(destination, "origin.git");
    await git(destination, ["init", "--quiet", "--bare", originRoot], env);
    const originUrl = pathToFileURL(originRoot).href;
    await git(root, ["remote", "add", FIXTURE_REFS.remote, originUrl], env);
    await git(root, ["push", "--quiet", "-u", FIXTURE_REFS.remote, FIXTURE_REFS.main], env);
    await git(root, ["push", "--quiet", FIXTURE_REFS.remote, FIXTURE_REFS.tag], env);
    return originRoot;
}

/**
 * Pre-seeds two `refs/stash` entries from throwaway edits to `mutable.txt` and `stash-target.txt`,
 * each `git stash push` returning the working tree to a clean checkout of `main` before the next
 * edit -- so neither stash entry collides with the dirty layer `seedDirtyWorkingTree` builds next.
 */
async function seedStashEntries(history: HistoryEnv): Promise<void> {
    const { root, env } = history;

    await writeTrackedFile(root, "mutable.txt", "stash one content\n");
    const stash1When = history.nextDate();
    await gitAt(root, ["stash", "push", "--quiet", "-m", "stash entry one"], env, stash1When);

    await writeTrackedFile(root, "stash-target.txt", "stash two content\n");
    const stash2When = history.nextDate();
    await gitAt(root, ["stash", "push", "--quiet", "-m", "stash entry two"], env, stash2When);
}

/**
 * Leaves `main`'s working tree dirty in every way PLAN.md step 7 lists: an ignored file, an
 * untracked file, a file with both staged and unstaged changes, a staged new binary file, an
 * untracked file with literal CRLF line endings, and a staged rename. This runs last, after the
 * stash entries above, and is never committed -- it is the state every restored test copy starts
 * from on top of the committed history.
 */
async function seedDirtyWorkingTree(history: HistoryEnv): Promise<void> {
    const { root, env } = history;

    // Ignored: matches the `ignored/` pattern committed in `.gitignore` during `Initial commit`.
    await writeTrackedFile(root, "ignored/build.log", "throwaway build output\n");

    // Untracked: new, not ignore-matched, never staged.
    await writeTrackedFile(root, "untracked.txt", "untracked content\n");

    // Staged-and-unstaged: one `git add` captures the first edit; a further edit on top is left
    // unstaged, so `git status --porcelain` reports `MM`.
    await writeTrackedFile(root, "mutable.txt", "staged change\n");
    await git(root, ["add", "mutable.txt"], env);
    await writeTrackedFile(root, "mutable.txt", "staged change\nplus unstaged addition\n");

    // Binary: staged as a new file, never committed.
    await writeBinaryFile(root, "binary.bin", BINARY_FIXTURE_CONTENT);
    await git(root, ["add", "binary.bin"], env);

    // CRLF: written with literal `\r\n` and left untracked, so nothing -- `core.autocrlf` is
    // pinned off regardless -- can normalize it before a test reads the raw bytes back off disk.
    await writeTrackedFile(root, "crlf.txt", "first line\r\nsecond line\r\nthird line\r\n");

    // Renamed: `topic.txt` reached `main` through the topic-branch merge above, so this rename is
    // staged against real tracked history rather than a same-commit synthetic file.
    await git(root, ["mv", "topic.txt", "topic-renamed.txt"], env);
}
