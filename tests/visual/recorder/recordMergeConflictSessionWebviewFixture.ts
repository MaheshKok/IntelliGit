/**
 * Phase 2c-v-a's recorder: records the `conflicted` scenario for the `merge-conflict-session`
 * resolved host context -- `MergeConflictSessionPanel` (`src/views/MergeConflictSessionPanel.ts`),
 * the standalone panel that lists a repository's in-progress merge conflicts and lets a user open,
 * accept, or abort them. `conflicted`, not `clean`: this panel renders in-progress conflict state,
 * so recording against `clean` would capture an empty conflict list and prove nothing (mirrors
 * `recordCommitPanelWebviewFixture.ts`'s own `dirty`-not-`clean` reasoning for the working-tree
 * panel).
 *
 * **The `vscode.WebviewPanel`, not `vscode.WebviewView`.** `MergeConflictSessionPanel.open()`
 * builds its own panel via `vscode.window.createWebviewPanel(...)` and wraps it with
 * `captureWebview(rawPanel, "merge-conflict-session")` itself (`MergeConflictSessionPanel.ts:111-121`)
 * -- unlike every Phase 2c-iv recorder, this module never constructs or resolves a webview view
 * directly. It reaches the panel production created AFTER the fact, through
 * `webviewPanelDouble.ts`'s construction registry (`getCreatedWebviewPanels()`) -- see that module's
 * own doc comment for the full mechanism, including why `dispose()` firing `onDidDispose` listeners
 * is load-bearing rather than tidy.
 *
 * **No `ready` handshake.** `open()` itself posts the panel's one `setSessionData` message
 * (`MergeConflictSessionPanel.ts:131`) as part of opening -- awaiting `open()` already yields it.
 * Sending a `ready` message on top would produce a redundant second identical message in the
 * fixture, so this recorder deliberately never sends one.
 *
 * **Disposing the panel it created is part of one recording, not cleanup bolted on after.** Nothing
 * else in this process ever disposes a `MergeConflictSessionPanel` -- a real user closing the tab
 * is the only thing that normally would. Without an explicit `dispose()` call here,
 * `MergeConflictSessionPanel.currentPanel` would stay set for the rest of the vitest process, and
 * every LATER recording call (the byte-identical-across-two-workspaces test records twice; the
 * singleton-oracle test explicitly depends on this) would silently take the reuse branch
 * (`MergeConflictSessionPanel.ts:102-109`) instead of creating a fresh panel. Disposing here is what
 * makes recording this context repeatable within one process, exactly the way a real user closing
 * the panel between sessions would be.
 *
 * **And it runs in a `finally`, because a FAILED recording leaks the singleton just as hard.**
 * `open()` assigns `MergeConflictSessionPanel.currentPanel = instance` BEFORE awaiting the
 * `postSessionData` that performs the git read (`MergeConflictSessionPanel.ts:128-130`), so any
 * throw from that read -- a broken repository, a hostile handed-in environment, a git binary that
 * refuses to run -- leaves a live panel holding the FAILED recording's `GitOps` as the process-wide
 * singleton. Every later `open()` in the process then takes the reuse branch and re-runs the
 * poisoned executor, so one failed recording turns every subsequent one in the same process red for
 * a reason that has nothing to do with them. Disposing in a `finally` bounds that damage to the one
 * call that caused it.
 */

import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";
import { MergeConflictSessionPanel } from "../../../src/views/MergeConflictSessionPanel";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { FIXTURE_REFS } from "../../fixtures/repo/seed";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { toGitEnvironment } from "./recordingGitEnvironment";
import { throwingDouble } from "./throwingDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";
import { getCreatedWebviewPanels, resetCreatedWebviewPanelsForTests } from "./webviewPanelDouble";

/** The one resolved host context this module records -- see `WEBVIEW_CONTEXT_IDS`. */
const MERGE_CONFLICT_SESSION_CONTEXT_ID: WebviewContextId = "merge-conflict-session";

/** Phase 2c-v-a's one recorded scenario name -- see this module's own doc comment for why
 * `conflicted`, not `clean`. */
