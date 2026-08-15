/**
 * Builds the environment every oracle runs `git` in.
 *
 * `git` picks its repository out of the environment before it reads any argument: `GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and their relatives all outrank both
 * `-C` and `cwd`. Inheriting the ambient environment wholesale therefore lets a developer shell --
 * or a CI step that exported one of them -- aim an oracle at an entirely different repository,
 * where it reads real refs, returns well-formed object IDs, and passes while measuring nothing the
 * flow did. The failure is silent in exactly the case an oracle exists to catch.
 *
 * So every `GIT_*` name is dropped from what is inherited, and only the fixture's own overlay is
 * put back: the repository an oracle observes is the one the fixture built, and nothing else can
 * redirect it.
 *
 * The name is upper-cased before that prefix test because Windows environment variable names are
 * case-insensitive: `set git_dir=...` is stored with the case it was written in, so `Object.entries`
 * reports `git_dir`, a case-sensitive `startsWith("GIT_")` misses it, and the variable is handed
 * straight back to the child -- where git reads it as `GIT_DIR` and redirects the oracle. That is
 * the exact silent-pass this function exists to prevent, reachable on the one platform where the
 * guard looked like it was working. `toUpperCase` (not `toLocaleUpperCase`) keeps this
 * locale-independent, so a Turkish locale cannot turn `git_` into something that fails to match.
 */
export function sanitizedGitEnv(overlay: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
    );
    return { ...inherited, ...overlay };
}
