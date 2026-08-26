/**
 * What the commit panel does when a SECOND document announces itself behind one `WebviewView`.
 *
 * VS Code can rebuild a hidden view's document without re-running `resolveWebviewView`, and the
 * React shell also re-announces on remount. Both arrive at the host identically: a fresh
 * `ready` carrying `attempt: 1` on a view that already had one. The host answers it -- and on the
 * failing CI runs the answer never lands, so the panel re-asks on its timer and stays on
 * `commit-panel-awaiting-hydration` for the rest of the session.
 *
 * Measured on main run 32968204695, row `shelf-apply`: the E2E handshake trace shows 9 `in ready`
 * and 16 `out setRepositories` all under document generation 2, beside a webview reporting
 * `hydration=<asks:18 received:0 last:null>`. Every PASSING row in that run stayed at generation
 * 1. So the trigger is empirical and clean -- a second opening ask that keeps asking after being
 * answered -- even though the trace cannot say whether the underlying cause is a VS Code document
 * reload or a component remount. This file pins the host's RESPONSE to that trigger, which is the
 * part we control and the part that decides whether the user gets a working panel.
 *
 * The rescue is re-setting `webview.html`, which forces the view to build a document bound to the
 * channel the host is posting into. It is bounded to once per resolve on purpose: the rescue
 * itself creates a new document that announces itself, so a per-generation budget would re-arm
 * forever and reload the panel in a loop.
 *
 * Why a local double rather than `createInspectableCommitPanelWebviewView`
 * (`tests/unit/views/CommitPanelViewProvider.test.ts:113`): that one stores ONE handler per event
 * and, more to the point here, exposes `html` as a plain field, so an assignment is invisible.
 * Counting assignments is the whole oracle. The shared double is not weakened -- it is unsuitable
 * for this question, not wrong for its own.
 */

import { describe, expect, it, vi } from "vitest";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

// `createCommitInfoVscodeDouble` deliberately omits `vscode.commands`; `resolveWebviewView` reaches
// it through `updateViewCount`'s `setContext`. Same layering as
// `tests/unit/views/webviewResolveSubscriptions.test.ts`.
vi.mock("vscode", () => {
    const base = createCommitInfoVscodeDouble();
    return new Proxy(base, {
        get(target, property) {
            if (property === "commands") {
                return {
                    executeCommand: (): Promise<undefined> => Promise.resolve(undefined),
                };
            }
            return Reflect.get(target, property) as unknown;
        },
    });
});

import type * as vscode from "vscode";
import { createFakeExtensionUri } from "../../visual/recorder/commitInfoVscodeDouble";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { CommitPanelViewProvider } from "../../../src/views/CommitPanelViewProvider";

const INERT_CONTEXT = {} as vscode.WebviewViewResolveContext;
const INERT_TOKEN = {} as vscode.CancellationToken;

/** A VS Code event whose registrations accumulate and whose `Disposable` actually removes one. */
class ListenerRegistry {
    private readonly listeners: Array<(arg: unknown) => unknown> = [];

    readonly register = (listener: (arg: never) => unknown): vscode.Disposable => {
        const entry = listener as (arg: unknown) => unknown;
        this.listeners.push(entry);
        return {
            dispose: (): void => {
                const index = this.listeners.indexOf(entry);
                if (index !== -1) this.listeners.splice(index, 1);
            },
        };
    };

    fire(arg: unknown): void {
        for (const listener of [...this.listeners]) void listener(arg);
    }
}

interface ReloadableView {
    readonly webviewView: vscode.WebviewView;
    readonly messages: ListenerRegistry;
    readonly posted: unknown[];
    /** How many times `webview.html` has been ASSIGNED -- the rebind oracle. */
    htmlAssignments: () => number;
}

