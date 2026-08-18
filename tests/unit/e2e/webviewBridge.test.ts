// Spec-derived tests for the E2E control channel's webview-state bridge (PLAN.md Phase 1
// step 10): "A missing, unmounted, or unacknowledged view is a hard failure, never an empty
// snapshot. Each request carries a correlation ID and a timeout." Every negative case here
// asserts `ok: false` with a descriptive error -- never a successful empty-value response,
// which would be indistinguishable from "the webview genuinely has no state for this key".

import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { E2eWebviewStateRequest } from "../../../src/e2e/protocol";
import { E2eWebviewRegistry } from "../../../src/e2e/webviewBridge";

type MessageListener = (message: unknown) => void;

interface FakeWebview {
    webview: vscode.Webview;
    posted: Record<string, unknown>[];
    listeners: MessageListener[];
    disposeCalls: number;
}

/**
 * A controllable double for `vscode.Webview` that captures posted messages and lets a test
 * simulate the webview-side bridge's reply by invoking the captured listener directly.
 */
function makeFakeWebview(postMessageResult: boolean | (() => boolean) = true): FakeWebview {
    const state: FakeWebview = {
        webview: undefined as unknown as vscode.Webview,
        posted: [],
        listeners: [],
        disposeCalls: 0,
    };

    state.webview = {
        postMessage: async (message: Record<string, unknown>) => {
            state.posted.push(message);
            return typeof postMessageResult === "function"
                ? postMessageResult()
                : postMessageResult;
        },
        onDidReceiveMessage: (listener: MessageListener) => {
            state.listeners.push(listener);
            return {
                dispose: () => {
                    state.disposeCalls += 1;
                },
            };
        },
    } as unknown as vscode.Webview;

    return state;
}

/** Simulates the webview-side bridge replying to the most recently posted correlated call. */
function replyToLatest(
    fake: FakeWebview,
    reply: { ok: true; value: unknown } | { ok: false; error: string },
): void {
    const lastMessage = fake.posted[fake.posted.length - 1];
    const callId = lastMessage?.callId as string;
    fake.listeners[fake.listeners.length - 1]?.({ source: "intelligitE2E", callId, ...reply });
}

function snapshotRequest(overrides: Partial<E2eWebviewStateRequest> = {}): E2eWebviewStateRequest {
    return {
        nonce: "n1",
        store: "webviewState",
        operation: "snapshot",
        viewId: "commit-panel",
        key: "groupByDir",
        ...overrides,
    } as E2eWebviewStateRequest;
}

describe("E2eWebviewRegistry: allowlist rejection", () => {
    it("rejects an unlisted webview-state key without ever posting to the webview", async () => {
        const registry = new E2eWebviewRegistry();
        const fake = makeFakeWebview();
        registry.register("commit-panel", fake.webview);

        const response = await registry.handleRequest(
            snapshotRequest({ key: "somethingNotAllowlisted" }),
        );

        expect(response).toEqual({
            nonce: "n1",
            ok: false,
            error: expect.stringContaining("not allowlisted"),
        });
        expect(fake.posted).toHaveLength(0);
    });
});

describe("E2eWebviewRegistry: hard failure on a missing webview", () => {
    it("fails with a descriptive error, not an empty snapshot, when no webview is registered", async () => {
        const registry = new E2eWebviewRegistry();

        const response = await registry.handleRequest(
            snapshotRequest({ viewId: "never-registered" }),
        );

        expect(response.ok).toBe(false);
        if (!response.ok) {
            expect(response.error).toContain("never-registered");
            expect(response.error).toContain("No live webview registered");
        }
    });
});

