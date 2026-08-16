// Long-lived request gates for commit-check HTTP calls. Every provider/API-origin
// bucket caps concurrent automatic work and shares server-directed cooldowns.

import { getErrorMessage } from "../../utils/errors";
import { HttpError, type HttpResponseMetadata } from "./http";
import type { ProviderId } from "./types";

type HttpHeaders = Record<string, string | string[] | undefined>;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
// Fallback ceiling for a bucket that has never observed a usable server quota pair. Once a bucket
// learns its real limit and remaining count, only the reserve-based cooldown and 429/Retry-After
// handling govern it; see ProviderRequestGate.hasObservedQuota.
const MAX_AUTOMATIC_REQUESTS_PER_WINDOW = 300;
/**
 * Absolute ceiling for a bucket that does report a usable quota.
 *
 * The server's advertised limit governs below this; the constant only stops a server that
 * advertises an implausible one from removing the client-side bound altogether.
 */
export const MAX_OBSERVED_REQUESTS_PER_WINDOW = 5_000;
// How far ahead a reset may sit and still be believed as this bucket's quota window. No provider's
// window runs longer than an hour, so a day of slack absorbs clock skew while still rejecting a
// value that would hold an earned cap bypass open forever: `seconds * 1000` overflows to Infinity
// for an absurd header, and every `> now()` test accepts Infinity. Cooldowns deliberately do not
// use this horizon -- see clampCooldown for why they must fail the other way.
const MAX_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 4;
const MIN_PRIMARY_RESERVE = 100;
const PRIMARY_RESERVE_RATIO = 0.1;

/**
 * Registry of provider and API-origin request gates.
 *
 * Each `(providerId, URL origin)` pair receives independent concurrency, rolling-start, and
 * cooldown state. `cooldownMessage` is injected so this transport-only service stays independent
 * from VS Code and future localization wiring.
 */
export class CommitChecksRequestGateRegistry {
    private readonly gates = new Map<string, ProviderRequestGate>();

    /**
     * Creates a registry with a caller-owned cooldown message and optional test clock.
     *
     * @param cooldownMessage - Safe message used when no server response detail is available.
     * @param now - Injectable clock for cooldown and rolling-window calculations.
     */
    constructor(
        private readonly cooldownMessage: string,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Runs an automatic request through the gate for its provider/API-origin bucket.
     *
     * @param providerId - Commit-check provider that owns the request.
     * @param url - Full API URL used to determine the origin-specific bucket.
     * @param task - HTTP task; never invoked while its bucket is blocked. It receives the bucket
     *   generation captured after acquiring capacity, which response observers use to reject stale
     *   metadata after a reset.
     * @returns The HTTP task result.
     * @throws HttpError with status 429 while the bucket is cooling down.
     */
    run<T>(
        providerId: ProviderId,
        url: string,
        task: (generation: number) => Promise<T>,
    ): Promise<T> {
        return this.gateFor(providerId, url).run(task);
    }

    /**
     * Records token-free HTTP response metadata against the response's provider/API-origin bucket.
     *
     * @param providerId - Commit-check provider that received the response.
     * @param metadata - Response facts emitted by the shared HTTP helper.
     * @param generation - Optional task generation. Tagged production metadata is ignored when a
     *   reset has advanced the live bucket generation.
     */
    observeResponse(
        providerId: ProviderId,
        metadata: HttpResponseMetadata,
        generation?: number,
    ): void {
        const key = this.keyFor(providerId, metadata.url);
        const gate = this.gates.get(key);
        if (gate) {
            gate.observeResponse(metadata, generation);
            return;
        }
        // Legacy callers do not tag metadata, so preserve their ability to seed a bucket. Tagged
        // metadata is always from an already-started task and must not recreate a reset bucket.
        if (generation === undefined)
            this.gateFor(providerId, metadata.url).observeResponse(metadata);
    }

    /**
     * Clears quota and cooldown state after a credential or configuration change.
     *
     * Idle buckets are discarded, while busy buckets retain their active tasks and waiters so a
     * reset cannot create a second concurrency pool for the same provider/API origin.
     */
    reset(): void {
        for (const [key, gate] of this.gates) {
            gate.reset();
            if (gate.isIdle()) this.gates.delete(key);
        }
    }

    private gateFor(providerId: ProviderId, url: string): ProviderRequestGate {
        const key = this.keyFor(providerId, url);
        let gate = this.gates.get(key);
        if (!gate) {
            gate = new ProviderRequestGate(
                providerId,
                MAX_CONCURRENT_REQUESTS,
                this.cooldownMessage,
                this.now,
            );
            this.gates.set(key, gate);
        }
        return gate;
    }

    private keyFor(providerId: ProviderId, url: string): string {
        return `${providerId}:${new URL(url).origin.toLowerCase()}`;
    }
}

/**
 * Backward-compatible GitHub-only facade until activation wiring moves to the provider registry.
 *
 * New callers should use `CommitChecksRequestGateRegistry` so self-hosted providers cannot share
 * rate state accidentally. This facade retains the existing constructor and observer boundary.
 */
export class GitHubRequestGate {
    private readonly gate: ProviderRequestGate;

