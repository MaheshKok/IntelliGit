/**
 * Provider-level test for the `CommitPanelViewProvider` webview-reload re-post fix
 * (`src/views/CommitPanelViewProvider.ts`).
 *
 * VS Code tears a hidden `WebviewView`'s context down and reloads it on show: the webview script
 * re-runs and re-announces itself with a second `ready` message, but `resolveWebviewView` does NOT
 * run again for that reload -- so its own `lastPostedPayload` reset (`:1065`) never fires.
 * `handleReadyMessage` (`:1440`) resets `lastPostedPayload = undefined` as its own first statement
 * (`:1446`) for exactly this reason: a fresh webview context has received nothing, so whatever
 * `postGraphCommitDetailState` (`:1972`) posts during this handler must never be suppressed as a
 * duplicate of what the PREVIOUS, now-dead context received -- even when the payload is
 * byte-identical. Without that reset, `isRedundantPost` (`shared/postedPayload.ts`) would compare
 * the unchanged commit-detail payload against the stale `lastPostedPayload` left over from the
 * pre-reload context, silently suppress the post, and leave the restored pane empty.
 *
 * `handleReadyMessage` never calls `postGraphCommitDetailState` directly -- it only reaches it
 * through `refreshGraphData(runtime)` (`:1463`), itself only invoked `if (runtime)`, i.e. only when
 * an active repository runtime exists. This test constructs the provider against a REAL seeded git
 * repository (mirroring `recordCommitPanelWebviewFixture.ts`'s construction recipe) so that path is
 * real, not assumed: the "reaches refreshGraphData" claim is what the post-count assertion below
 * actually exercises, not something asserted separately.
 *
 * Observation seam: `createFakeCommitPanelWebviewView()` (`commitInfoVscodeDouble.ts`) discards
 * every posted message (`postMessage: () => Promise.resolve(true)`), so this file builds its own
 * local inspectable double instead -- same choice, and the same reasoning, as
 * `CommitInfoViewProvider.test.ts`'s own `createInspectableFakeWebviewView`, the closest existing
 * model for this file's style. Its exact member set differs, though:
 * `CommitPanelViewProvider.resolveWebviewView` (`:1095-1101`) reads `webviewView.visible` and
 * calls `webviewView.onDidChangeVisibility(...)` unconditionally -- members
 * `CommitInfoViewProvider.resolveWebviewView` never reaches for -- so the double below instead
 * mirrors `createFakeCommitPanelWebviewView`'s own member set (`webview.*`, `onDidDispose`,
 * `visible`, `onDidChangeVisibility`), with an inspectable `posted` array standing in for the
 * discarding `postMessage`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

// Hoisted above the imports below -- see `recordCommitPanelWebviewFixture.test.ts` / `CommitInfoViewProvider.test.ts`
// for this exact convention. Reused unchanged: `commit-panel` forces no new `vscode` member (see
// `commitInfoVscodeDouble.ts`'s own doc comment).
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import type * as vscode from "vscode";
import {
    createFakeExtensionUri,
    createFakeUriFromPath,
} from "../../visual/recorder/commitInfoVscodeDouble";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import {
    CommitPanelViewProvider,
    affectsExpandedRow,
} from "../../../src/views/CommitPanelViewProvider";
import type { RepositoryWorkingTreeChange } from "../../../src/services/repositoryChangeEvents";
import {
    buildCommitPanelConstructorOptions,
    createEmptyWorkspaceMemento,
} from "../../visual/recorder/recordCommitPanelWebviewFixture";
import { toGitEnvironment } from "../../visual/recorder/recordingGitEnvironment";
import { assertDirtyPostcondition } from "../../fixtures/repo/scenarios";
import { seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
import { createScratchWorkspaces } from "../fixtures/scratchWorkspaces";
import type { CommitDetail } from "../../../src/types";
import type { CommitGraphInbound } from "../../../src/webviews/protocol/commitGraphTypes";

/** A resolve-context/token stand-in `resolveWebviewView` never reads -- same reasoning as
 * `recordCommitPanelWebviewFixture.ts`'s own `INERT_RESOLVE_CONTEXT`/`INERT_CANCELLATION_TOKEN`. */
const INERT_CONTEXT = {} as vscode.WebviewViewResolveContext;
const INERT_TOKEN = {} as vscode.CancellationToken;

function inertDisposable(): vscode.Disposable {
    return { dispose(): void {} };
}

