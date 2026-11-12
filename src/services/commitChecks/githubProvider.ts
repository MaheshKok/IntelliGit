// GitHub commit-check provider. Parses github.com remotes, authenticates with the
// built-in VS Code GitHub session, fetches Checks API runs plus legacy commit
// statuses for one commit, and normalizes them into the shared snapshot shape.
// HTTP is injected (`FetchJson`) so mapping is unit-testable without the network.

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
    CiCoverage,
    CiFlatCheck,
    CiJob,
    CiRun,
    CiState,
    CiStep,
    CommitCheckItem,
    CommitChecksSnapshot,
    CommitCheckState,
    CommitCiDetailData,
} from "../../types";
import { getErrorMessage } from "../../utils/errors";
import {
    downloadCiLog,
    HttpError,
    httpGetJson,
    httpGetJsonWithMeta,
    type DownloadCiLog,
    type DownloadedText,
    type FetchJson,
    type FetchJsonWithMeta,
} from "./http";
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
import { CI_MAX_PAGES, CI_PAGE_SIZE, isUnderApiPrefix, linkHeaderNext, paginate } from "./paginate";
import { RequestGateCooldownError } from "./requestGate";
import { NO_CI_CAPABILITIES } from "../../shared/ci/capabilities";
import {
    hasUnfinishedWork,
    isCompleteDetail,
    isCompleteSnapshot,
} from "../../shared/ci/completion";
import { cleanFailureSummary } from "../../shared/ci/excerpt";
import { logicalCheckId } from "../../shared/ci/identity";
import type { EtagStore } from "./etagStore";
import type {
    CiDetailFetch,
    CiFailedScanCursor,
    CiFailedScanPage,
    CiLogJob,
    CommitChecksProvider,
    HostMap,
    ProviderRepoRef,
} from "./types";

interface GitHubRepoRef extends ProviderRepoRef {
    readonly owner: string;
    readonly repo: string;
}

