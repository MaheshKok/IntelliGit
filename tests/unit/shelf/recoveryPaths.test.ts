/**
 * Pins the separator contract of `assertRepositoryRelativePath` against BOTH path flavours.
 *
 * The invariant this file exists for is invisible on the host that runs it. The function ends in
 * `normalized.split(path.sep).join("/")`, and on POSIX `path.sep` is already `/`, so that call is
 * the identity function -- delete it and every test on macOS or Linux still passes. The defect it
 * fixes is equally invisible: on Windows `path.normalize` returns `blocked\one.txt`, which is then
 * handed to git by `writeIndexEntry`, `getIndexEntry`, `getIndexPathFingerprint` and `getBaseEntry`.
 * Git addresses paths with `/` on every platform, so `git show <oid>:blocked\one.txt` resolves
 * nothing and each of those lookups silently addressed a path git had never heard of.
 *
 * So the flavour is supplied rather than inherited: `node:path` is mocked to `path.win32` and to
 * `path.posix` in turn. The result is a test that fails for the right reason on a developer laptop,
 * where the bug cannot otherwise be reproduced at all, and that means the same thing on all three
 * CI platforms rather than quietly testing nothing on two of them.
 */

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RecoveryPathsModule = typeof import("../../../src/shelf/recoveryPaths");

/** Loads the module under an explicitly chosen path flavour rather than the host's. */
async function loadUnder(flavour: path.PlatformPath): Promise<RecoveryPathsModule> {
    vi.resetModules();
    vi.doMock("node:path", () => ({ ...flavour, default: flavour }));
    return import("../../../src/shelf/recoveryPaths");
}

afterEach(() => {
    vi.doUnmock("node:path");
    vi.resetModules();
});

describe("assertRepositoryRelativePath under Windows path semantics", () => {
    let assertRepositoryRelativePath: RecoveryPathsModule["assertRepositoryRelativePath"];

    beforeEach(async () => {
        ({ assertRepositoryRelativePath } = await loadUnder(path.win32));
    });

    it("returns a backslash-separated input as a git path", () => {
        // The exact shape that broke on Windows. Without the normalization this returns
        // `blocked\one.txt`, which git cannot resolve.
        expect(assertRepositoryRelativePath("blocked\\one.txt")).toBe("blocked/one.txt");
    });

    it("returns a forward-slash input unchanged", () => {
        // `path.win32.normalize` rewrites `/` to `\` on the way through, so this input exercises
        // the normalization just as hard as the one above -- it simply arrives already correct.
        expect(assertRepositoryRelativePath("nested/dir/file.txt")).toBe("nested/dir/file.txt");
    });

    it("never emits a separator git cannot address", () => {
        for (const input of ["a\\b", "a/b", "a\\b/c", "./a\\b", "a\\\\b"]) {
            expect(
                assertRepositoryRelativePath(input),
                `input ${JSON.stringify(input)}`,
            ).not.toContain("\\");
        }
    });

    it("still rejects escapes, which are checked before the separator is rewritten", () => {
        // The guard runs on the platform form deliberately. Rewriting first would turn `..\..` into
        // `../..` and the `.startsWith(".." + path.sep)` check -- which uses the win32 separator --
        // would stop matching, silently opening the traversal this function exists to close.
        for (const escape of ["..", "..\\", "..\\evil.txt", "..\\..\\evil.txt", "C:\\abs.txt"]) {
            expect(
                () => assertRepositoryRelativePath(escape),
                `input ${JSON.stringify(escape)}`,
            ).toThrow();
        }
    });
});

describe("assertRepositoryRelativePath under POSIX path semantics", () => {
    let assertRepositoryRelativePath: RecoveryPathsModule["assertRepositoryRelativePath"];

    beforeEach(async () => {
        ({ assertRepositoryRelativePath } = await loadUnder(path.posix));
    });

    it("preserves a backslash, which is a legal POSIX filename character", () => {
        // The other half of the ratchet, and the reason the fix is `split(path.sep)` rather than a
        // blanket `replace(/\\/g, "/")`. A file genuinely named `weird\name.txt` is legal on Linux
        // and macOS, and rewriting its backslash would address the wrong path in git and corrupt an
        // exported shelf. A test that only pinned the Windows direction would accept that bug.
        expect(assertRepositoryRelativePath("weird\\name.txt")).toBe("weird\\name.txt");
    });

    it("returns a nested path unchanged", () => {
        expect(assertRepositoryRelativePath("nested/dir/file.txt")).toBe("nested/dir/file.txt");
    });

    it("still rejects escapes", () => {
        for (const escape of ["..", "../", "../evil.txt", "../../evil.txt", "/abs.txt"]) {
            expect(
                () => assertRepositoryRelativePath(escape),
                `input ${JSON.stringify(escape)}`,
            ).toThrow();
        }
    });
});
