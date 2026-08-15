// Orchestrates the development-only E2E control channel: evaluates the three-gate check,
// and -- only when it passes -- starts watching the channel directory, routing each parsed
// request to the handler for its store, and writing the correlated response back atomically.
// This is the single entry point `src/extension.ts` calls from `activate()`; every other
// module under `src/e2e/` is wired together here. See PLAN.md Phase 1 step 10.

import type * as vscode from "vscode";

import { getErrorMessage } from "../utils/errors";
import { setE2eControlChannelActive, setE2eWebviewRegistry } from "./activationState";
import { evaluateE2eGate } from "./gate";
import { handleMementoRequest } from "./handlers/mementoHandler";
import { handleSecretRequest } from "./handlers/secretHandler";
import type { E2eRequest, E2eResponse } from "./protocol";
import { errorResponse, parseE2eRequest } from "./protocol";
import { generateSecretDigestSalt } from "./secretDigest";
import {
    listRequestNonces,
    readRequestFile,
    removeChannelReadyMarker,
    removeRequestFile,
    watchChannelDir,
    writeChannelReadyMarker,
    writeResponseFileAtomic,
} from "./transportFs";
import { E2eWebviewRegistry } from "./webviewBridge";

/**
 * Handle returned by {@link activateE2eControlChannel}, always non-null even when the gate
 * rejects activation -- callers push `dispose()` unconditionally and check `active` if they
 * need to know whether the channel is live.
 */
export interface E2eControlChannelHandle {
    readonly active: boolean;
    readonly webviewRegistry: E2eWebviewRegistry;
    dispose(): void;
}

/**
 * How long an answered request may keep having its response re-written before the channel gives up
 * on it.
 *
 * Bounded in time rather than in attempts, because the useful bound is "someone is still waiting":
 * the client abandons a request after 30s (`DEFAULT_RESPONSE_TIMEOUT_MS` in
 * `tests/e2e/controlChannelClient.ts`), and a write that lands after that is delivered to nobody.
 * An attempt count would instead encode the reconciliation tick rate -- three attempts is 150ms,
 * which abandons a response path that was merely occupied for a moment, exactly the transient
 * worth retrying. Past this window the request is dropped, so a durable failure such as a full
 * volume costs a bounded burst rather than one failed write per tick for the life of the host.
 */
const DELIVERY_RETRY_WINDOW_MS = 30_000;

/**
 * Activates the development-only E2E control channel when, and only when, all three gates
 * in {@link evaluateE2eGate} pass. Safe to call unconditionally from `activate()` in every
 * install -- production included -- since a failed gate performs no watcher, no file I/O
 * beyond the gate's own read-only directory probe, and registers no command.
 */
