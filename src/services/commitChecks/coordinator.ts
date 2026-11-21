// Coordinates commit-check providers for one repository. It resolves the active
// remote once per repository generation, builds a provider-scoped cache key, and
// delegates snapshot caching/de-dupe to the shared CommitChecksService and CI detail
// caching to the sibling CommitCiDetailService.

import * as vscode from "vscode";
import type { GitOps } from "../../git/operations";
import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import { isCompleteSnapshot } from "../../shared/ci/completion";
import type { CiHistory } from "../../shared/ci/history";
import type {
    CiAttemptHistory,
    CiRun,
    CiState,
    CommitChecksSnapshot,
    CommitCiDetail,
    CommitCiDetailData,
    ProviderId,
} from "../../types";
import { getErrorMessage } from "../../utils/errors";
import type { CiGenerations, CiOperationContext } from "./ciGenerations";
import { readCiHistory } from "./ciHistory";
import {
    changedSinceGreen,
    firstParentLine,
    type ChangedSinceGreen,
    type ChangedSinceGreenRequest,
    type LoadedCommit,
} from "./changedSinceGreen";
import { applyUsual, usualCacheKey } from "./ciTiming";
import { ciLogKey, type CiLogSource } from "./ciLogMemoryStore";
import type { CiTrace } from "./ciTrace";
import { attach, CommitCiDetailService, type CiFailedScanHooks } from "./detailService";
import { summaryForState, unavailableSnapshot } from "./normalize";
import {
    applyRequired,
    RequiredChecksCache,
    UNKNOWN_REQUIRED,
    type RequiredChecks,
} from "./requiredChecks";
import { CommitChecksService, type CommitChecksFetchOptions } from "./service";
import type {
    CiDetailFetch,
    CiLogJob,
    CommitChecksProvider,
    HostMap,
    ProviderRepoRef,
} from "./types";

/** The provider that serves a repository and its parsed repository reference. */
export interface ProviderMatch {
    provider: CommitChecksProvider;
    ref: ProviderRepoRef;
}

/** Where one job's log lives in the window's store and how to download it again. */
export interface CiLogTarget {
    key: string;
    source: CiLogSource;
}

/**
 * Tries per request when the signed-in account changes while a request runs. When every
 * try sees a change (an account that cannot be read gets a fresh `unresolved-` id on
 * every read), the caller gets an unavailable answer, never one of another account.
 */
const ACCOUNT_ATTEMPTS = 2;

/** A fetch finished under another account than the one its cache key was built for. */
class AccountChangedError extends Error {}

/**
 * The caller that started a shared fetch went stale before a provider request: nothing is
 * sent or cached. A caller that joined that fetch and is still live starts its own.
 */
class StaleCallerError extends Error {}

/** Fetch options with the caller's own liveness check, run again before any provider request. */
type LiveFetchOptions = CommitChecksFetchOptions & { isCurrent?: () => boolean };

/**
 * Default cache TTL for pending snapshots, aligned with the webview poll interval
 * (`PENDING_CHECK_REFRESH_MS`, 15s). Sub-poll bursts (scroll/re-render) serve cache while
 * the 15s poll still re-fetches; tunable host-side. `none` and `unavailable` use separate
 * `CommitChecksService` defaults. Tests pass an explicit `ttlMs`.
 */
export const DEFAULT_COMMIT_CHECKS_TTL_MS = 15_000;

/** How long an ancestor's attempt histories are reused by later badge requests. */
const ATTEMPT_HISTORY_TTL_MS = 60_000;

/** Tunable behavior for the coordinator; all fields default to the prior Phase-0 behavior. */
export interface CommitChecksCoordinatorOptions {
    /** When false, every request returns a none snapshot without touching the network. */
    enabled?: boolean;
    /** Per-provider toggle; a provider id mapped to false yields no badge for its remote. */
    providerEnabled?: Partial<Record<ProviderId, boolean>>;
    /**
     * Milliseconds a pending snapshot is served from L1 before a re-fetch. `none` and
     * `unavailable` use separate service options/defaults. Ignored when `service` is supplied.
     */
    ttlMs?: number;
    /** Injectable clock for tests; defaults to Date.now. */
    now?: () => number;
    /** Shared cache/de-dupe service; omitted tests get an instance-local service. */
    service?: CommitChecksService;
    /** Shared CI detail cache; omitted tests get an instance-local service. */
    detailService?: CommitCiDetailService;
    /** Content-affecting settings fingerprint included in the shared cache key. */
    settingsFingerprint?: string;
    /** Host-wide auth and lifecycle generations checked by detail requests. */
    generations?: CiGenerations;
    /** Token-free diagnostic trace for discarded detail requests. */
    trace?: CiTrace;
    /** E2E runs only: a seeded detail served for a commit instead of the provider's. */
    fixture?: (
        hash: string,
    ) => { detail: CommitCiDetailData; capabilities: ProviderCiCapabilities } | undefined;
}

