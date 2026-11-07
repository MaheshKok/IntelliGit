// Shared CI detail cache, a sibling of CommitChecksService with the same L1, in-flight,
// generation, per-key fence and persistence pattern. Kept separate on purpose so the
// persisted snapshot path does not move for one new consumer; the tests mirror the
// snapshot service's generation and in-flight tests so the two cannot drift silently.

import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import { isCompleteDetail } from "../../shared/ci/completion";
import type { CommitCiDetail, CommitCiDetailData } from "../../types";
import type { CiTrace } from "./ciTrace";
import type { CiDetailPersistentCache } from "./detailPersistentCache";
import type { CommitChecksFetchOptions } from "./service";

interface DetailEntry {
    data: CommitCiDetailData;
    fetchedAt: number;
}

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
    private readonly inflight = new Map<string, Promise<CommitCiDetailData>>();
    // Grows by one entry per invalidated key (a write action), never per fetch.
    private readonly keyGenerations = new Map<string, number>();
    private readonly pendingTtlMs: number;
    private readonly noneTtlMs: number;
    private readonly unavailableTtlMs: number;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private readonly persistentCache?: CiDetailPersistentCache;
    private readonly trace?: CiTrace;
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
     * @param fetchDetail - Fetcher invoked only on cache and in-flight miss; must not throw.
     * @param serve - Capabilities and repository attached to the served detail.
     * @param options - `force` bypasses L1 and L2 but still joins a post-fence fetch.
     */
    async getOrFetch(
        key: string,
        fetchDetail: () => Promise<CommitCiDetailData>,
        serve: CiDetailServeContext,
        options: CommitChecksFetchOptions = {},
    ): Promise<CommitCiDetail> {
        const cached = this.cache.get(key);
        if (!options.force && cached && this.isFresh(cached)) {
            this.touch(key, cached);
            this.traceOutcome("hit-l1", cached.data, serve);
            return attach(cached.data, serve);
        }
        const inflight = this.inflight.get(key);
        if (inflight) return attach(await inflight, serve);
        if (!options.force && this.persistentCache) {
            const readGeneration = this.captureGeneration(key);
            const persisted = await this.getPersisted(key);
            // A read queued before invalidate() or clear() still sees the old entry.
            if (persisted && this.isCurrentGeneration(key, readGeneration)) {
                this.cache.set(key, { data: persisted, fetchedAt: this.now() });
                this.evictOldest();
                this.traceOutcome("hit-l2", persisted, serve);
                return attach(persisted, serve);
            }
        }
        const newerInflight = this.inflight.get(key);
        if (newerInflight) return attach(await newerInflight, serve);
        const generation = this.captureGeneration(key);
        const request = fetchDetail()
            .then(async (data) => {
                if (this.isCurrentGeneration(key, generation)) {
                    const fetchedAt = this.now();
                    this.cache.set(key, { data, fetchedAt });
                    this.evictOldest();
                    this.traceOutcome(
                        isCompleteDetail(data) ? "fetched" : "incomplete",
                        data,
                        serve,
                    );
                    await this.persist(key, data, fetchedAt);
                } else {
                    this.traceOutcome("discarded-generation", data, serve);
                }
                return data;
            })
            .finally(() => {
                if (this.inflight.get(key) === request) this.inflight.delete(key);
            });
        this.inflight.set(key, request);
        return attach(await request, serve);
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
        void this.persistentCache?.clear().catch(() => undefined);
    }

    private captureGeneration(key: string): readonly [number, number] {
        return [this.generation, this.keyGenerations.get(key) ?? 0];
    }

    private isCurrentGeneration(key: string, captured: readonly [number, number]): boolean {
        const [generation, keyGeneration] = this.captureGeneration(key);
        return captured[0] === generation && captured[1] === keyGeneration;
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
            return await this.persistentCache?.get(key);
        } catch {
            return undefined;
        }
    }

    private async persist(key: string, data: CommitCiDetailData, fetchedAt: number): Promise<void> {
        try {
            await this.persistentCache?.set(key, data, fetchedAt);
        } catch {
            // A failed persistent write leaves the entry in L1 only.
        }
    }

    private traceOutcome(
        outcome: "hit-l1" | "hit-l2" | "fetched" | "incomplete" | "discarded-generation",
        data: CommitCiDetailData,
        serve: CiDetailServeContext,
    ): void {
        this.trace?.({
            kind: "detail",
            outcome,
            repoKey: serve.repoKey,
            provider: data.provider,
            hash: data.hash,
        });
    }
}

/** Attaches the read-time values; the cached object itself never carries them. */
function attach(data: CommitCiDetailData, serve: CiDetailServeContext): CommitCiDetail {
    return { ...data, capabilities: serve.capabilities, repoKey: serve.repoKey };
}
