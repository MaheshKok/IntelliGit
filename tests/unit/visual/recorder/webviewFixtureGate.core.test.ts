/**
 * The core leg of the `webviewFixtureGate.*.test.ts` trio (see `webviewFixtureGateTestHelpers.ts`
 * for the split and the shared fixtures): the gate's default, non-update behavior. Every test here
 * is written to be able to fail for a REAL reason:
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` for
// why this must be a plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
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
import { WEBVIEW_FIXTURE_RECORDERS } from "../../../visual/recorder/webviewFixtureRegistry";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";
import {
    committedBytesInRepo,
    REAL_FIXTURES_DIR,
    REAL_SCENARIO_TIMEOUT_MS,
    REPO_ROOT,
    scratchRepoRootWithFixtures,
    throwingRegistryEntry,
} from "./webviewFixtureGateTestHelpers";

describe("runWebviewFixtureGate", () => {
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

    it(
        "passes on the current tree, and tests/visual/fixtures/host/ never trips it as an orphan",
        async () => {
            // Sanity precondition: host/ genuinely holds files and genuinely has no registry entry
            // -- otherwise this test would pass even without the exclusion this file's own doc
            // comment and `webviewFixtureGate.ts`'s `NON_WEBVIEW_FIXTURE_DIRS` claim to provide.
            const hostFiles = await readdir(path.join(REAL_FIXTURES_DIR, "host"));
            expect(hostFiles.length).toBeGreaterThan(0);
            expect(
                WEBVIEW_FIXTURE_RECORDERS.some((entry) => (entry.contextId as string) === "host"),
            ).toBe(false);

            // The ONE call that runs against the real tree with the DEFAULT (real) `prepareScenario`
            // -- and therefore the one that honors `UPDATE_WEBVIEW_FIXTURES=1` -- is what makes the
            // command in `webviewFixtureGate.ts`'s doc comment (and in the gate's own findings) real
            // rather than aspirational. In update mode this assertion is vacuously true, which is
            // inherent to any regeneration path: the proof then lives in `git diff`, and in the plain
            // rerun a developer does afterwards.
            const findings = await runWebviewFixtureGate({
                repoRoot: REPO_ROOT,
                registry: WEBVIEW_FIXTURE_RECORDERS,
                update: process.env[UPDATE_WEBVIEW_FIXTURES_ENV_VAR] === "1",
            });

            expect(findings).toEqual([]);
        },
        REAL_SCENARIO_TIMEOUT_MS,
    );

    it(
        "fails, naming the file, when a committed fixture drifts from a fresh recording",
        async () => {
            // A COPY of the whole real fixtures tree -- not the tracked files, and not just the one
            // fixture this test mutates. Copying the whole tree keeps this assertion at exactly one
            // finding as Phase 2c-iii/iv register more contexts: a scratch root holding only
            // `commit-info/clean.json` would report every other registry entry as "missing".
            const scratchRepoRoot = await scratchRepoRootWithFixtures("drift");
            try {
                const committedPath = webviewFixtureFilePath(
                    scratchRepoRoot,
                    "commit-info",
                    COMMIT_INFO_CLEAN_SCENARIO,
                );
                const original = await readFile(committedPath, "utf8");
                // Precondition: the copy is byte-identical to the tracked file, so the mismatch
                // below can only come from the mutation -- never from a lossy copy.
                expect(original).toBe(await committedBytesInRepo());

                const mutated = original.replace(/\}\n$/, "} \n");
                expect(mutated).not.toBe(original); // guards the mutation itself actually took effect
                await writeFile(committedPath, mutated, "utf8");

                const findings = await runWebviewFixtureGate({
                    repoRoot: scratchRepoRoot,
                    registry: WEBVIEW_FIXTURE_RECORDERS,
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
                await removeScratchDirectories(scratchRepoRoot);
            }
        },
        REAL_SCENARIO_TIMEOUT_MS,
    );

    it(
        "fails when a registry entry has no committed fixture on disk",
        async () => {
            // The real entries are included alongside the synthetic one -- otherwise the orphan scan
            // (correctly) reports the REAL committed `commit-info/clean.json` as unregistered too,
            // since it would be absent from this test's own registry, and the assertion below would
            // no longer isolate the "missing" behavior this test exists to prove.
            const registry = [...WEBVIEW_FIXTURE_RECORDERS, throwingRegistryEntry("dirty")];

            const findings = await runWebviewFixtureGate({ repoRoot: REPO_ROOT, registry });

            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                kind: "missing",
                contextId: "commit-info",
                scenario: "dirty",
                path: webviewFixtureFilePath(REPO_ROOT, "commit-info", "dirty"),
            });
        },
        REAL_SCENARIO_TIMEOUT_MS,
    );

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
            });

            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                kind: "orphan",
                contextId: "commit-info",
                scenario: "orphan-scenario",
                path: orphanPath,
            });
        } finally {
            await removeScratchDirectories(scratchRepoRoot);
        }
    });
});
