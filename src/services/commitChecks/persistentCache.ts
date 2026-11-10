// Persistent commit-check cache. This sits behind the shared runtime service
// and stores complete plus no-check snapshots, bounded by age and LRU size.

import { randomUUID } from "node:crypto";
import { isCompleteSnapshot } from "../../shared/ci/completion";
import { isCommitChecksSnapshot } from "../../shared/ci/persistedShape";
import type { CommitChecksSnapshot } from "../../types";
import type { CiActionFenceView } from "./ciActionFence";

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
    /** Action fences: a fenced commit's snapshot is never written. */
    fence?: CiActionFenceView;
}

interface PersistedCommitChecksEntry {
    key: string;
    snapshot: CommitChecksSnapshot;
    fetchedAt: number;
    lastAccessedAt: number;
    schemaVersion: number;
}

/** Write id of each key whose saved entry is not yet confirmed; such an entry is a miss. */
export type UnconfirmedWrites = Record<string, string>;

interface PersistedPayload {
    schemaVersion: number;
    entries: PersistedCommitChecksEntry[];
    unconfirmed: UnconfirmedWrites;
    /** Clear generation the payload was read under and is written with; see {@link clearGenerationKey}. */
    generation: string | undefined;
}

/** What a write carries from the moment its fetch started. */
export interface PersistentWrite {
    /** The store's `generation()` when the fetch started; a clear since then refuses the write. */
    generation: string | undefined;
    /**
     * Marks the entry unconfirmed under this id: it stays a miss, also after a restart, until
     * `confirmWrite(key, id)`, and `delete(key, id)` removes it only while it is this write.
     */
    id?: string;
}

/**
 * Memento key of a store's clear generation. Every window shares globalState, but each
 * orders only its own writes, so a write another window started before a clear can land
 * after it. `clear()` stores a new generation and a payload stamped with any other is a miss.
 */
export function clearGenerationKey(storageKey: string): string {
    return `${storageKey}.generation`;
}

/** VS Code globalState-backed cache for terminal and no-check commit-check snapshots. */
export class CommitChecksPersistentCache {
    private readonly storageKey: string;
    private readonly maxEntries: number;
    private readonly maxAgeMs: number;
    private readonly noneMaxAgeMs: number;
    private readonly now: () => number;
    private readonly fence?: CiActionFenceView;
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
        this.fence = options.fence;
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
            if (!entry || Object.hasOwn(payload.unconfirmed, key) || !this.isUsable(entry)) {
                return undefined;
            }
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
     * @param write - The fetch's start generation and an optional unconfirmed-write id.
     */
    async set(
        key: string,
        snapshot: CommitChecksSnapshot,
        fetchedAt = this.now(),
        write?: PersistentWrite,
    ): Promise<void> {
        if (!isPersistableSnapshot(snapshot)) {
            if (snapshot.state !== "unavailable") await this.delete(key);
            return;
        }
        await this.enqueue(async () => {
            // Checked here, not when queued: a fence begun while this write waited refuses it.
            if (this.fence?.isFenced(snapshot.hash)) return;
            const payload = this.read();
            // A clear in any window since the fetch started outdates this answer.
            if (write && write.generation !== payload.generation) return;
            const entry: PersistedCommitChecksEntry = {
                key,
                snapshot,
                fetchedAt,
                lastAccessedAt: this.now(),
                schemaVersion: SCHEMA_VERSION,
            };
            const entries = payload.entries.filter((candidate) => candidate.key !== key);
            await this.write(
                this.trim({
                    schemaVersion: SCHEMA_VERSION,
                    entries: [...entries, entry],
                    unconfirmed: markUnconfirmed(payload.unconfirmed, key, write?.id),
                    generation: payload.generation,
                }),
            );
        });
    }

    /**
     * Makes an unconfirmed write readable, if the entry under the key is still that write.
     *
     * @param key - Composite provider/repo/commit/settings key.
     * @param writeId - The id the write was saved with.
     */
    async confirmWrite(key: string, writeId: string): Promise<void> {
        await this.enqueue(async () => {
            const payload = this.read();
            if (payload.unconfirmed[key] !== writeId) return;
            await this.write({
                ...payload,
                unconfirmed: markUnconfirmed(payload.unconfirmed, key, undefined),
            });
        });
    }

    /**
     * Removes one persisted snapshot, in order with every queued read and write.
     *
     * @param key - Composite provider/repo/commit/settings key.
     * @param writeId - When given, removes the entry only while it is that unconfirmed
     *   write, so a newer entry under the key stays.
     */
    async delete(key: string, writeId?: string): Promise<void> {
        await this.enqueue(async () => {
            const payload = this.read();
            if (writeId !== undefined && payload.unconfirmed[key] !== writeId) return;
            if (!payload.entries.some((entry) => entry.key === key)) return;
            await this.write({
                schemaVersion: SCHEMA_VERSION,
                entries: payload.entries.filter((entry) => entry.key !== key),
                unconfirmed: markUnconfirmed(payload.unconfirmed, key, undefined),
                generation: payload.generation,
            });
        });
    }