function createReloadableWebviewView(): ReloadableView {
    const messages = new ListenerRegistry();
    const disposals = new ListenerRegistry();
    const visibilityChanges = new ListenerRegistry();
    const posted: unknown[] = [];
    let htmlAssignments = 0;
    let htmlValue = "";

    const webview = {
        options: {} as vscode.WebviewOptions,
        // An accessor, not a field: assigning `html` is the observable act this file is about, and
        // a plain field records only the last value, never that it was written again.
        get html(): string {
            return htmlValue;
        },
        set html(value: string) {
            htmlValue = value;
            htmlAssignments += 1;
        },
        cspSource: "vscode-webview://commit-panel-document-reload-test",
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: messages.register,
        postMessage: (message: unknown) => {
            posted.push(message);
            return Promise.resolve(true);
        },
    };

    const webviewView = {
        webview,
        visible: true,
        description: undefined,
        badge: undefined,
        onDidDispose: disposals.register,
        onDidChangeVisibility: visibilityChanges.register,
    } as unknown as vscode.WebviewView;

    return { webviewView, messages, posted, htmlAssignments: () => htmlAssignments };
}

/** Drains microtasks -- the commit panel's message listener is `async`. */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** No `repoRootUri`, so the constructor stays off `setRepositoriesInternal` and `getActiveRuntime`
 * returns undefined -- this file is about the handshake, not about Git. */
function createCommitPanelProvider(): CommitPanelViewProvider {
    return new CommitPanelViewProvider(
        createFakeExtensionUri(),
        new GitOps(new GitExecutor("/fake/repo")),
    );
}

/** One `ready`, awaited, so the async listener has run before the next assertion. */
async function ask(view: ReloadableView, attempt: number): Promise<void> {
    view.messages.fire({ type: "ready", attempt });
    await flushMicrotasks();
}

/** A `ready` with no `attempt` at all -- what a producer predating the field sends. */
async function askWithoutCount(view: ReloadableView): Promise<void> {
    view.messages.fire({ type: "ready" });
    await flushMicrotasks();
}

describe("commit panel document reload", () => {
    it("rebinds the document channel when a second document keeps asking after being answered", async () => {
        const provider = createCommitPanelProvider();
        const view = createReloadableWebviewView();
        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const afterResolve = view.htmlAssignments();

        await ask(view, 1); // first document announces itself
        await ask(view, 1); // a SECOND document announces itself behind the same view
        await ask(view, 2); // and is still asking, so the host's answer is not reaching it

        expect(
            view.htmlAssignments(),
            "a second document announced itself, was answered, and kept asking -- the host never " +
                "re-set webview.html, so its replies keep going to a channel that document is not " +
                "on and the panel stays blank for the rest of the session",
        ).toBeGreaterThan(afterResolve);
    });

    it("does not rebind while a single document is still in its opening burst", async () => {
        const provider = createCommitPanelProvider();
        const view = createReloadableWebviewView();
        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const afterResolve = view.htmlAssignments();

        await ask(view, 1);
        await ask(view, 2);
        await ask(view, 3);

        expect(
            view.htmlAssignments(),
            "one document re-asking on its timer is the ordinary healthy path; re-setting " +
                "webview.html there throws away a document that was about to hydrate",
        ).toBe(afterResolve);
    });

    it("rescues a stuck view at most once per resolve", async () => {
        const provider = createCommitPanelProvider();
        const view = createReloadableWebviewView();
        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const afterResolve = view.htmlAssignments();

        await ask(view, 1);
        await ask(view, 1);
        await ask(view, 2); // rescue fires here

        await ask(view, 1); // the rescue's own document announces itself
        await ask(view, 2); // and if it also fails, the budget must already be spent

        expect(
            view.htmlAssignments(),
            "the rescue re-sets webview.html, which itself creates a document that announces " +
                "itself -- so a budget that re-arms per generation reloads the panel forever",
        ).toBe(afterResolve + 1);
    });

    it("counts no documents at all when ready carries no attempt", async () => {
        const provider = createCommitPanelProvider();
        const view = createReloadableWebviewView();
        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);
        const afterResolve = view.htmlAssignments();

        await askWithoutCount(view);
        await askWithoutCount(view);
        await ask(view, 2);

        expect(
            view.htmlAssignments(),
            "`attempt` is untrusted webview input; reading a missing count as a NEW DOCUMENT would " +
                "let a producer that predates the field earn a rebind and reload a working panel. " +
                "Only the literal 1 counts as a document announcing itself",
        ).toBe(afterResolve);
    });
});
