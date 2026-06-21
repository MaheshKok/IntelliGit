import * as https from "https";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { CommitCheckItem, CommitChecksSnapshot, CommitCheckState } from "../types";
import { getErrorMessage } from "../utils/errors";

interface GitHubRepoRef {
    owner: string;
    repo: string;
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

const CICD_CHECK_PATTERN =
    /\b(ci|cd|build|release|deploy|deployment|test|tests|lint|typecheck|coverage|security|secret|secrets|scan|codeql|guard|package|publish|workflow|actions?)\b/i;
const REVIEW_CHECK_PATTERN = /\b(code\s*review|coderabbit|reviewdog|qodo)\b/i;

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

/** Fetches GitHub Checks API runs plus legacy commit statuses for one commit hash. */
export async function getGithubCommitChecks(
    gitOps: GitOps,
    hash: string,
): Promise<CommitChecksSnapshot> {
    const repoRef = await resolveGithubRepo(gitOps);
    if (!repoRef) {
        return unavailableSnapshot(hash, vscode.l10n.t("No GitHub remote found."));
    }

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

    const checkRunsPath = `/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(
        repoRef.repo,
    )}/commits/${encodeURIComponent(hash)}/check-runs?per_page=100`;
    const statusesPath = `/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(
        repoRef.repo,
    )}/commits/${encodeURIComponent(hash)}/statuses?per_page=100`;

    const [checkRunsResult, statusesResult] = await Promise.allSettled([
        githubGetJson(checkRunsPath, session.accessToken),
        githubGetJson(statusesPath, session.accessToken),
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

async function resolveGithubRepo(gitOps: GitOps): Promise<GitHubRepoRef | null> {
    const remotes = await gitOps.getRemotes();
    const orderedRemotes = remotes.includes("origin")
        ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
        : remotes;
    for (const remote of orderedRemotes) {
        const url = await gitOps.getRemoteUrl(remote);
        if (!url) continue;
        const parsed = parseGithubRemoteUrl(url);
        if (parsed) return parsed;
    }
    return null;
}

function cleanRepoRef(owner: string, repo: string): GitHubRepoRef | null {
    const cleanOwner = owner.trim();
    const cleanRepo = repo.trim().replace(/\.git$/i, "");
    if (!cleanOwner || !cleanRepo || cleanRepo.includes("/")) return null;
    return { owner: cleanOwner, repo: cleanRepo };
}

function githubGetJson(path: string, token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            `https://api.github.com${path}`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "User-Agent": "vscode-intelligit",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                res.on("end", () => {
                    req.setTimeout(0);
                    const statusCode = res.statusCode ?? 0;
                    if (statusCode < 200 || statusCode >= 300) {
                        reject(
                            new Error(`GitHub API returned ${statusCode}: ${data.slice(0, 200)}`),
                        );
                        return;
                    }
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch {
                        reject(new Error("Invalid GitHub API response"));
                    }
                });
            },
        );
        req.on("error", reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error("GitHub API request timed out"));
        });
    });
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

function isCiCdCheckItem(item: CommitCheckItem): boolean {
    const text = `${item.name} ${item.description}`;
    return CICD_CHECK_PATTERN.test(text) && !REVIEW_CHECK_PATTERN.test(text);
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

function aggregateState(items: CommitCheckItem[]): CommitCheckState {
    if (items.length === 0) return "none";
    const states = items.map((item) => item.state);
    if (states.some((state) => ["failure", "timed_out", "action_required"].includes(state))) {
        return "failure";
    }
    if (states.includes("pending")) return "pending";
    if (states.every((state) => state === "success")) return "success";
    if (states.every((state) => ["skipped", "neutral", "cancelled"].includes(state))) {
        return "skipped";
    }
    if (states.includes("unknown")) return "unknown";
    return "success";
}

function summaryForState(state: CommitCheckState): string {
    switch (state) {
        case "success":
            return vscode.l10n.t("All checks passed");
        case "failure":
            return vscode.l10n.t("Checks failed");
        case "pending":
            return vscode.l10n.t("Checks pending");
        case "skipped":
            return vscode.l10n.t("Checks skipped");
        case "none":
            return vscode.l10n.t("No checks found");
        case "unavailable":
            return vscode.l10n.t("GitHub checks unavailable");
        default:
            return vscode.l10n.t("Checks completed");
    }
}

function summaryForItems(items: CommitCheckItem[], state: CommitCheckState): string {
    if (state === "success") {
        const skippedItem = items.find(
            (item) =>
                ["skipped", "neutral", "cancelled"].includes(item.state) &&
                item.description &&
                item.description.toLowerCase() !== "completed",
        );
        if (skippedItem?.description) return skippedItem.description;
    }
    return summaryForState(state);
}

function unavailableSnapshot(hash: string, error: string): CommitChecksSnapshot {
    return {
        hash,
        state: "unavailable",
        summary: summaryForState("unavailable"),
        items: [],
        error,
    };
}

function readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function compactText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}
