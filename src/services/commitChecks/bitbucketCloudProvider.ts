// Bitbucket Cloud commit-check provider. Parses bitbucket.org remotes, authenticates
// with a Bearer access token from CredentialStore, follows the paginated commit
// build-statuses endpoint up to a bounded page cap, and normalizes results into the
// shared snapshot shape. The detail reads the commit's pipelines and their steps as the
// run and job tree. HTTP is injected (FetchJson, FetchJsonWithMeta) so state-mapping
// stays unit-testable with no network access.

import * as vscode from "vscode";
import type {
    CiCoverage,
    CiFlatCheck,
    CiJob,
    CiRun,
    CiState,
    CommitChecksSnapshot,
    CommitCiDetailData,
} from "../../types";
import { getErrorMessage } from "../../utils/errors";
import {
    hasUnfinishedWork,
    isCompleteDetail,
    isCompleteSnapshot,
} from "../../shared/ci/completion";
import { cleanFailureSummary } from "../../shared/ci/excerpt";
import { logicalCheckId } from "../../shared/ci/identity";
import type { EtagStore } from "./etagStore";
import {
    downloadCiLog,
    HttpError,
    httpGetJsonWithMeta,
    httpRequestJson,
    RequestNotSentError,
    type DownloadCiLog,
    type DownloadedText,
    type FetchJson,
    type FetchJsonWithMeta,
    type FetchResponse,
    type WriteJson,
} from "./http";
import {
    aggregateState,
    floorDetail,
    readString,
    redactError,
    redactSecret,
    summaryForItems,
    unavailableSnapshot,
} from "./normalize";
import { CI_MAX_PAGES, CI_PAGE_SIZE, isUnderApiPrefix, paginate } from "./paginate";
import { RequestGateCooldownError } from "./requestGate";
import { uniqueJobDurations, type UsualDuration } from "./ciTiming";
import { isStatusPage, toStatusItem, type BitbucketStatus } from "./bitbucketShared";
import { NO_CI_CAPABILITIES } from "../../shared/ci/capabilities";
import type {
    CiActionRequest,
    CiDetailFetch,
    CiFailedScanCursor,
    CiFailedScanPage,
    CiLogJob,
    CommitChecksProvider,
    HostMap,
    ProviderRepoRef,
} from "./types";
import { tokenAccountKey, type CredentialStore } from "./credentialStore";

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
     * Steps are the jobs, so a job has no steps of its own. Re-runs, attempt history and
     * required checks stay off.
     */
    readonly capabilities = Object.freeze({
        ...NO_CI_CAPABILITIES,
        runs: true,
        jobs: true,
        runHeader: true,
        logs: true,
        failureSummary: true,
        cancel: true,
        usualDuration: true,
        writeScopeHelp: "commit.checks.tab.writeScopeHelpBitbucketCloud",
    });

    /**
     * Creates a BitbucketCloudProvider.
     *
     * @param fetchJson - The HTTP boundary; pass `httpGetJson` in production.
     * @param store - The credential store used to retrieve access tokens.
     * @param fetchWithMeta - The HTTP boundary for conditional requests.
     * @param etags - The window's conditional-request store; reads of a commit that was still
     *   running when last read send `If-None-Match` through `fetchWithMeta`. None: no ETags.
     * @param cooldownEnd - The request gate's cooldown end for a URL's bucket (0 when not
     *   cooling down); tells a rate-limited scan page from a failed one.
     * @param downloadLog - The step log download.
     * @param write - The write-action request (stopPipeline).
     * @param scopeHelpUrl - The README section on the `pipeline` scope, linked from the hint a
     *   token without it gets (C3).
     */
    constructor(
        private readonly fetchJson: FetchJson,
        private readonly store: CredentialStore,
        private readonly fetchWithMeta: FetchJsonWithMeta = httpGetJsonWithMeta,
        private readonly etags?: EtagStore,
        private readonly cooldownEnd: (url: string) => number = () => 0,
        private readonly downloadLog: DownloadCiLog = downloadCiLog,
        private readonly write: WriteJson = httpRequestJson,
        private readonly scopeHelpUrl?: string,
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

    /** The Bitbucket Cloud API origin, whose request-gate bucket this provider shares. */
    apiUrl(): string {
        return API_BASE;
    }

    /** Fingerprint of the token stored for the host; never the token. */
    accountKey(ref: ProviderRepoRef): Promise<string> {
        return tokenAccountKey(() => this.store.get(ref.host));
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
        const commitKey = `${this.keyFor(ref)}@${hash}`;

        let rows: BitbucketStatus[];
        let truncated: boolean;
        try {
            ({ rows, truncated } = await this.fetchAllPages(
                first,
                headers,
                this.etags?.forCommit(commitKey),
            ));
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
        const snapshot: CommitChecksSnapshot = {
            hash,
            state,
            summary: summaryForItems(items, state),
            items,
            ...(truncated ? { partial: true } : {}),
        };
        // A partial snapshot is never persisted, so it is read again at every poll: it stays
        // on conditional requests like an unfinished one.
        this.etags?.noteCommit(commitKey, isCompleteSnapshot(snapshot) && !snapshot.partial);
        return snapshot;
    }

    /**
     * Follows the `next` pagination links from a starting URL, accumulating statuses.
     *
     * Stops at the first non-page response, when no `next` link remains, or when
     * MAX_PAGES is reached (a runaway-chain guard). Headers are reused for each page.
     *
     * @param firstUrl - The first page URL.
     * @param headers - The auth headers to send on every page request.
     * @param conditional - The conditional-request store, for a commit still running at its
     *   last read; the `next` link is in the body, so a 304's stored body keeps it.
     * @returns All status rows gathered across the fetched pages, and whether a page was left
     *   unread (the bound was hit, or a page was not a status page).
     */
    private async fetchAllPages(
        firstUrl: string,
        headers: Record<string, string>,
        conditional: EtagStore | undefined,
    ): Promise<{ rows: BitbucketStatus[]; truncated: boolean }> {
        const rows: BitbucketStatus[] = [];
        let url: string | undefined = firstUrl;
        for (let page = 0; url && page < MAX_PAGES; page++) {
            const raw: unknown = conditional
                ? (await this.fetchWithMeta(url, headers, conditional)).body
                : await this.fetchJson(url, headers);
            if (!isStatusPage(raw)) break;
            rows.push(...raw.values);
            url = normalizeBitbucketCloudNextUrl(raw.next);
            // A next link that is present but refused or malformed leaves its page unread.
            if (url === undefined && raw.next != null) return { rows, truncated: true };
        }
        return { rows, truncated: url !== undefined };
    }

    /**
     * Fetches the commit's pipelines, each one's steps as its jobs, and the build statuses that
     * are not its pipelines. A 403 keeps the flat status list with a hint on the `pipeline`
     * scope (C3); any other failure yields an `unavailable` detail. Never throws.
     */
    async getDetail(ref: ProviderRepoRef, hash: string): Promise<CiDetailFetch> {
        const cloudRef = ref as BitbucketCloudRepoRef;
        const token = await this.readToken(cloudRef.host, hash);
        if (typeof token !== "string") return flatDetail(token);
        const commitKey = `${this.keyFor(ref)}@${hash}#detail`;
        try {
            const detail = await this.readDetail(
                cloudRef,
                hash,
                token,
                this.etags?.forCommit(commitKey),
            );
            this.etags?.noteCommit(commitKey, isCompleteDetail(detail));
            return detail;
        } catch (err) {
            if (err instanceof HttpError && err.statusCode === 403) {
                // A token without the `pipeline` scope still reads build statuses. A refused
                // status list too means the token itself is refused, which the hint cannot fix.
                const snapshot = await this.getChecks(ref, hash);
                if (snapshot.state === "unavailable") return flatDetail(snapshot);
                return {
                    ...floorDetail(snapshot, this.id),
                    scopeHelp: {
                        key: "commit.checks.tab.pipelineScopeHint",
                        ...(this.scopeHelpUrl && { url: this.scopeHelpUrl }),
                    },
                    // Never saved, so the tree appears once the scope is added.
                    sessionOnly: true,
                };
            }
            return flatDetail(failedSnapshot(hash, cloudRef.host, err, token));
        }
    }

    private async readDetail(
        ref: BitbucketCloudRepoRef,
        hash: string,
        token: string,
        conditional: EtagStore | undefined,
    ): Promise<CiDetailFetch> {
        const fetch = (url: string) => this.fetchWithMeta(url, authHeaders(token), conditional);
        const base = repoApiUrl(ref);
        const pipelines = await this.pages(
            ref,
            fetch,
            `${base}/pipelines/?target.commit.hash=${encodeURIComponent(hash)}&pagelen=${CI_PAGE_SIZE}`,
            valuesOf<BitbucketPipeline>,
        );
        const runs: CiRun[] = [];
        const buildNumbers = new Set<string>();
        const scanCursors: CiFailedScanCursor[] = [];
        for (const pipeline of pipelines.items) {
            const runId = readString(pipeline.uuid);
            if (!runId) continue;
            // The first page's `size` is the step count the overflow scan is budgeted by.
            let size: number | null | undefined;
            // Serial, so one commit's many pipelines never take every gate slot at once.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const stepsPage = await this.pages(
                ref,
                async (url) => {
                    const response = await fetch(url);
                    if (size === undefined) size = sizeOf(response.body);
                    return response;
                },
                `${base}/pipelines/${encodeURIComponent(runId)}/steps/?pagelen=${CI_PAGE_SIZE}`,
                valuesOf<BitbucketStep>,
            );
            // A re-run between pages leaves steps of two attempts; no tree is built from them.
            const attempts = new Set(stepsPage.items.map((s) => optionalNumber(s.run_number)));
            attempts.delete(undefined);
            // The listed pipeline's attempt must be the steps' attempt: a re-run before the steps
            // were read leaves a complete tree of the newer attempt under the older pipeline.
            const pipelineAttempt = optionalNumber(pipeline.run_number);
            if (
                attempts.size > 1 ||
                (pipelineAttempt !== undefined && [...attempts].some((a) => a !== pipelineAttempt))
            ) {
                throw new Error(vscode.l10n.t("Remote data changed. Reload and try again."));
            }
            const run = toRun(ref, pipeline, runId, stepsPage.items, stepsPage.coverage);
            runs.push(run);
            if (run.runNumber !== undefined) buildNumbers.add(String(run.runNumber));
            if (run.state === "failure" && stepsPage.next) {
                // Steps have no state filter, so the scan continues the same collection.
                scanCursors.push({
                    runId,
                    ...(run.attempt !== undefined && { runAttempt: run.attempt }),
                    runName: runScope(pipeline),
                    url: stepsPage.next,
                    jobsRead: stepsPage.items.length,
                    jobsTotal: size ?? null,
                });
            }
        }
        const statuses = await this.pages(
            ref,
            fetch,
            `${base}/commit/${encodeURIComponent(hash)}/statuses?pagelen=${CI_PAGE_SIZE}`,
            valuesOf<BitbucketStatus>,
        );
        // Bitbucket posts each pipeline as a build status too; the run already shows it.
        const otherChecks = statuses.items
            .filter((status) => !isPipelineStatus(status, ref, buildNumbers))
            .map(toStatusItem);
        return {
            ...detailOf(hash, runs, pipelines.coverage, otherChecks, statuses.coverage),
            ...(scanCursors.length > 0 && { scanCursors }),
        };
    }

    /** Reads a collection page by page by the body's `next` link, under the next-link rule. */
    private pages<T>(
        ref: BitbucketCloudRepoRef,
        fetch: (url: string) => Promise<FetchResponse>,
        firstUrl: string,
        itemsOf: (body: unknown) => T[],
    ) {
        return paginate(fetch, firstUrl, nextOf, itemsOf, CI_MAX_PAGES, (url) =>
            this.allowNext(ref, url),
        );
    }

    /**
     * Reads one page of a failed pipeline's steps past the page bound and keeps the failed ones.
     * A request-gate cooldown is reported as `pausedUntil`, never as a failure; never throws.
     */
    async continueFailedScan(
        ref: ProviderRepoRef,
        cursor: CiFailedScanCursor,
    ): Promise<CiFailedScanPage> {
        const cloudRef = ref as BitbucketCloudRepoRef;
        const refused = vscode.l10n.t("The provider's next-page link was refused.");
        if (!this.allowNext(ref, cursor.url)) return { error: refused };
        const token = await this.readToken(cloudRef.host, "");
        if (typeof token !== "string") return { error: token.error ?? "" };
        const fetch = (url: string) => this.fetchWithMeta(url, authHeaders(token));
        // The budget is the step count first read; a later page's count never replaces it.
        let jobsTotal = cursor.jobsTotal;
        const kept = () => (jobsTotal === undefined ? {} : { next: { ...cursor, jobsTotal } });
        try {
            const changed = {
                runChanged: true,
                error: vscode.l10n.t("Remote data changed. Reload and try again."),
            } as const;
            // A re-run raises the pipeline's run_number and leaves the failed state while it runs.
            const current = async () =>
                (
                    await fetch(
                        `${repoApiUrl(cloudRef)}/pipelines/${encodeURIComponent(cursor.runId)}`,
                    )
                ).body as BitbucketPipeline | null;
            const runChanged = (pipeline: BitbucketPipeline | null) =>
                readString(pipeline?.uuid) !== cursor.runId ||
                optionalNumber(pipeline?.run_number) !== cursor.runAttempt ||
                mapBitbucketCiState(pipeline?.state) !== "failure";
            if (runChanged(await current())) return changed;
            const response = await fetch(cursor.url);
            // `null` remembers a missing first count, so a later page's count never fills it in.
            if (jobsTotal === undefined) jobsTotal = sizeOf(response.body);
            const pipeline = await current();
            if (!pipeline || runChanged(pipeline)) return changed;
            const items = valuesOf<BitbucketStep>(response.body);
            const failed = items
                .map((step) => toJob(step, cursor.runName, runUrlOf(cloudRef, pipeline), pipeline))
                .filter((job) => job.state === "failure");
            const next = nextOf(response);
            if (next === undefined) return { failed };
            const jobsRead = (cursor.jobsRead ?? 0) + items.length;
            const read = [...(cursor.read ?? []), cursor.url];
            // A link back to a page already read makes no progress; an empty page with a new
            // link does. The first page's count is not a stop: it can be stale by now.
            if (!this.allowNext(ref, next) || read.includes(next)) {
                return { failed, error: refused, ...kept() };
            }
            return { failed, next: { ...cursor, url: next, read, jobsRead, jobsTotal } };
        } catch (err) {
            if (err instanceof RequestGateCooldownError) {
                return { pausedUntil: err.until, ...kept() };
            }
            if (err instanceof HttpError && err.statusCode === 429) {
                const until = this.cooldownEnd(cursor.url);
                if (until > 0) return { pausedUntil: until, ...kept() };
            }
            const failed = failedSnapshot("", cloudRef.host, err, token);
            return { error: failed.error ?? "", ...kept() };
        }
    }

    /** Continuation guard (K33): the next link stays under the first request's repository path. */
    allowNext(ref: ProviderRepoRef, url: string): boolean {
        const next = normalizeBitbucketCloudNextUrl(url);
        if (next === undefined) return false;
        // The bearer token goes to the link, so another repository on the same origin is refused.
        // Slugs match case-blind, as Bitbucket reads them.
        const repoPath = `${new URL(repoApiUrl(ref as BitbucketCloudRepoRef)).pathname}/`;
        return new URL(next).pathname.toLowerCase().startsWith(repoPath.toLowerCase());
    }

    /** Downloads a step's log with the stored token; the redirect to storage drops it. */
    async getJobLog(
        ref: ProviderRepoRef,
        job: CiLogJob,
        signal: AbortSignal,
    ): Promise<DownloadedText> {
        const cloudRef = ref as BitbucketCloudRepoRef;
        const token = await this.readToken(cloudRef.host, "");
        if (typeof token !== "string") throw new Error(token.error ?? token.summary);
        const url = `${repoApiUrl(cloudRef)}/pipelines/${encodeURIComponent(job.runId)}/steps/${encodeURIComponent(job.jobId)}/log`;
        // The redirect to storage drops the token, and so does one that stays on the API origin
        // but leaves this repository.
        return this.downloadLog(url, authHeaders(token), signal, `${repoApiUrl(cloudRef)}/`);
    }

    /**
     * Stops a pipeline with the stored token; a token without `pipeline:write` is refused with
     * 403. Cancel is the only write action the capabilities offer, so no other one reaches here.
     */
    async runAction(
        ref: ProviderRepoRef,
        request: CiActionRequest,
        beforeSend: () => Promise<void>,
    ): Promise<void> {
        const cloudRef = ref as BitbucketCloudRepoRef;
        const url = `${repoApiUrl(cloudRef)}/pipelines/${encodeURIComponent(request.runId)}/stopPipeline`;
        const until = this.cooldownEnd(url);
        if (until > 0) {
            throw new RequestGateCooldownError(
                vscode.l10n.t("Commit-check requests are temporarily paused due to rate limiting."),
                until,
            );
        }
        const token = await this.readToken(cloudRef.host, "");
        if (typeof token !== "string") throw new HttpError(401, token.error ?? token.summary, {});
        try {
            await this.write("POST", url, authHeaders(token), undefined, async () => {
                // Admitted by the request gate, before the fence: the pipeline may have finished
                // or been re-run while the write waited in the queue.
                await this.requireStoppable(cloudRef, token, request);
                await beforeSend();
            });
        } catch (error) {
            throw redactError(error, token);
        }
    }

    /** Reads the pipeline again; refuses a Stop for one that is over or is another attempt. */
    private async requireStoppable(
        ref: BitbucketCloudRepoRef,
        token: string,
        request: CiActionRequest,
    ): Promise<void> {
        const { body } = await this.fetchWithMeta(
            `${repoApiUrl(ref)}/pipelines/${encodeURIComponent(request.runId)}`,
            authHeaders(token),
        );
        const pipeline = body as BitbucketPipeline | null;
        const state = mapBitbucketCiState(pipeline?.state);
        if (
            readString(pipeline?.uuid) !== request.runId ||
            (state !== "queued" && state !== "running") ||
            (request.attempt !== undefined &&
                optionalNumber(pipeline?.run_number) !== request.attempt)
        ) {
            throw new RequestNotSentError(
                vscode.l10n.t("Remote data changed. Reload and try again."),
                true,
            );
        }
    }

    /**
     * K23: the latest successful pipeline on `run`'s ref created before it, from the ref's
     * pipelines newest first, and its steps. No token, or `run` without a ref or creation time,
     * is null; a failed request or store read rejects.
     */
    async getUsualDuration(ref: ProviderRepoRef, run: CiRun): Promise<UsualDuration | null> {
        const createdAt = Date.parse(run.createdAt ?? "");
        if (!run.ref || Number.isNaN(createdAt)) return null;
        const cloudRef = ref as BitbucketCloudRepoRef;
        const token = await this.store.get(cloudRef.host);
        if (!token) return null;
        const fetch = (url: string) => this.fetchWithMeta(url, authHeaders(token));
        const base = repoApiUrl(cloudRef);
        const isBaseline = (pipeline: BitbucketPipeline) =>
            readString(pipeline.uuid) !== run.id &&
            readString(pipeline.target?.ref_name) === run.ref &&
            mapBitbucketCiState(pipeline.state) === "success" &&
            Date.parse(readString(pipeline.created_on)) < createdAt;
        try {
            let url: string | undefined =
                `${base}/pipelines/?target.ref_name=${encodeURIComponent(run.ref)}&sort=-created_on&pagelen=${CI_PAGE_SIZE}`;
            let baseline: BitbucketPipeline | undefined;
            for (let page = 0; url && !baseline && page < CI_MAX_PAGES; page++) {
                // Newest first, so the first match is the latest; most searches end on page one.
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                const response = await fetch(url);
                baseline = valuesOf<BitbucketPipeline>(response.body).find(isBaseline);
                const next = nextOf(response);
                url = next !== undefined && this.allowNext(cloudRef, next) ? next : undefined;
            }
            const baselineRunId = readString(baseline?.uuid);
            if (!baseline || !baselineRunId) return null;
            const scope = runScope(baseline);
            const steps = await this.pages(
                cloudRef,
                fetch,
                `${base}/pipelines/${encodeURIComponent(baselineRunId)}/steps/?pagelen=${CI_PAGE_SIZE}`,
                (body) =>
                    valuesOf<BitbucketStep>(body).map((step) => ({
                        logicalId: stepLogicalId(scope, step),
                        // A skipped or failed step's duration is not a usual time.
                        ms:
                            mapBitbucketCiState(step.state) === "success"
                                ? secondsToMs(step.duration_in_seconds)
                                : null,
                    })),
            );
            return {
                baselineRunId,
                runMs: secondsToMs(baseline.duration_in_seconds),
                // A cut step list cannot show that an id is unique, so no step gets a match.
                jobMs: steps.coverage === "full" ? uniqueJobDurations(steps.items) : {},
            };
        } catch (err) {
            throw redactError(err, token);
        }
    }

    /** The stored token, or the snapshot to show when there is none or the store failed. */
    private async readToken(host: string, hash: string): Promise<string | CommitChecksSnapshot> {
        try {
            return (await this.store.get(host)) || signInSnapshot(hash, host);
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
    }
}

/** A pipeline as the 2.0 API sends it; every field is untrusted. */
interface BitbucketPipeline {
    uuid?: unknown;
    build_number?: unknown;
    run_number?: unknown;
    creator?: { display_name?: unknown; nickname?: unknown } | null;
    target?: {
        ref_name?: unknown;
        selector?: { type?: unknown; pattern?: unknown } | null;
    } | null;
    trigger?: { name?: unknown } | null;
    state?: BitbucketState | null;
    created_on?: unknown;
    completed_on?: unknown;
    duration_in_seconds?: unknown;
}

interface BitbucketStep {
    uuid?: unknown;
    name?: unknown;
    state?: BitbucketState | null;
    started_on?: unknown;
    completed_on?: unknown;
    duration_in_seconds?: unknown;
    run_number?: unknown;
}

interface BitbucketState {
    name?: unknown;
    stage?: { name?: unknown } | null;
    result?: { name?: unknown; error?: { message?: unknown } | null } | null;
}

/** Repository API base under 2.0. */
function repoApiUrl(ref: BitbucketCloudRepoRef): string {
    return `${API_BASE}/repositories/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.repo)}`;
}

function authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
}

