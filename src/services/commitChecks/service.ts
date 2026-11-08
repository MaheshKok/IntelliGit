// Shared commit-check cache for all graph surfaces in one extension activation.
// Views still resolve their active repository, but snapshots and in-flight fetches
// are keyed globally so the same repo/SHA is fetched once.

import { isCompleteSnapshot } from "../../shared/ci/completion";
import type { CommitChecksSnapshot, ProviderId } from "../../types";
import type { CiTrace, CiTraceOutcome } from "./ciTrace";
import type { CommitChecksPersistentCache } from "./persistentCache";

/** One cached commit-check snapshot plus freshness bookkeeping. */
interface CacheEntry {
    snapshot: CommitChecksSnapshot;
    fetchedAt: number;
}

/** Runtime and persistent cache tuning. */
export interface CommitChecksServiceOptions {
    /** TTL for pending snapshots; preserved for existing callers. */
    ttlMs?: number;
    /** TTL for no-check snapshots before the provider is consulted again. */
    noneTtlMs?: number;
    /** TTL for unavailable snapshots before retrying a recoverable provider failure. */
    unavailableTtlMs?: number;
    /** Maximum in-memory entries retained across repository switches. */
    maxEntries?: number;
    /** Injectable clock for tests. */
    now?: () => number;
    /** Optional cross-session terminal and no-check snapshot cache. */
    persistentCache?: CommitChecksPersistentCache;
    /** Token-free diagnostic trace. */
    trace?: CiTrace;
}

/** Controls whether a commit-check request may use fresh cache snapshots. */
export interface CommitChecksFetchOptions {
    /** When true, bypasses fresh L1/L2 snapshots but retains in-flight de-duplication. */
    force?: boolean;
}

/** Shared in-memory commit-check cache and in-flight request de-dupe. */
export class CommitChecksService {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly inflight = new Map<string, Promise<CommitChecksSnapshot>>();
    private readonly pendingTtlMs: number;
    private readonly noneTtlMs: number;
    private readonly unavailableTtlMs: number;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private readonly persistentCache?: CommitChecksPersistentCache;
    private readonly trace?: CiTrace;
    // False once a clear() failed: the store may still hold another account's entries.
    private persistentReadable = Promise.resolve(true);
    private generation = 0;
    // Grows by one entry per invalidated key (a write action), never per fetch.
    private readonly keyGenerations = new Map<string, number>();