export function activateE2eControlChannel(
    context: vscode.ExtensionContext,
): E2eControlChannelHandle {
    const webviewRegistry = new E2eWebviewRegistry();
    setE2eWebviewRegistry(webviewRegistry);

    const gateResult = evaluateE2eGate(context.extensionMode, process.env);
    setE2eControlChannelActive(gateResult.active);

    if (!gateResult.active || gateResult.channelDir === undefined) {
        return {
            active: false,
            webviewRegistry,
            dispose: () => setE2eControlChannelActive(false),
        };
    }

    const channelDir = gateResult.channelDir;
    const digestSalt = generateSecretDigestSalt();

    const dispatchedNonces = new Set<string>();
    /**
     * Answered requests whose response could not be written, with the delivery attempts spent so
     * far. Retrying from here is what keeps a failed write from re-running the handler: the
     * request file survives an undelivered response, so reconciliation offers the same nonce
     * back, and re-dispatching it would seed a memento or store a secret a second time.
     */
    const pendingDeliveries = new Map<string, { response: E2eResponse; expiresAt: number }>();

    /**
     * Writes the response and consumes the request, keeping the response for another attempt when
     * the write fails and the retry window has not closed. Never throws -- it is the tail of a
     * floating promise, and what retries is the reconciliation loop, not a rejection handler.
     */
    const deliver = (nonce: string, response: E2eResponse, expiresAt: number): void => {
        try {
            // Response before removal: a request consumed ahead of its response is lost outright
            // when the write fails, and leaves the client's timeout diagnostic blaming a watcher
            // that did observe the request.
            writeResponseFileAtomic(channelDir, nonce, response);
            removeRequestFile(channelDir, nonce);
            pendingDeliveries.delete(nonce);
        } catch (error) {
            console.error(
                `E2E control channel failed to deliver the response to request "${nonce}": ${getErrorMessage(error)}`,
            );
            if (Date.now() >= expiresAt) {
                // Dropping the cached response while keeping the nonce claimed makes every later
                // reconciliation tick a no-op for this request -- it is neither re-answered nor
                // re-delivered. Nothing is lost that was not already lost: the client stopped
                // waiting when its own timeout elapsed.
                pendingDeliveries.delete(nonce);
                return;
            }
            pendingDeliveries.set(nonce, { response, expiresAt });
        }
    };

    const dispatchOnce = (nonce: string, payload: unknown): void => {
        if (dispatchedNonces.has(nonce)) {
            // Already answered. A cached response means only the write failed, so this offer is
            // the surviving request coming back -- retry the delivery alone, never the handler.
            const pending = pendingDeliveries.get(nonce);
            if (pending !== undefined) {
                deliver(nonce, pending.response, pending.expiresAt);
            }
            return;
        }
        dispatchedNonces.add(nonce);
        // `dispatchRequest` turns every parse and handler failure into an error response, so it
        // never rejects, and `deliver` swallows its own filesystem failures. The rejection
        // handler is the backstop for anything neither of them anticipated: without it, a throw
        // on this floating promise is an unhandled rejection in the extension host that names no
        // request at all.
        void dispatchRequest(context, webviewRegistry, digestSalt, nonce, payload)
            .then((response) => deliver(nonce, response, Date.now() + DELIVERY_RETRY_WINDOW_MS))
            .catch((error: unknown) => {
                console.error(
                    `E2E control channel failed to answer request "${nonce}": ${getErrorMessage(error)}`,
                );
            });
    };

    // The watcher must exist before the scan: a file created between scan and watch would
    // otherwise recreate the exact activation race this drain is fixing. `dispatchOnce`
    // makes the overlap safe when both paths observe the same nonce.
    const watcher = watchChannelDir(channelDir, dispatchOnce);
    for (const nonce of listRequestNonces(channelDir)) {
        let payload: unknown;
        try {
            payload = readRequestFile(channelDir, nonce);
        } catch {
            // Unreadable at drain time. Skipped silently rather than logged: the reconciliation
            // loop started above reaches the same file on its next tick and reports it there,
            // and logging here as well would name one nonce twice for a single bad request.
            continue;
        }
        if (payload !== undefined) {
            dispatchOnce(nonce, payload);
        }
    }
    writeChannelReadyMarker(channelDir);

    return {
        active: true,
        webviewRegistry,
        dispose: () => {
            watcher.dispose();
            removeChannelReadyMarker(channelDir);
            webviewRegistry.disposeAll();
            setE2eControlChannelActive(false);
        },
    };
}

/**
 * Routes one parsed E2E request to the handler for its store, catching and reporting any
 * parse or handler failure as an error response rather than letting it crash the watcher
 * callback (which would silently stop processing every later request too).
 */
async function dispatchRequest(
    context: vscode.ExtensionContext,
    webviewRegistry: E2eWebviewRegistry,
    digestSalt: string,
    nonce: string,
    payload: unknown,
): Promise<E2eResponse> {
    let request: E2eRequest;
    try {
        request = parseE2eRequest(payload);
    } catch (error) {
        return errorResponse(nonce, getErrorMessage(error));
    }

    try {
        if (request.store === "memento") {
            return await handleMementoRequest(context, request);
        }
        if (request.store === "secret") {
            return await handleSecretRequest(context.secrets, digestSalt, request);
        }
        return await webviewRegistry.handleRequest(request);
    } catch (error) {
        return errorResponse(request.nonce, getErrorMessage(error));
    }
}
