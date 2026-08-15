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
 */
export function sanitizedGitEnv(overlay: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    return { ...inherited, ...overlay };
}
