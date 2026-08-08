// Executes secret (SecretStorage) requests for the E2E control channel against the real
// `vscode.SecretStorage` the extension host uses in production. Snapshot NEVER returns the
// raw value -- only presence and a salted digest -- because the flows this exists for need
// "is commitChecks signed in", not the token itself; returning values would build a
// credential-exfiltration surface just to satisfy a test assertion (PLAN.md Phase 1 step 10).

import type * as vscode from "vscode";

import { getErrorMessage } from "../../utils/errors";
import { isAllowedSecretKey } from "../allowlist";
import type { E2eResponse, E2eSecretRequest } from "../protocol";
import { errorResponse, okAckResponse, okSecretPresenceResponse } from "../protocol";
import { digestSecret } from "../secretDigest";

/**
 * Executes a secret seed/snapshot/reset request. Rejects any key absent from
 * `SECRET_ALLOWLIST` before it ever reaches `SecretStorage.get`/`store`/`delete`.
 */
export async function handleSecretRequest(
    secrets: vscode.SecretStorage,
    digestSalt: string,
    request: E2eSecretRequest,
): Promise<E2eResponse> {
    if (!isAllowedSecretKey(request.key)) {
        return errorResponse(request.nonce, `Secret key "${request.key}" is not allowlisted`);
    }

    if (request.operation === "snapshot") {
        const value = await secrets.get(request.key);
        if (value === undefined) {
            return okSecretPresenceResponse(request.nonce, false);
        }
        return okSecretPresenceResponse(request.nonce, true, digestSecret(value, digestSalt));
    }

    try {
        if (request.operation === "seed") {
            await secrets.store(request.key, request.value);
        } else {
            await secrets.delete(request.key);
        }
        return okAckResponse(request.nonce);
    } catch (error) {
        return errorResponse(request.nonce, getErrorMessage(error));
    }
}