/** The commit a "flaky n/m" line starts from, and the Git Log's loaded commits. */
interface CiHistoryLineRequest {
    hash: string;
    loaded: readonly LoadedCommit[];
}

/** Resolves the provider for a repository and delegates snapshots to the shared cache. */
export class CommitChecksCoordinator {
    private readonly enabled: boolean;
    private readonly providerEnabled: Partial<Record<ProviderId, boolean>>;
    private readonly service: CommitChecksService;
    private readonly detailService: CommitCiDetailService;
    private readonly settingsFingerprint: string;
    private readonly generations?: CiGenerations;
    private readonly trace?: CiTrace;
    private readonly fixture?: CommitChecksCoordinatorOptions["fixture"];
    private readonly requiredChecks: RequiredChecksCache;
    private readonly now: () => number;
    private readonly attemptReads = new Map<
        string,
        { at: number; read: Promise<CiAttemptHistory[]> }
    >();
    private resolvedProvider = false;
    private providerMatch: ProviderMatch | null = null;
    private providerGeneration = 0;
    // Shared by concurrent callers (the bounded viewport fan-out can start several
    // resolutions before the first settles) so only one findProviderMatch() search runs.
    // clearProviderResolution() must null this too, or a caller arriving after a
    // repository switch could be handed the PREVIOUS repository's still-settling search —
    // the exact staleness the generation guard below exists to prevent.
    private resolutionInFlight: Promise<ProviderMatch | null> | null = null;

    /**
     * Builds a coordinator over an ordered provider registry for one repository.
     *
     * @param gitOps - Active repository Git facade; remotes are read on every request.
     * @param providers - Ordered provider registry; first match wins for a given remote.
     * @param hostMap - Self-hosted host to provider-id overrides (empty for GitHub-only).
     * @param options - Feature/provider toggles and TTL clock; defaults preserve prior behavior.
     */
    constructor(
        private readonly gitOps: GitOps,
        private readonly providers: readonly CommitChecksProvider[],
        private readonly hostMap: HostMap = {},
        options: CommitChecksCoordinatorOptions = {},
    ) {
        this.enabled = options.enabled ?? true;
        this.providerEnabled = options.providerEnabled ?? {};
        this.service =
            options.service ?? new CommitChecksService({ ttlMs: options.ttlMs, now: options.now });
        this.detailService =
            options.detailService ??
            new CommitCiDetailService({ ttlMs: options.ttlMs, now: options.now });
        this.settingsFingerprint = options.settingsFingerprint ?? "-";
        this.generations = options.generations;
        this.trace = options.trace;
        this.fixture = options.fixture;
        this.requiredChecks = new RequiredChecksCache(options.now);
        this.now = options.now ?? Date.now;
    }

    /** Drops shared cached snapshots and details; called after credential/settings changes. */
    clear(): void {
        this.clearProviderResolution();
        this.service.clear();
        this.detailService.clear();
        this.requiredChecks.clear();
        this.attemptReads.clear();
    }

    /** Clears only the memoized provider/ref, preserving shared cached snapshots. */
    clearProviderResolution(): void {
        this.providerGeneration += 1;
        this.resolvedProvider = false;
        this.providerMatch = null;
        // Must drop the in-flight promise too: otherwise a caller arriving after this
        // switch would be handed the PREVIOUS repository's still-settling resolution
        // instead of starting a fresh one under the new generation.
        this.resolutionInFlight = null;
    }

    /**
     * Returns the snapshot for a commit, serving a fresh cache hit unless a forced refresh is set.
     *
     * @param hash - Full Git commit hash requested by a visible graph row.
     * @param options - Cache refresh controls, including forced cache-layer bypasses. Once
     *   `isCurrent` is false after an await, no provider request starts and the snapshot is
     *   the no-badge one.
     */
    async getChecks(hash: string, options: LiveFetchOptions = {}): Promise<CommitChecksSnapshot> {
        if (!this.enabled) {
            // Feature off: no badge, no remote resolution, no network. The webview also
            // never renders the button, so this is defense in depth.
            return this.noneSnapshot(hash);
        }
        const seeded = this.fixture?.(hash);
        if (seeded) {
            const { outcome, otherChecks, error, signInHost } = seeded.detail;
            return {
                hash,
                state: outcome,
                summary: summaryForState(outcome),
                items: otherChecks.map(
                    ({ id, logicalId, name, description, state, source, url }) => ({
                        id,
                        logicalId,
                        name,
                        description,
                        state,
                        // A snapshot has no build source; Bitbucket Server's live badge reports builds as statuses.
                        source: source === "build" ? ("status" as const) : source,
                        url,
                    }),
                ),
                ...(error === undefined ? {} : { error }),
                ...(signInHost === undefined ? {} : { signInHost }),
            };
        }
        return this.fetchFresh(hash, options);
    }

