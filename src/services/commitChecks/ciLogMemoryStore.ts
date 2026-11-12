// The window's CI log store (owner path C, 2026-11-07): downloaded logs live in memory only,
// one store per window, so no other window or a restart ever sees them. It never touches the
// file system; a reload empties it and a log is downloaded again on the next request.

import { createHash } from "crypto";
import type { ProviderId } from "../../types";
import { buildCiLogExcerpt, findFirstErrorLine, type CiLogErrorRules } from "./firstErrorLine";
import type { DownloadedText } from "./http";

/** Logs one window keeps in memory (a design constant; each log is at most 50 MB). */
export const MAX_CI_LOGS_IN_MEMORY = 3;

/** What is needed to download one job's log again; holds no log text. */
export interface CiLogSource {
    repoKey: string;
    provider: ProviderId;
    runId: string;
    jobId: string;
    attempt?: number;
}

/** A stored log. */
export interface CiLogEntry {
    text: string;
    truncated: boolean;
    /** 0-based line the editor opens at. */
    firstErrorLine: number;
}

/** What the webview may receive for a log: the excerpt, never the text. */
export interface CiLogPreview {
    excerpt: string;
    truncated: boolean;
    firstErrorLine: number;
}

/** Downloads one job's log; the store passes its own signal, aborted by `clear()`. */
type CiLogDownload = (source: CiLogSource, signal: AbortSignal) => Promise<DownloadedText>;

/** Dependencies of `CiLogMemoryStore`. */
export interface CiLogMemoryStoreOptions {
    download: CiLogDownload;
    /** The provider's error markers; the generic fallback when absent. */
    errorRules?: (source: CiLogSource) => CiLogErrorRules;
}

/**
 * The store key of one job attempt's log: a SHA-256 of its identity as 64 hex characters.
 *
 * @param providerKey - The provider's repository key.
 * @param runId - Run (pipeline) id.
 * @param jobId - Job id.
 * @param attempt - Run attempt, when the provider has one.
 */
export function ciLogKey(
    providerKey: string,
    runId: string,
    jobId: string,
    attempt: number | undefined,
): string {
    return createHash("sha256")
        .update(`${providerKey}\0${runId}\0${jobId}\0${attempt ?? ""}`)
        .digest("hex");
}

interface InflightLoad {
    promise: Promise<CiLogEntry>;
    controller: AbortController;
}

/** In-memory, per-window LRU of downloaded CI logs with one shared download per key. */
export class CiLogMemoryStore {
    // A Map keeps insertion order, so its first key is the least recently used.
    private readonly entries = new Map<string, CiLogEntry>();
    private readonly inflight = new Map<string, InflightLoad>();
    private readonly sources = new Map<string, CiLogSource>();
    private readonly listeners = new Set<(key: string) => void>();
    private generation = 0;

    /**
     * Creates an empty store.
     *
     * @param options - The download transport and the provider's error markers.
     */
    constructor(private readonly options: CiLogMemoryStoreOptions) {}

    /**
     * The stored log for `key`, marked most recently used; undefined when not in memory.
     *
     * @param key - Key from `ciLogKey`.
     */
    get(key: string): CiLogEntry | undefined {
        const entry = this.entries.get(key);
        if (entry) {
            this.entries.delete(key);
            this.entries.set(key, entry);
        }
        return entry;
    }

    /**
     * The download record of a log requested in this window, kept after eviction.
     *
     * @param key - Key from `ciLogKey`.
     */
    sourceOf(key: string): CiLogSource | undefined {
        return this.sources.get(key);
    }

    /**
     * The log for `key`: stored, joined to the download in flight, or downloaded now.
     *
     * Only settled jobs may be loaded. A failed download stores nothing and rejects every waiter
     * with the same error. `signal` stops this waiter only; a shared download continues.
     *
     * @param key - Key from `ciLogKey`.
     * @param source - What to download; recorded so the log can be downloaded again.
     * @param signal - Cancels this waiter.
     */
    load(key: string, source: CiLogSource, signal?: AbortSignal): Promise<CiLogEntry> {
        this.sources.set(key, source);
        const stored = this.get(key);
        if (stored) return Promise.resolve(stored);
        const shared = this.inflight.get(key) ?? this.startDownload(key, source);
        return waitFor(shared.promise, signal);
    }

    /**
     * Loads the log and returns only its webview-safe excerpt.
     *
     * @param key - Key from `ciLogKey`.
     * @param source - What to download.
     * @param signal - Cancels this waiter.
     */
    async preview(key: string, source: CiLogSource, signal?: AbortSignal): Promise<CiLogPreview> {
        const entry = await this.load(key, source, signal);
        return {
            excerpt: buildCiLogExcerpt(entry.text, entry.firstErrorLine),
            truncated: entry.truncated,
            firstErrorLine: entry.firstErrorLine,
        };
    }

    /**
     * Calls `listener` with the key of every log a download stores.
     *
     * @param listener - Receives the stored key.
     */
    onDidLoad(listener: (key: string) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /** Empties the store and aborts downloads in flight; their late results are dropped. */
    clear(): void {
        this.generation++;
        this.entries.clear();
        for (const { controller } of this.inflight.values()) controller.abort();
        this.inflight.clear();
    }

    /** Clears the store and drops every listener. */
    dispose(): void {
        this.clear();
        this.listeners.clear();
    }

    private startDownload(key: string, source: CiLogSource): InflightLoad {
        const controller = new AbortController();
        const generation = this.generation;
        const promise = this.options.download(source, controller.signal).then(
            (downloaded) => {
                if (generation !== this.generation) throw abortError();
                this.inflight.delete(key);
                const rules = this.options.errorRules?.(source) ?? { patterns: [] };
                const entry: CiLogEntry = {
                    text: downloaded.text,
                    truncated: downloaded.truncated,
                    firstErrorLine: findFirstErrorLine(downloaded.text, rules),
                };
                this.entries.set(key, entry);
                while (this.entries.size > MAX_CI_LOGS_IN_MEMORY) {
                    this.entries.delete(this.entries.keys().next().value as string);
                }
                for (const listener of [...this.listeners]) listener(key);
                return entry;
            },
            (error: unknown) => {
                if (generation !== this.generation) throw abortError();
                this.inflight.delete(key);
                throw error;
            },
        );
        const load = { promise, controller };
        this.inflight.set(key, load);
        return load;
    }
}

/** `promise`, or an abort rejection as soon as `signal` aborts. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() =>
        signal.removeEventListener("abort", onAbort),
    );
}

function abortError(): Error {
    const error = new Error("The log download was aborted");
    error.name = "AbortError";
    return error;
}
