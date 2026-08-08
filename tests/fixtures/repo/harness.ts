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
    /** The parent directory this call's own fixture-owned root is allocated under (via `mkdtemp`,
     * so concurrent calls never collide). Defaults to {@link DEFAULT_WORKSPACES_ROOT}. */
    readonly workspacesRoot?: string;
}

/** The runner-known default parent for every workspace's own fixture-owned root, when a caller does
 * not supply `workspacesRoot` explicitly. A fixed location under the OS temp directory, exactly
 * like `manifest.ts`'s `DEFAULT_MANIFEST_PATH` -- every worker process in the same run agrees on it
 * without needing an environment variable. */
export const DEFAULT_WORKSPACES_ROOT = path.join(tmpdir(), "intelligit-e2e-workspaces");

/**
 * Builds one independent, fully-functional per-test fixture workspace: reads the manifest, copies
 * the template it names, rehydrates the copy, allocates this workspace's own scratch directories,
 * and returns a handle. Every call -- including two calls in the same process -- produces a wholly
 * independent workspace: independent copy (its own inodes, per `copyTemplate.ts`'s own contract),
 * independent origin, independent `HOME`/`TMPDIR`/`TMP`/`TEMP`, independent profile directory.
 *
 * Propagates whatever `readFixtureManifest`, `copyTemplate`, or `rehydrateCopy` throw, unmodified --
 * a missing/malformed manifest, a symlink-containment violation, or a rehydration failure are all
 * real construction failures this function does not paper over.
 */
export async function createFixtureWorkspace(options?: CreateFixtureWorkspaceOptions): Promise<FixtureWorkspace> {
    const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH;
    const workspacesRoot = options?.workspacesRoot ?? DEFAULT_WORKSPACES_ROOT;

    const manifest = await readFixtureManifest(manifestPath);

    await mkdir(workspacesRoot, { recursive: true });
    const ownRoot = await mkdtemp(path.join(workspacesRoot, "intelligit-e2e-workspace-"));

    const { root, originRoot, profileDir, env } = await allocateWorkspace(ownRoot, manifest.templateRoot);

    return { root, originRoot, profileDir, env, dispose: createDisposer(ownRoot, root, env) };
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
    await Promise.all([mkdir(scratchTmpDir, { recursive: true }), mkdir(profileDir, { recursive: true })]);

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

/** Builds this workspace's `dispose()`. The `disposed` flag is checked and set synchronously, with
 * no `await` between the check and the set, so two overlapping calls (Node's single-threaded event
 * loop cannot interleave synchronous code) can never both proceed past the guard. */
function createDisposer(ownRoot: string, root: string, env: NodeJS.ProcessEnv): () => Promise<void> {
    let disposed = false;
    return async () => {
        if (disposed) return;
        disposed = true;
        await removeLinkedWorktrees(root, env);
        await rm(ownRoot, { recursive: true, force: true });
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

    await Promise.all(linkedWorktreePaths.map((worktreePath) => rm(worktreePath, { recursive: true, force: true })));
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
