// Coordinates commit-check providers for one repository. It resolves the active
// remote once per repository generation, builds a provider-scoped cache key, and
// delegates snapshot caching/de-dupe to the shared CommitChecksService and CI detail
// caching to the sibling CommitCiDetailService.

import * as vscode from "vscode";
import type { GitOps } from "../../git/operations";
import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import { isCompleteSnapshot } from "../../shared/ci/completion";
import type {
    CommitChecksSnapshot,
    CommitCiDetail,
    CommitCiDetailData,
    ProviderId,
} from "../../types";
import { getErrorMessage } from "../../utils/errors";
import type { CiGenerations, CiOperationContext } from "./ciGenerations";
import type { CiTrace } from "./ciTrace";
import { attach, CommitCiDetailService } from "./detailService";
import { summaryForState, unavailableSnapshot } from "./normalize";
import { CommitChecksService, type CommitChecksFetchOptions } from "./service";
import type { CommitChecksProvider, HostMap, ProviderRepoRef } from "./types";

interface ProviderMatch {
    provider: CommitChecksProvider;
    ref: ProviderRepoRef;
}

/**
 * Tries per request when the signed-in account changes while a request runs. When every
 * try sees a change (an account that cannot be read gets a fresh `unresolved-` id on
 * every read), the caller gets an unavailable answer, never one of another account.
 */
const ACCOUNT_ATTEMPTS = 2;

/** A fetch finished under another account than the one its cache key was built for. */
class AccountChangedError extends Error {}

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
    /** Shared CI detail cache; omitted tests get an instance-local service. */
    detailService?: CommitCiDetailService;
    /** Content-affecting settings fingerprint included in the shared cache key. */
    settingsFingerprint?: string;
    /** Host-wide auth and lifecycle generations checked by detail requests. */
    generations?: CiGenerations;
    /** Token-free diagnostic trace for discarded detail requests. */
    trace?: CiTrace;
    /** E2E runs only: a seeded detail served for a commit instead of the provider's. */
    fixture?: (
        hash: string,
    ) => { detail: CommitCiDetailData; capabilities: ProviderCiCapabilities } | undefined;
}

