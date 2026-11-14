// Provider seam for commit-check hosts. Each provider matches a Git remote URL to a
// repository reference and fetches a normalized snapshot for one commit hash. The
// coordinator owns remote resolution and caching; providers stay stateless and
// host-specific.

import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import type {
    CiAction,
    CiActionEvidence,
    CiJob,
    CommitChecksSnapshot,
    CommitCiDetailData,
    ProviderId,
} from "../../types";
import type { CiOperationContext } from "./ciGenerations";
import type { DownloadedText } from "./http";
import type { RequiredChecks } from "./requiredChecks";

export type { ProviderId } from "../../types";

/** Maps a self-hosted Git host (e.g. "git.acme.com") to the provider that serves it. */
export type HostMap = Record<string, ProviderId>;

/**
 * Opaque repository reference produced by a provider's `match` and consumed by its own
 * `getChecks`. The base only guarantees the host; each provider narrows it internally
 * (owner/repo, projectPath, workspace/repo, ...).
 */
export interface ProviderRepoRef {
    readonly host: string;
}

/**
 * Where the scan for failed jobs past the page bound continues.
 *
 * @public consumed by later CI tab phases.
 */
export interface CiFailedScanCursor {
    readonly runId: string;
    readonly runAttempt?: number;
    /**
     * GitLab: the pipeline's `updated_at` when the scan started. GitLab runs have no attempt, and
     * a retry rewrites the pipeline even when it fails again, so a different value discards the scan.
     */
    readonly runVersion?: string;
    /** The run's workflow name, the scope of a scanned job that does not name its own. */
    readonly runName: string;
    readonly url: string;
    /** Scan pages already read before `url`; a next link back to one of them is refused. */
    readonly read?: readonly string[];
    /** Jobs read before `url`; the scan stops once they reach the run's own job count. */
    readonly jobsRead?: number;
    /**
     * The run's job count as first read (GitLab: its failed-job count); fixed for the whole
     * scan, so no later page raises it. `null` means the first scan page was read and named
     * none, so the scan stays unbudgeted.
     */
    readonly jobsTotal?: number | null;
    /** Ids of the jobs the detail already shows; a scan that starts from page one skips them. */
    readonly listed?: readonly string[];
}

/**
 * One page of the failed-job overflow scan, the reason it could not be read, or the end of the
 * request gate's cooldown that refused it (the scan pauses until then, not a page failure).
 * A page whose next link was refused carries its failed jobs and the error that stops the scan.
 * A stop or pause may carry `next`: the same page's cursor with the job budget the request read
 * saved, where Refresh or the resume reads again.
 * `runChanged` means the run, or a job the page read, names another id or attempt than the
 * cursor's, or (GitLab) the pipeline is no longer `failed` or its `updated_at` no longer
 * matches `runVersion`: nothing is kept, and the scan stops with `error` until a read from scratch.
 *
 * @public consumed by later CI tab phases.
 */
export type CiFailedScanPage =
    | { readonly failed: CiJob[]; readonly next?: CiFailedScanCursor; readonly error?: string }
    | { readonly error: string; readonly next?: CiFailedScanCursor }
    | { readonly pausedUntil: number; readonly next?: CiFailedScanCursor }
    | { readonly runChanged: true; readonly error: string };

/**
 * What `getDetail` returns: the detail plus one scan cursor per failed run whose job list hit
 * the page bound. The detail service keeps the cursors in memory and never caches them.
 * `sessionOnly` marks a tree the provider cannot vouch for across a restart (it may mix two
 * attempts of a run): it is served from memory and never saved.
 */
export type CiDetailFetch = CommitCiDetailData & {
    readonly scanCursors?: readonly CiFailedScanCursor[];
    readonly sessionOnly?: true;
};

/** A commit-check host integration: detection plus per-commit fetch. */
export interface CommitChecksProvider {
    readonly id: ProviderId;
    /** What this provider can show or do; attached to every served detail at read time. */
    readonly capabilities: ProviderCiCapabilities;
    /** Returns a repo reference when this provider serves the remote, else null. */
    match(remoteUrl: string, hostMap: HostMap): ProviderRepoRef | null;
    /** Returns a stable provider-scoped repository identity for shared caching. */
    keyFor(ref: ProviderRepoRef): string;
    /**
     * Returns a token-free id of the account this provider signs in with for `ref`, so a
     * cached result is only ever served to the account that fetched it. A failed lookup
     * returns an id no other lookup shares. Must not throw.
     */
    accountKey?(ref: ProviderRepoRef): Promise<string>;
    /** Fetches and normalizes the check snapshot for one commit hash. Must not throw. */
    getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot>;
    /**
     * Fetches the run, job and step detail for one commit. Must not throw: failures are
     * an `unavailable` outcome. Absent = the coordinator builds a flat detail from the
     * snapshot.
     */
    getDetail?(ref: ProviderRepoRef, hash: string, ctx: CiOperationContext): Promise<CiDetailFetch>;
    /** Reads the next page of failed jobs past the page bound. Must not throw. */
    continueFailedScan?(
        ref: ProviderRepoRef,
        cursor: CiFailedScanCursor,
        ctx: CiOperationContext,
    ): Promise<CiFailedScanPage>;
    /** Continuation guard: true only for a next-page URL under this provider's API base. */
    allowNext?(ref: ProviderRepoRef, url: string): boolean;
    /**
     * Reads which checks must pass before a merge into `branch`. A refusal or a missing
     * setting is a `partial` or `unknown` status; a transient failure (network, server error,
     * rate limit) rejects, so nothing is cached for it.
     */
    getRequiredChecks?(ref: ProviderRepoRef, branch: string): Promise<RequiredChecks>;
    /**
     * The evidence rule that ends an action's fence, stored with the fence when the action
     * starts. Absent = `cancelled` for cancel; re-run actions need it.
     */
    actionEvidence?(action: CiAction): CiActionEvidence;
    /**
     * Sends one write action. Refuses with `RequestGateCooldownError` while the request's
     * bucket cools down and with an `HttpError` 401 when signed out, both before `beforeSend`;
     * once the request gate admits the request, awaits `beforeSend` (the action fence; a
     * rejection sends nothing) and sends one request, never retried. Rejects with the
     * response's `HttpError`, or another error when the request may have reached the provider.
     */
    runAction?(
        ref: ProviderRepoRef,
        request: CiActionRequest,
        beforeSend: () => Promise<void>,
    ): Promise<void>;
    /** How this provider marks the error lines of its logs; the generic fallback when absent. */
    readonly firstErrorPatterns?: readonly RegExp[];
    /** Text before the step name on a step's start line in this provider's logs. */
    readonly stepStartPrefix?: string;
    /**
     * Downloads one finished job's log, at most 50 MB (O2). Rejects on failure; an `HttpError`
     * 401 or 403 means the credential cannot read the log.
     */
    getJobLog?(ref: ProviderRepoRef, job: CiLogJob, signal: AbortSignal): Promise<DownloadedText>;
}

/** A write action on one run, or on one job of it (`rerunJob`); ids as the detail names them. */
export interface CiActionRequest {
    readonly action: CiAction;
    readonly runId: string;
    /** Set for `rerunJob` only. */
    readonly jobId?: string;
}

/** The job whose log is downloaded; ids as the detail names them. */
export interface CiLogJob {
    readonly runId: string;
    readonly jobId: string;
    readonly attempt?: number;
    /** Name of the job's first failed step; the error-word fallback searches after it. */
    readonly failedStep?: string;
}
