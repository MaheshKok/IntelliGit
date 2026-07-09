// Bitbucket Cloud commit-check provider. Parses bitbucket.org remotes, authenticates
// with a Bearer access token from CredentialStore, follows the paginated commit
// build-statuses endpoint up to a bounded page cap, and normalizes results into the
// shared snapshot shape. HTTP is injected (FetchJson) so state-mapping stays
// unit-testable with no network access.

import * as vscode from "vscode";
import type { CommitChecksSnapshot } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import type { FetchJson } from "./http";
import { aggregateState, redactSecret, summaryForItems, unavailableSnapshot } from "./normalize";
import { isStatusPage, toStatusItem, type BitbucketStatus } from "./bitbucketShared";
import type { CommitChecksProvider, HostMap, ProviderRepoRef } from "./types";
import type { CredentialStore } from "./credentialStore";

/** Built-in Bitbucket Cloud git host (the only host this provider serves). */
const CLOUD_HOST = "bitbucket.org";
/** API base for Bitbucket Cloud v2. The git host (bitbucket.org) differs from the API host. */
const API_BASE = "https://api.bitbucket.org/2.0";
// ponytail: a single commit's statuses fit in one page (pagelen=100); the cap only
// guards against a pathological `next` chain. Raise it if real repos ever exceed it.
const MAX_PAGES = 5;

/** Narrows ProviderRepoRef with the workspace and repo parsed from a bitbucket.org remote. */
interface BitbucketCloudRepoRef extends ProviderRepoRef {
    readonly workspace: string;
    readonly repo: string;
}

// URL parser (exported for unit testing)

/**
 * Parses a Bitbucket Cloud remote URL in HTTPS or SCP-like SSH form.
 *
 * Supports:
 * - HTTPS:    `https://bitbucket.org/workspace/repo[.git]`
 * - SCP/SSH:  `git@bitbucket.org:workspace/repo[.git]`
 *
 * Only `https` is accepted for the URL form so a plaintext remote can never be
 * turned into an API request (SSRF guard). Bitbucket Cloud has no nested
 * workspaces, so exactly the first two path segments are used (workspace/repo);
 * a single segment yields null.
 *
 * @param remoteUrl - The raw remote URL string from Git configuration.
 * @returns A parsed repo reference, or null when the URL is not a Bitbucket
 *   Cloud URL or lacks a workspace/repo pair.
 */
export function parseBitbucketCloudUrl(remoteUrl: string): BitbucketCloudRepoRef | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return null;

    // SCP-like:  git@bitbucket.org:<path>
    const scpMatch = /^git@bitbucket\.org:(.+)$/i.exec(trimmed);
    if (scpMatch) {
        return buildRef(scpMatch[1]);
    }

    // HTTPS: https://bitbucket.org/<path>. Reject http and any other scheme.
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "https:") return null;
        if (url.hostname.toLowerCase() !== CLOUD_HOST) return null;
        return buildRef(url.pathname);
    } catch {
        return null;
    }
}

/**
 * Builds a BitbucketCloudRepoRef from a slash-delimited path string.
 *
 * The first segment is the workspace, the second is the repo; any deeper
 * segments are ignored. Returns null when fewer than two segments are present.
 *
 * @param rawPath - The path portion of the remote URL, may include `.git`.
 * @returns A BitbucketCloudRepoRef or null.
 */
function buildRef(rawPath: string): BitbucketCloudRepoRef | null {
    const parts = rawPath
        .replace(/\.git$/i, "")
        .split("/")
        .filter(Boolean);

    if (parts.length < 2) return null;

    const [workspace, repo] = parts;
    if (!workspace || !repo) return null;

    return { host: CLOUD_HOST, workspace, repo };
}

// Provider

/**
 * Commit-check provider for Bitbucket Cloud (bitbucket.org).
 *
 * Matches only bitbucket.org remotes; self-hosted Bitbucket Data Center is a
 * separate provider. Authentication uses a token from the CredentialStore; when
 * no token is stored the provider returns an "unavailable" snapshot (with a
 * sign-in hint) without fetching. HTTP errors also produce an "unavailable"
 * snapshot whose error message never contains the access token.
 */
export class BitbucketCloudProvider implements CommitChecksProvider {
    readonly id = "bitbucket-cloud" as const;

    /**
     * Creates a BitbucketCloudProvider.
     *
     * @param fetchJson - The HTTP boundary; pass `httpGetJson` in production.
     * @param store - The credential store used to retrieve access tokens.
     */
    constructor(
        private readonly fetchJson: FetchJson,
        private readonly store: CredentialStore,
    ) {}