    /**
     * The snapshots a commit's checks are compared with: its first parent's and the default
     * branch tip's, both cache first; `origin/HEAD` is read for this request.
     *
     * @param parents - The commit's parent hashes, first parent first.
     * @param line - The commit and the Git Log's loaded commits: their first-parent line is
     *   read from the caches only, for "flaky n/m".
     */
    async ciHistory(parents: readonly string[], line?: CiHistoryLineRequest): Promise<CiHistory> {
        const history = await readCiHistory(
            {
                getChecks: (hash) => this.getChecks(hash),
                readDefaultBranch: () => this.gitOps.readDefaultBranch(),
            },
            parents,
        );
        if (!line) return history;
        // After the parent read, so the first parent just fetched is in the cache too.
        const ancestors = await Promise.all(
            firstParentLine(line.hash, line.loaded).map(async (hash) => {
                const [snapshot, detail] = await Promise.all([
                    this.cachedSnapshot(hash),
                    this.cachedDetail(hash, ""),
                ]);
                const items = snapshot && snapshot.state !== "unavailable" ? snapshot.items : null;
                // A cached detail that read its re-runs holds them; any other commit whose checks
                // are cached (detail never opened, or one that never read them, such as an
                // unavailable one) asks the provider (§9), so a job that failed then passed
                // there still counts and an unread answer stays unread.
                const attempts =
                    detail?.attemptHistory ?? (items ? await this.readAttemptHistory(hash) : []);
                return {
                    hash,
                    items,
                    ...(items && snapshot?.partial && { partial: true as const }),
                    attempts: attempts ?? [],
                    ...(attempts === null && { attemptsUnavailable: true as const }),
                };
            }),
        );
        return { ...history, line: ancestors };
    }

    /**
     * The newest first-parent ancestor inside the loaded commits where a failed job passed,
     * and the files changed since (PLAN.md §14). Snapshots and the selected commit's detail
     * are read from the caches only: nothing here sends a request. `undefined` when checks
     * are off. A git failure rejects.
     *
     * @param request - The job, the selected commit and the Git Log's loaded commits.
     * @param repoKey - The repository the Checks tab asks about.
     */
    async changedSinceGreen(
        request: ChangedSinceGreenRequest,
        repoKey: string,
    ): Promise<ChangedSinceGreen | undefined> {
        if (!this.enabled) return undefined;
        return changedSinceGreen(
            {
                cachedChecks: (hash) => this.cachedSnapshot(hash),
                cachedDetail: (hash) => this.cachedDetail(hash, repoKey),
                diffNameStatus: (from, to) => this.gitOps.diffNameStatus(from, to),
                diffNumstat: (from, to) => this.gitOps.diffNumstat(from, to),
            },
            request,
        );
    }

    /**
     * A commit's attempt histories from the provider, remembered briefly per account so repeated
     * badge requests share one read. Empty when the provider lists no re-runs; `null` (unread,
     * never an empty history) when the read failed or the account changed meanwhile. A failure
     * is not remembered, so the next request (Refresh) reads it again.
     */
    private async readAttemptHistory(hash: string): Promise<CiAttemptHistory[] | null> {
        const providerGeneration = this.providerGeneration;
        try {
            const match = await this.resolveEnabledMatch();
            if (!match?.provider.capabilities.attemptHistory) return [];
            const { provider, ref } = match;
            if (!provider.getAttemptHistory) return [];
            const key = this.snapshotKey(match, await this.readAccount(match), hash);
            const now = this.now();
            const kept = this.attemptReads.get(key);
            let read = kept && now - kept.at < ATTEMPT_HISTORY_TTL_MS ? kept.read : undefined;
            if (!read) {
                const fresh = provider.getAttemptHistory(ref, hash);
                this.attemptReads.set(key, { at: now, read: fresh });
                fresh.catch(() => {
                    if (this.attemptReads.get(key)?.read === fresh) this.attemptReads.delete(key);
                });
                read = fresh;
            }
            const answer = await read;
            return providerGeneration === this.providerGeneration ? answer : null;
        } catch {
            return null;
        }
    }

    /**
     * A commit's cached snapshot (L1, then L2), or `undefined`; never asks the provider. An
     * E2E-seeded commit is served from its fixture, which sends nothing either.
     */
    private cachedSnapshot(hash: string): Promise<CommitChecksSnapshot | undefined> {
        if (this.fixture?.(hash)) return this.getChecks(hash);
        return this.fromCache((key) => this.service.getCached(key), hash);
    }

