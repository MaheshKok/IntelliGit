// "Find where CI broke" in the Changed Files view (PLAN.md section 13): disposing the provider
// cancels the bisect it hosts, so no queued read can still send a request afterwards.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

vi.mock("vscode", () => createCommitInfoVscodeDouble());

import type * as vscode from "vscode";
import { createFakeExtensionUri } from "../../visual/recorder/commitInfoVscodeDouble";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CommitInfoViewProvider } from "../../../src/views/CommitInfoViewProvider";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => setE2eControlChannelActive(false));

describe("CommitInfoViewProvider disposal", () => {
    it("provider disposal stops the sidebar bisect before a queued read sends", async () => {
        setE2eControlChannelActive(true);
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        let receive: ((message: unknown) => unknown) | undefined;
        const view = {
            webview: {
                options: {},
                html: "",
                cspSource: "vscode-webview://fake",
                asWebviewUri: (uri: vscode.Uri) => uri,
                onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
                    receive = listener;
                    return { dispose(): void {} };
                },
                postMessage: () => Promise.resolve(true),
            },
            onDidDispose: () => ({ dispose(): void {} }),
        } as unknown as vscode.WebviewView;
        provider.resolveWebviewView(view, {} as never, {} as never);
        await receive?.({ type: "ready" });

        const guards: Array<() => boolean> = [];
        const commit = { hash: "a".repeat(40), parents: ["b".repeat(40)] };
        provider.setCiSource({
            enabled: true,
            repoKey: () => "/repo",
            getDetail: vi.fn(),
            bisect: {
                source: {
                    // The read waits as a request queued behind the gate would.
                    getChecks: async (_hash: string, options: { sendGuard: () => boolean }) => {
                        guards.push(options.sendGuard);
                        await new Promise(() => undefined);
                    },
                    capabilities: async () => undefined,
                    attemptHistory: async () => [],
                },
                loaded: () => [commit],
            },
        } as never);
        void receive?.({
            type: "startCiBisect",
            requestId: 1,
            repoKey: "/repo",
            commits: [commit],
        });
        await flush();
        expect(guards, "the read is queued").toHaveLength(1);

        provider.dispose();

        expect(guards[0](), "disposed provider must invalidate queued CI work").toBe(false);
    });
});

describe("CommitInfoViewProvider sidebar relay", () => {
    it("sidebar click while the previously ready Changed Files webview is unavailable survives its reload", async () => {
        setE2eControlChannelActive(true);
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        let receive: ((message: unknown) => unknown) | undefined;
        let available = true;
        const delivery = vi.fn(async (_message: { type: string }) => available);
        const view = {
            webview: {
                options: {},
                html: "",
                cspSource: "vscode-webview://fake",
                asWebviewUri: (uri: vscode.Uri) => uri,
                onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
                    receive = listener;
                    return { dispose(): void {} };
                },
                postMessage: delivery,
            },
            onDidDispose: () => ({ dispose(): void {} }),
        } as unknown as vscode.WebviewView;
        provider.resolveWebviewView(view, {} as never, {} as never);
        const commits = [
            { hash: "a".repeat(40), parents: ["b".repeat(40)] },
            { hash: "b".repeat(40), parents: [] },
        ];
        provider.setCiSource({
            enabled: true,
            repoKey: () => "/A",
            getDetail: vi.fn(),
            bisect: {
                source: {
                    getChecks: async () => undefined,
                    capabilities: async () => undefined,
                    attemptHistory: async () => [],
                },
                loaded: () => commits,
            },
        } as never);
        const relays = () =>
            delivery.mock.calls.flat().filter((msg) => msg.type === "startCiBisectInChecks");
        try {
            await receive?.({ type: "ready" });
            available = false;
            provider.startCiBisect(commits);
            await flush();
            expect(await delivery.mock.results.at(-1)?.value, "the view refused the relay").toBe(
                false,
            );
            available = true;
            await receive?.({ type: "ready" });
            expect(
                relays(),
                "undelivered relay should be sent again after the view reloads",
            ).toEqual([
                expect.objectContaining({ repoKey: "/A", commits }),
                expect.objectContaining({ repoKey: "/A", commits }),
            ]);
            await flush();
            await receive?.({ type: "ready" });
            expect(relays(), "a delivered relay is not sent a third time").toHaveLength(2);
        } finally {
            provider.dispose();
        }
    });

    /** A ready view whose every post waits until the test answers it. */
    function heldRelay() {
        setE2eControlChannelActive(true);
        const provider = new CommitInfoViewProvider(createFakeExtensionUri());
        let receive!: (message: unknown) => Promise<unknown>;
        const answers: Array<{ type: string; answer: (delivered: boolean) => void }> = [];
        const delivery = vi.fn(
            (message: { type: string }) =>
                new Promise<boolean>((answer) => answers.push({ type: message.type, answer })),
        );
        provider.resolveWebviewView(
            {
                webview: {
                    options: {},
                    html: "",
                    cspSource: "vscode-webview://fake",
                    asWebviewUri: (uri: vscode.Uri) => uri,
                    onDidReceiveMessage: (listener: typeof receive) => {
                        receive = listener;
                        return { dispose(): void {} };
                    },
                    postMessage: delivery,
                },
                onDidDispose: () => ({ dispose(): void {} }),
            } as unknown as vscode.WebviewView,
            {} as never,
            {} as never,
        );
        provider.setCiSource({
            enabled: true,
            repoKey: () => "/A",
            getDetail: vi.fn(),
            bisect: { source: {}, loaded: () => [] },
        } as never);
        const relays = () =>
            delivery.mock.calls.flat().filter((msg) => msg.type === "startCiBisectInChecks");
        const relayAnswers = () => answers.filter(({ type }) => type === "startCiBisectInChecks");
        return { provider, receive: (msg: unknown) => receive(msg), answers, relays, relayAnswers };
    }

    const first = [{ hash: "a".repeat(40), parents: ["b".repeat(40)] }];
    const second = [{ hash: "c".repeat(40), parents: ["d".repeat(40)] }];

    it("one click is relayed once even when ready re-runs while it is in flight", async () => {
        const { provider, receive, answers, relays } = heldRelay();
        try {
            await receive({ type: "ready" });
            let initDone!: () => void;
            const iconTheme = (provider as unknown as { iconTheme: object }).iconTheme as {
                initIconThemeData(): Promise<void>;
            };
            vi.spyOn(iconTheme, "initIconThemeData").mockImplementationOnce(
                () => new Promise<void>((resolve) => (initDone = resolve)),
            );
            const reload = receive({ type: "ready" });
            provider.startCiBisect(first);
            initDone();
            await reload;
            answers.forEach(({ answer }) => answer(true));
            await flush();
            expect(
                relays(),
                "one click is relayed once even when ready re-runs while it is in flight",
            ).toHaveLength(1);
        } finally {
            provider.dispose();
        }
    });

    it("a second click made while the first relay is in flight survives the first delivery", async () => {
        const { provider, receive, relays, relayAnswers } = heldRelay();
        try {
            await receive({ type: "ready" });
            provider.startCiBisect(first);
            provider.startCiBisect(second);
            const [firstPost, secondPost] = relayAnswers();
            firstPost.answer(true);
            secondPost.answer(false);
            await flush();
            await receive({ type: "ready" });
            expect(
                relays().map((msg) => (msg as { commits?: unknown }).commits),
                "the undelivered second click is sent again after the reload",
            ).toEqual([first, second, second]);
        } finally {
            provider.dispose();
        }
    });
});
