/**
 * The update-mode leg of the `webviewFixtureGate.*.test.ts` trio (see
 * `webviewFixtureGateTestHelpers.ts` for the split and the shared fixtures).
 *
 * The gate's `missing` finding tells a developer to rerun with `UPDATE_WEBVIEW_FIXTURES=1`.
 * These tests exist so that instruction stays true: Phase 2c-i's regeneration path lived in a
 * byte-comparison test that 2c-ii deleted as redundant, which left the env var named in an
 * error message that nothing in the repository read any more. A dead recovery path is worse
 * than none -- it pushes the next developer toward hand-writing fixture bytes, which is
 * exactly how the decorative, never-regenerable fixture 2c-i had to replace came to exist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` for
// why this must be a plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import { COMMIT_INFO_CLEAN_SCENARIO } from "../../../visual/recorder/recordCommitInfoWebviewFixture";
import { runWebviewFixtureGate } from "../../../visual/recorder/webviewFixtureGate";
import {
    buildWebviewFixture,
    serializeWebviewFixture,
    webviewFixtureFilePath,
} from "../../../visual/recorder/webviewFixtureFile";
import { WEBVIEW_FIXTURE_RECORDERS } from "../../../visual/recorder/webviewFixtureRegistry";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";
import {
    committedBytesInRepo,
    REAL_SCENARIO_TIMEOUT_MS,
    scratchRepoRootWithFixtures,
} from "./webviewFixtureGateTestHelpers";

describe("runWebviewFixtureGate", () => {
    beforeEach(() => {
        setE2eControlChannelActive(true);
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetE2eWebviewCaptureSinkForTests();
    });

    describe("update mode -- the regeneration path the gate's own error message promises", () => {
        it(
            "rewrites a drifted fixture, leaving the next gate run clean",
            async () => {
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
                        update: true,
                    });

                    expect(updated).toEqual([]);
                    expect(await readFile(committedPath, "utf8")).toBe(original);
                    // The real proof: a plain (non-update) run over the regenerated tree is clean.
                    expect(
                        await runWebviewFixtureGate({
                            repoRoot: scratchRepoRoot,
                            registry: WEBVIEW_FIXTURE_RECORDERS,
                        }),
                    ).toEqual([]);
                } finally {
                    await removeScratchDirectories(scratchRepoRoot);
                }
            },
            REAL_SCENARIO_TIMEOUT_MS,
        );

        it(
            "creates a fixture that does not exist yet, directories and all",
            async () => {
                // A bare scratch root: no `tests/visual/fixtures/` at all, which is the state every
                // scenario Phase 2c-iii adds starts in.
                const scratchRepoRoot = await mkdtemp(
                    path.join(tmpdir(), "intelligit-webview-gate-update-create-"),
                );
                try {
                    const findings = await runWebviewFixtureGate({
                        repoRoot: scratchRepoRoot,
                        registry: WEBVIEW_FIXTURE_RECORDERS,
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
                    await removeScratchDirectories(scratchRepoRoot);
                }
            },
            REAL_SCENARIO_TIMEOUT_MS,
        );

        it(
            "never deletes an orphan -- reports it even in update mode",
            async () => {
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
                        update: true,
                    });

                    expect(findings).toHaveLength(1);
                    expect(findings[0]).toMatchObject({ kind: "orphan", path: orphanPath });
                    // Deleting a tracked file because an env var was set is not a regeneration path.
                    await expect(readFile(orphanPath, "utf8")).resolves.toContain(
                        "orphan-scenario",
                    );
                } finally {
                    await removeScratchDirectories(scratchRepoRoot);
                }
            },
            REAL_SCENARIO_TIMEOUT_MS,
        );

        it(
            "writes nothing at all when update is off",
            async () => {
                const scratchRepoRoot = await scratchRepoRootWithFixtures("no-update-write");
                try {
                    const committedPath = webviewFixtureFilePath(
                        scratchRepoRoot,
                        "commit-info",
                        COMMIT_INFO_CLEAN_SCENARIO,
                    );
                    const drifted = (await readFile(committedPath, "utf8")).replace(
                        /\}\n$/,
                        "} \n",
                    );
                    await writeFile(committedPath, drifted, "utf8");

                    await runWebviewFixtureGate({
                        repoRoot: scratchRepoRoot,
                        registry: WEBVIEW_FIXTURE_RECORDERS,
                    });

                    // Still the drifted bytes: the default gate reports drift, it never repairs it.
                    expect(await readFile(committedPath, "utf8")).toBe(drifted);
                } finally {
                    await removeScratchDirectories(scratchRepoRoot);
                }
            },
            REAL_SCENARIO_TIMEOUT_MS,
        );
    });
});