    /** A commit's cached detail (L1, then L2), or `undefined`; never asks the provider. */
    private async cachedDetail(
        hash: string,
        repoKey: string,
    ): Promise<CommitCiDetailData | undefined> {
        const seeded = this.fixture?.(hash);
        if (seeded) return seeded.detail;
        return this.fromCache(
            (key, match) =>
                this.detailService.getCached(`${key}#detail`, {
                    repoKey,
                    capabilities: match.provider.capabilities,
                }),
            hash,
        );
    }

    /** Reads a commit's cache entry under the signed-in account; `undefined` on a miss. */
    private async fromCache<T>(
        read: (key: string, match: ProviderMatch) => Promise<T>,
        hash: string,
    ): Promise<T | undefined> {
        try {
            const match = await this.resolveEnabledMatch();
            if (!match) return undefined;
            return await read(this.snapshotKey(match, await this.readAccount(match), hash), match);
        } catch {
            return undefined;
        }
    }

    /**
     * Returns the CI detail for a commit with the provider's capabilities attached, or
     * undefined when no enabled provider serves this repository (feature off, provider
     * off, no matching remote, or the remotes could not be read).
     *
     * @param hash - Full Git commit hash.
     * @param options - `force` bypasses the detail caches (and the snapshot caches for a
     *   provider without its own detail). `isCurrent` is the caller's own liveness check: once
     *   it is false after an await, no provider request starts and the result is undefined.
     * @param ctx - Context captured when the operation started. A sign-in change, a CI
     *   settings change, a closed repository or a repository switch after it was captured
     *   also yields undefined, so the caller publishes nothing.
     * @param onScanUpdate - Receives the detail again after each failed-job overflow scan
     *   page, while this is the newest request for the commit and `ctx` is still current.
     */
    async getDetail(
        hash: string,
        options: LiveFetchOptions,
        ctx: CiOperationContext,
        onScanUpdate?: (detail: CommitCiDetail) => void,
    ): Promise<CommitCiDetail | undefined> {
        if (!this.enabled) return undefined;
        const seeded = this.fixture?.(hash);
        if (seeded)
            return { ...seeded.detail, capabilities: seeded.capabilities, repoKey: ctx.repoKey };
        const providerGeneration = this.providerGeneration;
        const live = (): boolean =>
            this.isCurrent(ctx, providerGeneration) && options.isCurrent?.() !== false;
        let match: ProviderMatch | null;
        try {
            match = await this.resolveEnabledMatch();
        } catch {
            return undefined;
        }
        if (!live()) return this.discard(ctx, hash);
        if (!match) return undefined;
        const { provider, ref } = match;
        const getDetail = provider.getDetail?.bind(provider);
        const fetchDetail = getDetail
            ? async (): Promise<CiDetailFetch> => {
                  try {
                      return await getDetail(ref, hash, ctx);
                  } catch (err) {
                      return floorDetail(
                          unavailableSnapshot(hash, getErrorMessage(err)),
                          provider.id,
                      );
                  }
              }
            : async (): Promise<CiDetailFetch> =>
                  floorDetail(await this.fetchSnapshot(match, hash, options), provider.id);
        const serve = { repoKey: ctx.repoKey, capabilities: provider.capabilities };
        const continueFailedScan = provider.continueFailedScan?.bind(provider);
        const unavailable = (error: string): CommitCiDetail =>
            attach(floorDetail(unavailableSnapshot(hash, error), provider.id), serve);
        // The detail and its required marks are read and published under one account: a switch
        // anywhere in between starts both over, so no account's rule marks another's detail.
        const marked = await this.withAccount(
            match,
            fetchDetail,
            async (account, checkedFetch, confirm) => {
                // The account read was awaited: a caller gone stale meanwhile sends nothing.
                if (!live()) return undefined;
                // Read beside the detail and applied at serve time, so the detail cache never holds it.
                const required = this.readRequired(match, account, confirm, live);
                const markRequired = (
                    served: CommitCiDetail,
                    rule: Awaited<typeof required>,
                ): CommitCiDetail =>
                    rule
                        ? applyRequired(
                              served,
                              rule.checks,
                              rule.defaultBranchUnknown,
                              rule.defaultBranch,
                          )
                        : served;
                // Each update holds every page found so far, so only the newest one is
                // published; an older one whose rule read finished late would hide later jobs.
                let newestUpdate = 0;
                const scan: CiFailedScanHooks | undefined = continueFailedScan && {
                    continueScan: async (cursor) => {
                        try {
                            return await continueFailedScan(ref, cursor, ctx);
                        } catch (err) {
                            return { error: getErrorMessage(err) };
                        }
                    },
                    isCurrent: () => this.isCurrent(ctx, providerGeneration),
                    onUpdate:
                        onScanUpdate &&
                        ((update) => {
                            const updateNumber = ++newestUpdate;
                            void (async () => {
                                // Re-read through the 1 h cache (K21), so an update after the hour
                                // carries the current rule, not the one the scan started with.
                                const rule = await this.readRequired(match, account, confirm, live);
                                const marked = markRequired(update, rule);
                                await confirm();
                                // No await from the account check to the publish, so the account
                                // just confirmed is the one that receives the update.
                                if (
                                    updateNumber !== newestUpdate ||
                                    !this.isCurrent(ctx, providerGeneration)
                                ) {
                                    return;
                                }
                                onScanUpdate(marked);
                            })().catch(() => undefined);
                        }),
                };
                const [detail, rule] = await Promise.all([
                    this.detailService.getOrFetch(
                        `${this.snapshotKey(match, account, hash)}#detail`,
                        async () => {
                            // The detail caches were read first: a caller gone stale meanwhile sends nothing.
                            if (!live()) throw new StaleCallerError();
                            return this.withUsual(
                                match,
                                account,
                                await checkedFetch(),
                                confirm,
                                live,
                            );
                        },
                        serve,
                        options,
                        confirm,
                        scan,
                    ),
                    required,
                ]);
                return markRequired(detail, rule);
            },
            unavailable,
        ).catch((err: unknown) => {
            if (err instanceof StaleCallerError) return null;
            throw err;
        });
        // Joined another caller's fetch that stopped: a caller still live starts its own.
        if (marked === null && live()) return this.getDetail(hash, options, ctx, onScanUpdate);
        if (!live()) return this.discard(ctx, hash, provider.id);
        return marked ?? undefined;
    }

