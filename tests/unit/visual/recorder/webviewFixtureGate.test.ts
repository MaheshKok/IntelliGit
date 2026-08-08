/**
 * Spec-derived tests for `tests/visual/recorder/webviewFixtureGate.ts` -- PLAN.md step 13's
 * repo-wide regenerate-and-compare gate. Where `recordCommitInfoWebviewFixture.test.ts` proves ONE
 * recorder reproduces its OWN committed fixture, this file proves the generalization: every entry
 * in `webviewFixtureRegistry.ts`, checked in both directions.
 *
 * Every test here is written to be able to fail for a REAL reason:
 *  - "fails ... when a committed fixture drifts" copies the real fixtures tree into a scratch
 *    `repoRoot`, mutates the COPY byte for byte, and observes the gate catch it -- proving the gate
 *    reads real committed bytes off disk rather than trusting an in-memory recording alone, while
 *    never putting the tracked file at risk. (It deliberately does NOT mutate-and-restore the
 *    tracked file: a run killed mid-test -- Ctrl-C, OOM, a CI timeout -- would skip the restore and
 *    leave a corrupted committed fixture for the next commit to absorb.)
 *  - "fails ... when a registry entry has no committed fixture" uses a registry entry whose
 *    `record` throws if ever called, so the finding must come from the filesystem check alone --
 *    never from tolerating a call that should not happen.
 *  - "fails ... when an orphaned fixture file exists" plants a lone file under an isolated scratch
 *    `repoRoot`, never the real repository, so this test can never itself leave a stray file
 *    behind for `git diff --stat tests/visual/fixtures/` to notice.
 *  - "passes on the current tree" is the gate's own real-world proof, and separately confirms
 *    `tests/visual/fixtures/host/` -- which certifiably holds files but no registry entry -- is
 *    never reported as an orphan.
 *  - "registers at least one recording" guards against the gate passing vacuously over an empty
 *    registry, which would prove nothing about any of the above.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` for
// why this must be a plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import { seedFixtureTemplate, type FixtureTemplate } from "../../../fixtures/repo/seed";
import { COMMIT_INFO_CLEAN_SCENARIO } from "../../../visual/recorder/recordCommitInfoWebviewFixture";
import {
    runWebviewFixtureGate,
    UPDATE_WEBVIEW_FIXTURES_ENV_VAR,
} from "../../../visual/recorder/webviewFixtureGate";
import {
    buildWebviewFixture,
    serializeWebviewFixture,
    webviewFixtureFilePath,
} from "../../../visual/recorder/webviewFixtureFile";
import {
    WEBVIEW_FIXTURE_RECORDERS,
    type WebviewFixtureRecorderEntry,
} from "../../../visual/recorder/webviewFixtureRegistry";
import type { WebviewFixture } from "../../../visual/recorder/webviewFixtureTypes";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REAL_FIXTURES_DIR = path.join(REPO_ROOT, "tests", "visual", "fixtures");

/** Recursive directory copy, used to mirror the real fixtures tree into a scratch `repoRoot`.
 * Hand-rolled rather than `fs.cp`, which is still flagged experimental on the Node versions this
 * repository supports and would print a warning into every run's output. */
async function copyDirectory(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const destination = path.join(to, entry.name);
        if (entry.isDirectory()) {
            await copyDirectory(source, destination);
        } else if (entry.isFile()) {
            await copyFile(source, destination);
        }
    }
}

/** A scratch `repoRoot` holding a byte-identical copy of the real fixtures tree. Every test that
 * mutates a fixture, or that lets the gate WRITE one, runs against one of these -- never against
 * the tracked tree. */
async function scratchRepoRootWithFixtures(label: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), `intelligit-webview-gate-${label}-`));
    await copyDirectory(REAL_FIXTURES_DIR, path.join(root, "tests", "visual", "fixtures"));
    return root;
}

function committedBytesInRepo(): Promise<string> {
    return readFile(
        webviewFixtureFilePath(REPO_ROOT, "commit-info", COMMIT_INFO_CLEAN_SCENARIO),
        "utf8",
    );
}

/** A registry entry whose `record` throws if ever invoked -- used by the "missing" test, where a
 * gate that (incorrectly) tried to record before checking the committed file exists would call
 * this and fail for the wrong reason. */
function throwingRegistryEntry(scenario: string): WebviewFixtureRecorderEntry {
    return {
        contextId: "commit-info",
        scenario,
        record: (): Promise<WebviewFixture> => {
            throw new Error(
                `record() must not be called for "${scenario}" -- its committed fixture is ` +
                    "missing, so the gate should report that without ever recording.",
            );
        },
    };
}

