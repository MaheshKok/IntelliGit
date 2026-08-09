/**
 * Spec-derived tests for `tests/visual/recorder/recordMergeConflictSessionWebviewFixture.ts` --
 * Phase 2c-v-a's recorder for the `merge-conflict-session` resolved host context
 * (`MergeConflictSessionPanel`, `src/views/MergeConflictSessionPanel.ts`), scenario `conflicted`.
 * Also covers the shared `vscode.WebviewPanel` double this recorder is the first consumer of
 * (`tests/visual/recorder/webviewPanelDouble.ts`) -- see the `webviewPanelDouble` describe block
 * below.
 *
 * `merge-conflict-session` is the first of the four remaining resolved host contexts recorded
 * against a `vscode.WebviewPanel` (`captureWebview`) rather than a `vscode.WebviewView`
 * (`captureWebviewViewProvider`) the way every context recorded through Phase 2c-iv was. That shape
 * difference is what makes THE SINGLETON ORACLE test below the point of this phase: unlike a
 * `WebviewViewProvider`, `MergeConflictSessionPanel` keeps a process-wide `currentPanel` singleton
 * that is cleared ONLY from an `onDidDispose` callback (`MergeConflictSessionPanel.ts:43,84-85`) --
 * see `webviewPanelDouble.ts`'s own doc comment for the full mechanism.
 *
 * Every test here is written to be able to fail for a REAL reason:
 *  - "parses" fails if the recorder ever emits a shape `parseWebviewFixture` rejects.
 *  - "byte-identical across two independently prepared conflicted workspaces" fails if
 *    canonicalization misses a source of nondeterminism -- built from TWO separately
 *    seeded-and-asserted `conflicted` workspaces (`workspaceA`, `workspaceB`), never the same root
 *    recorded twice.
 *  - "non-trivial" fails if the recorder captures zero messages, or if the recorded `files` are not
 *    actually unmerged conflict entries -- a `clean` repo could never pass this.
 *  - "no leaked identity" fails if a future change threads an absolute path into a posted message
 *    that canonicalization does not know to rewrite.
 *  - "gate honored" fails if the recorder ever succeeds -- silently producing an empty or partial
 *    fixture -- while the E2E control channel gate it depends on is inactive.
 *  - "clears the singleton after recording" (THE SINGLETON ORACLE) fails if `dispose()` stops
 *    firing `onDidDispose` listeners -- see that test's own comment for exactly which line's removal
 *    turns it red.
 *  - the `webviewPanelDouble` describe block fails if `dispose()` ever double-fires a listener,
 *    retroactively fires a listener registered after it already ran, or if the construction
 *    registry stops recording panels in order / stops emptying on reset.
 *  - `buildMergeConflictSessionLabels` fails if the source/target branch labels this recorder
 *    passes to `MergeConflictSessionPanel.open()` regress to a wrong value -- see that describe
 *    block's own comment for why no end-to-end assertion above can catch that on its own.
 *
 * Plus one registry test: the exact SET of registered context ids as of this phase, not a count.
 * This supersedes (and replaces) the equivalent assertion that used to live in
 * `recordCommitPanelWebviewFixture.test.ts` -- see that file's own note at the removal site, and
 * `recordCommitGraphWebviewFixture.test.ts`'s own note at ITS removal site, for the established
 * convention this migrates forward again.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- see `recordCommitInfoWebviewFixture.test.ts`'s own
// comment on this exact convention. `merge-conflict-session` is the first context that forces
// `window.createWebviewPanel` and `ViewColumn` onto this double -- see
// `commitInfoVscodeDouble.ts`'s own doc comment for exactly what Phase 2c-v-a added and why.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import { MergeConflictSessionPanel } from "../../../../src/views/MergeConflictSessionPanel";
import { REPOSITORY_SCENARIOS, type ScenarioWorkspace } from "../../../fixtures/repo/scenarios";
import { FIXTURE_REFS } from "../../../fixtures/repo/seed";
import {
    buildMergeConflictSessionLabels,
    MERGE_CONFLICT_SESSION_CONFLICTED_SCENARIO,
    recordMergeConflictSessionWebviewFixture,
} from "../../../visual/recorder/recordMergeConflictSessionWebviewFixture";
import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import type { WebviewFixture } from "../../../visual/recorder/webviewFixtureTypes";
import { WEBVIEW_FIXTURE_RECORDERS } from "../../../visual/recorder/webviewFixtureRegistry";
import {
    createFakeWebviewPanel,
    getCreatedWebviewPanels,
    resetCreatedWebviewPanelsForTests,
} from "../../../visual/recorder/webviewPanelDouble";

/** The real, exported `conflicted` `RepositoryScenario` -- reused directly rather than re-derived:
 * unlike `dirty` (the seeded template exactly as built, a two-line postcondition check),
 * `conflicted`'s real preparation is a `reset --hard` + `clean -fdx` + real conflicting `merge`
 * (`scenarios.ts`'s own `prepareConflicted`), none of which is exported on its own. Re-deriving it
 * here would duplicate non-trivial git-orchestration logic this test's own read budget did not
 * cover; `REPOSITORY_SCENARIOS` is the real, already-exported primitive it is built from --
 * `webviewFixtureGate.ts`'s own production `prepareRealScenario` reaches the same scenario the same
 * way. */
