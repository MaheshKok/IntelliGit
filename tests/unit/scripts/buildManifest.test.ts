/**
 * Spec-derived tests for the manifest contract shared by scripts/build.js and
 * scripts/verifyBuildProvenance.js. readManifest fails closed on a malformed
 * or unsafe manifest rather than silently treating it as absent -- a
 * corrupted provenance record is a different failure than no record at all,
 * and collapsing the two would hide the corruption case behind a green "no
 * manifest, run the build" message instead of a loud parse/schema error.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createManifest, hashFileContents, readManifest } from "../../../scripts/buildManifest.js";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

describe("buildManifest", () => {
    let distDir: string;

    beforeEach(() => {
        distDir = mkdtempSync(join(tmpdir(), "intelligit-manifest-test-"));
    });

    afterEach(() => {
        removeScratchDirectoriesSync(distDir);
    });

    it("returns null when no manifest file exists", () => {
        expect(readManifest(distDir)).toBeNull();
    });

    it("round-trips a manifest built by createManifest", () => {
        const output = join(distDir, "extension.js");
        writeFileSync(output, "console.log('hi');", "utf8");

        const manifest = createManifest({ distDir, outputPaths: [output] });
        expect(manifest.files).toEqual([{ path: "extension.js", hash: hashFileContents(output) }]);
    });

    it("rejects a manifest file that is not valid JSON", () => {
        writeFileSync(join(distDir, ".build-manifest.json"), "{ this is not json", "utf8");

        expect(() => readManifest(distDir)).toThrow(/Malformed build manifest/);
    });

    it("rejects a manifest missing required schema fields", () => {
        writeFileSync(join(distDir, ".build-manifest.json"), JSON.stringify({ files: [] }), "utf8");

        expect(() => readManifest(distDir)).toThrow(/does not match the expected schema/);
    });

    it("rejects a manifest declaring a schema version this build does not understand", () => {
        // A manifest that merely *has* a numeric schemaVersion tells the reader
        // nothing. If an unknown version is accepted, a future format whose
        // `files` entries mean something else is read with today's rules and
        // reported as verified provenance -- which is the one outcome recording
        // a version number exists to prevent.
        writeManifestFile({ schemaVersion: 2, files: [] });

        expect(() => readManifest(distDir)).toThrow(/declares schemaVersion 2/);
    });

    // Every one of these must be refused on every platform, because the
    // manifest is a file on disk that another machine reads: a Windows CI
    // runner verifying a manifest written on macOS applies `path.win32` rules
    // to bytes that were validated under POSIX ones. `verifyBuildProvenance`
    // resolves each entry with `path.join(distDir, ...p.split("/"))`, so an
    // escape only has to survive THAT platform's separator handling to land
    // outside dist. Listing the shapes is not the test -- the loop below
    // executes each one, so a guard that stops covering any single row goes red
    // rather than leaving a comment that used to be true.
    const unsafePaths: readonly (readonly [label: string, declaredPath: string])[] = [
        ["a POSIX parent-directory escape", "../../etc/passwd"],
        ["a Windows parent-directory escape", "..\\outside.js"],
        ["a Windows escape nested under a real segment", "nested\\..\\..\\outside.js"],
        ["a POSIX absolute path", "/etc/passwd"],
        ["a Windows absolute path", "C:\\Windows\\System32\\drivers\\etc\\hosts"],
        ["a Windows drive-relative path", "C:outside.js"],
        ["a bare current-directory segment", "./extension.js"],
        ["an embedded current-directory segment", "nested/./extension.js"],
        ["an empty path", ""],
        ["an empty interior segment", "nested//extension.js"],
    ];

    for (const [label, declaredPath] of unsafePaths) {
        it(`rejects a manifest entry whose path escapes the dist directory: ${label}`, () => {
            writeManifestFile({ files: [{ path: declaredPath, hash: "0".repeat(64) }] });

            expect(() => readManifest(distDir)).toThrow(/unsafe path outside dist/);
        });
    }

    function writeManifestFile({
        schemaVersion = 1,
        files,
    }: {
        schemaVersion?: number;
        files: readonly { path: string; hash: string }[];
    }): void {
        writeFileSync(
            join(distDir, ".build-manifest.json"),
            JSON.stringify({ schemaVersion, builtAt: new Date().toISOString(), files }),
            "utf8",
        );
    }
});