    /**
     * Returns a repo reference when the remote URL is a bitbucket.org remote.
     *
     * Bitbucket Cloud is SaaS-only, so the HostMap is ignored; self-hosted
     * Bitbucket is served by the Bitbucket Data Center provider instead.
     *
     * @param remoteUrl - The raw remote URL.
     * @param _hostMap - Unused; Bitbucket Cloud has a single fixed host.
     * @returns A BitbucketCloudRepoRef or null.
     */
    match(remoteUrl: string, _hostMap: HostMap): ProviderRepoRef | null {
        return parseBitbucketCloudUrl(remoteUrl);
    }

    /** Returns a stable repository cache key for a parsed Bitbucket Cloud remote. */
    keyFor(ref: ProviderRepoRef): string {
        const { host, workspace, repo } = ref as BitbucketCloudRepoRef;
        return `bitbucket-cloud:${host.toLowerCase()}:${workspace.toLowerCase()}/${repo.toLowerCase()}`;
    }

    /**
     * Fetches commit build statuses from the Bitbucket Cloud API and returns a snapshot.
     *
     * Returns state "unavailable" (without fetching) when no token is stored for the
     * host; the error message invites the user to sign in. Returns state "unavailable"
     * on HTTP or network errors; the error message will not contain the access token.
     * Returns state "none" for empty or malformed responses. Follows pagination up to
     * MAX_PAGES. Must not throw.
     *
     * @param ref - The repository reference produced by `match`.
     * @param hash - The full commit SHA to fetch statuses for.
     * @returns A CommitChecksSnapshot.
     */
    async getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot> {
        const { host, workspace, repo } = ref as BitbucketCloudRepoRef;

        let token: string | undefined;
        try {
            token = await this.store.get(host);
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
        if (!token) {
            return unavailableSnapshot(
                hash,
                vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
                host,
            );
        }

        // Bitbucket Cloud uses Bearer tokens (repository/project/workspace access tokens
        // or OAuth). App passwords are not supported: the store holds one value per host
        // with no username slot, and Atlassian is sunsetting them.
        const headers = { Authorization: `Bearer ${token}` };
        const first = `${API_BASE}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/commit/${encodeURIComponent(hash)}/statuses?pagelen=100`;

        let rows: BitbucketStatus[];
        try {
            rows = await this.fetchAllPages(first, headers);
        } catch (err) {
            const message = getErrorMessage(err);
            if (/\bHTTP (401|403)\b/i.test(message)) {
                return unavailableSnapshot(
                    hash,
                    vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
                    host,
                );
            }
            // getErrorMessage redacts URL-embedded credentials; redactSecret strips the
            // stored token in case a transport error echoed the Authorization header.
            return unavailableSnapshot(hash, redactSecret(message, token));
        }

        // No CI/CD name filter here: the Bitbucket build-statuses endpoint returns only
        // build statuses (not review bots), so an allowlist would silently hide real
        // failures from tools like Jenkins or SonarCloud whose names omit CI/CD keywords.
        const items = rows.map(toStatusItem);
        const state = aggregateState(items);
        return {
            hash,
            state,
            summary: summaryForItems(items, state),
            items,
        };
    }

    /**
     * Follows the `next` pagination links from a starting URL, accumulating statuses.
     *
     * Stops at the first non-page response, when no `next` link remains, or when
     * MAX_PAGES is reached (a runaway-chain guard). Headers are reused for each page.
     *
     * @param firstUrl - The first page URL.
     * @param headers - The auth headers to send on every page request.
     * @returns All status rows gathered across the fetched pages.
     */
    private async fetchAllPages(
        firstUrl: string,
        headers: Record<string, string>,
    ): Promise<BitbucketStatus[]> {
        const rows: BitbucketStatus[] = [];
        let url: string | undefined = firstUrl;
        for (let page = 0; url && page < MAX_PAGES; page++) {
            const raw = await this.fetchJson(url, headers);
            if (!isStatusPage(raw)) break;
            rows.push(...raw.values);
            url = normalizeBitbucketCloudNextUrl(raw.next);
        }
        return rows;
    }
}

function normalizeBitbucketCloudNextUrl(next: unknown): string | undefined {
    if (typeof next !== "string") return undefined;
    try {
        const url = new URL(next);
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.bitbucket.org") {
            return undefined;
        }
        if (!url.pathname.startsWith("/2.0/")) return undefined;
        return url.toString();
    } catch {
        return undefined;
    }
}
