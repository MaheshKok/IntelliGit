/**
 * Spec-derived tests for `tests/fixtures/repo/manifest.ts` (PLAN.md Phase 1 step 8, the manifest
 * slice -- Codex R5 #6). The governing claim under test: a worker reading the atomic per-run
 * manifest either gets a fully valid `FixtureManifest` or one of four DISTINCT hard failures
 * (missing / empty / truncated-or-malformed / schema-invalid) -- never a default, never a rebuild,
 * never a silent fallback. Every failure mode is planted directly on disk (bypassing
 * `writeFixtureManifest` entirely for the negative cases) so these tests do not merely mirror
 * `readFixtureManifest`'s own implementation.
 */

import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Node's built-in `node:fs/promises` exports non-configurable properties, so `vi.spyOn` cannot
// wrap them directly ("Cannot redefine property"). `vi.mock` with a pass-through factory is the
// standard vitest workaround: it replaces the module in the registry (for every importer within
// this file's graph, including `manifest.ts` itself) with wrapped `vi.fn()`s that still call the
// real implementation, so every other test in this file keeps writing real bytes to a real
// filesystem while these two calls also become inspectable.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        writeFile: vi.fn(actual.writeFile),
        rename: vi.fn(actual.rename),
    };
});

import {
    DEFAULT_MANIFEST_PATH,
    MANIFEST_SCHEMA_VERSION,
    claimFixtureManifest,
    readFixtureManifest,
    writeFixtureManifest,
    type FixtureManifest,
} from "../../fixtures/repo/manifest";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("manifest", () => {
    let cleanupDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(cleanupDirs.map((dir) => removeScratchDirectories(dir)));
        cleanupDirs = [];
    });

    async function makeWorkDir(prefix: string): Promise<string> {
        const workDir = await mkdtemp(path.join(tmpdir(), `intelligit-manifest-${prefix}-`));
        cleanupDirs.push(workDir);
        return workDir;
    }

    describe("round trip", () => {
        it("writes then reads back an identical manifest", async () => {
            const workDir = await makeWorkDir("roundtrip");
            const manifestPath = path.join(workDir, "nested", "manifest.json");
            const manifest: FixtureManifest = {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            };

            await writeFixtureManifest(manifestPath, manifest);
            const readBack = await readFixtureManifest(manifestPath);

            expect(readBack).toEqual(manifest);
        });

        it("creates the manifest's parent directory when it does not exist yet", async () => {
            const workDir = await makeWorkDir("mkdirp");
            const manifestPath = path.join(workDir, "does", "not", "exist", "manifest.json");

            await expect(
                writeFixtureManifest(manifestPath, {
                    schemaVersion: MANIFEST_SCHEMA_VERSION,
                    templateRoot: path.join(workDir, "template"),
                }),
            ).resolves.not.toThrow();
        });

        it("DEFAULT_MANIFEST_PATH is an absolute path under the OS temp directory", () => {
            expect(path.isAbsolute(DEFAULT_MANIFEST_PATH)).toBe(true);
            expect(DEFAULT_MANIFEST_PATH.startsWith(tmpdir())).toBe(true);
        });
    });

    describe("atomicity", () => {
        it("leaves no temp file behind after a successful write -- only the final manifest exists", async () => {
            const workDir = await makeWorkDir("notemp");
            const manifestPath = path.join(workDir, "manifest.json");

            await writeFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            });

            const entries = await readdir(workDir);
            expect(entries).toEqual(["manifest.json"]);
        });

        it("writes to a same-directory temp file and renames it into place -- never writes the target path directly", async () => {
            // Deterministic proof of the temp-then-rename SHAPE, independent of any timing window:
            // an implementation that writes `manifestPath` directly (skipping the rename entirely)
            // would still pass the "no debris left behind" test above and might even dodge the
            // concurrent-read race below on a fast filesystem -- this test catches that defect class
            // by asserting the actual calls made, not just the end state.
            const workDir = await makeWorkDir("atomic-shape");
            const manifestPath = path.join(workDir, "manifest.json");

            const writeFileMock = vi.mocked(writeFile);
            const renameMock = vi.mocked(rename);
            writeFileMock.mockClear();
            renameMock.mockClear();

            await writeFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            });

            expect(writeFileMock).toHaveBeenCalledTimes(1);
            const [writtenPath] = writeFileMock.mock.calls[0] as [string, ...unknown[]];
            expect(writtenPath).not.toBe(manifestPath);
            expect(path.dirname(writtenPath)).toBe(path.dirname(manifestPath));

            expect(renameMock).toHaveBeenCalledTimes(1);
            const [renameFrom, renameTo] = renameMock.mock.calls[0] as [string, string];
            expect(renameFrom).toBe(writtenPath);
            expect(renameTo).toBe(manifestPath);
        });

        it("a concurrent reader never observes a partially-written manifest under real write pressure", async () => {
            const workDir = await makeWorkDir("race");
            const manifestPath = path.join(workDir, "manifest.json");
            // A large `templateRoot`-adjacent payload (still schema-valid: extra keys are not
            // rejected) gives the temp-file write measurable duration, so a reader polling
            // during that window has a real chance to observe a bug if one existed -- not just
            // a theoretical race.
            const manifest = {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
                padding: "x".repeat(8_000_000),
            } as unknown as FixtureManifest;

            let writeDone = false;
            let observedValid = 0;
            let observedMissing = 0;
            let observedUnexpected: unknown = null;

            const writePromise = writeFixtureManifest(manifestPath, manifest).then(() => {
                writeDone = true;
            });

            const pollPromise = (async () => {
                while (!writeDone) {
                    try {
                        const read = await readFixtureManifest(manifestPath);
                        observedValid += 1;
                        if (read.templateRoot !== manifest.templateRoot) {
                            observedUnexpected = `templateRoot mismatch: ${read.templateRoot}`;
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        if (message.includes("no manifest file")) {
                            observedMissing += 1;
                        } else {
                            observedUnexpected = message;
                        }
                    }
                }
            })();

            await Promise.all([writePromise, pollPromise]);

            expect(observedUnexpected).toBeNull();
            expect(observedMissing + observedValid).toBeGreaterThan(0);
        }, 30_000);
    });

    describe("hard failures -- distinct message per cause", () => {
        it("THROWS naming a missing manifest when the file does not exist", async () => {
            const workDir = await makeWorkDir("missing");
            const manifestPath = path.join(workDir, "never-written.json");

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(/no manifest file/);
        });

        it("THROWS naming an empty manifest for a zero-byte file", async () => {
            const workDir = await makeWorkDir("empty");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFile(manifestPath, "", "utf8");

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(/is empty/);
        });

        it("THROWS naming a whitespace-only file as empty", async () => {
            const workDir = await makeWorkDir("whitespace");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFile(manifestPath, "   \n\t  \n", "utf8");

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(/is empty/);
        });

        it("THROWS naming truncated/malformed JSON for a half-written file -- THE TEETH TEST", async () => {
            const workDir = await makeWorkDir("truncated");
            const manifestPath = path.join(workDir, "manifest.json");
            const fullyValid = JSON.stringify({
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            });
            // Simulates exactly the hazard atomicity exists to prevent: a reader landing mid-write.
            // Planted directly, bypassing writeFixtureManifest entirely, so this proves
            // readFixtureManifest itself rejects a torn file rather than relying on the writer to
            // never produce one.
            const halfWritten = fullyValid.slice(0, Math.floor(fullyValid.length / 2));
            await writeFile(manifestPath, halfWritten, "utf8");

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(
                /truncated or contains malformed JSON/,
            );
        });

        it("THROWS distinguishing schema-invalid JSON (valid JSON, wrong shape) from truncated JSON", async () => {
            const workDir = await makeWorkDir("schema-array");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFile(manifestPath, JSON.stringify([1, 2, 3]), "utf8");

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(
                /fails schema validation/,
            );
        });

        it("THROWS naming the wrong schemaVersion", async () => {
            const workDir = await makeWorkDir("schema-version");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFile(
                manifestPath,
                JSON.stringify({ schemaVersion: 999, templateRoot: workDir }),
                "utf8",
            );

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(
                /"schemaVersion" must be exactly/,
            );
        });

        it("THROWS naming a missing templateRoot field", async () => {
            const workDir = await makeWorkDir("schema-missing-root");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFile(
                manifestPath,
                JSON.stringify({ schemaVersion: MANIFEST_SCHEMA_VERSION }),
                "utf8",
            );

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(
                /"templateRoot" must be/,
            );
        });

        it("THROWS naming a relative templateRoot as invalid", async () => {
            const workDir = await makeWorkDir("schema-relative-root");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFile(
                manifestPath,
                JSON.stringify({
                    schemaVersion: MANIFEST_SCHEMA_VERSION,
                    templateRoot: "relative/path",
                }),
                "utf8",
            );

            await expect(readFixtureManifest(manifestPath)).rejects.toThrow(
                /"templateRoot" must be/,
            );
        });

        it("THROWS naming multiple problems together when several fields are wrong at once", async () => {
            const workDir = await makeWorkDir("schema-multi");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFile(
                manifestPath,
                JSON.stringify({ schemaVersion: "not-a-number", templateRoot: 42 }),
                "utf8",
            );

            let thrown: unknown;
            try {
                await readFixtureManifest(manifestPath);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(Error);
            const message = (thrown as Error).message;
            expect(message).toContain("schemaVersion");
            expect(message).toContain("templateRoot");
        });

        it("sanity: reading the exact bytes writeFixtureManifest produced never throws", async () => {
            const workDir = await makeWorkDir("sanity");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            });

            await expect(readFixtureManifest(manifestPath)).resolves.not.toThrow();
        });
    });

    describe("claimFixtureManifest -- distinct from writeFixtureManifest's unconditional overwrite", () => {
        it("succeeds and is readable when no manifest exists yet", async () => {
            const workDir = await makeWorkDir("claim-fresh");
            const manifestPath = path.join(workDir, "manifest.json");
            const manifest: FixtureManifest = {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            };

            await claimFixtureManifest(manifestPath, manifest);
            const readBack = await readFixtureManifest(manifestPath);

            expect(readBack).toEqual(manifest);
        });

        it("THROWS naming the existing templateRoot when a manifest already exists, and leaves it byte-identical", async () => {
            const workDir = await makeWorkDir("claim-collision");
            const manifestPath = path.join(workDir, "manifest.json");
            const existing: FixtureManifest = {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "run-a-template"),
            };
            await writeFixtureManifest(manifestPath, existing);
            const bytesBefore = await readFile(manifestPath, "utf8");

            const challenger: FixtureManifest = {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "run-b-template"),
            };

            await expect(claimFixtureManifest(manifestPath, challenger)).rejects.toThrow(
                new RegExp(escapeRegExp(existing.templateRoot)),
            );

            const bytesAfter = await readFile(manifestPath, "utf8");
            expect(bytesAfter).toBe(bytesBefore);
        });

        it("does not survive as a temp file after a successful claim", async () => {
            const workDir = await makeWorkDir("claim-notemp-ok");
            const manifestPath = path.join(workDir, "manifest.json");

            await claimFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            });

            const entries = await readdir(workDir);
            expect(entries).toEqual(["manifest.json"]);
        });

        it("does not survive as a temp file after a refused claim", async () => {
            const workDir = await makeWorkDir("claim-notemp-refused");
            const manifestPath = path.join(workDir, "manifest.json");
            await writeFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            });

            await expect(
                claimFixtureManifest(manifestPath, {
                    schemaVersion: MANIFEST_SCHEMA_VERSION,
                    templateRoot: path.join(workDir, "other-template"),
                }),
            ).rejects.toThrow();

            const entries = await readdir(workDir);
            expect(entries).toEqual(["manifest.json"]);
        });

        it("the documented explicit override (writeFixtureManifest) DOES replace an existing manifest", async () => {
            const workDir = await makeWorkDir("claim-then-override");
            const manifestPath = path.join(workDir, "manifest.json");
            await claimFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "run-a-template"),
            });

            const replacement: FixtureManifest = {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "run-b-template"),
            };
            await writeFixtureManifest(manifestPath, replacement);

            await expect(readFixtureManifest(manifestPath)).resolves.toEqual(replacement);
        });

        it("concurrent claims at the same target: exactly one wins, the rest throw", async () => {
            const workDir = await makeWorkDir("claim-concurrent");
            const manifestPath = path.join(workDir, "manifest.json");
            const CONCURRENT_CLAIMANTS = 10;

            const results = await Promise.allSettled(
                Array.from({ length: CONCURRENT_CLAIMANTS }, (_, index) =>
                    claimFixtureManifest(manifestPath, {
                        schemaVersion: MANIFEST_SCHEMA_VERSION,
                        templateRoot: path.join(workDir, `claimant-${index}-template`),
                    }),
                ),
            );

            const fulfilled = results.filter((result) => result.status === "fulfilled");
            const rejected = results.filter((result) => result.status === "rejected");

            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(CONCURRENT_CLAIMANTS - 1);

            // The one winner's manifest must be the one actually on disk -- and it must be readable,
            // proving the winning write was never partially applied.
            await expect(readFixtureManifest(manifestPath)).resolves.not.toThrow();

            const entries = await readdir(workDir);
            expect(entries).toEqual(["manifest.json"]);
        }, 30_000);
    });

    describe("directory hygiene", () => {
        it("does not disturb unrelated files already in the manifest's directory", async () => {
            const workDir = await makeWorkDir("hygiene");
            await mkdir(workDir, { recursive: true });
            await writeFile(path.join(workDir, "unrelated.txt"), "leave me alone\n", "utf8");
            const manifestPath = path.join(workDir, "manifest.json");

            await writeFixtureManifest(manifestPath, {
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                templateRoot: path.join(workDir, "template"),
            });

            const entries = (await readdir(workDir)).sort();
            expect(entries).toEqual(["manifest.json", "unrelated.txt"]);
        });
    });
});