/** Resolves once every microtask / `setImmediate` callback queued synchronously up to this call
 * has drained -- see `CommitInfoViewProvider.test.ts`'s own `flushMicrotasks` doc comment: a
 * single `setImmediate` tick is sufficient to observe `decorateAndStoreCommitDetail`'s settled
 * effects in this double (no real timer or I/O wait anywhere in its chain). */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Local inspectable `vscode.WebviewView` double. See this file's own doc comment for why its
 * member set mirrors `createFakeCommitPanelWebviewView` (`commitInfoVscodeDouble.ts`) --
 * `webview.*`, `onDidDispose`, `visible`, `onDidChangeVisibility` -- rather than the narrower set
 * `CommitInfoViewProvider.test.ts`'s own inspectable double needs.
 */
/**
 * The three answers a real VS Code host gives `webview.postMessage`. `"refused"` is a resolved
 * `false` -- the host took the call and did not deliver it -- and `"rejected"` is the promise
 * failing outright. Both are indistinguishable from `"delivered"` to a caller that drops the
 * returned promise, which is what the delivery-failure block at the bottom of this file pins down.
 */
type DeliveryOutcome = "delivered" | "refused" | "rejected";

/**
 * What `WebviewView.visible` answers. `"disposed"` is not a third visibility -- it is the absence of
 * an answer: every getter on a disposed `WebviewView` raises instead of returning, so code that
 * reads one has to decide what an unreadable view means rather than receiving a boolean.
 */
type Visibility = boolean | "disposed";

function createInspectableCommitPanelWebviewView(
    outcome: DeliveryOutcome = "delivered",
    visible: Visibility = true,
): {
    readonly webviewView: vscode.WebviewView;
    readonly posted: unknown[];
    receiveMessage(message: unknown): Promise<void>;
    disposeView(): void;
} {
    let messageHandler: ((message: unknown) => unknown) | undefined;
    let disposeHandler: (() => void) | undefined;
    const posted: unknown[] = [];

    const webview = {
        options: {} as vscode.WebviewOptions,
        html: "",
        cspSource: "vscode-webview://fake-commit-panel-provider-test",
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
            messageHandler = listener;
            return inertDisposable();
        },
        postMessage: (message: unknown) => {
            posted.push(message);
            if (outcome === "rejected") {
                return Promise.reject(new Error("Webview is disposed"));
            }
            return Promise.resolve(outcome === "delivered");
        },
    };

    const webviewView = {
        webview,
        get visible(): boolean {
            if (visible === "disposed") {
                throw new Error("Webview is disposed");
            }
            return visible;
        },
        onDidDispose: (listener: () => void) => {
            disposeHandler = listener;
            return inertDisposable();
        },
        onDidChangeVisibility: () => inertDisposable(),
    } as unknown as vscode.WebviewView;

    return {
        webviewView,
        posted,
        receiveMessage: async (message: unknown): Promise<void> => {
            if (!messageHandler) {
                throw new Error(
                    "createInspectableCommitPanelWebviewView.receiveMessage: no message handler " +
                        "was registered yet -- resolveWebviewView() must run first.",
                );
            }
            await messageHandler(message);
        },
        disposeView: (): void => {
            if (!disposeHandler) {
                throw new Error(
                    "createInspectableCommitPanelWebviewView.disposeView: no dispose handler was " +
                        "registered yet -- resolveWebviewView() must run first.",
                );
            }
            disposeHandler();
        },
    };
}

function setCommitDetailMessages(posted: readonly unknown[]): Record<string, unknown>[] {
    return messagesOfType(posted, "setCommitDetail");
}

function messagesOfType(posted: readonly unknown[], type: string): Record<string, unknown>[] {
    return posted.filter(
        (message): message is Record<string, unknown> => isRecord(message) && message.type === type,
    );
}

function sampleDetail(): CommitDetail {
    return {
        hash: "b08ddf030532f359194329a212f0d9ba54bb6a02",
        shortHash: "b08ddf03",
        message: "Add conflict target",
        body: "",
        author: "IntelliGit Fixture Repo",
        email: "intelligit-fixture@example.invalid",
        date: "2000-01-01T01:00:00Z",
        parentHashes: ["70fa528600605d9b3f1fce7aa04ec799ed494ffd"],
        refs: [],
        files: [{ path: "conflict.txt", status: "A", additions: 3, deletions: 0 }],
    };
}

const scratch = createScratchWorkspaces();

/** Mirrors `recordCommitPanelWebviewFixture.test.ts`'s own (non-exported) `prepareDirtyWorkspace`:
 * seeds one real git working tree and confirms it landed in the `dirty` postcondition
 * `seedFixtureTemplate` always leaves it in. `dirty`, not `clean`, only because that is the
 * scenario the sibling recorder test already established as safe for this provider -- this test's
 * own assertions do not depend on working-tree dirtiness at all. */
