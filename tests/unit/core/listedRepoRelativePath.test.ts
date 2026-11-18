/**
 * A name Git listed (`diff --name-status -z`) is a Git path: `/` separates it on every platform
 * and a backslash is part of the name, so `docs\setup.txt` on a POSIX repository is not
 * `docs/setup.txt`. The Windows flavour is supplied by mocking `node:path` to `path.win32`, so
 * the test fails for the right reason on any host.
 */

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type RepoRelativePathModule = typeof import("../../../src/utils/repoRelativePath");

/** Loads the module under an explicitly chosen path flavour rather than the host's. */
async function loadUnder(flavour: path.PlatformPath): Promise<RepoRelativePathModule> {
    vi.resetModules();
    vi.doMock("node:path", () => ({ ...flavour, default: flavour }));
    return import("../../../src/utils/repoRelativePath");
}

afterEach(() => {
    vi.doUnmock("node:path");
    vi.resetModules();
});

describe.each([
    ["win32", path.win32],
    ["posix", path.posix],
])("assertListedRepoRelativePath under %s path semantics", (_name, flavour) => {
    it("returns a Git-listed name unchanged, a backslash included", async () => {
        const { assertListedRepoRelativePath } = await loadUnder(flavour);
        for (const name of ["docs\\setup.txt", "docs/setup.txt", "line\nname", "a\\..\\b.txt"]) {
            expect(assertListedRepoRelativePath(name), JSON.stringify(name)).toBe(name);
        }
    });

    it.each([
        ["an empty name", ""],
        ["an absolute name", "/etc/passwd"],
        ["a NUL byte", "bad\0name"],
        ["a .. segment", "../outside.txt"],
        ["a nested .. segment", "a/../../outside.txt"],
        ["a . segment", "a/./b.txt"],
        ["the repository root", "."],
        ["an empty segment", "a//b.txt"],
        ["a trailing slash", "a/"],
    ])("refuses %s", async (_what, name) => {
        const { assertListedRepoRelativePath } = await loadUnder(flavour);
        expect(() => assertListedRepoRelativePath(name)).toThrow(/^Rejected /);
    });
});

describe("assertRepoRelativePath keeps its native separator handling", () => {
    it("turns a Windows path into Git's slash form", async () => {
        const { assertRepoRelativePath } = await loadUnder(path.win32);
        expect(assertRepoRelativePath("docs\\setup.txt")).toBe("docs/setup.txt");
        expect(() => assertRepoRelativePath("..\\outside.txt")).toThrow("escaping repo root");
    });
});