    /**
     * Creates the legacy GitHub facade.
     *
     * @param limit - Maximum concurrent GitHub requests.
     * @param now - Injectable clock for tests.
     */
    constructor(limit: number, now: () => number = Date.now) {
        this.gate = new ProviderRequestGate(
            "github",
            limit,
            "GitHub rate limit cooldown is active.",
            now,
        );
    }

    /**
     * Runs one GitHub request through the compatibility gate.
     *
     * Legacy callers receive 403 only when this gate blocks before their task starts. HTTP errors
     * thrown by a started task retain their original status code for provider-level handling.
     */
    async run<T>(task: () => Promise<T>): Promise<T> {
        let taskStarted = false;
        try {
            return await this.gate.run(async () => {
                taskStarted = true;
                return task();
            });
        } catch (error) {
            if (!taskStarted && error instanceof HttpError && error.statusCode === 429) {
                throw new HttpError(403, error.message, error.headers);
            }
            throw error;
        }
    }

    /** Records GitHub response quota metadata through the compatibility gate. */
    observeResponse(metadata: HttpResponseMetadata): void {
        this.gate.observeResponse(metadata);
    }

    /** Clears the GitHub compatibility gate after an authentication change. */
    reset(): void {
        this.gate.reset();
    }
}

/** One provider/API-origin bucket with policy-specific response handling. */
class ProviderRequestGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private cooldownUntil = 0;
    private cooldownError = "";
    private readonly startedAt: number[] = [];
    private generation = 0;
    private rateLimit = 0;
    private rateRemaining: number | undefined;
    private rateResetAt = 0;
    // Earned only by parsing a usable limit+remaining pair AND a future reset for this provider;
    // never granted by provider identity or by default. Providers that parse no such pair (or only
    // a boolean near-limit signal) can never set this, so they stay on the static fallback cap.
    //
    // The reset is part of the bargain, not a detail: surrendering the fallback cap leaves the
    // reserve cooldown as the sole guard, and that cooldown cannot arm without a future reset. A
    // reset beyond MAX_RESET_HORIZON_MS does not count as usable, because an out-of-horizon value
    // stays in the future forever.
    //
    // This flag alone does not bound the bypass, and must not be read as if it did. It is
    // re-evaluated per observation, but only when an observation arrives: a header-less response
    // leaves the sticky GitHub quota triple untouched, and a bucket whose requests all fail at the
    // transport layer is never observed at all. Liveness is therefore re-derived where it is used,
    // in automaticRequestCeiling, rather than trusted from here.
    private hasObservedQuota = false;

    constructor(
        private readonly providerId: ProviderId,
        private readonly limit: number,
        private readonly cooldownMessage: string,
        private readonly now: () => number,
    ) {}

    async run<T>(task: (generation: number) => Promise<T>): Promise<T> {
        this.pruneStartedAt();
        this.throwIfCoolingDown();
        this.throwIfRequestBudgetExhausted();
        await this.acquire();
        let taskGeneration: number | undefined;
        try {
            this.pruneStartedAt();
            this.throwIfCoolingDown();
            this.throwIfRequestBudgetExhausted();
            const generation = this.generation;
            taskGeneration = generation;
            this.startedAt.push(this.now());
            return await task(generation);
        } catch (err) {
            if (taskGeneration === this.generation) this.rememberCooldown(err);
            throw err;
        } finally {
            this.release();
        }
    }

    observeResponse(metadata: HttpResponseMetadata, generation?: number): void {
        if (generation !== undefined && generation !== this.generation) return;
        if (metadata.statusCode === 429) {
            this.activateGenericCooldown(readCooldownUntil(metadata, this.providerId, this.now()));
            return;
        }
        if (metadata.statusCode === 403 && this.providerId !== "github") return;

        switch (this.providerId) {
            case "github":
                this.observeGitHubResponse(metadata);
                return;
            case "gitlab":
                this.observeGitLabResponse(metadata);
                return;
            case "bitbucket-cloud":
                if (
                    headerValue(metadata.headers, "x-ratelimit-nearlimit")?.trim().toLowerCase() ===
                    "true"
                ) {
                    this.activateGenericCooldown(this.now() + REQUEST_WINDOW_MS);
                }
                return;
            case "bitbucket-server":
                return;
        }
    }

