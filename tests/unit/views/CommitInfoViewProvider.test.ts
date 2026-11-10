/**
 * Provider-level tests for the redundant `setCommitDetail` post fix in
 * `src/views/CommitInfoViewProvider.ts`.
 *
 * `CommitInfoViewProvider.setCommitDetail` posts the raw commit detail immediately, then starts
 * `decorateAndStoreDetail`, which awaits `IconThemeService.decorateCommitDetailWithFolderIcons` and
 * posts again unconditionally. When no icon resolver is attached (this test's `vscode` double never
 * implements `vscode.extensions` -- see `commitInfoVscodeDouble.ts`'s own doc comment), decoration
 * is a true no-op and the second post is byte-identical to the first: "suppresses the second post"
 * below proves that redundant post is gone.
 *
 * THE TRAP: `IconThemeService.getThemeData()` reads live, mutable instance state
 * (`folderIcons`/`iconFonts`) independently of whatever `decorateCommitDetailWithFolderIcons`
 * returns, and that method awaits `initIconThemeData()` -- which can populate that state for the
 * FIRST time -- before decorating. So the second post can legitimately differ from the first in
 * exactly those fields, even though the commit detail itself never changed. "does NOT suppress"
 * below proves the guard does not get this wrong: it stubs `getThemeData()` to return different
 * values across the two `postCurrentState` calls this scenario drives (installed AFTER the
 * `ready`-handler's own call, so it controls exactly the two calls under test) and asserts BOTH
 * posts still go out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

// Hoisted above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` for why this must
// be a plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import type * as vscode from "vscode";
import { createFakeExtensionUri } from "../../visual/recorder/commitInfoVscodeDouble";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CommitInfoViewProvider } from "../../../src/views/CommitInfoViewProvider";
import type { IconThemeService } from "../../../src/views/shared/IconThemeService";
import type { CommitCiDetail, CommitDetail } from "../../../src/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";

/** A resolve-context/token stand-in `resolveWebviewView` never reads -- same reasoning as
 * `recordCommitInfoWebviewFixture.ts`'s own `INERT_RESOLVE_CONTEXT`/`INERT_CANCELLATION_TOKEN`. */
const INERT_CONTEXT = {} as vscode.WebviewViewResolveContext;
const INERT_TOKEN = {} as vscode.CancellationToken;

/** Resolves once every microtask queued synchronously up to this call has drained -- see
 * `recordCommitInfoWebviewFixture.ts`'s own `flushMicrotasks` doc comment for why a single
 * `setImmediate` tick is sufficient to observe `decorateAndStoreDetail`'s settled effects in this
 * double (no real timer or I/O wait anywhere in its chain). */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** A minimal local `vscode.WebviewView` double with an inspectable `posted` array -- deliberately
 * NOT `commitInfoVscodeDouble.ts`'s own `createFakeCommitInfoWebviewView`, whose `postMessage` is
 * fixed at `() => Promise.resolve(true)` with no capture hook. Same member set that function's own
 * doc comment establishes as the exact minimum `CommitInfoViewProvider.resolveWebviewView` reaches
 * for (`webview.{options,html,cspSource,asWebviewUri,onDidReceiveMessage,postMessage}`, the view's
 * own `onDidDispose`). */
function createInspectableFakeWebviewView(): {
    readonly webviewView: vscode.WebviewView;
    readonly posted: unknown[];
    receiveMessage(message: unknown): Promise<void>;
    dispose(): void;
} {
    let messageHandler: ((message: unknown) => unknown) | undefined;
    let disposeHandler: (() => void) | undefined;
    const posted: unknown[] = [];

    const webview = {
        options: {} as vscode.WebviewOptions,
        html: "",
        cspSource: "vscode-webview://fake-commit-info-provider-test",
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
            messageHandler = listener;
            return { dispose(): void {} };
        },
        postMessage: (message: unknown) => {
            posted.push(message);
            return Promise.resolve(true);
        },
    };

    const webviewView = {
        webview,
        onDidDispose: (listener: () => void) => {
            disposeHandler = listener;
            return { dispose(): void {} };
        },
    } as unknown as vscode.WebviewView;

    return {
        webviewView,
        posted,
        dispose: (): void => disposeHandler?.(),
        receiveMessage: async (message: unknown): Promise<void> => {
            if (!messageHandler) {
                throw new Error(
                    "createInspectableFakeWebviewView.receiveMessage: no message handler was " +
                        "registered yet -- resolveWebviewView() must run first.",
                );
            }
            await messageHandler(message);
        },
    };
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

