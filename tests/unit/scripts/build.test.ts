/**
 * Spec-derived tests for the build-orchestration bug fixed in scripts/build.js:
 * a caught esbuild exception was previously indistinguishable from "entry file
 * does not exist yet", and nothing cleaned dist/ -- so a genuine compile
 * failure could leave a stale bundle in place while the build reported
 * success. Each test below proves the specific failure mode from PLAN.md
 * Phase 0 step 2 is actually caught, not merely asserted away.
 *
 * Configs are deliberately built from throwaway plain-JS entry points in a
 * scratch directory rather than the real src/webviews entries, so these tests
 * exercise runBuild's orchestration logic in isolation from the real bundle
 * graph and stay fast.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuild } from "../../../scripts/build.js";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

describe("runBuild", () => {
    let workDir: string;
    let srcDir: string;
    let distDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "intelligit-build-test-"));
        srcDir = join(workDir, "src");
        distDir = join(workDir, "dist");
        mkdirSync(srcDir, { recursive: true });
    });

    afterEach(() => {
        removeScratchDirectoriesSync(workDir);
    });

    function writeSource(name: string, contents: string): string {
        const absolutePath = join(srcDir, name);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, contents, "utf8");
        return absolutePath;
    }

    function validExtensionConfig() {
        return {
            entryPoints: [writeSource("extension.js", "module.exports = { ok: true };")],
            bundle: true,
            outfile: join(distDir, "extension.js"),
            platform: "node" as const,
            format: "cjs" as const,
        };
    }

    function validEditorHelperConfig() {
        return {
            entryPoints: [writeSource("editorHelper.js", "module.exports = { ok: true };")],
            bundle: true,
            outfile: join(distDir, "interactive-rebase-editor-helper.cjs"),
            platform: "node" as const,
            format: "cjs" as const,
        };
    }

    it("skips a webview entry that genuinely does not exist, and the build still succeeds", async () => {
        const missingEntry = join(srcDir, "does-not-exist.js");
        const log: string[] = [];

        const { outputs, skipped } = await runBuild({
            extensionConfig: validExtensionConfig(),
            editorHelperConfig: validEditorHelperConfig(),
            webviewConfigs: [
                {
                    entryPoints: [missingEntry],
                    bundle: true,
                    outfile: join(distDir, "webview-missing.js"),
                    platform: "browser",
                    format: "iife",
                },
            ],
            distDir,
            log: (message) => log.push(message),
        });

        // The missing entry was skipped, not built, and never fabricated on disk.
        expect(skipped).toEqual([missingEntry]);
        expect(existsSync(join(distDir, "webview-missing.js"))).toBe(false);
        expect(log.some((message) => message.includes("Skipped (not found)"))).toBe(true);

        // The build as a whole still succeeded: the other declared outputs were
        // built and a provenance manifest was written for them.
        expect(outputs.some((path) => path.endsWith("extension.js"))).toBe(true);
        expect(outputs.some((path) => path.endsWith("interactive-rebase-editor-helper.cjs"))).toBe(
            true,
        );
        expect(existsSync(join(distDir, ".build-manifest.json"))).toBe(true);
    });

    it("fails the build -- does not skip it -- when esbuild throws for an entry that exists", async () => {
        // Genuinely invalid syntax: a real esbuild parse failure, not a mocked one.
        const brokenEntry = writeSource("broken-webview.js", "this is not valid javascript {{{");

        await expect(
            runBuild({
                extensionConfig: validExtensionConfig(),
                editorHelperConfig: validEditorHelperConfig(),
                webviewConfigs: [
                    {
                        entryPoints: [brokenEntry],
                        bundle: true,
                        outfile: join(distDir, "webview-broken.js"),
                        platform: "browser",
                        format: "iife",
                    },
                ],
                distDir,
                log: () => {},
            }),
        ).rejects.toThrow();

        // A failed build must never certify anything: no manifest, no output for
        // the entry that failed to compile.
        expect(existsSync(join(distDir, ".build-manifest.json"))).toBe(false);
        expect(existsSync(join(distDir, "webview-broken.js"))).toBe(false);
    });

    it("cleans a stale artifact left over from a previous build instead of leaving it behind", async () => {
        mkdirSync(distDir, { recursive: true });
        const orphan = join(distDir, "webview-orphan.js");
        writeFileSync(orphan, "stale content nobody produced this run", "utf8");
        expect(existsSync(orphan)).toBe(true);

        await runBuild({
            extensionConfig: validExtensionConfig(),
            editorHelperConfig: validEditorHelperConfig(),
            webviewConfigs: [],
            distDir,
            log: () => {},
        });

        expect(existsSync(orphan)).toBe(false);
    });

    it("writes a manifest whose recorded hash matches the actual bytes on disk", async () => {
        await runBuild({
            extensionConfig: validExtensionConfig(),
            editorHelperConfig: validEditorHelperConfig(),
            webviewConfigs: [],
            distDir,
            log: () => {},
        });

        const manifest = JSON.parse(readFileSync(join(distDir, ".build-manifest.json"), "utf8"));
        expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual([
            "extension.js",
            "interactive-rebase-editor-helper.cjs",
        ]);

        // The hash is recomputed here from `node:crypto` rather than by calling
        // the build's own `hashFileContents`. Reusing the production helper
        // would make this assertion a tautology on the axis that matters: a
        // build that switched algorithms, or hashed the source instead of the
        // emitted bundle, would agree with itself and stay green. Every output
        // is checked, so the loop cannot pass vacuously on an empty manifest --
        // the path assertion above already pins the set.
        for (const file of manifest.files as { path: string; hash: string }[]) {
            const outputPath = join(distDir, file.path);
            expect(existsSync(outputPath)).toBe(true);
            const actualSha256 = createHash("sha256")
                .update(readFileSync(outputPath))
                .digest("hex");
            expect(file.hash, `manifest hash for ${file.path}`).toBe(actualSha256);
        }
    });
});
