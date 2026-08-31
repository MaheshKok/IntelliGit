/**
 * Spec-derived tests for `tests/visual/recorder/recordCommitPanelWebviewFixture.ts` -- Phase
 * 2c-iv-c's recorder for the `commit-panel` resolved host context, scenario `dirty` (see
 * SPEC-phase2c-iv-c.md's own "Scope" section for why `dirty`, not `clean`: this view renders
 * working-tree state).
 *
 * Every test here is written to be able to fail for a REAL reason:
 *  - "parses" fails if the recorder ever emits a shape `parseWebviewFixture` rejects.
 *  - "byte-identical across two independently prepared dirty workspaces" fails if canonicalization
 *    misses a source of nondeterminism -- built from TWO separately seeded-and-asserted `dirty`
 *    workspaces (`workspaceA`, `workspaceB`), never the same root recorded twice.
 *  - "non-trivial" fails if the recorder captures zero messages, or if the seeded `dirty`
 *    working-tree changes (the untracked file `seedFixtureTemplate` always leaves behind) are not
 *    actually reflected in what got posted.
 *  - "no leaked identity" fails if a future change threads an absolute path into a posted message
 *    that canonicalization does not know to rewrite.
 *  - "gate honored" fails if the recorder ever succeeds -- silently producing an empty or partial
 *    fixture -- while the E2E control channel gate it depends on is inactive.
 *  - `createEmptyWorkspaceMemento` fails if the recorder's workspace store ever hands back host
 *    state -- a persisted commit draft would flow straight into the payload, and no end-to-end
 *    assertion here would notice.
 *  - `buildCommitPanelConstructorOptions` fails if any of the four constructor arguments this
 *    recording's `dirty`/`ready` path can never distinguish end-to-end regresses to an unsafe
 *    value -- the pure-function-extraction pattern `buildProviderOptions`
 *    (`recordCommitGraphWebviewFixture.ts`, Phase 2c-iv-b) established for exactly this failure
 *    mode.
 *
 * The "registers exactly the contexts claimed through this phase" registry-set assertion that used
 * to live here has moved on to `recordMergeConflictSessionWebviewFixture.test.ts` (Phase 2c-v-a) --
 * see the note at its removal site, below, for the migrating-forward convention.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts`'s own
// comment on this exact convention (`recordCommitGraphWebviewFixture.test.ts` repeats it). Reused
// completely unchanged: `commit-panel` forced no new `vscode` member, including the filesystem
// watcher it was expected to -- see `commitInfoVscodeDouble.ts`'s own doc comment for why.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import { GitExecutor } from "../../../../src/git/executor";
import { assertDirtyPostcondition } from "../../../fixtures/repo/scenarios";
import { seedFixtureTemplate, type FixtureTemplate } from "../../../fixtures/repo/seed";
import {
    buildCommitPanelConstructorOptions,
    COMMIT_PANEL_DIRTY_SCENARIO,
    createEmptyWorkspaceMemento,
    recordCommitPanelWebviewFixture,
} from "../../../visual/recorder/recordCommitPanelWebviewFixture";
import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import { createScratchWorkspaces } from "../../fixtures/scratchWorkspaces";
import { withWindowsHeadroom } from "../../../setup/platformTimeouts";

// Scratch-path bookkeeping and the settle-before-propagating seed live in one shared helper -- see
// `scratchWorkspaces.ts` for the two directory leaks the obvious shapes here both cause. This one
// lives at module scope so `prepareDirtyWorkspace` can register a scratch `HOME` between seeding it
// and asserting the postcondition: a FAILED postcondition is the likeliest rejection here, and by
// then the `HOME` very much exists. `seedPair` registering the same home again on success is the
// duplicate registration `removeAll` collapses.
const scratch = createScratchWorkspaces();

/**
 * Builds one independently prepared `dirty` scenario workspace. Mirrors `scenarios.ts`'s own
 * `prepareDirty` exactly (`seedFixtureTemplate` already builds the `dirty` state; this only
 * confirms the postcondition holds for THIS destination) rather than importing the `dirty` entry
 * out of `REPOSITORY_SCENARIOS` -- both `assertDirtyPostcondition` and `seedFixtureTemplate` are
 * already the real exported primitives `prepareDirty` is built from, so re-deriving its two-line
 * body here needs no additional surface this test's read budget did not already cover.
 */
async function prepareDirtyWorkspace(destination: string): Promise<FixtureTemplate> {
    const template = await seedFixtureTemplate(destination);
    scratch.register(template.home);
    await assertDirtyPostcondition(template.root, template.env);
    return template;
}

