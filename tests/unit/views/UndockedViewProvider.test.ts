/**
 * Regression test for the `lastPostedPayload` reset inside `UndockedViewProvider`'s `ready` message
 * handler (`src/views/UndockedViewProvider.ts:949`, immediately before the `postCommitDetailState()`
 * call at `:950`).
 *
 * `postCommitDetailState()` (`:1908`) guards outgoing `setCommitDetail` posts against
 * `lastPostedPayload`, an exact-byte duplicate check (`src/views/shared/postedPayload.ts`).
 * `lastPostedPayload` is also reset when `open()` creates a brand new panel (`:688`) -- but that
 * branch does NOT run again just because the webview reloads. This panel sets
 * `retainContextWhenHidden: true` (`:683`), yet VS Code can still tear down and rebuild the
 * webview's OWN script context on a window/webview reload, which re-announces itself with a second
 * `ready` message while `this.panel` itself is untouched. Without the SECOND reset at `:949`, that
 * second `ready` would call `postCommitDetailState()` against a `lastPostedPayload` still holding
 * what the OLD, now-dead context received, so the identical-looking repost the reloaded context
 * actually needs would be wrongly suppressed as a duplicate -- and the restored pane would render
 * empty.
 *
 * Observation seam: option (a), a small local inspectable `postMessage`, in the style of
 * `createInspectableFakeWebviewView()` in the sibling
 * `tests/unit/views/CommitInfoViewProvider.test.ts` (which pins the identical invariant for the
 * `WebviewView`-based `CommitInfoViewProvider`). Unlike that provider, `UndockedViewProvider` owns a
 * `vscode.WebviewPanel` it creates ITSELF, internally, inside `open()` by calling
 * `vscode.window.createWebviewPanel(...)` -- there is no view object this test can build and hand in
 * directly. `webviewPanelDouble.ts`'s construction registry (`getCreatedWebviewPanels()`) is the only
 * way to reach that internally-created panel, and this test replaces its `webview.postMessage` --
 * which the shared double fixes at `() => Promise.resolve(true)` with no capture hook -- with a local
 * recorder. That plain property write always falls through to the real underlying webview object
 * (`throwingDouble.ts` has no `set` trap by design; see its own doc comment), so every later
 * `panel.webview.postMessage(...)` call -- including every one `UndockedViewProvider.postToWebview`
 * makes internally -- resolves to this recorder. The E2E control channel
 * (`setE2eControlChannelActive`, `getE2eWebviewCaptureSink`) is never touched: it defaults to
 * inactive, and `captureWebview` (`src/e2e/webviewCapture.ts`) returns the panel unwrapped and
 * identity-equal while it is -- which is exactly what makes the patched `postMessage` visible to
 * production code in the first place.
 *
 * A real seeded repository is used rather than a stub `GitOps`: the `ready` handler's own fan-out
 * (`sendBranches`, `loadInitial`, `refreshCommitPanelData`) calls real `GitOps` methods, matching the
 * construction recipe `tests/visual/recorder/recordUndockedWebviewFixture.ts` already uses to drive
 * this same provider through this same message.
 */

import { describe, expect, it, vi } from "vitest";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