async function prepareDirtyWorkspace(destination: string): Promise<FixtureTemplate> {
    const template = await seedFixtureTemplate(destination);
    scratch.register(template.home);
    await assertDirtyPostcondition(template.root, template.env);
    return template;
}

describe("CommitPanelViewProvider reload re-post", () => {
    afterEach(async () => {
        await scratch.removeAll();
    });

    it(
        "re-posts the unchanged commit detail after a webview reload's second `ready`, because " +
            "resolveWebviewView does not re-run and a fresh context has received nothing",
        async () => {
            const parentDir = await mkdtemp(
                path.join(tmpdir(), "intelligit-commit-panel-provider-test-"),
            );
            scratch.register(parentDir);
            const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

            const constructorOptions = buildCommitPanelConstructorOptions();
            const gitOps = new GitOps(
                new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env)),
            );
            const provider = new CommitPanelViewProvider(
                createFakeExtensionUri(),
                gitOps,
                createFakeUriFromPath(workspace.root),
                createEmptyWorkspaceMemento(),
                undefined, // secrets -- nothing on this path reads a secret.
                constructorOptions.shelfServiceForRepository,
                constructorOptions.shelfRemoveOnUnshelve,
                constructorOptions.commitMessageGenerationCoordinator,
                constructorOptions.interactiveRebaseStorageRoot,
            );

            const { webviewView, posted, receiveMessage } =
                createInspectableCommitPanelWebviewView();
            provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
            await receiveMessage({ type: "ready" });

            provider.setCommitDetail(sampleDetail());
            await flushMicrotasks();

            const beforeReload = setCommitDetailMessages(posted);
            expect(
                beforeReload.length,
                "setCommitDetail() must post at least once before the reload scenario begins",
            ).toBeGreaterThanOrEqual(1);
            const countBeforeReload = beforeReload.length;

            // VS Code tears a hidden WebviewView's context down and reloads it on show. The
            // script re-runs and re-announces itself with a second `ready`, but the provider is
            // already resolved -- resolveWebviewView, and its own `lastPostedPayload` reset, does
            // NOT run again. No intervening resolveWebviewView call here is the point.
            await receiveMessage({ type: "ready" });
            await flushMicrotasks();

            const afterReload = setCommitDetailMessages(posted);
            expect(
                afterReload.length,
                "the reloaded webview's second `ready` must reach postGraphCommitDetailState " +
                    "(via refreshGraphData) and re-post the commit detail -- a guard keyed only " +
                    "on payload equality would have wrongly swallowed exactly this repost",
            ).toBeGreaterThan(countBeforeReload);
            expect(
                afterReload[afterReload.length - 1],
                "the re-post to the reloaded webview must be byte-identical to what the dead " +
                    "context received -- byte-identical is the whole point of this regression",
            ).toEqual(beforeReload[beforeReload.length - 1]);
        },
        30_000,
    );
});

/**
 * The panel's only route to content is the host's answer to `ready`, and nothing about that
 * exchange is acknowledged -- VS Code's `postMessage` resolves `false` for a webview that is not
 * live, and its contract says even a `true` does not mean the message was received. So the webview
 * re-asks while it is still unhydrated (`useExtensionMessages.ts`), and it used to stop after
 * fifteen tries: each re-ask cost the host a full Git refresh, so an unbounded retry would have
 * been a stampede. Stopping is what turned one dropped message into a permanently blank pane, which
 * is what CI run 31964819068 captured -- a mounted React app that had rendered
 * `commit-panel-awaiting-hydration` and nothing else, beside a host whose badge read "5 changed
 * files" and whose graph webview had rendered every commit.
 *
 * `attempt` is what makes the retry affordable, so this pins the two halves that have to hold at
 * once: a re-ask is still ANSWERED with everything the host already holds (otherwise the retry
 * cannot recover the panel and the whole mechanism is decorative), and it does NOT repeat the Git
 * reads (otherwise the retry cannot be unbounded). `refreshing` is the observable for the second
 * half: `postRefreshing` brackets the full-refresh branch and nothing else posts it.
 */
