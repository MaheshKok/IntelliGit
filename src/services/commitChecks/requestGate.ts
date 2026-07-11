// Long-lived request gate for GitHub commit-check HTTP calls. It caps concurrent
// requests and shares GitHub's rate-limit cooldown across every graph surface.

import { getErrorMessage } from "../../utils/errors";
import { HttpError, type HttpResponseMetadata } from "./http";

type HttpHeaders = Record<string, string | string[] | undefined>;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const MAX_AUTOMATIC_REQUESTS_PER_WINDOW = 300;
const MIN_PRIMARY_RESERVE = 100;
const PRIMARY_RESERVE_RATIO = 0.1;

/**
 * Shared GitHub request gate with concurrency, rolling automatic-request, and quota reserve limits.
 *
 * This gate protects a GitHub account from background badge refreshes. It is not an authorization
 * boundary: server headers are untrusted scheduling hints and provider authentication remains separate.
 */
export class GitHubRequestGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private cooldownUntil = 0;
    private cooldownError = "";
    private readonly startedAt: number[] = [];
    private rateLimit = 0;
    private rateRemaining: number | undefined;
    private rateResetAt = 0;

    /**
     * Creates a long-lived gate.
     *
     * @param limit - Maximum concurrent requests.
     * @param now - Injectable clock for tests.
     */
    constructor(
        private readonly limit: number,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Runs an automatic GitHub request after concurrency, cooldown, and budget checks.
     *
     * @param task - HTTP task to execute; it is never invoked if a gate check blocks it.
     * @returns The task result.
     * @throws HttpError while a GitHub cooldown is active.
     */
    async run<T>(task: () => Promise<T>): Promise<T> {
        this.pruneStartedAt();
        this.throwIfCoolingDown();
        this.throwIfRequestBudgetExhausted();
        await this.acquire();
        try {
            this.pruneStartedAt();
            this.throwIfCoolingDown();
            this.throwIfRequestBudgetExhausted();
            this.startedAt.push(this.now());
            return await task();
        } catch (err) {
            this.rememberCooldown(err);
            throw err;
        } finally {
            this.release();
        }
    }

    /**
     * Records token-free GitHub response quota metadata for later automatic requests.
     *
     * Only finite, non-negative header values are retained. A remaining quota at the configured
     * reserve starts a generic cooldown through the server-provided future reset time.
     */
    observeResponse(metadata: HttpResponseMetadata): void {
        const limit = readNonNegativeHeader(metadata.headers, "x-ratelimit-limit");
        if (limit !== undefined) this.rateLimit = limit;
        const remaining = readNonNegativeHeader(metadata.headers, "x-ratelimit-remaining");
        if (remaining !== undefined) this.rateRemaining = remaining;
        const resetSeconds = readNonNegativeHeader(metadata.headers, "x-ratelimit-reset");
        if (resetSeconds !== undefined) {
            const resetAt = resetSeconds * 1000;
            if (Number.isFinite(resetAt)) this.rateResetAt = resetAt;
        }

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

    /** Clears server-observed quota, local starts, and every active cooldown after auth changes. */
    reset(): void {
        this.startedAt.length = 0;
        this.rateLimit = 0;
        this.rateRemaining = undefined;
        this.rateResetAt = 0;
        this.cooldownUntil = 0;
        this.cooldownError = "";
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
            throw new HttpError(
                403,
                this.cooldownError || "GitHub rate limit cooldown is active.",
                {},
            );
        }
    }

    private rememberCooldown(reason: unknown): void {
        const until = readRateLimitUntil(reason, this.now());
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

function readRateLimitUntil(reason: unknown, now: number): number {
    if (
        !(reason instanceof HttpError) ||
        (reason.statusCode !== 403 && reason.statusCode !== 429)
    ) {
        return 0;
    }
    const retryAfter = readRetryAfter(headerValue(reason.headers, "retry-after"), now);
    if (retryAfter > now) return retryAfter;
    if (headerValue(reason.headers, "x-ratelimit-remaining") === "0") {
        const resetSeconds = Number(headerValue(reason.headers, "x-ratelimit-reset"));
        const resetMs = Number.isFinite(resetSeconds) ? resetSeconds * 1000 : 0;
        if (resetMs > now) return resetMs;
    }
    return reason.statusCode === 429 ? now + 60_000 : 0;
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
    if (Number.isFinite(seconds)) return now + seconds * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? dateMs : 0;
}
