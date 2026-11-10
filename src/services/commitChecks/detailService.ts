// Shared CI detail cache, a sibling of CommitChecksService with the same L1, in-flight,
// generation, per-key fence and persistence pattern. Kept separate on purpose so the
// persisted snapshot path does not move for one new consumer; the tests mirror the
// snapshot service's generation and in-flight tests so the two cannot drift silently.

import { randomUUID } from "node:crypto";
import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import { hasUnfinishedWork, isCompleteDetail } from "../../shared/ci/completion";
import type { CiFailedScan, CiJob, CommitCiDetail, CommitCiDetailData } from "../../types";
import type { CiActionFenceStore } from "./ciActionFence";
import type { CiTrace, CiTraceOutcome, CiTraceReason } from "./ciTrace";
import type { CiDetailPersistentCache } from "./detailPersistentCache";
import type { PersistentWrite } from "./persistentCache";
import type { CommitChecksFetchOptions } from "./service";
import type { CiDetailFetch, CiFailedScanCursor, CiFailedScanPage } from "./types";

interface DetailEntry {
    data: CommitCiDetailData;
    fetchedAt: number;
    /** The store's clear generation the entry was read or fetched under. */
    storeGeneration: string | undefined;
    /** Failed-job overflow scans by run id; in memory only, never persisted. */
    scans?: Map<string, ScanState>;
}

/** Progress of one run's overflow scan; carried across refetches of the same run attempt. */
interface ScanState {
    cursor: CiFailedScanCursor;
    found: CiJob[];
    state: CiFailedScan["state"];
    error?: string;
    /** True while a page loop runs, so a refetch never starts a second one. */
    active: boolean;
    /** Another attempt's data was seen: the detail stays incomplete and the scan is never resumed. */
    remoteChanged?: true;
}

/** How the detail service reads overflow-scan pages for a key and tells the newest requester. */
export interface CiFailedScanHooks {
    readonly continueScan: (cursor: CiFailedScanCursor) => Promise<CiFailedScanPage>;
    /** False once the operation that asked may no longer publish. */
    readonly isCurrent: () => boolean;
    /** Receives the detail again after every scan page. */
    readonly onUpdate?: (detail: CommitCiDetail) => void;
}

/** The newest requester of a key: its scan hooks and where its detail is shown. */
interface ScanRequester {
    hooks: CiFailedScanHooks;
    serve: CiDetailServeContext;
}

/** This service's clear count, the key's invalidate count and the store's clear generation. */
type Generation = readonly [number, number, string | undefined];

/** What a read hands back before the read-time values are attached; never cached. */
type ServedDetailData = CommitCiDetailData & Pick<CommitCiDetail, "refreshError">;

/** Values attached to every served detail at read time, never cached. */
export interface CiDetailServeContext {
    readonly repoKey: string;
    /** From the installed provider object. */
    readonly capabilities: ProviderCiCapabilities;
}

/** Runtime and persistent detail cache tuning. */
export interface CommitCiDetailServiceOptions {
    /** TTL for incomplete details (including an incomplete failure or unknown settlement). */
    ttlMs?: number;
    /** TTL for no-check details. */
    noneTtlMs?: number;
    /** TTL for unavailable details. */
    unavailableTtlMs?: number;
    /** Maximum in-memory entries. */
    maxEntries?: number;
    /** Injectable clock for tests. */
    now?: () => number;
    /** Cross-session store for complete, fully covered details. */
    persistentCache?: CiDetailPersistentCache;
    /** Token-free diagnostic trace. */
    trace?: CiTrace;
    /**
     * Action fences: a fenced commit is served from L1 only with the pending TTL, every
     * fetched detail is checked for the action's evidence, the fence is attached, and the
     * commit is fetched again once its fence ends.
     */
    fences?: Pick<CiActionFenceStore, "isFenced" | "fenceFor" | "resolve" | "onDidEnd">;
}