/** A second, distinguishable commit -- the mid-`ready` selection in the ordering test below. Its
 * hash is `sampleDetail()`'s parent, so the pair reads as two commits from one real history. */
function otherDetail(): CommitDetail {
    return {
        hash: "70fa528600605d9b3f1fce7aa04ec799ed494ffd",
        shortHash: "70fa5286",
        message: "Seed the fixture repository",
        body: "",
        author: "IntelliGit Fixture Repo",
        email: "intelligit-fixture@example.invalid",
        date: "2000-01-01T00:00:00Z",
        parentHashes: [],
        refs: [],
        files: [{ path: "README.md", status: "A", additions: 1, deletions: 0 }],
    };
}

function setDetailMessages(posted: readonly unknown[]): Record<string, unknown>[] {
    return posted.filter(
        (message): message is Record<string, unknown> =>
            isRecord(message) && message.type === "setCommitDetail",
    );
}

describe("CommitInfoViewProvider Checks tab scan re-posts", () => {
    // The Checks tab switch is on only while the E2E control channel is.
    beforeEach(() => setE2eControlChannelActive(true));
    afterEach(() => setE2eControlChannelActive(false));

    it("cancelCommitCiDetail from a hidden tab stops that request's re-posts", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const provider = new CommitInfoViewProvider(createFakeExtensionUri());
            const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
            provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
            await receiveMessage({ type: "ready" });
            const runningScan: CommitCiDetail = {
                hash: sampleDetail().hash,
                provider: "github",
                complete: true,
                outcome: "failure",
                runs: [
                    {
                        id: "1",
                        name: "CI",
                        state: "failure",
                        jobs: [],
                        jobsCoverage: { reason: "pageBound", shown: 1000 },
                        failedScan: { state: "running", found: 0 },
                    },
                ],
                runsCoverage: "full",
                otherChecks: [],
                otherChecksCoverage: "full",
                capabilities: NO_CI_CAPABILITIES,
                repoKey: "/repo",
            };
            provider.setCiSource({
                enabled: true,
                repoKey: () => "/repo",
                getDetail: async () => runningScan,
            });
            const replies = () =>
                posted.filter((message) => isRecord(message) && message.type === "commitCiDetail");

            const answered = receiveMessage({
                type: "requestCommitCiDetail",
                requestId: 1,
                repoKey: "/repo",
                hash: sampleDetail().hash,
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(replies()).toHaveLength(1);

            await receiveMessage({ type: "cancelCommitCiDetail", requestId: 1 });
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(replies(), "re-posts after the tab was hidden").toHaveLength(1);
            await answered;
        } finally {
            vi.useRealTimers();
        }
    });

    it("a late cancel from a replaced webview leaves its successor's request running", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const provider = new CommitInfoViewProvider(createFakeExtensionUri());
            const retired = createInspectableFakeWebviewView();
            provider.resolveWebviewView(retired.webviewView, INERT_CONTEXT, INERT_TOKEN);
            const current = createInspectableFakeWebviewView();
            provider.resolveWebviewView(current.webviewView, INERT_CONTEXT, INERT_TOKEN);
            await current.receiveMessage({ type: "ready" });
            provider.setCiSource({
                enabled: true,
                repoKey: () => "/repo",
                getDetail: async () => ({
                    hash: sampleDetail().hash,
                    provider: "github",
                    complete: true,
                    outcome: "failure",
                    runs: [
                        {
                            id: "1",
                            name: "CI",
                            state: "failure",
                            jobs: [],
                            jobsCoverage: { reason: "pageBound", shown: 1000 },
                            failedScan: { state: "running", found: 0 },
                        },
                    ],
                    runsCoverage: "full",
                    otherChecks: [],
                    otherChecksCoverage: "full",
                    capabilities: NO_CI_CAPABILITIES,
                    repoKey: "/repo",
                }),
            });
            const replies = () =>
                current.posted.filter(
                    (message) => isRecord(message) && message.type === "commitCiDetail",
                );

            // Each webview numbers its requests from 1, so the retired one's id names this one.
            const answered = current.receiveMessage({
                type: "requestCommitCiDetail",
                requestId: 1,
                repoKey: "/repo",
                hash: sampleDetail().hash,
            });
            await vi.advanceTimersByTimeAsync(0);
            await retired.receiveMessage({ type: "cancelCommitCiDetail", requestId: 1 });
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(
                replies().length,
                "the successor's scan progress keeps arriving after the late cancel",
            ).toBeGreaterThan(1);
            current.dispose();
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            await answered;
        } finally {
            vi.useRealTimers();
        }
    });

    /** A Checks tab request on `view` whose overflow scan never ends, counting the fetches. */
    async function startEndlessScan(
        provider: CommitInfoViewProvider,
        view: ReturnType<typeof createInspectableFakeWebviewView>,
    ) {
        const getDetail = vi.fn(async (): Promise<CommitCiDetail> => ({
            hash: sampleDetail().hash,
            provider: "github",
            complete: true,
            outcome: "failure",
            runs: [
                {
                    id: "1",
                    name: "CI",
                    state: "failure",
                    jobs: [],
                    jobsCoverage: { reason: "pageBound", shown: 1000 },
                    failedScan: { state: "running", found: 0 },
                },
            ],
            runsCoverage: "full",
            otherChecks: [],
            otherChecksCoverage: "full",
            capabilities: NO_CI_CAPABILITIES,
            repoKey: "/repo",
        }));
        provider.setCiSource({ enabled: true, repoKey: () => "/repo", getDetail });
        const answered = view.receiveMessage({
            type: "requestCommitCiDetail",
            requestId: 1,
            repoKey: "/repo",
            hash: sampleDetail().hash,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(getDetail).toHaveBeenCalledTimes(1);
        return { getDetail, answered };
    }

    it("a replaced webview's scan loop stops fetching once its successor is resolved", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const provider = new CommitInfoViewProvider(createFakeExtensionUri());
            const retired = createInspectableFakeWebviewView();
            provider.resolveWebviewView(retired.webviewView, INERT_CONTEXT, INERT_TOKEN);
            await retired.receiveMessage({ type: "ready" });
            const { getDetail, answered } = await startEndlessScan(provider, retired);

            const current = createInspectableFakeWebviewView();
            provider.resolveWebviewView(current.webviewView, INERT_CONTEXT, INERT_TOKEN);
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(getDetail, "fetches for the replaced webview").toHaveBeenCalledTimes(1);
            await answered;
        } finally {
            vi.useRealTimers();
        }
    });

    it("disposing the provider stops a running scan loop", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const provider = new CommitInfoViewProvider(createFakeExtensionUri());
            const view = createInspectableFakeWebviewView();
            provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);
            await view.receiveMessage({ type: "ready" });
            const { getDetail, answered } = await startEndlessScan(provider, view);

            provider.dispose();
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(getDetail, "fetches after the provider was disposed").toHaveBeenCalledTimes(1);
            await answered;
        } finally {
            vi.useRealTimers();
        }
    });

    it("a webview reload stops its previous context's scan loop; a replaced webview's late ready does not", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const provider = new CommitInfoViewProvider(createFakeExtensionUri());
            const retired = createInspectableFakeWebviewView();
            provider.resolveWebviewView(retired.webviewView, INERT_CONTEXT, INERT_TOKEN);
            const current = createInspectableFakeWebviewView();
            provider.resolveWebviewView(current.webviewView, INERT_CONTEXT, INERT_TOKEN);
            await current.receiveMessage({ type: "ready" });
            const { getDetail, answered } = await startEndlessScan(provider, current);

            await retired.receiveMessage({ type: "ready" });
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            const fetches = getDetail.mock.calls.length;
            expect(
                fetches,
                "the current webview's loop kept re-reading after a replaced webview's late ready",
            ).toBeGreaterThan(1);

            // VS Code reloads a hidden view's webview without resolving the view again.
            await current.receiveMessage({ type: "ready" });
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(getDetail, "fetches after the webview reloaded").toHaveBeenCalledTimes(fetches);
            await answered;
        } finally {
            vi.useRealTimers();
        }
    });

    it("a repository switch hands the pane the new repository, so its Checks tab asks again", async () => {
        let repoKey = "/repo-a";
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });
        provider.setCiSource({
            enabled: true,
            repoKey: () => repoKey,
            getDetail: async () => undefined,
        });
        provider.setCommitDetail(sampleDetail());
        await flushMicrotasks();
        expect(setDetailMessages(posted).at(-1)?.ciRepoKey).toBe("/repo-a");

        // A request still carrying the old key gets no reply (ciDetailHandler.test.ts), so the
        // pane must learn the new key: the switch clears it, and the next commit carries the key.
        repoKey = "/repo-b";
        posted.length = 0;
        provider.clear();
        expect(posted, "the switch clears the pane").toEqual([{ type: "clear" }]);
        // The same commit, as both repositories can share history.
        provider.setCommitDetail(sampleDetail());
        await flushMicrotasks();
        expect(setDetailMessages(posted).at(-1)?.ciRepoKey, "key after the switch").toBe("/repo-b");
    });
});

