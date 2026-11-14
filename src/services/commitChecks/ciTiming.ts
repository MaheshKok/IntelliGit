// "Usually" durations for running CI items (PLAN.md K23). Providers find the baseline, the
// latest successful earlier run of the same workflow and branch; this module caches it per
// selected run and attaches it to the served detail.

import type * as vscode from "vscode";
import type { CiRun } from "../../types";

/** How long the baseline of a selected run took, and each of its jobs by logical id. */
export interface UsualDuration {
    readonly baselineRunId: string;
    /** Null when the provider gave no usable duration for the baseline run. */
    readonly runMs: number | null;
    /** Only logical ids that occur once in the baseline. */
    readonly jobMs: Readonly<Record<string, number>>;
}

/** K23: a baseline is complete and immutable, so it is kept a day, in memory and on disk. */
const USUAL_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_KEY = "intelligit.commitChecks.usualDurations";
/** Saved baselines kept at most; the oldest are dropped first. */
const MAX_SAVED = 200;

/** Options of {@link UsualDurationCache}. */
interface UsualDurationCacheOptions {
    /** Keeps baselines across windows and restarts (the extension's global state). */
    readonly store?: Pick<vscode.Memento, "get" | "update">;
    /** Injectable clock for tests. */
    readonly now?: () => number;
}

interface Saved {
    readonly at: number;
    readonly value: UsualDuration;
}

/**
 * The cache key of a selected run's baseline (K23: `usual:<repoKey>:<selectedRunId>`).
 *
 * @param scope - The repository key, with the account when the provider has one.
 * @param run - The selected run.
 */
export function usualCacheKey(scope: string, run: CiRun): string {
    return `usual:${scope}:${run.id}`;
}

/** Milliseconds between two provider timestamps; null when either is missing or unparsable. */
export function spanMs(start: unknown, end: unknown): number | null {
    if (typeof start !== "string" || typeof end !== "string") return null;
    const ms = Date.parse(end) - Date.parse(start);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Durations by logical id, leaving out ids that occur more than once or have no duration. */
export function uniqueJobDurations(
    jobs: readonly { logicalId: string; ms: number | null }[],
): Record<string, number> {
    const counts = new Map<string, number>();
    for (const { logicalId } of jobs) counts.set(logicalId, (counts.get(logicalId) ?? 0) + 1);
    return Object.fromEntries(
        jobs.flatMap(({ logicalId, ms }) =>
            counts.get(logicalId) === 1 && ms !== null ? [[logicalId, ms]] : [],
        ),
    );
}

/**
 * The run with its usual duration and each job's, matched by logical id when the id is unique
 * in the run; `null` = unknown ("usually: unknown").
 */
export function applyUsual(run: CiRun, usual: UsualDuration | null): CiRun {
    const counts = new Map<string, number>();
    for (const job of run.jobs) counts.set(job.logicalId, (counts.get(job.logicalId) ?? 0) + 1);
    return {
        ...run,
        usualDurationMs: usual?.runMs ?? null,
        jobs: run.jobs.map((job) => ({
            ...job,
            usualDurationMs:
                usual &&
                counts.get(job.logicalId) === 1 &&
                Object.hasOwn(usual.jobMs, job.logicalId)
                    ? usual.jobMs[job.logicalId]
                    : null,
        })),
    };
}

/**
 * Baselines by selected run: in memory, and in `store` when given, each for 24 hours. Callers
 * asking at the same time share one fetch. "No baseline" and a failed fetch are not kept: a
 * run that was still going when asked may succeed later and become the baseline.
 */
export class UsualDurationCache {
    private readonly entries = new Map<
        string,
        { readonly at: number; readonly value: Promise<UsualDuration | null> }
    >();
    private readonly store?: Pick<vscode.Memento, "get" | "update">;
    private readonly now: () => number;
    private generation = 0;
    // Saved entries from before the last clear() are ignored until its write lands.
    private clearedAt = Number.NEGATIVE_INFINITY;
    private writes: Promise<unknown> = Promise.resolve();

    /**
     * Creates an empty cache.
     *
     * @param options - Where baselines are kept across windows, and the clock.
     */
    constructor(options: UsualDurationCacheOptions = {}) {
        this.store = options.store;
        this.now = options.now ?? Date.now;
    }

    /** The kept baseline for `key`, or `fetch`'s answer when none is younger than a day. */
    get(key: string, fetch: () => Promise<UsualDuration | null>): Promise<UsualDuration | null> {
        const now = this.now();
        const hit = this.entries.get(key);
        if (hit && now - hit.at < USUAL_TTL_MS) return hit.value;
        const saved = this.readSaved()[key];
        if (saved && now - saved.at < USUAL_TTL_MS) {
            const value = Promise.resolve(saved.value);
            this.entries.set(key, { at: saved.at, value });
            return value;
        }
        const generation = this.generation;
        const entry = { at: now, value: fetch() };
        this.entries.set(key, entry);
        entry.value.then(
            (value) => {
                if (!value) {
                    if (this.entries.get(key) === entry) this.entries.delete(key);
                } else if (generation === this.generation) {
                    this.save(key, { at: entry.at, value });
                }
            },
            () => {
                if (this.entries.get(key) === entry) this.entries.delete(key);
            },
        );
        return entry.value;
    }

    /** Drops every baseline, saved ones too; a fetch already under way is not kept. */
    clear(): void {
        this.generation += 1;
        this.clearedAt = this.now();
        this.entries.clear();
        const store = this.store;
        if (store) this.enqueue(() => store.update(STORE_KEY, undefined));
    }

    private save(key: string, saved: Saved): void {
        const store = this.store;
        if (!store) return;
        this.enqueue(() => {
            const now = this.now();
            const kept = Object.entries({ ...this.readSaved(), [key]: saved })
                .filter(([, entry]) => now - entry.at < USUAL_TTL_MS)
                .sort(([, a], [, b]) => b.at - a.at)
                .slice(0, MAX_SAVED);
            return store.update(STORE_KEY, Object.fromEntries(kept));
        });
    }

    /** Writes one after another, so a save never overwrites a later clear or save. */
    private enqueue(write: () => Thenable<void>): void {
        // A failed write only costs a refetch later; the chain must keep going.
        this.writes = this.writes.then(write).then(undefined, () => undefined);
    }

    private readSaved(): Record<string, Saved> {
        const raw = this.store?.get<unknown>(STORE_KEY);
        if (!raw || typeof raw !== "object") return {};
        return Object.fromEntries(
            Object.entries(raw).filter(([, entry]) => isSaved(entry) && entry.at > this.clearedAt),
        );
    }
}

function isSaved(entry: unknown): entry is Saved {
    if (!entry || typeof entry !== "object") return false;
    const { at, value } = entry as { at?: unknown; value?: unknown };
    if (typeof at !== "number" || !value || typeof value !== "object") return false;
    const { baselineRunId, runMs, jobMs } = value as Record<string, unknown>;
    return (
        typeof baselineRunId === "string" &&
        (runMs === null || typeof runMs === "number") &&
        !!jobMs &&
        typeof jobMs === "object" &&
        Object.values(jobMs).every((ms) => typeof ms === "number")
    );
}