/** Shared in-memory CI detail cache with in-flight de-dupe and a per-key fence. */
export class CommitCiDetailService {
    private readonly cache = new Map<string, DetailEntry>();
    private readonly inflight = new Map<string, Promise<ServedDetailData>>();
    // The newest requester's scan hooks per key, so each scan page reaches whoever shows it now.
    private readonly scanHooks = new Map<string, ScanRequester>();
    // Grows by one entry per invalidated key (a write action), never per fetch.
    private readonly keyGenerations = new Map<string, number>();
    // Keys whose saved copy invalidate() failed to delete: not read again until a window
    // reload, after which the old copy is readable again until the next save replaces it.
    private readonly undeletedSaves = new Set<string>();
    private readonly pendingTtlMs: number;
    private readonly noneTtlMs: number;
    private readonly unavailableTtlMs: number;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private readonly persistentCache?: CiDetailPersistentCache;
    private readonly trace?: CiTrace;
    private readonly fences?: CommitCiDetailServiceOptions["fences"];
    // False once a clear() failed: the store may still hold another account's entries.
    private persistentReadable = Promise.resolve(true);
    private generation = 0;
    // Fence ends seen so far, and the count at each commit's latest end (one per action).
    private fenceEndCount = 0;
    private readonly fenceEnds = new Map<string, number>();
    // Commits whose stored entries may predate an ended action, with that end's count:
    // never read from the store until that end's removal succeeds.
    private readonly staleStored = new Map<string, number>();