interface GitHubCheckRun {
    id?: unknown;
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

interface GitHubWorkflowRun {
    id?: unknown;
    name?: unknown;
    display_title?: unknown;
    html_url?: unknown;
    status?: unknown;
    conclusion?: unknown;
    workflow_id?: unknown;
    event?: unknown;
    actor?: { login?: unknown } | null;
    head_branch?: unknown;
    run_number?: unknown;
    run_attempt?: unknown;
    created_at?: unknown;
    run_started_at?: unknown;
    updated_at?: unknown;
    check_suite_id?: unknown;
    repository?: { id?: unknown } | null;
}

interface GitHubWorkflowJob {
    id?: unknown;
    name?: unknown;
    workflow_name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    html_url?: unknown;
    check_run_url?: unknown;
    started_at?: unknown;
    completed_at?: unknown;
    run_attempt?: unknown;
    steps?: unknown;
}

interface GitHubWorkflowStep {
    number?: unknown;
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    started_at?: unknown;
    completed_at?: unknown;
}

const GITHUB_PAGE_SIZE = 100;
/** Whole detail reads before a run that keeps re-running is shown as it was last read. */
const DETAIL_MAX_READS = 3;
/**
 * GitHub lists a ref's check runs from its 1 000 most recent check suites only
 * (https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference). The API
 * does not report the limit, so it is GitHub's documented value. Past it the flat list is
 * partial; exactly at it is treated the same, since the suites count is not documented to go
 * past the limit, and a job missing from the snapshot is looked up in its own suite.
 */
const REF_CHECK_SUITE_LIMIT = 1000;
/** Statuses of an expired signed log link; the logs endpoint then hands out a fresh one. */
const EXPIRED_LOG_LINK = new Set([403, 404, 410]);

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
    /** Each flag turns on in the phase that implements it. */
    readonly capabilities = Object.freeze({
        ...NO_CI_CAPABILITIES,
        runs: true,
        jobs: true,
        steps: true,
        runHeader: true,
        logs: true,
        failureSummary: true,
    });
    /** GitHub Actions prefixes each error annotation line of a log with this marker. */
    readonly firstErrorPatterns = [/##\[error\]/];
    /** GitHub Actions opens each step's section of a log with this marker and the step name. */
    readonly stepStartPrefix = "##[group]";

    /**
     * Accepts injected HTTP boundaries and an optional CI/CD include override.
     *
     * @param fetchJson - The HTTP boundary; defaults to the real HTTPS helper in production.
     * @param ciCdPattern - Optional include pattern from `commitChecks.ciCdFilter`; when
     *   omitted the built-in `CICD_CHECK_PATTERN` is used. The review-bot exclusion always
     *   applies regardless of this override.
     * @param fetchWithMeta - The HTTP boundary for the `Link`-paged run and job lists.
     * @param cooldownEnd - The request gate's cooldown end for a URL's bucket (0 when not
     *   cooling down); tells a rate-limit response on a scan page from a permission refusal.
     * @param etags - The window's conditional-request store; reads of a commit that was still
     *   running when last read send `If-None-Match` through `fetchWithMeta`. None: no ETags.
     * @param downloadLog - The job log download; follows the logs endpoint's redirect.
     */
    constructor(
        private readonly fetchJson: FetchJson = httpGetJson,
        private readonly ciCdPattern?: RegExp,
        private readonly fetchWithMeta: FetchJsonWithMeta = httpGetJsonWithMeta,
        private readonly cooldownEnd: (url: string) => number = () => 0,
        private readonly etags?: EtagStore,
        private readonly downloadLog: DownloadCiLog = downloadCiLog,
    ) {}

    /**
     * Downloads a job's log. The logs endpoint redirects to a short-lived signed URL on another
     * host, which the download follows without the token; a 403, 404 or 410 from that URL
     * means the link expired, so the endpoint is asked once more for a fresh one.
     *
     * @param ref - The repository.
     * @param job - The job; GitHub's job id names one attempt.
     * @param signal - Aborts the download.
     */
    async getJobLog(
        ref: ProviderRepoRef,
        job: CiLogJob,
        signal: AbortSignal,
    ): Promise<DownloadedText> {
        const session = await openSession("");
        if (!isSession(session)) {
            throw new Error(session.error ?? summaryForState(session.state));
        }
        const url = `${repoApiUrl(ref as GitHubRepoRef)}/actions/jobs/${encodeURIComponent(job.jobId)}/logs`;
        const headers = githubHeaders(session);
        try {
            return await this.downloadLog(url, headers, signal);
        } catch (err) {
            const fromSignedLink =
                err instanceof HttpError &&
                EXPIRED_LOG_LINK.has(err.statusCode) &&
                err.url !== undefined &&
                err.url !== new URL(url).href;
            if (!fromSignedLink) throw err;
            return this.downloadLog(url, headers, signal);
        }
    }

    /** Matches any github.com remote; the host map is not consulted for GitHub. */
    match(remoteUrl: string, _hostMap: HostMap): ProviderRepoRef | null {
        return parseGithubRemoteUrl(remoteUrl);
    }

    /** Returns a stable repository cache key for a parsed GitHub remote. */
    keyFor(ref: ProviderRepoRef): string {
        const { host, owner, repo } = ref as GitHubRepoRef;
        return `github:${host.toLowerCase()}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
    }

    /** The signed-in VS Code GitHub account id; "signed-out" without a session. */
    async accountKey(): Promise<string> {
        try {
            const session = await vscode.authentication.getSession("github", ["repo"], {
                silent: true,
            });
            return session ? `account-${session.account.id}` : "signed-out";
        } catch {
            return `unresolved-${randomUUID()}`;
        }
    }

    /** Authenticates, fetches check-runs + statuses in parallel, and normalizes them. */
    async getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot> {
        const session = await openSession(hash);
        if (!isSession(session)) return session;
        const commitKey = `${this.keyFor(ref)}@${hash}`;
        const { snapshot } = await this.fetchSnapshot(
            ref as GitHubRepoRef,
            hash,
            session,
            false,
            this.etags?.forCommit(commitKey),
        );
        this.etags?.noteCommit(commitKey, isCompleteSnapshot(snapshot));
        return snapshot;
    }

    /**
     * Fetches the commit's workflow runs, their latest jobs and steps, and the snapshot's
     * checks that are not jobs. Any page failure yields an `unavailable` detail; never throws.
     */
    async getDetail(ref: ProviderRepoRef, hash: string): Promise<CiDetailFetch> {
        const gitHubRef = ref as GitHubRepoRef;
        const session = await openSession(hash);
        if (!isSession(session)) return flatDetail(session);
        const commitKey = `${this.keyFor(ref)}@${hash}#detail`;
        const conditional = this.etags?.forCommit(commitKey);
        try {
            // A re-run during a read restarts it whole, since the snapshot's check runs belong
            // to the old attempt too. The last read keeps what it saw, marked incomplete.
            for (let read = 1; ; read += 1) {
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                const detail = await this.readDetail(
                    gitHubRef,
                    hash,
                    session,
                    read === DETAIL_MAX_READS,
                    conditional,
                );
                if (detail) {
                    this.etags?.noteCommit(commitKey, isCompleteDetail(detail));
                    return detail;
                }
            }
        } catch (err) {
            return flatDetail(failedSnapshot(hash, gitHubRef.host, err, session.accessToken));
        }
    }

    /**
     * One read of the detail: run list, snapshot, then each run's jobs and its attempt again.
     * GitHub can announce a re-run's attempt before its jobs and check runs catch up, so the
     * read counts only when the attempt is unchanged, every job reports the run's attempt and
     * every job's check run is in the snapshot. Otherwise it returns undefined, or on the
     * last read an incomplete detail that is never saved.
     */
    private async readDetail(
        ref: GitHubRepoRef,
        hash: string,
        session: vscode.AuthenticationSession,
        lastRead: boolean,
        conditional: EtagStore | undefined,
    ): Promise<CiDetailFetch | undefined> {
        const fetch = (url: string) => this.fetchWithMeta(url, githubHeaders(session), conditional);
        let repositoryId: string | undefined;
        const runsPage = await paginate(
            fetch,
            `${repoApiUrl(ref)}/actions/runs?head_sha=${encodeURIComponent(hash)}&per_page=${CI_PAGE_SIZE}`,
            linkHeaderNext,
            (body) => {
                const runs = readList<GitHubWorkflowRun>(body, "workflow_runs");
                repositoryId ??= readId(runs[0]?.repository?.id);
                return runs;
            },
            CI_MAX_PAGES,
            (url) => this.allowNext(ref, url, repositoryId),
        );
        const { snapshot, checkRunIds, summaries } = await this.fetchSnapshot(
            ref,
            hash,
            session,
            true,
            conditional,
        );
        if (snapshot.state === "unavailable") return flatDetail(snapshot);
        // At GitHub's suite limit the snapshot is partial whether or not a job is missing from
        // it: the flat list reports the gap, and a missing job is looked up in its own suite.
        const refLimited = await this.refAtSuiteLimit(ref, hash, session, conditional);
        const inOwnSuite = async (run: GitHubWorkflowRun, missing: readonly string[]) => {
            const suiteId = readId(run.check_suite_id);
            if (!refLimited || suiteId === undefined) return false;
            const suite = await paginate(
                fetch,
                `${repoApiUrl(ref)}/check-suites/${encodeURIComponent(suiteId)}/check-runs?filter=all&per_page=${CI_PAGE_SIZE}`,
                linkHeaderNext,
                (body) => readCheckRuns(body).flatMap((checkRun) => readId(checkRun.id) ?? []),
                CI_MAX_PAGES,
                (url) => this.allowNext(ref, url, repositoryId),
            );
            const ids = new Set(suite.items);
            return missing.every((id) => ids.has(id));
        };
        let rerun = false;
        let summaryMissed = false;
        const runs: CiRun[] = [];
        // Every run as read, hidden jobs included, so a hidden job's check run is no flat check.
        const readRuns: CiRun[] = [];
        const scanCursors: CiFailedScanCursor[] = [];
        for (const run of runsPage.items) {
            const runId = readId(run.id);
            if (runId === undefined) continue;
            const runName = readString(run.name) || readString(run.display_title);
            let jobsTotal: number | undefined;
            // Serial by GitHub's own instruction, like the check-run pager below.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const jobsPage = await paginate(
                fetch,
                `${repoApiUrl(ref)}/actions/runs/${runId}/jobs?filter=latest&per_page=${CI_PAGE_SIZE}`,
                linkHeaderNext,
                (body) => {
                    jobsTotal ??= totalCount(body);
                    return readList<GitHubWorkflowJob>(body, "jobs").map((job) =>
                        toJob(job, runName),
                    );
                },
                CI_MAX_PAGES,
                (url) => this.allowNext(ref, url, repositoryId),
            );
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const current = await this.currentRun(ref, runId, session, conditional);
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const known = await this.unlistedSummaries(
                ref,
                jobsPage.items,
                { checkRunIds, summaries },
                session,
                conditional,
            );
            if (!known.complete) summaryMissed = true;
            const jobs = jobsPage.items.map((job) => withFailureSummary(job, known.summaries));
            const ciRun = toRun(run, runId, runName, jobs, jobsPage.coverage);
            const missing = ciRun.jobs.flatMap((job) =>
                job.checkRunId === undefined || checkRunIds.has(job.checkRunId)
                    ? []
                    : [job.checkRunId],
            );
            const consistent =
                optionalNumber(current.run_attempt) === ciRun.attempt &&
                ciRun.jobs.every(
                    (job) => job.attempt === undefined || job.attempt === ciRun.attempt,
                ) &&
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                (missing.length === 0 || (await inOwnSuite(run, missing)));
            if (!consistent) {
                if (!lastRead) return undefined;
                rerun = true;
            }
            readRuns.push(ciRun);
            const next = ciRun.state === "failure" ? jobsPage.next : undefined;
            if (consistent) {
                runs.push(ciRun);
                if (next) {
                    scanCursors.push({
                        runId,
                        runAttempt: ciRun.attempt,
                        runName,
                        url: next,
                        jobsRead: jobsPage.items.length,
                        ...(jobsTotal !== undefined && { jobsTotal }),
                    });
                }
            } else {
                // A run shows only its own attempt's jobs. Its overflow scan stops instead of
                // starting, since its run check would restart it on every page; Refresh reads again.
                runs.push({
                    ...ciRun,
                    jobs: ciRun.jobs.filter(
                        (job) => job.attempt === undefined || job.attempt === ciRun.attempt,
                    ),
                    ...(next && {
                        failedScan: {
                            state: "stopped" as const,
                            found: 0,
                            error: vscode.l10n.t("Remote data changed. Reload and try again."),
                        },
                    }),
                });
            }
        }
        const otherChecks = otherChecksOf(snapshot.items, readRuns);
        return {
            ...detailOf(hash, runs, runsPage.coverage, otherChecks),
            ...(refLimited && {
                otherChecksCoverage: { reason: "pageBound" as const, shown: otherChecks.length },
            }),
            // A missed failure text is read again later rather than saved missing.
            ...((rerun || summaryMissed) && { complete: false }),
            ...(scanCursors.length > 0 && { scanCursors }),
        };
    }