describe("CommitPanelViewProvider hydration re-ask", () => {
    afterEach(async () => {
        await scratch.removeAll();
    });

    it("answers a re-ask from state it already holds, without repeating the startup Git reads", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-commit-panel-reask-test-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const gitOps = new GitOps(
            new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env)),
        );
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            gitOps,
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const { webviewView, posted, receiveMessage } = createInspectableCommitPanelWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);

        await receiveMessage({ type: "ready", attempt: 1 });
        await flushMicrotasks();
        const afterFirst = posted.length;
        expect(
            messagesOfType(posted, "setRepositories").length,
            "a first announcement must be hydrated",
        ).toBeGreaterThanOrEqual(1);
        expect(
            messagesOfType(posted, "refreshing").length,
            "a first announcement must run the startup refresh -- otherwise the assertion " +
                "below proves nothing, because `refreshing` would be absent either way",
        ).toBeGreaterThan(0);

        const hydrationsBeforeReAsk = messagesOfType(posted, "setRepositories").length;
        const refreshesBeforeReAsk = messagesOfType(posted, "refreshing").length;

        // The webview is still mounted and still empty: it never received the answer above.
        await receiveMessage({ type: "ready", attempt: 2 });
        await flushMicrotasks();

        expect(
            messagesOfType(posted, "setRepositories").length,
            "a re-ask must be answered -- the panel is unhydrated precisely because the " +
                "previous answer never arrived, so withholding this one strands it forever",
        ).toBeGreaterThan(hydrationsBeforeReAsk);
        expect(
            messagesOfType(posted, "refreshing").length,
            "a re-ask must NOT repeat the startup Git refresh; the webview re-asks on a " +
                "timer, so paying full price per attempt is the cost that forced the retry " +
                "to give up and leave the panel blank",
        ).toBe(refreshesBeforeReAsk);
        expect(
            posted.length,
            "a re-ask must still deliver the host's cached working-tree state, not the " +
                "repository list alone -- the dropped answer took the file list with it",
        ).toBeGreaterThan(afterFirst + 1);
    }, 30_000);

    /**
     * The other direction of the same drop, and the one that makes "answer a re-ask from cache" a
     * trap rather than an optimization. A `ready` can be lost on the way IN, and then the host never
     * ran the startup read at all -- so its working-tree cache is still the empty one the runtime
     * was constructed with (`snapshotForRuntime` serves `runtime.files` verbatim). Answering that
     * re-ask from cache posts a repository with zero changed files to a panel that would then render
     * a confident, wrong "nothing to commit" over a dirty tree. Silently wrong beats visibly blank
     * only from the host's side of the wire.
     *
     * So the skip is conditioned on the read having actually happened, not on the attempt number
     * alone. The assertion is on the delivered file list rather than on any internal marker: an
     * unhydrated panel's whole problem is what it did or did not receive.
     */
    it("does the full startup read for a re-ask when the first attempt never reached the host", async () => {
        const parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-commit-panel-cold-reask-test-"),
        );
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const gitOps = new GitOps(
            new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env)),
        );
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            gitOps,
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const { webviewView, posted, receiveMessage } = createInspectableCommitPanelWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);

        // No attempt 1 anywhere: this is what a `ready` lost on the way in looks like from the
        // host's side -- the panel is on its second try and the host is hearing from it first.
        await receiveMessage({ type: "ready", attempt: 2 });
        await flushMicrotasks();

        const deliveredFileCounts = messagesOfType(posted, "update").map((message) =>
            Array.isArray(message.files) ? message.files.length : -1,
        );
        expect(
            Math.max(-1, ...deliveredFileCounts),
            "the workspace is dirty, so at least one delivered snapshot must carry files; " +
                "skipping the startup read here posts an empty tree the panel cannot tell " +
                "apart from a clean one",
        ).toBeGreaterThan(0);
    }, 30_000);
});

/**
 * `postMessage` is the only wire the panel has, and VS Code answers it three ways: delivered,
 * accepted-but-not-delivered (a resolved `false`), and rejected. The host used to treat all three
 * as success -- `this.view?.webview.postMessage(msg)`, promise dropped -- so a panel that never
 * received its hydration looked, from the extension's side, exactly like one that did. That is the
 * shape of the intermittent blank commit panel in CI: the panel sits at `awaiting-hydration`
 * through every retry while the host believes it answered each one.
 *
 * These tests are about the DIAGNOSTIC, not about recovery. Nothing here can make a dead webview
 * accept a message; what it can do is stop a failure from being indistinguishable from a success.
 * The assertion is on `console.error` specifically because that is the channel the E2E harness
 * reads -- `tests/e2e/pageObjects/intelliGitView.ts` folds the extension host's console into its
 * failure message -- so the next CI red names which leg dropped the message instead of only
 * reporting that the panel came up blank.
 *
 * The rejection case carries a second defect: the old code left the returned promise floating, so
 * a rejecting `postMessage` surfaced in the host as an unhandled rejection. Asserting the reason
 * reaches the log proves a rejection handler is attached, which is what prevents it.
 *
 * `showRebaseDialog` is the vehicle because it is the one public method that reaches
 * `postToWebview` in a single call with no git I/O behind it -- the wire is the subject here, not
 * whatever payload happens to be travelling on it.
 */
