/**
 * Spec-derived tests for `tests/fixtures/repo/runFixtureTeardown.ts`. The governing claims under
 * test: teardown removes both the template directory and the manifest file; it is safe (never
 * throws) when either or both are already absent (a setup that failed partway, or a teardown run
 * twice); it does NOT swallow a genuine filesystem failure; and a full setup -> teardown -> setup
 * cycle leaves the second setup free to build cleanly at the same paths.
 */

import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    claimFixtureManifest,
    MANIFEST_SCHEMA_VERSION,
    readFixtureManifest,
} from "../../fixtures/repo/manifest";
import { runFixtureSetup } from "../../fixtures/repo/runFixtureSetup";
import { runFixtureTeardown } from "../../fixtures/repo/runFixtureTeardown";
import { seedFixtureTemplate } from "../../fixtures/repo/seed";

const FIXTURE_TIMEOUT_MS = 30_000;

async function exists(candidate: string): Promise<boolean> {
    try {
        await stat(candidate);
        return true;
    } catch {
        return false;
    }
}

describe("runFixtureTeardown", () => {
    let cleanupDirs: string[] = [];
    let cleanupHomes: string[] = [];
    /** Directories whose permissions a test deliberately locked down, restored in afterEach so the
     * outer `cleanupDirs` removal (and vitest's own temp-dir cleanup) never trips over them. */
    let permissionsToRestore: string[] = [];

    afterEach(async () => {
        await Promise.all(
            permissionsToRestore.map((dir) => chmod(dir, 0o755).catch(() => undefined)),
        );
        permissionsToRestore = [];
        await Promise.all([
            ...cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })),
            ...cleanupHomes.map((home) => rm(home, { recursive: true, force: true })),
        ]);
        cleanupDirs = [];
        cleanupHomes = [];
    });

    async function makeWorkDir(prefix: string): Promise<string> {
        const workDir = await mkdtemp(
            path.join(tmpdir(), `intelligit-runfixtureteardown-${prefix}-`),
        );
        cleanupDirs.push(workDir);
        return workDir;
    }

    describe("removes what setup built", () => {
        it(
            "removes both the template directory and the manifest",
            async () => {
                const workDir = await makeWorkDir("both");
                const templateRoot = path.join(workDir, "template");
                const manifestPath = path.join(workDir, "manifest.json");

                const result = await runFixtureSetup({ templateRoot, manifestPath });
                cleanupHomes.push(result.template.home);

                expect(await exists(templateRoot)).toBe(true);
                expect(await exists(manifestPath)).toBe(true);

                await runFixtureTeardown({ templateRoot, manifestPath });

                expect(await exists(templateRoot)).toBe(false);
                expect(await exists(manifestPath)).toBe(false);
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("safe against partial setup state", () => {
        it("does not throw when neither the template nor the manifest exists", async () => {
            const workDir = await makeWorkDir("neither");
            const templateRoot = path.join(workDir, "never-built");
            const manifestPath = path.join(workDir, "never-written.json");

            await expect(runFixtureTeardown({ templateRoot, manifestPath })).resolves.not.toThrow();
        });

        it(
            "does not throw and removes the template when only the template exists (manifest was never published)",
            async () => {
                const workDir = await makeWorkDir("template-only");
                const templateRoot = path.join(workDir, "template");
                const manifestPath = path.join(workDir, "never-written.json");

                const template = await seedFixtureTemplate(templateRoot);
                cleanupHomes.push(template.home);
                expect(await exists(templateRoot)).toBe(true);

                await expect(
                    runFixtureTeardown({ templateRoot, manifestPath }),
                ).resolves.not.toThrow();

                expect(await exists(templateRoot)).toBe(false);
            },
            FIXTURE_TIMEOUT_MS,
        );

        it("does not throw and removes the manifest when only the manifest exists (template was never built)", async () => {
            const workDir = await makeWorkDir("manifest-only");
            const templateRoot = path.join(workDir, "never-built");
            const manifestPath = path.join(workDir, "manifest.json");

            await claimFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot,
            });
            expect(await exists(manifestPath)).toBe(true);

            await expect(runFixtureTeardown({ templateRoot, manifestPath })).resolves.not.toThrow();

            expect(await exists(manifestPath)).toBe(false);
        });
    });

    describe("idempotency", () => {
        it(
            "a second teardown call on an already-torn-down pair is a no-op, never a throw",
            async () => {
                const workDir = await makeWorkDir("idempotent");
                const templateRoot = path.join(workDir, "template");
                const manifestPath = path.join(workDir, "manifest.json");

                const result = await runFixtureSetup({ templateRoot, manifestPath });
                cleanupHomes.push(result.template.home);

                await runFixtureTeardown({ templateRoot, manifestPath });
                await expect(
                    runFixtureTeardown({ templateRoot, manifestPath }),
                ).resolves.not.toThrow();
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("non-masking: a genuine filesystem failure is never swallowed", () => {
        it(
            "propagates EACCES when the template's parent directory forbids removal, rather than treating it as merely absent",
            async () => {
                const workDir = await makeWorkDir("permission-denied");
                const lockedParent = path.join(workDir, "locked-parent");
                const templateRoot = path.join(lockedParent, "template");
                const manifestPath = path.join(workDir, "manifest.json");

                await mkdir(templateRoot, { recursive: true });
                await writeFile(path.join(templateRoot, "marker.txt"), "present\n", "utf8");
                // Removing a real permission-denied case: rm's `force: true` only ignores ENOENT
                // ("path does not exist"), never EACCES -- verified empirically before writing this
                // test. Write permission on the PARENT is what lets an entry be unlinked from it, so
                // locking `lockedParent` (not `templateRoot` itself) is what blocks the removal.
                await chmod(lockedParent, 0o555);
                permissionsToRestore.push(lockedParent);

                await expect(runFixtureTeardown({ templateRoot, manifestPath })).rejects.toThrow(
                    /EACCES|permission/i,
                );
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("round trip", () => {
        it(
            "setup -> teardown -> setup builds cleanly again at the same paths",
            async () => {
                const workDir = await makeWorkDir("roundtrip");
                const templateRoot = path.join(workDir, "template");
                const manifestPath = path.join(workDir, "manifest.json");

                const first = await runFixtureSetup({ templateRoot, manifestPath });
                cleanupHomes.push(first.template.home);
                await runFixtureTeardown({ templateRoot, manifestPath });

                expect(await exists(templateRoot)).toBe(false);
                expect(await exists(manifestPath)).toBe(false);

                const second = await runFixtureSetup({ templateRoot, manifestPath });
                cleanupHomes.push(second.template.home);

                await expect(readFixtureManifest(manifestPath)).resolves.toEqual({
                    schemaVersion: MANIFEST_SCHEMA_VERSION,
                    templateRoot,
                });

                await runFixtureTeardown({ templateRoot, manifestPath });
                expect(await exists(templateRoot)).toBe(false);
                expect(await exists(manifestPath)).toBe(false);
            },
            FIXTURE_TIMEOUT_MS,
        );
    });
});
