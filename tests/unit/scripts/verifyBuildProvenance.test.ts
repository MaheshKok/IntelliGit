/**
 * Spec-derived tests for the build-provenance gate: dist/.build-manifest.json
 * plus scripts/verifyBuildProvenance.js must prove a declared output is not
 * merely present but actually came from the build that wrote the manifest.
 * Presence alone must not satisfy it (PLAN.md Phase 0 step 2), so the primary
 * case here is a stale bundle -- present, but wrong content -- being rejected.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createManifest, writeManifest } from "../../../scripts/buildManifest.js";
import { verifyBuildProvenance } from "../../../scripts/verifyBuildProvenance.js";

describe("verifyBuildProvenance", () => {
    let distDir: string;

    beforeEach(() => {
        distDir = mkdtempSync(join(tmpdir(), "intelligit-provenance-test-"));
    });

    afterEach(() => {
        rmSync(distDir, { recursive: true, force: true });
    });

    function seedOutput(name: string, contents: string): string {
        const absolutePath = join(distDir, name);
        writeFileSync(absolutePath, contents, "utf8");
        return absolutePath;
    }

    it("passes when every declared output's content hash matches the manifest", () => {
        const output = seedOutput("extension.js", "console.log('build A');");
        writeManifest(distDir, createManifest({ distDir, outputPaths: [output] }));

        const result = verifyBuildProvenance({ distDir });

        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it("fails a stale bundle: content changed after the manifest was written", () => {
        const output = seedOutput("extension.js", "console.log('build A');");
        writeManifest(distDir, createManifest({ distDir, outputPaths: [output] }));

        // Simulate the exact bug being fixed: a later, unrelated build (or a
        // partial/failed one) leaves different bytes at the same declared path
        // without a new manifest being written for them.
        writeFileSync(output, "console.log('build B, never verified by a manifest');", "utf8");

        const result = verifyBuildProvenance({ distDir });

        expect(result.ok).toBe(false);
        expect(
            result.errors.some(
                (error) =>
                    error.includes("Stale declared output") && error.includes("extension.js"),
            ),
        ).toBe(true);
    });

    it("fails when a declared output is missing entirely -- presence alone is not checked in isolation", () => {
        const output = seedOutput("extension.js", "console.log('build A');");
        writeManifest(distDir, createManifest({ distDir, outputPaths: [output] }));
        rmSync(output);

        const result = verifyBuildProvenance({ distDir });

        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.includes("Missing declared output"))).toBe(true);
    });

    it("fails when no manifest exists at all", () => {
        const result = verifyBuildProvenance({ distDir });

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/no build manifest/i);
        expect(existsSync(join(distDir, ".build-manifest.json"))).toBe(false);
    });

    it("fails rather than pass vacuously when the manifest declares zero files", () => {
        writeManifest(distDir, createManifest({ distDir, outputPaths: [] }));

        const result = verifyBuildProvenance({ distDir });

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/zero output files/i);
    });
});