describe("CommitPanelViewProvider webview delivery failures", () => {
    let restoreConsole: (() => void) | undefined;

    afterEach(() => {
        restoreConsole?.();
        restoreConsole = undefined;
    });

    function captureConsoleErrors(): string[] {
        const lines: string[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            lines.push(args.map((arg) => String(arg)).join(" "));
        });
        restoreConsole = () => spy.mockRestore();
        return lines;
    }

    /** No disk is touched on this path: nothing between construction and `postToWebview` runs git. */
    function resolveProviderWith(outcome: DeliveryOutcome): {
        provider: CommitPanelViewProvider;
        posted: unknown[];
    } {
        const repoRoot = path.join(tmpdir(), "intelligit-delivery-failure-no-io");
        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(repoRoot)),
            createFakeUriFromPath(repoRoot),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );
        const { webviewView, posted } = createInspectableCommitPanelWebviewView(outcome);
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        return { provider, posted };
    }

    function rebaseDialogMessage(): Extract<CommitGraphInbound, { type: "showRebaseDialog" }> {
        return {
            type: "showRebaseDialog",
            requestId: "delivery-failure-test",
            commits: [],
            branch: "refs/heads/main",
            hasPushed: false,
        };
    }

    it("reports a message the webview accepted and never delivered", async () => {
        const errors = captureConsoleErrors();
        const { provider, posted } = resolveProviderWith("refused");

        provider.showRebaseDialog(rebaseDialogMessage());
        await flushMicrotasks();

        expect(
            messagesOfType(posted, "showRebaseDialog"),
            "the message must still be handed to VS Code -- this is about the answer, not the send",
        ).toHaveLength(1);
        expect(
            errors.join("\n"),
            "a resolved `false` means the panel never got the message; saying nothing about it " +
                "leaves an unhydrated panel indistinguishable from a hydrated one, which is " +
                "precisely why the blank-panel failures in CI carry no host-side evidence",
        ).toContain("showRebaseDialog");
    });

    it("reports a message postMessage rejected, and keeps the reason", async () => {
        const errors = captureConsoleErrors();
        const { provider } = resolveProviderWith("rejected");

        provider.showRebaseDialog(rebaseDialogMessage());
        await flushMicrotasks();

        const reported = errors.join("\n");
        expect(
            reported,
            "a rejected postMessage was dropped on an un-awaited promise, which both hid the " +
                "failure and raised an unhandled rejection in the extension host",
        ).toContain("showRebaseDialog");
        expect(
            reported,
            "reporting that a post failed without the reason leaves the next reader exactly " +
                "where the silent version did -- the cause is the whole payload",
        ).toContain("Webview is disposed");
    });
});

/**
 * The panel's only hydration path is the host's answer to `ready`, and `postToWebview` answers
 * through the provider's cached `this.view` rather than through the webview that actually asked.
 * Those are not the same thing. `onDidDispose` clears `this.view`, and `handleReadyMessage`'s own
 * comment records that VS Code tears a hidden view's context down and reloads it on show WITHOUT
 * re-running `resolveWebviewView` -- so a `ready` can arrive while the record is empty. It is then
 * answered to nothing, and `postToWebview`'s `if (!view) return` is the single path in the entire
 * delivery layer that logs nothing at all: every other outcome goes through `postWebviewMessage`,
 * which reports refusals and rejections. The pane stays blank for the rest of the session with no
 * host-side evidence.
 *
 * That is exactly the signature CI keeps capturing on `e2e-full`: a mounted React app rendering
 * `commit-panel-awaiting-hydration` -- which `SET_REPOSITORIES` would have cleared unconditionally,
 * even for an empty list, so it proves zero hydrations were applied -- beside a clean extension-host
 * console, next to a fully populated graph webview.
 *
 * The invariant pinned here is the protocol one, not a repair recipe: a request that arrives from a
 * live webview must be answered TO that webview. A webview that just posted a message is alive by
 * construction, whatever the provider's own record happens to say.
 */
