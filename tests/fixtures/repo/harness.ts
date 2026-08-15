/**
 * Per-test workspace factory (PLAN.md Phase 1 step 8, the third and final slice of this step --
 * builds on `copyTemplate.ts`, `rehydrate.ts`, and this file's own sibling `manifest.ts`).
 * `createFixtureWorkspace()` is what a Playwright test actually calls: it reads the atomic per-run
 * manifest a setup project already published (`manifest.ts`), copies the template it names,
 * rehydrates the copy so it is independently functional, allocates every fixture-owned scratch
 * directory PLAN.md line 92 requires, and returns a handle a test drives directly.
 *
 * This module is deliberately plain, Playwright-free TypeScript: it imports nothing from
 * `@playwright/test` and is fully exercisable from vitest without Playwright running at all. Slice
 * 8c-ii wires it into an actual Playwright setup/teardown project and per-test fixture on top of
 * this file; that wiring is out of scope here.
 *
 * **Fixture-owned scratch directories (PLAN.md line 92, Codex R3 #7).** The extension itself
 * writes outside the repository, the profile, and every durable store via `os.tmpdir()`-rooted
 * `mkdtemp` calls at 9 sites in `src/`. An interrupted flow leaks those into the shared OS temp
 * directory, where no reset target reaches them and a later, unrelated test can observe them.
 * Every workspace this factory returns therefore allocates its own `HOME` (via `seed.ts`'s
 * `createSanitizedGitEnv({ homeParent })`, which is the option that module exists to serve), its
 * own `TMPDIR`/`TMP`/`TEMP` (three platform-conventional names for the same one directory, so a
 * leaked temp file lands beneath this workspace's own root on every OS this suite runs on), and its
 * own VS Code profile directory -- all four as children of one `dispose()`-owned root, so cleanup
 * is "remove one directory tree," never a hand-maintained list of scratch paths to also remember.
 *
 * **Reset is dispose() + a fresh copy, never in-place undo (PLAN.md line 60).** This module has no
 * "reset" or "restore" function at all -- a caller that wants a clean workspace calls `dispose()`
 * on the old handle and `createFixtureWorkspace()` again. That is also why two concurrent handles
 * from two separate calls must be provably independent: `tests/unit/e2e/harness.test.ts` mutates
 * one workspace and asserts neither the other workspace nor the template changed.
 *
 * **`dispose()` and linked worktrees (PLAN.md step 9's own note, carried into step 8's contract).**
 * A linked worktree's directory lives OUTSIDE the repository root that owns it -- that is what
 * "linked" means -- so deleting only the fixture-owned root would leave it behind. `dispose()`
 * therefore runs `git worktree list --porcelain` against the workspace and removes every entry
 * after the first (the first is always the primary worktree, which lives inside the fixture-owned
 * root and is covered by that root's own removal -- see `snapshotWorktrees.ts`'s identical
 * reasoning) before removing the root itself.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyTemplate } from "./copyTemplate";
import { runGit } from "./gitRun";
import { DEFAULT_MANIFEST_PATH, readFixtureManifest } from "./manifest";
import { rehydrateCopy } from "./rehydrate";
import {
    REPOSITORY_SCENARIOS,
    type RepositoryScenarioId,
} from "./scenarios";
import { createSanitizedGitEnv } from "./seed";

/** What `createFixtureWorkspace()` returns -- matches PLAN.md line 60's stated shape
 * (`{ root, originRoot, profileDir, dispose }`) plus `env`, which every caller needs in order to
 * actually route git subprocesses and the eventual `_electron.launch` child process through this
 * workspace's own fixture-owned scratch directories rather than the ambient environment. */
export interface FixtureWorkspace {
    /** Absolute path to this workspace's working-tree repository (the rehydrated copy's `workspace/`). */
    readonly root: string;
    /** Absolute path to this workspace's own bare `origin` (the rehydrated copy's `origin.git/`). */
    readonly originRoot: string;
    /** Absolute path to this workspace's own, empty VS Code profile directory. */
    readonly profileDir: string;
    /** Absolute path to the scenario's shelf storage root, when the scenario creates one. */
    readonly shelfStorageRoot?: string;
    /** Sanitized git env whose `HOME`, `TMPDIR`, `TMP`, and `TEMP` all resolve beneath this
     * workspace's own fixture-owned root (PLAN.md line 92). Pass this as `env` to every git
     * subprocess this test spawns, and to the `_electron.launch` child process, so anything either
     * one leaks lands inside this workspace's root instead of the shared OS temp directory. */
    readonly env: NodeJS.ProcessEnv;
    /** Removes this workspace's entire fixture-owned root, including every linked worktree living
     * outside it. Idempotent: a second call is a no-op, never a throw. */
    dispose(): Promise<void>;
}