/**
 * The body's `next` link. A value that is not a string is handed on as text, so the next-link
 * rule refuses it and the page never counts as the last.
 */
function nextOf(response: FetchResponse): string | undefined {
    const next = (response.body as { next?: unknown } | null)?.next;
    if (next === undefined || next === null || next === "") return undefined;
    return typeof next === "string" ? next : JSON.stringify(next);
}

/** A page without a `values` list is a failed read, never an empty collection. */
function valuesOf<T>(body: unknown): T[] {
    if (!isStatusPage(body)) {
        throw new Error(vscode.l10n.t("Remote data changed. Reload and try again."));
    }
    return body.values as T[];
}

/** The collection's item count in a page body; null when it names none. */
function sizeOf(body: unknown): number | null {
    return optionalNumber((body as { size?: unknown } | null)?.size) ?? null;
}

/**
 * The pipeline's name as Bitbucket shows it: the branch, tag or custom pipeline pattern, else
 * the selector type ("default"). The logical scope of its steps; empty when it names neither.
 */
function runScope(pipeline: BitbucketPipeline): string {
    return (
        readString(pipeline.target?.selector?.pattern) ||
        readString(pipeline.target?.selector?.type)
    );
}

function stepLogicalId(scope: string, step: BitbucketStep): string {
    return logicalCheckId({
        kind: "job",
        scope,
        name: readString(step.name) || readString(step.uuid),
    });
}

