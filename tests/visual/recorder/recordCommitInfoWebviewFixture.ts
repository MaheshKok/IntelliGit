/**
 * Phase 2c-i's one thin vertical slice: records a "clean" webview-payload fixture for the
 * `commit-info` resolved host context (`CommitInfoViewProvider`,
 * `src/views/CommitInfoViewProvider.ts`) end to end -- a REAL provider, resolved through Phase 2a's
 * capture seam (`src/e2e/webviewCapture.ts`), driven against a REAL seeded git workspace so a REAL
 * git service (`GitOps.getCommitDetail`, `src/git/operations.ts`) produces the payload, then
 * canonicalized with Phase 2b (`canonicalizeCapturedMessages.ts`) and serialized with Phase 2b's
 * fixed-byte convention (`webviewFixtureFile.ts`).
 *
 * **Why `commit-info`.** Of the 8 resolved host contexts (`WEBVIEW_CONTEXT_IDS`), this one has the
 * least host wiring to stand up: `CommitInfoViewProvider` needs only an `extensionUri` and a
 * `vscode.WebviewView` to resolve, and its "clean" scenario (`ready`, then one selected commit)
 * touches exactly one collaborator beyond the VS Code surface -- `IconThemeService` /
 * `FileIconThemeResolver` -- whose every VS Code read is already wrapped in its own try/catch and
 * falls back cleanly when unimplemented (see `commitInfoVscodeDouble.ts`'s own doc comment for the
 * exact two members deliberately left out). The commit-graph and undocked contexts by contrast need
 * a `RepositoryContext`/multi-repository selector; the merge-editor and shelf-conflict contexts need
 * a merge/shelf session; `merge-conflict-session` needs a live conflicted working tree. None of that
 * is needed here.
 *
 * **Why the E2E gate is checked here, not left to the capture seam alone.** `captureWebview` /
 * `captureWebviewViewProvider` already no-op (return the real object, identity-equal) when
 * `isE2eControlChannelActive()` is false -- that is correct production behavior, but it means a
 * caller who forgets to activate the gate gets back a fully functional, UNCAPTURED provider: every
 * step below still runs, `resolveWebviewView` still succeeds, `setCommitDetail` still resolves --
 * and the recorder would silently return a fixture with zero messages instead of failing. This
 * function checks the gate itself, first, and throws loudly, so a misconfigured recording run
 * fails at the one call that actually knows a recording was intended, rather than downstream at
 * some assertion that has no idea why the fixture came back empty.
 *
 * **Why `setCommitDetail`'s completion is awaited via a microtask flush.**
 * `CommitInfoViewProvider.setCommitDetail` is synchronous and does not return a promise; it fires
 * `decorateAndStoreDetail(...)` and lets it settle on its own schedule. Every step inside that chain
 * in this double (icon-theme resolution failing over to its declared fallback, see the module doc
 * comment on `commitInfoVscodeDouble.ts`) is already-resolved Promise chaining with no real timer or
 * I/O wait, so a single `setImmediate` tick -- which only runs after Node's microtask queue is fully
 * drained, including microtasks newly enqueued while draining -- is sufficient to observe the
 * second, decorated `setCommitDetail` post this module's own tests assert on.
 */

import type * as vscode from "vscode";

