// Executes memento (globalState/workspaceState) requests for the E2E control channel
// against the real `vscode.Memento` the extension host uses in production -- never a mock
// or a shadow store -- so a snapshot genuinely reflects what production code would see.

import type * as vscode from "vscode";

import { isAllowedMementoKey } from "../allowlist";
import type { E2eMementoRequest, E2eResponse } from "../protocol";
import { errorResponse, okAckResponse, okValueResponse } from "../protocol";

/** Resolves the correct Memento (`globalState` or `workspaceState`) for a request's scope. */
function mementoFor(
    context: Pick<vscode.ExtensionContext, "globalState" | "workspaceState">,
    scope: "global" | "workspace",
): vscode.Memento {
    return scope === "global" ? context.globalState : context.workspaceState;
}

/**
 * Executes a memento seed/snapshot/reset request. Rejects any key absent from
 * `MEMENTO_ALLOWLIST` before it ever reaches `Memento.get`/`Memento.update` -- an unlisted
 * key is a rejection, never a passthrough.
 */
export async function handleMementoRequest(
    context: Pick<vscode.ExtensionContext, "globalState" | "workspaceState">,
    request: E2eMementoRequest,
): Promise<E2eResponse> {
    if (!isAllowedMementoKey(request.scope, request.key)) {
        return errorResponse(
            request.nonce,
            `Memento key "${request.key}" (scope: ${request.scope}) is not allowlisted`,
        );
    }

    const memento = mementoFor(context, request.scope);

    if (request.operation === "snapshot") {
        return okValueResponse(request.nonce, memento.get(request.key) ?? null);
    }

    if (request.operation === "seed") {
        await memento.update(request.key, request.value);
        return okAckResponse(request.nonce);
    }

    await memento.update(request.key, undefined);
    return okAckResponse(request.nonce);
}
