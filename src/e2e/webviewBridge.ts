// Host-side registry of live webviews for the E2E control channel's webview-state leg.
// `getState`/`setState` are renderer-side only (src/webviews/react/shared/vscodeApi.ts) --
// no extension-host API reads them -- so this bridges an E2E webviewState request across
// the host/webview boundary via `postMessage`/`onDidReceiveMessage`, correlating replies by
// a per-call id. A missing webview, an unmounted state bridge, or a timeout is a hard
// failure, never an empty snapshot: silently returning "no state" for a broken bridge would
// be a false green (PLAN.md Phase 1 step 10).

import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";

import { isAllowedWebviewStateKey } from "./allowlist";
import type { E2eResponse, E2eWebviewStateRequest } from "./protocol";
import { errorResponse, okAckResponse, okValueResponse } from "./protocol";

const DEFAULT_TIMEOUT_MS = 5000;
const BRIDGE_MESSAGE_SOURCE = "intelligitE2E";

interface PendingCall {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

interface RegisteredWebview {
    webview: vscode.Webview;
    disposeListener: () => void;
}

/** Shape of a reply the webview-side state bridge posts back to the host. */
interface BridgeReply {
    source: typeof BRIDGE_MESSAGE_SOURCE;
    callId: string;
    ok: boolean;
    value?: unknown;
    error?: string;
}

function isBridgeReply(message: unknown): message is BridgeReply {
    if (typeof message !== "object" || message === null) {
        return false;
    }
    const record = message as Record<string, unknown>;
    return record.source === BRIDGE_MESSAGE_SOURCE && typeof record.callId === "string";
}

/**
 * Host-side registry mapping a stable view id (see `deriveE2eViewId` in
 * `src/views/webviewHtml.ts`) to the live `vscode.Webview` currently showing that view.
 * Registration is idempotent: registering the same view id again replaces the previous
 * webview and disposes its message listener, so callers never need to manage a disposable
 * themselves.
 */
export class E2eWebviewRegistry {
    private readonly webviews = new Map<string, RegisteredWebview>();
    private readonly pending = new Map<string, PendingCall>();
    private readonly timeoutMs: number;

    /** Constructs a registry, optionally overriding the correlated-call timeout (tests only). */
    constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
        this.timeoutMs = timeoutMs;
    }

    /** Registers the live webview currently showing `viewId`, replacing any prior one. */
    register(viewId: string, webview: vscode.Webview): void {
        this.webviews.get(viewId)?.disposeListener();
        const messageSub = webview.onDidReceiveMessage((message: unknown) => {
            this.handleWebviewMessage(message);
        });
        this.webviews.set(viewId, {
            webview,
            disposeListener: () => {
                messageSub.dispose();
            },
        });
    }

    /** Disposes every registered webview's message listener. Called on control-channel disposal. */
    disposeAll(): void {
        for (const entry of this.webviews.values()) {
            entry.disposeListener();
        }
        this.webviews.clear();
    }

    private handleWebviewMessage(message: unknown): void {
        if (!isBridgeReply(message)) {
            return;
        }
        const pending = this.pending.get(message.callId);
        if (!pending) {
            return;
        }
        this.pending.delete(message.callId);
        if (message.ok) {
            pending.resolve(message.value);
        } else {
            pending.reject(new Error(message.error ?? "E2E webview call failed"));
        }
    }

    /** Handles one webviewState seed/snapshot/reset request end to end. */
    async handleRequest(request: E2eWebviewStateRequest): Promise<E2eResponse> {
        if (!isAllowedWebviewStateKey(request.key)) {
            return errorResponse(
                request.nonce,
                `Webview state key "${request.key}" is not allowlisted`,
            );
        }

        const webview = this.webviews.get(request.viewId)?.webview;
        if (!webview) {
            return errorResponse(
                request.nonce,
                `No live webview registered for viewId "${request.viewId}"`,
            );
        }

        return this.callWebview(webview, request);
    }

    private async callWebview(
        webview: vscode.Webview,
        request: E2eWebviewStateRequest,
    ): Promise<E2eResponse> {
        const callId = randomUUID();
        const callPromise = this.awaitReply(callId);
        const posted = await webview.postMessage({
            source: BRIDGE_MESSAGE_SOURCE,
            callId,
            operation: request.operation,
            key: request.key,
            value: "value" in request ? request.value : undefined,
        });
        if (!posted) {
            this.pending.delete(callId);
            return errorResponse(
                request.nonce,
                `postMessage to viewId "${request.viewId}" was rejected (webview not visible or disposed)`,
            );
        }

        try {
            const value = await callPromise;
            if (request.operation === "snapshot") {
                return okValueResponse(request.nonce, value);
            }
            return okAckResponse(request.nonce);
        } catch (error) {
            return errorResponse(
                request.nonce,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * Awaits a correlated reply for `callId`, rejecting hard if none arrives before the
     * configured timeout. A silent timeout would let a dead webview look like an empty
     * snapshot, which this channel's spec explicitly forbids.
     */
    private awaitReply(callId: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(callId);
                reject(
                    new Error(
                        `E2E webview call "${callId}" timed out after ${this.timeoutMs}ms (no reply from webview state bridge)`,
                    ),
                );
            }, this.timeoutMs);
            this.pending.set(callId, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });
    }
}