describe("CommitPanelViewProvider hydration answers the webview that asked", () => {
    afterEach(async () => {
        await scratch.removeAll();
    });

    it("answers a `ready` from a live webview whose view record was already cleared", async () => {
        // A REAL seeded working tree, not a bare path: `handleReadyMessage` runs git behind
        // `postRepositoryListHydration`, and against a non-existent root it throws `spawn git
        // ENOENT` -- which fails this test through the error path instead of through its own
        // assertion, and so would prove nothing about hydration either way.
        const parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-ready-after-view-record-loss-"),
        );
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const { webviewView, posted, receiveMessage, disposeView } =
            createInspectableCommitPanelWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        const hydrationsBefore = messagesOfType(posted, "setRepositories").length;

        // VS Code disposes the WebviewView when the container is hidden. The webview document can
        // outlive that record and re-announce itself without `resolveWebviewView` running again --
        // the case `handleReadyMessage`'s own comment already describes. No re-resolve here is the
        // entire point: a test that resolved again would restore `this.view` and prove nothing.
        disposeView();
        await receiveMessage({ type: "ready", attempt: 2 });
        await flushMicrotasks();

        expect(
            messagesOfType(posted, "setRepositories").length,
            "a `ready` from a webview that is provably live -- it just posted this very message " +
                "-- must be answered to that webview. Answering through a cleared `this.view` " +
                "drops the reply in silence and strands the pane on " +
                "commit-panel-awaiting-hydration for the rest of the session, however many times " +
                "the webview re-asks",
        ).toBeGreaterThan(hydrationsBefore);
    });

    it("keeps answering the view on screen when a replaced view posts a late message", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-stale-sender-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        // VS Code replaced the view: a second resolve, so `this.view` is the NEW one and is not
        // empty. The old document can still post -- a retained context, or a message already in
        // flight when the replacement landed.
        const replaced = createInspectableCommitPanelWebviewView();
        provider.resolveWebviewView(replaced.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const onScreen = createInspectableCommitPanelWebviewView();
        provider.resolveWebviewView(onScreen.webviewView, INERT_CONTEXT, INERT_TOKEN);

        const replacedBefore = messagesOfType(replaced.posted, "setRepositories").length;
        const onScreenBefore = messagesOfType(onScreen.posted, "setRepositories").length;

        await replaced.receiveMessage({ type: "ready", attempt: 2 });
        await flushMicrotasks();

        expect(
            messagesOfType(onScreen.posted, "setRepositories").length,
            "the reply must go to the view actually on screen -- adopting every sender would " +
                "hand the record back to a view VS Code already replaced, and blank the live " +
                "pane to un-blank a dead one",
        ).toBeGreaterThan(onScreenBefore);
        expect(
            messagesOfType(replaced.posted, "setRepositories").length,
            "a replaced view must not capture the provider's view record just by posting: the " +
                "visibility guard is what keeps adoption a recovery rather than a hijack",
        ).toBe(replacedBefore);
    });

    it("adopts a visible sender over a hidden cached view", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-visible-sender-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const visibleSender = createInspectableCommitPanelWebviewView("delivered", true);
        provider.resolveWebviewView(visibleSender.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const hiddenCached = createInspectableCommitPanelWebviewView("delivered", false);
        provider.resolveWebviewView(hiddenCached.webviewView, INERT_CONTEXT, INERT_TOKEN);

        const visibleBefore = messagesOfType(visibleSender.posted, "setRepositories").length;
        const hiddenBefore = messagesOfType(hiddenCached.posted, "setRepositories").length;

        await visibleSender.receiveMessage({ type: "ready", attempt: 2 });
        await flushMicrotasks();

        expect(
            messagesOfType(visibleSender.posted, "setRepositories").length,
            "a visible sender must receive hydration when the cached view is hidden",
        ).toBeGreaterThan(visibleBefore);
        expect(
            messagesOfType(hiddenCached.posted, "setRepositories").length,
            "a hidden cached view must not receive hydration from the visible sender",
        ).toBe(hiddenBefore);
    });

    /**
     * Both tests below are about the same thing from opposite sides: the ownership decision reads
     * `visible` on two views, and a disposed `WebviewView` answers neither read -- it raises.
     *
     * Reading one used to happen before the caller's `try`, so the raise rejected the message
     * listener outright. Nothing was posted, nothing was shown, nothing was logged, and every
     * retry died at the identical line -- which is what an unhydrated panel looks like in CI:
     * `asks:18 received:0` from the webview's own counters, beside a host holding a fully
     * populated repository.
     *
     * The two directions cannot share a default. An unreadable RECORDED view has to yield, because
     * it can no longer render what it is being handed; an unreadable SENDER has to be answered,
     * because it just spoke. One constant for both strands the panel on whichever side it gets
     * wrong, so each is pinned separately here.
     */
    it("answers a live sender when the recorded view can no longer be read", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-dead-record-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const onScreen = createInspectableCommitPanelWebviewView("delivered", true);
        provider.resolveWebviewView(onScreen.webviewView, INERT_CONTEXT, INERT_TOKEN);
        // Resolved second, so it owns the record. VS Code disposed it without this provider's
        // dispose handler clearing the record -- that handler only fires for the view it was
        // registered on, so a record can outlive the view it names.
        const disposedRecord = createInspectableCommitPanelWebviewView("delivered", "disposed");
        provider.resolveWebviewView(disposedRecord.webviewView, INERT_CONTEXT, INERT_TOKEN);

        const onScreenBefore = messagesOfType(onScreen.posted, "setRepositories").length;

        await onScreen.receiveMessage({ type: "ready", attempt: 18 });
        await flushMicrotasks();

        expect(
            messagesOfType(onScreen.posted, "setRepositories").length,
            "a panel asking for hydration must be answered even when the record names a view " +
                "that can no longer answer for itself; the alternative is a pane that asks " +
                "forever and is never told anything",
        ).toBeGreaterThan(onScreenBefore);
    });

    it("answers a sender it can no longer read rather than the hidden view holding the record", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-unreadable-sender-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined,
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const sender = createInspectableCommitPanelWebviewView("delivered", "disposed");
        provider.resolveWebviewView(sender.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const hiddenCached = createInspectableCommitPanelWebviewView("delivered", false);
        provider.resolveWebviewView(hiddenCached.webviewView, INERT_CONTEXT, INERT_TOKEN);

        const senderBefore = messagesOfType(sender.posted, "setRepositories").length;
        const hiddenBefore = messagesOfType(hiddenCached.posted, "setRepositories").length;

        await sender.receiveMessage({ type: "ready", attempt: 18 });
        await flushMicrotasks();

        expect(
            messagesOfType(sender.posted, "setRepositories").length,
            "a view that just delivered a message is the one waiting for the answer, whether or " +
                "not its visibility can be read; a post that fails from here is reported, where " +
                "withholding it is not",
        ).toBeGreaterThan(senderBefore);
        expect(
            messagesOfType(hiddenCached.posted, "setRepositories").length,
            "the hidden cached view asked for nothing and must not be answered in its place",
        ).toBe(hiddenBefore);
    });

    /**
     * The third row of the ownership table, and the one the two tests above straddle without
     * covering: the record is unreadable AND the sender is hidden.
     *
     * A hidden sender is not a quiet one -- VS Code reloads a hidden view's document without
     * re-running `resolveWebviewView`, which is the very case this whole path exists for, so the
     * `ready` arriving here is from a live view that will render the moment its pane is shown.
     * The recorded view, by contrast, can no longer be read and so can no longer render anything
     * at all. Keeping ownership there answers a view that cannot listen and strands the one that
     * asked, which is the exact silence the adoption logic was written to end.
     */
    it("answers a hidden sender when the recorded view can no longer be read", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-dead-record-hidden-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const hiddenSender = createInspectableCommitPanelWebviewView("delivered", false);
        provider.resolveWebviewView(hiddenSender.webviewView, INERT_CONTEXT, INERT_TOKEN);
        // Resolved second, so it holds the record when the hidden view speaks.
        const disposedRecord = createInspectableCommitPanelWebviewView("delivered", "disposed");
        provider.resolveWebviewView(disposedRecord.webviewView, INERT_CONTEXT, INERT_TOKEN);

        const hiddenBefore = messagesOfType(hiddenSender.posted, "setRepositories").length;

        await hiddenSender.receiveMessage({ type: "ready", attempt: 18 });
        await flushMicrotasks();

        expect(
            messagesOfType(hiddenSender.posted, "setRepositories").length,
            "a hidden view that asked for hydration is still the only view that can ever render " +
                "the answer; a record that cannot be read has no claim to outrank it",
        ).toBeGreaterThan(hiddenBefore);
    });

    it("reposts unchanged commit detail to a newly adopted visible sender", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-visible-sender-detail-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined,
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const visibleSender = createInspectableCommitPanelWebviewView("delivered", true);
        provider.resolveWebviewView(visibleSender.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const hiddenCached = createInspectableCommitPanelWebviewView("delivered", false);
        provider.resolveWebviewView(hiddenCached.webviewView, INERT_CONTEXT, INERT_TOKEN);

        const detail = sampleDetail();
        provider.setCommitDetail(detail);
        await flushMicrotasks();

        const hiddenDetailMessages = setCommitDetailMessages(hiddenCached.posted);
        expect(
            hiddenDetailMessages.length,
            "the hidden cached view must own the initial commit-detail payload before adoption",
        ).toBeGreaterThanOrEqual(1);
        const cursorOwningPayload = hiddenDetailMessages[hiddenDetailMessages.length - 1];

        const visibleBeforeSelect = setCommitDetailMessages(visibleSender.posted).length;
        await visibleSender.receiveMessage({ type: "selectCommit", hash: detail.hash });
        await flushMicrotasks();
        expect(
            setCommitDetailMessages(visibleSender.posted).length,
            "selectCommit itself must not post commit detail while the visible sender takes ownership",
        ).toBe(visibleBeforeSelect);

        const visibleBeforeRepost = setCommitDetailMessages(visibleSender.posted).length;
        const hiddenBeforeRepost = setCommitDetailMessages(hiddenCached.posted).length;
        provider.setCommitDetail(detail);
        await flushMicrotasks();

        const visibleAfterRepost = setCommitDetailMessages(visibleSender.posted);
        expect(
            visibleAfterRepost.length,
            "visible adoption must reset the commit-detail dedupe cursor so the unchanged detail is reposted",
        ).toBeGreaterThan(visibleBeforeRepost);
        expect(
            setCommitDetailMessages(hiddenCached.posted).length,
            "the hidden cached view must not receive the post after visible adoption",
        ).toBe(hiddenBeforeRepost);
        expect(visibleAfterRepost[visibleAfterRepost.length - 1]).toEqual(cursorOwningPayload);
    });

    it("retains a hidden cached view when the late sender is also hidden", async () => {
        const parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-hidden-senders-"));
        scratch.register(parentDir);
        const workspace = await prepareDirtyWorkspace(path.join(parentDir, "root"));

        const constructorOptions = buildCommitPanelConstructorOptions();
        const provider = new CommitPanelViewProvider(
            createFakeExtensionUri(),
            new GitOps(new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env))),
            createFakeUriFromPath(workspace.root),
            createEmptyWorkspaceMemento(),
            undefined, // secrets -- nothing on this path reads a secret.
            constructorOptions.shelfServiceForRepository,
            constructorOptions.shelfRemoveOnUnshelve,
            constructorOptions.commitMessageGenerationCoordinator,
            constructorOptions.interactiveRebaseStorageRoot,
        );

        const hiddenSender = createInspectableCommitPanelWebviewView("delivered", false);
        provider.resolveWebviewView(hiddenSender.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const hiddenCached = createInspectableCommitPanelWebviewView("delivered", false);
        provider.resolveWebviewView(hiddenCached.webviewView, INERT_CONTEXT, INERT_TOKEN);

        const senderBefore = messagesOfType(hiddenSender.posted, "setRepositories").length;
        const cachedBefore = messagesOfType(hiddenCached.posted, "setRepositories").length;

        await hiddenSender.receiveMessage({ type: "ready", attempt: 2 });
        await flushMicrotasks();

        expect(
            messagesOfType(hiddenCached.posted, "setRepositories").length,
            "when both views are hidden, the recorded view remains the hydration owner",
        ).toBeGreaterThan(cachedBefore);
        expect(
            messagesOfType(hiddenSender.posted, "setRepositories").length,
            "a hidden sender must not replace another hidden recorded view",
        ).toBe(senderBefore);
    });
});