    /**
     * Creates the shared runtime cache.
     *
     * @param options - TTL, capacity, and clock overrides.
     */
    constructor(options: CommitChecksServiceOptions = {}) {
        this.pendingTtlMs = options.ttlMs ?? 30_000;
        this.noneTtlMs = options.noneTtlMs ?? 60 * 60 * 1000;
        this.unavailableTtlMs = options.unavailableTtlMs ?? 15 * 60 * 1000;
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1_000));
        this.now = options.now ?? Date.now;
        this.persistentCache = options.persistentCache;
        this.trace = options.trace;
    }

    /**
     * Returns a cached snapshot or runs one shared fetch for the key.
     *
     * @param key - Provider/repo/settings/commit cache key.
     * @param fetchSnapshot - Fetcher invoked only on cache and in-flight miss.
     * @param options - Cache refresh controls, including forced L1/L2 bypasses.
     * @param provider - Provider id written to the diagnostic trace.
     * @returns The cached or freshly fetched snapshot.
     */
    async getOrFetch(
        key: string,
        fetchSnapshot: () => Promise<CommitChecksSnapshot>,
        options: CommitChecksFetchOptions = {},
        provider?: ProviderId,
    ): Promise<CommitChecksSnapshot> {
        const trace = (outcome: CiTraceOutcome, hash: string, ms?: number): void =>
            this.trace?.({ kind: "snapshot", outcome, provider, hash, ms });
        const cached = this.cache.get(key);
        if (!options.force && cached && this.isFresh(cached)) {
            this.touch(key, cached);
            trace("hit-l1", cached.snapshot.hash);
            return cached.snapshot;
        }
        const inflight = this.inflight.get(key);
        if (inflight) return inflight;
        if (!options.force && this.persistentCache) {
            const readGeneration = this.captureGeneration(key);
            const persisted = await this.getPersisted(key);
            // A read queued before invalidate() or clear() still sees the old entry.
            if (persisted && this.isCurrentGeneration(key, readGeneration)) {
                this.cache.set(key, { snapshot: persisted, fetchedAt: this.now() });
                this.evictOldest();
                trace("hit-l2", persisted.hash);
                return persisted;
            }
        }
        const newerInflight = this.inflight.get(key);
        if (newerInflight) return newerInflight;
        const generation = this.captureGeneration(key);
        const startedAt = this.now();
        const request = fetchSnapshot()
            .then(async (snapshot): Promise<CommitChecksSnapshot> => {
                const ms = this.now() - startedAt;
                if (!this.isCurrentGeneration(key, generation)) {
                    trace("discarded-generation", snapshot.hash, ms);
                    // invalidate() or clear() superseded this result: its callers get the newer one.
                    return this.getOrFetch(key, fetchSnapshot, options, provider);
                }
                const fetchedAt = this.now();
                this.cache.set(key, { snapshot, fetchedAt });
                this.evictOldest();
                trace(isCompleteSnapshot(snapshot) ? "fetched" : "incomplete", snapshot.hash, ms);
                await this.persist(key, snapshot, fetchedAt);
                return snapshot;
            })
            .finally(() => {
                if (this.inflight.get(key) === request) {
                    this.inflight.delete(key);
                }
            });
        this.inflight.set(key, request);
        return request;
    }

    /**
     * Drops one key from L1, the in-flight map and the persistent store. A fetch that
     * started before this call neither caches its result nor is joined by a later one.
     *
     * @param key - Provider/repo/settings/commit cache key.
     */
    async invalidate(key: string): Promise<void> {
        this.keyGenerations.set(key, (this.keyGenerations.get(key) ?? 0) + 1);
        this.cache.delete(key);
        this.inflight.delete(key);
        await this.persistentCache?.delete(key);
    }

    /** Clears runtime snapshots and in-flight fetches after auth/settings changes. */
    clear(): void {
        this.generation += 1;
        this.cache.clear();
        this.inflight.clear();
        const clear = this.persistentCache?.clear();
        if (clear) {
            this.persistentReadable = Promise.resolve(clear).then(
                () => true,
                () => false,
            );
        }
    }

    private captureGeneration(key: string): readonly [number, number] {
        return [this.generation, this.keyGenerations.get(key) ?? 0];
    }

    private isCurrentGeneration(key: string, captured: readonly [number, number]): boolean {
        const [generation, keyGeneration] = this.captureGeneration(key);
        return captured[0] === generation && captured[1] === keyGeneration;
    }

    private isFresh(entry: CacheEntry): boolean {
        if (isCompleteSnapshot(entry.snapshot)) return true;
        const { state } = entry.snapshot;
        const ageMs = this.now() - entry.fetchedAt;
        if (state === "none") return ageMs < this.noneTtlMs;
        if (state === "unavailable") return ageMs < this.unavailableTtlMs;
        // Pending, including a failure whose other checks are still running.
        return ageMs < this.pendingTtlMs;
    }

    private touch(key: string, entry: CacheEntry): void {
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

    private async getPersisted(key: string): Promise<CommitChecksSnapshot | undefined> {
        if (!this.persistentCache) return undefined;
        try {
            if (!(await this.persistentReadable)) return undefined;
            return await this.persistentCache.get(key);
        } catch {
            return undefined;
        }
    }

    private async persist(
        key: string,
        snapshot: CommitChecksSnapshot,
        fetchedAt: number,
    ): Promise<void> {
        try {
            await this.persistentCache?.set(key, snapshot, fetchedAt);
        } catch {
            // Persistent cache failure must not break commit-check badges.
        }
    }
}
