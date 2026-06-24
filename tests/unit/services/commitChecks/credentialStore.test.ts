// Spec-derived tests for CredentialStore. Behavior is taken from the Phase 1 contract:
// host-keyed get/set/delete over SecretStorage, missing key returns undefined (no throw),
// set replaces rather than appends, hosts are isolated, and a token is never added to a
// propagated error. The underlying SecretStorage is faked with a Map; nothing else is mocked.

import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";

const KEY_PREFIX = "intelligit.commitChecks.token:";

/**
 * Builds a Map-backed SecretStorage double exposing the call spies used in assertions.
 */
function makeSecrets(initial: Record<string, string> = {}): {
    secrets: vscode.SecretStorage;
    map: Map<string, string>;
    store: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
} {
    const map = new Map<string, string>(Object.entries(initial));
    const get = vi.fn(async (key: string) => map.get(key));
    const store = vi.fn(async (key: string, value: string) => {
        map.set(key, value);
    });
    const del = vi.fn(async (key: string) => {
        map.delete(key);
    });
    const secrets = { get, store, delete: del } as unknown as vscode.SecretStorage;
    return { secrets, map, store, get, del };
}

describe("CredentialStore", () => {
    it("stores a token under the host-namespaced key", async () => {
        const { secrets, map, store } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await cred.set("gitlab.com", "glpat-abc");

        expect(store).toHaveBeenCalledWith(`${KEY_PREFIX}gitlab.com`, "glpat-abc");
        expect(map.get(`${KEY_PREFIX}gitlab.com`)).toBe("glpat-abc");
    });

    it("round-trips a stored token through get", async () => {
        const { secrets } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await cred.set("bitbucket.org", "bbtoken");

        expect(await cred.get("bitbucket.org")).toBe("bbtoken");
    });

    it("returns undefined for a host with no stored token", async () => {
        const { secrets } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await expect(cred.get("gitlab.com")).resolves.toBeUndefined();
    });

    it("replaces the token on a second set rather than appending", async () => {
        const { secrets, map } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await cred.set("gitlab.com", "first");
        await cred.set("gitlab.com", "second");

        expect(await cred.get("gitlab.com")).toBe("second");
        // Exactly one key total; the old value is replaced in place, not appended.
        expect(map.size).toBe(1);
        expect(map.get(`${KEY_PREFIX}gitlab.com`)).toBe("second");
    });

    it("isolates tokens per host", async () => {
        const { secrets } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await cred.set("gitlab.com", "gl-token");

        expect(await cred.get("gitlab.com")).toBe("gl-token");
        expect(await cred.get("bitbucket.org")).toBeUndefined();
    });

    it("normalizes surrounding whitespace so set and get agree on the host", async () => {
        const { secrets } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await cred.set("gitlab.com ", "gl-token");

        // Stored with a trailing space, retrieved without one: must still match.
        expect(await cred.get("gitlab.com")).toBe("gl-token");
        await cred.delete(" gitlab.com");
        expect(await cred.get("gitlab.com")).toBeUndefined();
    });

    it("matches hosts case-insensitively so casing differences resolve to one token", async () => {
        const { secrets, map } = makeSecrets();
        const cred = new CredentialStore(secrets);

        // DNS hosts are case-insensitive; a token stored under mixed case must be found by
        // the lowercase host a provider derives from a remote URL, and vice versa.
        await cred.set("GitLab.Com", "gl-token");

        expect(await cred.get("gitlab.com")).toBe("gl-token");
        expect(await cred.get("GITLAB.COM")).toBe("gl-token");
        // A second set under different casing replaces in place rather than adding a key.
        await cred.set("gitlab.com", "gl-token-2");
        expect(map.size).toBe(1);
        expect(await cred.get("GitLab.Com")).toBe("gl-token-2");
    });

    it("does not collide across hosts that share a prefix", async () => {
        const { secrets } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await cred.set("gitlab.com", "cloud");
        await cred.set("gitlab.example.com", "selfhosted");

        expect(await cred.get("gitlab.com")).toBe("cloud");
        expect(await cred.get("gitlab.example.com")).toBe("selfhosted");
    });

    it("removes a stored token on delete", async () => {
        const { secrets, del } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await cred.set("gitlab.com", "gl-token");
        await cred.delete("gitlab.com");

        expect(del).toHaveBeenCalledWith(`${KEY_PREFIX}gitlab.com`);
        expect(await cred.get("gitlab.com")).toBeUndefined();
    });

    it("does not throw when deleting a host that has no token", async () => {
        const { secrets } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await expect(cred.delete("never-stored.com")).resolves.toBeUndefined();
    });

    it("propagates a storage failure without adding the token to the error", async () => {
        // The mock error is generic and does NOT contain the token, so any token in the
        // surfaced error can only come from CredentialStore wrapping it — which it must not.
        const secrets = {
            store: vi.fn(async () => {
                throw new Error("secret storage unavailable");
            }),
            get: vi.fn(),
            delete: vi.fn(),
        } as unknown as vscode.SecretStorage;
        const cred = new CredentialStore(secrets);

        await expect(cred.set("gitlab.com", "glpat-SUPERSECRET")).rejects.toThrow(
            "secret storage unavailable",
        );
        await expect(cred.set("gitlab.com", "glpat-SUPERSECRET")).rejects.not.toThrow(
            /glpat-SUPERSECRET/,
        );
    });

    it("rejects an empty or whitespace-only host before touching storage", async () => {
        const { secrets, store, get, del } = makeSecrets();
        const cred = new CredentialStore(secrets);

        await expect(cred.set("", "token")).rejects.toThrow(TypeError);
        await expect(cred.get("   ")).rejects.toThrow(TypeError);
        await expect(cred.delete("")).rejects.toThrow(TypeError);
        // A rejected host must never reach SecretStorage.
        expect(store).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
    });
});
