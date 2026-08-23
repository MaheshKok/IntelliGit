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
 *
 * Phase 2c-iv-a adds four tests for the scenario-aware rework (`workspace` is gone; the gate now
 * prepares what each entry's typed `scenario` declares):
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
 * These four deliberately avoid real `git` scenario builds (`scenarios.test.ts` already proves
 * those) -- an instrumented `prepareScenario` hands back real scratch directories without paying
 * for a full seeded history, so disposal is still checked against something real on disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` for
// why this must be a plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import type { RepositoryScenarioId, ScenarioWorkspace } from "../../../fixtures/repo/scenarios";
import { COMMIT_INFO_CLEAN_SCENARIO } from "../../../visual/recorder/recordCommitInfoWebviewFixture";
import {
    assertDisposableScenarioPath,
    prepareIntoScratchDestination,
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

/** A real scenario build (`seedFixtureTemplate` plus, for most scenarios, a handful more `git`
 * calls) takes long enough that vitest's default 5s-per-test timeout is not generous enough --
 * this mirrors the 60s the old shared `beforeAll` used for exactly one such build. Every test below
 * that lets the gate prepare a REAL "clean" scenario (i.e. does not inject its own
 * `prepareScenario`) passes this as its own timeout.
 *
 * The 60s it used to be was inherited from that `beforeAll` and never measured against the slowest
 * supported platform. Windows runs this work 2-5x slower -- many small `git` calls over many small
 * files -- and `rewrites a drifted fixture` needed 53,835ms of the 60,000 there on run
 * 32654169455, then 60,012ms on the next one, where it timed out (#223). A 10% margin on the
 * slowest leg is a red waiting for an ordinary bad minute, not a budget. What a timeout is for
 * here is catching a HANG, and 180s still does that against a file whose Windows leg totals ~220s
 * either way. */
const REAL_SCENARIO_TIMEOUT_MS = 180_000;

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
 * this and fail for the wrong reason. `scenario` must be a real `RepositoryScenarioId` that has no
 * committed `commit-info` fixture on disk (only "clean.json" is committed -- see the `ls` this
 * phase's own report cites), so the "missing" branch is genuinely exercised rather than
 * short-circuited by a file that happens to already be there. */
function throwingRegistryEntry(scenario: RepositoryScenarioId): WebviewFixtureRecorderEntry {
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

/** A registry entry that never touches real `git`, `vscode`, or `workspace.template` -- its
 * `record` returns a trivial, empty-message fixture keyed on `scenario` alone. Used by the
 * scenario-preparation tests below, which are about the GATE's prepare-once/dispose-always
 * contract, not about what any one recorder actually captures (`recordCommitInfoWebviewFixture`
 * already covers that, and `scenarios.test.ts` covers what a real scenario looks like). */
function fakeEntry(scenario: RepositoryScenarioId): WebviewFixtureRecorderEntry {
    return {
        contextId: "commit-info",
        scenario,
        record: async () => buildWebviewFixture("commit-info", scenario, []),
    };
}

/** One call an instrumented `prepareScenario` made: real scratch directories (so a disposal
 * assertion has something real to `existsSync` against) without paying for an actual `git` history
 * build. */
interface FakeScenarioPreparation {
    readonly id: RepositoryScenarioId;
    readonly destination: string;
    readonly home: string;
}

/**
 * Builds a `prepareScenario` that records every call it receives and, for each one, creates real
 * scratch directories shaped exactly like a real `ScenarioWorkspace` -- `root` at
 * `<destination>/workspace`, `home` a SEPARATE scratch directory, matching what `scenarios.ts`'s
 * own builders produce (see `webviewFixtureGate.ts`'s `disposeScenarioWorkspace` doc comment for
 * why `home` is deliberately not nested under `destination`). `template` is always `undefined`:
 * nothing here needs seeded history, and the one test that DOES care about an absent template
 * relies on exactly this.
 */
function instrumentedPrepareScenario(): {
    readonly prepareScenario: (id: RepositoryScenarioId) => Promise<ScenarioWorkspace>;
    readonly calls: RepositoryScenarioId[];
    readonly preparations: FakeScenarioPreparation[];
} {
    const calls: RepositoryScenarioId[] = [];
    const preparations: FakeScenarioPreparation[] = [];
    const prepareScenario = async (id: RepositoryScenarioId): Promise<ScenarioWorkspace> => {
        calls.push(id);
        const destination = await mkdtemp(
            path.join(tmpdir(), `intelligit-webview-gate-fake-${id}-`),
        );
        const root = path.join(destination, "workspace");
        await mkdir(root, { recursive: true });
        const home = await mkdtemp(path.join(tmpdir(), `intelligit-webview-gate-fake-home-${id}-`));
        preparations.push({ id, destination, home });
        return { id, root, env: process.env, home, template: undefined };
    };
    return { prepareScenario, calls, preparations };
}

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
                await rm(scratchRepoRoot, { recursive: true, force: true });
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

    /**
     * The gate's `missing` finding tells a developer to rerun with `UPDATE_WEBVIEW_FIXTURES=1`.
     * These tests exist so that instruction stays true: Phase 2c-i's regeneration path lived in a
     * byte-comparison test that 2c-ii deleted as redundant, which left the env var named in an
     * error message that nothing in the repository read any more. A dead recovery path is worse
     * than none -- it pushes the next developer toward hand-writing fixture bytes, which is
     * exactly how the decorative, never-regenerable fixture 2c-i had to replace came to exist.
     */
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
                    await rm(scratchRepoRoot, { recursive: true, force: true });
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
                    await rm(scratchRepoRoot, { recursive: true, force: true });
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
                    await rm(scratchRepoRoot, { recursive: true, force: true });
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
                    await rm(scratchRepoRoot, { recursive: true, force: true });
                }
            },
            REAL_SCENARIO_TIMEOUT_MS,
        );
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
                await rm(scratchRepoRoot, { recursive: true, force: true });
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
                await rm(scratchRepoRoot, { recursive: true, force: true });
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
                await rm(scratchRepoRoot, { recursive: true, force: true });
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
                await rm(scratchRepoRoot, { recursive: true, force: true });
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
                await rm(path.dirname(workspace.root), { recursive: true, force: true });
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
                    await rm(allocated, { recursive: true, force: true });
                }
            },
        );
    });
});