    /**
     * The fetched detail with the usual duration of each run that is queued, running or has a
     * queued or running job, and of its jobs (K23), cached per selected run. A run whose lookup failed is left without one; only a change
     * of the signed-in account rejects.
     */
    private async withUsual(
        match: ProviderMatch,
        account: string | undefined,
        detail: CiDetailFetch,
        confirm: () => Promise<void>,
        live: () => boolean,
    ): Promise<CiDetailFetch> {
        const { provider, ref } = match;
        const getUsualDuration = provider.getUsualDuration?.bind(provider);
        if (!provider.capabilities.usualDuration || !getUsualDuration) return detail;
        const scope = provider.keyFor(ref);
        const runs: CiRun[] = [];
        for (const run of detail.runs) {
            // A failed run can still have a job going, and that job shows a usual duration too.
            const active = (state: CiState) => state === "queued" || state === "running";
            if (!active(run.state) && !run.jobs.some((job) => active(job.state))) {
                runs.push(run);
                continue;
            }
            // Each lookup is a request of its own: a caller gone stale sends no more.
            if (!live()) throw new StaleCallerError();
            try {
                // Serial, so a commit with many running runs never takes every gate slot at once.
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                const usual = await this.detailService.usualDurations.get(
                    usualCacheKey(account === undefined ? scope : `${scope}|${account}`, run),
                    async () => {
                        const found = await getUsualDuration(ref, run);
                        // A throw here is a rejected fetch, which the cache drops.
                        await confirm();
                        return found;
                    },
                );
                runs.push(applyUsual(run, usual));
            } catch (err) {
                if (err instanceof AccountChangedError) throw err;
                runs.push(run);
            }
        }
        return { ...detail, runs };
    }

    /**
     * The merge rule of the default branch, read fresh from `origin/HEAD` on every call and
     * cached per branch for an hour (K21, K22). Undefined for a provider that cannot read
     * one. Any failure is `unknown` and a transient one is not cached; only a change of the
     * signed-in account rejects (the caller's `withAccount` then starts over under the new one).
     *
     * @param match - The provider and repository the rule is read for.
     * @param account - The account the caller's attempt runs under; it partitions the cache.
     * @param confirm - Throws once the signed-in account is no longer `account`.
     */
    private async readRequired(
        match: ProviderMatch,
        account: string | undefined,
        confirm: () => Promise<void>,
        live: () => boolean,
    ): Promise<
        | { checks: RequiredChecks; defaultBranchUnknown: boolean; defaultBranch?: string }
        | undefined
    > {
        const { provider, ref } = match;
        const getRequiredChecks = provider.getRequiredChecks?.bind(provider);
        if (!provider.capabilities.requiredChecks || !getRequiredChecks) return undefined;
        try {
            const branch = await this.gitOps.readDefaultBranch();
            if (!branch) return { checks: UNKNOWN_REQUIRED, defaultBranchUnknown: true };
            // A switch during the Git read must not start the fetch: it would run as the new
            // account and be cached under the old account's key.
            await confirm();
            const scope = provider.keyFor(ref);
            const checks = await this.requiredChecks.get(
                account === undefined ? scope : `${scope}|${account}`,
                branch.name,
                async () => {
                    // The Git read and the account check were awaited: a caller gone stale sends nothing.
                    if (!live()) throw new StaleCallerError();
                    const rule = await getRequiredChecks(ref, branch.name);
                    // A throw here is a rejected fetch, which the cache drops.
                    await confirm();
                    return rule;
                },
            );
            return { checks, defaultBranchUnknown: false, defaultBranch: branch.name };
        } catch (err) {
            if (err instanceof AccountChangedError || err instanceof StaleCallerError) throw err;
            return { checks: UNKNOWN_REQUIRED, defaultBranchUnknown: false };
        }
    }