    /**
     * Reads one page of a failed run's jobs past the page bound and keeps only failed jobs.
     * A request-gate cooldown is reported as `pausedUntil`, never as a failure; never throws.
     */
    async continueFailedScan(
        ref: ProviderRepoRef,
        cursor: CiFailedScanCursor,
    ): Promise<CiFailedScanPage> {
        // The cursor came from a guarded link, so its repository id is the one the API named.
        const repositoryId = /^\/repositories\/(\d+)\//.exec(safePathname(cursor.url))?.[1];
        const refused = vscode.l10n.t("The provider's next-page link was refused.");
        if (!this.allowNext(ref, cursor.url, repositoryId)) return { error: refused };
        const session = await openSession("");
        if (!isSession(session)) {
            return { error: session.error ?? summaryForState(session.state) };
        }
        // The budget is the job count first read; a later page's count never replaces it. A stop
        // or pause after the page that read it keeps it in the same page's cursor.
        let jobsTotal = cursor.jobsTotal;
        const kept = () => (jobsTotal === undefined ? {} : { next: { ...cursor, jobsTotal } });
        try {
            const changed = {
                runChanged: true,
                error: vscode.l10n.t("Remote data changed. Reload and try again."),
            } as const;
            const runChanged = async () => {
                const run = await this.currentRun(ref as GitHubRepoRef, cursor.runId, session);
                return (
                    readId(run.id) !== cursor.runId ||
                    optionalNumber(run.run_attempt) !== cursor.runAttempt
                );
            };
            // Read before every page, resumes included, so a re-run elsewhere stops the scan.
            if (await runChanged()) return changed;
            const response = await this.fetchWithMeta(cursor.url, githubHeaders(session));
            // `null` remembers a missing first count, so a later page's count never fills it in.
            if (jobsTotal === undefined) jobsTotal = totalCount(response.body) ?? null;
            // And after it: a re-run before this page answered would mix the two attempts' jobs.
            if (await runChanged()) return changed;
            const jobs = readList<GitHubWorkflowJob>(response.body, "jobs").map((job) =>
                toJob(job, cursor.runName),
            );
            // The run kept its attempt but the page did not catch up: discard it.
            if (
                jobs.some((job) => job.attempt !== undefined && job.attempt !== cursor.runAttempt)
            ) {
                return changed;
            }
            const failedJobs = jobs.filter((job) => job.state === "failure");
            // The commit's check-run listing is not read here, so each failed job's text comes
            // from its own check run. One that cannot be read leaves its job without the text
            // rather than hiding the job or re-reading the page.
            const { summaries } = await this.unlistedSummaries(
                ref as GitHubRepoRef,
                failedJobs,
                { checkRunIds: new Set(), summaries: new Map() },
                session,
                undefined,
            );
            const failed = failedJobs.map((job) => withFailureSummary(job, summaries));
            const next = linkHeaderNext(response);
            if (next === undefined) return { failed };
            const read = [...(cursor.read ?? []), requestedUrl(cursor.url)];
            const jobsRead = (cursor.jobsRead ?? 0) + jobs.length;
            // A link back to a page already read would loop the scan without end. A respelt link
            // to one is caught once the run's own job count is read, and an empty page that links
            // onward makes no progress.
            if (
                !this.allowNext(ref, next, repositoryId) ||
                read.includes(requestedUrl(next)) ||
                jobs.length === 0 ||
                jobsTotal === null ||
                jobsRead >= jobsTotal
            ) {
                // The same page again, with the budget saved, so Refresh resumes under it.
                return { failed, error: refused, ...kept() };
            }
            return { failed, next: { ...cursor, url: next, read, jobsRead, jobsTotal } };
        } catch (err) {
            if (err instanceof RequestGateCooldownError) {
                return { pausedUntil: err.until, ...kept() };
            }
            // A 429 or a quota 403 puts the gate into cooldown; a permission 403 does not.
            if (err instanceof HttpError && (err.statusCode === 429 || err.statusCode === 403)) {
                const until = this.cooldownEnd(cursor.url);
                if (until > 0) return { pausedUntil: until, ...kept() };
            }
            const failed = failedSnapshot("", ref.host, err, session.accessToken);
            return { error: failed.error ?? "", ...kept() };
        }
    }

