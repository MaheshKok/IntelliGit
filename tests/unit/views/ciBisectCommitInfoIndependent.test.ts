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
});
