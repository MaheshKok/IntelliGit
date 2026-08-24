import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    resolveVSCodeExecutable,
    resolveVSCodeVersion,
} from "../../e2e/hostFixtures/resolveVSCodeExecutable";
import { VSCODE_VERSION } from "../../e2e/hostFixtures/vscodeVersion";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

/**
 * Records the state the downloader was handed, standing in for the real one. The guarantee under
 * test is invisible from the outside -- `resolveVSCodeExecutable` returns the same path either way
 * -- so it has to be observed at the moment it matters, which is the call itself.
 */
const download = vi.hoisted(() => ({
    cacheWasDirectory: undefined as boolean | undefined,
    executablePath: "",
}));

vi.mock("@vscode/test-electron", () => ({
    downloadAndUnzipVSCode: async ({ cachePath }: { readonly cachePath: string }) => {
        const { stat } = await import("node:fs/promises");
        download.cacheWasDirectory = await stat(cachePath).then(
            (entry) => entry.isDirectory(),
            () => false,
        );
        return download.executablePath;
    },
}));

describe("resolveVSCodeVersion", () => {
    it("uses the pinned version when the override is unset", () => {
        expect(resolveVSCodeVersion({})).toBe(VSCODE_VERSION);
    });

    it.each(["", " ", " \t\n "])(
        "uses the pinned version for whitespace-only value %j",
        (value) => {
            expect(resolveVSCodeVersion({ INTELLIGIT_VSCODE_VERSION: value })).toBe(VSCODE_VERSION);
        },
    );

    it("uses a non-empty override without downloading VS Code", () => {
        expect(resolveVSCodeVersion({ INTELLIGIT_VSCODE_VERSION: "insiders" })).toBe("insiders");
    });

    // A padded value is judged non-empty by the same `trim()` the emptiness check uses, so
    // returning the raw string would hand the downloader " insiders " and resolve no build at all.
    it.each([" insiders", "insiders ", " insiders\n"])(
        "returns the trimmed override for padded value %j",
        (value) => {
            expect(resolveVSCodeVersion({ INTELLIGIT_VSCODE_VERSION: value })).toBe("insiders");
        },
    );
});

describe("resolveVSCodeExecutable", () => {
    /** Restored rather than deleted: CI legitimately sets this, and this file does not own it. */
    const realCacheOverride = process.env.INTELLIGIT_VSCODE_CACHE;
    const scratchRoots: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        if (realCacheOverride === undefined) delete process.env.INTELLIGIT_VSCODE_CACHE;
        else process.env.INTELLIGIT_VSCODE_CACHE = realCacheOverride;
        await removeScratchDirectories(...scratchRoots.splice(0));
    });

    // Windows has no `~/.cache`. `%USERPROFILE%\.cache` does not exist and nothing on that platform
    // creates it, while `downloadAndUnzipVSCode` makes its cache directory with a NON-recursive
    // `mkdirSync` that needs the parent already present. That held on macOS only because the
    // darwin-only Spotlight opt-out created it first, and on Linux only because XDG guarantees it --
    // two accidents wearing the shape of a guarantee. The Windows leg died in `globalSetup` with
    // `ENOENT: no such file or directory, mkdir 'C:\Users\runneradmin\.cache\intelligit-vscode-test'`
    // before one smoke test ran (#223).
    //
    // Platform is stubbed rather than the test skipped off Windows: skipping would assert the
    // guarantee only where it already held by accident, which is precisely backwards.
    it("creates the download cache directory on a platform with no ~/.cache", async () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "intelligit-cache-"));
        scratchRoots.push(scratchRoot);
        // Two levels deep, so the ABSENT parent is what a non-recursive `mkdirSync` would trip on --
        // one level would be created by either implementation and prove nothing.
        const cachePath = path.join(scratchRoot, ".cache", "intelligit-vscode-test");
        process.env.INTELLIGIT_VSCODE_CACHE = cachePath;
        download.cacheWasDirectory = undefined;
        download.executablePath = path.join(cachePath, "Code.exe");

        await resolveVSCodeExecutable(path.join(scratchRoot, "repo"));

        expect(download.cacheWasDirectory, "cache directory present at download time").toBe(true);
    });
});
