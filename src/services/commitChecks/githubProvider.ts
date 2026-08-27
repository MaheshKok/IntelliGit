// GitHub commit-check provider. Parses github.com remotes, authenticates with the
// built-in VS Code GitHub session, fetches Checks API runs plus legacy commit
// statuses for one commit, and normalizes them into the shared snapshot shape.
// HTTP is injected (`FetchJson`) so mapping is unit-testable without the network.

import * as vscode from "vscode";
import type { CommitCheckItem, CommitChecksSnapshot, CommitCheckState } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { HttpError, httpGetJson, type FetchJson } from "./http";
import {
    aggregateState,
    compactText,
    isCiCdCheckItem,
    readString,
    redactSecret,
    summaryForState,
    summaryForItems,
    unavailableSnapshot,
} from "./normalize";
import type { CommitChecksProvider, HostMap, ProviderRepoRef } from "./types";

interface GitHubRepoRef extends ProviderRepoRef {
    readonly owner: string;
    readonly repo: string;
}

interface GitHubCheckRun {
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    html_url?: unknown;
    details_url?: unknown;
    output?: unknown;
}

interface GitHubStatus {
    context?: unknown;
    state?: unknown;
    description?: unknown;
    target_url?: unknown;
}

const GITHUB_PAGE_SIZE = 100;

/** Parses GitHub.com remote URLs from HTTPS, SSH, and scp-like Git remotes. */
export function parseGithubRemoteUrl(remoteUrl: string): GitHubRepoRef | null {
    const trimmed = remoteUrl.trim();
    const scpMatch = /^git@github\.com:([^/]+)\/(.+)$/i.exec(trimmed);
    if (scpMatch) return cleanRepoRef(scpMatch[1], scpMatch[2]);

    try {
        const url = new URL(trimmed);
        if (url.hostname.toLowerCase() !== "github.com") return null;
        const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
        if (parts.length !== 2) return null;
        return cleanRepoRef(parts[0], parts[1]);
    } catch {
        return null;
    }
}

/** Normalizes GitHub REST payloads into the compact webview snapshot shape. */
export function normalizeGithubChecks(
    hash: string,
    checkRunsResponse: unknown,
    statusesResponse: unknown,
    ciCdPattern?: RegExp,
): CommitChecksSnapshot {
    const items = [
        ...readCheckRuns(checkRunsResponse).map(toCheckRunItem),
        ...readStatuses(statusesResponse).map(toStatusItem),
    ].filter((item) => isCiCdCheckItem(item, ciCdPattern));
    const state = aggregateState(items);
    return {
        hash,
        state,
        summary: summaryForItems(items, state),
        items,
    };
}

/** GitHub commit-check provider backed by the built-in VS Code GitHub session. */
export class GitHubProvider implements CommitChecksProvider {
    readonly id = "github" as const;

    /**
     * Accepts an injected HTTP boundary and an optional CI/CD include override.
     *
     * @param fetchJson - The HTTP boundary; defaults to the real HTTPS helper in production.
     * @param ciCdPattern - Optional include pattern from `commitChecks.ciCdFilter`; when
     *   omitted the built-in `CICD_CHECK_PATTERN` is used. The review-bot exclusion always
     *   applies regardless of this override.
     */
    constructor(
        private readonly fetchJson: FetchJson = httpGetJson,
        private readonly ciCdPattern?: RegExp,
    ) {}

    /** Matches any github.com remote; the host map is not consulted for GitHub. */
    match(remoteUrl: string, _hostMap: HostMap): ProviderRepoRef | null {
        return parseGithubRemoteUrl(remoteUrl);
    }

