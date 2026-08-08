/**
 * Phase 2c-iv-c's recorder: records the `dirty` scenario for the `commit-panel` resolved host
 * context -- `CommitPanelViewProvider` (`src/views/CommitPanelViewProvider.ts`), the sidebar panel
 * that shows working-tree changes, the commit message box, and stash/shelf actions. `dirty`, not
 * `clean`: this view renders working-tree state, so recording against `clean` would capture an
 * empty panel and prove nothing (SPEC-phase2c-iv-c.md's own "Scope" section).
 *
 * **Construction (`src/activation/repositoryMode.ts:305-315`), nine positional arguments.** Every
 * argument below is a deliberate choice:
 *
 *  - `extensionUri` -- `createFakeExtensionUri()`, as the commit-graph recorder does.
 *  - `gitOps` -- a real `GitOps` over the REAL prepared `dirty` workspace, its executor pinned to
 *    the scenario's sanitized environment (`toGitEnvironment`, `recordingGitEnvironment.ts`) so the
 *    recording cannot inherit the running developer's `~/.gitconfig`.
 *  - `repoRootUri` -- `createFakeUriFromPath(repoRoot)`. Passing it is what makes the constructor
 *    call `setRepositoriesInternal`, so the panel has a repository to render. Passing `undefined`
 *    would record an empty panel, which is not the `dirty` scenario.
 *  - `workspaceState` -- {@link createEmptyWorkspaceMemento}, deliberately NOT a `throwingDouble`
 *    -- see that function's own doc comment.
 *  - `secrets` -- {@link createInertSecretStorage}, a `throwingDouble`: nothing on this path
 *    should read a secret, so a throw is a finding, not a path.
 *  - the remaining four (`shelfServiceForRepository`, `shelfRemoveOnUnshelve`,
 *    `commitMessageGenerationCoordinator`, `interactiveRebaseStorageRoot`) are built by
 *    {@link buildCommitPanelConstructorOptions}, exported so a test can assert on them directly --
 *    mirroring `buildProviderOptions` in `recordCommitGraphWebviewFixture.ts` (Phase 2c-iv-b), the
 *    established answer to "an end-to-end assertion cannot tell this decision apart from a wrong
 *    one".
 *
 * **The watcher that is never constructed.** This recorder was specified on the belief that the
 * constructor reaches `registerRuntimeWatcher` (`CommitPanelViewProvider.ts:746`) and therefore
 * needs a `vscode.workspace.createFileSystemWatcher` double. It does not.
 * `syncRuntimeWatchers` (`:727-730`) builds `desiredRoots` from `expandedRepositoryRoots` (`:114`,
 * written only by the public `setExpandedRepositories`, reachable only from the
 * `"setExpandedRepositories"` webview message at `:1591`) with the ACTIVE root filtered out, and
 * `setRepositoriesInternal` (`:308-313`) makes this recording's single root the active one --
 * so `desiredRoots` is empty and no watcher is ever created. That design is deliberate (its own
 * doc comment at `:725` says watchers exist for expanded NON-active rows); it is simply
 * inapplicable to a single-repository recording.
 *
 * Nothing was added to the `vscode` double for it. The silent `try`/`catch` at `:768` would have
 * made a `throwingDouble` useless there anyway -- it swallows the throw, so the recording still
 * "succeeds" and proves nothing -- but that only matters once something reaches the call site. If
 * a future multi-repository scenario does, `throwingDouble` will name the missing member, which is
 * the signal to implement it deliberately then.
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
import { CommitPanelViewProvider } from "../../../src/views/CommitPanelViewProvider";
import type { ShelfService } from "../../../src/services/shelfService";
import type { CommitMessageGenerationCoordinator } from "../../../src/ai/commitMessageGenerationCoordinator";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { toGitEnvironment } from "./recordingGitEnvironment";
import {
    createFakeCommitPanelWebviewView,
    createFakeExtensionUri,
    createFakeUriFromPath,
} from "./commitInfoVscodeDouble";
import { throwingDouble } from "./throwingDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";

/** The one resolved host context this module records -- see `WEBVIEW_CONTEXT_IDS`. */
const COMMIT_PANEL_CONTEXT_ID: WebviewContextId = "commit-panel";

