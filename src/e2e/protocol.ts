// Request/response envelope for the E2E control channel's file transport. One request
// addresses exactly one key in exactly one store (memento, secret, or webviewState) with
// exactly one operation (seed, snapshot, reset); see PLAN.md Phase 1 step 10. Parsing is
// manual (matching this repo's existing boundary-validation convention in
// src/views/messageValidation.ts) rather than a schema library: every field is untrusted
// input crossing a process boundary via a JSON file Playwright wrote, so nothing here may
// assume a well-formed shape.

import type { MementoScope } from "./allowlist";

type E2eOperation = "seed" | "snapshot" | "reset";

interface E2eMementoRequestBase {
    readonly nonce: string;
    readonly store: "memento";
    readonly scope: MementoScope;
    readonly key: string;
}

/** A memento seed/snapshot/reset request, addressed by scope + key. */
export type E2eMementoRequest =
    | (E2eMementoRequestBase & { readonly operation: "seed"; readonly value: unknown })
    | (E2eMementoRequestBase & { readonly operation: "snapshot" })
    | (E2eMementoRequestBase & { readonly operation: "reset" });

interface E2eSecretRequestBase {
    readonly nonce: string;
    readonly store: "secret";
    readonly key: string;
}

/** A secret seed/snapshot/reset request. Snapshot never returns the raw value. */
export type E2eSecretRequest =
    | (E2eSecretRequestBase & { readonly operation: "seed"; readonly value: string })
    | (E2eSecretRequestBase & { readonly operation: "snapshot" })
    | (E2eSecretRequestBase & { readonly operation: "reset" });

interface E2eWebviewStateRequestBase {
    readonly nonce: string;
    readonly store: "webviewState";
    readonly viewId: string;
    readonly key: string;
}

/** A webview-state seed/snapshot/reset request, addressed by viewId + key. */
export type E2eWebviewStateRequest =
    | (E2eWebviewStateRequestBase & { readonly operation: "seed"; readonly value: unknown })
    | (E2eWebviewStateRequestBase & { readonly operation: "snapshot" })
    | (E2eWebviewStateRequestBase & { readonly operation: "reset" });

/** One correlated request written by the Playwright-side client as `<nonce>.request.json`. */
export type E2eRequest = E2eMementoRequest | E2eSecretRequest | E2eWebviewStateRequest;

/** The payload carried by a successful response, shaped per the request that produced it. */
type E2eResult =
    | { readonly kind: "value"; readonly value: unknown }
    | { readonly kind: "secretPresence"; readonly present: boolean; readonly digest?: string };

/** A successful response. `result` is omitted for a bare seed/reset acknowledgement. */
export interface E2eOkResponse {
    readonly nonce: string;
    readonly ok: true;
    readonly result?: E2eResult;
}

/** A failed response -- an allowlist rejection, a malformed request, or a handler error. */
export interface E2eErrorResponse {
    readonly nonce: string;
    readonly ok: false;
    readonly error: string;
}

/** One correlated reply written by the extension as `<nonce>.response.json`. */
export type E2eResponse = E2eOkResponse | E2eErrorResponse;

function assertRecord(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${context} must be a JSON object`);
    }
    return value as Record<string, unknown>;
}

function assertString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`E2E request field "${field}" must be a non-empty string`);
    }
    return value;
}

function assertScope(value: unknown): MementoScope {
    if (value !== "global" && value !== "workspace") {
        throw new Error(
            `E2E request field "scope" must be "global" or "workspace", got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

function assertOperation(value: unknown): E2eOperation {
    if (value !== "seed" && value !== "snapshot" && value !== "reset") {
        throw new Error(
            `E2E request field "operation" must be "seed", "snapshot", or "reset", got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

function parseMementoRequest(
    record: Record<string, unknown>,
    nonce: string,
    operation: E2eOperation,
): E2eMementoRequest {
    const scope = assertScope(record.scope);
    const key = assertString(record.key, "key");
    if (operation === "seed") {
        if (!("value" in record)) {
            throw new Error('E2E memento seed request is missing field "value"');
        }
        return { nonce, store: "memento", operation, scope, key, value: record.value };
    }
    return { nonce, store: "memento", operation, scope, key };
}

function parseSecretRequest(
    record: Record<string, unknown>,
    nonce: string,
    operation: E2eOperation,
): E2eSecretRequest {
    const key = assertString(record.key, "key");
    if (operation === "seed") {
        return {
            nonce,
            store: "secret",
            operation,
            key,
            value: assertString(record.value, "value"),
        };
    }
    return { nonce, store: "secret", operation, key };
}

function parseWebviewStateRequest(
    record: Record<string, unknown>,
    nonce: string,
    operation: E2eOperation,
): E2eWebviewStateRequest {
    const viewId = assertString(record.viewId, "viewId");
    const key = assertString(record.key, "key");
    if (operation === "seed") {
        if (!("value" in record)) {
            throw new Error('E2E webviewState seed request is missing field "value"');
        }
        return { nonce, store: "webviewState", operation, viewId, key, value: record.value };
    }
    return { nonce, store: "webviewState", operation, viewId, key };
}

/**
 * Parses and validates an untrusted request payload read from `<nonce>.request.json`.
 * Throws on any structural or type mismatch -- callers convert that into an
 * {@link E2eErrorResponse} rather than letting a malformed file crash the watcher.
 */
export function parseE2eRequest(raw: unknown): E2eRequest {
    const record = assertRecord(raw, "E2E request");
    const nonce = assertString(record.nonce, "nonce");
    const operation = assertOperation(record.operation);
    const store = record.store;

    if (store === "memento") {
        return parseMementoRequest(record, nonce, operation);
    }
    if (store === "secret") {
        return parseSecretRequest(record, nonce, operation);
    }
    if (store === "webviewState") {
        return parseWebviewStateRequest(record, nonce, operation);
    }
    throw new Error(
        `E2E request field "store" must be "memento", "secret", or "webviewState", got ${JSON.stringify(store)}`,
    );
}

/** Builds a successful response carrying a snapshot's raw value (memento/webviewState). */
export function okValueResponse(nonce: string, value: unknown): E2eOkResponse {
    return { nonce, ok: true, result: { kind: "value", value } };
}

/** Builds a successful response carrying a secret's presence and digest, never its value. */
export function okSecretPresenceResponse(
    nonce: string,
    present: boolean,
    digest?: string,
): E2eOkResponse {
    return { nonce, ok: true, result: { kind: "secretPresence", present, digest } };
}

/** Builds a bare successful acknowledgement for a seed or reset request. */
export function okAckResponse(nonce: string): E2eOkResponse {
    return { nonce, ok: true };
}

/** Builds a failure response carrying a human-readable reason. */
export function errorResponse(nonce: string, error: string): E2eErrorResponse {
    return { nonce, ok: false, error };
}
