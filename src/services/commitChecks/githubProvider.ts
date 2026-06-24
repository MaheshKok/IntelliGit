// GitHub commit-check provider. Parses github.com remotes, authenticates with the
// built-in VS Code GitHub session, fetches Checks API runs plus legacy commit
// statuses for one commit, and normalizes them into the shared snapshot shape.
// HTTP is injected (`FetchJson`) so mapping is unit-testable without the network.

import * as vscode from "vscode";
import type { CommitCheckItem, CommitChecksSnapshot, CommitCheckState } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { httpGetJson, type FetchJson } from "./http";
import {
    aggregateState,
    compactText,
    isCiCdCheckItem,
    readString,
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
): CommitChecksSnapshot {
    const items = [
        ...readCheckRuns(checkRunsResponse).map(toCheckRunItem),
        ...readStatuses(statusesResponse).map(toStatusItem),
    ].filter(isCiCdCheckItem);
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

    /** Accepts an injected HTTP boundary; defaults to the real HTTPS helper in production. */
    constructor(private readonly fetchJson: FetchJson = httpGetJson) {}

    /** Matches any github.com remote; the host map is not consulted for GitHub. */
    match(remoteUrl: string, _hostMap: HostMap): ProviderRepoRef | null {
        return parseGithubRemoteUrl(remoteUrl);
    }

    /** Authenticates, fetches check-runs + statuses in parallel, and normalizes them. */
    async getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot> {
        const { owner, repo } = ref as GitHubRepoRef;

        let session: vscode.AuthenticationSession;
        try {
            session = await vscode.authentication.getSession("github", ["repo"], {
                createIfNone: true,
            });
        } catch (err) {
            return unavailableSnapshot(
                hash,
                vscode.l10n.t("GitHub authentication failed: {message}", {
                    message: getErrorMessage(err),
                }),
            );
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
            this.fetchJson(`${base}/check-runs?per_page=100`, headers),
            this.fetchJson(`${base}/statuses?per_page=100`, headers),
        ]);

        if (checkRunsResult.status === "rejected" && statusesResult.status === "rejected") {
            return unavailableSnapshot(hash, getErrorMessage(checkRunsResult.reason));
        }

        return normalizeGithubChecks(
            hash,
            checkRunsResult.status === "fulfilled" ? checkRunsResult.value : undefined,
            statusesResult.status === "fulfilled" ? statusesResult.value : undefined,
        );
    }
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
