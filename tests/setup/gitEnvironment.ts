/**
 * Vitest setup: no test process may read the machine's Git configuration, or act on a repository
 * it inherited from whatever launched the run.
 *
 * **The defect this closes.** An audit of every test module that spawns real Git found 21 with no
 * configuration isolation at all. They set an author identity and stopped there, so each `git`
 * subprocess inherited both the developer's `~/.gitconfig` and the machine's system config. Two
 * consequences, one loud and one quiet:
 *
 * - **Loud, on Windows.** Git for Windows ships `core.autocrlf=true` in its *system* config. Every
 *   byte-exact assertion in the shelf, patch, and rebase suites therefore read back CRLF where the
 *   fixture had written LF -- `expected 'third\r\n' to be 'third\n'` -- and the whole class of
 *   failure had nothing to do with the behaviour under test. This was a large share of the Windows
 *   failures tracked in issue #223.
 * - **Quiet, everywhere.** A developer with `diff.renames=false`, a `core.autocrlf`, a commit
 *   template, or a `gpg.format` set globally gets different results from the same commit. That is
 *   the reproducibility defect `tests/visual/recorder/recordingGitEnvironment.ts` documents for the
 *   recorder, present in a further 21 modules that never got the same treatment.
 *
 * **The inherited repository.** Git exports `GIT_DIR` to every hook it runs from a linked
 * worktree, and `GIT_DIR` outranks both `cwd` and `-C`. While `.githooks/pre-push` ran
 * `test:coverage`, a push from a worktree therefore pointed every fixture's `git init` and
 * `git config user.name "Test User"` -- each aimed at a fresh temporary directory -- at the
 * developer's shared `.git/config`, and their own commits went on to be authored as
 * `Test User <test@example.com>`. Clearing the variables `git rev-parse --local-env-vars` lists
 * leaves the `cwd` a fixture passes as the only thing that decides which repository it touches.
 *
 * Setting this once per worker rather than in each module is deliberate. The failing modules do not
 * share a Git helper -- some pass `{ ...process.env, ...identity }`, some pass `{ cwd }` and no
 * `env` at all -- so there is no single call site to fix, and a convention that must be re-applied
 * by hand in every new test file is a convention that will be missed. `process.env` is the one seam
 * every one of those shapes already inherits from.
 *
 * A module that needs a *specific* configuration still sets its own `GIT_CONFIG_GLOBAL`; an
 * explicit value in a spawn's `env` overrides what is set here, which is exactly what
 * `tests/unit/fixtures/seedDeterminism.test.ts` relies on to point Git at a deliberately hostile
 * config.
 *
 * Proven rather than assumed: `tests/unit/gitEnvironmentIsolation.test.ts` spawns real Git and
 * asserts it cannot see a global or system setting, or be redirected by an inherited `GIT_DIR`.
 * Without that, this file could be dropped from `vitest.config.ts` and every suite would keep
 * passing locally while silently losing the guarantee.
 */

import { ABSENT_GIT_CONFIG_GLOBAL } from "../helpers/gitConfigIsolation";

// The variables `git rev-parse --local-env-vars` lists as local to one repository (Git 2.50). An
// inherited one outranks the repository, index, or config a fixture's `cwd` would select.
for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
]) {
    delete process.env[name];
}
process.env.GIT_CONFIG_GLOBAL = ABSENT_GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = "1";
