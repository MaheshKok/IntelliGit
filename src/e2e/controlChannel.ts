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
import { removeRequestFile, watchChannelDir, writeResponseFileAtomic } from "./transportFs";
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

    const watcher = watchChannelDir(channelDir, (nonce, payload) => {
        // `dispatchRequest` turns every parse and handler failure into an error response, so it
        // never rejects -- but the callback below is not covered by that. `removeRequestFile`
        // and `writeResponseFileAtomic` are synchronous filesystem calls that can throw (the
        // channel directory removed by test teardown while a request was in flight, a full
        // volume, something already occupying the response path). A throw there, with no
        // rejection handler attached, is an unhandled promise rejection in the extension host
        // that names no request at all -- so it is caught and reported against its own nonce.
        dispatchRequest(context, webviewRegistry, digestSalt, nonce, payload)
            .then((response) => {
                removeRequestFile(channelDir, nonce);
                writeResponseFileAtomic(channelDir, nonce, response);
            })
            .catch((error: unknown) => {
                console.error(
                    `E2E control channel failed to finalize request "${nonce}": ${getErrorMessage(error)}`,
                );
            });
    });

    return {
        active: true,
        webviewRegistry,
        dispose: () => {
            watcher.dispose();
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