export const MERGE_CONFLICT_SESSION_CONFLICTED_SCENARIO = "conflicted";

export interface RecordMergeConflictSessionWebviewFixtureOptions {
    /** Absolute path to a REAL seeded git working-tree repository, already in the `conflicted`
     * state (an in-progress merge stopped on real conflict markers -- see
     * `tests/fixtures/repo/scenarios.ts`'s `assertConflictedPostcondition`). Never mutated -- every
     * git call this module makes through `GitOps.getConflictFilesDetailed()` is a read. */
    readonly repoRoot: string;
    /** The concrete-path roots this recording's canonicalization pass rewrites to `<ROOT>` /
     * `<ORIGIN>` / `<PROFILE>` (see `canonicalizeCapturedMessages.ts`). This slice never allocates
     * a VS Code profile directory, so callers pass `profileDir: ""`. */
    readonly roots: PlaceholderRoots;
    /** The scenario's sanitized git environment (`ScenarioWorkspace.env` / `FixtureTemplate.env`).
     * Required, not optional: a recording that inherits the host environment reads the developer's
     * own `~/.gitconfig` and produces a fixture nobody else can reproduce -- see
     * `recordingGitEnvironment.ts`'s own doc comment for the concrete failure. */
    readonly env: NodeJS.ProcessEnv;
}

/**
 * Builds the branch labels this recording passes to `MergeConflictSessionPanel.open()`, taken from
 * the REAL seeded branches the `conflicted` scenario merges (`tests/fixtures/repo/scenarios.ts`'s
 * `prepareConflicted`: `git merge FIXTURE_REFS.conflicting` run while `main` is checked out).
 * `sourceBranch` is the incoming branch being merged IN (`FIXTURE_REFS.conflicting`,
 * `"conflict/with-main"`); `targetBranch` is the branch the merge runs on (`FIXTURE_REFS.main`,
 * `"main"`) -- the same source/target semantics `MergeConflictSessionPanel`'s own default labels
 * use ("incoming branch" / "current branch", `MergeConflictSessionPanel.ts:47-48`), but with the
 * scenario's REAL branch names so the fixture reflects an actual merge instead of a placeholder
 * pair.
 *
 * Exported and unit-tested directly (the extracted-oracle pattern `buildProviderOptions`,
 * `recordCommitGraphWebviewFixture.ts`, and `buildCommitPanelConstructorOptions`,
 * `recordCommitPanelWebviewFixture.ts`, already establish): `sourceBranch`/`targetBranch` ARE
 * reflected in the recorded bytes (`MergeConflictSessionPanel.ts:290-294` posts them straight into
 * `setSessionData`), but none of this recorder's own end-to-end tests check their SPECIFIC string
 * values -- a swapped or mistyped pair would still parse, still be byte-identical between two
 * independently prepared workspaces (the swap is a constant, not derived per-workspace), and still
 * carry a non-empty `files` array. Only a direct assertion on this pure function's return value
 * catches that regression.
 */
export function buildMergeConflictSessionLabels(): {
    sourceBranch: string;
    targetBranch: string;
} {
    return {
        sourceBranch: FIXTURE_REFS.conflicting,
        targetBranch: FIXTURE_REFS.main,
    };
}

/**
 * Structural stand-in for `MergeConflictSessionCallbacks` (`MergeConflictSessionPanel.ts:29-32`),
 * not exported from production -- passed by structural typing rather than importing the type (the
 * spec for this phase is explicit: do not export it from production just to import it here). Every
 * member throws by name: none of `openMerge` / `acceptYours` / `acceptTheirs` / `abortMerge` is
 * ever sent by this recording -- `open()` alone posts the one `setSessionData` message this fixture
 * captures (`MergeConflictSessionPanel.ts:131`) -- so a call reaching either callback means this
 * recording reached a webview message it was never meant to, which is a finding to report, not an
 * expected path.
 */
interface MergeConflictSessionCallbacksDouble {
    onOpenMergeConflict: (filePath: string) => Promise<void>;
    onConflictStateChanged: () => Promise<void>;
}

function createInertMergeConflictSessionCallbacks(): MergeConflictSessionCallbacksDouble {
    return throwingDouble<MergeConflictSessionCallbacksDouble>("mergeConflictSessionCallbacks", {});
}

