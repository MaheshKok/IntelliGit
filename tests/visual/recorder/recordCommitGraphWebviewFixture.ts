/**
 * Phase 2c-iv-b's pair of recorders: records "clean" webview-payload fixtures for the
 * `commit-graph-card` and `commit-graph-compact` resolved host contexts. Both are the SAME
 * `CommitGraphViewProvider` class (`src/views/CommitGraphViewProvider.ts`) constructed with a
 * different `scriptFile` / `title` / `showRepositoryLabel` -- see the two real construction sites,
 * `src/activation/repositoryMode.ts:284` (card, default `scriptFile`) and `:290` (compact,
 * `webview-compactcommitgraph.js`) -- so one shared recording function, parameterized by variant,
 * drives both rather than duplicating the end-to-end sequence twice.
 *
 * Both variants record against the `clean` scenario: `CommitGraphViewProvider` renders commit
 * history and branches, not working-tree state, so there is no `dirty`/`clean` divergence to
 * capture for it the way there would be for a working-tree-status view.
 *
 * **The commit-checks trap, and why it is avoided here.** `CommitGraphViewProvider`'s constructor
 * (`:170-186`) unconditionally builds a `CommitChecksCoordinator`, and when
 * `options.commitChecksProviders` is omitted it defaults to four REAL HTTP-backed providers
 * (GitHub, GitLab, Bitbucket Cloud, Bitbucket Server). A recorder must never depend on the
 * network -- a fixture that varies with a CI runner's connectivity is not a baseline -- so this
 * module always passes `commitChecksProviders: []`, plus `settings: undefined`,
 * `commitChecksService: undefined`, and `hostMap: {}` so the coordinator stays inert. No message
 * this "clean" scenario captures asks the coordinator to fetch anything (that only happens on a
 * `requestVisibleCommitChecks` webview message, never sent here), so this is a defensive
 * precondition, not a workaround for an observed failure.
 *
 * **`credentialStore`.** `CredentialStore` (`src/services/commitChecks/credentialStore.ts:19`) is
 * a thin stateless wrapper: `constructor(secrets: vscode.SecretStorage)`. Built here over a
 * `throwingDouble`-backed `vscode.SecretStorage` ({@link createInertSecretStorage}) -- with no
 * providers registered, nothing should ever read a secret, so every member throwing by name is
 * exactly right; a throw from it would mean a real secret read happened, which is a finding, not
 * an expected path.
 *
 * **The `vscode` surface.** Reuses `createCommitInfoVscodeDouble()`
 * (`commitInfoVscodeDouble.ts`) unchanged -- see that function's own doc comment for the full
 * accounting of why the `ready`-then-history-loads happy path needs nothing beyond what it already
 * implements for `commit-info`.
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
import { CommitGraphViewProvider } from "../../../src/views/CommitGraphViewProvider";
import { compactCommitGraphViewOptions } from "../../../src/views/commitGraphHostOptions";
import { CredentialStore } from "../../../src/services/commitChecks/credentialStore";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { loadRecordingBranches } from "./recordingBranches";
import { toGitEnvironment } from "./recordingGitEnvironment";
import { createFakeCommitGraphWebviewView, createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { throwingDouble } from "./throwingDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";

/** The two resolved host contexts this module records -- see `WEBVIEW_CONTEXT_IDS`. */
const COMMIT_GRAPH_CARD_CONTEXT_ID: WebviewContextId = "commit-graph-card";
const COMMIT_GRAPH_COMPACT_CONTEXT_ID: WebviewContextId = "commit-graph-compact";

/** Phase 2c-iv-b's one recorded scenario name for both contexts -- see this module's own doc
 * comment for why `commit-graph-card` / `commit-graph-compact` have no `dirty` counterpart. */
export const COMMIT_GRAPH_CLEAN_SCENARIO = "clean";