    /**
     * Creates the shared detail cache.
     *
     * @param options - TTL, capacity, clock, persistence and trace overrides.
     */
    constructor(options: CommitCiDetailServiceOptions = {}) {
        this.pendingTtlMs = options.ttlMs ?? 30_000;
        this.noneTtlMs = options.noneTtlMs ?? 60 * 60 * 1000;
        this.unavailableTtlMs = options.unavailableTtlMs ?? 15 * 60 * 1000;
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1_000));
        this.now = options.now ?? Date.now;
        this.persistentCache = options.persistentCache;
        this.trace = options.trace;
        this.fences = options.fences;
        this.fences?.onDidEnd((hash) => this.fenceEnded(hash));
    }

    /**
     * Returns a cached detail or runs one shared fetch for the key, with the read-time
     * values attached.
     *
     * @param key - Detail cache key (`<snapshot key>#detail`).
     * @param fetchDetail - Fetcher invoked only on cache and in-flight miss. A rejection
     *   caches nothing and reaches every caller sharing the fetch.
     * @param serve - Capabilities and repository attached to the served detail.
     * @param options - `force` bypasses L1 and L2 but still joins a post-fence fetch.
     * @param confirm - Runs once a fetched detail is saved. A rejection removes exactly
     *   that saved detail from L1 and L2 (never a newer one) and reaches every caller
     *   sharing the fetch.
     * @param scan - Reads failed-job pages past the page bound for the cursors the fetch
     *   returns; the latest call's hooks receive every later scan page for the key.
     */
    async getOrFetch(
        key: string,
        fetchDetail: () => Promise<CiDetailFetch>,
        serve: CiDetailServeContext,
        options: CommitChecksFetchOptions = {},
        confirm?: () => Promise<void>,
        scan?: CiFailedScanHooks,
    ): Promise<CommitCiDetail> {
        if (scan) this.scanHooks.set(key, { hooks: scan, serve });
        const data = await this.getData(key, fetchDetail, serve, options, confirm);
        return attach(data, serve, this.fences?.fenceFor(serve.repoKey, data.hash));
    }

    private async getData(
        key: string,
        fetchDetail: () => Promise<CiDetailFetch>,
        serve: CiDetailServeContext,
        options: CommitChecksFetchOptions,
        confirm: (() => Promise<void>) | undefined,
    ): Promise<ServedDetailData> {
        const cached = this.cache.get(key);
        if (!options.force && cached && this.isFresh(cached) && this.isServable(cached)) {
            this.touch(key, cached);
            this.traceOutcome("hit-l1", cached.data, serve);
            this.startScans(key, cached, this.captureGeneration(key));
            return served(cached);
        }
        const inflight = this.inflight.get(key);
        if (inflight) return inflight;
        if (!options.force && this.persistentCache) {
            const readGeneration = this.captureGeneration(key);
            const readFenceEnds = this.fenceEndCount;
            const persisted = await this.getPersisted(key);
            // A read queued before invalidate() or clear() still sees the old entry, and a
            // fenced commit's stored entry may predate the action.
            if (
                persisted &&
                this.isCurrentGeneration(key, readGeneration) &&
                !this.fences?.isFenced(persisted.hash) &&
                !this.fenceEndedSince(persisted.hash, readFenceEnds) &&
                !this.staleStored.has(persisted.hash)
            ) {
                // A forced refresh that started or finished during the read is newer than the
                // saved copy; one still confirming its save is joined, never served early.
                const running = this.inflight.get(key);
                if (running) return running;
                const newer = this.cache.get(key);
                if (newer && newer !== cached) {
                    if (this.isFresh(newer) && this.isServable(newer)) {
                        this.traceOutcome("hit-l1", newer.data, serve);
                        this.startScans(key, newer, this.captureGeneration(key));
                        return served(newer);
                    }
                    // The newer entry expired while the read waited: fetch, never fall back.
                } else {
                    this.cache.set(key, {
                        data: persisted,
                        fetchedAt: this.now(),
                        storeGeneration: readGeneration[2],
                    });
                    this.evictOldest();
                    this.traceOutcome("hit-l2", persisted, serve);
                    return persisted;
                }
            }
        }
        const newerInflight = this.inflight.get(key);
        if (newerInflight) return newerInflight;
        const generation = this.captureGeneration(key);
        let fenceEnds = this.fenceEndCount;
        // A fence that ended during the fetch means the answer may predate the action.
        const isCurrent = (data: CommitCiDetailData): boolean =>
            this.isCurrentGeneration(key, generation) &&
            !this.fenceEndedSince(data.hash, fenceEnds);
        const request = fetchDetail()
            .then(async ({ scanCursors, ...data }): Promise<ServedDetailData> => {
                if (isCurrent(data)) {
                    // Ends the fences this detail shows took effect before the save below
                    // is queued (they leave memory synchronously); never rejects. This
                    // detail is the evidence, so the end it causes does not outdate it.
                    void this.fences?.resolve(serve.repoKey, data.hash, data);
                    fenceEnds = this.fenceEndCount;
                    const previous = this.cache.get(key);
                    if (
                        options.force &&
                        data.outcome === "unavailable" &&
                        previous &&
                        this.isServable(previous) &&
                        previous.data.outcome !== "unavailable"
                    ) {
                        // A failed refresh must not blank the tree: keep the earlier entry as is.
                        this.traceOutcome("failed", data, serve);
                        return { ...served(previous), refreshError: data.error ?? "" };
                    }
                    const entry: DetailEntry = {
                        data,
                        fetchedAt: this.now(),
                        storeGeneration: generation[2],
                        scans: carryScans(data, scanCursors, previous),
                    };
                    this.cache.set(key, entry);
                    this.evictOldest();
                    this.traceOutcome(
                        isCompleteDetail(data) ? "fetched" : "incomplete",
                        data,
                        serve,
                    );
                    // The write is queued before any later delete or clear, so it cannot land
                    // after one; a fence during it already dropped the L1 entry set above.
                    // With `confirm`, the save stays unreadable until it passes, so a failed
                    // removal after a rejection still leaves nothing readable.
                    const writeId = confirm ? randomUUID() : undefined;
                    const storageFailed = (): void =>
                        this.traceOutcome("failed", data, serve, "storage");
                    await this.persist(
                        key,
                        data,
                        entry.fetchedAt,
                        { generation: generation[2], id: writeId },
                        storageFailed,
                    );
                    await this.confirmSaved(key, entry, confirm, writeId, storageFailed);
                    if (isCurrent(data)) {
                        // A scan that finds its run changed must start a new fetch, not join this one.
                        if (this.inflight.get(key) === request) this.inflight.delete(key);
                        this.startScans(key, entry, generation);
                        return served(entry);
                    }
                }
                this.traceOutcome("discarded-generation", data, serve);
                // Another window's clear() leaves this request in the map; a retry must not join it.
                if (this.inflight.get(key) === request) this.inflight.delete(key);
                // invalidate() or clear() superseded this result: its callers get the newer one.
                return this.getData(key, fetchDetail, serve, options, confirm);
            })
            .finally(() => {
                if (this.inflight.get(key) === request) this.inflight.delete(key);
            });
        this.inflight.set(key, request);
        return request;
    }

    /**
     * Drops one key from L1, the in-flight map and the persistent store. A fetch that
     * started before this call neither caches its result nor is joined by a later one.
     *
     * @param key - Detail cache key.
     */
    async invalidate(key: string): Promise<void> {
        this.keyGenerations.set(key, (this.keyGenerations.get(key) ?? 0) + 1);
        this.cache.delete(key);
        this.inflight.delete(key);
        this.scanHooks.delete(key);
        try {
            await this.persistentCache?.delete(key);
        } catch (error) {
            this.undeletedSaves.add(key);
            throw error;
        }
    }

    /** Clears every detail after auth or settings changes; late results are dropped. */
    clear(): void {
        this.generation += 1;
        this.cache.clear();
        this.inflight.clear();
        this.scanHooks.clear();
        const clear = this.persistentCache?.clear();
        if (clear) {
            this.persistentReadable = clear.then(
                () => true,
                () => false,
            );
        }
    }

    /**
     * A commit's fence ended: what was fetched or saved while it was fenced may be the
     * pre-action answer (also one another window saved), so it is dropped and fetched again.
     * Returns the stored entries' removal; a rejection keeps the fence stored.
     */
    private fenceEnded(hash: string): Promise<void> | undefined {
        this.fenceEndCount += 1;
        this.fenceEnds.set(hash, this.fenceEndCount);
        for (const [key, entry] of this.cache) {
            if (entry.data.hash === hash) this.cache.delete(key);
        }
        const end = this.fenceEndCount;
        this.staleStored.set(hash, end);
        return this.persistentCache?.deleteHash(hash).then(
            () => {
                if (this.staleStored.get(hash) === end) this.staleStored.delete(hash);
            },
            (error: unknown) => {
                this.trace?.({ kind: "detail", outcome: "failed", reason: "storage", hash });
                throw error;
            },
        );
    }

    private fenceEndedSince(hash: string, count: number): boolean {
        return (this.fenceEnds.get(hash) ?? 0) > count;
    }

    // Another window's clear() bumps only the store's shared generation, not this service's.
    private captureGeneration(key: string): Generation {
        return [this.generation, this.keyGenerations.get(key) ?? 0, this.storeGeneration()];
    }

    private isCurrentGeneration(key: string, captured: Generation): boolean {
        const current = this.captureGeneration(key);
        return current.every((part, index) => part === captured[index]);
    }

    private storeGeneration(): string | undefined {
        return this.persistentCache?.generation();
    }

    /** False once a clear() in any window, visible here, came after the entry was stored. */
    private isServable(entry: DetailEntry): boolean {
        return entry.storeGeneration === this.storeGeneration();
    }

    private isFresh(entry: DetailEntry): boolean {
        const ageMs = this.now() - entry.fetchedAt;
        // A re-run or cancel the provider has not shown yet: any answer may be the old one.
        if (this.fences?.isFenced(entry.data.hash)) return ageMs < this.pendingTtlMs;
        // Judged on what is served: a scan can complete a detail whose stored data is not.
        if (isCompleteDetail(served(entry))) return true;
        if (entry.data.outcome === "none") return ageMs < this.noneTtlMs;
        if (entry.data.outcome === "unavailable") return ageMs < this.unavailableTtlMs;
        return ageMs < this.pendingTtlMs;
    }

    private touch(key: string, entry: DetailEntry): void {
        this.cache.delete(key);
        this.cache.set(key, entry);
    }

    private evictOldest(): void {
        while (this.cache.size > this.maxEntries) {
            const oldest = this.cache.keys().next().value;
            if (!oldest) return;
            this.cache.delete(oldest);
        }
    }

    private async getPersisted(key: string): Promise<CommitCiDetailData | undefined> {
        if (this.undeletedSaves.has(key)) return undefined;
        try {
            if (!(await this.persistentReadable)) return undefined;
            return await this.persistentCache?.get(key);
        } catch {
            return undefined;
        }
    }

    private async persist(
        key: string,
        data: CommitCiDetailData,
        fetchedAt: number,
        write: PersistentWrite,
        storageFailed: () => void,
    ): Promise<void> {
        try {
            await this.persistentCache?.set(key, data, fetchedAt, write);
        } catch {
            // A failed persistent write leaves the entry in L1 only.
            storageFailed();
        }
    }

    /**
     * Runs `confirm`. A pass makes the unconfirmed save readable; a rejection removes this
     * entry's own L1 and L2 writes and rethrows.
     */
    private async confirmSaved(
        key: string,
        entry: DetailEntry,
        confirm: (() => Promise<void>) | undefined,
        writeId: string | undefined,
        storageFailed: () => void,
    ): Promise<void> {
        if (!confirm || writeId === undefined) return;
        try {
            await confirm();
        } catch (error) {
            if (this.cache.get(key) === entry) this.cache.delete(key);
            try {
                await this.persistentCache?.delete(key, writeId);
            } catch {
                // The save stays unconfirmed, so it is never read.
            }
            throw error;
        }
        try {
            await this.persistentCache?.confirmWrite(key, writeId);
        } catch {
            // The save stays unconfirmed: a later fetch saves the detail again.
            storageFailed();
        }
    }

    /** Starts a page loop for each scan left running with none (new, or its requester left). */
    private startScans(key: string, entry: DetailEntry, generation: Generation): void {
        for (const scan of entry.scans?.values() ?? []) {
            if (!scan.active && scan.state === "running") void this.runScan(key, scan, generation);
        }
    }

    /**
     * Reads one failed-job page at a time while the scan's entry, run attempt, key generation
     * and requester stay current. A gate cooldown pauses until it ends; a changed run or attempt
     * stops for good; any other failure stops with found jobs and the cursor kept, so a refresh
     * resumes from there.
     */
    private async runScan(key: string, scan: ScanState, generation: Generation): Promise<void> {
        scan.active = true;
        try {
            while (scan.state === "running") {
                const requester = this.scanHooks.get(key);
                if (!requester?.hooks.isCurrent() || !this.isScanLive(key, scan, generation)) {
                    return;
                }
                // Serial by design: the gate paces the scan one page at a time (plan §3).
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                const page = await requester.hooks.continueScan(scan.cursor);
                // Read again: a newer request may have replaced the hooks during the await.
                const latest = this.scanHooks.get(key) ?? requester;
                // A stale requester's page is dropped; the cursor stays for the next request
                // but keeps the budget the page froze, so a later page cannot raise it.
                if (!latest.hooks.isCurrent() || !this.isScanLive(key, scan, generation)) {
                    const frozen = "next" in page ? page.next?.jobsTotal : undefined;
                    if (scan.cursor.jobsTotal === undefined && frozen !== undefined) {
                        scan.cursor = { ...scan.cursor, jobsTotal: frozen };
                    }
                    return;
                }
                const entry = this.cache.get(key) as DetailEntry;
                if ("runChanged" in page) {
                    // No automatic refetch, which a run re-run before every page would repeat
                    // without bound; the detail stays incomplete, so its next read starts over.
                    scan.state = "stopped";
                    scan.error = page.error;
                    scan.remoteChanged = true;
                    this.traceScan("failed", entry.data, requester.serve);
                } else if ("pausedUntil" in page) {
                    if (page.next) scan.cursor = page.next;
                    scan.state = "paused";
                    setTimeout(
                        () => {
                            if (
                                scan.state !== "paused" ||
                                !this.isScanLive(key, scan, generation)
                            ) {
                                return;
                            }
                            scan.state = "running";
                            void this.runScan(key, scan, generation);
                        },
                        Math.max(0, page.pausedUntil - this.now()),
                    );
                    this.traceScan("paused", entry.data, requester.serve);
                } else {
                    this.traceScan(applyPage(scan, page), entry.data, requester.serve);
                }
                latest.hooks.onUpdate?.(
                    attach(
                        served(entry),
                        latest.serve,
                        this.fences?.fenceFor(latest.serve.repoKey, entry.data.hash),
                    ),
                );
            }
        } finally {
            scan.active = false;
        }
    }

    /** The scan still belongs to the current entry for the key, under the same generation. */
    private isScanLive(key: string, scan: ScanState, generation: Generation): boolean {
        return (
            this.isCurrentGeneration(key, generation) &&
            this.cache.get(key)?.scans?.get(scan.cursor.runId) === scan
        );
    }

    private traceScan(
        outcome: CiTraceOutcome,
        data: CommitCiDetailData,
        serve: CiDetailServeContext,
    ): void {
        this.trace?.({
            kind: "scan",
            outcome,
            repoKey: serve.repoKey,
            provider: data.provider,
            hash: data.hash,
        });
    }

    private traceOutcome(
        outcome: "hit-l1" | "hit-l2" | "fetched" | "incomplete" | "discarded-generation" | "failed",
        data: CommitCiDetailData,
        serve: CiDetailServeContext,
        reason?: CiTraceReason,
    ): void {
        this.trace?.({
            kind: "detail",
            outcome,
            repoKey: serve.repoKey,
            provider: data.provider,
            hash: data.hash,
            ...(reason && { reason }),
        });
    }
}

