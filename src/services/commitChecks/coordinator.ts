// Coordinates commit-check providers for one repository. On every request it
// re-resolves Git remotes (the active repo can change at runtime), picks the first
// matching provider (origin first), and caches the resulting snapshot per commit
// hash. Terminal snapshots are served from cache indefinitely; non-terminal states
// (pending/none/unavailable) are served from cache only within a TTL, so a still-
// running, just-pushed, or transiently rate-limited commit settles without a manual
// refresh yet is not re-fetched on every sub-poll request. The whole feature and each
// provider can be disabled, in which case the matched commit yields no badge.

import type { GitOps } from "../../git/operations";
import type { CommitChecksSnapshot } from "../../types";
import { isPendingCheckState } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { summaryForState, unavailableSnapshot } from "./normalize";
import type { CommitChecksProvider, HostMap, ProviderId, ProviderRepoRef } from "./types";

interface ProviderMatch {
    provider: CommitChecksProvider;
    ref: ProviderRepoRef;
}

/**
 * Default cache TTL for non-terminal snapshots, aligned with the webview poll interval
 * (`PENDING_CHECK_REFRESH_MS`, 15s). Sub-poll bursts (scroll/re-render) serve cache while
 * the 15s poll still re-fetches; tunable host-side. Tests pass an explicit `ttlMs`.
 */
export const DEFAULT_COMMIT_CHECKS_TTL_MS = 15_000;

/** A cached snapshot tagged with the clock time it was fetched, for TTL comparison. */
interface CacheEntry {
    snapshot: CommitChecksSnapshot;
    fetchedAt: number;
}

/** Tunable behavior for the coordinator; all fields default to the prior Phase-0 behavior. */
export interface CommitChecksCoordinatorOptions {
    /** When false, every request returns a none snapshot without touching the network. */
    enabled?: boolean;
    /** Per-provider toggle; a provider id mapped to false yields no badge for its remote. */
    providerEnabled?: Partial<Record<ProviderId, boolean>>;
    /**
     * Milliseconds a non-terminal snapshot (pending/none/unavailable) is served from cache
     * before a re-fetch. Defaults to 0 (re-fetch every request, the prior behavior). This
     * is a throttle, not rate-limit backoff: a still-rate-limited host is re-fetched once
     * per TTL; the server-sent Retry-After clear-time is not honored (tracked follow-up).
     */
    ttlMs?: number;
    /** Injectable clock for tests; defaults to Date.now. */
    now?: () => number;
}

/** Resolves a provider per request and caches commit-check snapshots by hash. */
export class CommitChecksCoordinator {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly enabled: boolean;
    private readonly providerEnabled: Partial<Record<ProviderId, boolean>>;
    private readonly ttlMs: number;
    private readonly now: () => number;

    /**
     * Builds a coordinator over an ordered provider registry for one repository.
     *
     * @param gitOps - Active repository Git facade; remotes are read on every request.
     * @param providers - Ordered provider registry; first match wins for a given remote.
     * @param hostMap - Self-hosted host to provider-id overrides (empty for GitHub-only).
     * @param options - Feature/provider toggles and TTL clock; defaults preserve prior behavior.
     */
    constructor(
        private readonly gitOps: GitOps,
        private readonly providers: readonly CommitChecksProvider[],
        private readonly hostMap: HostMap = {},
        options: CommitChecksCoordinatorOptions = {},
    ) {
        this.enabled = options.enabled ?? true;
        this.providerEnabled = options.providerEnabled ?? {};
        this.ttlMs = options.ttlMs ?? 0;
        this.now = options.now ?? Date.now;
    }

    /** Drops all cached snapshots; called when the active repository changes. */
    clear(): void {
        this.cache.clear();
    }

    /** Returns the snapshot for a commit, serving a fresh cache hit or re-fetching. */
    async getChecks(hash: string): Promise<CommitChecksSnapshot> {
        if (!this.enabled) {
            // Feature off: no badge, no remote resolution, no network. The webview also
            // never renders the button, so this is defense in depth.
            return this.noneSnapshot(hash);
        }
        const cached = this.cache.get(hash);
        if (cached && this.isFresh(cached)) {
            return cached.snapshot;
        }
        const snapshot = await this.fetchFresh(hash);
        this.cache.set(hash, { snapshot, fetchedAt: this.now() });
        return snapshot;
    }

    /**
     * Whether a cache entry may still be served. Terminal snapshots are served forever;
     * non-terminal ones (pending/none/unavailable) only while within the TTL window.
     */
    private isFresh(entry: CacheEntry): boolean {
        const { state } = entry.snapshot;
        const nonTerminal = isPendingCheckState(state) || state === "unavailable";
        if (!nonTerminal) return true;
        return this.now() - entry.fetchedAt < this.ttlMs;
    }

    /** Builds the no-badge snapshot used when the feature or matched provider is disabled. */
    private noneSnapshot(hash: string): CommitChecksSnapshot {
        return { hash, state: "none", summary: summaryForState("none"), items: [] };
    }

    private async fetchFresh(hash: string): Promise<CommitChecksSnapshot> {
        let match: ProviderMatch | null;
        try {
            match = await this.resolveProvider();
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
        if (!match) {
            // No registered provider matched any remote (an unmapped self-hosted host, or
            // an unsupported forge). That is a configuration state, not a recoverable
            // error: yield no badge (state "none"), the same as a disabled provider. An
            // "unavailable" error badge here would be permanent — re-fetching can never
            // map the host — and the UI only hides "none".
            return this.noneSnapshot(hash);
        }
        if (this.providerEnabled[match.provider.id] === false) {
            // Hard-stop: the origin-first matched provider is disabled. Yield no badge and
            // do NOT fall through to a later remote's enabled provider — the badge stays
            // tied to origin, not to whichever remote happens to be on.
            return this.noneSnapshot(hash);
        }
        try {
            return await match.provider.getChecks(match.ref, hash);
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
    }

    private async resolveProvider(): Promise<ProviderMatch | null> {
        const remotes = await this.gitOps.getRemotes();
        const ordered = remotes.includes("origin")
            ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
            : remotes;
        for (const remote of ordered) {
            const url = await this.gitOps.getRemoteUrl(remote);
            if (!url) continue;
            for (const provider of this.providers) {
                const ref = provider.match(url, this.hostMap);
                if (ref) return { provider, ref };
            }
        }
        return null;
    }
}