    reset(): void {
        this.generation += 1;
        this.startedAt.length = 0;
        this.rateLimit = 0;
        this.rateRemaining = undefined;
        this.rateResetAt = 0;
        this.hasObservedQuota = false;
        this.cooldownUntil = 0;
        this.cooldownError = "";
    }

    /** Returns whether this bucket has neither in-flight tasks nor queued waiters. */
    isIdle(): boolean {
        return this.active === 0 && this.waiters.length === 0;
    }

    private observeGitHubResponse(metadata: HttpResponseMetadata): void {
        const limit = readNonNegativeHeader(metadata.headers, "x-ratelimit-limit");
        if (limit !== undefined) this.rateLimit = limit;
        const remaining = readNonNegativeHeader(metadata.headers, "x-ratelimit-remaining");
        if (remaining !== undefined) this.rateRemaining = remaining;
        const resetAt = withinResetHorizon(
            readProviderResetAt(metadata.headers, "github"),
            this.now(),
        );
        if (resetAt > 0) this.rateResetAt = resetAt;
        this.hasObservedQuota =
            this.rateLimit > 0 && this.rateRemaining !== undefined && this.rateResetAt > this.now();

        const reserve = Math.max(
            MIN_PRIMARY_RESERVE,
            Math.ceil(this.rateLimit * PRIMARY_RESERVE_RATIO),
        );
        if (
            this.rateRemaining !== undefined &&
            this.rateRemaining <= reserve &&
            this.rateResetAt > this.now()
        ) {
            this.activateGenericCooldown(clampCooldown(this.rateResetAt, this.now()));
        }
    }

    private observeGitLabResponse(metadata: HttpResponseMetadata): void {
        // Limit and reset are stored rather than kept local because automaticRequestCeiling reads
        // both to decide whether this bucket still holds a live quota; a provider that left either
        // unwritten would be judged against a field it never set. Remaining stays local: the
        // reserve check below is its only reader on this path.
        const limit = readNonNegativeHeader(metadata.headers, "ratelimit-limit");
        if (limit !== undefined) this.rateLimit = limit;
        const remaining = readNonNegativeHeader(metadata.headers, "ratelimit-remaining");
        const resetAt = withinResetHorizon(
            readProviderResetAt(metadata.headers, "gitlab"),
            this.now(),
        );
        if (resetAt > 0) this.rateResetAt = resetAt;
        this.hasObservedQuota =
            limit !== undefined && limit > 0 && remaining !== undefined && resetAt > this.now();
        if (
            limit !== undefined &&
            remaining !== undefined &&
            remaining <= Math.max(1, Math.ceil(limit * PRIMARY_RESERVE_RATIO)) &&
            resetAt > this.now()
        ) {
            this.activateGenericCooldown(clampCooldown(resetAt, this.now()));
        }
    }

    private async acquire(): Promise<void> {
        if (this.active < Math.max(1, this.limit)) {
            this.active += 1;
            return;
        }
        await new Promise<void>((resolve) => {
            this.waiters.push(resolve);
        });
    }

    private release(): void {
        const next = this.waiters.shift();
        if (next) {
            next();
            return;
        }
        this.active -= 1;
    }

    private throwIfCoolingDown(): void {
        if (this.now() < this.cooldownUntil) {
            throw new HttpError(429, this.cooldownError || this.cooldownMessage, {});
        }
    }

    private rememberCooldown(reason: unknown): void {
        if (!isCooldownError(reason, this.providerId)) return;
        const until = readCooldownUntil(reason, this.providerId, this.now());
        if (until < this.cooldownUntil || (until === this.cooldownUntil && this.cooldownError)) {
            return;
        }
        this.cooldownUntil = until;
        this.cooldownError = getErrorMessage(reason);
    }

    private pruneStartedAt(): void {
        const expiresAt = this.now() - REQUEST_WINDOW_MS;
        while (this.startedAt[0] !== undefined && this.startedAt[0] <= expiresAt) {
            this.startedAt.shift();
        }
    }

    private throwIfRequestBudgetExhausted(): void {
        if (this.startedAt.length < this.automaticRequestCeiling()) return;
        this.activateGenericCooldown(this.startedAt[0] + REQUEST_WINDOW_MS);
        this.throwIfCoolingDown();
    }

