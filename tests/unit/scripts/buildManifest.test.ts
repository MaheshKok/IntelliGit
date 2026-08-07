/**
 * Spec-derived tests for the manifest contract shared by scripts/build.js and
 * scripts/verifyBuildProvenance.js. readManifest fails closed on a malformed
 * or unsafe manifest rather than silently treating it as absent -- a
 * corrupted provenance record is a different failure than no record at all,
 * and collapsing the two would hide the corruption case behind a green "no
 * manifest, run the build" message instead of a loud parse/schema error.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createManifest, hashFileContents, readManifest } from "../../../scripts/buildManifest.js";

describe("buildManifest", () => {
    let distDir: string;

    beforeEach(() => {
        distDir = mkdtempSync(join(tmpdir(), "intelligit-manifest-test-"));
    });

    afterEach(() => {
        rmSync(distDir, { recursive: true, force: true });
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

    it("rejects a manifest entry whose path escapes the dist directory", () => {
        writeFileSync(
            join(distDir, ".build-manifest.json"),
            JSON.stringify({
                schemaVersion: 1,
                builtAt: new Date().toISOString(),
                files: [{ path: "../../etc/passwd", hash: "0".repeat(64) }],
            }),
            "utf8",
        );

        expect(() => readManifest(distDir)).toThrow(/unsafe path outside dist/);
    });
});
