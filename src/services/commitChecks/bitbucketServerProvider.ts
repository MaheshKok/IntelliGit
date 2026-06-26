// Bitbucket Server / Data Center commit-check provider. Self-hosted Bitbucket has no
// fixed host, so this provider only matches remotes whose host is registered as
// "bitbucket-server" in the HostMap. It reads the global build-status REST endpoint
// (keyed by commit SHA alone) with a Bearer HTTP access token and normalizes the
// result into the shared snapshot shape. HTTP is injected (FetchJson) so it stays
// unit-testable with no network access.

import * as vscode from "vscode";
import type { CommitChecksSnapshot } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import type { FetchJson } from "./http";
import { aggregateState, redactSecret, summaryForItems, unavailableSnapshot } from "./normalize";
import { isStatusPage, toStatusItem } from "./bitbucketShared";
import type { CommitChecksProvider, HostMap, ProviderRepoRef } from "./types";
import type { CredentialStore } from "./credentialStore";

// ponytail: a commit's build statuses fit well under one page of 100. The Server API
// paginates with start/limit/isLastPage, but a single fetch with limit=100 covers
// every realistic case. Add isLastPage/nextPageStart looping only if a real repo
// exceeds it.
const PAGE_LIMIT = 100;

// URL parser (exported for unit testing)

/**
 * Parses a self-hosted Bitbucket remote URL against a given host.
 *
 * Self-hosted Bitbucket has no built-in host, so the caller supplies the host
 * (resolved from the HostMap). Supports the HTTPS clone form
 * `https://<host>/scm/<project>/<repo>.git`, the SSH form
 * `ssh://git@<host>[:port]/<project>/<repo>.git`, and the SCP-like form
 * `git@<host>:<project>/<repo>.git`. Only `https`/`ssh` remote schemes are
 * accepted; a plaintext `http://` remote is rejected (SSRF guard) since the API
 * call is always derived as `https://<host>/rest/...`.
 *
 * The build-status REST endpoint is keyed by commit SHA alone, so only the host
 * is needed; the project/repo segments are validated (a bare host is not a repo)
 * but not retained.
 *
 * @param remoteUrl - The raw remote URL string from Git configuration.
 * @param host - The hostname to match against (lowercase-normalized).
 * @returns A repo reference carrying the host, or null when the URL does not
 *   belong to `host` or lacks a project/repo path.
 */
export function parseBitbucketServerUrl(remoteUrl: string, host: string): ProviderRepoRef | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return null;

    // SCP-like:  git@<host>:<path>
    const scpMatch = new RegExp(`^git@${escapeRegex(host)}:(.+)$`, "i").exec(trimmed);
    if (scpMatch) {
        return hasRepoPath(scpMatch[1]) ? { host: host.toLowerCase() } : null;
    }

    // URL form: only https and ssh schemes are accepted. http is rejected so a
    // plaintext remote can never be turned into an API request (SSRF guard).
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "https:" && url.protocol !== "ssh:") return null;
        if (url.hostname.toLowerCase() !== host.toLowerCase()) return null;
        // Strip the Bitbucket Server `/scm` clone prefix before checking for a repo path.
        const path = url.pathname.replace(/^\/scm\//i, "/");
        return hasRepoPath(path) ? { host: host.toLowerCase() } : null;
    } catch {
        return null;
    }
}

/**
 * Reports whether a path string contains at least a project/repo pair.
 *
 * @param rawPath - The path portion of the remote URL, may include `.git`.
 * @returns True when two or more non-empty segments remain after stripping `.git`.
 */
function hasRepoPath(rawPath: string): boolean {
    const parts = rawPath
        .replace(/\.git$/i, "")
        .split("/")
        .filter(Boolean);
    return parts.length >= 2;
}

/**
 * Escapes special regex metacharacters in a literal string.
 *
 * @param str - The string to escape.
 * @returns The escaped string safe for use inside a RegExp constructor.
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Provider

/**
 * Commit-check provider for self-hosted Bitbucket Server / Data Center.
 *
 * Has no built-in host: it only serves remotes whose host is registered as
 * "bitbucket-server" in the HostMap. Authentication uses an HTTP access token
 * from the CredentialStore sent as `Authorization: Bearer`; when no token is
 * stored the provider returns an "unavailable" snapshot (with a sign-in hint)
 * without fetching. HTTP errors also produce an "unavailable" snapshot whose
 * error message never contains the access token.
 */
export class BitbucketServerProvider implements CommitChecksProvider {
    readonly id = "bitbucket-server" as const;

    /**
     * Creates a BitbucketServerProvider.
     *
     * @param fetchJson - The HTTP boundary; pass `httpGetJson` in production.
     * @param store - The credential store used to retrieve access tokens.
     */
    constructor(
        private readonly fetchJson: FetchJson,
        private readonly store: CredentialStore,
    ) {}

    /**
     * Returns a repo reference when a HostMap-registered Server host serves the remote.
     *
     * Self-hosted Bitbucket has no built-in host, so only hosts mapped to
     * "bitbucket-server" in the HostMap are tried.
     *
     * @param remoteUrl - The raw remote URL.
     * @param hostMap - Extension-configured map of hostname → provider id.
     * @returns A repo reference carrying the host, or null.
     */
    match(remoteUrl: string, hostMap: HostMap): ProviderRepoRef | null {
        for (const [host, providerId] of Object.entries(hostMap)) {
            if (providerId !== "bitbucket-server") continue;
            const ref = parseBitbucketServerUrl(remoteUrl, host);
            if (ref) return ref;
        }
        return null;
    }

    /**
     * Fetches commit build statuses from the Bitbucket Server API and returns a snapshot.
     *
     * Returns state "unavailable" (without fetching) when no token is stored for the
     * host; the error message invites the user to sign in. Returns state "unavailable"
     * on HTTP or network errors; the error message will not contain the access token.
     * Returns state "none" for empty or malformed responses. Must not throw.
     *
     * @param ref - The repository reference produced by `match`.
     * @param hash - The full commit SHA to fetch statuses for.
     * @returns A CommitChecksSnapshot.
     */
    async getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot> {
        const { host } = ref;

        const token = await this.store.get(host);
        if (!token) {
            return unavailableSnapshot(
                hash,
                vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
            );
        }

        // Bitbucket Server / Data Center uses HTTP access tokens sent as a Bearer header.
        const headers = { Authorization: `Bearer ${token}` };
        // The build-status endpoint is global (keyed by commit SHA only); no project/repo.
        const url = `https://${host}/rest/build-status/1.0/commits/${encodeURIComponent(hash)}?limit=${PAGE_LIMIT}`;

        let raw: unknown;
        try {
            raw = await this.fetchJson(url, headers);
        } catch (err) {
            const message = getErrorMessage(err);
            if (/\bHTTP (401|403)\b/i.test(message)) {
                return unavailableSnapshot(
                    hash,
                    vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
                );
            }
            // getErrorMessage redacts URL-embedded credentials; redactSecret strips the
            // stored token in case a transport error echoed the Authorization header.
            return unavailableSnapshot(hash, redactSecret(message, token));
        }

        // The Server build-status endpoint returns build statuses only (no review bots),
        // so every value is aggregated; an allowlist would silently hide real failures.
        const rows = isStatusPage(raw) ? raw.values : [];
        const items = rows.map(toStatusItem);
        const state = aggregateState(items);
        return {
            hash,
            state,
            summary: summaryForItems(items, state),
            items,
        };
    }
}
