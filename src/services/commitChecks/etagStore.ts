// In-memory store for conditional CI requests (plan §3 "ETag", K12). A request for a
// commit whose checks were still running when last read sends the stored `ETag` as
// `If-None-Match`; a 304 then costs nothing against GitHub's primary rate limit and
// returns the stored body. Complete commits are served from the snapshot and detail
// caches, so their requests never use this store.

/** The 200 response a later 304 stands for. */
export interface EtagEntry {
    readonly etag: string;
    /** The raw JSON text, parsed anew for every 304 so no caller shares or edits it. */
    readonly body: string;
    /** The response's `Link` and `x-next-page` headers, restored into a 304's headers. */
    readonly pagination: Readonly<Record<string, string | string[]>>;
}

/** Entries kept, least recently used dropped first (K12). */
const ETAG_STORE_MAX_ENTRIES = 500;

/** Conditional-request store, one per window, never persisted. */
export class EtagStore {
    private readonly entries = new Map<string, EtagEntry>();
    private readonly incompleteCommits = new Map<string, true>();

    /**
     * Creates an empty store for one window.
     *
     * @param authGeneration - Reads the current auth generation; it is part of every key, so a
     *   sign-in change never reuses a body read with another token.
     */
    constructor(private readonly authGeneration: () => number) {}

    /**
     * The key for `url` under the auth generation now. Callers take it when the request is
     * sent, so a response is stored under the generation it was read with.
     */
    keyFor(url: string): string {
        return `${this.authGeneration()}\0${url}`;
    }

    /** The entry for `key`, now the most recently used, if one is kept. */
    get(key: string): EtagEntry | undefined {
        const entry = this.entries.get(key);
        if (entry) remember(this.entries, key, entry);
        return entry;
    }

    /** Keeps `entry` as the most recently used, dropping the least recent past the limit. */
    set(key: string, entry: EtagEntry): void {
        remember(this.entries, key, entry);
    }

    /**
     * This store when `commitKey` was incomplete at its last read, else undefined.
     *
     * @param commitKey - A provider's key for one commit's snapshot or detail.
     */
    forCommit(commitKey: string): EtagStore | undefined {
        return this.incompleteCommits.has(commitKey) ? this : undefined;
    }

    /**
     * Records whether `commitKey`'s latest read was complete, which decides whether its next
     * read uses this store.
     */
    noteCommit(commitKey: string, complete: boolean): void {
        if (complete) this.incompleteCommits.delete(commitKey);
        else remember(this.incompleteCommits, commitKey, true);
    }
}

/** Moves `key` to the most recent end of `map` and drops the oldest past the limit. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > ETAG_STORE_MAX_ENTRIES) map.delete(map.keys().next().value as string);
}
