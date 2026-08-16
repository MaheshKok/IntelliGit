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
import { CommitPanelViewProvider } from "../../../src/views/CommitPanelViewProvider";
import {
    buildCommitPanelConstructorOptions,
    createEmptyWorkspaceMemento,
} from "../../visual/recorder/recordCommitPanelWebviewFixture";
import { toGitEnvironment } from "../../visual/recorder/recordingGitEnvironment";
import { assertDirtyPostcondition } from "../../fixtures/repo/scenarios";
import { seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
import { createScratchWorkspaces } from "../fixtures/scratchWorkspaces";
import type { CommitDetail } from "../../../src/types";

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
function createInspectableCommitPanelWebviewView(): {
    readonly webviewView: vscode.WebviewView;
    readonly posted: unknown[];
    receiveMessage(message: unknown): Promise<void>;
} {
    let messageHandler: ((message: unknown) => unknown) | undefined;
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
            return Promise.resolve(true);
        },
    };

    const webviewView = {
        webview,
        visible: true,
        onDidDispose: () => inertDisposable(),
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
    };
}

function setCommitDetailMessages(posted: readonly unknown[]): Record<string, unknown>[] {
    return messagesOfType(posted, "setCommitDetail");
}

function messagesOfType(posted: readonly unknown[], type: string): Record<string, unknown>[] {
    return posted.filter(
        (message): message is Record<string, unknown> =>
            isRecord(message) && message.type === type,
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

    it(
        "answers a re-ask from state it already holds, without repeating the startup Git reads",
        async () => {
            const parentDir = await mkdtemp(
                path.join(tmpdir(), "intelligit-commit-panel-reask-test-"),
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
        },
        30_000,
    );

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
    it(
        "does the full startup read for a re-ask when the first attempt never reached the host",
        async () => {
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

            const { webviewView, posted, receiveMessage } =
                createInspectableCommitPanelWebviewView();
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
        },
        30_000,
    );
});