describe("E2eWebviewRegistry: correlated round trip", () => {
    it("resolves a snapshot request when the webview replies with a matching callId", async () => {
        const registry = new E2eWebviewRegistry();
        const fake = makeFakeWebview();
        registry.register("commit-panel", fake.webview);

        const responsePromise = registry.handleRequest(snapshotRequest());
        await flushMicrotasks();

        expect(fake.posted).toHaveLength(1);
        expect(fake.posted[0]).toMatchObject({
            source: "intelligitE2E",
            operation: "snapshot",
            key: "groupByDir",
        });
        expect(typeof fake.posted[0]?.callId).toBe("string");

        replyToLatest(fake, { ok: true, value: true });

        await expect(responsePromise).resolves.toEqual({
            nonce: "n1",
            ok: true,
            result: { kind: "value", value: true },
        });
    });

    it("resolves a seed request as a bare acknowledgement, not a value echo", async () => {
        const registry = new E2eWebviewRegistry();
        const fake = makeFakeWebview();
        registry.register("commit-panel", fake.webview);

        const responsePromise = registry.handleRequest(
            snapshotRequest({ operation: "seed", value: false } as Partial<E2eWebviewStateRequest>),
        );
        await flushMicrotasks();
        expect(fake.posted[0]).toMatchObject({ operation: "seed", value: false });

        replyToLatest(fake, { ok: true, value: null });

        await expect(responsePromise).resolves.toEqual({ nonce: "n1", ok: true });
    });

    it("resolves a reset request as a bare acknowledgement", async () => {
        const registry = new E2eWebviewRegistry();
        const fake = makeFakeWebview();
        registry.register("commit-panel", fake.webview);

        const responsePromise = registry.handleRequest(
            snapshotRequest({ operation: "reset" } as Partial<E2eWebviewStateRequest>),
        );
        await flushMicrotasks();
        replyToLatest(fake, { ok: true, value: null });

        await expect(responsePromise).resolves.toEqual({ nonce: "n1", ok: true });
    });

    it("surfaces a webview-reported failure (ok: false) as an error response", async () => {
        const registry = new E2eWebviewRegistry();
        const fake = makeFakeWebview();
        registry.register("commit-panel", fake.webview);

        const responsePromise = registry.handleRequest(snapshotRequest());
        await flushMicrotasks();
        replyToLatest(fake, { ok: false, error: "webview-side key rejection" });

        const response = await responsePromise;
        expect(response.ok).toBe(false);
        if (!response.ok) {
            expect(response.error).toBe("webview-side key rejection");
        }
    });

    it("ignores a reply carrying an unknown callId, leaving the real call still pending", async () => {
        const registry = new E2eWebviewRegistry();
        const fake = makeFakeWebview();
        registry.register("commit-panel", fake.webview);

        const responsePromise = registry.handleRequest(snapshotRequest());
        await flushMicrotasks();

        fake.listeners[0]?.({
            source: "intelligitE2E",
            callId: "unrelated-call-id",
            ok: true,
            value: 1,
        });
        fake.listeners[0]?.({ source: "someOtherProtocol", callId: fake.posted[0]?.callId });

        replyToLatest(fake, { ok: true, value: "real reply" });

        await expect(responsePromise).resolves.toEqual({
            nonce: "n1",
            ok: true,
            result: { kind: "value", value: "real reply" },
        });
    });
});

describe("E2eWebviewRegistry: hard failure on postMessage rejection", () => {
    it("fails immediately when postMessage returns false (webview not visible/disposed)", async () => {
        const registry = new E2eWebviewRegistry();
        const fake = makeFakeWebview(false);
        registry.register("commit-panel", fake.webview);

        const response = await registry.handleRequest(snapshotRequest());

        expect(response.ok).toBe(false);
        if (!response.ok) {
            expect(response.error).toContain("postMessage");
        }
    });

    /**
     * The timeout timer must die with the call it belongs to. `awaitReply` arms a timer and
     * stores its `clearTimeout` inside the resolve/reject wrappers, both reachable only through
     * the `pending` map -- so deleting the map entry directly, which is what the rejected-
     * postMessage path does, drops the only handle that could ever clear it.
     *
     * The surviving timer is not merely untidy. It later fires `reject` on a promise nobody is
     * awaiting any more (`handleRequest` returned its error response long before), which is an
     * unhandled rejection in the extension host -- and a rejected `postMessage` is an ORDINARY
     * condition here, happening every time the target webview is hidden or disposed.
     *
     * The assertion is the live timer count rather than "no unhandled rejection fired", because
     * the count is checkable at the instant the response is returned, with nothing to wait for
     * and no reliance on the runner's rejection reporting.
     */
    it("leaves no live timer behind when postMessage is rejected", async () => {
        vi.useFakeTimers();
        try {
            const registry = new E2eWebviewRegistry();
            const fake = makeFakeWebview(false);
            registry.register("commit-panel", fake.webview);

            const response = await registry.handleRequest(snapshotRequest());
            expect(response.ok).toBe(false);

            expect(
                vi.getTimerCount(),
                "the correlated-call timeout outlived the call it belonged to; when it fires it " +
                    "rejects a promise no one is awaiting, which is an unhandled rejection in the host",
            ).toBe(0);

            // Nothing left to fire: advancing well past the default timeout must be inert.
            await vi.advanceTimersByTimeAsync(10_000);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("E2eWebviewRegistry: hard failure on timeout", () => {
    it("fails with a timeout error when the webview never replies", async () => {
        const registry = new E2eWebviewRegistry(30);
        const fake = makeFakeWebview();
        registry.register("commit-panel", fake.webview);

        const response = await registry.handleRequest(snapshotRequest());

        expect(response.ok).toBe(false);
        if (!response.ok) {
            expect(response.error).toMatch(/timed out/);
        }
    });
});

describe("E2eWebviewRegistry: re-registration", () => {
    it("disposes the previous listener when the same viewId is registered again", () => {
        const registry = new E2eWebviewRegistry();
        const first = makeFakeWebview();
        const second = makeFakeWebview();

        registry.register("commit-panel", first.webview);
        registry.register("commit-panel", second.webview);

        expect(first.disposeCalls).toBe(1);
    });
});

/** Flushes pending microtasks so an in-flight `handleRequest` call has posted its message. */
function flushMicrotasks(): Promise<void> {
    return Promise.resolve().then(() => Promise.resolve());
}
