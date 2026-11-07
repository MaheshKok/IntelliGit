// Persistent CI detail cache, a sibling of the snapshot store. It keeps only details that
// are complete and fully covered, never the values attached at read time (capabilities,
// repoKey, action fence), and treats an entry from another contract version as a miss.

import { isCompleteDetail, isFullyCovered } from "../../shared/ci/completion";
import { CI_DETAIL_CONTRACT_VERSION } from "../../shared/ci/contractVersion";
import type { CommitCiDetail, CommitCiDetailData } from "../../types";
import type { CommitChecksPersistentState } from "./persistentCache";

const DEFAULT_STORAGE_KEY = "intelligit.commitChecks.detailCache.v1";
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Persistent detail cache tuning. */
export interface CiDetailPersistentCacheOptions {
    /** Memento key used for the single cache payload. */
    storageKey?: string;
    /** Maximum persisted details retained across sessions. */
    maxEntries?: number;
    /** Maximum age of a persisted detail. */
    maxAgeMs?: number;
    /** Injectable clock for tests. */
    now?: () => number;
}

interface PersistedDetailEntry {
    key: string;
    contractVersion: number;
    data: CommitCiDetailData;
    fetchedAt: number;
    lastAccessedAt: number;
}

interface PersistedDetailPayload {
    entries: PersistedDetailEntry[];
}

/** VS Code globalState-backed cache for complete, fully covered CI details. */
export class CiDetailPersistentCache {
    private readonly storageKey: string;
    private readonly maxEntries: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;
    private operations: Promise<void> = Promise.resolve();

    /**
     * Creates a bounded persistent detail cache.
     *
     * @param state - VS Code globalState-compatible storage.
     * @param options - Storage key, age, capacity, and clock overrides.
     */
    constructor(
        private readonly state: CommitChecksPersistentState,
        options: CiDetailPersistentCacheOptions = {},
    ) {
        this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
        this.maxAgeMs = Math.max(0, Math.floor(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
        this.now = options.now ?? Date.now;
    }

    /**
     * Returns a valid persisted detail and bumps its LRU timestamp.
     *
     * @param key - Detail cache key (`<snapshot key>#detail`).
     * @returns The persisted detail, or undefined on miss, expiry, version change or bad shape.
     */
    async get(key: string): Promise<CommitCiDetailData | undefined> {
        return this.enqueue(async () => {
            const payload = this.read();
            const entry = payload.entries.find((candidate) => candidate.key === key);
            if (!entry) return undefined;
            entry.lastAccessedAt = this.now();
            await this.write(this.trim(payload));
            return entry.data;
        });
    }

    /**
     * Persists a detail when it is complete and fully covered. Any other provider answer
     * removes the stored entry it supersedes (a rerun of a settled commit); an
     * unavailable one changes nothing.
     *
     * @param key - Detail cache key.
     * @param detail - Provider detail; read-time fields are stripped before writing.
     * @param fetchedAt - Fetch timestamp to preserve across sessions.
     */
    async set(key: string, detail: CommitCiDetailData, fetchedAt = this.now()): Promise<void> {
        if (!isPersistableDetail(detail)) {
            if (detail.outcome !== "unavailable") await this.delete(key);
            return;
        }
        const data = toPersistedData(detail);
        await this.enqueue(async () => {
            const payload = this.read();
            const entry: PersistedDetailEntry = {
                key,
                contractVersion: CI_DETAIL_CONTRACT_VERSION,
                data,
                fetchedAt,
                lastAccessedAt: this.now(),
            };
            const entries = payload.entries.filter((candidate) => candidate.key !== key);
            await this.write(this.trim({ entries: [...entries, entry] }));
        });
    }

    /**
     * Removes one persisted detail, in order with every queued read and write.
     *
     * @param key - Detail cache key.
     */
    async delete(key: string): Promise<void> {
        await this.enqueue(async () => {
            const payload = this.read();
            if (!payload.entries.some((entry) => entry.key === key)) return;
            await this.write({ entries: payload.entries.filter((entry) => entry.key !== key) });
        });
    }

    /**
     * Clears every persisted detail, in order with every queued read and write. When
     * removing the key fails, an empty payload is written over it so a restart cannot
     * read the old entries; the clear still rejects so the caller fails closed.
     */
    async clear(): Promise<void> {
        await this.enqueue(async () => {
            try {
                await this.state.update(this.storageKey, undefined);
            } catch (error) {
                await this.write({ entries: [] });
                throw error;
            }
        });
    }

    private read(): PersistedDetailPayload {
        const payload = this.state.get<unknown>(this.storageKey);
        if (!payload || typeof payload !== "object") return { entries: [] };
        const entries = (payload as { entries?: unknown }).entries;
        if (!Array.isArray(entries)) return { entries: [] };
        return {
            entries: entries.filter(
                (entry): entry is PersistedDetailEntry =>
                    isEntryShape(entry) && this.isUsable(entry),
            ),
        };
    }

    private async write(payload: PersistedDetailPayload): Promise<void> {
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

    private trim(payload: PersistedDetailPayload): PersistedDetailPayload {
        const entries = payload.entries
            .filter((entry) => this.isUsable(entry))
            .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
            .slice(0, this.maxEntries);
        return { entries };
    }

    private isUsable(entry: PersistedDetailEntry): boolean {
        if (entry.contractVersion !== CI_DETAIL_CONTRACT_VERSION) return false;
        if (!isPersistableDetail(entry.data)) return false;
        return this.now() - entry.fetchedAt <= this.maxAgeMs;
    }
}

/** Only complete and fully covered details may outlive the window. */
function isPersistableDetail(detail: CommitCiDetailData): boolean {
    return isCompleteDetail(detail) && isFullyCovered(detail);
}

/** Drops the values attached at read time, in case a served detail is passed in. */
function toPersistedData(detail: CommitCiDetailData): CommitCiDetailData {
    const data: Partial<CommitCiDetail> & CommitCiDetailData = { ...detail };
    delete data.capabilities;
    delete data.repoKey;
    delete data.actionFence;
    return data;
}

function isEntryShape(value: unknown): value is PersistedDetailEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<PersistedDetailEntry>;
    const data = entry.data as Partial<CommitCiDetailData> | undefined;
    return (
        typeof entry.key === "string" &&
        typeof entry.contractVersion === "number" &&
        typeof entry.fetchedAt === "number" &&
        typeof entry.lastAccessedAt === "number" &&
        !!data &&
        typeof data === "object" &&
        typeof data.hash === "string" &&
        typeof data.complete === "boolean" &&
        Array.isArray(data.runs) &&
        Array.isArray(data.otherChecks)
    );
}
