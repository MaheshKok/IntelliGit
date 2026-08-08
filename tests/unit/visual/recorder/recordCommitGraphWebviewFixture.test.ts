/**
 * Spec-derived tests for `tests/visual/recorder/recordCommitGraphWebviewFixture.ts` -- Phase
 * 2c-iv-b's pair of recorders for the `commit-graph-card` and `commit-graph-compact` resolved
 * host contexts. Both are the SAME `CommitGraphViewProvider` class (`src/views/
 * CommitGraphViewProvider.ts`) constructed with a different `scriptFile`/`title`/
 * `showRepositoryLabel` (see `src/activation/repositoryMode.ts:284` and `:290`), so a single
 * parameterized test body (`describeRecorder`) runs the same five spec-required assertions
 * against each -- duplicating five `it` blocks per variant would just be the same failure modes
 * written twice.
 *
 * Every test here is written to be able to fail for a REAL reason, mirroring
 * `recordCommitInfoWebviewFixture.test.ts`:
 *  - "parses" fails if a recorder ever emits a shape `parseWebviewFixture` rejects.
 *  - "byte-identical across two independent roots" fails if canonicalization misses a source of
 *    nondeterminism -- built from TWO separately seeded workspaces (`workspaceA`, `workspaceB`),
 *    never the same root recorded twice.
 *  - "non-trivial" fails if a recorder captures zero messages, or the captured `loadCommits`
 *    payload doesn't carry real git hashes -- proof the REAL `GitOps.getLog` /
 *    `GitOps.getUnpushedCommitHashes` calls produced this, not a hand-fabricated stand-in. (The
 *    `setBranches` payload's `branches` array is legitimately empty on this recorder's minimal
 *    seam -- see the test body's own comment.)
 *  - "no leaked identity" fails if a future change threads an absolute path into a posted message
 *    that canonicalization does not know to rewrite.
 *  - "gate honored" fails if a recorder ever succeeds -- silently producing an empty or partial
 *    fixture -- while the E2E control channel gate it depends on is inactive.
 *
 * Plus one registry test: the exact SET of registered context ids after this phase, not a count,
 * so a duplicate or a missing entry fails even if the total happens to match.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts`'s own
// comment on this exact convention. Reused unchanged: `createCommitInfoVscodeDouble()` already
// implements every `vscode` module member `CommitGraphViewProvider`'s happy path (`ready`, then
// history loads) reaches -- see `recordCommitGraphWebviewFixture.ts`'s own doc comment for the
// full accounting of why nothing more was needed.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import { seedFixtureTemplate, type FixtureTemplate } from "../../../fixtures/repo/seed";
import {
    buildProviderOptions,
    COMMIT_GRAPH_CLEAN_SCENARIO,
    recordCommitGraphCardWebviewFixture,
    recordCommitGraphCompactWebviewFixture,
} from "../../../visual/recorder/recordCommitGraphWebviewFixture";
import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import type { WebviewFixture } from "../../../visual/recorder/webviewFixtureTypes";

/** A real git commit hash (short or full, hex) -- what `GitOps.getLog` returns, never a
 * fabricated stand-in. Used to prove a `loadCommits` payload came from a real git service. */
const GIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * The first real git hash in a recording's `loadCommits` payload. Used as a substitution needle by
 * the canonicalization-wiring test below; throws rather than returning a sentinel, because a
 * recording with no such hash means that test's premise is gone and it must fail loudly instead of
 * silently asserting nothing.
 */
function firstCommitHash(fixture: WebviewFixture): string {
    for (const captured of fixture.messages) {
        const message = captured.message as {
            type?: unknown;
            commits?: ReadonlyArray<{ hash?: unknown }>;
        };
        if (message?.type !== "loadCommits") continue;
        const hash = message.commits?.[0]?.hash;
        if (typeof hash === "string" && GIT_HASH_PATTERN.test(hash)) return hash;
    }
    throw new Error(
        "firstCommitHash: the recording carries no loadCommits commit hash, so the " +
            "canonicalization-wiring test has no needle to substitute. Fix the premise, do not " +
            "relax the assertion.",
    );
}