/** The pipeline's result page on bitbucket.org; undefined without a build number. */
function runUrlOf(ref: BitbucketCloudRepoRef, pipeline: BitbucketPipeline): string | undefined {
    const buildNumber = optionalNumber(pipeline.build_number);
    if (buildNumber === undefined) return undefined;
    return `https://${CLOUD_HOST}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.repo)}/pipelines/results/${buildNumber}`;
}

function toRun(
    ref: BitbucketCloudRepoRef,
    pipeline: BitbucketPipeline,
    id: string,
    steps: BitbucketStep[],
    jobsCoverage: CiCoverage,
): CiRun {
    const name = runScope(pipeline);
    const url = runUrlOf(ref, pipeline);
    return {
        id,
        name: name || id,
        url,
        state: mapBitbucketCiState(pipeline.state),
        event: optionalString(pipeline.trigger?.name)?.toLowerCase(),
        actor:
            optionalString(pipeline.creator?.display_name) ??
            optionalString(pipeline.creator?.nickname),
        ref: optionalString(pipeline.target?.ref_name),
        runNumber: optionalNumber(pipeline.build_number),
        attempt: optionalNumber(pipeline.run_number),
        createdAt: optionalString(pipeline.created_on),
        // Bitbucket sends no separate start time: creation to completion is the duration it reports.
        startedAt: optionalString(pipeline.created_on),
        completedAt: optionalString(pipeline.completed_on),
        jobs: steps.map((step) => toJob(step, name, url, pipeline)),
        jobsCoverage,
    };
}