    /**
     * Continuation guard (K33): a next link must stay on the API origin under this
     * repository's path, `/repos/{owner}/{repo}/` or, as GitHub's own `Link` headers name it,
     * `/repositories/{id}/` for the id the API reported for this repository.
     */
    allowNext(ref: ProviderRepoRef, url: string, repositoryId?: string): boolean {
        const { owner, repo } = ref as GitHubRepoRef;
        const prefixes = [`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/`];
        if (repositoryId !== undefined) prefixes.push(`/repositories/${repositoryId}/`);
        return isUnderApiPrefix(url, apiBase(ref), prefixes);
    }

    /** Whether the commit has as many check suites as GitHub lists check runs from. */
    private async refAtSuiteLimit(
        ref: GitHubRepoRef,
        hash: string,
        session: vscode.AuthenticationSession,
        conditional: EtagStore | undefined,
    ): Promise<boolean> {
        const response = await this.fetchWithMeta(
            `${repoApiUrl(ref)}/commits/${encodeURIComponent(hash)}/check-suites?per_page=1`,
            githubHeaders(session),
            conditional,
        );
        const total = (response.body as { total_count?: unknown } | null)?.total_count;
        return typeof total === "number" && total >= REF_CHECK_SUITE_LIMIT;
    }

    /**
     * The listed check runs' failure texts, plus that of each failed job whose check run the
     * commit's listing missed (GitHub's suite limit), read from the job's own check run. The
     * text is extra: a read that fails or meets a cooldown leaves that job without it and
     * `complete` false, never the jobs unread. Never throws.
     */
    private async unlistedSummaries(
        ref: GitHubRepoRef,
        jobs: readonly CiJob[],
        listed: { checkRunIds: ReadonlySet<string>; summaries: ReadonlyMap<string, string> },
        session: vscode.AuthenticationSession,
        conditional: EtagStore | undefined,
    ): Promise<{ summaries: ReadonlyMap<string, string>; complete: boolean }> {
        const known = new Map(listed.summaries);
        let complete = true;
        for (const job of jobs) {
            const id = job.checkRunId;
            if (job.state !== "failure" || id === undefined || listed.checkRunIds.has(id)) {
                continue;
            }
            try {
                // Serial, like the detail's other reads.
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                const response = await this.fetchWithMeta(
                    `${repoApiUrl(ref)}/check-runs/${encodeURIComponent(id)}`,
                    githubHeaders(session),
                    conditional,
                );
                const summary = checkRunSummary(response.body ?? {});
                if (summary !== undefined) known.set(id, summary);
            } catch {
                complete = false;
            }
        }
        return { summaries: known, complete };
    }

