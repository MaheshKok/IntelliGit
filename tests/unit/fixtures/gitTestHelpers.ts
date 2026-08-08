/**
 * Shared git-subprocess helper for the `snapshot.ts` test suite split across this directory
 * (`snapshotWorkingTree.test.ts`, `snapshotIndex.test.ts`, `snapshotRefsAndWorktrees.test.ts`,
 * `snapshotObjectStore.test.ts`, `snapshotNormalize.test.ts`). `snapshot.test.ts` -- the
 * orchestration-level suite for `snapshotWorkspace()` itself -- builds on the full
 * `seedFixtureTemplate()` template instead of a lightweight scratch repo, so it does not need
 * this module.
 *
 * Deliberately duplicated rather than imported from `tests/fixtures/repo/gitRun.ts`: these tests
 * exist to verify `snapshot.ts`'s output against evidence they did not generate (Gate 4 of this
 * repo's own working discipline) -- driving the fixture and reading it back through the *same*
 * internal git-runner the module under test also uses would let a bug in that shared seam hide
 * from every test built on top of it. Mirrors the pattern `tests/unit/fixtures/seed.test.ts`
 * already uses for the same reason.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createSanitizedGitEnv, type SanitizedGitEnv } from "../../fixtures/repo/seed";

const execFileAsync = promisify(execFile);

/** Runs one git process against `cwd` with `env`, returning trimmed UTF-8 stdout. */
export async function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8").trim();
}

/** A small, purpose-built repository for one test file's own scenario -- lighter than the full
 * `seedFixtureTemplate` history, but built with the same sanitized, deterministic environment
 * (via `createSanitizedGitEnv`, per PLAN.md step 9's "every git subprocess must use the
 * sanitized environment" constraint) so nothing here leaks ambient user config or timezone. */
export interface ScratchRepo extends SanitizedGitEnv {
    readonly root: string;
    /** Removes the repo root and its scratch `HOME`. Call in `afterEach`/`afterAll`. */
    dispose(): Promise<void>;
}

/** `git init`s an empty repository on `main`, pinned to the same repo-local config
 * `seed.ts` uses, under a fresh sanitized environment. */
export async function createScratchRepo(namePrefix: string): Promise<ScratchRepo> {
    const { env, home } = await createSanitizedGitEnv();
    const root = await mkdtemp(path.join(tmpdir(), `intelligit-${namePrefix}-`));
    await git(root, ["init", "--quiet", "-b", "main"], env);
    await git(root, ["config", "core.autocrlf", "false"], env);
    await git(root, ["config", "core.ignorecase", "false"], env);
    await git(root, ["config", "commit.gpgsign", "false"], env);
    return {
        root,
        env,
        home,
        dispose: async () => {
            await Promise.all([
                rm(root, { recursive: true, force: true }),
                rm(home, { recursive: true, force: true }),
            ]);
        },
    };
}

/** Writes `content` to `relativePath` under `root`, creating parent directories as needed. */
export async function writeRepoFile(root: string, relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
}

/** Stages every pending change and commits it, returning the new commit's SHA. Every commit in
 * this test suite shares `seed.ts`'s fixed author/committer identity and date via `env`, so SHAs
 * stay stable across runs wherever a test happens to assert one directly. */
export async function commitAll(root: string, env: NodeJS.ProcessEnv, message: string): Promise<string> {
    await git(root, ["add", "-A"], env);
    await git(root, ["commit", "--quiet", "-m", message], env);
    return git(root, ["rev-parse", "HEAD"], env);
}
