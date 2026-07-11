// Shared commit-check cache for all graph surfaces in one extension activation.
// Views still resolve their active repository, but snapshots and in-flight fetches
// are keyed globally so the same repo/SHA is fetched once.

import type { CommitChecksSnapshot } from "../../types";
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
    private pendingPersistentClear = Promise.resolve();
    private generation = 0;

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
    }

    /**
     * Returns a cached snapshot or runs one shared fetch for the key.
     *
     * @param key - Provider/repo/settings/commit cache key.
     * @param fetchSnapshot - Fetcher invoked only on cache and in-flight miss.
     * @param options - Cache refresh controls, including forced L1/L2 bypasses.
     * @returns The cached or freshly fetched snapshot.
     */
    async getOrFetch(
        key: string,
        fetchSnapshot: () => Promise<CommitChecksSnapshot>,
        options: CommitChecksFetchOptions = {},
    ): Promise<CommitChecksSnapshot> {
        const cached = this.cache.get(key);
        if (!options.force && cached && this.isFresh(cached)) {
            this.touch(key, cached);
            return cached.snapshot;
        }
        const inflight = this.inflight.get(key);
        if (inflight) return inflight;
        if (!options.force && this.persistentCache) {
            const persisted = await this.getPersisted(key);
            if (persisted) {
                this.cache.set(key, { snapshot: persisted, fetchedAt: this.now() });
                this.evictOldest();
                return persisted;
            }
        }
        const newerInflight = this.inflight.get(key);
        if (newerInflight) return newerInflight;
        const generation = this.generation;
        const request = fetchSnapshot()
            .then(async (snapshot) => {
                if (generation === this.generation) {
                    const fetchedAt = this.now();
                    this.cache.set(key, { snapshot, fetchedAt });
                    this.evictOldest();
                    await this.persist(key, snapshot, fetchedAt);
                }
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

    /** Clears runtime snapshots and in-flight fetches after auth/settings changes. */
    clear(): void {
        this.generation += 1;
        this.cache.clear();
        this.inflight.clear();
        const clear = this.persistentCache?.clear();
        if (clear) {
            this.pendingPersistentClear = Promise.resolve(clear).catch(() => undefined);
        }
    }

    private isFresh(entry: CacheEntry): boolean {
        const { state } = entry.snapshot;
        const ageMs = this.now() - entry.fetchedAt;
        if (state === "pending") return ageMs < this.pendingTtlMs;
        if (state === "none") return ageMs < this.noneTtlMs;
        if (state === "unavailable") return ageMs < this.unavailableTtlMs;
        return true;
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
            await this.pendingPersistentClear;
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