describe("CommitInfoViewProvider Open in Checks", () => {
    const ciSource = {
        enabled: true,
        repoKey: () => "/repo",
        getDetail: async () => undefined,
    };
    const openMessages = (posted: readonly unknown[]) =>
        posted.filter((message) => isRecord(message) && message.type === "openChecksTab");

    it("review: Open in Checks survives a view that is not ready yet", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        provider.setCommitDetail(sampleDetail());
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);

        provider.openChecksTab(sampleDetail().hash);
        expect(openMessages(posted), "posted before the webview listens").toEqual([]);

        await receiveMessage({ type: "ready" });
        expect(openMessages(posted), "open request after ready").toEqual([
            { type: "openChecksTab", repoKey: "/repo", hash: sampleDetail().hash },
        ]);

        // A reload of the same view must not switch the tab again on its own.
        await receiveMessage({ type: "ready" });
        expect(openMessages(posted), "open request repeated on reload").toHaveLength(1);
    });

    it("Open in Checks before the view was ever resolved reaches it once it is ready", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        provider.setCommitDetail(sampleDetail());
        provider.openChecksTab(sampleDetail().hash);

        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });
        expect(openMessages(posted), "open request after first resolve").toEqual([
            { type: "openChecksTab", repoKey: "/repo", hash: sampleDetail().hash },
        ]);
    });

    it("Open in Checks on a ready view posts at once", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        provider.setCommitDetail(sampleDetail());
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });

        provider.openChecksTab(sampleDetail().hash);
        expect(openMessages(posted), "open request on a ready view").toHaveLength(1);
        await receiveMessage({ type: "ready" });
        expect(openMessages(posted), "open request repeated on reload").toHaveLength(1);
    });

    it("review: a late ready from a replaced view does not hand its request to the new view", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        provider.setCommitDetail(sampleDetail());
        const old = createInspectableFakeWebviewView();
        provider.resolveWebviewView(old.webviewView, INERT_CONTEXT, INERT_TOKEN);
        // Hold the old view's ready handler inside its await until the view has been replaced.
        let releaseOldReady = (): void => {};
        const iconTheme = (provider as unknown as { iconTheme: IconThemeService }).iconTheme;
        vi.spyOn(iconTheme, "initIconThemeData").mockReturnValueOnce(
            new Promise<void>((resolve) => {
                releaseOldReady = resolve;
            }),
        );
        const oldReady = old.receiveMessage({ type: "ready" });

        const replacement = createInspectableFakeWebviewView();
        provider.resolveWebviewView(replacement.webviewView, INERT_CONTEXT, INERT_TOKEN);
        provider.openChecksTab(sampleDetail().hash);
        releaseOldReady();
        await oldReady;
        expect(openMessages(replacement.posted), "not before replacement ready").toEqual([]);

        await replacement.receiveMessage({ type: "ready" });
        expect(openMessages(replacement.posted), "open request after replacement ready").toEqual([
            { type: "openChecksTab", repoKey: "/repo", hash: sampleDetail().hash },
        ]);
    });

    it("review: a repository switch before the view is ready keeps the request's own repository", async () => {
        let repoKey = "/repo-a";
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource({ ...ciSource, repoKey: () => repoKey });
        provider.setCommitDetail(sampleDetail());
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);

        provider.openChecksTab(sampleDetail().hash);
        repoKey = "/repo-b";
        await receiveMessage({ type: "ready" });
        expect(
            openMessages(posted),
            "the held request names the repository it was made in",
        ).toEqual([{ type: "openChecksTab", repoKey: "/repo-a", hash: sampleDetail().hash }]);
    });

    it("Open in Checks waits until the pane shows the requested commit", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });
        provider.setCommitDetail(otherDetail());

        // The graph selects the row and asks at once; the row's detail is still loading.
        provider.openChecksTab(sampleDetail().hash);
        expect(openMessages(posted), "open request while another commit is shown").toEqual([]);

        provider.setCommitDetail(sampleDetail());
        expect(openMessages(posted), "open request once the commit is shown").toEqual([
            { type: "openChecksTab", repoKey: "/repo", hash: sampleDetail().hash },
        ]);
        const order = posted.filter(
            (message) =>
                isRecord(message) &&
                (message.type === "openChecksTab" ||
                    (message.type === "setCommitDetail" &&
                        (message.detail as CommitDetail).hash === sampleDetail().hash)),
        );
        expect(
            order.map((message) => (message as Record<string, unknown>).type),
            "the commit reaches the pane before the tab switches to it",
        ).toEqual(["setCommitDetail", "openChecksTab"]);
    });

    it("a selection that moves on drops a waiting Open in Checks", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });
        provider.setCommitDetail(otherDetail());

        provider.openChecksTab(sampleDetail().hash);
        provider.setCommitDetail(otherDetail());
        provider.setCommitDetail(sampleDetail());
        expect(
            openMessages(posted),
            "an open request outlived a selection of another commit",
        ).toEqual([]);
    });

    it("clearing the pane drops a waiting Open in Checks", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });
        provider.setCommitDetail(otherDetail());

        provider.openChecksTab(sampleDetail().hash);
        // A branch filter clears the pane, cancelling the requested commit's load.
        provider.clear({ loading: true });
        // A later plain click on the same commit.
        provider.setCommitDetail(sampleDetail());
        expect(openMessages(posted), "an open request outlived a cleared pane").toEqual([]);
    });

    it("review: disposing a replaced view leaves the new view ready", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        provider.setCiSource(ciSource);
        provider.setCommitDetail(sampleDetail());
        const old = createInspectableFakeWebviewView();
        provider.resolveWebviewView(old.webviewView, INERT_CONTEXT, INERT_TOKEN);
        await old.receiveMessage({ type: "ready" });
        const replacement = createInspectableFakeWebviewView();
        provider.resolveWebviewView(replacement.webviewView, INERT_CONTEXT, INERT_TOKEN);
        await replacement.receiveMessage({ type: "ready" });

        old.dispose();
        provider.openChecksTab(sampleDetail().hash);
        expect(openMessages(replacement.posted), "open request after old view disposed").toEqual([
            { type: "openChecksTab", repoKey: "/repo", hash: sampleDetail().hash },
        ]);
    });
});