    /**
     * Removes every persisted snapshot of one commit, under any key, in order with every
     * queued read and write; another window may have saved it.
     *
     * @param hash - Commit hash.
     */
    async deleteHash(hash: string): Promise<void> {
        await this.enqueue(async () => {
            const payload = this.read();
            const entries = payload.entries.filter((entry) => entry.snapshot.hash !== hash);
            if (entries.length === payload.entries.length) return;
            await this.write({
                ...payload,
                entries,
                unconfirmed: keepUnconfirmed(payload.unconfirmed, entries),
            });
        });
    }

    /**
     * Clears all persisted commit-check snapshots. Runs in the queue so a write queued
     * before it lands first and is wiped, never after; a new clear generation makes a
     * write another window started before it unreadable when it lands later. When
     * removing the key fails, an empty payload is written over it so a restart cannot
     * read the old entries; the clear still rejects so the caller fails closed for the
     * session.
     */
    async clear(): Promise<void> {
        await this.enqueue(async () => {
            try {
                await this.state.update(clearGenerationKey(this.storageKey), randomUUID());
                await this.state.update(this.storageKey, undefined);
            } catch (error) {
                await this.write({
                    schemaVersion: SCHEMA_VERSION,
                    entries: [],
                    unconfirmed: {},
                    generation: this.generation(),
                });
                throw error;
            }
        });
    }

    /** The store's current clear generation; a fetch captures it when it starts. */
    generation(): string | undefined {
        return this.state.get<string>(clearGenerationKey(this.storageKey));
    }

    /**
     * Reads the generation before the payload and carries it into the write, so a clear
     * from another window landing after this read leaves the write stamped stale (a miss).
     */
    private read(): PersistedPayload {
        const generation = this.generation();
        const payload = this.state.get<unknown>(this.storageKey);
        if (!isPayload(payload) || payload.generation !== generation) {
            return { schemaVersion: SCHEMA_VERSION, entries: [], unconfirmed: {}, generation };
        }
        return {
            schemaVersion: SCHEMA_VERSION,
            entries: payload.entries.filter((entry) => isEntryShape(entry) && this.isUsable(entry)),
            unconfirmed: payload.unconfirmed ?? {},
            generation,
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
        return {
            schemaVersion: SCHEMA_VERSION,
            entries,
            unconfirmed: keepUnconfirmed(payload.unconfirmed, entries),
            generation: payload.generation,
        };
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

/** Returns `marks` with `key` marked unconfirmed by `id`, or unmarked when `id` is undefined. */
export function markUnconfirmed(
    marks: UnconfirmedWrites,
    key: string,
    id: string | undefined,
): UnconfirmedWrites {
    const rest = Object.fromEntries(Object.entries(marks).filter(([marked]) => marked !== key));
    return id === undefined ? rest : { ...rest, [key]: id };
}

/** Drops the marks of keys that no longer have an entry. */
export function keepUnconfirmed(
    marks: UnconfirmedWrites,
    entries: readonly { key: string }[],
): UnconfirmedWrites {
    const keys = new Set(entries.map((entry) => entry.key));
    return Object.fromEntries(Object.entries(marks).filter(([key]) => keys.has(key)));
}

/** Absent marks are an older payload's; malformed marks make the whole payload a miss. */
export function isUnconfirmedWrites(value: unknown): value is UnconfirmedWrites | undefined {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.values(value).every((id) => typeof id === "string");
}

/** A bad-shaped entry is dropped on read, so it is a miss and the next save replaces it. */
function isEntryShape(value: unknown): value is PersistedCommitChecksEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<PersistedCommitChecksEntry>;
    return (
        typeof entry.key === "string" &&
        typeof entry.fetchedAt === "number" &&
        typeof entry.lastAccessedAt === "number" &&
        isCommitChecksSnapshot(entry.snapshot)
    );
}

function isPayload(
    value: unknown,
): value is Omit<PersistedPayload, "unconfirmed"> & { unconfirmed?: UnconfirmedWrites } {
    if (!value || typeof value !== "object") return false;
    const payload = value as { schemaVersion?: unknown; entries?: unknown; unconfirmed?: unknown };
    return (
        payload.schemaVersion === SCHEMA_VERSION &&
        Array.isArray(payload.entries) &&
        isUnconfirmedWrites(payload.unconfirmed)
    );
}
