/**
 * The environment every webview-fixture recording runs its git reads under.
 *
 * **The defect this exists to close.** A recorder builds `new GitOps(new GitExecutor(repoRoot))`,
 * and `GitExecutor` spawns git with `{ ...process.env, ... }` (`src/git/executor.ts`). Without an
 * explicit environment, every git read during a recording therefore inherits whoever is running
 * it: their `HOME`, and so their `~/.gitconfig`. That is enough to make a committed fixture
 * irreproducible on another machine -- a global `diff.renames = false` turns the seeded
 * `topic.txt -> topic-renamed.txt` rename into a separate add and delete, and
 * `commit-panel/dirty.json`'s `changedFileCount` goes from 5 to 6. The fixture gate then fails for
 * a developer who changed nothing.
 *
 * The fixture layer already builds exactly the environment that prevents this:
 * `createSanitizedGitEnv()` (`tests/fixtures/repo/seed.ts`) pins a scratch `HOME`,
 * `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, a fixed identity, and a fixed
 * date, and every `ScenarioWorkspace` carries it as `env`. It was simply not being threaded as far
 * as the recording -- the registry passed `repoRoot` and `roots` and dropped `env` on the floor.
 * This module is the thread.
 *
 * `process.env` is deliberately NOT mutated to achieve this, even though it would be fewer lines:
 * `GitExecutor.run`'s own contract says the parent environment is never mutated
 * (`src/git/executor.ts`), so a recorder that reached in and set `GIT_CONFIG_GLOBAL` globally would
 * be violating the invariant it depends on. The executor's constructor `defaultEnv` is the
 * supported seam.
 */

/**
 * Narrows a `NodeJS.ProcessEnv` to the `Record<string, string>` `GitExecutor` accepts, dropping
 * keys whose value is `undefined`.
 *
 * The drop is the point, not a formality. `NodeJS.ProcessEnv` types every value as
 * `string | undefined`, and passing an explicit `undefined` through to `spawn`'s `env` is not the
 * same as omitting the key -- on some platforms it is rejected outright, and elsewhere it can
 * surface as the literal string "undefined". Casting instead of filtering would hide that.
 */
export function toGitEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
    const entries = Object.entries(env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return Object.fromEntries(entries);
}