describe("runWebviewFixtureGate", () => {
    let parentDir: string;
    let workspace: FixtureTemplate;

    beforeAll(async () => {
        parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-webview-gate-test-"));
        workspace = await seedFixtureTemplate(path.join(parentDir, "root"));
    }, 60_000);

    afterAll(async () => {
        await rm(parentDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        setE2eControlChannelActive(true);
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetE2eWebviewCaptureSinkForTests();
    });

    it("registers at least one recording -- an empty registry would pass this gate vacuously", () => {
        expect(WEBVIEW_FIXTURE_RECORDERS.length).toBeGreaterThan(0);
    });

    it("passes on the current tree, and tests/visual/fixtures/host/ never trips it as an orphan", async () => {
        // Sanity precondition: host/ genuinely holds files and genuinely has no registry entry --
        // otherwise this test would pass even without the exclusion this file's own doc comment
        // and `webviewFixtureGate.ts`'s `NON_WEBVIEW_FIXTURE_DIRS` claim to provide.
        const hostFiles = await readdir(path.join(REAL_FIXTURES_DIR, "host"));
        expect(hostFiles.length).toBeGreaterThan(0);
        expect(
            WEBVIEW_FIXTURE_RECORDERS.some((entry) => (entry.contextId as string) === "host"),
        ).toBe(false);

        // The ONE call that runs against the real tree, and therefore the one that honors
        // `UPDATE_WEBVIEW_FIXTURES=1` -- that is what makes the command in `webviewFixtureGate.ts`'s
        // doc comment (and in the gate's own findings) real rather than aspirational. In update
        // mode this assertion is vacuously true, which is inherent to any regeneration path: the
        // proof then lives in `git diff`, and in the plain rerun a developer does afterwards.
        const findings = await runWebviewFixtureGate({
            repoRoot: REPO_ROOT,
            registry: WEBVIEW_FIXTURE_RECORDERS,
            workspace,
            update: process.env[UPDATE_WEBVIEW_FIXTURES_ENV_VAR] === "1",
        });

        expect(findings).toEqual([]);
    });

    it("fails, naming the file, when a committed fixture drifts from a fresh recording", async () => {
        // A COPY of the whole real fixtures tree -- not the tracked files, and not just the one
        // fixture this test mutates. Copying the whole tree keeps this assertion at exactly one
        // finding as Phase 2c-iii registers more contexts: a scratch root holding only
        // `commit-info/clean.json` would report every other registry entry as "missing".
        const scratchRepoRoot = await scratchRepoRootWithFixtures("drift");
        try {
            const committedPath = webviewFixtureFilePath(
                scratchRepoRoot,
                "commit-info",
                COMMIT_INFO_CLEAN_SCENARIO,
            );
            const original = await readFile(committedPath, "utf8");
            // Precondition: the copy is byte-identical to the tracked file, so the mismatch below
            // can only come from the mutation -- never from a lossy copy.
            expect(original).toBe(await committedBytesInRepo());

            const mutated = original.replace(/\}\n$/, "} \n");
            expect(mutated).not.toBe(original); // guards the mutation itself actually took effect
            await writeFile(committedPath, mutated, "utf8");

            const findings = await runWebviewFixtureGate({
                repoRoot: scratchRepoRoot,
                registry: WEBVIEW_FIXTURE_RECORDERS,
                workspace,
            });

            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                kind: "mismatch",
                contextId: "commit-info",
                scenario: COMMIT_INFO_CLEAN_SCENARIO,
                path: committedPath,
            });
            expect(findings[0].detail.length).toBeGreaterThan(0);
        } finally {
            await rm(scratchRepoRoot, { recursive: true, force: true });
        }
    });

    it("fails when a registry entry has no committed fixture on disk", async () => {
        // The real entries are included alongside the synthetic one -- otherwise the orphan scan
        // (correctly) reports the REAL committed `commit-info/clean.json` as unregistered too,
        // since it would be absent from this test's own registry, and the assertion below would
        // no longer isolate the "missing" behavior this test exists to prove.
        const registry = [
            ...WEBVIEW_FIXTURE_RECORDERS,
            throwingRegistryEntry("does-not-exist-on-disk"),
        ];

        const findings = await runWebviewFixtureGate({ repoRoot: REPO_ROOT, registry, workspace });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            kind: "missing",
            contextId: "commit-info",
            scenario: "does-not-exist-on-disk",
            path: webviewFixtureFilePath(REPO_ROOT, "commit-info", "does-not-exist-on-disk"),
        });
    });

    /**
     * The gate's `missing` finding tells a developer to rerun with `UPDATE_WEBVIEW_FIXTURES=1`.
     * These tests exist so that instruction stays true: Phase 2c-i's regeneration path lived in a
     * byte-comparison test that 2c-ii deleted as redundant, which left the env var named in an
     * error message that nothing in the repository read any more. A dead recovery path is worse
     * than none -- it pushes the next developer toward hand-writing fixture bytes, which is
     * exactly how the decorative, never-regenerable fixture 2c-i had to replace came to exist.
     */
    describe("update mode -- the regeneration path the gate's own error message promises", () => {
        it("rewrites a drifted fixture, leaving the next gate run clean", async () => {
            const scratchRepoRoot = await scratchRepoRootWithFixtures("update-drift");
            try {
                const committedPath = webviewFixtureFilePath(
                    scratchRepoRoot,
                    "commit-info",
                    COMMIT_INFO_CLEAN_SCENARIO,
                );
                const original = await readFile(committedPath, "utf8");
                await writeFile(committedPath, original.replace(/\}\n$/, "} \n"), "utf8");

                const updated = await runWebviewFixtureGate({
                    repoRoot: scratchRepoRoot,
                    registry: WEBVIEW_FIXTURE_RECORDERS,
                    workspace,
                    update: true,
                });

                expect(updated).toEqual([]);
                expect(await readFile(committedPath, "utf8")).toBe(original);
                // The real proof: a plain (non-update) run over the regenerated tree is clean.
                expect(
                    await runWebviewFixtureGate({
                        repoRoot: scratchRepoRoot,
                        registry: WEBVIEW_FIXTURE_RECORDERS,
                        workspace,
                    }),
                ).toEqual([]);
            } finally {
                await rm(scratchRepoRoot, { recursive: true, force: true });
            }
        });

        it("creates a fixture that does not exist yet, directories and all", async () => {
            // A bare scratch root: no `tests/visual/fixtures/` at all, which is the state every
            // scenario Phase 2c-iii adds starts in.
            const scratchRepoRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-webview-gate-update-create-"),
            );
            try {
                const findings = await runWebviewFixtureGate({
                    repoRoot: scratchRepoRoot,
                    registry: WEBVIEW_FIXTURE_RECORDERS,
                    workspace,
                    update: true,
                });

                expect(findings).toEqual([]);
                // Byte-equal to the TRACKED fixture -- proves the regeneration path and the
                // committed file agree, so regenerating never silently changes what is on disk.
                expect(
                    await readFile(
                        webviewFixtureFilePath(
                            scratchRepoRoot,
                            "commit-info",
                            COMMIT_INFO_CLEAN_SCENARIO,
                        ),
                        "utf8",
                    ),
                ).toBe(await committedBytesInRepo());
            } finally {
                await rm(scratchRepoRoot, { recursive: true, force: true });
            }
        });

        it("never deletes an orphan -- reports it even in update mode", async () => {
            const scratchRepoRoot = await scratchRepoRootWithFixtures("update-orphan");
            try {
                const orphanPath = webviewFixtureFilePath(
                    scratchRepoRoot,
                    "commit-info",
                    "orphan-scenario",
                );
                await writeFile(
                    orphanPath,
                    serializeWebviewFixture(
                        buildWebviewFixture("commit-info", "orphan-scenario", []),
                    ),
                    "utf8",
                );

                const findings = await runWebviewFixtureGate({
                    repoRoot: scratchRepoRoot,
                    registry: WEBVIEW_FIXTURE_RECORDERS,
                    workspace,
                    update: true,
                });

                expect(findings).toHaveLength(1);
                expect(findings[0]).toMatchObject({ kind: "orphan", path: orphanPath });
                // Deleting a tracked file because an env var was set is not a regeneration path.
                await expect(readFile(orphanPath, "utf8")).resolves.toContain("orphan-scenario");
            } finally {
                await rm(scratchRepoRoot, { recursive: true, force: true });
            }
        });

        it("writes nothing at all when update is off", async () => {
            const scratchRepoRoot = await scratchRepoRootWithFixtures("no-update-write");
            try {
                const committedPath = webviewFixtureFilePath(
                    scratchRepoRoot,
                    "commit-info",
                    COMMIT_INFO_CLEAN_SCENARIO,
                );
                const drifted = (await readFile(committedPath, "utf8")).replace(/\}\n$/, "} \n");
                await writeFile(committedPath, drifted, "utf8");

                await runWebviewFixtureGate({
                    repoRoot: scratchRepoRoot,
                    registry: WEBVIEW_FIXTURE_RECORDERS,
                    workspace,
                });

                // Still the drifted bytes: the default gate reports drift, it never repairs it.
                expect(await readFile(committedPath, "utf8")).toBe(drifted);
            } finally {
                await rm(scratchRepoRoot, { recursive: true, force: true });
            }
        });
    });

    it("fails when an orphaned fixture file exists with no registry entry", async () => {
        const scratchRepoRoot = await mkdtemp(
            path.join(tmpdir(), "intelligit-webview-gate-orphan-"),
        );
        try {
            const orphanDir = path.join(
                scratchRepoRoot,
                "tests",
                "visual",
                "fixtures",
                "commit-info",
            );
            await mkdir(orphanDir, { recursive: true });
            const orphanPath = path.join(orphanDir, "orphan-scenario.json");
            await writeFile(
                orphanPath,
                serializeWebviewFixture(buildWebviewFixture("commit-info", "orphan-scenario", [])),
                "utf8",
            );

            const findings = await runWebviewFixtureGate({
                repoRoot: scratchRepoRoot,
                registry: [],
                workspace,
            });

            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                kind: "orphan",
                contextId: "commit-info",
                scenario: "orphan-scenario",
                path: orphanPath,
            });
        } finally {
            await rm(scratchRepoRoot, { recursive: true, force: true });
        }
    });
});