    /** The workflow run as the API reports it now; an empty run for an empty body. */
    private async currentRun(
        ref: GitHubRepoRef,
        runId: string,
        session: vscode.AuthenticationSession,
        conditional?: EtagStore,
    ): Promise<GitHubWorkflowRun> {
        const response = await this.fetchWithMeta(
            `${repoApiUrl(ref)}/actions/runs/${encodeURIComponent(runId)}`,
            githubHeaders(session),
            conditional,
        );
        return response.body ?? {};
    }

    /**
     * The snapshot, plus the id of every check run read, before the CI/CD filter drops any:
     * the detail checks each job's check run against them. `summaries` holds each check run's
     * output title and summary by check-run id, the failure text of the job it belongs to.
     */
    private async fetchSnapshot(
        ref: GitHubRepoRef,
        hash: string,
        session: vscode.AuthenticationSession,
        requireBoth = false,
        conditional?: EtagStore,
    ): Promise<{
        snapshot: CommitChecksSnapshot;
        checkRunIds: ReadonlySet<string>;
        summaries: ReadonlyMap<string, string>;
    }> {
        const headers = githubHeaders(session);
        const base = `${repoApiUrl(ref)}/commits/${encodeURIComponent(hash)}`;
        const fetchJson: FetchJson = conditional
            ? async (url, sent) => (await this.fetchWithMeta(url, sent, conditional)).body
            : this.fetchJson;

        const [checkRunsResult, statusesResult] = await Promise.allSettled([
            fetchAllCheckRuns(fetchJson, base, headers),
            fetchAllStatuses(fetchJson, base, headers),
        ]);

        const rejected = [checkRunsResult, statusesResult].flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
        );
        // The badge shows whichever endpoint answered; the detail claims full coverage, so it
        // needs both.
        if (rejected.length === 2 || (rejected.length === 1 && requireBoth)) {
            // A refused credential on either endpoint wins; else the check-run error is shown.
            const reason = rejected.find(isCredentialRejection) ?? rejected[0];
            return {
                snapshot: failedSnapshot(hash, ref.host, reason, session.accessToken),
                checkRunIds: new Set(),
                summaries: new Map(),
            };
        }