describe("CommitInfoViewProvider redundant setCommitDetail post", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("suppresses the second post when decoration changes nothing", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();

        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });

        provider.setCommitDetail(sampleDetail());
        await flushMicrotasks();

        expect(setDetailMessages(posted)).toHaveLength(1);
    });

    it(
        "does NOT suppress the second post when theme data legitimately arrives late " +
            "(initIconThemeData populates state between the two posts)",
        async () => {
            const provider = new CommitInfoViewProvider(createFakeExtensionUri());
            const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();

            provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
            await receiveMessage({ type: "ready" });

            // Installed AFTER the ready-handler's own `postCurrentState()` call already ran for
            // real, so this controls exactly the two calls `setCommitDetail` below drives: the
            // immediate raw post, and the post-decoration post.
            const iconTheme = (provider as unknown as { iconTheme: IconThemeService }).iconTheme;
            const themeDataSpy = vi.spyOn(iconTheme, "getThemeData");
            themeDataSpy.mockReturnValueOnce({ folderIcons: {}, iconFonts: [] });
            themeDataSpy.mockReturnValueOnce({
                folderIcons: {
                    folderIcon: { uri: "icon-a.svg" },
                    folderExpandedIcon: { uri: "icon-a-expanded.svg" },
                },
                iconFonts: [{ fontFamily: "seti", src: "seti.woff" }],
            });

            provider.setCommitDetail(sampleDetail());
            await flushMicrotasks();

            const messages = setDetailMessages(posted);
            expect(messages).toHaveLength(2);
            expect(messages[0].iconFonts).toEqual([]);
            expect(messages[0].folderIcon).toBeUndefined();
            expect(messages[1].iconFonts).toEqual([{ fontFamily: "seti", src: "seti.woff" }]);
            expect(messages[1].folderIcon).toEqual({ uri: "icon-a.svg" });
        },
    );

    it(
        "re-posts the unchanged detail to a webview that reloaded, because a second `ready` " +
            "means a fresh context that received none of the earlier posts",
        async () => {
            const provider = new CommitInfoViewProvider(createFakeExtensionUri());
            const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();

            provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
            await receiveMessage({ type: "ready" });

            provider.setCommitDetail(sampleDetail());
            await flushMicrotasks();
            expect(setDetailMessages(posted)).toHaveLength(1);

            // VS Code tears a hidden WebviewView's context down and reloads it on show. The
            // script re-runs and announces itself with a second `ready`, but the provider is
            // already resolved, so `resolveWebviewView` -- and its `lastPostedPayload` reset --
            // does NOT run again. The detail is byte-identical to the one posted before the
            // reload, so a duplicate guard keyed only on the payload would suppress it and leave
            // the restored pane empty. This is the regression the `ready`-handler reset prevents.
            await receiveMessage({ type: "ready" });
            await flushMicrotasks();

            const messages = setDetailMessages(posted);
            expect(
                messages,
                "the reloaded webview must receive the detail again, byte-identical or not",
            ).toHaveLength(2);
            expect(messages[1]).toEqual(messages[0]);
        },
    );

    /**
     * The `ready` handler's `lastPostedPayload` reset must run BEFORE its `await`, not after.
     *
     * That await yields, and on a reload `this.ready` is already true from the first `ready` --
     * so a commit selected or refreshed during the window posts for real, against the context
     * that is currently live. Resetting afterwards discards the record of that post, and the
     * handler's closing `postCurrentState()` then re-sends what the webview already has.
     *
     * The two details must DIFFER for this to be detectable. With an identical one, the
     * post-await reset merely relocates which of the two calls is suppressed and the webview
     * ends up with the same message either way -- a test using one payload passes on the broken
     * ordering. Selecting a different commit mid-window separates them: the correct ordering
     * sends `X` then `Y`; the broken one sends `X`, `Y`, `Y`.
     */
    it("does not re-post a detail that arrived while the ready handler was still awaiting", async () => {
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        const { webviewView, posted, receiveMessage } = createInspectableFakeWebviewView();

        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });

        provider.setCommitDetail(sampleDetail());
        await flushMicrotasks();
        expect(setDetailMessages(posted)).toHaveLength(1);

        // The reload's `ready`. `initIconThemeData` is where that handler yields, so driving
        // the selection from inside it puts the post exactly in the window under test.
        //
        // The guard is load-bearing, not defensive: `setCommitDetail` starts
        // `decorateAndStoreDetail`, which awaits this very method again. Without it the
        // stand-in re-enters itself and the test dies of heap exhaustion rather than
        // reporting on the ordering.
        const iconTheme = (provider as unknown as { iconTheme: IconThemeService }).iconTheme;
        let selectedMidWindow = false;
        vi.spyOn(iconTheme, "initIconThemeData").mockImplementation(async () => {
            if (selectedMidWindow) return;
            selectedMidWindow = true;
            provider.setCommitDetail(otherDetail());
            await flushMicrotasks();
        });

        await receiveMessage({ type: "ready" });
        await flushMicrotasks();

        const messages = setDetailMessages(posted);
        expect(
            messages.map((message) => (message.detail as CommitDetail).shortHash),
            "the second commit must reach the webview exactly once: the reset belongs before " +
                "the await, so the mid-window post is the one recorded and the handler's " +
                "closing post is suppressed as the duplicate it is",
        ).toEqual(["b08ddf03", "70fa5286"]);
    });
});