/** Phase 2c-iv-c's one recorded scenario name -- see this module's own doc comment for why
 * `dirty`, not `clean`. */
export const COMMIT_PANEL_DIRTY_SCENARIO = "dirty";

export interface RecordCommitPanelWebviewFixtureOptions {
    /** Absolute path to a REAL seeded git working-tree repository, already in the `dirty` state
     * (e.g. `FixtureTemplate.root` from `tests/fixtures/repo/seed.ts`). Never mutated -- every git
     * call this module makes is a read. */
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

/** A resolve-context stand-in `CommitPanelViewProvider.resolveWebviewView` never reads -- same
 * reasoning as `recordCommitGraphWebviewFixture.ts`'s own `INERT_RESOLVE_CONTEXT`. */
const INERT_RESOLVE_CONTEXT = {} as vscode.WebviewViewResolveContext;
/** Same reasoning as {@link INERT_RESOLVE_CONTEXT}, for the unread `_token` parameter. */
const INERT_CANCELLATION_TOKEN = {} as vscode.CancellationToken;

/**
 * A `vscode.SecretStorage` double for `CommitPanelViewProvider`'s `secrets` argument -- every
 * member throws by name (see `throwingDouble.ts`). Nothing on the `dirty`/`ready` path this
 * recording drives reads a secret, so a throw here is a finding to report, not an expected path --
 * same reasoning as `recordCommitGraphWebviewFixture.ts`'s own `createInertSecretStorage`.
 */
function createInertSecretStorage(): vscode.SecretStorage {
    return throwingDouble<vscode.SecretStorage>("secretStorage", {});
}

/**
 * A minimal in-memory `vscode.Memento`, deliberately NOT a `throwingDouble`.
 * `CommitPanelViewProvider`'s constructor legitimately reads `workspaceState`:
 * `loadStoredChangedFileCounts()` (`CommitPanelViewProvider.ts:426-437`) calls
 * `this.workspaceState?.get(...)` unconditionally during construction, so a `throwingDouble` would
 * throw before the provider finished constructing (or, if `workspaceState` were left `undefined`
 * instead, the optional-chained read would be skipped entirely -- a different, wrong path). This
 * double is deliberately EMPTY: any persisted changed-file count or commit draft is HOST state
 * (whatever a developer happened to leave in their own last session), not repository state, and
 * letting one leak into a committed fixture would make the fixture depend on whoever happened to
 * record it last. An empty store is the one deterministic, host-independent cold start.
 *
 * Exported for the same reason as {@link buildCommitPanelConstructorOptions}: emptiness is
 * invisible to every end-to-end assertion here. A Memento that returned a persisted commit draft
 * would push that host string straight into the recorded payload, and no local test would notice
 * -- the leak test only looks for paths, and the byte-identity test compares two recordings that
 * would share the same poisoned store. Only the repo-wide fixture gate catches it, and only after
 * the bad bytes are already committed. Asserting on this factory directly is the local oracle.
 */
export function createEmptyWorkspaceMemento(): vscode.Memento {
    const store = new Map<string, unknown>();
    return {
        get: ((key: string, defaultValue?: unknown) =>
            store.has(key) ? store.get(key) : defaultValue) as vscode.Memento["get"],
        update: async (key: string, value: unknown): Promise<void> => {
            if (value === undefined) store.delete(key);
            else store.set(key, value);
        },
        keys: (): readonly string[] => [...store.keys()],
    };
}

/** The four `CommitPanelViewProvider` constructor arguments {@link buildCommitPanelConstructorOptions}
 * builds -- see that function's own doc comment for why each is set the way it is. */
export interface CommitPanelConstructorOptions {
    readonly shelfServiceForRepository: (repositoryRoot: string) => ShelfService | undefined;
    readonly shelfRemoveOnUnshelve: boolean;
    readonly commitMessageGenerationCoordinator: CommitMessageGenerationCoordinator | undefined;
    readonly interactiveRebaseStorageRoot: string | undefined;
}

/**
 * Builds the four `CommitPanelViewProvider` constructor arguments (6th through 9th) that no
 * end-to-end assertion can distinguish from a wrong value: the `dirty`/`ready` path this recorder
 * drives never sends a shelf-specific, AI-commit-message-generation, or interactive-rebase
 * message, so any of these four could be swapped for something else and no recorded byte would
 * change. Extracted and exported for the identical reason `buildProviderOptions`
 * (`recordCommitGraphWebviewFixture.ts`, Phase 2c-iv-b) was: asserting on this pure function
 * directly is the only oracle that goes red when one of these four regresses.
 *
 *  - `shelfServiceForRepository: () => undefined` -- the `dirty` scenario seeds no shelves
 *    (`shelf-populated` is a separate scenario, out of scope here); `requireShelfService` throws
 *    only from shelf-specific messages, none of which `ready` sends.
 *  - `shelfRemoveOnUnshelve: true` -- matches production's usual setting
 *    (`shelfSettings.removeOnUnshelve`, `src/activation/repositoryMode.ts:311`).
 *  - `commitMessageGenerationCoordinator: undefined` -- the AI commit-message path; a recorder
 *    must never drive it.
 *  - `interactiveRebaseStorageRoot: undefined` -- production passes
 *    `context.globalStorageUri?.fsPath`, an ABSOLUTE HOST PATH; `PlaceholderRoots` has no slot for
 *    it, so a recorded value would be an unrewritable leak. `undefined` is safe exactly because
 *    this recording never reaches an interactive-rebase message.
 */
export function buildCommitPanelConstructorOptions(): CommitPanelConstructorOptions {
    return {
        shelfServiceForRepository: () => undefined,
        shelfRemoveOnUnshelve: true,
        commitMessageGenerationCoordinator: undefined,
        interactiveRebaseStorageRoot: undefined,
    };
}

/**
 * Records the `commit-panel` / `dirty` scenario end to end and returns the canonicalized,
 * ready-to-serialize fixture. Throws if the E2E control channel gate is inactive, or if the
 * capture seam allocated no sink despite the gate being active -- either is a recording-run
 * misconfiguration, never a fixture with fewer messages than intended. Mirrors
 * `recordCommitGraphWebviewFixture`'s own gate-check reasoning.
 */
export async function recordCommitPanelWebviewFixture(
    options: RecordCommitPanelWebviewFixtureOptions,
): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive()) {
        throw new Error(
            "recordCommitPanelWebviewFixture: the E2E control channel gate " +
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

    const constructorOptions = buildCommitPanelConstructorOptions();
    const provider = new CommitPanelViewProvider(
        createFakeExtensionUri(),
        new GitOps(new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env))),
        createFakeUriFromPath(options.repoRoot),
        createEmptyWorkspaceMemento(),
        createInertSecretStorage(),
        constructorOptions.shelfServiceForRepository,
        constructorOptions.shelfRemoveOnUnshelve,
        constructorOptions.commitMessageGenerationCoordinator,
        constructorOptions.interactiveRebaseStorageRoot,
    );
    const capturedProvider = captureWebviewViewProvider(provider, COMMIT_PANEL_CONTEXT_ID);

    const { webviewView, receiveMessage } = createFakeCommitPanelWebviewView();
    capturedProvider.resolveWebviewView(
        webviewView,
        INERT_RESOLVE_CONTEXT,
        INERT_CANCELLATION_TOKEN,
    );

    // The webview signals readiness once -- the real bootstrap sequence every host context's
    // bundled React app follows. `handleReadyMessage` (`CommitPanelViewProvider.ts:1424-1448`) is
    // `async` and is fully awaited here before any message it posts is read back.
    await receiveMessage({ type: "ready" });

    const sink = getE2eWebviewCaptureSink();
    if (!sink) {
        throw new Error(
            "recordCommitPanelWebviewFixture: isE2eControlChannelActive() was true, but no " +
                "capture sink was allocated. captureWebviewViewProvider only allocates one once a " +
                "webview is actually resolved (src/e2e/webviewCapture.ts) -- this means " +
                "resolveWebviewView never ran, which is a bug in this recorder, not an empty " +
                "scenario.",
        );
    }

    const captured = sink
        .getMessages()
        .filter((message) => message.contextId === COMMIT_PANEL_CONTEXT_ID);
    resetE2eWebviewCaptureSinkForTests();

    const canonicalized = canonicalizeCapturedMessages(captured, options.roots, []);
    return buildWebviewFixture(COMMIT_PANEL_CONTEXT_ID, COMMIT_PANEL_DIRTY_SCENARIO, canonicalized);
}
