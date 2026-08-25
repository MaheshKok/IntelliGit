/**
 * The disposal-and-guards leg of the `webviewFixtureGate.*.test.ts` trio (see
 * `webviewFixtureGateTestHelpers.ts` for the split and the shared fixtures).
 *
 * Phase 2c-iv-a's four scenario-preparation tests prove the scenario-aware rework (`workspace` is
 * gone; the gate now prepares what each entry's typed `scenario` declares):
 *  - "prepares each distinct scenario at most once" registers three entries, two sharing a
 *    scenario, against an INSTRUMENTED `prepareScenario` and asserts the call COUNT -- not a code
 *    read, not a log line.
 *  - "disposes every prepared workspace" and "still disposes ... when a recorder rejects" both use
 *    real scratch directories from that same instrumentation and assert `existsSync` is false for
 *    both the destination directory and the scratch `home` afterwards -- proving cleanup, not just
 *    asserting the code that should cause it looks right.
 *  - "an entry whose scenario has no template fails loudly" mislabels the real `commit-info`
 *    entry's scenario to `empty-repo` (the one scenario `ScenarioWorkspace.template` is genuinely
 *    absent for) and asserts the failure names both the context and the scenario, rather than a
 *    bare `TypeError: Cannot read properties of undefined`.
 *
 * These deliberately avoid real `git` scenario builds (the `scenarios.*.test.ts` suites already
 * prove those) -- an instrumented `prepareScenario` hands back real scratch directories without
 * paying for a full seeded history, so disposal is still checked against something real on disk.
 * The `prepareIntoScratchDestination` and `assertDisposableScenarioPath` describes cover the
 * allocation-cleanup and delete-containment guards directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` for
// why this must be a plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import {
    assertDisposableScenarioPath,
    prepareIntoScratchDestination,
    runWebviewFixtureGate,
} from "../../../visual/recorder/webviewFixtureGate";
import {
    WEBVIEW_FIXTURE_RECORDERS,
    type WebviewFixtureRecorderEntry,
} from "../../../visual/recorder/webviewFixtureRegistry";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";
import { fakeEntry, instrumentedPrepareScenario } from "./webviewFixtureGateTestHelpers";

describe("runWebviewFixtureGate", () => {
    beforeEach(() => {
        setE2eControlChannelActive(true);
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetE2eWebviewCaptureSinkForTests();
    });

    /**
     * Phase 2c-iv-a: `scenario` is now typed `RepositoryScenarioId`, and the gate prepares a real
     * `ScenarioWorkspace` per distinct scenario rather than being handed one shared `FixtureTemplate`
     * by the caller. These four prove that rework's own contract, independent of what any one
     * recorder captures.
     */
    describe("scenario preparation and disposal (Phase 2c-iv-a)", () => {
        it("prepares each distinct scenario at most once per run, reusing it across every entry that declares it", async () => {
            const scratchRepoRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-webview-gate-prepare-once-"),
            );
            const { prepareScenario, calls, preparations } = instrumentedPrepareScenario();
            try {
                // Three entries, two sharing "clean" -- the spec's own example. A gate that
                // (incorrectly) prepared per-ENTRY rather than per-distinct-scenario would call
                // `prepareScenario` three times here, not two.
                const registry: WebviewFixtureRecorderEntry[] = [
                    fakeEntry("clean"),
                    fakeEntry("dirty"),
                    fakeEntry("clean"),
                ];

                await runWebviewFixtureGate({
                    repoRoot: scratchRepoRoot,
                    registry,
                    update: true,
                    prepareScenario,
                });

                expect(calls).toEqual(["clean", "dirty"]);
                expect(preparations).toHaveLength(2);
            } finally {
                await removeScratchDirectories(scratchRepoRoot);
            }
        });

        it("disposes every prepared workspace -- both the destination directory and the scratch home", async () => {
            const scratchRepoRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-webview-gate-dispose-"),
            );
            const { prepareScenario, preparations } = instrumentedPrepareScenario();
            try {
                await runWebviewFixtureGate({
                    repoRoot: scratchRepoRoot,
                    registry: [fakeEntry("clean")],
                    update: true,
                    prepareScenario,
                });

                expect(preparations).toHaveLength(1);
                // Both checked, and checked SEPARATELY: `home` is a sibling of `destination`, not
                // nested inside it (see `webviewFixtureGate.ts`'s `disposeScenarioWorkspace` doc
                // comment) -- a gate that only removed `destination` would pass the first of these
                // and fail the second.
                expect(existsSync(preparations[0].destination)).toBe(false);
                expect(existsSync(preparations[0].home)).toBe(false);
            } finally {
                await removeScratchDirectories(scratchRepoRoot);
            }
        });

        it("still disposes every prepared workspace when a recorder rejects", async () => {
            const scratchRepoRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-webview-gate-dispose-throw-"),
            );
            const { prepareScenario, preparations } = instrumentedPrepareScenario();
            try {
                const throwingEntry: WebviewFixtureRecorderEntry = {
                    contextId: "commit-info",
                    scenario: "clean",
                    record: async () => {
                        throw new Error("synthetic recorder failure for disposal test");
                    },
                };

                await expect(
                    runWebviewFixtureGate({
                        repoRoot: scratchRepoRoot,
                        registry: [throwingEntry],
                        update: true,
                        prepareScenario,
                    }),
                ).rejects.toThrow("synthetic recorder failure for disposal test");

                expect(preparations).toHaveLength(1);
                expect(existsSync(preparations[0].destination)).toBe(false);
                expect(existsSync(preparations[0].home)).toBe(false);
            } finally {
                await removeScratchDirectories(scratchRepoRoot);
            }
        });

        it("an entry whose scenario has no template fails loudly, naming context and scenario", async () => {
            const scratchRepoRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-webview-gate-no-template-"),
            );
            const { prepareScenario, preparations } = instrumentedPrepareScenario();
            try {
                // The REAL production `record` function, mislabeled to a scenario
                // (`ScenarioWorkspace.template` is `undefined`, exactly like the real `empty-repo`)
                // it was never written to handle -- proving the guard lives in the entry itself, not
                // in this test's own double.
                const [commitInfoEntry] = WEBVIEW_FIXTURE_RECORDERS;
                const registry: WebviewFixtureRecorderEntry[] = [
                    { ...commitInfoEntry, scenario: "empty-repo" },
                ];

                await expect(
                    runWebviewFixtureGate({
                        repoRoot: scratchRepoRoot,
                        registry,
                        update: true,
                        prepareScenario,
                    }),
                ).rejects.toThrow(/commit-info\/empty-repo/);

                // The guard fires before the entry ever reaches real recording, but the workspace
                // was still prepared (the gate cannot know an entry lacks a template until the entry
                // says so) and must still be disposed despite the throw.
                expect(preparations).toHaveLength(1);
                expect(existsSync(preparations[0].destination)).toBe(false);
                expect(existsSync(preparations[0].home)).toBe(false);
            } finally {
                await removeScratchDirectories(scratchRepoRoot);
            }
        });
    });

    describe("prepareIntoScratchDestination", () => {
        it("removes the scratch destination it allocated when prepare rejects", async () => {
            // The leak this covers is invisible to the gate's own tests: `runWebviewFixtureGate`'s
            // `prepareScenario` option replaces this allocation entirely, so an injected rejecting
            // scenario would exercise the TEST's mkdtemp, not the production one. Called directly,
            // the allocated path is observable and its removal is assertable.
            let allocated: string | undefined;
            const failure = new Error("scenario builder blew up halfway through seeding");

            await expect(
                prepareIntoScratchDestination("clean", async (destination) => {
                    allocated = destination;
                    expect(existsSync(destination)).toBe(true);
                    throw failure;
                }),
            ).rejects.toBe(failure);

            expect(allocated).toBeDefined();
            expect(existsSync(allocated as string)).toBe(false);
        });

        it("keeps the destination it allocated when prepare resolves", async () => {
            // The other half of the contract: cleanup must be scoped to the FAILURE path. A
            // version that removed the directory unconditionally would pass the test above while
            // deleting every successfully prepared workspace out from under its own recording.
            const workspace = await prepareIntoScratchDestination("clean", async (destination) => {
                const root = path.join(destination, "workspace");
                await mkdir(root, { recursive: true });
                return { id: "clean", root, env: process.env, home: root, template: undefined };
            });
            try {
                expect(existsSync(workspace.root)).toBe(true);
                expect(existsSync(path.dirname(workspace.root))).toBe(true);
            } finally {
                await removeScratchDirectories(path.dirname(workspace.root));
            }
        });
    });

    describe("assertDisposableScenarioPath", () => {
        // Exercised directly rather than through `disposeScenarioWorkspace`, deliberately. The
        // gate derives a workspace's destination as `path.dirname(workspace.root)`, which is only
        // ever right because every scenario builder places its root at `<destination>/workspace`.
        // Driving the real disposal with a root that breaks that convention would, on the RED run
        // where the guard does not yet exist, recursively delete the OS temp root for real -- so
        // the decision is checked where checking it is free of consequence.

        it("refuses the OS temp root -- what path.dirname() yields if a root sits at its destination", () => {
            expect(() => assertDisposableScenarioPath(tmpdir(), "clean", "destination")).toThrow(
                /refusing to recursively remove/,
            );
            // The scenario is named so a failure points at the builder that broke the convention,
            // not just at the gate that caught it.
            expect(() => assertDisposableScenarioPath(tmpdir(), "clean", "destination")).toThrow(
                /clean/,
            );
        });

        it("refuses a filesystem root", () => {
            expect(() =>
                assertDisposableScenarioPath(path.parse(tmpdir()).root, "dirty", "destination"),
            ).toThrow(/refusing to recursively remove/);
        });

        // The case the "is it the temp root or a filesystem root?" denylist waved through, and the
        // reason this guard is containment-based. `runWebviewFixtureGate`'s `prepareScenario` is
        // injectable, so `workspace.root` is whatever a scenario returns; a scenario rooted inside
        // the repository yields a `path.dirname` of a TRACKED directory, which is neither the temp
        // root nor a filesystem root. Under the old check this passed and the recursive `rm` then
        // deleted the working tree. Asserted for both roles, because `home` is not derived at all
        // -- it arrives verbatim from `prepare()` and previously had no guard whatsoever.
        it.each(["destination", "home"] as const)(
            "refuses a repository path that is neither the temp root nor a filesystem root (%s)",
            (role) => {
                const insideRepo = path.resolve(__dirname, "..", "..", "..", "workspace");
                expect(() => assertDisposableScenarioPath(insideRepo, "clean", role)).toThrow(
                    /strictly beneath the OS temp root/,
                );
                expect(() => assertDisposableScenarioPath(insideRepo, "clean", role)).toThrow(
                    new RegExp(role),
                );
            },
        );

        // Containment is not satisfied by a shared prefix: a sibling whose NAME merely begins with
        // the temp root's is outside it. Without the path-segment semantics `path.relative` gives,
        // a `startsWith` check would accept this.
        it("refuses a sibling whose name merely shares the temp root's prefix", () => {
            expect(() =>
                assertDisposableScenarioPath(`${tmpdir()}-evil/workspace`, "clean", "destination"),
            ).toThrow(/strictly beneath the OS temp root/);
        });

        // `..` cannot be used to climb out of the temp root and back into tracked files, even
        // though the string starts inside it.
        it("refuses a path that escapes the temp root through ..", () => {
            expect(() =>
                assertDisposableScenarioPath(
                    path.join(tmpdir(), "..", "..", "etc"),
                    "clean",
                    "destination",
                ),
            ).toThrow(/strictly beneath the OS temp root/);
        });

        it.each(["destination", "home"] as const)(
            "allows a real mkdtemp path -- the guard must not reject the normal case (%s)",
            async (role) => {
                // Built exactly the way the gate and `createSanitizedGitEnv` build theirs, so this
                // covers the macOS `/var` -> `/private/var` symlink duality that a naive
                // containment check against a single spelling of `tmpdir()` would fail on.
                const allocated = await mkdtemp(
                    path.join(tmpdir(), "intelligit-webview-gate-guard-"),
                );
                try {
                    expect(() =>
                        assertDisposableScenarioPath(allocated, "clean", role),
                    ).not.toThrow();
                    // And its realpath: whichever spelling `tmpdir()` reports, the other one is what
                    // a path that round-tripped through the filesystem comes back as.
                    expect(() =>
                        assertDisposableScenarioPath(realpathSync(allocated), "clean", role),
                    ).not.toThrow();
                } finally {
                    await removeScratchDirectories(allocated);
                }
            },
        );
    });
});
