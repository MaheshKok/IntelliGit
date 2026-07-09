// Coordinates commit-check providers for one repository. It resolves the active
// remote once per repository generation, builds a provider-scoped cache key, and
// delegates snapshot caching/de-dupe to the shared CommitChecksService.

import type { GitOps } from "../../git/operations";
import type { CommitChecksSnapshot } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { summaryForState, unavailableSnapshot } from "./normalize";
import { CommitChecksService } from "./service";
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

/** Tunable behavior for the coordinator; all fields default to the prior Phase-0 behavior. */
export interface CommitChecksCoordinatorOptions {
    /** When false, every request returns a none snapshot without touching the network. */
    enabled?: boolean;
    /** Per-provider toggle; a provider id mapped to false yields no badge for its remote. */
    providerEnabled?: Partial<Record<ProviderId, boolean>>;
    /**
     * Milliseconds a non-terminal snapshot (pending/none/unavailable) is served from cache
     * before a re-fetch. Ignored when `service` is supplied because the shared service owns TTL.
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
    }

    /** Returns the snapshot for a commit, serving a fresh cache hit or re-fetching. */
    async getChecks(hash: string): Promise<CommitChecksSnapshot> {
        if (!this.enabled) {
            // Feature off: no badge, no remote resolution, no network. The webview also
            // never renders the button, so this is defense in depth.
            return this.noneSnapshot(hash);
        }
        return this.fetchFresh(hash);
    }

    /** Builds the no-badge snapshot used when the feature or matched provider is disabled. */
    private noneSnapshot(hash: string): CommitChecksSnapshot {
        return { hash, state: "none", summary: summaryForState("none"), items: [] };
    }

    private async fetchFresh(hash: string): Promise<CommitChecksSnapshot> {
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
        return this.service.getOrFetch(key, async () => {
            try {
                return await match.provider.getChecks(match.ref, hash);
            } catch (err) {
                return unavailableSnapshot(hash, getErrorMessage(err));
            }
        });
    }

    private async resolveProvider(): Promise<ProviderMatch | null> {
        if (this.resolvedProvider) return this.providerMatch;
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
                if (ref) {
                    this.providerMatch = { provider, ref };
                    this.resolvedProvider = true;
                    return this.providerMatch;
                }
            }
        }
        this.providerMatch = null;
        this.resolvedProvider = true;
        return null;
    }
}