export interface RecordCommitGraphWebviewFixtureOptions {
    /** Absolute path to a REAL seeded git working-tree repository (e.g. `FixtureTemplate.root` from
     * `tests/fixtures/repo/seed.ts`). Never mutated -- every git call this module makes is a read. */
    readonly repoRoot: string;
    /** The concrete-path roots this recording's canonicalization pass rewrites to `<ROOT>` /
     * `<ORIGIN>` / `<PROFILE>` (see `canonicalizeCapturedMessages.ts`). This slice never allocates a
     * VS Code profile directory, so callers pass `profileDir: ""`. */
    readonly roots: PlaceholderRoots;
    /** The scenario's sanitized git environment (`ScenarioWorkspace.env` / `FixtureTemplate.env`).
     * Required, not optional: a recording that inherits the host environment reads the developer's
     * own `~/.gitconfig` and produces a fixture nobody else can reproduce -- see
     * `recordingGitEnvironment.ts`'s own doc comment for the concrete failure. */
    readonly env: NodeJS.ProcessEnv;
}

/** A resolve-context stand-in `CommitGraphViewProvider.resolveWebviewView` never reads (its own
 * parameter is named `_context`) -- an empty object satisfies the type without modeling a member
 * production code does not touch. */
const INERT_RESOLVE_CONTEXT = {} as vscode.WebviewViewResolveContext;
/** Same reasoning as {@link INERT_RESOLVE_CONTEXT}, for the unread `_token` parameter. */
const INERT_CANCELLATION_TOKEN = {} as vscode.CancellationToken;

/**
 * A `vscode.SecretStorage` double for {@link CredentialStore} -- every member throws by name (see
 * `throwingDouble.ts`). This recording always passes `commitChecksProviders: []`
 * ({@link buildProviderOptions}), so no commit-check provider that could read a stored secret is
 * ever constructed; if this throws, a real secret read happened somewhere it should not have, and
 * that is a finding to report, not an expected path.
 */
function createInertSecretStorage(): vscode.SecretStorage {
    return throwingDouble<vscode.SecretStorage>("secretStorage", {});
}

/** Which of the two same-class registrations a recording is driving. */
type CommitGraphVariant = "card" | "compact";

/**
 * Builds the `CommitGraphViewProvider` constructor's fourth argument for one variant, mirroring
 * the two real construction sites in `src/activation/repositoryMode.ts` exactly (see this
 * module's own doc comment for the line numbers). Every field below that is NOT variant-specific
 * is set to keep the commit-checks coordinator inert -- see this module's own doc comment on the
 * commit-checks trap.
 *
 * Exported for one reason: the commit-checks trap is this module's single loudest safety
 * requirement, and it cannot be observed from a recorded payload. Deleting
 * `commitChecksProviders: []` leaves every end-to-end assertion green -- the four default
 * providers are only CONSTRUCTED, and stay dormant until a `requestVisibleCommitChecks` message
 * this scenario never sends -- so the invariant would be protected by a comment alone. Asserting
 * on this pure function is the only oracle that goes red when the line disappears.
 */
export function buildProviderOptions(
    variant: CommitGraphVariant,
): NonNullable<ConstructorParameters<typeof CommitGraphViewProvider>[3]> {
    const inert = {
        hostMap: {},
        settings: undefined,
        commitChecksService: undefined,
        commitChecksProviders: [],
    };
    if (variant === "compact") {
        return {
            ...inert,
            // The SHARED production definition, not a hand-copy of it. This recorder previously
            // duplicated `scriptFile` and a bare `title: "Graph"` literal where production calls
            // `vscode.l10n.t("Graph")`. The recorded bytes are identical either way -- which is
            // exactly the problem: a production edit dropping `l10n.t` (the defect fixed in
            // `ShelfConflictEditorPanel`) changed no fixture and no assertion, so it was invisible
            // to every recorder-backed oracle by construction. Calling production's own factory is
            // what lets `tests/unit/visual/harness/hostContexts.test.ts` witness that regression.
            ...compactCommitGraphViewOptions(),
            // Production: `repositories.length > 1`. Recorded against a single-repository seeded
            // workspace, where the real call site would also resolve to `false`.
            showRepositoryLabel: false,
        };
    }
    return inert;
}

