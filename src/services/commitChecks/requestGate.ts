// Long-lived request gate for GitHub commit-check HTTP calls. It caps concurrent
// requests and shares GitHub's rate-limit cooldown across every graph surface.

import { getErrorMessage } from "../../utils/errors";
import { HttpError } from "./http";

type HttpHeaders = Record<string, string | string[] | undefined>;

/** Shared GitHub request gate with a semaphore and server-driven cooldown. */
export class GitHubRequestGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private cooldownUntil = 0;
    private cooldownError = "";

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
     * Runs a request after concurrency and cooldown checks.
     *
     * @param task - HTTP task to execute.
     * @returns The task result.
     * @throws HttpError while a GitHub cooldown is active.
     */
    async run<T>(task: () => Promise<T>): Promise<T> {
        this.throwIfCoolingDown();
        await this.acquire();
        try {
            this.throwIfCoolingDown();
            return await task();
        } catch (err) {
            this.rememberCooldown(err);
            throw err;
        } finally {
            this.release();
        }
    }

    private async acquire(): Promise<void> {
        if (this.active >= Math.max(1, this.limit)) {
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
        this.active += 1;
    }

    private release(): void {
        this.active -= 1;
        this.waiters.shift()?.();
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
        if (until <= this.cooldownUntil) return;
        this.cooldownUntil = until;
        this.cooldownError = getErrorMessage(reason);
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

function readRetryAfter(value: string | undefined, now: number): number {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return now + seconds * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? dateMs : 0;
}
