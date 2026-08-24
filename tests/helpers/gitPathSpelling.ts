/**
 * Spells a path the way git will, so an assertion against git output is not really an assertion
 * about Node's path conventions (#223).
 *
 * **The defect this closes.** Several fixture tests build a path with `path.join`, hand it to
 * `git worktree add`, and then assert `expect(await git(... "worktree list --porcelain"))
 * .toContain(thatPath)`. On macOS and Linux the two spellings coincide and the assertion is
 * meaningful. On a Windows runner they diverge twice over, and the test fails while the code under
 * test is behaving perfectly:
 *
 * ```text
 * expected 'worktree C:/Users/runneradmin/AppData…'
 *   to contain 'C:\Users\RUNNER~1\AppData\Local\Temp\…'
 * ```
 *
 * 1. **8.3 short names.** `os.tmpdir()` returns `C:\Users\RUNNER~1\...` on a GitHub Actions runner;
 *    git reports the long form, `C:/Users/runneradmin/...`. `fs.realpathSync` is Node's own JS
 *    resolver and leaves `RUNNER~1` alone -- only `fs.realpathSync.native` goes through
 *    `GetFinalPathNameByHandle` and recovers the canonical on-disk spelling.
 * 2. **Separators.** git addresses paths with `/` on every platform; `path.join` produces `\`.
 *
 * Only the needle is converted, never the haystack: git already emits `/` everywhere, so rewriting
 * its output would be a no-op that quietly widens what the assertion accepts.
 *
 * `separator` is a parameter rather than a read of `path.sep` so the Windows branch is reachable
 * from a macOS run -- a branch that only ever executes on CI is a branch whose first execution is a
 * 28-minute round trip. It gates the slash rewrite because a backslash is a legal character in a
 * POSIX filename, where rewriting one would fabricate a path that names a different directory.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";

export function gitSpellingOf(candidate: string, separator: string = sep): string {
    let onDisk = candidate;
    try {
        onDisk = realpathSync.native(candidate);
    } catch {
        // Not created yet, already removed, or otherwise unresolvable: the literal spelling the
        // caller passed is the best available answer, and is correct whenever the two agree.
    }
    return separator === "\\" ? onDisk.split("\\").join("/") : onDisk;
}