/**
 * Records one `CommitGraphViewProvider` variant's `clean` scenario end to end and returns the
 * canonicalized, ready-to-serialize fixture. Throws if the E2E control channel gate is inactive,
 * or if the capture seam allocated no sink despite the gate being active -- either is a
 * recording-run misconfiguration, never a fixture with fewer messages than intended. Mirrors
 * `recordCommitInfoWebviewFixture`'s own gate-check reasoning (see that module's doc comment).
 */
async function recordCommitGraphWebviewFixture(
    contextId: WebviewContextId,
    variant: CommitGraphVariant,
    options: RecordCommitGraphWebviewFixtureOptions,
): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive()) {
        throw new Error(
            `recordCommitGraphWebviewFixture(${contextId}): the E2E control channel gate ` +
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

    const credentialStore = new CredentialStore(createInertSecretStorage());
    const gitOps = new GitOps(
        new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env)),
    );
    const provider = new CommitGraphViewProvider(
        createFakeExtensionUri(),
        gitOps,
        credentialStore,
        buildProviderOptions(variant),
    );
    const capturedProvider = captureWebviewViewProvider(provider, contextId);

    // Production's activation sequence, applied BEFORE the view resolves -- see
    // `recordingBranches.ts` for why the branch list has to be populated at all (an unpopulated
    // provider records `"branches": []`) and why the call belongs on this side of
    // `resolveWebviewView`: the setter caches without posting while no view exists, so `ready`'s
    // own `sendBranches` posts the populated list exactly once.
    const { branches, worktrees } = await loadRecordingBranches(
        gitOps,
        options.repoRoot,
        options.env,
    );
    provider.setBranches(branches, worktrees);

    const { webviewView, receiveMessage } = createFakeCommitGraphWebviewView();
    capturedProvider.resolveWebviewView(
        webviewView,
        INERT_RESOLVE_CONTEXT,
        INERT_CANCELLATION_TOKEN,
    );

    // The webview signals readiness once -- the real bootstrap sequence every host context's
    // bundled React app follows. `CommitGraphViewProvider`'s own `ready` handler is `async` and is
    // fully awaited here before any message it posts is read back, so no extra microtask flush
    // (unlike `recordCommitInfoWebviewFixture`'s `setCommitDetail`, which is fire-and-forget) is
    // needed: `loadInitial()`'s `Promise.all([getLog, getUnpushedCommitHashes])` is awaited inside
    // the same handler this call awaits.
    await receiveMessage({ type: "ready" });

    const sink = getE2eWebviewCaptureSink();
    if (!sink) {
        throw new Error(
            `recordCommitGraphWebviewFixture(${contextId}): isE2eControlChannelActive() was ` +
                "true, but no capture sink was allocated. captureWebviewViewProvider only " +
                "allocates one once a webview is actually resolved (src/e2e/webviewCapture.ts) " +
                "-- this means resolveWebviewView never ran, which is a bug in this recorder, " +
                "not an empty scenario.",
        );
    }

    const captured = sink.getMessages().filter((message) => message.contextId === contextId);
    resetE2eWebviewCaptureSinkForTests();

    const canonicalized = canonicalizeCapturedMessages(captured, options.roots, []);
    return buildWebviewFixture(contextId, COMMIT_GRAPH_CLEAN_SCENARIO, canonicalized);
}

/** Records the `commit-graph-card` context: `CommitGraphViewProvider` constructed with its
 * default `scriptFile` (`webview-commitgraph.js`), matching `repositoryMode.ts:284`. */
export function recordCommitGraphCardWebviewFixture(
    options: RecordCommitGraphWebviewFixtureOptions,
): Promise<WebviewFixture> {
    return recordCommitGraphWebviewFixture(COMMIT_GRAPH_CARD_CONTEXT_ID, "card", options);
}

/** Records the `commit-graph-compact` context: `CommitGraphViewProvider` constructed with
 * `scriptFile: "webview-compactcommitgraph.js"`, matching `repositoryMode.ts:290`. */
export function recordCommitGraphCompactWebviewFixture(
    options: RecordCommitGraphWebviewFixtureOptions,
): Promise<WebviewFixture> {
    return recordCommitGraphWebviewFixture(COMMIT_GRAPH_COMPACT_CONTEXT_ID, "compact", options);
}