        const checkRuns =
            checkRunsResult.status === "fulfilled" ? checkRunsResult.value : undefined;
        return {
            snapshot: normalizeGithubChecks(
                hash,
                checkRuns,
                statusesResult.status === "fulfilled" ? statusesResult.value : undefined,
                this.ciCdPattern,
            ),
            checkRunIds: new Set(readCheckRuns(checkRuns).flatMap((run) => readId(run.id) ?? [])),
            summaries: new Map(
                readCheckRuns(checkRuns).flatMap((run) => {
                    const id = readId(run.id);
                    const summary = id === undefined ? undefined : checkRunSummary(run);
                    return id === undefined || summary === undefined
                        ? []
                        : [[id, summary] as const];
                }),
            ),
        };
    }
}

/** The VS Code GitHub session, or the snapshot to show when there is none or it failed. */
async function openSession(
    hash: string,
): Promise<vscode.AuthenticationSession | CommitChecksSnapshot> {
    try {
        const session = await vscode.authentication.getSession("github", ["repo"], {
            silent: true,
        });
        return session ?? { hash, state: "none", summary: summaryForState("none"), items: [] };
    } catch (err) {
        return unavailableSnapshot(
            hash,
            vscode.l10n.t("GitHub authentication failed: {message}", {
                message: getErrorMessage(err),
            }),
        );
    }
}