/** Adds a read page's new failed jobs and next cursor to the scan; returns the trace outcome. */
function applyPage(
    scan: ScanState,
    page: Exclude<CiFailedScanPage, { pausedUntil: number } | { runChanged: true }>,
): CiTraceOutcome {
    if ("failed" in page) {
        const known = new Set(scan.found.map((job) => job.id));
        scan.found.push(...page.failed.filter((job) => !known.has(job.id)));
    }
    if (page.next) scan.cursor = page.next;
    if (page.error !== undefined) {
        scan.state = "stopped";
        scan.error = page.error;
        return "failed";
    }
    if (!("next" in page && page.next)) scan.state = "done";
    return "fetched";
}

/**
 * One scan per cursor. A scan of the same run id and attempt in the previous entry is carried
 * as the same object, keeping its found jobs and saved cursor; any other run starts afresh.
 */
function carryScans(
    data: CommitCiDetailData,
    cursors: readonly CiFailedScanCursor[] | undefined,
    previous: DetailEntry | undefined,
): Map<string, ScanState> | undefined {
    if (!cursors?.length) return undefined;
    const scans = new Map<string, ScanState>();
    for (const cursor of cursors) {
        if (!data.runs.some((run) => run.id === cursor.runId)) continue;
        const carried = previous?.scans?.get(cursor.runId);
        if (carried && !carried.remoteChanged && carried.cursor.runAttempt === cursor.runAttempt) {
            if (carried.state === "stopped") {
                carried.state = "running";
                delete carried.error;
            }
            scans.set(cursor.runId, carried);
        } else {
            scans.set(cursor.runId, { cursor, found: [], state: "running", active: false });
        }
    }
    return scans;
}