    /**
     * The store key and download record of one job's log in this repository. An E2E fixture's
     * log is keyed by the repository and served from the seeded text.
     *
     * @param hash - The commit the job ran for.
     * @param job - The job, with its run and attempt as the detail names them.
     * @param ctx - The operation's context; its repository is recorded with the source.
     * @returns Undefined when no enabled provider with logs serves the repository.
     */
    async ciLogTarget(
        hash: string,
        job: CiLogJob,
        ctx: CiOperationContext,
    ): Promise<CiLogTarget | undefined> {
        if (!this.enabled) return undefined;
        const { runId, jobId, attempt, failedStep } = job;
        const seeded = this.fixture?.(hash);
        if (seeded) {
            if (!seeded.capabilities.logs) return undefined;
            return {
                key: ciLogKey(`e2e:${ctx.repoKey}`, runId, jobId, attempt),
                source: {
                    repoKey: ctx.repoKey,
                    provider: seeded.detail.provider,
                    runId,
                    jobId,
                    attempt,
                    failedStep,
                },
            };
        }
        const match = await this.resolveEnabledMatch();
        if (!match?.provider.getJobLog || !match.provider.capabilities.logs) return undefined;
        return {
            key: ciLogKey(match.provider.keyFor(match.ref), runId, jobId, attempt),
            source: {
                repoKey: ctx.repoKey,
                provider: match.provider.id,
                ref: match.ref,
                runId,
                jobId,
                attempt,
                failedStep,
            },
        };
    }

    /**
     * Whether a detail operation may still publish: same auth and lifecycle generations,
     * and the coordinator still serves the repository it started for. The surface that
     * publishes also compares `ctx.repoKey` with the repository it shows.
     */
    private isCurrent(ctx: CiOperationContext, providerGeneration: number): boolean {
        if (providerGeneration !== this.providerGeneration) return false;
        return this.generations?.isCurrent(ctx, ctx.repoKey) ?? true;
    }

    /**
     * Captures the provider resolution a write action starts under and returns the check to run
     * right before it sends: false once the sign-in or CI settings changed, the provider
     * resolution was cleared (the repository switched), or the surface shows another repository.
     *
     * @param ctx - The operation's context.
     * @param currentRepoKey - The repository the surface shows now, read at each check.
     */
    actionGuard(ctx: CiOperationContext, currentRepoKey: () => string): () => boolean {
        const providerGeneration = this.providerGeneration;
        return () =>
            providerGeneration === this.providerGeneration &&
            (this.generations?.isCurrent(ctx, currentRepoKey()) ??
                ctx.repoKey === currentRepoKey());
    }

    private discard(ctx: CiOperationContext, hash: string, provider?: ProviderId): undefined {
        this.trace?.({
            kind: "detail",
            outcome: "discarded-generation",
            repoKey: ctx.repoKey,
            provider,
            hash,
        });
        return undefined;
    }

