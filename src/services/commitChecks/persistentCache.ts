// Persistent terminal commit-check cache. This sits behind the shared runtime
// service and stores only settled snapshots, bounded by age and LRU size.

import type { CommitChecksSnapshot, CommitCheckState } from "../../types";
import { isPendingCheckState } from "../../types";

const SCHEMA_VERSION = 1;
const DEFAULT_STORAGE_KEY = "intelligit.commitChecks.cache.v1";
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Minimal VS Code Memento shape used by the persistent cache. */
export interface CommitChecksPersistentState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

/** Persistent cache tuning. Defaults match the Phase 2 plan. */
export interface CommitChecksPersistentCacheOptions {
    /** Memento key used for the single cache payload. */
    storageKey?: string;
    /** Maximum terminal snapshots retained across sessions. */
    maxEntries?: number;
    /** Maximum age for persisted terminal snapshots. */
    maxAgeMs?: number;
    /** Injectable clock for tests. */
    now?: () => number;
}

interface PersistedCommitChecksEntry {
    key: string;
    snapshot: CommitChecksSnapshot;
    fetchedAt: number;
    lastAccessedAt: number;
    schemaVersion: number;
}

interface PersistedPayload {
    schemaVersion: number;
    entries: PersistedCommitChecksEntry[];
}

/** VS Code globalState-backed cache for terminal commit-check snapshots. */
export class CommitChecksPersistentCache {
    private readonly storageKey: string;
    private readonly maxEntries: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;

    /**
     * Creates a bounded persistent cache.
     *
     * @param state - VS Code globalState-compatible storage.
     * @param options - Storage key, age, capacity, and clock overrides.
     */
    constructor(
        private readonly state: CommitChecksPersistentState,
        options: CommitChecksPersistentCacheOptions = {},
    ) {
        this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
        this.maxAgeMs = Math.max(0, Math.floor(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
        this.now = options.now ?? Date.now;
    }

    /**
     * Returns a valid terminal snapshot and bumps its LRU timestamp.
     *
     * @param key - Composite provider/repo/commit/settings key.
     * @returns The persisted snapshot, or undefined on miss/expiry/corruption.
     */
    async get(key: string): Promise<CommitChecksSnapshot | undefined> {
        const payload = this.read();
        const entry = payload.entries.find((candidate) => candidate.key === key);
        if (!entry || !this.isUsable(entry)) return undefined;
        entry.lastAccessedAt = this.now();
        await this.write(this.trim(payload));
        return entry.snapshot;
    }

    /**
     * Persists a terminal snapshot; non-terminal states are ignored.
     *
     * @param key - Composite provider/repo/commit/settings key.
     * @param snapshot - Snapshot returned by a provider.
     * @param fetchedAt - Fetch timestamp to preserve across sessions.
     */
    async set(key: string, snapshot: CommitChecksSnapshot, fetchedAt = this.now()): Promise<void> {
        if (!isPersistentCommitCheckState(snapshot.state)) return;
        const payload = this.read();
        const entry: PersistedCommitChecksEntry = {
            key,
            snapshot,
            fetchedAt,
            lastAccessedAt: this.now(),
            schemaVersion: SCHEMA_VERSION,
        };
        const entries = payload.entries.filter((candidate) => candidate.key !== key);
        await this.write(
            this.trim({ schemaVersion: SCHEMA_VERSION, entries: [...entries, entry] }),
        );
    }

    /** Clears all persisted commit-check snapshots. */
    async clear(): Promise<void> {
        await this.state.update(this.storageKey, undefined);
    }

    private read(): PersistedPayload {
        const payload = this.state.get<unknown>(this.storageKey);
        if (!isPayload(payload)) return { schemaVersion: SCHEMA_VERSION, entries: [] };
        return {
            schemaVersion: SCHEMA_VERSION,
            entries: payload.entries.filter((entry) => this.isUsable(entry)),
        };
    }

    private async write(payload: PersistedPayload): Promise<void> {
        await this.state.update(this.storageKey, payload);
    }

    private trim(payload: PersistedPayload): PersistedPayload {
        const entries = payload.entries
            .filter((entry) => this.isUsable(entry))
            .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
            .slice(0, this.maxEntries);
        return { schemaVersion: SCHEMA_VERSION, entries };
    }

    private isUsable(entry: PersistedCommitChecksEntry): boolean {
        if (entry.schemaVersion !== SCHEMA_VERSION) return false;
        if (!isPersistentCommitCheckState(entry.snapshot.state)) return false;
        return this.now() - entry.fetchedAt <= this.maxAgeMs;
    }
}

/** Returns true for states safe to persist across sessions. */
export function isPersistentCommitCheckState(state: CommitCheckState): boolean {
    return !isPendingCheckState(state) && state !== "unavailable";
}

function isPayload(value: unknown): value is PersistedPayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as { schemaVersion?: unknown; entries?: unknown };
    return payload.schemaVersion === SCHEMA_VERSION && Array.isArray(payload.entries);
}
