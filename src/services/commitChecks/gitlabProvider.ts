// GitLab commit-check provider. Parses gitlab.com and self-hosted GitLab remotes,
// authenticates via a stored PRIVATE-TOKEN from CredentialStore, fetches the GitLab
// commit-statuses endpoint for one commit, and normalizes results into the shared
// snapshot shape. HTTP is injected (FetchJson) so state-mapping is unit-testable.

import * as vscode from "vscode";
import type { CommitCheckItem, CommitChecksSnapshot, CommitCheckState } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import type { FetchJson } from "./http";
import {
    aggregateState,
    compactText,
    isCiCdCheckItem,
    readString,
    redactSecret,
    summaryForItems,
    unavailableSnapshot,
} from "./normalize";
import type { CommitChecksProvider, HostMap, ProviderRepoRef } from "./types";
import type { CredentialStore } from "./credentialStore";

/** Narrows ProviderRepoRef with the owner path and repo name parsed from the remote URL. */
interface GitLabRepoRef extends ProviderRepoRef {
    readonly owner: string;
    readonly repo: string;
}

/** One entry in the GitLab commit-statuses response array. */
interface GitLabStatus {
    name?: unknown;
    status?: unknown;
    description?: unknown;
    target_url?: unknown;
    allow_failure?: unknown;
}

// ---------------------------------------------------------------------------
// URL parser (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parses a GitLab remote URL in HTTPS or SCP-like SSH form.
 *
 * Recognises only `gitlab.com` as the built-in host. Self-hosted instances
 * must be matched through the HostMap by the provider's `match` method.
 *
 * @param remoteUrl - The raw remote URL string from Git configuration.
 * @returns A parsed repo reference, or null when the URL is not a GitLab URL
 *   or does not contain at least two path segments.
 */
export function parseGitlabRemoteUrl(remoteUrl: string): GitLabRepoRef | null {
    return parseGitlabUrl(remoteUrl, "gitlab.com");
}

/**
 * Parses a GitLab remote URL against a given host (built-in or self-hosted).
 *
 * Supports:
 * - HTTPS:    `https://<host>/[group/...]owner/repo[.git]`
 * - SCP/SSH:  `git@<host>:[group/...]owner/repo[.git]`
 *
 * Returns null for single path segments (no owner/repo distinction), empty
 * input, or URLs whose host does not match.
 *
 * @param remoteUrl - The raw remote URL string.
 * @param host - The hostname to match against (must be lowercase-normalized already).
 * @returns A repo reference or null.
 */
function parseGitlabUrl(remoteUrl: string, host: string): GitLabRepoRef | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return null;

    // SCP-like:  git@<host>:<path>
    const scpMatch = new RegExp(`^git@${escapeRegex(host)}:(.+)$`, "i").exec(trimmed);
    if (scpMatch) {
        return buildRef(host, scpMatch[1]);
    }

    // HTTPS: https://<host>/<path>. Only https is accepted; http and any other
    // scheme are rejected so a plaintext remote can never be queried (SSRF guard).
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "https:") return null;
        if (url.hostname.toLowerCase() !== host.toLowerCase()) return null;
        const path = url.pathname.replace(/^\/+|\/+$/g, "");
        return buildRef(host, path);
    } catch {
        return null;
    }
}

/**
 * Builds a GitLabRepoRef from a host and a slash-delimited path string.
 *
 * The last segment is the repo name; all preceding segments form the owner
 * path. Returns null when there are fewer than two segments (no owner).
 *
 * @param host - The resolved hostname, already lowercase-normalized.
 * @param rawPath - The path portion of the remote URL, may include `.git`.
 * @returns A GitLabRepoRef or null.
 */