/**
 * Records the `merge-conflict-session` / `conflicted` scenario end to end and returns the
 * canonicalized, ready-to-serialize fixture. Throws if the E2E control channel gate is inactive, if
 * `open()` did not create exactly one new panel (see the thrown message for why that specifically
 * diagnoses a broken panel-double `dispose()`), or if the capture seam allocated no sink despite the
 * gate being active -- each is a recording-run misconfiguration, never a fixture with fewer messages
 * than intended. Mirrors `recordCommitPanelWebviewFixture`'s own gate-check reasoning.
 */
export async function recordMergeConflictSessionWebviewFixture(
    options: RecordMergeConflictSessionWebviewFixtureOptions,
): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive()) {
        throw new Error(
            "recordMergeConflictSessionWebviewFixture: the E2E control channel gate " +
                "(isE2eControlChannelActive()) is inactive. Recording through an inactive gate " +
                "would silently produce an EMPTY fixture -- captureWebview returns the real, " +
                "unwrapped panel identity-equal when the gate is off, so MergeConflictSessionPanel " +
                "would open for real but nothing would ever reach the capture sink. Call " +
                "setE2eControlChannelActive(true) (src/e2e/activationState.ts) before recording.",
        );
    }

    // Cleared first, not last: this call's own messages/panels must never be preceded by a previous
    // recording's leftovers in the process-wide state `captureWebview` and this recorder both share.
    resetE2eWebviewCaptureSinkForTests();
    resetCreatedWebviewPanelsForTests();

    const gitOps = new GitOps(
        new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env)),
    );

    try {
        await MergeConflictSessionPanel.open(
            createFakeExtensionUri(),
            gitOps,
            buildMergeConflictSessionLabels(),
            createInertMergeConflictSessionCallbacks(),
        );

        const createdPanels = getCreatedWebviewPanels();
        if (createdPanels.length !== 1) {
            throw new Error(
                "recordMergeConflictSessionWebviewFixture: expected MergeConflictSessionPanel.open() " +
                    `to create exactly one new webview panel, but ${createdPanels.length} were created. ` +
                    "A count of 0 means open() took the REUSE branch " +
                    "(MergeConflictSessionPanel.ts:102-109) instead of creating a fresh panel -- which " +
                    "happens when a previous recording in this process left " +
                    "MergeConflictSessionPanel.currentPanel set, i.e. the panel double's dispose() " +
                    "(webviewPanelDouble.ts) failed to fire its onDidDispose listeners.",
            );
        }

        const sink = getE2eWebviewCaptureSink();
        if (!sink) {
            throw new Error(
                "recordMergeConflictSessionWebviewFixture: isE2eControlChannelActive() was true, but " +
                    "no capture sink was allocated. captureWebview only allocates one once a panel is " +
                    "actually wrapped (src/e2e/webviewCapture.ts) -- this means " +
                    "MergeConflictSessionPanel.open() never reached its own createWebviewPanel call, " +
                    "which is a bug in this recorder, not an empty scenario.",
            );
        }

        const captured = sink
            .getMessages()
            .filter((message) => message.contextId === MERGE_CONFLICT_SESSION_CONTEXT_ID);

        const canonicalized = canonicalizeCapturedMessages(captured, options.roots, []);
        return buildWebviewFixture(
            MERGE_CONFLICT_SESSION_CONTEXT_ID,
            MERGE_CONFLICT_SESSION_CONFLICTED_SCENARIO,
            canonicalized,
        );
    } finally {
        // Disposing the panel this recording created is part of the recording itself, not cleanup
        // bolted on after -- and it runs on the failure path too, because `open()` publishes the
        // singleton before the git read that can throw. See this module's own top doc comment.
        // Iterates the registry rather than a captured `[panel]` binding so a throw BEFORE the
        // count guard (which is where a failed git read lands) still disposes what was created.
        for (const created of getCreatedWebviewPanels()) created.dispose();
        resetCreatedWebviewPanelsForTests();
        resetE2eWebviewCaptureSinkForTests();
    }
}