export interface CreateFixtureWorkspaceOptions {
    /** Where to read the atomic per-run manifest from. Defaults to {@link DEFAULT_MANIFEST_PATH}. */
    readonly manifestPath?: string;
    /** Repository scenario to prepare instead of reading the default manifest. */
    readonly scenario?: FixtureScenarioId;
    /** The parent directory this call's own fixture-owned root is allocated under (via `mkdtemp`,
     * so concurrent calls never collide). Defaults to {@link DEFAULT_WORKSPACES_ROOT}. */
    readonly workspacesRoot?: string;
}

/** Scenario IDs valid for a `FixtureWorkspace`; `empty-repo` has no origin and is excluded. */
export type FixtureScenarioId = Exclude<RepositoryScenarioId, "empty-repo">;

const WORKSPACE_ROOT_PREFIX = "ig-XXXXXX";
const WORKSPACE_PROFILE_DIR = "profile";
const VSCODE_MAIN_SOCKET_NAME = "1.13-main.sock";
const SHORT_WORKSPACES_ROOT_NAME = "i";

/**
 * Derives a workspace parent that leaves room for VS Code's main-process Unix socket. The
 * calculation is pure so a macOS-shaped temp path is tested on every platform; the shortened
 * sibling remains the parent of the same dispose-owned root, so HOME, temp, copy, and profile
 * cleanup retain one ownership boundary.
 */
export function deriveWorkspacesRoot(candidateParent: string, socketPathLimit: number): string {
    if (!Number.isInteger(socketPathLimit) || socketPathLimit <= 0) {
        throw new RangeError(`socketPathLimit must be a positive integer, got ${socketPathLimit}`);
    }

    const fits = (parent: string): boolean =>
        path.join(parent, WORKSPACE_ROOT_PREFIX, WORKSPACE_PROFILE_DIR, VSCODE_MAIN_SOCKET_NAME)
            .length <= socketPathLimit;
    if (fits(candidateParent)) {
        return candidateParent;
    }

    const shortenedSibling = path.join(path.dirname(candidateParent), SHORT_WORKSPACES_ROOT_NAME);
    if (fits(shortenedSibling)) {
        return shortenedSibling;
    }

    const shortestPath = path.join(path.parse(candidateParent).root, SHORT_WORKSPACES_ROOT_NAME);
    throw new RangeError(
        `Cannot derive a creatable workspaces root for candidateParent "${candidateParent}" with socketPathLimit ${socketPathLimit}; shortest path attempted was "${shortestPath}".`,
    );
}

/** The runner-known default parent for every workspace's own fixture-owned root, when a caller does
 * not supply `workspacesRoot`. A fixed location under the OS temp directory, exactly like
 * `manifest.ts`'s `DEFAULT_MANIFEST_PATH`; macOS gets the short sibling required by `sun_path`,
 * while Linux keeps the readable temp-rooted path because it already fits its socket budget. */
export const DEFAULT_WORKSPACES_ROOT = deriveWorkspacesRoot(
    path.join(tmpdir(), "intelligit-e2e-workspaces"),
    process.platform === "darwin" ? 104 : 108,
);

/**
 * Builds one independent, fully-functional per-test fixture workspace: the default path reads the
 * manifest and copies the template it names, while a selected scenario prepares its own repository;
 * both paths allocate this workspace's own scratch directories and return the same handle shape.
 * Every call -- including two calls in the same process -- produces a wholly independent workspace:
 * independent copy (its own inodes, per `copyTemplate.ts`'s own contract), independent origin,
 * independent `HOME`/`TMPDIR`/`TMP`/`TEMP`, independent profile directory.
 *
 * Propagates whatever `readFixtureManifest`, `copyTemplate`, or `rehydrateCopy` throw, unmodified --
 * a missing/malformed manifest, a symlink-containment violation, or a rehydration failure are all
 * real construction failures this function does not paper over. It does, however, take its own root
 * back down before rethrowing: `dispose()` is the only thing that ever removes that root and it only
 * exists on the handle this function returns, so a throw after `mkdtemp` would otherwise leave a
 * full workspace copy with no owner at all. `runFixtureTeardown` removes the template directory and
 * the manifest, never a workspace root, and `DEFAULT_WORKSPACES_ROOT` is a fixed path under the OS
 * temp directory -- so those orphans accumulate run over run rather than being reclaimed later.
 */