function isSession(
    value: vscode.AuthenticationSession | CommitChecksSnapshot,
): value is vscode.AuthenticationSession {
    return "accessToken" in value;
}

function githubHeaders(session: vscode.AuthenticationSession): Record<string, string> {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${session.accessToken}`,
        "User-Agent": "vscode-intelligit",
        "X-GitHub-Api-Version": "2022-11-28",
    };
}

/** REST API origin for the remote's host (github.com → api.github.com). */
function apiBase(ref: ProviderRepoRef): string {
    return `https://api.${ref.host}`;
}

function repoApiUrl(ref: GitHubRepoRef): string {
    return `${apiBase(ref)}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

/**
 * The unavailable snapshot for a failed request: a sign-in prompt when the credential was
 * refused, else the error text with the session token redacted.
 */
function failedSnapshot(
    hash: string,
    host: string,
    reason: unknown,
    token: string,
): CommitChecksSnapshot {
    if (isCredentialRejection(reason)) {
        // Parity with GitLab and both Bitbucket providers: a rejected credential yields a
        // badge carrying signInHost, which is what renders the popover's "Sign in" action.
        // Without it a revoked session is a dead-end error badge whose only recovery is a
        // window reload. The sign-in command routes github.com to VS Code's own session
        // prompt rather than the token store, which this provider never reads.
        return unavailableSnapshot(
            hash,
            vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
            host,
        );
    }
    // getErrorMessage redacts URL-embedded credentials; redactSecret strips the session
    // token in case a transport error echoed the Authorization header.
    return unavailableSnapshot(hash, redactSecret(getErrorMessage(reason), token));
}

/** The run-less detail for a snapshot that is none or unavailable; never complete. */
function flatDetail(snapshot: CommitChecksSnapshot): CommitCiDetailData {
    return {
        hash: snapshot.hash,
        provider: "github",
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
        provider: "github",
        complete: outcome !== "none" && !hasUnfinishedWork(runs, otherChecks),
        outcome,
        runs,
        runsCoverage,
        otherChecks,
        // The snapshot pages through every check run and status, so its list has no bound.
        otherChecksCoverage: "full",
    };
}

/**
 * Snapshot checks that are not one of the jobs: matched by check-run id; an item without an
 * id (an older cached snapshot) only when exactly one job has its name, since a visible
 * duplicate beats a hidden status.
 */
function otherChecksOf(items: CommitCheckItem[], runs: CiRun[]): CiFlatCheck[] {
    const jobs = runs.flatMap((run) => run.jobs);
    const checkRunIds = new Set(jobs.map((job) => job.checkRunId));
    return items
        .filter((item) =>
            item.id !== undefined
                ? item.source !== "check-run" || !checkRunIds.has(item.id)
                : jobs.filter((job) => job.checkName === item.name).length !== 1,
        )
        .map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            state: item.state,
            source: item.source,
            url: item.url,
        }));
}

function toRun(
    run: GitHubWorkflowRun,
    id: string,
    name: string,
    jobs: CiJob[],
    jobsCoverage: CiCoverage,
): CiRun {
    const status = readString(run.status);
    return {
        id,
        name: name || id,
        url: optionalString(run.html_url),
        state: mapActionsState(status, readString(run.conclusion)),
        workflowId: readId(run.workflow_id),
        event: optionalString(run.event),
        actor: optionalString(run.actor?.login),
        ref: optionalString(run.head_branch),
        runNumber: optionalNumber(run.run_number),
        attempt: optionalNumber(run.run_attempt),
        createdAt: optionalString(run.created_at),
        startedAt: optionalString(run.run_started_at),
        completedAt: status === "completed" ? optionalString(run.updated_at) : undefined,
        jobs,
        jobsCoverage,
    };
}

/** Maps one Actions job; `scope` is the run's workflow name when the job does not carry one. */
function toJob(job: GitHubWorkflowJob, scope: string): CiJob {
    const id = readId(job.id) ?? "";
    const name = readString(job.name) || id;
    return {
        id,
        logicalId: logicalCheckId({
            kind: "job",
            scope: readString(job.workflow_name) || scope,
            name,
        }),
        checkRunId: /\/check-runs\/(\d+)$/.exec(safePathname(readString(job.check_run_url)))?.[1],
        name,
        checkName: name,
        state: mapActionsState(readString(job.status), readString(job.conclusion)),
        url: optionalString(job.html_url),
        startedAt: optionalString(job.started_at),
        completedAt: optionalString(job.completed_at),
        attempt: optionalNumber(job.run_attempt),
        steps: (Array.isArray(job.steps) ? (job.steps as GitHubWorkflowStep[]) : []).map(toStep),
    };
}

/**
 * A failed job with its check run's failure text. Matched by the check-run id from the job's
 * `check_run_url`: the Actions job id names another object and may equal an unrelated check run's.
 */
function withFailureSummary(job: CiJob, summaries: ReadonlyMap<string, string>): CiJob {
    if (job.state !== "failure" || job.checkRunId === undefined) return job;
    const failureSummary = summaries.get(job.checkRunId);
    return failureSummary === undefined ? job : { ...job, failureSummary };
}

/** A check run's output title and summary, cleaned and cut; undefined when it has neither. */
function checkRunSummary(run: GitHubCheckRun): string | undefined {
    const output = (run.output && typeof run.output === "object" ? run.output : {}) as {
        title?: unknown;
        summary?: unknown;
    };
    const parts = [readString(output.title), readString(output.summary)].filter(Boolean);
    return cleanFailureSummary(parts.join("\n"));
}

function toStep(step: GitHubWorkflowStep): CiStep {
    return {
        number: optionalNumber(step.number) ?? 0,
        name: readString(step.name),
        state: mapActionsState(readString(step.status), readString(step.conclusion)),
        startedAt: optionalString(step.started_at),
        completedAt: optionalString(step.completed_at),
    };
}

/** Maps an Actions run, job or step `status` and `conclusion` to the shared CI state. */
function mapActionsState(status: string, conclusion: string): CiState {
    switch (status) {
        case "in_progress":
            return "running";
        case "queued":
        case "waiting":
        case "requested":
        case "pending":
            return "queued";
        case "completed":
            break;
        default:
            return "unknown";
    }
    switch (conclusion) {
        case "success":
        case "cancelled":
        case "skipped":
        case "neutral":
            return conclusion;
        case "failure":
        case "timed_out":
        case "startup_failure":
        case "action_required":
            return "failure";
        default:
            return "unknown";
    }
}

function readList<T>(body: unknown, field: string): T[] {
    if (!body || typeof body !== "object") return [];
    const list = (body as Record<string, unknown>)[field];
    return Array.isArray(list) ? (list as T[]) : [];
}

/** A numeric or string API id as a string; GitHub ids exceed 2^31 but stay exact doubles. */
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

function totalCount(body: unknown): number | undefined {
    return optionalNumber((body as { total_count?: unknown } | null)?.total_count);
}

/** The URL a request actually sends: normalized, without the fragment. */
function requestedUrl(url: string): string {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
}

function safePathname(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return "";
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
        // Serial by GitHub's own instruction: concurrent requests from one user or client id
        // trip the secondary rate limit, which answers 403 and costs the whole fetch. A page
        // count in the low single digits is not worth trading that for.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
        // Serial for the same reason as the check-runs pager above: GitHub's secondary rate
        // limit penalises concurrent requests from one client, and the docstring's "each
        // sequential page request" is this line.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
        id: readId(run.id),
        name: readString(run.name) || vscode.l10n.t("GitHub check"),
        description: compactText(summary || title || readString(run.status)),
        state: mapCheckRunState(readString(run.status), readString(run.conclusion)),
        source: "check-run",
        url: readString(run.html_url) || readString(run.details_url) || undefined,
    };
}

function toStatusItem(status: GitHubStatus): CommitCheckItem {
    return {
        id: optionalString(status.context),
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