describe("commit-graph webview recorders", () => {
    let parentDir: string;
    let workspaceA: FixtureTemplate;
    let workspaceB: FixtureTemplate;

    beforeAll(async () => {
        parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-webview-recorder-commit-graph-test-"),
        );
        // Two INDEPENDENT seeded destinations, not the same root recorded twice -- see this
        // module's own doc comment on the byte-identical test.
        [workspaceA, workspaceB] = await Promise.all([
            seedFixtureTemplate(path.join(parentDir, "root-a")),
            seedFixtureTemplate(path.join(parentDir, "root-b")),
        ]);
    }, 60_000);

    afterAll(async () => {
        await Promise.all([
            rm(workspaceA.home, { recursive: true, force: true }),
            rm(workspaceB.home, { recursive: true, force: true }),
            rm(parentDir, { recursive: true, force: true }),
        ]);
    });

    beforeEach(() => {
        setE2eControlChannelActive(true);
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetE2eWebviewCaptureSinkForTests();
    });

    function optionsFor(workspace: FixtureTemplate) {
        return {
            repoRoot: workspace.root,
            roots: { root: workspace.root, originRoot: workspace.originRoot, profileDir: "" },
        };
    }
    type RecordOptions = ReturnType<typeof optionsFor>;

    /**
     * Runs the five spec-required assertions (SPEC-phase2c-iv-b.md's "Tests" section) against one
     * recorder function. `recordCommitGraphCardWebviewFixture` and
     * `recordCommitGraphCompactWebviewFixture` construct the identical provider class, so the ways
     * either can fail are identical -- this body is written once and invoked for both variants
     * below, rather than five near-duplicate `it` blocks per variant.
     */
    function describeRecorder(
        label: string,
        contextId: "commit-graph-card" | "commit-graph-compact",
        record: (options: RecordOptions) => Promise<WebviewFixture>,
    ): void {
        describe(label, () => {
            it("records a real end-to-end fixture that parseWebviewFixture accepts", async () => {
                const fixture = await record(optionsFor(workspaceA));

                const bytes = serializeWebviewFixture(fixture);
                const reparsed = parseWebviewFixture(JSON.parse(bytes));

                expect(reparsed.schemaVersion).toBe(fixture.schemaVersion);
                expect(reparsed.contextId).toBe(contextId);
                expect(reparsed.scenario).toBe(COMMIT_GRAPH_CLEAN_SCENARIO);
                expect(reparsed).toEqual(fixture);
            });

            it("produces byte-identical fixtures from two independently seeded temp roots", async () => {
                // Sequential, not Promise.all: both recordings share the process-wide capture
                // sink (`captureWebviewViewProvider` always allocates through it), so running
                // them concurrently would interleave their messages.
                const fixtureA = await record(optionsFor(workspaceA));
                const fixtureB = await record(optionsFor(workspaceB));

                expect(serializeWebviewFixture(fixtureA)).toBe(serializeWebviewFixture(fixtureB));
            });

            /**
             * The byte-identical test above cannot prove this recorder's canonicalization pass is
             * wired up at all: the `clean` commit-graph payload legitimately contains no absolute
             * path and no volatile value, so two independently seeded workspaces serialize
             * identically whether `canonicalizeCapturedMessages` runs or not -- deleting the call
             * leaves the whole suite green. It passes because there is nothing to canonicalize,
             * not because canonicalization works.
             *
             * This closes that by putting the needle INTO the payload: it lifts a real commit hash
             * out of a first recording and declares that string as `roots.root` for a second one.
             * The hash stands in for "any concrete string the caller declares as a root" -- what
             * is under test here is not the canonicalizer (`canonicalizeCapturedMessages.test.ts`
             * owns that) but this recorder's threading of the CALLER's roots into it, which
             * nothing else exercises. A future context whose payload does carry a path inherits a
             * proven-live substitution instead of an assumed one.
             */
            it("applies the caller's declared roots to the captured payload", async () => {
                const baseline = await record(optionsFor(workspaceA));
                const needle = firstCommitHash(baseline);

                const base = optionsFor(workspaceA);
                const fixture = await record({
                    ...base,
                    roots: { ...base.roots, root: needle },
                });
                const bytes = serializeWebviewFixture(fixture);

                expect(bytes).toContain("<ROOT>");
                expect(bytes).not.toContain(needle);
            });

            it("captures a non-trivial payload carrying recognizable production fields", async () => {
                const fixture = await record(optionsFor(workspaceA));

                expect(fixture.messages.length).toBeGreaterThan(0);

                // `setBranches` IS posted (real behavior: `sendBranches()` runs unconditionally in
                // the `ready` handler), but `branches` itself is legitimately empty here: `this.
                // branches` is only ever populated by the provider's own public `setBranches()`
                // method, called by host-wiring code this recorder deliberately does not drive
                // (out of this phase's scope -- see `recordCommitGraphWebviewFixture.ts`'s own doc
                // comment). Asserted as a real, empty array -- not asserted non-empty, which would
                // be testing a call this recorder never makes.
                const branchMessages = fixture.messages.filter(
                    (captured) =>
                        typeof captured.message === "object" &&
                        captured.message !== null &&
                        (captured.message as { type?: unknown }).type === "setBranches",
                );
                expect(branchMessages.length).toBeGreaterThan(0);
                const branches = (branchMessages[0].message as { branches: unknown[] }).branches;
                expect(Array.isArray(branches)).toBe(true);
                expect(branches).toEqual([]);

                const commitMessages = fixture.messages.filter(
                    (captured) =>
                        typeof captured.message === "object" &&
                        captured.message !== null &&
                        (captured.message as { type?: unknown }).type === "loadCommits",
                );
                expect(commitMessages.length).toBeGreaterThan(0);
                const commits = (commitMessages[0].message as { commits: Array<{ hash: string }> })
                    .commits;
                expect(commits.length).toBeGreaterThan(0);
                expect(commits.every((commit) => GIT_HASH_PATTERN.test(commit.hash))).toBe(true);
            });

            it("never leaks the temp root, real HOME, or /Users/ into the serialized bytes", async () => {
                const fixture = await record(optionsFor(workspaceA));
                const bytes = serializeWebviewFixture(fixture);

                expect(bytes).not.toContain(workspaceA.root);
                expect(bytes).not.toContain(workspaceA.home);
                expect(bytes).not.toContain("/Users/");
                if (process.env.HOME) {
                    expect(bytes).not.toContain(process.env.HOME);
                }
            });

            it("fails loudly instead of silently recording nothing when the E2E gate is inactive", async () => {
                setE2eControlChannelActive(false);

                await expect(record(optionsFor(workspaceA))).rejects.toThrow(
                    /E2E control channel/i,
                );
            });
        });
    }

    describeRecorder(
        "recordCommitGraphCardWebviewFixture",
        "commit-graph-card",
        recordCommitGraphCardWebviewFixture,
    );
    describeRecorder(
        "recordCommitGraphCompactWebviewFixture",
        "commit-graph-compact",
        recordCommitGraphCompactWebviewFixture,
    );

    /**
     * The commit-checks trap is this phase's loudest safety requirement and is invisible to every
     * end-to-end assertion above: `CommitGraphViewProvider`'s constructor defaults
     * `commitChecksProviders` to four REAL HTTP-backed providers, but those providers are only
     * CONSTRUCTED -- they stay dormant until a `requestVisibleCommitChecks` message this scenario
     * never sends. So deleting `commitChecksProviders: []` from the recorder changes no recorded
     * byte today, and the invariant would rest on a comment. These assertions are the only thing
     * that goes red when the line disappears.
     */
    describe("buildProviderOptions", () => {
        it("keeps the commit-checks coordinator inert for both variants", () => {
            for (const variant of ["card", "compact"] as const) {
                const options = buildProviderOptions(variant);

                // Deliberately `toEqual([])`, not a truthiness or length check: an absent
                // `commitChecksProviders` is `undefined`, which is exactly the deletion this
                // asserts against, and `undefined` must not read as "no providers".
                expect(options.commitChecksProviders).toEqual([]);
                expect(options.settings).toBeUndefined();
                expect(options.commitChecksService).toBeUndefined();
                expect(options.hostMap).toEqual({});
            }
        });

        it("mirrors each real construction site's variant-specific options", () => {
            // `repositoryMode.ts:284` passes no `scriptFile`, so the provider's own
            // CARD_SCRIPT_FILE default ("webview-commitgraph.js") applies -- recording an explicit
            // value here would stop testing the default the card context actually resolves.
            const card = buildProviderOptions("card");
            expect(card.scriptFile).toBeUndefined();
            expect(card.title).toBeUndefined();
            expect(card.showRepositoryLabel).toBeUndefined();

            // `repositoryMode.ts:290`. None of these three reach a posted message -- `scriptFile`
            // and `title` reach only `getHtml()`, `showRepositoryLabel` only `view.description` --
            // so the recorded payloads cannot distinguish the variants, and this is the only place
            // the compact registration's options are pinned.
            const compact = buildProviderOptions("compact");
            expect(compact.scriptFile).toBe("webview-compactcommitgraph.js");
            expect(compact.title).toBe("Graph");
            expect(compact.showRepositoryLabel).toBe(false);
        });
    });

    // The "registers exactly the contexts claimed through this phase" registry assertion that
    // used to live here has moved to `recordCommitPanelWebviewFixture.test.ts` (Phase 2c-iv-c),
    // updated for the current full set. It migrates forward to the newest phase's test file each
    // time a context is registered, rather than being duplicated and left stale in every earlier
    // phase's file -- see that test's own doc comment.
});
