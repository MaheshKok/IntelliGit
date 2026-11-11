// GitLab commit-check provider. Parses gitlab.com and self-hosted GitLab remotes,
// authenticates via a stored PRIVATE-TOKEN from CredentialStore, fetches the GitLab
// commit-statuses endpoint for one commit, and normalizes results into the shared
// snapshot shape. The detail reads the commit's pipelines and their jobs. HTTP is
// injected (FetchJson, FetchJsonWithMeta) so state-mapping is unit-testable.

import * as vscode from "vscode";
import type {
    CiCoverage,
    CiFlatCheck,
    CiJob,
    CiRun,
    CiState,
    CommitCheckItem,
    CommitChecksSnapshot,
    CommitCheckState,
    CommitCiDetailData,
} from "../../types";
import { getErrorMessage } from "../../utils/errors";
import {
    HttpError,
    httpGetJsonWithMeta,
    type FetchJson,
    type FetchJsonWithMeta,
    type FetchResponse,
} from "./http";
import {
    aggregateState,
    compactText,
    isCiCdCheckItem,
    readString,
    redactSecret,
    summaryForItems,
    unavailableSnapshot,
} from "./normalize";
import { CI_MAX_PAGES, CI_PAGE_SIZE, isUnderApiPrefix, paginate } from "./paginate";
import { RequestGateCooldownError } from "./requestGate";
import { NO_CI_CAPABILITIES } from "../../shared/ci/capabilities";
import { hasUnfinishedWork } from "../../shared/ci/completion";
import { logicalCheckId } from "../../shared/ci/identity";
import type {
    CiDetailFetch,
    CiFailedScanCursor,
    CiFailedScanPage,
    CommitChecksProvider,
    HostMap,
    ProviderRepoRef,
} from "./types";
import { tokenAccountKey, type CredentialStore } from "./credentialStore";

/** Narrows ProviderRepoRef with the owner path and repo name parsed from the remote URL. */
interface GitLabRepoRef extends ProviderRepoRef {
    readonly owner: string;
    readonly repo: string;
}

/** One entry in the GitLab commit-statuses response array. */
interface GitLabStatus {
    id?: unknown;
    name?: unknown;
    status?: unknown;
    description?: unknown;
    target_url?: unknown;
    allow_failure?: unknown;
}

/** A pipeline as the single-pipeline request returns it; the list omits `user` and `duration`. */
interface GitLabPipeline {
    id?: unknown;
    iid?: unknown;
    name?: unknown;
    status?: unknown;
    source?: unknown;
    ref?: unknown;
    web_url?: unknown;
    user?: { username?: unknown } | null;
    created_at?: unknown;
    started_at?: unknown;
    finished_at?: unknown;
    updated_at?: unknown;
}

/** One entry of a pipeline's job list. */
interface GitLabJob {
    id?: unknown;
    name?: unknown;
    stage?: unknown;
    status?: unknown;
    web_url?: unknown;
    started_at?: unknown;
    finished_at?: unknown;
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
    /** Each flag turns on in the phase that implements it; GitLab's API has no steps. */
    readonly capabilities = Object.freeze({
        ...NO_CI_CAPABILITIES,
        runs: true,
        jobs: true,
        runHeader: true,
    });

