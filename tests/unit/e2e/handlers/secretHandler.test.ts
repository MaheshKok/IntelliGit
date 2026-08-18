// Spec-derived tests for the E2E control channel's secret handler. The mandatory contract:
// "a secret request returns presence+digest and the raw value appears NOWHERE in the
// response payload" -- every snapshot assertion here serializes the full response with
// JSON.stringify and searches for the raw secret, not just the field it expects to be
// absent, so a handler that leaked the value into an unexpected field would still be caught.

import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { handleSecretRequest } from "../../../../src/e2e/handlers/secretHandler";
import type { E2eSecretRequest } from "../../../../src/e2e/protocol";
import { digestSecret } from "../../../../src/e2e/secretDigest";

const ALLOWED_KEY = "intelligit.commitChecks.token:gitlab.com";
const SALT = "test-salt";

/** Builds a Map-backed double for `vscode.SecretStorage`. */
function makeSecretStorage(seed: Record<string, string> = {}): vscode.SecretStorage {
    const map = new Map<string, string>(Object.entries(seed));
    return {
        keys: async () => Array.from(map.keys()),
        get: async (key: string) => map.get(key),
        store: async (key: string, value: string) => {
            map.set(key, value);
        },
        delete: async (key: string) => {
            map.delete(key);
        },
        onDidChange: (() => ({
            dispose: () => undefined,
        })) as unknown as vscode.SecretStorage["onDidChange"],
    };
}

describe("handleSecretRequest: allowlist rejection", () => {
    it("rejects an unlisted key without touching SecretStorage", async () => {
        const secrets = makeSecretStorage();
        const request: E2eSecretRequest = {
            nonce: "n1",
            store: "secret",
            operation: "seed",
            key: "intelligit.notAllowlisted",
            value: "glpat-should-not-be-stored",
        };
        const response = await handleSecretRequest(secrets, SALT, request);
        expect(response).toEqual({
            nonce: "n1",
            ok: false,
            error: expect.stringContaining("not allowlisted"),
        });
        await expect(secrets.get("intelligit.notAllowlisted")).resolves.toBeUndefined();
    });
});

describe("handleSecretRequest: snapshot never carries the raw value", () => {
    it("returns presence=false with no digest when nothing is stored", async () => {
        const secrets = makeSecretStorage();
        const response = await handleSecretRequest(secrets, SALT, {
            nonce: "n1",
            store: "secret",
            operation: "snapshot",
            key: ALLOWED_KEY,
        });
        expect(response).toEqual({
            nonce: "n1",
            ok: true,
            result: { kind: "secretPresence", present: false },
        });
    });

    it("returns presence=true and a matching digest, with the raw value absent from the whole payload", async () => {
        const rawValue = "glpat-SUPER-SECRET-TOKEN-VALUE";
        const secrets = makeSecretStorage({ [ALLOWED_KEY]: rawValue });

        const response = await handleSecretRequest(secrets, SALT, {
            nonce: "n1",
            store: "secret",
            operation: "snapshot",
            key: ALLOWED_KEY,
        });

        expect(response.ok).toBe(true);
        if (response.ok && response.result?.kind === "secretPresence") {
            expect(response.result.present).toBe(true);
            expect(response.result.digest).toBe(digestSecret(rawValue, SALT));
        } else {
            throw new Error("expected a secretPresence result");
        }

        // The mandatory assertion: serialize the entire response and confirm the raw value,
        // and every non-trivial substring of it, is nowhere in it.
        const serialized = JSON.stringify(response);
        expect(serialized).not.toContain(rawValue);
        expect(serialized).not.toContain("SUPER-SECRET");
    });
});

describe("handleSecretRequest: seed -> snapshot -> reset -> snapshot", () => {
    it("round-trips through the real SecretStorage", async () => {
        const secrets = makeSecretStorage();
        const rawValue = "glpat-round-trip-token";

        const seedResponse = await handleSecretRequest(secrets, SALT, {
            nonce: "n1",
            store: "secret",
            operation: "seed",
            key: ALLOWED_KEY,
            value: rawValue,
        });
        expect(seedResponse).toEqual({ nonce: "n1", ok: true });
        await expect(secrets.get(ALLOWED_KEY)).resolves.toBe(rawValue);

        const snapshotAfterSeed = await handleSecretRequest(secrets, SALT, {
            nonce: "n2",
            store: "secret",
            operation: "snapshot",
            key: ALLOWED_KEY,
        });
        expect(snapshotAfterSeed).toMatchObject({ result: { present: true } });

        const resetResponse = await handleSecretRequest(secrets, SALT, {
            nonce: "n3",
            store: "secret",
            operation: "reset",
            key: ALLOWED_KEY,
        });
        expect(resetResponse).toEqual({ nonce: "n3", ok: true });

        const snapshotAfterReset = await handleSecretRequest(secrets, SALT, {
            nonce: "n4",
            store: "secret",
            operation: "snapshot",
            key: ALLOWED_KEY,
        });
        expect(snapshotAfterReset).toEqual({
            nonce: "n4",
            ok: true,
            result: { kind: "secretPresence", present: false },
        });
    });

    it("surfaces a store failure as an error response rather than throwing", async () => {
        const secrets = makeSecretStorage();
        secrets.store = async () => {
            throw new Error("keychain unavailable");
        };

        const response = await handleSecretRequest(secrets, SALT, {
            nonce: "n1",
            store: "secret",
            operation: "seed",
            key: ALLOWED_KEY,
            value: "glpat-x",
        });
        expect(response).toEqual({ nonce: "n1", ok: false, error: "keychain unavailable" });
    });
});
