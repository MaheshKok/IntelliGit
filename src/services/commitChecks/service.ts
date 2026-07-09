// Shared commit-check cache for all graph surfaces in one extension activation.
// Views still resolve their active repository, but snapshots and in-flight fetches
// are keyed globally so the same repo/SHA is fetched once.

import type { CommitChecksSnapshot } from "../../types";
import { isPendingCheckState } from "../../types";

/** One cached commit-check snapshot plus freshness bookkeeping. */
interface CacheEntry {
    snapshot: CommitChecksSnapshot;
    fetchedAt: number;
}

/** Runtime cache tuning; persistence is intentionally left for the next phase. */
export interface CommitChecksServiceOptions {
    /** TTL for pending/none/unavailable snapshots; terminal snapshots live until evicted. */
    ttlMs?: number;
    /** Maximum in-memory entries retained across repository switches. */
    maxEntries?: number;
    /** Injectable clock for tests. */
    now?: () => number;
}

/** Shared in-memory commit-check cache and in-flight request de-dupe. */
export class CommitChecksService {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly inflight = new Map<string, Promise<CommitChecksSnapshot>>();
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private generation = 0;

    /**
     * Creates the shared runtime cache.
     *
     * @param options - TTL, capacity, and clock overrides.
     */
    constructor(options: CommitChecksServiceOptions = {}) {
        this.ttlMs = options.ttlMs ?? 0;
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1_000));
        this.now = options.now ?? Date.now;
    }

    /**
     * Returns a cached snapshot or runs one shared fetch for the key.
     *
     * @param key - Provider/repo/settings/commit cache key.
     * @param fetchSnapshot - Fetcher invoked only on cache and in-flight miss.
     * @returns The cached or freshly fetched snapshot.
     */
    async getOrFetch(
        key: string,
        fetchSnapshot: () => Promise<CommitChecksSnapshot>,
    ): Promise<CommitChecksSnapshot> {
        const cached = this.cache.get(key);
        if (cached && this.isFresh(cached)) {
            this.touch(key, cached);
            return cached.snapshot;
        }
        const inflight = this.inflight.get(key);
        if (inflight) return inflight;
        const generation = this.generation;
        const request = fetchSnapshot()
            .then((snapshot) => {
                if (generation === this.generation) {
                    this.cache.set(key, { snapshot, fetchedAt: this.now() });
                    this.evictOldest();
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
    }

    private isFresh(entry: CacheEntry): boolean {
        const { state } = entry.snapshot;
        const nonTerminal = isPendingCheckState(state) || state === "unavailable";
        if (!nonTerminal) return true;
        return this.now() - entry.fetchedAt < this.ttlMs;
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
}
