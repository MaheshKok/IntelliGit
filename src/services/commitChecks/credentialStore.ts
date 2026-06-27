// Token store for non-GitHub commit-check providers, backed by VS Code SecretStorage.
// Tokens are namespaced per host so a credential stored for one host is never returned
// for another. GitHub uses VS Code's built-in authentication and does not use this store.
// The token value is only passed to SecretStorage; it is never logged or placed in errors.

import type * as vscode from "vscode";

/** Prefix for every secret key this store owns; the host is appended verbatim. */
const KEY_PREFIX = "intelligit.commitChecks.token:";

/**
 * Stores and retrieves commit-check access tokens keyed by host.
 *
 * The store is a thin, stateless wrapper over a `vscode.SecretStorage` instance,
 * so multiple instances backed by the same storage observe the same secrets.
 * Tokens are never logged and never embedded in messages; only the host is used
 * to derive the secret key.
 */
export class CredentialStore {
    private readonly secrets: vscode.SecretStorage;

    /**
     * Creates a credential store backed by the given secret storage.
     *
     * @param secrets - The VS Code secret storage, typically `context.secrets`.
     */
    constructor(secrets: vscode.SecretStorage) {
        this.secrets = secrets;
    }

    /**
     * Reads the stored token for a host.
     *
     * @param host - The provider host, for example `gitlab.com`.
     * @returns The token, or `undefined` when no token is stored for the host.
     */
    async get(host: string): Promise<string | undefined> {
        return this.secrets.get(keyFor(host));
    }

    /**
     * Stores the token for a host, replacing any token previously stored for it.
     *
     * @param host - The provider host the token authenticates against.
     * @param token - The access token to store.
     */
    async set(host: string, token: string): Promise<void> {
        await this.secrets.store(keyFor(host), token);
    }

    /**
     * Removes any stored token for a host.
     *
     * @param host - The provider host whose token should be deleted.
     */
    async delete(host: string): Promise<void> {
        await this.secrets.delete(keyFor(host));
    }
}

/**
 * Builds the namespaced secret key for a host.
 *
 * @param host - The provider host. It is trimmed and lowercased so the key is stable
 *   across casing and whitespace differences: a token stored as `"GitLab.Com "` is
 *   found by `get("gitlab.com")`. DNS hosts are case-insensitive, and providers derive
 *   the host from a remote URL, so normalizing here prevents a silent token miss. A `:`
 *   in the host (for example a port) is safe because the key is only ever constructed,
 *   never parsed back into prefix and host.
 * @returns The fully qualified secret key.
 * @throws TypeError When the host is empty or whitespace-only, since such a host
 *   would silently share one unattributed key across providers.
 */
function keyFor(host: string): string {
    const cleanHost = host.trim().toLowerCase();
    if (cleanHost === "") {
        throw new TypeError("CredentialStore host must be a non-empty string.");
    }
    return `${KEY_PREFIX}${cleanHost}`;
}