    /**
     * Creates a GitLabProvider.
     *
     * @param fetchJson - The HTTP boundary; pass `httpGetJson` in production.
     * @param store - The credential store used to retrieve PRIVATE-TOKENs.
     * @param ciCdPattern - Optional include pattern from `commitChecks.ciCdFilter`; when
     *   omitted the built-in `CICD_CHECK_PATTERN` is used. The review-bot exclusion always
     *   applies regardless of this override.
     * @param fetchWithMeta - The HTTP boundary for the `x-next-page`-paged detail lists.
     * @param cooldownEnd - The request gate's cooldown end for a URL's bucket (0 when not
     *   cooling down); tells a rate-limited scan page from a failed one.
     */
    constructor(
        private readonly fetchJson: FetchJson,
        private readonly store: CredentialStore,
        private readonly ciCdPattern?: RegExp,
        private readonly fetchWithMeta: FetchJsonWithMeta = httpGetJsonWithMeta,
        private readonly cooldownEnd: (url: string) => number = () => 0,
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

    /** Returns a stable repository cache key for a parsed GitLab remote. */
    keyFor(ref: ProviderRepoRef): string {
        const { host, owner, repo } = ref as GitLabRepoRef;
        return `gitlab:${host.toLowerCase()}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
    }

    /** Fingerprint of the token stored for the host; never the token. */
    accountKey(ref: ProviderRepoRef): Promise<string> {
        return tokenAccountKey(() => this.store.get(ref.host));
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
        const gitLabRef = ref as GitLabRepoRef;
        const token = await this.readToken(gitLabRef.host, hash);
        if (typeof token !== "string") return token;

        const url = `${projectApiUrl(gitLabRef)}/repository/commits/${encodeURIComponent(hash)}/statuses?per_page=100`;

        let raw: unknown;
        try {
            raw = await this.fetchJson(url, { "PRIVATE-TOKEN": token });
        } catch (err) {
            return failedSnapshot(hash, gitLabRef.host, err, token);
        }

        if (!Array.isArray(raw)) {
            return noneSnapshot(hash);
        }

        // Commit status payloads are small network responses; keep transform readable.
        // react-doctor-disable-next-line react-doctor/js-combine-iterations
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

    /**
     * Fetches the commit's pipelines, each one's header and jobs, and the commit statuses that
     * are not jobs. Any page failure yields an `unavailable` detail; never throws.
     */
    async getDetail(ref: ProviderRepoRef, hash: string): Promise<CiDetailFetch> {
        const gitLabRef = ref as GitLabRepoRef;
        const token = await this.readToken(gitLabRef.host, hash);
        if (typeof token !== "string") return flatDetail(token);
        try {
            return await this.readDetail(gitLabRef, hash, token);
        } catch (err) {
            return flatDetail(failedSnapshot(hash, gitLabRef.host, err, token));
        }
    }

    private async readDetail(
        ref: GitLabRepoRef,
        hash: string,
        token: string,
    ): Promise<CiDetailFetch> {
        const fetch = (url: string) => this.fetchWithMeta(url, { "PRIVATE-TOKEN": token });
        const pages = <T>(firstUrl: string, itemsOf: (body: unknown) => T[]) => {
            let current = firstUrl;
            return paginate(
                (url) => {
                    current = url;
                    return fetch(url);
                },
                firstUrl,
                (response) => nextPageUrl(response, current),
                itemsOf,
                CI_MAX_PAGES,
                (url) => this.allowNext(ref, url),
            );
        };
        const base = projectApiUrl(ref);
        const pipelines = await pages(
            `${base}/pipelines?sha=${encodeURIComponent(hash)}&per_page=${CI_PAGE_SIZE}`,
            readArray<GitLabPipeline>,
        );
        const runs: CiRun[] = [];
        const scanCursors: CiFailedScanCursor[] = [];
        for (const listed of pipelines.items) {
            const runId = readId(listed.id);
            if (runId === undefined) continue;
            // Serial, so one commit's many pipelines never take every gate slot at once.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const pipeline = ((await fetch(`${base}/pipelines/${runId}`)).body ??
                {}) as GitLabPipeline;
            const runName = readString(pipeline.name);
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const jobsPage = await pages(
                `${base}/pipelines/${runId}/jobs?per_page=${CI_PAGE_SIZE}`,
                readArray<GitLabJob>,
            );
            const jobs = inStageOrder(jobsPage.items).map((job) => toJob(job, runName));
            const run = toRun(pipeline, runId, runName, jobs, jobsPage.coverage);
            runs.push(run);
            if (run.state === "failure" && jobsPage.next) {
                // The failed-only collection is read from its first page; jobs already shown
                // are skipped by id.
                const runVersion = optionalString(pipeline.updated_at);
                scanCursors.push({
                    runId,
                    ...(runVersion && { runVersion }),
                    runName,
                    url: `${base}/pipelines/${runId}/jobs?scope[]=failed&per_page=${CI_PAGE_SIZE}`,
                    listed: jobs.map((job) => job.id),
                });
            }
        }
        const statuses = await pages(
            `${base}/repository/commits/${encodeURIComponent(hash)}/statuses?per_page=${CI_PAGE_SIZE}`,
            readArray<GitLabStatus>,
        );
        // GitLab lists every job as a commit status under the job's own id.
        const jobIds = new Set(runs.flatMap((run) => run.jobs.map((job) => job.id)));
        const otherChecks = statuses.items
            .filter((status) => !jobIds.has(readId(status.id) ?? ""))
            .map((status) => ({ ...toStatusItem(status), id: readId(status.id) }))
            .filter((item) => isCiCdCheckItem(item, this.ciCdPattern));
        return {
            ...detailOf(hash, runs, pipelines.coverage, otherChecks, statuses.coverage),
            ...(scanCursors.length > 0 && { scanCursors }),
        };
    }

    /**
     * Reads one page of a failed pipeline's failed jobs and keeps those not already shown.
     * A request-gate cooldown is reported as `pausedUntil`, never as a failure; never throws.
     */
    async continueFailedScan(
        ref: ProviderRepoRef,
        cursor: CiFailedScanCursor,
    ): Promise<CiFailedScanPage> {
        const gitLabRef = ref as GitLabRepoRef;
        const refused = vscode.l10n.t("The provider's next-page link was refused.");
        if (!this.allowNext(ref, cursor.url)) return { error: refused };
        const token = await this.readToken(gitLabRef.host, "");
        if (typeof token !== "string") return { error: token.error ?? "" };
        const fetch = (url: string) => this.fetchWithMeta(url, { "PRIVATE-TOKEN": token });
        // The budget is the failed-job count first read; a later page's count never replaces it.
        let jobsTotal = cursor.jobsTotal;
        const kept = () => (jobsTotal === undefined ? {} : { next: { ...cursor, jobsTotal } });
        try {
            const changed = {
                runChanged: true,
                error: vscode.l10n.t("Remote data changed. Reload and try again."),
            } as const;
            // A retried pipeline leaves the failed state and its new jobs replace the old ones; a
            // retry that already failed again shows only as a rewritten `updated_at`.
            const runChanged = async () => {
                const response = await fetch(
                    `${projectApiUrl(gitLabRef)}/pipelines/${encodeURIComponent(cursor.runId)}`,
                );
                const current = response.body as GitLabPipeline | null;
                return (
                    readString(current?.status) !== "failed" ||
                    (cursor.runVersion !== undefined &&
                        optionalString(current?.updated_at) !== cursor.runVersion)
                );
            };
            if (await runChanged()) return changed;
            const response = await fetch(cursor.url);
            // `null` remembers a missing first count, so a later page's count never fills it in.
            if (jobsTotal === undefined) jobsTotal = totalHeader(response) ?? null;
            if (await runChanged()) return changed;
            const jobs = readArray<GitLabJob>(response.body);
            const listed = new Set(cursor.listed);
            const failed = jobs
                .filter((job) => readString(job.status) === "failed")
                .map((job) => toJob(job, cursor.runName))
                .filter((job) => !listed.has(job.id));
            const next = nextPageUrl(response, cursor.url);
            if (next === undefined) return { failed };
            const jobsRead = (cursor.jobsRead ?? 0) + jobs.length;
            // Page numbers only rise, so a next page cannot loop back; a count reached or an
            // empty page that links onward makes no progress. GitLab leaves out x-total on very
            // large collections, and then the scan follows the next pages unbudgeted.
            if (
                !this.allowNext(ref, next) ||
                jobs.length === 0 ||
                (jobsTotal !== null && jobsRead >= jobsTotal)
            ) {
                return { failed, error: refused, ...kept() };
            }
            return { failed, next: { ...cursor, url: next, jobsRead, jobsTotal } };
        } catch (err) {
            if (err instanceof RequestGateCooldownError) {
                return { pausedUntil: err.until, ...kept() };
            }
            // A 429 puts the gate into cooldown. A GitLab 403 is an auth or availability
            // refusal, never a quota, so it stops the scan.
            if (err instanceof HttpError && err.statusCode === 429) {
                const until = this.cooldownEnd(cursor.url);
                if (until > 0) return { pausedUntil: until, ...kept() };
            }
            const failed = failedSnapshot("", gitLabRef.host, err, token);
            return { error: failed.error ?? "", ...kept() };
        }
    }

    /**
     * Continuation guard (K33): a next link must stay on `https://<host>` under this project's
     * API path, `/api/v4/projects/<owner%2Frepo>/`.
     */
    allowNext(ref: ProviderRepoRef, url: string): boolean {
        const { host, owner, repo } = ref as GitLabRepoRef;
        return isUnderApiPrefix(url, `https://${host}`, [
            `/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}/`,
        ]);
    }

    /** The stored token, or the snapshot to show when there is none or the store failed. */
    private async readToken(host: string, hash: string): Promise<string | CommitChecksSnapshot> {
        try {
            const token = await this.store.get(host);
            // No token: surface an actionable "unavailable" rather than hiding the badge
            // as "none". The coordinator caches this terminal state, so a successful
            // sign-in must clear the cache (see intelligit.commitChecks.signIn) for the
            // badge to recover without a window reload.
            return token || signInSnapshot(hash, host);
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** REST API v4 base of the remote's project, addressed by its URL-encoded path. */
function projectApiUrl(ref: GitLabRepoRef): string {
    return `https://${ref.host}/api/v4/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}`;
}

function signInSnapshot(hash: string, host: string): CommitChecksSnapshot {
    return unavailableSnapshot(
        hash,
        vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
        host,
    );
}

/**
 * The unavailable snapshot for a failed request: a sign-in prompt when the token was refused,
 * else the error text with the token redacted.
 */
function failedSnapshot(
    hash: string,
    host: string,
    reason: unknown,
    token: string,
): CommitChecksSnapshot {
    const message = getErrorMessage(reason);
    if (/\bHTTP (401|403)\b/i.test(message)) return signInSnapshot(hash, host);
    // getErrorMessage redacts URL-embedded credentials; redactSecret strips the
    // stored token in case a transport error echoed the PRIVATE-TOKEN header.
    return unavailableSnapshot(hash, redactSecret(message, token));
}

/** The run-less detail for a snapshot that is unavailable; never complete. */
function flatDetail(snapshot: CommitChecksSnapshot): CommitCiDetailData {
    return {
        hash: snapshot.hash,
        provider: "gitlab",
        complete: false,
        outcome: snapshot.state,
        runs: [],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        error: snapshot.error,
        signInHost: snapshot.signInHost,
    };
}

function detailOf(
    hash: string,
    runs: CiRun[],
    runsCoverage: CiCoverage,
    otherChecks: CiFlatCheck[],
    otherChecksCoverage: CiCoverage,
): CommitCiDetailData {
    const states = [
        ...runs.flatMap((run) => [run.state, ...run.jobs.map((job) => job.state)]),
        ...otherChecks.map((check) => check.state),
    ];
    const outcome = aggregateState(
        states.map((state) => ({
            state: state === "queued" || state === "running" ? "pending" : state,
        })),
    );
    return {
        hash,
        provider: "gitlab",
        complete: outcome !== "none" && !hasUnfinishedWork(runs, otherChecks),
        outcome,
        runs,
        runsCoverage,
        otherChecks,
        otherChecksCoverage,
    };
}

function toRun(
    pipeline: GitLabPipeline,
    id: string,
    name: string,
    jobs: CiJob[],
    jobsCoverage: CiCoverage,
): CiRun {
    return {
        id,
        name: name || id,
        url: optionalString(pipeline.web_url),
        state: mapGitLabCiState(readString(pipeline.status)),
        event: optionalString(pipeline.source),
        actor: optionalString(pipeline.user?.username),
        ref: optionalString(pipeline.ref),
        runNumber: optionalNumber(pipeline.iid),
        createdAt: optionalString(pipeline.created_at),
        startedAt: optionalString(pipeline.started_at),
        completedAt: optionalString(pipeline.finished_at),
        jobs,
        jobsCoverage,
    };
}

/** Maps one job; `scope` is the pipeline name (empty when the pipeline has none). */
function toJob(job: GitLabJob, scope: string): CiJob {
    const id = readId(job.id) ?? "";
    const name = readString(job.name) || id;
    return {
        id,
        logicalId: logicalCheckId({ kind: "job", scope, name }),
        name,
        checkName: name,
        state: mapGitLabCiState(readString(job.status)),
        url: optionalString(job.web_url),
        startedAt: optionalString(job.started_at),
        completedAt: optionalString(job.finished_at),
        steps: [],
        ...(job.allow_failure === true && { optional: true }),
    };
}

/**
 * Jobs grouped by stage, stages in the order GitLab created them, as its pipeline view shows.
 * A pipeline creates its jobs stage by stage, so the lowest job id of a stage dates it; a
 * retried job gets a new, higher id but keeps its stage's place.
 */
function inStageOrder(jobs: GitLabJob[]): GitLabJob[] {
    const byId = [...jobs].sort(
        (a, b) => (optionalNumber(a.id) ?? 0) - (optionalNumber(b.id) ?? 0),
    );
    const stages = new Map<string, GitLabJob[]>();
    for (const job of byId) {
        const stage = readString(job.stage);
        stages.set(stage, [...(stages.get(stage) ?? []), job]);
    }
    return [...stages.values()].flat();
}

/** Maps a GitLab pipeline or job `status` to the shared CI state. */
function mapGitLabCiState(status: string): CiState {
    switch (status) {
        case "created":
        case "waiting_for_resource":
        case "preparing":
        case "pending":
        case "scheduled":
        case "waiting_for_callback":
            return "queued";
        case "running":
        case "canceling":
            return "running";
        case "success":
            return "success";
        case "failed":
            return "failure";
        case "canceled":
            return "cancelled";
        case "skipped":
            return "skipped";
        // A manual job waits for a person, not for CI; the snapshot shows it as settled too.
        case "manual":
            return "neutral";
        default:
            return "unknown";
    }
}

/**
 * The next page's URL from GitLab's `x-next-page` header: empty or absent on the last page.
 * A value that is not a later page number throws, so a page whose next page cannot be read
 * never counts as the last.
 */
function nextPageUrl(response: FetchResponse, url: string): string | undefined {
    const next = String(response.headers["x-next-page"] ?? "").trim();
    if (!next) return undefined;
    const target = new URL(url);
    const page = Number(target.searchParams.get("page") ?? "1");
    if (!/^\d+$/.test(next) || Number(next) <= page) {
        throw new Error(vscode.l10n.t("Malformed x-next-page header."));
    }
    target.searchParams.set("page", next);
    return target.href;
}

/** GitLab's `x-total` item count; absent for very large collections. */
function totalHeader(response: FetchResponse): number | undefined {
    const total = String(response.headers["x-total"] ?? "").trim();
    return /^\d+$/.test(total) ? Number(total) : undefined;
}

function readArray<T>(body: unknown): T[] {
    return Array.isArray(body) ? (body as T[]) : [];
}

function readId(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return typeof value === "string" && value ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
    return readString(value) || undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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