/** Maps one step; `scope` is the pipeline name, `pipeline` gives the fallback failure text. */
function toJob(
    step: BitbucketStep,
    scope: string,
    runUrl: string | undefined,
    pipeline: BitbucketPipeline,
): CiJob {
    const id = readString(step.uuid);
    const name = readString(step.name) || id;
    let state = mapBitbucketCiState(step.state);
    // A step still waiting in a finished pipeline is a manual step nobody started.
    if (state === "queued" && readString(pipeline.state?.name).toUpperCase() === "COMPLETED") {
        state = "neutral";
    }
    const failureSummary =
        state === "failure"
            ? cleanFailureSummary(
                  readString(step.state?.result?.error?.message) ||
                      readString(pipeline.state?.result?.error?.message),
              )
            : undefined;
    return {
        id,
        logicalId: stepLogicalId(scope, step),
        name,
        checkName: name,
        state,
        url: runUrl && `${runUrl}/steps/${encodeURIComponent(id)}`,
        startedAt: optionalString(step.started_on),
        completedAt: optionalString(step.completed_on),
        attempt: optionalNumber(step.run_number),
        steps: [],
        ...(failureSummary !== undefined && { failureSummary }),
    };
}

/** An in-progress pipeline's stage; any other stage is running. PAUSED waits for a person. */
const STAGE_STATES = new Map<string, CiState>([
    ["PAUSED", "neutral"],
    ["HALTED", "unknown"],
]);

