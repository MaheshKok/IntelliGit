import path from "node:path";

/**
 * Makes a POSIX-shaped fixture path absolute for the host platform.
 *
 * **The defect this closes.** Tests across this suite invent fake absolute paths as literals --
 * `/repo`, `/tmp/project`, `/root/client` -- and feed them to production code that quite correctly
 * calls `path.join` or `path.resolve` on them. Those literals are not absolute paths on Windows.
 * `path.join("/repo", "x.patch")` there yields `\repo\x.patch`, and `path.resolve("/tmp/project")`
 * yields `D:\tmp\project`, resolved against whichever drive the runner happens to be on. Neither
 * can ever equal the POSIX literal the test asserts, so ~18 tests failed on Windows for a reason
 * that had nothing to do with the behaviour they exist to pin.
 *
 * The fix belongs here, at the point the fixture is *defined*, rather than at each assertion.
 * Normalizing separators when comparing would paper over the separator half and still leave the
 * drive-letter half broken -- `playwrightVisualConfig.test.ts` already built its expectation with
 * `path.join` and still failed, because the production side had used `path.resolve` and gained a
 * `D:` the test side never had. Resolving once at the source makes the fixture a genuinely valid
 * absolute path on every platform, so production's `join`/`resolve` become no-ops and both sides
 * agree without any comparison-time normalization discarding information.
 *
 * Expectations stay hand-written: callers wrap the literal they always wrote, so a wrong directory,
 * wrong filename, or missing join still fails. Only the platform-invalid root is repaired.
 *
 * On POSIX this is the identity function -- `path.resolve("/repo") === "/repo"` -- so nothing about
 * the existing macOS and Linux runs changes.
 *
 * @param posixPath An absolute POSIX-style path literal, e.g. `/repo/dist/app.js`.
 */
export function fixturePath(posixPath: string): string {
    return path.resolve(posixPath);
}

/**
 * Joins segments onto a POSIX-shaped fixture root, returning a platform-native absolute path.
 *
 * Convenience for the common `fixturePath("/repo/a/b.txt")` shape when the root is already held in
 * a variable. `fixtureJoin("/repo", "a", "b.txt")` reads closer to the assertion it supports.
 */
export function fixtureJoin(posixRoot: string, ...segments: readonly string[]): string {
    return path.resolve(posixRoot, ...segments);
}