describe("commit-panel webview recorder", () => {
    let parentDir: string;
    let workspaceA: FixtureTemplate;
    let workspaceB: FixtureTemplate;

    beforeAll(async () => {
        parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-webview-recorder-commit-panel-test-"),
        );
        scratch.register(parentDir);
        // Two INDEPENDENT seeded-and-asserted destinations, not the same root recorded twice --
        // see this module's own doc comment on the byte-identical test.
        [workspaceA, workspaceB] = await scratch.seedPair(
            () => prepareDirtyWorkspace(path.join(parentDir, "root-a")),
            () => prepareDirtyWorkspace(path.join(parentDir, "root-b")),
        );
    }, withWindowsHeadroom(60_000));

    afterAll(async () => {
        await scratch.removeAll();
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
            env: workspace.env,
        };
    }

    it("records a real end-to-end fixture that parseWebviewFixture accepts", async () => {
        const fixture = await recordCommitPanelWebviewFixture(optionsFor(workspaceA));

        const bytes = serializeWebviewFixture(fixture);
        const reparsed = parseWebviewFixture(JSON.parse(bytes));

        expect(reparsed.schemaVersion).toBe(fixture.schemaVersion);
        expect(reparsed.contextId).toBe("commit-panel");
        expect(reparsed.scenario).toBe(COMMIT_PANEL_DIRTY_SCENARIO);
        expect(reparsed).toEqual(fixture);
    });

    it("produces byte-identical fixtures from two independently prepared dirty workspaces", async () => {
        // Sequential, not Promise.all: both recordings share the process-wide capture sink
        // (`captureWebviewViewProvider` always allocates through it), so running them concurrently
        // would interleave their messages.
        const fixtureA = await recordCommitPanelWebviewFixture(optionsFor(workspaceA));
        const fixtureB = await recordCommitPanelWebviewFixture(optionsFor(workspaceB));

        expect(serializeWebviewFixture(fixtureA)).toBe(serializeWebviewFixture(fixtureB));
    });

    it("captures a non-trivial payload carrying the seeded dirty working-tree changes", async () => {
        const fixture = await recordCommitPanelWebviewFixture(optionsFor(workspaceA));

        expect(fixture.messages.length).toBeGreaterThan(0);

        // The `dirty` scenario is `seedFixtureTemplate`'s state exactly as built: at least one
        // modified tracked path AND at least one untracked path (`assertDirtyPostcondition`, this
        // file's own `prepareDirtyWorkspace`). If the recorded payload carries none of that, either
        // `ready`'s working-tree refresh never ran, or the provider was constructed against the
        // wrong root -- both are recorder bugs this assertion exists to catch.
        const messageTypes = fixture.messages.map((captured) =>
            typeof captured.message === "object" && captured.message !== null
                ? (captured.message as { type?: unknown }).type
                : undefined,
        );
        const changedFiles = fixture.messages.flatMap((captured) => {
            if (typeof captured.message !== "object" || captured.message === null) return [];
            const message = captured.message as {
                files?: ReadonlyArray<{ path?: unknown; staged?: unknown; status?: unknown }>;
            };
            return Array.isArray(message.files) ? message.files : [];
        });

        expect(changedFiles.length).toBeGreaterThan(0);
        expect(
            changedFiles.every((file) => typeof file.path === "string" && file.path.length > 0),
        ).toBe(true);
        // None of the file paths in a working-tree snapshot may be absolute -- production always
        // posts repo-relative paths, and this doubles as an early, specific version of the
        // no-leaked-identity test below.
        expect(changedFiles.every((file) => !path.isAbsolute(file.path as string))).toBe(true);
        // Ties the assertion to `assertDirtyPostcondition`'s own definition of `dirty` (`scenarios.ts:140`):
        // at least one STAGED path AND at least one UNTRACKED ("?") path. A recorder that captured
        // some unrelated non-empty `files` array (or the SAME state `clean` would also produce)
        // would pass the two assertions above but fail these -- this is what makes the payload
        // provably tied to `dirty`, not just "non-empty".
        expect(changedFiles.some((file) => file.staged === true)).toBe(true);
        expect(changedFiles.some((file) => file.status === "?")).toBe(true);
        // Sanity: the message-type list itself must be non-empty and every entry must be a string
        // (i.e. every captured message really is a typed protocol message, not a malformed capture).
        expect(messageTypes.length).toBeGreaterThan(0);
        expect(messageTypes.every((type) => typeof type === "string")).toBe(true);
    });

    it("never leaks the temp root, real HOME, or /Users/ into the serialized bytes", async () => {
        const fixture = await recordCommitPanelWebviewFixture(optionsFor(workspaceA));
        const bytes = serializeWebviewFixture(fixture);

        expect(bytes).not.toContain(workspaceA.root);
        expect(bytes).not.toContain(workspaceA.home);
        expect(bytes).not.toContain("/Users/");
        if (process.env.HOME) {
            expect(bytes).not.toContain(process.env.HOME);
        }
    });

    // The env-determinism regression. `GitExecutor.runBinary` spawns with `{ ...process.env, ... }`,
    // so before this recorder threaded the scenario's own sanitized environment through the
    // executor, every recording read the DEVELOPER's `~/.gitconfig`. That is not theoretical for
    // this fixture: `commit-panel/dirty.json` carries `{"path": "topic-renamed.txt", "sourcePath":
    // "topic.txt", "status": "R"}`, and a global `diff.renames = false` splits that one rename into
    // an add plus a delete -- `changedFileCount` goes 5 -> 6 and the committed bytes stop matching
    // for that developer alone, on a machine where nothing in the repo changed.
    //
    // The control assertion is what makes this test unable to pass vacuously: it proves, in the same
    // hostile environment, that an executor which DOES inherit the ambient environment really sees
    // `diff.renames=false`. Without it, a future change that made the hostile config unreachable for
    // some unrelated reason would leave this test green while proving nothing.
    it("ignores a hostile ambient git config, so no developer's ~/.gitconfig can change the fixture", async () => {
        const baseline = serializeWebviewFixture(
            await recordCommitPanelWebviewFixture(optionsFor(workspaceA)),
        );

        const hostileConfig = path.join(parentDir, "hostile.gitconfig");
        await writeFile(hostileConfig, "[diff]\n\trenames = false\n", "utf8");
        const previous = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = hostileConfig;
        try {
            const ambient = new GitExecutor(workspaceA.root);
            expect((await ambient.run(["config", "--get", "diff.renames"])).trim()).toBe("false");

            const underHostileConfig = serializeWebviewFixture(
                await recordCommitPanelWebviewFixture(optionsFor(workspaceA)),
            );
            expect(underHostileConfig).toBe(baseline);
        } finally {
            if (previous === undefined) {
                delete process.env.GIT_CONFIG_GLOBAL;
            } else {
                process.env.GIT_CONFIG_GLOBAL = previous;
            }
        }
    });

    it("fails loudly instead of silently recording nothing when the E2E gate is inactive", async () => {
        setE2eControlChannelActive(false);

        await expect(recordCommitPanelWebviewFixture(optionsFor(workspaceA))).rejects.toThrow(
            /E2E control channel/i,
        );
    });

    /**
     * The recorder supplies an EMPTY `vscode.Memento`, and nothing end to end can tell that apart
     * from a populated one. A Memento carrying a persisted commit draft -- whatever a developer
     * left in their own last session -- pushes that host string straight into the recorded
     * payload: the leak test above only looks for paths, and the byte-identity test compares two
     * recordings that share the same store, so both stay green. Only the repo-wide fixture gate
     * catches it, and only once the host string is already committed.
     *
     * So the emptiness is asserted where it is decided, the same extraction
     * `buildCommitPanelConstructorOptions` (and `buildProviderOptions` before it) uses.
     */
    describe("createEmptyWorkspaceMemento", () => {
        it("returns nothing for any key, so no host state can reach a recording", () => {
            const memento = createEmptyWorkspaceMemento();

            expect(memento.keys()).toEqual([]);
            // The two keys `CommitPanelViewProvider` actually reads at cold start: the persisted
            // changed-file counts (`loadStoredChangedFileCounts`, `:426`) and the restored commit
            // draft (`getStoredCommitDraft`, reached from `handleReadyMessage`).
            expect(memento.get("intelligit.changedFileCounts")).toBeUndefined();
            expect(memento.get("intelligit.commitDraft")).toBeUndefined();
            // A supplied default must come back untouched rather than being shadowed by a stored
            // value -- the read shape production uses.
            expect(memento.get("intelligit.commitDraft", "fallback")).toBe("fallback");
        });
    });

    describe("buildCommitPanelConstructorOptions", () => {
        it("keeps every E2E-invisible constructor argument at its documented safe value", () => {
            // The `dirty`/`ready` path never sends a shelf-specific, AI-commit-message-generation,
            // or interactive-rebase message, so no end-to-end assertion above can tell any of these
            // four apart from a wrong value -- see `recordCommitPanelWebviewFixture.ts`'s own doc
            // comment on `buildCommitPanelConstructorOptions` for why this direct assertion is the
            // only oracle that goes red when one of them regresses.
            const options = buildCommitPanelConstructorOptions();

            expect(options.shelfServiceForRepository("/any/repository/root")).toBeUndefined();
            expect(options.shelfRemoveOnUnshelve).toBe(true);
            expect(options.commitMessageGenerationCoordinator).toBeUndefined();
            expect(options.interactiveRebaseStorageRoot).toBeUndefined();
        });
    });

    // The "registers exactly the contexts claimed through this phase" registry assertion that used
    // to live here has moved to `recordMergeConflictSessionWebviewFixture.test.ts` (Phase 2c-v-a),
    // updated for the current full set. It migrates forward to the newest phase's test file each
    // time a context is registered, rather than being duplicated and left stale in every earlier
    // phase's file -- see that test's own doc comment.
});
