// Long-lived request gates for commit-check HTTP calls. Every provider/API-origin
// bucket caps concurrent automatic work and shares server-directed cooldowns.

import { getErrorMessage } from "../../utils/errors";
import { HttpError, type HttpResponseMetadata } from "./http";
import type { ProviderId } from "./types";

type HttpHeaders = Record<string, string | string[] | undefined>;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const MAX_AUTOMATIC_REQUESTS_PER_WINDOW = 300;
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
        try {
            this.pruneStartedAt();
            this.throwIfCoolingDown();
            this.throwIfRequestBudgetExhausted();
            this.startedAt.push(this.now());
            return await task(this.generation);
        } catch (err) {
            this.rememberCooldown(err);
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
        const resetAt = readProviderResetAt(metadata.headers, "github");
        if (resetAt > 0) this.rateResetAt = resetAt;

        const reserve = Math.max(
            MIN_PRIMARY_RESERVE,
            Math.ceil(this.rateLimit * PRIMARY_RESERVE_RATIO),
        );
        if (
            this.rateRemaining !== undefined &&
            this.rateRemaining <= reserve &&
            this.rateResetAt > this.now()
        ) {
            this.activateGenericCooldown(this.rateResetAt);
        }
    }

    private observeGitLabResponse(metadata: HttpResponseMetadata): void {
        const limit = readNonNegativeHeader(metadata.headers, "ratelimit-limit");
        const remaining = readNonNegativeHeader(metadata.headers, "ratelimit-remaining");
        const resetAt = readProviderResetAt(metadata.headers, "gitlab");
        if (
            limit !== undefined &&
            remaining !== undefined &&
            remaining <= Math.max(1, Math.ceil(limit * PRIMARY_RESERVE_RATIO)) &&
            resetAt > this.now()
        ) {
            this.activateGenericCooldown(resetAt);
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
        if (this.startedAt.length < MAX_AUTOMATIC_REQUESTS_PER_WINDOW) return;
        this.activateGenericCooldown(this.startedAt[0] + REQUEST_WINDOW_MS);
        this.throwIfCoolingDown();
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
    const retryAfter = readRetryAfter(headerValue(metadata.headers, "retry-after"), now);
    if (retryAfter > now) return retryAfter;

    const resetAt = readProviderResetAt(metadata.headers, providerId);
    if (
        resetAt > now &&
        (metadata.statusCode === 429 ||
            headerValue(metadata.headers, "x-ratelimit-remaining") === "0")
    ) {
        return resetAt;
    }
    return metadata.statusCode === 429 ? now + 60_000 : 0;
}

function readProviderResetAt(headers: HttpHeaders, providerId: ProviderId): number {
    const name = providerId === "gitlab" ? "ratelimit-reset" : "x-ratelimit-reset";
    const value = headerValue(headers, name);
    if (!value?.trim()) return 0;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? dateMs : 0;
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