function buildRef(host: string, rawPath: string): GitLabRepoRef | null {
    const parts = rawPath
        .replace(/\.git$/i, "")
        .split("/")
        .filter(Boolean);

    if (parts.length < 2) return null;

    const repo = parts[parts.length - 1];
    const owner = parts.slice(0, parts.length - 1).join("/");

    if (!owner || !repo) return null;

    return { host: host.toLowerCase(), owner, repo };
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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Commit-check provider for GitLab.com and self-hosted GitLab instances.
 *
 * Matches remote URLs against the built-in gitlab.com host or hosts registered
 * as "gitlab" in the HostMap. Authentication uses a PRIVATE-TOKEN fetched from
 * the CredentialStore; when no token is stored the provider returns an
 * "unavailable" snapshot (with a sign-in hint) without fetching. HTTP errors
 * also produce an "unavailable" snapshot whose error message never contains the
 * access token.
 */
export class GitLabProvider implements CommitChecksProvider {
    readonly id = "gitlab" as const;

    /**
     * Creates a GitLabProvider.
     *
     * @param fetchJson - The HTTP boundary; pass `httpGetJson` in production.
     * @param store - The credential store used to retrieve PRIVATE-TOKENs.
     * @param ciCdPattern - Optional include pattern from `commitChecks.ciCdFilter`; when
     *   omitted the built-in `CICD_CHECK_PATTERN` is used. The review-bot exclusion always
     *   applies regardless of this override.
     */
    constructor(
        private readonly fetchJson: FetchJson,
        private readonly store: CredentialStore,
        private readonly ciCdPattern?: RegExp,
    ) {}

    /**
     * Returns a repo reference when the remote URL belongs to a GitLab host.
     *
     * The built-in host `gitlab.com` is always recognized. Any other host is
     * accepted only when `hostMap[host] === "gitlab"`.
     *
     * @param remoteUrl - The raw remote URL.
     * @param hostMap - Extension-configured map of hostname → provider id.
     * @returns A GitLabRepoRef or null.
     */
    match(remoteUrl: string, hostMap: HostMap): ProviderRepoRef | null {
        // Try the built-in gitlab.com host first.
        const builtIn = parseGitlabRemoteUrl(remoteUrl);
        if (builtIn) return builtIn;

        // Try each host registered as "gitlab" in the HostMap.
        for (const [host, providerId] of Object.entries(hostMap)) {
            if (providerId !== "gitlab") continue;
            const ref = parseGitlabUrl(remoteUrl, host);
            if (ref) return ref;
        }

        return null;
    }

    /**
     * Fetches commit statuses from the GitLab API and returns a normalized snapshot.
     *
     * Returns state "unavailable" (without fetching) when no token is stored for the
     * host; the error message invites the user to sign in. Returns state "unavailable"
     * on HTTP or network errors; the error message will not contain the access token.
     * Returns state "none" for empty or non-array responses. Must not throw.
     *
     * @param ref - The repository reference produced by `match`.
     * @param hash - The full commit SHA to fetch statuses for.
     * @returns A CommitChecksSnapshot.
     */
    async getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot> {
        const { host, owner, repo } = ref as GitLabRepoRef;

        let token: string | undefined;
        try {
            token = await this.store.get(host);
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
        if (!token) {
            // No token: surface an actionable "unavailable" rather than hiding the badge
            // as "none". The coordinator caches this terminal state, so a successful
            // sign-in must clear the cache (see intelligit.commitChecks.signIn) for the
            // badge to recover without a window reload.
            return unavailableSnapshot(
                hash,
                vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
                host,
            );
        }

        const projectPath = encodeURIComponent(`${owner}/${repo}`);
        const url = `https://${host}/api/v4/projects/${projectPath}/repository/commits/${encodeURIComponent(hash)}/statuses?per_page=100`;
        const headers = { "PRIVATE-TOKEN": token };

        let raw: unknown;
        try {
            raw = await this.fetchJson(url, headers);
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
            // stored token in case a transport error echoed the PRIVATE-TOKEN header.
            return unavailableSnapshot(hash, redactSecret(message, token));
        }

        if (!Array.isArray(raw)) {
            return noneSnapshot(hash);
        }

        const items = (raw as GitLabStatus[])
            .map(toStatusItem)
            .filter((item) => isCiCdCheckItem(item, this.ciCdPattern));
        const state = aggregateState(items);
        return {
            hash,
            state,
            summary: summaryForItems(items, state),
            items,
        };
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Builds a terminal snapshot that reports no checks were found.
 *
 * @param hash - The commit SHA being queried.
 * @returns A CommitChecksSnapshot with state "none" and no items.
 */
function noneSnapshot(hash: string): CommitChecksSnapshot {
    return { hash, state: "none", summary: "", items: [] };
}

/**
 * Converts one GitLab commit-status API entry into a CommitCheckItem.
 *
 * @param status - A raw object from the GitLab statuses array.
 * @returns A normalized CommitCheckItem.
 */
function toStatusItem(status: GitLabStatus): CommitCheckItem {
    return {
        name: readString(status.name) || "GitLab status",
        description: compactText(readString(status.description) || readString(status.status)),
        state: mapGitLabStatus(readString(status.status)),
        source: "status",
        url: readString(status.target_url) || undefined,
    };
}

/**
 * Maps a GitLab pipeline/job status string to the shared CommitCheckState type.
 *
 * GitLab statuses: success, failed, running, pending, created, preparing,
 * waiting_for_resource, scheduled, canceled, skipped, manual.
 * "canceled" (one L in GitLab's API) maps to "cancelled" (two L's in our type).
 *
 * @param status - The raw GitLab status string.
 * @returns The normalized CommitCheckState.
 */
function mapGitLabStatus(status: string): CommitCheckState {
    switch (status) {
        case "success":
            return "success";
        case "failed":
            return "failure";
        case "running":
        case "pending":
        case "created":
        case "preparing":
        case "waiting_for_resource":
        case "scheduled":
            return "pending";
        case "canceled":
            return "cancelled";
        case "skipped":
            return "skipped";
        case "manual":
            return "action_required";
        default:
            return "unknown";
    }
}
