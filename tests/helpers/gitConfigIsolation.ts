import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A `GIT_CONFIG_GLOBAL` value that hides the developer's real `~/.gitconfig` on every platform.
 *
 * **What this replaces, and why.** Tests that drive real Git reached for `os.devNull`, which is
 * `/dev/null` on POSIX and `\\.\nul` on Windows. Git for Windows refuses that outright --
 * `fatal: unable to access '\\.\nul': Invalid argument` -- so `git init` failed before any test
 * body ran, and every real-repository case in the file died with it. That single value accounted
 * for 22 of the Windows failures tracked in issue #223.
 *
 * The replacement is a path that deliberately does not exist. Git treats a missing global config
 * exactly as "no global configuration", which is the whole intent, and unlike a device path it
 * means the same thing on every platform. It also needs no file to create, track, or clean up,
 * so it cannot leak into a fixture's own directory -- which matters, because a config file
 * written inside a repository under test would show up as untracked and break the dirt-detection
 * cases that motivated the isolation in the first place.
 *
 * Nothing in these suites runs `git config --global`, which is the only thing that would create
 * the file, so it stays absent for the life of the run.
 *
 * **Pair this with `GIT_CONFIG_NOSYSTEM=1`.** This constant covers only the global config. The
 * system config is a separate file, and on Windows it is the one that ships `core.autocrlf=true`
 * -- enough on its own to make every byte-exact assertion read back one character longer than it
 * wrote. `GIT_CONFIG_NOSYSTEM` is the portable way to switch it off and needs no path at all.
 *
 * A fixture stack that already owns a scratch `HOME` should prefer an empty real file instead;
 * see `createSanitizedGitEnv` in `tests/fixtures/repo/seed.ts`, which can dispose one on the
 * schedule it already has, and which additionally needs `GIT_CONFIG_SYSTEM` to be a readable
 * path rather than unset.
 */
export const ABSENT_GIT_CONFIG_GLOBAL = path.join(
    tmpdir(),
    "intelligit-absent-gitconfig",
    "gitconfig",
);