// The row watcher used to be a `createFileSystemWatcher`, so "what reaches this row" was
// decided by the OS and never needed asserting. It is now a filter over a shared stream that
// also carries Git metadata and one event per keystroke, so the decision is code -- and the
// listener that applies it needs a live provider, a repository runtime and an expanded row to
// reach. The predicate is extracted so the rule itself can be asserted directly.
describe("expanded-row refresh filter", () => {
    const event = (
        overrides: Partial<RepositoryWorkingTreeChange>,
    ): RepositoryWorkingTreeChange => ({
        repoRoot: "/repo",
        path: "src/example.ts",
        source: "workspace-file",
        ...overrides,
    });

    it("refreshes on a write that lands on disk", () => {
        expect(affectsExpandedRow(event({}))).toBe(true);
    });

    it("skips an edit that is still only in the editor buffer", () => {
        expect(
            affectsExpandedRow(event({ unsaved: true })),
            "an unsaved edit re-runs `git status`, which cannot change until the write lands, once per typing burst for the lifetime of the expanded row",
        ).toBe(false);
    });

    it("skips Git metadata, as the filesystem watcher it replaced did", () => {
        expect(affectsExpandedRow(event({ source: "git-index" }))).toBe(false);
        expect(affectsExpandedRow(event({ source: "git-state" }))).toBe(false);
    });
});
