/**
 * Subscription-lifetime test for the two webview providers that VS Code can resolve more than once
 * against the SAME `WebviewView` instance.
 *
 * `SwitchableWebviewViewProvider` (`src/activation/common.ts:82`) keeps a registered view ID stable
 * while swapping the provider behind it: `setProvider` re-resolves the retained view against the
 * new provider. So the no-repository -> repository handover calls `resolveWebviewView` twice on one
 * view -- once for `OnboardingViewProvider`, once for `CommitPanelViewProvider` -- and every
 * subscription the first resolve installed is still live on that webview unless the provider
 * retired it. `webview.onDidReceiveMessage` returns a `Disposable` for exactly this reason.
 *
 * Why this file exists rather than an assertion added to `CommitPanelViewProvider.test.ts`: that
 * file's `createInspectableCommitPanelWebviewView` (`:113`) registers events as
 * `messageHandler = listener` / `disposeHandler = listener` -- assignment, not append -- and returns
 * an inert disposable. A double that keeps one handler per event and ignores disposal cannot tell a
 * provider that re-registers from one that registers once: both leave exactly one reachable
 * handler. The double below keeps listener ARRAYS and honours the returned disposable, which is the
 * only shape that can observe registration lifetime at all. The existing double is not weakened --
 * it is unsuitable for this question, not wrong for its own.
 *
 * The counts are the defect, but the handover test also states the consequence directly: a retired
 * onboarding provider must not act on messages arriving from the commit panel's document. Today it
 * does -- `OnboardingViewProvider`'s listener still dispatches `cloneRepository` / `openFolder` /
 * `initializeRepository` from a document that has been re-rendered by a different provider.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

/** Hoisted above the `vi.mock` factory below -- same convention as `CommitPanelViewProvider.test.ts`. */
const { executedCommands } = vi.hoisted(() => ({ executedCommands: [] as string[] }));

// `createCommitInfoVscodeDouble` is a throwing double: `vscode.commands` is deliberately absent
// because no recording scenario reaches it. `OnboardingViewProvider`'s message listener is exactly
// such a path, so this layer records the dispatch instead of throwing on it -- the leaked listener
// firing has to be observable as data, not as an exception thrown from inside an event callback.
vi.mock("vscode", () => {
    const base = createCommitInfoVscodeDouble();
    return new Proxy(base, {
        get(target, property) {
            if (property === "commands") {
                return {
                    executeCommand: (command: string): Promise<undefined> => {
                        executedCommands.push(command);
                        return Promise.resolve(undefined);
                    },
                };
            }
            return Reflect.get(target, property) as unknown;
        },
    });
});

import type * as vscode from "vscode";
import { createFakeExtensionUri } from "../../visual/recorder/commitInfoVscodeDouble";
import { SwitchableWebviewViewProvider } from "../../../src/activation/common";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { CommitPanelViewProvider } from "../../../src/views/CommitPanelViewProvider";
import { OnboardingViewProvider } from "../../../src/views/OnboardingViewProvider";

/** Resolve context/token stand-ins neither `resolveWebviewView` reads. */
const INERT_CONTEXT = {} as vscode.WebviewViewResolveContext;
const INERT_TOKEN = {} as vscode.CancellationToken;

/**
 * A VS Code event whose registrations accumulate and whose `Disposable` actually removes one.
 * `size` is the live listener count -- what a leak is made of, and what a single-slot double erases.
 */
class ListenerRegistry {
    private readonly listeners: Array<(arg: unknown) => unknown> = [];

    get size(): number {
        return this.listeners.length;
    }

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

    /** Fires every live listener, mirroring a real host: one event reaches all registrations. */
    fire(arg: unknown): void {
        for (const listener of [...this.listeners]) void listener(arg);
    }
}

function createMultiListenerWebviewView(): {
    readonly webviewView: vscode.WebviewView;
    readonly messages: ListenerRegistry;
    readonly disposals: ListenerRegistry;
    readonly visibilityChanges: ListenerRegistry;
} {
    const messages = new ListenerRegistry();
    const disposals = new ListenerRegistry();
    const visibilityChanges = new ListenerRegistry();

    const webview = {
        options: {} as vscode.WebviewOptions,
        html: "",
        cspSource: "vscode-webview://webview-resolve-subscriptions-test",
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: messages.register,
        postMessage: () => Promise.resolve(true),
    };

    const webviewView = {
        webview,
        visible: true,
        description: undefined,
        badge: undefined,
        onDidDispose: disposals.register,
        onDidChangeVisibility: visibilityChanges.register,
    } as unknown as vscode.WebviewView;

    return { webviewView, messages, disposals, visibilityChanges };
}

function createOnboardingProvider(): OnboardingViewProvider {
    return new OnboardingViewProvider(createFakeExtensionUri(), "no-git-repo", "IntelliGit");
}

/** No `repoRootUri`: `resolveWebviewView` never reads one, and omitting it keeps the constructor
 * off `setRepositoriesInternal` so this file stays a pure subscription-lifetime test. */
function createCommitPanelProvider(): CommitPanelViewProvider {
    return new CommitPanelViewProvider(
        createFakeExtensionUri(),
        new GitOps(new GitExecutor("/fake/repo")),
    );
}

beforeEach(() => {
    executedCommands.length = 0;
});

describe("webview provider resolve subscriptions", () => {
    it("retires the previous resolve's subscriptions when onboarding re-resolves one view", () => {
        const provider = createOnboardingProvider();
        const view = createMultiListenerWebviewView();

        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);
        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);

        expect(
            view.messages.size,
            "OnboardingViewProvider.resolveWebviewView discarded the Disposable returned by " +
                "webview.onDidReceiveMessage, so the first resolve's listener is still live",
        ).toBe(1);
        expect(
            view.disposals.size,
            "OnboardingViewProvider.resolveWebviewView discarded the Disposable returned by " +
                "webviewView.onDidDispose, so the first resolve's listener is still live",
        ).toBe(1);
    });

    it("retires the previous resolve's subscriptions when the commit panel re-resolves one view", () => {
        const provider = createCommitPanelProvider();
        const view = createMultiListenerWebviewView();

        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);
        provider.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);

        expect(
            view.messages.size,
            "CommitPanelViewProvider.resolveWebviewView discarded the Disposable returned by " +
                "webview.onDidReceiveMessage, so the first resolve's listener is still live",
        ).toBe(1);
        expect(
            view.disposals.size,
            "CommitPanelViewProvider.resolveWebviewView discarded the Disposable returned by " +
                "webviewView.onDidDispose, so the first resolve's listener is still live",
        ).toBe(1);
        expect(
            view.visibilityChanges.size,
            "CommitPanelViewProvider.resolveWebviewView discarded the Disposable returned by " +
                "webviewView.onDidChangeVisibility, so the first resolve's listener is still live",
        ).toBe(1);
    });

    it("leaves no onboarding listener behind after the no-repository -> repository handover", () => {
        const view = createMultiListenerWebviewView();
        const switchable = new SwitchableWebviewViewProvider(createOnboardingProvider());
        switchable.resolveWebviewView(view.webviewView, INERT_CONTEXT, INERT_TOKEN);

        switchable.setProvider(createCommitPanelProvider());

        expect(
            view.messages.size,
            "SwitchableWebviewViewProvider.setProvider re-resolved the retained view, and the " +
                "retired OnboardingViewProvider's message listener survived the handover",
        ).toBe(1);

        view.messages.fire({ type: "cloneRepository" });

        expect(
            executedCommands,
            "a retired OnboardingViewProvider acted on a message arriving from the commit " +
                "panel's document",
        ).toEqual([]);
    });
});
