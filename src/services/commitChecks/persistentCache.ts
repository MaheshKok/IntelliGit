// Persistent commit-check cache. This sits behind the shared runtime service
// and stores complete plus no-check snapshots, bounded by age and LRU size.

import { isCompleteSnapshot } from "../../shared/ci/completion";
import type { CommitChecksSnapshot } from "../../types";

const SCHEMA_VERSION = 1;
const DEFAULT_STORAGE_KEY = "intelligit.commitChecks.cache.v1";
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NONE_MAX_AGE_MS = 60 * 60 * 1000;

/** Minimal VS Code Memento shape used by the persistent cache. */
export interface CommitChecksPersistentState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

/** Persistent cache tuning for settled snapshots that survive extension restarts. */
export interface CommitChecksPersistentCacheOptions {
    /** Memento key used for the single cache payload. */
    storageKey?: string;
    /** Maximum persisted snapshots retained across sessions. */
    maxEntries?: number;
    /** Maximum age for persisted terminal snapshots. */
    maxAgeMs?: number;
    /** Maximum age for a persisted no-check snapshot. */
    noneMaxAgeMs?: number;
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

/** VS Code globalState-backed cache for terminal and no-check commit-check snapshots. */
export class CommitChecksPersistentCache {
    private readonly storageKey: string;
    private readonly maxEntries: number;
    private readonly maxAgeMs: number;
    private readonly noneMaxAgeMs: number;
    private readonly now: () => number;
    private operations: Promise<void> = Promise.resolve();

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
        this.noneMaxAgeMs = Math.max(
            0,
            Math.floor(options.noneMaxAgeMs ?? DEFAULT_NONE_MAX_AGE_MS),
        );
        this.now = options.now ?? Date.now;
    }

    /**
     * Returns a valid persisted snapshot and bumps its LRU timestamp.
     *
     * @param key - Composite provider/repo/commit/settings key.
     * @returns The persisted snapshot, or undefined on miss/expiry/corruption.
     */
    async get(key: string): Promise<CommitChecksSnapshot | undefined> {
        return this.enqueue(async () => {
            const payload = this.read();
            const entry = payload.entries.find((candidate) => candidate.key === key);
            if (!entry || !this.isUsable(entry)) return undefined;
            entry.lastAccessedAt = this.now();
            await this.write(this.trim(payload));
            return entry.snapshot;
        });
    }

    /**
     * Persists an eligible snapshot. An incomplete one (pending, or a failure with
     * running checks) removes any stored entry it supersedes, such as a rerun of a
     * settled commit; an unavailable one changes nothing.
     *
     * @param key - Composite provider/repo/commit/settings key.
     * @param snapshot - Snapshot returned by a provider.
     * @param fetchedAt - Fetch timestamp to preserve across sessions.
     */
    async set(key: string, snapshot: CommitChecksSnapshot, fetchedAt = this.now()): Promise<void> {
        if (!isPersistableSnapshot(snapshot)) {
            if (snapshot.state !== "unavailable") await this.delete(key);
            return;
        }
        await this.enqueue(async () => {
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
        });
    }

    /**
     * Removes one persisted snapshot, in order with every queued read and write.
     *
     * @param key - Composite provider/repo/commit/settings key.
     */
    async delete(key: string): Promise<void> {
        await this.enqueue(async () => {
            const payload = this.read();
            if (!payload.entries.some((entry) => entry.key === key)) return;
            await this.write({
                schemaVersion: SCHEMA_VERSION,
                entries: payload.entries.filter((entry) => entry.key !== key),
            });
        });
    }

    /**
     * Clears all persisted commit-check snapshots. Runs in the queue so a write queued
     * before it lands first and is wiped, never after. When removing the key fails, an
     * empty payload is written over it so a restart cannot read the old entries; the
     * clear still rejects so the caller fails closed for the session.
     */
    async clear(): Promise<void> {
        await this.enqueue(async () => {
            try {
                await this.state.update(this.storageKey, undefined);
            } catch (error) {
                await this.write({ schemaVersion: SCHEMA_VERSION, entries: [] });
                throw error;
            }
        });
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

    /** Serializes storage read-modify-write operations without poisoning later work after a failure. */
    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operations.then(operation, operation);
        this.operations = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
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
        if (!isPersistableSnapshot(entry.snapshot)) return false;
        const maxAgeMs = entry.snapshot.state === "none" ? this.noneMaxAgeMs : this.maxAgeMs;
        return this.now() - entry.fetchedAt <= maxAgeMs;
    }
}

/** Returns true for a complete snapshot or a no-check snapshot. */
export function isPersistableSnapshot(snapshot: CommitChecksSnapshot): boolean {
    return snapshot.state === "none" || isCompleteSnapshot(snapshot);
}

function isPayload(value: unknown): value is PersistedPayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as { schemaVersion?: unknown; entries?: unknown };
    return payload.schemaVersion === SCHEMA_VERSION && Array.isArray(payload.entries);
}
