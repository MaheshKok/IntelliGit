// Coordinates commit-check providers for one repository. It resolves the active
// remote once per repository generation, builds a provider-scoped cache key, and
// delegates snapshot caching/de-dupe to the shared CommitChecksService.

import type { GitOps } from "../../git/operations";
import type { CommitChecksSnapshot } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { summaryForState, unavailableSnapshot } from "./normalize";
import { CommitChecksService, type CommitChecksFetchOptions } from "./service";
import type { CommitChecksProvider, HostMap, ProviderId, ProviderRepoRef } from "./types";

interface ProviderMatch {
    provider: CommitChecksProvider;
    ref: ProviderRepoRef;
}

/**
 * Default cache TTL for pending snapshots, aligned with the webview poll interval
 * (`PENDING_CHECK_REFRESH_MS`, 15s). Sub-poll bursts (scroll/re-render) serve cache while
 * the 15s poll still re-fetches; tunable host-side. `none` and `unavailable` use separate
 * `CommitChecksService` defaults. Tests pass an explicit `ttlMs`.
 */
export const DEFAULT_COMMIT_CHECKS_TTL_MS = 15_000;

/** Tunable behavior for the coordinator; all fields default to the prior Phase-0 behavior. */
export interface CommitChecksCoordinatorOptions {
    /** When false, every request returns a none snapshot without touching the network. */
    enabled?: boolean;
    /** Per-provider toggle; a provider id mapped to false yields no badge for its remote. */
    providerEnabled?: Partial<Record<ProviderId, boolean>>;
    /**
     * Milliseconds a pending snapshot is served from L1 before a re-fetch. `none` and
     * `unavailable` use separate service options/defaults. Ignored when `service` is supplied.
     */
    ttlMs?: number;
    /** Injectable clock for tests; defaults to Date.now. */
    now?: () => number;
    /** Shared cache/de-dupe service; omitted tests get an instance-local service. */
    service?: CommitChecksService;
    /** Content-affecting settings fingerprint included in the shared cache key. */
    settingsFingerprint?: string;
}

/** Resolves the provider for a repository and delegates snapshots to the shared cache. */
export class CommitChecksCoordinator {
    private readonly enabled: boolean;
    private readonly providerEnabled: Partial<Record<ProviderId, boolean>>;
    private readonly service: CommitChecksService;
    private readonly settingsFingerprint: string;
    private resolvedProvider = false;
    private providerMatch: ProviderMatch | null = null;
    private providerGeneration = 0;
    // Shared by concurrent callers (the bounded viewport fan-out can start several
    // resolutions before the first settles) so only one findProviderMatch() search runs.
    // clearProviderResolution() must null this too, or a caller arriving after a
    // repository switch could be handed the PREVIOUS repository's still-settling search —
    // the exact staleness the generation guard below exists to prevent.
    private resolutionInFlight: Promise<ProviderMatch | null> | null = null;

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
        this.service =
            options.service ?? new CommitChecksService({ ttlMs: options.ttlMs, now: options.now });
        this.settingsFingerprint = options.settingsFingerprint ?? "-";
    }

    /** Drops shared cached snapshots; called after credential/settings changes. */
    clear(): void {
        this.clearProviderResolution();
        this.service.clear();
    }

    /** Clears only the memoized provider/ref, preserving shared cached snapshots. */
    clearProviderResolution(): void {
        this.providerGeneration += 1;
        this.resolvedProvider = false;
        this.providerMatch = null;
        // Must drop the in-flight promise too: otherwise a caller arriving after this
        // switch would be handed the PREVIOUS repository's still-settling resolution
        // instead of starting a fresh one under the new generation.
        this.resolutionInFlight = null;
    }

    /**
     * Returns the snapshot for a commit, serving a fresh cache hit unless a forced refresh is set.
     *
     * @param hash - Full Git commit hash requested by a visible graph row.
     * @param options - Cache refresh controls, including forced cache-layer bypasses.
     */
    async getChecks(
        hash: string,
        options: CommitChecksFetchOptions = {},
    ): Promise<CommitChecksSnapshot> {
        if (!this.enabled) {
            // Feature off: no badge, no remote resolution, no network. The webview also
            // never renders the button, so this is defense in depth.
            return this.noneSnapshot(hash);
        }
        return this.fetchFresh(hash, options);
    }

    /** Builds the no-badge snapshot used when the feature or matched provider is disabled. */
    private noneSnapshot(hash: string): CommitChecksSnapshot {
        return { hash, state: "none", summary: summaryForState("none"), items: [] };
    }

    /**
     * Resolves the provider-scoped key and delegates cache policy to the shared service.
     *
     * @param hash - Full Git commit hash requested by a visible graph row.
     * @param options - Cache-refresh intent forwarded unchanged to the shared service.
     */
    private async fetchFresh(
        hash: string,
        options: CommitChecksFetchOptions,
    ): Promise<CommitChecksSnapshot> {
        const providerGeneration = this.providerGeneration;
        let match: ProviderMatch | null;
        try {
            match = await this.resolveProvider();
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
        if (providerGeneration !== this.providerGeneration) {
            return this.noneSnapshot(hash);
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
        const key = `${match.provider.keyFor(match.ref)}@${hash}:${this.settingsFingerprint}`;
        return this.service.getOrFetch(
            key,
            async () => {
                try {
                    return await match.provider.getChecks(match.ref, hash);
                } catch (err) {
                    return unavailableSnapshot(hash, getErrorMessage(err));
                }
            },
            options,
        );
    }

    private async resolveProvider(): Promise<ProviderMatch | null> {
        if (this.resolvedProvider) return this.providerMatch;
        if (this.resolutionInFlight) return this.resolutionInFlight;
        const generation = this.providerGeneration;
        const pending = this.findProviderMatch();
        this.resolutionInFlight = pending;
        try {
            const match = await pending;
            // A generation bump while the search above was in flight means the repository
            // changed mid-resolution: return this stale match to the caller (fetchFresh
            // already discards it) but do not memoize it as the current repository's answer.
            if (generation !== this.providerGeneration) return match;
            this.providerMatch = match;
            this.resolvedProvider = true;
            return match;
        } finally {
            if (this.resolutionInFlight === pending) this.resolutionInFlight = null;
        }
    }

    /** Origin-first, first-match remote search; no side effects — resolveProvider owns memoization. */
    private async findProviderMatch(): Promise<ProviderMatch | null> {
        const remotes = await this.gitOps.getRemotes();
        const ordered = remotes.includes("origin")
            ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
            : remotes;
        for (const remote of ordered) {
            // Remote matching is first-match semantics with origin priority.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