/** A completed pipeline's or step's result. */
const RESULT_STATES = new Map<string, CiState>([
    ["SUCCESSFUL", "success"],
    ["FAILED", "failure"],
    ["ERROR", "failure"],
    ["STOPPED", "cancelled"],
    ["EXPIRED", "cancelled"],
    ["NOT_RUN", "skipped"],
    ["SKIPPED", "skipped"],
]);

/** Maps a pipeline or step `state` to the shared CI state. */
function mapBitbucketCiState(state: BitbucketState | null | undefined): CiState {
    switch (readString(state?.name).toUpperCase()) {
        case "PENDING":
        case "READY":
            return "queued";
        case "IN_PROGRESS":
            return STAGE_STATES.get(readString(state?.stage?.name).toUpperCase()) ?? "running";
        case "COMPLETED":
            return RESULT_STATES.get(readString(state?.result?.name).toUpperCase()) ?? "unknown";
        default:
            return "unknown";
    }
}

/**
 * True for the build status Bitbucket posts for a listed pipeline of this repository: a
 * bitbucket.org link into the repository whose `results/<n>` names the pipeline's build number.
 */
function isPipelineStatus(
    status: BitbucketStatus,
    ref: BitbucketCloudRepoRef,
    buildNumbers: ReadonlySet<string>,
): boolean {
    let url: URL;
    try {
        url = new URL(readString(status.url));
    } catch {
        return false;
    }
    if (url.hostname.toLowerCase() !== CLOUD_HOST) return false;
    // The pipelines page keeps the result number in the fragment (`#!/results/42`).
    const where = `${url.pathname}${url.hash}`.toLowerCase();
    if (!where.startsWith(`/${ref.workspace.toLowerCase()}/${ref.repo.toLowerCase()}/`)) {
        return false;
    }
    const buildNumber = /\/results\/(\d+)/.exec(where)?.[1];
    return buildNumber !== undefined && buildNumbers.has(buildNumber);
}

/** A duration in seconds as milliseconds; null when it is missing or not a duration. */
function secondsToMs(seconds: unknown): number | null {
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? Math.round(seconds * 1000)
        : null;
}

function optionalString(value: unknown): string | undefined {
    return readString(value) || undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    return unavailableSnapshot(hash, redactSecret(message, token));
}

/** The run-less detail for a snapshot that is unavailable; never complete. */
function flatDetail(snapshot: CommitChecksSnapshot): CommitCiDetailData {
    return {
        hash: snapshot.hash,
        provider: "bitbucket-cloud",
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
        provider: "bitbucket-cloud",
        complete: outcome !== "none" && !hasUnfinishedWork(runs, otherChecks),
        outcome,
        runs,
        runsCoverage,
        otherChecks,
        otherChecksCoverage,
    };
}

function normalizeBitbucketCloudNextUrl(next: unknown): string | undefined {
    if (typeof next !== "string" || !isUnderApiPrefix(next, API_BASE, ["/2.0/"])) {
        return undefined;
    }
    return new URL(next).toString();
}