    /**
     * Drops the snapshot and the detail of one commit from every cache layer, so the
     * next fetch starts a new request and cannot bring an older result back.
     *
     * @param hash - Full Git commit hash.
     */
    async invalidate(hash: string): Promise<void> {
        const match = await this.resolveEnabledMatch();
        if (!match) return;
        const snapshotKey = this.snapshotKey(match, await this.readAccount(match), hash);
        // Both run even when one fails to delete its stored entry, so neither cache keeps
        // serving the dropped result in this window; the first failure is still reported.
        const results = await Promise.allSettled([
            this.service.invalidate(snapshotKey),
            this.detailService.invalidate(`${snapshotKey}#detail`),
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
    }

    /**
     * Drops only the detail of one commit, with its in-flight request, and keeps the
     * snapshot: the HEAD monitor's settlement fetch then starts after settlement.
     *
     * @param hash - Full Git commit hash.
     */
    async invalidateDetail(hash: string): Promise<void> {
        if (!this.enabled || this.fixture?.(hash)) return;
        const match = await this.resolveEnabledMatch();
        if (!match) return;
        const snapshotKey = this.snapshotKey(match, await this.readAccount(match), hash);
        await this.detailService.invalidate(`${snapshotKey}#detail`);
    }

    /**
     * Capabilities of the provider serving this commit (an E2E fixture's own), or
     * undefined when checks are off or no enabled provider matches. Throws when the
     * remotes cannot be read.
     *
     * @param hash - Full Git commit hash.
     */
    async capabilities(hash: string): Promise<ProviderCiCapabilities | undefined> {
        if (!this.enabled) return undefined;
        const seeded = this.fixture?.(hash);
        if (seeded) return seeded.capabilities;
        return (await this.resolveEnabledMatch())?.provider.capabilities;
    }

    /**
     * The request-gate bucket (provider id and a URL on its API origin) this repository's
     * requests go through, so the HEAD monitor pauses only for its own bucket. Undefined when
     * checks are off, for an E2E fixture (it sends nothing) or when no provider matches.
     * Throws when the remotes cannot be read.
     *
     * @param hash - Full Git commit hash.
     */
    async requestBucket(
        hash: string,
    ): Promise<{ providerId: ProviderId; url: string } | undefined> {
        if (!this.enabled || this.fixture?.(hash)) return undefined;
        const match = await this.resolveEnabledMatch();
        const url = match?.provider.apiUrl?.(match.ref);
        return match && url ? { providerId: match.provider.id, url } : undefined;
    }

    /**
     * The provider and repository a write action on this repository goes to, or null when
     * none applies (feature or provider off, no matching remote, or an E2E fixture, which
     * never sends a request). Throws when the remotes cannot be read.
     */
    async actionTarget(hash: string): Promise<ProviderMatch | null> {
        if (!this.enabled || this.fixture?.(hash)) return null;
        return this.resolveEnabledMatch();
    }

    /** Builds the no-badge snapshot used when the feature or matched provider is disabled. */
    private noneSnapshot(hash: string): CommitChecksSnapshot {
        return { hash, state: "none", summary: summaryForState("none"), items: [] };
    }

    /**
     * Resolves the provider-scoped key and delegates cache policy to the shared service.
     *
     * @param hash - Full Git commit hash requested by a visible graph row.
     * @param options - Cache-refresh intent forwarded unchanged to the shared service.
     */
    private async fetchFresh(
        hash: string,
        options: LiveFetchOptions,
    ): Promise<CommitChecksSnapshot> {
        const providerGeneration = this.providerGeneration;
        let match: ProviderMatch | null;
        try {
            match = await this.resolveEnabledMatch();
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
        if (!match) return this.noneSnapshot(hash);
        let snapshot: CommitChecksSnapshot | undefined;
        try {
            snapshot = await this.fetchSnapshot(match, hash, options);
        } catch (err) {
            if (!(err instanceof StaleCallerError)) throw err;
            // Joined another caller's fetch that stopped: a caller still live starts its own.
            if (options.isCurrent?.() !== false) return this.fetchFresh(hash, options);
        }
        // The repository changed during the fetch, or the caller went stale: this answer
        // belongs to the old state, and is dropped the same way a stale provider resolution is.
        if (!snapshot || providerGeneration !== this.providerGeneration) {
            this.trace?.({
                kind: "snapshot",
                outcome: "discarded-generation",
                provider: match.provider.id,
                hash,
            });
            return this.noneSnapshot(hash);
        }
        return snapshot;
    }

    /**
     * Resolves the provider for the current repository generation, or null when none
     * applies. Throws when the remotes cannot be read.
     */
    private async resolveEnabledMatch(): Promise<ProviderMatch | null> {
        const providerGeneration = this.providerGeneration;
        const match = await this.resolveProvider();
        // The repository changed while resolving: this match belongs to the old one.
        if (providerGeneration !== this.providerGeneration) return null;
        // No registered provider matched any remote (an unmapped self-hosted host, or
        // an unsupported forge). That is a configuration state, not a recoverable
        // error: yield no badge (state "none"), the same as a disabled provider. An
        // "unavailable" error badge here would be permanent — re-fetching can never
        // map the host — and the UI only hides "none".
        if (!match) return null;
        // Hard-stop: the origin-first matched provider is disabled. Yield no badge and
        // do NOT fall through to a later remote's enabled provider — the badge stays
        // tied to origin, not to whichever remote happens to be on.
        if (this.providerEnabled[match.provider.id] === false) return null;
        return match;
    }

    /**
     * Every cache key ends in the signed-in account, so saved results of another account,
     * including ones a failed clear left on disk, never match.
     */
    private snapshotKey(match: ProviderMatch, account: string | undefined, hash: string): string {
        const suffix = account === undefined ? "" : `|${account}`;
        return `${match.provider.keyFor(match.ref)}@${hash}:${this.settingsFingerprint}${suffix}`;
    }

    /** Reads the signed-in account now; never memoized, so a sign-in change applies at once. */
    private async readAccount(match: ProviderMatch): Promise<string | undefined> {
        return match.provider.accountKey?.(match.ref);
    }

    /**
     * Runs one cache operation under the account read now. `run` gets a fetcher that reads
     * the account again when `fetch` returns (a fenced re-ask included); if it changed,
     * that fetcher throws instead of returning, so nothing is stored under the old
     * account's key. `run` also gets `confirm`, which the cache calls once the answer is
     * saved: a change by then makes the cache remove that saved answer. The account is
     * read once more when `run` returns (a saved answer read from disk may finish after a
     * switch). Any change starts the operation over under the new account; when the tries
     * run out the caller gets `unavailable` and no try's answer stays saved.
     */
    private async withAccount<R, T>(
        match: ProviderMatch,
        fetch: () => Promise<R>,
        run: (
            account: string | undefined,
            checkedFetch: () => Promise<R>,
            confirm: () => Promise<void>,
        ) => Promise<T>,
        unavailable: (error: string) => T,
    ): Promise<T> {
        for (let attempt = 1; attempt <= ACCOUNT_ATTEMPTS; attempt += 1) {
            const account = await this.readAccount(match);
            const confirm = async (): Promise<void> => {
                if ((await this.readAccount(match)) !== account) throw new AccountChangedError();
            };
            const checkedFetch = async (): Promise<R> => {
                const result = await fetch();
                await confirm();
                return result;
            };
            try {
                const result = await run(account, checkedFetch, confirm);
                await confirm();
                return result;
            } catch (err) {
                if (!(err instanceof AccountChangedError)) throw err;
            }
        }
        return unavailable(vscode.l10n.t("The signed-in account changed during the request."));
    }

    private fetchSnapshot(
        match: ProviderMatch,
        hash: string,
        options: LiveFetchOptions,
    ): Promise<CommitChecksSnapshot> {
        const fetchChecks = async (): Promise<CommitChecksSnapshot> => {
            // The account and the caches were read first: a caller gone stale sends nothing.
            if (options.isCurrent?.() === false) throw new StaleCallerError();
            try {
                return await match.provider.getChecks(match.ref, hash);
            } catch (err) {
                return unavailableSnapshot(hash, getErrorMessage(err));
            }
        };
        return this.withAccount(
            match,
            fetchChecks,
            (account, checkedFetch, confirm) =>
                this.service.getOrFetch(
                    this.snapshotKey(match, account, hash),
                    checkedFetch,
                    options,
                    match.provider.id,
                    confirm,
                ),
            (error) => unavailableSnapshot(hash, error),
        );
    }

    private async resolveProvider(): Promise<ProviderMatch | null> {
        if (this.resolvedProvider) return this.providerMatch;
        if (this.resolutionInFlight) return this.resolutionInFlight;
        const generation = this.providerGeneration;
        const pending = this.findProviderMatch();
        this.resolutionInFlight = pending;
        try {
            const match = await pending;
            // A generation bump while the search above was in flight means the repository
            // changed mid-resolution: return this stale match to the caller (fetchFresh
            // already discards it) but do not memoize it as the current repository's answer.
            if (generation !== this.providerGeneration) return match;
            this.providerMatch = match;
            this.resolvedProvider = true;
            return match;
        } finally {
            if (this.resolutionInFlight === pending) this.resolutionInFlight = null;
        }
    }

    /** Origin-first, first-match remote search; no side effects — resolveProvider owns memoization. */
    private async findProviderMatch(): Promise<ProviderMatch | null> {
        const remotes = await this.gitOps.getRemotes();
        const ordered = remotes.includes("origin")
            ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
            : remotes;
        for (const remote of ordered) {
            // Remote matching is first-match semantics with origin priority.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const url = await this.gitOps.getRemoteUrl(remote);
            if (!url) continue;
            for (const provider of this.providers) {
                const ref = provider.match(url, this.hostMap);
                if (ref) return { provider, ref };
            }
        }
        return null;
    }
}

/**
 * Builds the flat detail of a provider without its own `getDetail`: no runs, every
 * snapshot item as a flat check, complete exactly when the snapshot is.
 */
function floorDetail(snapshot: CommitChecksSnapshot, provider: ProviderId): CommitCiDetailData {
    return {
        hash: snapshot.hash,
        provider,
        complete: isCompleteSnapshot(snapshot),
        outcome: snapshot.state,
        runs: [],
        runsCoverage: "full",
        otherChecks: snapshot.items.map((item) => ({
            id: item.id,
            logicalId: item.logicalId,
            name: item.name,
            description: item.description,
            state: item.state,
            source: item.source,
            url: item.url,
        })),
        // A snapshot names no reason for its unread remainder; "pageBound" is the usual one.
        otherChecksCoverage: snapshot.partial
            ? { reason: "pageBound", shown: snapshot.items.length }
            : "full",
        error: snapshot.error,
        signInHost: snapshot.signInHost,
    };
}