const CONFLICTED_SCENARIO = REPOSITORY_SCENARIOS.find((scenario) => scenario.id === "conflicted");
if (!CONFLICTED_SCENARIO) {
    throw new Error(
        'recordMergeConflictSessionWebviewFixture.test.ts: no "conflicted" scenario is registered ' +
            "in REPOSITORY_SCENARIOS.",
    );
}

/** Builds one independently prepared `conflicted` scenario workspace. */
async function prepareConflictedWorkspace(destination: string): Promise<ScenarioWorkspace> {
    return CONFLICTED_SCENARIO.prepare(destination);
}

/** `ScenarioWorkspace.template` is defined for every scenario except `empty-repo` -- `conflicted`
 * always carries one. Narrows it once so every call site below does not have to. */
function requireTemplate(workspace: ScenarioWorkspace) {
    if (!workspace.template) {
        throw new Error(
            `"${workspace.id}" scenario workspace unexpectedly has no seeded template.`,
        );
    }
    return workspace.template;
}

/**
 * The first conflicted path in a recorded fixture -- the needle the roots test declares as its
 * `root` so canonicalization has something real to rewrite. Throws rather than returning a default:
 * a fixture with no conflict entry means the recording itself regressed, and silently falling back
 * to some placeholder string would turn that into a passing test.
 */
function firstConflictPath(fixture: WebviewFixture): string {
    for (const captured of fixture.messages) {
        if (typeof captured.message !== "object" || captured.message === null) continue;
        const data = (captured.message as { data?: { files?: ReadonlyArray<{ path?: unknown }> } })
            .data;
        const first = data?.files?.[0]?.path;
        if (typeof first === "string" && first.length > 0) return first;
    }
    throw new Error(
        "firstConflictPath: the recorded fixture carries no setSessionData file path, so the " +
            "recording regressed before this test could use it as a canonicalization needle.",
    );
}

