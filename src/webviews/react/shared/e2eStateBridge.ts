// Webview-side leg of the development-only E2E control channel. Installed from the single
// `acquireVsCodeApi` wrapper (src/webviews/react/shared/vscodeApi.ts), gated at runtime on
// `window.intelligitE2E` -- a flag the shell (src/views/webviewHtml.ts) injects only when the
// extension host's three-gate check passed. Runtime-gated, not build-gated: a build-time
// `define` would produce a different bundle for tests than for production. See PLAN.md
// Phase 1 step 10.

import type { VsCodeApi } from "./vscodeApiTypes";
import { isAllowedWebviewStateKey } from "../../../e2e/allowlist";

declare global {
    interface Window {
        /** Injected by the webview shell only when every host-side E2E gate has passed. */
        intelligitE2E?: boolean;
    }
}

const SOURCE = "intelligitE2E";
const REMOUNT_EVENT = "intelligit:e2e-seed";

type BridgeOperation = "seed" | "snapshot" | "reset";

interface BridgeRequest {
    source: typeof SOURCE;
    callId: string;
    operation: BridgeOperation;
    key: string;
    value?: unknown;
}

function isBridgeRequest(data: unknown): data is BridgeRequest {
    if (typeof data !== "object" || data === null) {
        return false;
    }
    const record = data as Record<string, unknown>;
    return (
        record.source === SOURCE &&
        typeof record.callId === "string" &&
        (record.operation === "seed" ||
            record.operation === "snapshot" ||
            record.operation === "reset") &&
        typeof record.key === "string"
    );
}

/** Normalizes the webview's persisted state blob to a plain, indexable record. */
function readStateRecord(api: VsCodeApi<unknown, unknown>): Record<string, unknown> {
    const raw = api.getState();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    return raw as Record<string, unknown>;
}

function postReply(
    api: VsCodeApi<unknown, unknown>,
    callId: string,
    reply: { ok: true; value: unknown } | { ok: false; error: string },
): void {
    api.postMessage({ source: SOURCE, callId, ...reply });
}

/**
 * Signals that persisted webview state changed underneath the mounted app. `setState` alone
 * does not re-render React, so a component that needs to reflect a seeded value immediately
 * must opt in by listening for this event and forcing its own remount; the post-reload
 * rehydration path (the E2E oracle's primary check) works regardless, since it only depends
 * on `getState`/`setState` persistence.
 */
function dispatchRemountSignal(key: string, value: unknown): void {
    window.dispatchEvent(new CustomEvent(REMOUNT_EVENT, { detail: { key, value } }));
}

/** Handles one correlated request from the extension host, always replying exactly once. */
function handleBridgeRequest(api: VsCodeApi<unknown, unknown>, request: BridgeRequest): void {
    if (!isAllowedWebviewStateKey(request.key)) {
        postReply(api, request.callId, {
            ok: false,
            error: `Webview state key "${request.key}" is not allowlisted`,
        });
        return;
    }

    const state = readStateRecord(api);

    if (request.operation === "snapshot") {
        postReply(api, request.callId, { ok: true, value: state[request.key] ?? null });
        return;
    }

    if (request.operation === "seed") {
        api.setState({ ...state, [request.key]: request.value });
        dispatchRemountSignal(request.key, request.value);
        postReply(api, request.callId, { ok: true, value: null });
        return;
    }

    const nextState: Record<string, unknown> = { ...state };
    delete nextState[request.key];
    api.setState(nextState);
    dispatchRemountSignal(request.key, undefined);
    postReply(api, request.callId, { ok: true, value: null });
}

/**
 * Installs the webview-side leg of the E2E control channel. A no-op unless a `window` global
 * exists AND `window.intelligitE2E` is `true`, so in a production install this never attaches a
 * message listener -- only the (inert) code for it ships in the bundle, bounded by the fact that
 * webview messaging is reachable only from the extension host behind the nonce CSP. The
 * `typeof window` check guards `getVsCodeApi()` (which unconditionally calls this) being
 * exercised outside a real browser/webview document, e.g. from a plain Node unit test.
 */
export function installE2eStateBridge(api: VsCodeApi<unknown, unknown>): void {
    if (typeof window === "undefined" || window.intelligitE2E !== true) {
        return;
    }

    window.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (!isBridgeRequest(event.data)) {
            return;
        }
        handleBridgeRequest(api, event.data);
    });
}