export async function createFixtureWorkspace(
    options?: CreateFixtureWorkspaceOptions,
): Promise<FixtureWorkspace> {
    const workspacesRoot = options?.workspacesRoot ?? DEFAULT_WORKSPACES_ROOT;

    if (options?.scenario === undefined) {
        const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH;
        const manifest = await readFixtureManifest(manifestPath);

        await mkdir(workspacesRoot, { recursive: true });
        const ownRoot = await mkdtemp(path.join(workspacesRoot, "ig-"));
        try {
            const { root, originRoot, profileDir, env } = await allocateWorkspace(
                ownRoot,
                manifest.templateRoot,
            );

            return { root, originRoot, profileDir, env, dispose: createDisposer(ownRoot, root, env) };
        } catch (error) {
            // Best-effort, and deliberately not allowed to replace the diagnosis: the caller needs
            // to know WHY construction failed, and a cleanup error raised in its place would bury
            // that. `force: true` already absorbs the case where nothing was created yet.
            await rm(ownRoot, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }

    await mkdir(workspacesRoot, { recursive: true });
    const ownRoot = await mkdtemp(path.join(workspacesRoot, "ig-"));
    try {
        const { root, originRoot, profileDir, env, shelfStorageRoot } =
            await allocateScenarioWorkspace(ownRoot, options.scenario);
        return {
            root,
            originRoot,
            profileDir,
            env,
            shelfStorageRoot,
            dispose: createDisposer(ownRoot, root, env),
        };
    } catch (error) {
        // Best-effort, and deliberately not allowed to replace the diagnosis: the caller needs
        // to know WHY construction failed, and a cleanup error raised in its place would bury
        // that. `force: true` already absorbs the case where nothing was created yet.
        await rm(ownRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

/** The construction half of {@link createFixtureWorkspace}, split out so the function above stays a
 * short, readable top-level sequence: allocate this workspace's scratch directories, copy the
 * template into this workspace's own root, then rehydrate that copy. */
async function allocateWorkspace(
    ownRoot: string,
    templateRoot: string,
): Promise<{
    readonly root: string;
    readonly originRoot: string;
    readonly profileDir: string;
    readonly env: NodeJS.ProcessEnv;
}> {
    const scratchTmpDir = path.join(ownRoot, "tmp");
    const profileDir = path.join(ownRoot, "profile");
    await Promise.all([
        mkdir(scratchTmpDir, { recursive: true }),
        mkdir(profileDir, { recursive: true }),
    ]);

    // `homeParent: ownRoot` is the exact hook `createSanitizedGitEnv`'s own doc comment says PLAN.md
    // line 92 exists to use: without it, `HOME` would land directly under the shared OS temp
    // directory, exactly the leak this workspace's own root is supposed to contain.
    const sanitized = await createSanitizedGitEnv({ homeParent: ownRoot });
    const env: NodeJS.ProcessEnv = {
        ...sanitized.env,
        TMPDIR: scratchTmpDir,
        TMP: scratchTmpDir,
        TEMP: scratchTmpDir,
    };

    const copyDestination = path.join(ownRoot, "copy");
    await copyTemplate(templateRoot, copyDestination);
    await rehydrateCopy(copyDestination, env);

    return {
        root: path.join(copyDestination, "workspace"),
        originRoot: path.join(copyDestination, "origin.git"),
        profileDir,
        env,
    };
}

/** Builds a selected non-empty repository scenario inside the caller-owned root and adds the
 * profile and temporary directories that the returned fixture process tree must also own. */
async function allocateScenarioWorkspace(
    ownRoot: string,
    scenarioId: FixtureScenarioId,
): Promise<{
    readonly root: string;
    readonly originRoot: string;
    readonly profileDir: string;
    readonly env: NodeJS.ProcessEnv;
    readonly shelfStorageRoot?: string;
}> {
    const scenario = REPOSITORY_SCENARIOS.find(({ id }) => id === scenarioId);
    if (scenario === undefined || scenario.id === "empty-repo") {
        throw new Error(
            `createFixtureWorkspace: scenario "${scenarioId}" is not a valid origin-backed fixture scenario.`,
        );
    }

    const scratchTmpDir = path.join(ownRoot, "tmp");
    const profileDir = path.join(ownRoot, WORKSPACE_PROFILE_DIR);
    await Promise.all([
        mkdir(scratchTmpDir, { recursive: true }),
        mkdir(profileDir, { recursive: true }),
    ]);

    const scenarioWorkspace = await scenario.prepare(path.join(ownRoot, "copy"), {
        homeParent: ownRoot,
    });
    if (scenarioWorkspace.template === undefined) {
        throw new Error(
            `createFixtureWorkspace: scenario "${scenarioId}" did not provide an origin-backed template.`,
        );
    }

    const env: NodeJS.ProcessEnv = {
        ...scenarioWorkspace.env,
        TMPDIR: scratchTmpDir,
        TMP: scratchTmpDir,
        TEMP: scratchTmpDir,
    };
    return {
        root: scenarioWorkspace.root,
        originRoot: scenarioWorkspace.template.originRoot,
        profileDir,
        env,
        shelfStorageRoot: scenarioWorkspace.shelfStorageRoot,
    };
}

/** Builds this workspace's `dispose()`. The `disposed` flag is checked and set synchronously, with
 * no `await` between the check and the set, so two overlapping calls (Node's single-threaded event
 * loop cannot interleave synchronous code) can never both proceed past the guard. */
function createDisposer(
    ownRoot: string,
    root: string,
    env: NodeJS.ProcessEnv,
): () => Promise<void> {
    let disposed = false;
    return async () => {
        if (disposed) return;
        disposed = true;
        await removeLinkedWorktrees(root, env);
        // `ownRoot` contains the scratch HOME, and a descendant of the closing VS Code host can
        // still be flushing into it when this rm walks the tree: a file created between readdir
        // and rmdir surfaces as `ENOTEMPTY: directory not empty, rmdir
        // '.../intelligit-fixture-home-*'`. Measured at roughly one run in four across two
        // sweeps, attaching to whichever row happened to be executing -- it is a teardown race,
        // not a row defect, which is why it moved between rows. `maxRetries`/`retryDelay` are
        // Node's documented remedy for exactly this error class (EBUSY/EMFILE/ENFILE/ENOTEMPTY/
        // EPERM) with linear backoff. Retrying is safe here because the directory is scratch the
        // harness owns outright; nothing else may recreate it once disposal has begun.
        await rm(ownRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    };
}

/**
 * Enumerates `git worktree list --porcelain` against `root` and removes every entry after the
 * first -- the primary worktree (always listed first; see `snapshotWorktrees.ts`'s identical,
 * empirically-confirmed assumption) lives at `root` itself and is covered by the caller's own
 * removal of the fixture-owned root, so only LINKED worktrees, which live outside it, need
 * removing here.
 */
async function removeLinkedWorktrees(root: string, env: NodeJS.ProcessEnv): Promise<void> {
    let raw: string;
    try {
        raw = await runGit(root, ["worktree", "list", "--porcelain"], env);
    } catch {
        // The workspace's own repository is already gone -- e.g. a concurrent/prior dispose(), or
        // construction failed before the copy landed. Nothing to enumerate; the caller's removal of
        // the fixture-owned root below still runs and covers whatever remains.
        return;
    }

    const blocks = raw
        .split("\n\n")
        .map((block) => block.trim())
        .filter((block) => block.length > 0);

    const linkedWorktreePaths = blocks
        .slice(1)
        .map(extractWorktreePath)
        .filter((worktreePath): worktreePath is string => worktreePath !== null);

    await Promise.all(
        linkedWorktreePaths.map((worktreePath) =>
            rm(worktreePath, { recursive: true, force: true }),
        ),
    );
}

/** Pulls the `worktree <path>` field out of one `git worktree list --porcelain` block -- the field
 * is always the block's first line (empirically confirmed; see `snapshotWorktrees.ts`'s
 * `parseBlockFields`, which this duplicates in miniature rather than importing, since this function
 * only ever needs the one field and not that module's full per-field parse). */
function extractWorktreePath(block: string): string | null {
    const firstLine = block.split("\n")[0] ?? "";
    const prefix = "worktree ";
    return firstLine.startsWith(prefix) ? firstLine.slice(prefix.length) : null;
}
