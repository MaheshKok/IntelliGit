import { spawnSync } from "node:child_process";

/**
 * Capabilities the host OS either has or does not, for tests whose INPUT the platform cannot
 * represent at all (#223).
 *
 * These are deliberately not "skip on Windows" flags scattered at five call sites. Each constant
 * names the capability a test needs and states why the platform lacks it, so a reader can tell a
 * genuine coverage gap from a bug someone gave up on -- and so `it.skipIf` reports the test as
 * SKIPPED rather than letting an early `return` print a green tick for a test that never ran.
 *
 * Neither of these is a defect in IntelliGit, and neither can be fixed by changing IntelliGit: the
 * OS refuses the input before any of our code is reached. Anything that is merely spelled
 * differently on Windows -- separators, 8.3 short names, line endings -- is a portability bug and
 * belongs in a fix, not here.
 */

/**
 * Whether a filename may contain the characters Windows reserves.
 *
 * Win32 forbids `< > : " | ? *` and control characters in any path component, at the API layer --
 * `CreateFileW` fails with `ERROR_INVALID_NAME` and Node reports `ENOENT`. The tests gated on this
 * deliberately create files called things like `literal[abc]*?.txt`, `:(glob)*`, and a name
 * containing a double quote, to prove IntelliGit passes such names to git literally instead of
 * letting them be interpreted as pathspec magic. The property under test is real and worth having;
 * the fixture simply cannot exist on Windows, where those names are equally unreachable for a user.
 */
export const FILENAMES_MAY_CONTAIN_RESERVED_CHARACTERS = process.platform !== "win32";

/**
 * Whether POSIX permission bits are enforced by the filesystem.
 *
 * `fs.chmod` on Windows sets only the read-only attribute, and even that does not make a DIRECTORY
 * un-writable -- Windows models that as an ACL, which `chmod` does not touch. A test that chmods a
 * directory to 0o500 and expects the next write to fail with `EACCES` therefore gets a successful
 * write instead. The negative-path behaviour being asserted is still enforced on the POSIX legs.
 */
export const POSIX_PERMISSIONS_ENFORCED = process.platform !== "win32";

/** Whether this runtime can execute the POSIX-shell contracts used by shell-dependent tests. */
export const supportsPosixShell =
    process.platform !== "win32" &&
    spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

/** Whether chmod can make a fixture unreadable for the current test process. */
export const supportsUnreadableDirectories =
    process.platform !== "win32" && process.getuid?.() !== 0;