    /**
     * Requests this bucket may start per rolling window.
     *
     * A bucket reporting a live quota is governed by the reserve cooldown rather than the static
     * fallback, so its ceiling follows the advertised limit. It keeps a ceiling either way: that
     * cooldown is driven entirely by server-supplied numbers, so a server reporting plenty would
     * otherwise leave no client-side bound at all.
     *
     * Liveness is re-derived here rather than taken from hasObservedQuota, which only changes when
     * a response is observed. The cases most worth bounding are the ones where responses stop
     * arriving -- a connection that fails at the transport layer never reaches the observer -- so
     * reading the flag alone would let a bucket keep a raised ceiling for as long as it stayed
     * broken.
     *
     * The advertised limit can only raise the ceiling, never lower it. A provider whose window is
     * shorter than REQUEST_WINDOW_MS advertises a number smaller than this window's budget, and
     * honouring that literally would throttle a bucket below the fallback that governs one which
     * reported no quota at all.
     */
    private automaticRequestCeiling(): number {
        if (!this.hasObservedQuota || this.rateResetAt <= this.now()) {
            return MAX_AUTOMATIC_REQUESTS_PER_WINDOW;
        }
        return Math.max(
            MAX_AUTOMATIC_REQUESTS_PER_WINDOW,
            Math.min(this.rateLimit, MAX_OBSERVED_REQUESTS_PER_WINDOW),
        );
    }

    private activateGenericCooldown(until: number): void {
        if (until <= this.cooldownUntil) return;
        this.cooldownUntil = until;
        this.cooldownError = "";
    }
}

function isCooldownError(reason: unknown, providerId: ProviderId): reason is HttpError {
    return (
        reason instanceof HttpError &&
        (reason.statusCode === 429 || (providerId === "github" && reason.statusCode === 403))
    );
}

function readCooldownUntil(
    metadata: Pick<HttpResponseMetadata, "statusCode" | "headers">,
    providerId: ProviderId,
    now: number,
): number {
    const retryAfter = clampCooldown(
        readRetryAfter(headerValue(metadata.headers, "retry-after"), now),
        now,
    );
    if (retryAfter > now) return retryAfter;

    const resetAt = clampCooldown(readProviderResetAt(metadata.headers, providerId), now);
    if (
        resetAt > now &&
        (metadata.statusCode === 429 ||
            headerValue(metadata.headers, "x-ratelimit-remaining") === "0")
    ) {
        return resetAt;
    }
    return metadata.statusCode === 429 ? now + 60_000 : 0;
}

/**
 * Parses a provider reset header into an absolute instant, or 0 when it carries no usable value.
 *
 * The instant is returned unbounded, Infinity included: callers decide what an implausible value
 * means, and the two callers need opposite answers.
 */
function readProviderResetAt(headers: HttpHeaders, providerId: ProviderId): number {
    const name = providerId === "gitlab" ? "ratelimit-reset" : "x-ratelimit-reset";
    const value = headerValue(headers, name);
    if (!value?.trim()) return 0;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? dateMs : 0;
}

/**
 * Returns an instant only when it could be a real provider reset, and 0 otherwise.
 *
 * For decisions an out-of-horizon value should *withhold*: the cap bypass requires a future reset,
 * so discarding the value denies the bypass. Cooldowns need the opposite; see clampCooldown.
 */
function withinResetHorizon(instant: number, now: number): number {
    return Number.isFinite(instant) && instant <= now + MAX_RESET_HORIZON_MS ? instant : 0;
}

/**
 * Bounds a server-directed cooldown to one request window.
 *
 * Cooldowns cannot share withinResetHorizon, because they fail safe in the opposite direction.
 * Discarding an out-of-horizon value withholds a permission there; here it would discard the
 * backoff itself, drop to the 60-second fallback, and resume knocking on a server that asked for a
 * day. Clamping instead honours as much of the demand as any real window can justify, and a
 * provider that still wants more re-arms this from its next response.
 */
function clampCooldown(instant: number, now: number): number {
    if (Number.isNaN(instant) || instant <= now) return 0;
    return Math.min(instant, now + REQUEST_WINDOW_MS);
}

function headerValue(headers: HttpHeaders, name: string): string | undefined {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

function readNonNegativeHeader(headers: HttpHeaders, name: string): number | undefined {
    const value = headerValue(headers, name);
    if (!value?.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readRetryAfter(value: string | undefined, now: number): number {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isInteger(seconds) && seconds >= 0) return now + seconds * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? dateMs : 0;
}