/** Resolves the provider for a repository and delegates snapshots to the shared cache. */
export class CommitChecksCoordinator {
    private readonly enabled: boolean;
    private readonly providerEnabled: Partial<Record<ProviderId, boolean>>;
    private readonly service: CommitChecksService;
    private readonly detailService: CommitCiDetailService;
    private readonly settingsFingerprint: string;
    private readonly generations?: CiGenerations;
    private readonly trace?: CiTrace;
    private readonly fixture?: CommitChecksCoordinatorOptions["fixture"];
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
        this.detailService =
            options.detailService ??
            new CommitCiDetailService({ ttlMs: options.ttlMs, now: options.now });
        this.settingsFingerprint = options.settingsFingerprint ?? "-";
        this.generations = options.generations;
        this.trace = options.trace;
        this.fixture = options.fixture;
    }

    /** Drops shared cached snapshots and details; called after credential/settings changes. */
    clear(): void {
        this.clearProviderResolution();
        this.service.clear();
        this.detailService.clear();
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
        const seeded = this.fixture?.(hash);
        if (seeded) {
            const { outcome, otherChecks } = seeded.detail;
            return {
                hash,
                state: outcome,
                summary: summaryForState(outcome),
                items: otherChecks.map(({ name, description, state, url }) => ({
                    name,
                    description,
                    state,
                    source: "status" as const,
                    url,
                })),
            };
        }
        return this.fetchFresh(hash, options);
    }

    /**
     * Returns the CI detail for a commit with the provider's capabilities attached, or
     * undefined when no enabled provider serves this repository (feature off, provider
     * off, no matching remote, or the remotes could not be read).
     *
     * @param hash - Full Git commit hash.
     * @param options - `force` bypasses the detail caches (and the snapshot caches for a
     *   provider without its own detail).
     * @param ctx - Context captured when the operation started. A sign-in change, a CI
     *   settings change, a closed repository or a repository switch after it was captured
     *   also yields undefined, so the caller publishes nothing.
     */
    async getDetail(
        hash: string,
        options: CommitChecksFetchOptions,
        ctx: CiOperationContext,
    ): Promise<CommitCiDetail | undefined> {
        if (!this.enabled) return undefined;
        const seeded = this.fixture?.(hash);
        if (seeded)
            return { ...seeded.detail, capabilities: seeded.capabilities, repoKey: ctx.repoKey };
        const providerGeneration = this.providerGeneration;
        let match: ProviderMatch | null;
        try {
            match = await this.resolveEnabledMatch();
        } catch {
            return undefined;
        }
        if (!this.isCurrent(ctx, providerGeneration)) return this.discard(ctx, hash);
        if (!match) return undefined;
        const { provider, ref } = match;
        const getDetail = provider.getDetail?.bind(provider);
        const fetchDetail = getDetail
            ? async (): Promise<CommitCiDetailData> => {
                  try {
                      return await getDetail(ref, hash, ctx);
                  } catch (err) {
                      return floorDetail(
                          unavailableSnapshot(hash, getErrorMessage(err)),
                          provider.id,
                      );
                  }
              }
            : async (): Promise<CommitCiDetailData> =>
                  floorDetail(await this.fetchSnapshot(match, hash, options), provider.id);
        const serve = { repoKey: ctx.repoKey, capabilities: provider.capabilities };
        const detail = await this.withAccount(
            match,
            fetchDetail,
            (account, checkedFetch, confirm) =>
                this.detailService.getOrFetch(
                    `${this.snapshotKey(match, account, hash)}#detail`,
                    checkedFetch,
                    serve,
                    options,
                    confirm,
                ),
            (error) => attach(floorDetail(unavailableSnapshot(hash, error), provider.id), serve),
        );
        if (!this.isCurrent(ctx, providerGeneration)) return this.discard(ctx, hash, provider.id);
        return detail;
    }

    /**
     * Whether a detail operation may still publish: same auth and lifecycle generations,
     * and the coordinator still serves the repository it started for. The surface that
     * publishes also compares `ctx.repoKey` with the repository it shows.
     */
    private isCurrent(ctx: CiOperationContext, providerGeneration: number): boolean {
        if (providerGeneration !== this.providerGeneration) return false;
        return this.generations?.isCurrent(ctx, ctx.repoKey) ?? true;
    }

    private discard(ctx: CiOperationContext, hash: string, provider?: ProviderId): undefined {
        this.trace?.({
            kind: "detail",
            outcome: "discarded-generation",
            repoKey: ctx.repoKey,
            provider,
            hash,
        });
        return undefined;
    }

    /**
     * Drops the snapshot and the detail of one commit from every cache layer, so the
     * next fetch starts a new request and cannot bring an older result back.
     *
     * @param hash - Full Git commit hash.
     */
    async invalidate(hash: string): Promise<void> {
        const match = await this.resolveEnabledMatch();
        if (!match) return;
        const snapshotKey = this.snapshotKey(match, await this.readAccount(match), hash);
        await this.service.invalidate(snapshotKey);
        await this.detailService.invalidate(`${snapshotKey}#detail`);
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
            match = await this.resolveEnabledMatch();
        } catch (err) {
            return unavailableSnapshot(hash, getErrorMessage(err));
        }
        if (!match) return this.noneSnapshot(hash);
        const snapshot = await this.fetchSnapshot(match, hash, options);
        // The repository changed during the fetch: this answer belongs to the old one, and
        // is dropped the same way a stale provider resolution is.
        if (providerGeneration !== this.providerGeneration) {
            this.trace?.({
                kind: "snapshot",
                outcome: "discarded-generation",
                provider: match.provider.id,
                hash,
            });
            return this.noneSnapshot(hash);
        }
        return snapshot;
    }

    /**
     * Resolves the provider for the current repository generation, or null when none
     * applies. Throws when the remotes cannot be read.
     */
    private async resolveEnabledMatch(): Promise<ProviderMatch | null> {
        const providerGeneration = this.providerGeneration;
        const match = await this.resolveProvider();
        // The repository changed while resolving: this match belongs to the old one.
        if (providerGeneration !== this.providerGeneration) return null;
        // No registered provider matched any remote (an unmapped self-hosted host, or
        // an unsupported forge). That is a configuration state, not a recoverable
        // error: yield no badge (state "none"), the same as a disabled provider. An
        // "unavailable" error badge here would be permanent — re-fetching can never
        // map the host — and the UI only hides "none".
        if (!match) return null;
        // Hard-stop: the origin-first matched provider is disabled. Yield no badge and
        // do NOT fall through to a later remote's enabled provider — the badge stays
        // tied to origin, not to whichever remote happens to be on.
        if (this.providerEnabled[match.provider.id] === false) return null;
        return match;
    }

    /**
     * Every cache key ends in the signed-in account, so saved results of another account,
     * including ones a failed clear left on disk, never match.
     */
    private snapshotKey(match: ProviderMatch, account: string | undefined, hash: string): string {
        const suffix = account === undefined ? "" : `|${account}`;
        return `${match.provider.keyFor(match.ref)}@${hash}:${this.settingsFingerprint}${suffix}`;
    }

    /** Reads the signed-in account now; never memoized, so a sign-in change applies at once. */
    private async readAccount(match: ProviderMatch): Promise<string | undefined> {
        return match.provider.accountKey?.(match.ref);
    }

    /**
     * Runs one cache operation under the account read now. `run` gets a fetcher that reads
     * the account again when `fetch` returns (a fenced re-ask included); if it changed,
     * that fetcher throws instead of returning, so nothing is stored under the old
     * account's key. `run` also gets `confirm`, which the cache calls once the answer is
     * saved: a change by then makes the cache remove that saved answer. The account is
     * read once more when `run` returns (a saved answer read from disk may finish after a
     * switch). Any change starts the operation over under the new account; when the tries
     * run out the caller gets `unavailable` and no try's answer stays saved.
     */
    private async withAccount<R, T>(
        match: ProviderMatch,
        fetch: () => Promise<R>,
        run: (
            account: string | undefined,
            checkedFetch: () => Promise<R>,
            confirm: () => Promise<void>,
        ) => Promise<T>,
        unavailable: (error: string) => T,
    ): Promise<T> {
        for (let attempt = 1; attempt <= ACCOUNT_ATTEMPTS; attempt += 1) {
            const account = await this.readAccount(match);
            const confirm = async (): Promise<void> => {
                if ((await this.readAccount(match)) !== account) throw new AccountChangedError();
            };
            const checkedFetch = async (): Promise<R> => {
                const result = await fetch();
                await confirm();
                return result;
            };
            try {
                const result = await run(account, checkedFetch, confirm);
                await confirm();
                return result;
            } catch (err) {
                if (!(err instanceof AccountChangedError)) throw err;
            }
        }
        return unavailable(vscode.l10n.t("The signed-in account changed during the request."));
    }

    private fetchSnapshot(
        match: ProviderMatch,
        hash: string,
        options: CommitChecksFetchOptions,
    ): Promise<CommitChecksSnapshot> {
        const fetchChecks = async (): Promise<CommitChecksSnapshot> => {
            try {
                return await match.provider.getChecks(match.ref, hash);
            } catch (err) {
                return unavailableSnapshot(hash, getErrorMessage(err));
            }
        };
        return this.withAccount(
            match,
            fetchChecks,
            (account, checkedFetch, confirm) =>
                this.service.getOrFetch(
                    this.snapshotKey(match, account, hash),
                    checkedFetch,
                    options,
                    match.provider.id,
                    confirm,
                ),
            (error) => unavailableSnapshot(hash, error),
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

/**
 * Builds the flat detail of a provider without its own `getDetail`: no runs, every
 * snapshot item as a flat check, complete exactly when the snapshot is.
 */
function floorDetail(snapshot: CommitChecksSnapshot, provider: ProviderId): CommitCiDetailData {
    return {
        hash: snapshot.hash,
        provider,
        complete: isCompleteSnapshot(snapshot),
        outcome: snapshot.state,
        runs: [],
        runsCoverage: "full",
        otherChecks: snapshot.items.map((item) => ({
            id: item.id,
            logicalId: item.logicalId,
            name: item.name,
            description: item.description,
            state: item.state,
            source: item.source,
            url: item.url,
        })),
        // A snapshot reports no truncation.
        otherChecksCoverage: "full",
        error: snapshot.error,
        signInHost: snapshot.signInHost,
    };
}