    /** Returns a stable repository cache key for a parsed GitHub remote. */
    keyFor(ref: ProviderRepoRef): string {
        const { host, owner, repo } = ref as GitHubRepoRef;
        return `github:${host.toLowerCase()}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
    }

    /** Authenticates, fetches check-runs + statuses in parallel, and normalizes them. */
    async getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot> {
        const { host, owner, repo } = ref as GitHubRepoRef;

        let session: vscode.AuthenticationSession | undefined;
        try {
            session = await vscode.authentication.getSession("github", ["repo"], {
                silent: true,
            });
        } catch (err) {
            return unavailableSnapshot(
                hash,
                vscode.l10n.t("GitHub authentication failed: {message}", {
                    message: getErrorMessage(err),
                }),
            );
        }
        if (!session) {
            return { hash, state: "none", summary: summaryForState("none"), items: [] };
        }

        const headers = {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${session.accessToken}`,
            "User-Agent": "vscode-intelligit",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo,
        )}/commits/${encodeURIComponent(hash)}`;

        const [checkRunsResult, statusesResult] = await Promise.allSettled([
            fetchAllCheckRuns(this.fetchJson, base, headers),
            fetchAllStatuses(this.fetchJson, base, headers),
        ]);

        if (checkRunsResult.status === "rejected" && statusesResult.status === "rejected") {
            if (
                isCredentialRejection(checkRunsResult.reason) ||
                isCredentialRejection(statusesResult.reason)
            ) {
                // Parity with GitLab and both Bitbucket providers: a rejected credential
                // yields a badge carrying signInHost, which is what renders the popover's
                // "Sign in" action. Without it a revoked session is a dead-end error badge
                // whose only recovery is a window reload. The sign-in command routes
                // github.com to VS Code's own session prompt rather than the token store,
                // which this provider never reads.
                return unavailableSnapshot(
                    hash,
                    vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
                    host,
                );
            }
            // getErrorMessage redacts URL-embedded credentials; redactSecret strips the
            // session token in case a transport error echoed the Authorization header.
            const message = getErrorMessage(checkRunsResult.reason);
            return unavailableSnapshot(hash, redactSecret(message, session.accessToken));
        }

        return normalizeGithubChecks(
            hash,
            checkRunsResult.status === "fulfilled" ? checkRunsResult.value : undefined,
            statusesResult.status === "fulfilled" ? statusesResult.value : undefined,
            this.ciCdPattern,
        );
    }
}

/**
 * Fetches every check-run page advertised by GitHub.
 *
 * The promise rejects when any page fails, so callers never normalize a partial check-run
 * collection as a successful endpoint result.
 *
 * @param fetchJson - Authenticated HTTP boundary used for each sequential page request.
 * @param base - Commit API URL without an endpoint suffix.
 * @param headers - Authenticated GitHub request headers.
 * @returns A combined check-run payload suitable for the normalizer.
 */
async function fetchAllCheckRuns(
    fetchJson: FetchJson,
    base: string,
    headers: Record<string, string>,
): Promise<{ check_runs: GitHubCheckRun[] }> {
    const firstPage = await fetchJson(
        `${base}/check-runs?per_page=${GITHUB_PAGE_SIZE}&filter=latest&page=1`,
        headers,
    );
    const checkRuns = readCheckRuns(firstPage);
    for (let page = 2; page <= pageCount(firstPage); page += 1) {
        const response = await fetchJson(
            `${base}/check-runs?per_page=${GITHUB_PAGE_SIZE}&filter=latest&page=${page}`,
            headers,
        );
        checkRuns.push(...readCheckRuns(response));
    }
    return { check_runs: checkRuns };
}

/**
 * Fetches every page from GitHub's combined-status endpoint as one atomic result.
 *
 * The promise rejects when any page fails, discarding earlier pages so endpoint degradation is
 * handled by the provider's independent settled-result logic.
 *
 * @param fetchJson - Authenticated HTTP boundary used for each sequential page request.
 * @param base - Commit API URL without an endpoint suffix.
 * @param headers - Authenticated GitHub request headers.
 * @returns A combined status payload suitable for the normalizer.
 */
async function fetchAllStatuses(
    fetchJson: FetchJson,
    base: string,
    headers: Record<string, string>,
): Promise<{ statuses: GitHubStatus[] }> {
    const firstPage = await fetchJson(
        `${base}/status?per_page=${GITHUB_PAGE_SIZE}&page=1`,
        headers,
    );
    const statuses = readStatuses(firstPage);
    for (let page = 2; page <= pageCount(firstPage); page += 1) {
        const response = await fetchJson(
            `${base}/status?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
            headers,
        );
        statuses.push(...readStatuses(response));
    }
    return { statuses };
}