// Hoisted above the imports below -- see `CommitInfoViewProvider.test.ts` /
// `recordCommitInfoWebviewFixture.test.ts` for why this must be a plain, non-mocked import ahead of
// the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommitDetail } from "../../../src/types";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { UndockedViewProvider } from "../../../src/views/UndockedViewProvider";
import { seedFixtureTemplate } from "../../fixtures/repo/seed";
import { toGitEnvironment } from "../../visual/recorder/recordingGitEnvironment";
import {
    buildUndockedProviderConstructorArguments,
    buildUndockedWorkspaceConfiguration,
} from "../../visual/recorder/recordUndockedWebviewFixture";
import {
    type FakeWebviewPanel,
    getCreatedWebviewPanels,
    resetCreatedWebviewPanelsForTests,
} from "../../visual/recorder/webviewPanelDouble";
import {
    resetFakeWorkspaceConfigurationForTests,
    setFakeWorkspaceConfiguration,
} from "../../visual/recorder/workspaceConfigurationDouble";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Resolves once every microtask queued synchronously up to this call has drained -- same technique
 * (and same justification) as `CommitInfoViewProvider.test.ts`'s own `flushMicrotasks`: nothing in
 * this double's chain does real timer or I/O work, so a single `setImmediate` tick is enough to
 * observe `setCommitDetail`'s fire-and-forget decoration settle. */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function sampleCommitDetail(): CommitDetail {
    return {
        hash: "a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
        shortHash: "a1b2c3d4",
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

function setCommitDetailMessages(posted: readonly unknown[]): Record<string, unknown>[] {
    return posted.filter(
        (message): message is Record<string, unknown> =>
            isRecord(message) && message.type === "setCommitDetail",
    );
}

/**
 * Replaces `panel.webview.postMessage` -- which the shared double discards unconditionally -- with a
 * local recorder, and returns the array it appends to. See this file's own header for why the plain
 * property write is guaranteed to be seen by the provider's own later calls.
 */
function attachPostedMessageRecorder(panel: FakeWebviewPanel): unknown[] {
    const posted: unknown[] = [];
    panel.webview.postMessage = (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
    };
    return posted;
}

describe("UndockedViewProvider commit-detail re-post on webview reload", () => {
    it(
        "re-posts the selected commit detail when `ready` fires again without a new panel, even " +
            "though the payload is byte-identical to what the previous webview context received",
        async () => {
            const parentDir = await mkdtemp(
                path.join(tmpdir(), "intelligit-undocked-provider-test-"),
            );
            resetCreatedWebviewPanelsForTests();
            resetFakeWorkspaceConfigurationForTests();
            try {
                const template = await seedFixtureTemplate(path.join(parentDir, "repo"), {
                    homeParent: parentDir,
                });
                const gitOps = new GitOps(
                    new GitExecutor(template.root, undefined, toGitEnvironment(template.env)),
                );
                setFakeWorkspaceConfiguration(buildUndockedWorkspaceConfiguration());

                const provider = new UndockedViewProvider(
                    ...buildUndockedProviderConstructorArguments({
                        repoRoot: template.root,
                        gitOps,
                    }),
                );

                provider.open();
                const createdPanels = getCreatedWebviewPanels();
                expect(
                    createdPanels.length,
                    "open() must create exactly one webview panel",
                ).toEqual(1);
                const [panel] = createdPanels;
                if (!panel) {
                    throw new Error("UndockedViewProvider.open() did not create a webview panel.");
                }
                const posted = attachPostedMessageRecorder(panel);

                await panel.receiveMessage({ type: "ready" });

                const detail = sampleCommitDetail();
                provider.setCommitDetail(detail);
                // setCommitDetail's own icon-theme decoration runs as a fire-and-forget async chain
                // (see UndockedViewProvider.ts:601); flush the microtask queue so its settled
                // effects -- including any second post it makes on top of the immediate one -- are
                // captured before reading the count below.
                await flushMicrotasks();

                const beforeReload = setCommitDetailMessages(posted);
                expect(
                    beforeReload.length,
                    "setCommitDetail must post the selected commit detail at least once before " +
                        "the reload",
                ).toBeGreaterThanOrEqual(1);
                const countBeforeReload = beforeReload.length;
                const lastPayloadBeforeReload = beforeReload[countBeforeReload - 1];

                // The point of this test: a second `ready` fires WITHOUT a second `open()` call, so
                // open()'s own create-panel reset (UndockedViewProvider.ts:688) never runs again --
                // only the reset inside the `ready` case itself (:949) can save this repost.
                await panel.receiveMessage({ type: "ready" });
                await flushMicrotasks();

                const afterReload = setCommitDetailMessages(posted);
                expect(
                    afterReload.length,
                    "the reloaded webview context must receive a fresh setCommitDetail post " +
                        "instead of being silently suppressed as a duplicate of what the " +
                        "previous, now-dead webview context already received",
                ).toBeGreaterThan(countBeforeReload);
                expect(
                    afterReload[afterReload.length - 1],
                    "the re-post must carry the exact same commit-detail payload as before the " +
                        "reload -- byte-identical is the whole point; a duplicate guard keyed only " +
                        "on the payload would have swallowed this post",
                ).toEqual(lastPayloadBeforeReload);
            } finally {
                for (const createdPanel of getCreatedWebviewPanels()) createdPanel.dispose();
                resetCreatedWebviewPanelsForTests();
                resetFakeWorkspaceConfigurationForTests();
                await removeScratchDirectories(parentDir);
            }
        },
    );
});