import {
    captureWebviewViewProvider,
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";
import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { CommitInfoViewProvider } from "../../../src/views/CommitInfoViewProvider";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { toGitEnvironment } from "./recordingGitEnvironment";
import { createFakeCommitInfoWebviewView, createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";

/** The `commit-info` host context's own resolved id -- see `WEBVIEW_CONTEXT_IDS`. */
const COMMIT_INFO_CONTEXT_ID: WebviewContextId = "commit-info";

/** Phase 2c-i's one recorded scenario name, per PLAN.md step 11's `<scenario>.json` convention. */
export const COMMIT_INFO_CLEAN_SCENARIO = "clean";

export interface RecordCommitInfoWebviewFixtureOptions {
    /** Absolute path to a REAL seeded git working-tree repository (e.g. `FixtureTemplate.root` from
     * `tests/fixtures/repo/seed.ts`). Never mutated -- every git call this module makes is a read. */
    readonly repoRoot: string;
    /** The commit hash `GitOps.getCommitDetail` resolves for the "clean" scenario's selected commit. */
    readonly commitHash: string;
    /** The concrete-path roots this recording's canonicalization pass rewrites to `<ROOT>` /
     * `<ORIGIN>` / `<PROFILE>` (see `canonicalizeCapturedMessages.ts`). This slice never allocates a
     * VS Code profile directory, so callers pass `profileDir: ""` -- `buildPlaceholderReplacements`
     * treats an empty root as "no needles for this placeholder", never as a wildcard. */
    readonly roots: PlaceholderRoots;
    /** The scenario's sanitized git environment (`ScenarioWorkspace.env` / `FixtureTemplate.env`).
     * Required, not optional: a recording that inherits the host environment reads the developer's
     * own `~/.gitconfig` and produces a fixture nobody else can reproduce -- see
     * `recordingGitEnvironment.ts`'s own doc comment for the concrete failure. */
    readonly env: NodeJS.ProcessEnv;
}

/** A resolve-context stand-in `CommitInfoViewProvider.resolveWebviewView` never reads (its own
 * parameter is named `_context`) -- an empty object satisfies the type without modeling a member
 * production code does not touch. */
const INERT_RESOLVE_CONTEXT = {} as vscode.WebviewViewResolveContext;
/** Same reasoning as {@link INERT_RESOLVE_CONTEXT}, for the unread `_token` parameter. */
const INERT_CANCELLATION_TOKEN = {} as vscode.CancellationToken;

/** Resolves once every microtask queued synchronously up to this call has drained -- including ones
 * newly enqueued while draining, since Node fully empties the microtask queue before running any
 * `setImmediate` callback. See this module's own doc comment for why that is sufficient here and
 * not a race. */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Records the `commit-info` "clean" scenario end to end and returns the canonicalized, ready-to-
 * serialize fixture. Throws if the E2E control channel gate is inactive (see this module's own doc
 * comment) or if the capture seam allocated no sink despite the gate being active -- either is a
 * recording-run misconfiguration, never a fixture with fewer messages than intended.
 */
export async function recordCommitInfoWebviewFixture(
    options: RecordCommitInfoWebviewFixtureOptions,
): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive()) {
        throw new Error(
            "recordCommitInfoWebviewFixture: the E2E control channel gate " +
                "(isE2eControlChannelActive()) is inactive. Recording through an inactive gate " +
                "would silently produce an EMPTY fixture -- captureWebviewViewProvider returns " +
                "the real, unwrapped provider identity-equal when the gate is off, so " +
                "resolveWebviewView would run for real but nothing would ever reach the capture " +
                "sink. Call setE2eControlChannelActive(true) (src/e2e/activationState.ts) before " +
                "recording.",
        );
    }

    // Cleared first, not last: this call's own messages must never be preceded by a previous
    // recording's leftovers in the process-wide sink `captureWebviewViewProvider` always shares.
    resetE2eWebviewCaptureSinkForTests();

    const provider = new CommitInfoViewProvider(createFakeExtensionUri());
    const capturedProvider = captureWebviewViewProvider(provider, COMMIT_INFO_CONTEXT_ID);

    const { webviewView, receiveMessage } = createFakeCommitInfoWebviewView();
    capturedProvider.resolveWebviewView(
        webviewView,
        INERT_RESOLVE_CONTEXT,
        INERT_CANCELLATION_TOKEN,
    );

    // The webview signals readiness before any commit is selected -- the real bootstrap sequence
    // every one of the 8 host contexts' bundled React apps follows.
    await receiveMessage({ type: "ready" });

    const gitOps = new GitOps(
        new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env)),
    );
    const detail = await gitOps.getCommitDetail(options.commitHash);

    capturedProvider.setCommitDetail(detail);
    await flushMicrotasks();

    const sink = getE2eWebviewCaptureSink();
    if (!sink) {
        throw new Error(
            "recordCommitInfoWebviewFixture: isE2eControlChannelActive() was true, but no capture " +
                "sink was allocated. captureWebviewViewProvider only allocates one once a webview " +
                "is actually resolved (src/e2e/webviewCapture.ts) -- this means resolveWebviewView " +
                "never ran, which is a bug in this recorder, not an empty scenario.",
        );
    }

    const captured = sink
        .getMessages()
        .filter((message) => message.contextId === COMMIT_INFO_CONTEXT_ID);
    resetE2eWebviewCaptureSinkForTests();

    const canonicalized = canonicalizeCapturedMessages(captured, options.roots, []);
    return buildWebviewFixture(COMMIT_INFO_CONTEXT_ID, COMMIT_INFO_CLEAN_SCENARIO, canonicalized);
}