/**
 * Returns the number of pages advertised by a GitHub paginated response.
 *
 * @param value - First-page payload from a paginated endpoint.
 * @returns At least one page, even when the payload has no usable total count.
 */
function pageCount(value: unknown): number {
    if (!value || typeof value !== "object") return 1;
    const totalCount = (value as { total_count?: unknown }).total_count;
    if (typeof totalCount !== "number" || !Number.isFinite(totalCount)) return 1;
    return Math.max(1, Math.ceil(totalCount / GITHUB_PAGE_SIZE));
}

/**
 * Reports whether a rejected request failed because the session credential was refused.
 *
 * The other three providers pattern-match `HTTP 401|403` on the message text; GitHub's
 * rejections arrive as the typed `HttpError`, so the status is read directly. 403 needs
 * one carve-out the siblings do not: GitHub answers an exhausted primary quota with 403
 * and `x-ratelimit-remaining: 0` -- the same pair `readCooldownUntil` keys its backoff on
 * -- and signing in again does not refill a quota, so offering that action would send the
 * user somewhere that cannot help. Any other 403 (a missing `repo` scope, an org that has
 * not authorized the token for SSO) is fixed by re-authorizing.
 *
 * @param reason - The settled rejection reason from one of the two endpoint requests.
 * @returns True when re-authorizing is the action that would fix the failure.
 */
function isCredentialRejection(reason: unknown): boolean {
    if (!(reason instanceof HttpError)) return false;
    if (reason.statusCode === 401) return true;
    if (reason.statusCode !== 403) return false;
    const remaining = reason.headers["x-ratelimit-remaining"];
    return (Array.isArray(remaining) ? remaining[0] : remaining) !== "0";
}

function cleanRepoRef(owner: string, repo: string): GitHubRepoRef | null {
    const cleanOwner = owner.trim();
    const cleanRepo = repo.trim().replace(/\.git$/i, "");
    if (!cleanOwner || !cleanRepo || cleanRepo.includes("/")) return null;
    return { host: "github.com", owner: cleanOwner, repo: cleanRepo };
}

function readCheckRuns(value: unknown): GitHubCheckRun[] {
    if (!value || typeof value !== "object") return [];
    const runs = (value as { check_runs?: unknown }).check_runs;
    return Array.isArray(runs) ? (runs as GitHubCheckRun[]) : [];
}

function readStatuses(value: unknown): GitHubStatus[] {
    if (Array.isArray(value)) return value as GitHubStatus[];
    if (!value || typeof value !== "object") return [];
    const statuses = (value as { statuses?: unknown }).statuses;
    return Array.isArray(statuses) ? (statuses as GitHubStatus[]) : [];
}

function toCheckRunItem(run: GitHubCheckRun): CommitCheckItem {
    const output = run.output && typeof run.output === "object" ? run.output : {};
    const summary = readString((output as { summary?: unknown }).summary);
    const title = readString((output as { title?: unknown }).title);
    return {
        name: readString(run.name) || vscode.l10n.t("GitHub check"),
        description: compactText(summary || title || readString(run.status)),
        state: mapCheckRunState(readString(run.status), readString(run.conclusion)),
        source: "check-run",
        url: readString(run.html_url) || readString(run.details_url) || undefined,
    };
}

function toStatusItem(status: GitHubStatus): CommitCheckItem {
    return {
        name: readString(status.context) || vscode.l10n.t("Commit status"),
        description: compactText(readString(status.description) || readString(status.state)),
        state: mapStatusState(readString(status.state)),
        source: "status",
        url: readString(status.target_url) || undefined,
    };
}

function mapCheckRunState(status: string, conclusion: string): CommitCheckState {
    if (status === "queued" || status === "in_progress") return "pending";
    switch (conclusion) {
        case "success":
        case "failure":
        case "skipped":
        case "neutral":
        case "cancelled":
        case "timed_out":
        case "action_required":
            return conclusion;
        default:
            return status === "completed" ? "unknown" : "pending";
    }
}

function mapStatusState(state: string): CommitCheckState {
    if (state === "success" || state === "pending") return state;
    if (state === "failure" || state === "error") return "failure";
    return "unknown";
}