describe("merge-conflict-session webview recorder", () => {
    let parentDir: string;
    let workspaceA: ScenarioWorkspace;
    let workspaceB: ScenarioWorkspace;

    beforeAll(async () => {
        parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-webview-recorder-merge-conflict-session-test-"),
        );
        // Two INDEPENDENT seeded-and-asserted destinations, not the same root recorded twice --
        // see this module's own doc comment on the byte-identical test.
        [workspaceA, workspaceB] = await Promise.all([
            prepareConflictedWorkspace(path.join(parentDir, "root-a")),
            prepareConflictedWorkspace(path.join(parentDir, "root-b")),
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
        resetCreatedWebviewPanelsForTests();
    });

    function optionsFor(workspace: ScenarioWorkspace) {
        const template = requireTemplate(workspace);
        return {
            repoRoot: workspace.root,
            roots: { root: workspace.root, originRoot: template.originRoot, profileDir: "" },
            env: workspace.env,
        };
    }

    it("records a real end-to-end fixture that parseWebviewFixture accepts", async () => {
        const fixture = await recordMergeConflictSessionWebviewFixture(optionsFor(workspaceA));

        const bytes = serializeWebviewFixture(fixture);
        const reparsed = parseWebviewFixture(JSON.parse(bytes));

        expect(reparsed.schemaVersion).toBe(fixture.schemaVersion);
        expect(reparsed.contextId).toBe("merge-conflict-session");
        expect(reparsed.scenario).toBe(MERGE_CONFLICT_SESSION_CONFLICTED_SCENARIO);
        expect(reparsed).toEqual(fixture);
    });

    it("produces byte-identical fixtures from two independently prepared conflicted workspaces", async () => {
        // Sequential, not Promise.all: both recordings share the process-wide capture sink, so
        // running them concurrently would interleave their messages.
        const fixtureA = await recordMergeConflictSessionWebviewFixture(optionsFor(workspaceA));
        const fixtureB = await recordMergeConflictSessionWebviewFixture(optionsFor(workspaceB));

        expect(serializeWebviewFixture(fixtureA)).toBe(serializeWebviewFixture(fixtureB));
    });

    // Without this test, deleting the `canonicalizeCapturedMessages` call from the recorder leaves
    // all 91 tests in this suite GREEN -- verified by mutation at the root. This payload is
    // genuinely placeholder-free: `files[].path` is repo-relative (`conflict.txt`) and the branch
    // labels are literals, so canonicalization has nothing to rewrite and its removal changes not
    // one recorded byte. The same defect shipped in Phase 2c-iv-b (FINDING 1) and is fixed the same
    // way: declare a root that DOES occur in the payload, so the pass has real work to do and its
    // absence is observable.
    it("applies the caller's declared roots to the captured payload", async () => {
        const base = optionsFor(workspaceA);
        const baseline = await recordMergeConflictSessionWebviewFixture(base);
        const needle = firstConflictPath(baseline);

        const fixture = await recordMergeConflictSessionWebviewFixture({
            ...base,
            roots: { ...base.roots, root: needle },
        });
        const bytes = serializeWebviewFixture(fixture);

        expect(bytes).toContain("<ROOT>");
        expect(bytes).not.toContain(`"${needle}"`);
    });

    // The env-determinism oracle. Deleting `toGitEnvironment(options.env)` from this recorder's
    // `GitExecutor` construction also leaves all 91 tests green -- likewise verified by mutation.
    // Unlike `commit-panel`, no hostile git CONFIG can expose it here: this payload comes from a
    // single `git status --porcelain=v1 -z -uall` (`operations.ts:1561-1587`), and `-z`, `-uall`,
    // and `--porcelain=v1` between them neutralize `core.quotePath`, `status.showUntrackedFiles`,
    // and `status.relativePaths` respectively. So the observable is not a DIFFERENT payload but no
    // payload at all: point the handed-in environment at a syntactically invalid global config and
    // git itself refuses to run. A recorder that ignores `options.env` reads the ambient
    // environment instead, git succeeds, and the recording completes -- which is exactly the
    // regression this asserts cannot happen.
    it("actually runs git under the environment it was handed, not the ambient one", async () => {
        const brokenConfig = path.join(parentDir, "broken.gitconfig");
        await writeFile(brokenConfig, "[[[ this is not valid git config\n", "utf8");

        const base = optionsFor(workspaceA);
        await expect(
            recordMergeConflictSessionWebviewFixture({
                ...base,
                env: { ...base.env, GIT_CONFIG_GLOBAL: brokenConfig },
            }),
        ).rejects.toThrow();

        // Control: the SAME options minus the broken config record fine, so the rejection above is
        // the config being honored -- not some unrelated breakage in this workspace.
        const fixture = await recordMergeConflictSessionWebviewFixture(base);
        expect(fixture.messages.length).toBeGreaterThan(0);
    });

    it("captures a non-trivial payload whose files are all real unmerged conflict entries", async () => {
        const fixture = await recordMergeConflictSessionWebviewFixture(optionsFor(workspaceA));

        expect(fixture.messages.length).toBeGreaterThan(0);

        const setSessionDataMessages = fixture.messages.filter(
            (captured) =>
                typeof captured.message === "object" &&
                captured.message !== null &&
                (captured.message as { type?: unknown }).type === "setSessionData",
        );
        expect(setSessionDataMessages.length).toBeGreaterThan(0);

        const files = setSessionDataMessages.flatMap((captured) => {
            const message = captured.message as {
                data?: { files?: ReadonlyArray<{ path?: unknown; code?: unknown }> };
            };
            return message.data?.files ?? [];
        });

        // Ties the assertion to `assertConflictedPostcondition`'s own definition of `conflicted`
        // (`scenarios.ts:162-164`): every entry's status code must be one of the real unmerged pairs.
        // A `clean` repo (or any non-conflicted state) has no such entries and could never pass this.
        expect(files.length).toBeGreaterThan(0);
        expect(files.every((file) => typeof file.path === "string" && file.path.length > 0)).toBe(
            true,
        );
        expect(
            files.every(
                (file) =>
                    typeof file.code === "string" && /^(UU|AA|DD|AU|UA|UD|DU)$/.test(file.code),
            ),
        ).toBe(true);
    });

    it("never leaks the temp root, real HOME, or /Users/ into the serialized bytes", async () => {
        const fixture = await recordMergeConflictSessionWebviewFixture(optionsFor(workspaceA));
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

        await expect(
            recordMergeConflictSessionWebviewFixture(optionsFor(workspaceA)),
        ).rejects.toThrow(/E2E control channel/i);
    });

    /**
     * THE SINGLETON ORACLE -- the point of this phase. `MergeConflictSessionPanel.open()` reuses
     * `currentPanel` (`MergeConflictSessionPanel.ts:102-109`) instead of creating a fresh panel
     * unless the previous panel was disposed. `recordMergeConflictSessionWebviewFixture` disposes
     * the panel it drove as its own last step specifically so this reuse never happens across two
     * recordings in the same process -- and disposing only actually clears `currentPanel` if the
     * panel double's `dispose()` (`webviewPanelDouble.ts`) invokes its `onDidDispose` listeners.
     *
     * Deleting the `for (const listener of ...) listener();` loop inside `webviewPanelDouble.ts`'s
     * `dispose()` (or the `disposeListeners.push(callback)` line inside its `onDidDispose`) turns
     * this test red: `MergeConflictSessionPanel.currentPanel` stays set after the first recording,
     * the second `open()` call takes the reuse branch, no new panel is registered, and the second
     * recording's own capture-sink guard throws (the sink the reused panel's stale `postMessage`
     * closure writes into is not the sink this recorder reads back) instead of returning a payload.
     */
    it("clears the singleton after recording, so a second recording in the same process still captures real data", async () => {
        const fixtureA = await recordMergeConflictSessionWebviewFixture(optionsFor(workspaceA));
        expect(MergeConflictSessionPanel.isOpen()).toBe(false);

        const fixtureB = await recordMergeConflictSessionWebviewFixture(optionsFor(workspaceB));

        expect(fixtureB.messages.length).toBeGreaterThan(0);
        expect(serializeWebviewFixture(fixtureB)).toBe(serializeWebviewFixture(fixtureA));
    });

    it("registers exactly the contexts claimed through Phase 2c-v-a", () => {
        const contextIds = new Set(WEBVIEW_FIXTURE_RECORDERS.map((entry) => entry.contextId));

        expect(contextIds).toEqual(
            new Set([
                "commit-info",
                "commit-graph-card",
                "commit-graph-compact",
                "commit-panel",
                "merge-conflict-session",
            ]),
        );
    });

    /**
     * `buildMergeConflictSessionLabels` is the extracted-oracle this recorder needs
     * (`SPEC-phase2c-v-a.md` section 4's "extracted-oracle rule"). `sourceBranch`/`targetBranch`
     * ARE reflected in the recorded bytes (`MergeConflictSessionPanel.ts:290-294` posts them
     * straight into `setSessionData`), but NONE of the end-to-end assertions above check their
     * specific string values -- "non-trivial" only inspects `files`, "byte-identical" only proves
     * the two recordings agree WITH EACH OTHER (a consistently wrong constant would still pass
     * that), and "parses" only checks schema shape. A swapped or mistyped source/target pair would
     * therefore stay invisible to every test above; only a direct assertion on this pure function
     * catches it. Asserting on it directly is the same oracle pattern `buildProviderOptions`
     * (`recordCommitGraphWebviewFixture.ts`) and `buildCommitPanelConstructorOptions`
     * (`recordCommitPanelWebviewFixture.ts`) already establish.
     */
    describe("buildMergeConflictSessionLabels", () => {
        it("names the conflicted scenario's real branches, not placeholders", () => {
            // `prepareConflicted` (`scenarios.ts`) merges `FIXTURE_REFS.conflicting` INTO
            // `FIXTURE_REFS.main` -- so the incoming/source side is `conflicting` and the
            // current/target side is `main`, matching `MergeConflictSessionPanel`'s own
            // "incoming branch" / "current branch" semantics (`MergeConflictSessionPanel.ts:47-48`).
            expect(buildMergeConflictSessionLabels()).toEqual({
                sourceBranch: FIXTURE_REFS.conflicting,
                targetBranch: FIXTURE_REFS.main,
            });
        });
    });
});

/**
 * Unit tests for the shared `vscode.WebviewPanel` double `merge-conflict-session` is the first
 * consumer of. Isolated from any real `git`/scenario workspace -- these are about the double's own
 * contract, not about what any one recorder captures (the describe block above already covers
 * that).
 */
describe("webviewPanelDouble", () => {
    afterEach(() => {
        resetCreatedWebviewPanelsForTests();
    });

    it("dispose() invokes every registered onDidDispose listener exactly once, even across repeated dispose() calls", () => {
        const panel = createFakeWebviewPanel();
        let firstCount = 0;
        let secondCount = 0;
        panel.onDidDispose(() => {
            firstCount += 1;
        });
        panel.onDidDispose(() => {
            secondCount += 1;
        });

        panel.dispose();
        expect(firstCount).toBe(1);
        expect(secondCount).toBe(1);

        // Idempotent: a second dispose() call must not refire either listener.
        panel.dispose();
        expect(firstCount).toBe(1);
        expect(secondCount).toBe(1);
    });

    it("does not retroactively fire a listener registered after dispose() already ran", () => {
        const panel = createFakeWebviewPanel();
        panel.dispose();

        let count = 0;
        panel.onDidDispose(() => {
            count += 1;
        });

        expect(count).toBe(0);
    });

    it("records every created panel in construction order", () => {
        const first = createFakeWebviewPanel();
        const second = createFakeWebviewPanel();

        const created = getCreatedWebviewPanels();
        expect(created.length).toBe(2);
        expect(created[0]).toBe(first);
        expect(created[1]).toBe(second);
    });

    it("resetCreatedWebviewPanelsForTests empties the registry", () => {
        createFakeWebviewPanel();
        resetCreatedWebviewPanelsForTests();

        expect(getCreatedWebviewPanels()).toEqual([]);
    });
});