/**
 * The entry's detail with each scan's found jobs appended and its `failedScan` progress; a
 * found job's own check run leaves the flat checks, so each check-run id is shown once.
 */
function served(entry: DetailEntry): CommitCiDetailData {
    const scans = entry.scans;
    if (!scans) return entry.data;
    const foundCheckRunIds = new Set(
        [...scans.values()].flatMap((scan) => scan.found.flatMap((job) => job.checkRunId ?? [])),
    );
    const otherChecks = entry.data.otherChecks.filter(
        (check) =>
            check.source !== "check-run" ||
            check.id === undefined ||
            !foundCheckRunIds.has(check.id),
    );
    const runs = entry.data.runs.map((run) => {
        const scan = scans.get(run.id);
        if (!scan) return run;
        const shown = new Set(run.jobs.map((job) => job.id));
        const failedScan: CiFailedScan = {
            state: scan.state,
            found: scan.found.length,
            ...(scan.error !== undefined && { error: scan.error }),
        };
        return {
            ...run,
            jobs: [...run.jobs, ...scan.found.filter((job) => !shown.has(job.id))],
            failedScan,
        };
    });
    // A scan exists only for a failed run, so the failure-wins outcome cannot change. The
    // provider's own reason for an incomplete read (a re-run seen mid-read) still holds.
    return {
        ...entry.data,
        complete:
            entry.data.complete &&
            !hasUnfinishedWork(runs, otherChecks) &&
            ![...scans.values()].some((scan) => scan.remoteChanged),
        otherChecks,
        runs,
    };
}

/**
 * Attaches the read-time values; the cached object itself never carries them.
 *
 * @param data - The cached or fetched detail.
 * @param serve - Capabilities and repository.
 * @param actionFence - The commit's action fence in that repository, if any.
 */
export function attach(
    data: ServedDetailData,
    serve: CiDetailServeContext,
    actionFence?: CommitCiDetail["actionFence"],
): CommitCiDetail {
    return {
        ...data,
        capabilities: serve.capabilities,
        repoKey: serve.repoKey,
        ...(actionFence && { actionFence }),
    };
}
