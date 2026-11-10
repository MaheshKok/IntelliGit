// Shared CI detail cache, a sibling of CommitChecksService with the same L1, in-flight,
// generation, per-key fence and persistence pattern. Kept separate on purpose so the
// persisted snapshot path does not move for one new consumer; the tests mirror the
// snapshot service's generation and in-flight tests so the two cannot drift silently.

import { randomUUID } from "node:crypto";
import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import { isCompleteDetail } from "../../shared/ci/completion";
import type { CommitCiDetail, CommitCiDetailData } from "../../types";
import type { CiTrace, CiTraceReason } from "./ciTrace";
import type { CiDetailPersistentCache } from "./detailPersistentCache";
import type { PersistentWrite } from "./persistentCache";
import type { CommitChecksFetchOptions } from "./service";

interface DetailEntry {
    data: CommitCiDetailData;
    fetchedAt: number;
    /** The store's clear generation the entry was read or fetched under. */
    storeGeneration: string | undefined;
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
}

/** Shared in-memory CI detail cache with in-flight de-dupe and a per-key fence. */
export class CommitCiDetailService {
    private readonly cache = new Map<string, DetailEntry>();
    private readonly inflight = new Map<string, Promise<ServedDetailData>>();
    // Grows by one entry per invalidated key (a write action), never per fetch.
    private readonly keyGenerations = new Map<string, number>();
    private readonly pendingTtlMs: number;
    private readonly noneTtlMs: number;
    private readonly unavailableTtlMs: number;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private readonly persistentCache?: CiDetailPersistentCache;
    private readonly trace?: CiTrace;
    // False once a clear() failed: the store may still hold another account's entries.
    private persistentReadable = Promise.resolve(true);
    private generation = 0;

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
     */
    async getOrFetch(
        key: string,
        fetchDetail: () => Promise<CommitCiDetailData>,
        serve: CiDetailServeContext,
        options: CommitChecksFetchOptions = {},
        confirm?: () => Promise<void>,
    ): Promise<CommitCiDetail> {
        return attach(await this.getData(key, fetchDetail, serve, options, confirm), serve);
    }

    private async getData(
        key: string,
        fetchDetail: () => Promise<CommitCiDetailData>,
        serve: CiDetailServeContext,
        options: CommitChecksFetchOptions,
        confirm: (() => Promise<void>) | undefined,
    ): Promise<ServedDetailData> {
        const cached = this.cache.get(key);
        if (!options.force && cached && this.isFresh(cached) && this.isServable(cached)) {
            this.touch(key, cached);
            this.traceOutcome("hit-l1", cached.data, serve);
            return cached.data;
        }
        const inflight = this.inflight.get(key);
        if (inflight) return inflight;
        if (!options.force && this.persistentCache) {
            const readGeneration = this.captureGeneration(key);
            const persisted = await this.getPersisted(key);
            // A read queued before invalidate() or clear() still sees the old entry.
            if (persisted && this.isCurrentGeneration(key, readGeneration)) {
                // A forced refresh that started or finished during the read is newer than the
                // saved copy; one still confirming its save is joined, never served early.
                const running = this.inflight.get(key);
                if (running) return running;
                const newer = this.cache.get(key);
                if (newer && newer !== cached) {
                    if (this.isFresh(newer) && this.isServable(newer)) {
                        this.traceOutcome("hit-l1", newer.data, serve);
                        return newer.data;
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
        const request = fetchDetail()
            .then(async (data): Promise<ServedDetailData> => {
                if (this.isCurrentGeneration(key, generation)) {
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
                        return { ...previous.data, refreshError: data.error ?? "" };
                    }
                    const entry = { data, fetchedAt: this.now(), storeGeneration: generation[2] };
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
                    if (this.isCurrentGeneration(key, generation)) return data;
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
        await this.persistentCache?.delete(key);
    }

    /** Clears every detail after auth or settings changes; late results are dropped. */
    clear(): void {
        this.generation += 1;
        this.cache.clear();
        this.inflight.clear();
        const clear = this.persistentCache?.clear();
        if (clear) {
            this.persistentReadable = clear.then(
                () => true,
                () => false,
            );
        }
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
        if (isCompleteDetail(entry.data)) return true;
        const ageMs = this.now() - entry.fetchedAt;
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

/** Attaches the read-time values; the cached object itself never carries them. */
export function attach(data: ServedDetailData, serve: CiDetailServeContext): CommitCiDetail {
    return { ...data, capabilities: serve.capabilities, repoKey: serve.repoKey };
}
