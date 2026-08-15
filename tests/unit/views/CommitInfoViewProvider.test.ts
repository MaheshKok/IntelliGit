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

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

// Hoisted above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` for why this must
// be a plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import type * as vscode from "vscode";
import { createFakeExtensionUri } from "../../visual/recorder/commitInfoVscodeDouble";
import { CommitInfoViewProvider } from "../../../src/views/CommitInfoViewProvider";
import type { IconThemeService } from "../../../src/views/shared/IconThemeService";
import type { CommitDetail } from "../../../src/types";

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
} {
    let messageHandler: ((message: unknown) => unknown) | undefined;
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
        onDidDispose: () => ({ dispose(): void {} }),
    } as unknown as vscode.WebviewView;

    return {
        webviewView,
        posted,
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

function setDetailMessages(posted: readonly unknown[]): Record<string, unknown>[] {
    return posted.filter(
        (message): message is Record<string, unknown> =>
            isRecord(message) && message.type === "setCommitDetail",
    );
}

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
});
