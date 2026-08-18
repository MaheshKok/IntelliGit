import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../src/services/commitChecks/http";
import {
    CommitChecksRequestGateRegistry,
    GitHubRequestGate,
    MAX_OBSERVED_REQUESTS_PER_WINDOW,
} from "../../../../src/services/commitChecks/requestGate";

const GITHUB_API_URL = "https://api.github.com/repos/acme/repo/commits/main/status";
const COOLDOWN_MESSAGE = "Commit checks rate limit cooldown is active.";
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

describe("GitHubRequestGate", () => {
    it("caps concurrent requests", async () => {
        const gate = new GitHubRequestGate(4);
        let active = 0;
        let maxActive = 0;

        await Promise.all(
            Array.from({ length: 10 }, () =>
                gate.run(async () => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    active -= 1;
                }),
            ),
        );

        expect(maxActive).toBeLessThanOrEqual(4);
    });

    it("shares GitHub primary rate-limit cooldown across later callers", async () => {
        let clock = 1_000;
        const gate = new GitHubRequestGate(4, () => clock);
        const limited = new HttpError(403, "HTTP 403: API rate limit exceeded", {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "61",
        });
        await expect(
            gate.run(async () => {
                throw limited;
            }),
        ).rejects.toThrow("HTTP 403: API rate limit exceeded");

        const task = vi.fn(async () => "ok");
        await expect(gate.run(task)).rejects.toMatchObject({
            statusCode: 403,
            message: "HTTP 403: API rate limit exceeded",
        });
        expect(task).not.toHaveBeenCalled();

        clock = 61_001;
        await expect(gate.run(task)).resolves.toBe("ok");
        expect(task).toHaveBeenCalledTimes(1);
    });

    it("preserves a primary 403 detail when response metadata activates the same cooldown", async () => {
        const gate = new GitHubRequestGate(4, () => 1_000);
        const headers = {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "3600",
        };
        const primary = new HttpError(403, "HTTP 403: API rate limit exceeded", headers);

        await expect(
            gate.run(async () => {
                gate.observeResponse({ url: GITHUB_API_URL, statusCode: 403, headers });
                throw primary;
            }),
        ).rejects.toThrow("HTTP 403: API rate limit exceeded");

        const task = vi.fn(async () => "ok");
        await expect(gate.run(task)).rejects.toThrow("HTTP 403: API rate limit exceeded");
        expect(task).not.toHaveBeenCalled();
    });

    it("allows a request when the observed primary quota exceeds its reserve", async () => {
        const gate = new GitHubRequestGate(4, () => 1_000);
        gate.observeResponse({
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "501",
                "x-ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        await expect(gate.run(task)).resolves.toBe("ok");
        expect(task).toHaveBeenCalledTimes(1);
    });

    it.each([
        { limit: "5000", remaining: "500" },
        { limit: "1000", remaining: "100" },
    ])(
        "blocks a request when observed remaining quota reaches its reserve",
        async ({ limit, remaining }) => {
            const gate = new GitHubRequestGate(4, () => 1_000);
            gate.observeResponse({
                url: GITHUB_API_URL,
                statusCode: 200,
                headers: {
                    "x-ratelimit-limit": limit,
                    "x-ratelimit-remaining": remaining,
                    "x-ratelimit-reset": "3600",
                },
            });
            const task = vi.fn(async () => "ok");

            await expect(gate.run(task)).rejects.toThrow("GitHub rate limit cooldown is active.");
            expect(task).not.toHaveBeenCalled();
        },
    );

    it("blocks request 301 in a rolling hour and allows the next request after the oldest expires", async () => {
        let clock = 1_000;
        const gate = new GitHubRequestGate(4, () => clock);
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(gate.run(task)).resolves.toBe("ok");
        }
        await expect(gate.run(task)).rejects.toThrow("GitHub rate limit cooldown is active.");
        expect(task).toHaveBeenCalledTimes(300);

        clock += 60 * 60 * 1000 + 1;
        await expect(gate.run(task)).resolves.toBe("ok");
        expect(task).toHaveBeenCalledTimes(301);
    });

    it("does not invoke a blocked task or consume the rolling request budget", async () => {
        let clock = 1_000;
        const gate = new GitHubRequestGate(4, () => clock);
        gate.observeResponse({
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                // No x-ratelimit-limit observed: this bucket stays in the fallback state, so the
                // default MIN_PRIMARY_RESERVE (100) cooldown threshold applies, and it must not
                // earn the local cap bypass tested separately below.
                "x-ratelimit-remaining": "50",
                "x-ratelimit-reset": "3600",
            },
        });
        const blockedTask = vi.fn(async () => "blocked");

        await expect(gate.run(blockedTask)).rejects.toThrow(
            "GitHub rate limit cooldown is active.",
        );
        expect(blockedTask).not.toHaveBeenCalled();

        clock = 3_600_001;
        const task = vi.fn(async () => "ok");
        for (let index = 0; index < 300; index += 1) {
            await expect(gate.run(task)).resolves.toBe("ok");
        }
        await expect(gate.run(task)).rejects.toThrow("GitHub rate limit cooldown is active.");
    });

    it("keeps the fallback cap when a quota tuple is spread across two responses", async () => {
        const gate = new GitHubRequestGate(4, () => 1_000);
        // Neither response advertises a usable quota by itself: the first names a limit with no
        // remaining or reset, the second a remaining and reset with no limit. Because each field
        // is sticky, the pair can look like one coherent 5000/hour budget that no response ever
        // stated. Raising the ceiling is a permission, so it has to be earned by a single
        // response -- which is what observeGitLabResponse already requires.
        gate.observeResponse({
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: { "x-ratelimit-limit": "5000" },
        });
        gate.observeResponse({
            url: GITHUB_API_URL,
            statusCode: 200,
            // Well clear of the 500 reserve for a 5000 limit, so a reserve cooldown cannot be
            // what stops the run below and counterfeit the cap.
            headers: { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": "3600" },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(gate.run(task)).resolves.toBe("ok");
        }
        await expect(gate.run(task)).rejects.toThrow("GitHub rate limit cooldown is active.");
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("reset clears observed quota and rolling request starts", async () => {
        const gate = new GitHubRequestGate(4, () => 1_000);
        gate.observeResponse({
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "3600",
            },
        });
        gate.reset();
        const task = vi.fn(async () => "ok");

        await expect(gate.run(task)).resolves.toBe("ok");
        for (let index = 1; index < 300; index += 1) {
            await expect(gate.run(task)).resolves.toBe("ok");
        }
        await expect(gate.run(task)).rejects.toThrow("GitHub rate limit cooldown is active.");

        gate.reset();
        await expect(gate.run(task)).resolves.toBe("ok");
    });

    it("shares a GitHub secondary retry-after cooldown across later callers", async () => {
        let clock = 1_000;
        const gate = new GitHubRequestGate(4, () => clock);
        await expect(
            gate.run(async () => {
                throw new HttpError(403, "HTTP 403: secondary rate limit", { "retry-after": "60" });
            }),
        ).rejects.toThrow("HTTP 403: secondary rate limit");

        const task = vi.fn(async () => "ok");
        await expect(gate.run(task)).rejects.toThrow("HTTP 403: secondary rate limit");
        expect(task).not.toHaveBeenCalled();

        clock = 61_001;
        await expect(gate.run(task)).resolves.toBe("ok");
    });
});

describe("CommitChecksRequestGateRegistry", () => {
    it.each([
        { limit: "1000", remaining: "100" },
        { limit: "5", remaining: "1" },
    ])("uses the GitLab quota reserve for limit $limit", async ({ limit, remaining }) => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        registry.observeResponse("gitlab", {
            url,
            statusCode: 200,
            headers: {
                "ratelimit-limit": limit,
                "ratelimit-remaining": remaining,
                "ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        await expect(registry.run("gitlab", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).not.toHaveBeenCalled();
    });

    it("uses Bitbucket Cloud NearLimit to cooldown the API origin for one hour", async () => {
        let clock = 1_000;
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => clock);
        const url = "https://api.bitbucket.org/2.0/repositories/acme/repo/commit/main/statuses";
        registry.observeResponse("bitbucket-cloud", {
            url,
            statusCode: 200,
            headers: { "x-ratelimit-nearlimit": "true" },
        });
        const task = vi.fn(async () => "ok");

        await expect(registry.run("bitbucket-cloud", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).not.toHaveBeenCalled();

        clock += 60 * 60 * 1000 + 1;
        await expect(registry.run("bitbucket-cloud", url, task)).resolves.toBe("ok");
    });

    it("honors Bitbucket Server Retry-After without cooling after a bare 403", async () => {
        let clock = 1_000;
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => clock);
        const url = "https://bitbucket.example.test/rest/build-status/1.0/commits/main";
        const cooldownTask = vi.fn(async () => "ok");

        await expect(
            registry.run("bitbucket-server", url, async (generation) => {
                registry.observeResponse(
                    "bitbucket-server",
                    { url, statusCode: 429, headers: { "retry-after": "60" } },
                    generation,
                );
                throw new HttpError(429, "HTTP 429: slow down", { "retry-after": "60" });
            }),
        ).rejects.toThrow("HTTP 429: slow down");
        await expect(registry.run("bitbucket-server", url, cooldownTask)).rejects.toMatchObject({
            statusCode: 429,
            message: "HTTP 429: slow down",
        });
        expect(cooldownTask).not.toHaveBeenCalled();

        clock = 61_001;
        await expect(
            registry.run("bitbucket-server", url, async (generation) => {
                registry.observeResponse(
                    "bitbucket-server",
                    { url, statusCode: 403, headers: {} },
                    generation,
                );
                throw new HttpError(403, "HTTP 403: forbidden", {});
            }),
        ).rejects.toThrow("HTTP 403: forbidden");
        await expect(registry.run("bitbucket-server", url, cooldownTask)).resolves.toBe("ok");
    });

    it("shares a self-hosted provider cooldown by origin but isolates different hosts", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const firstUrl = "https://git.alpha.example.test/api/v4/projects/1/statuses/main";

        await expect(
            registry.run("gitlab", firstUrl, async () => {
                throw new HttpError(429, "HTTP 429: slow down", { "retry-after": "60" });
            }),
        ).rejects.toThrow("HTTP 429: slow down");

        const sharedHostTask = vi.fn(async () => "shared");
        await expect(
            registry.run(
                "gitlab",
                "https://GIT.ALPHA.EXAMPLE.TEST/api/v4/projects/2/statuses/main",
                sharedHostTask,
            ),
        ).rejects.toMatchObject({ statusCode: 429, message: "HTTP 429: slow down" });
        expect(sharedHostTask).not.toHaveBeenCalled();

        const isolatedHostTask = vi.fn(async () => "isolated");
        await expect(
            registry.run(
                "gitlab",
                "https://git.beta.example.test/api/v4/projects/1/statuses/main",
                isolatedHostTask,
            ),
        ).resolves.toBe("isolated");
        expect(isolatedHostTask).toHaveBeenCalledTimes(1);
    });

    it("retains a busy bucket through reset so a fifth task waits for an original release", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE);
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        const releases: Array<() => void> = [];
        let active = 0;
        let maxActive = 0;
        let started = 0;
        const blockingTask = async (): Promise<void> => {
            started += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
        };

        const originalTasks = Array.from({ length: 4 }, () =>
            registry.run("gitlab", url, blockingTask),
        );
        for (let index = 0; index < 8 && started < 4; index += 1) {
            await Promise.resolve();
        }
        expect(started).toBe(4);

        registry.reset();
        const fifthTask = registry.run("gitlab", url, blockingTask);
        for (let index = 0; index < 8; index += 1) {
            await Promise.resolve();
        }
        expect(started).toBe(4);
        expect(maxActive).toBe(4);

        releases.shift()?.();
        for (let index = 0; index < 8 && started < 5; index += 1) {
            await Promise.resolve();
        }
        expect(started).toBe(5);
        expect(maxActive).toBe(4);

        while (releases.length > 0) releases.shift()?.();
        await Promise.all([...originalTasks, fifthTask]);
    });

    it("clears an idle cooldown without sharing it with another self-hosted host", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const cooledUrl = "https://git.alpha.example.test/api/v4/projects/1/statuses/main";
        const isolatedUrl = "https://git.beta.example.test/api/v4/projects/1/statuses/main";

        await expect(
            registry.run("gitlab", cooledUrl, async () => {
                throw new HttpError(429, "HTTP 429: slow down", { "retry-after": "60" });
            }),
        ).rejects.toThrow("HTTP 429: slow down");
        await expect(
            registry.run("gitlab", cooledUrl, async () => "blocked"),
        ).rejects.toMatchObject({
            statusCode: 429,
        });
        await expect(registry.run("gitlab", isolatedUrl, async () => "isolated")).resolves.toBe(
            "isolated",
        );

        registry.reset();
        await expect(registry.run("gitlab", cooledUrl, async () => "reset")).resolves.toBe("reset");
    });

    it("ignores old-generation metadata that arrives after reset", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE);
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        let generation: number | undefined;
        let releaseOldRequest: (() => void) | undefined;
        let markOldRequestStarted: (() => void) | undefined;
        const oldRequestStarted = new Promise<void>((resolve) => {
            markOldRequestStarted = resolve;
        });
        const oldRequest = registry.run("gitlab", url, async (taskGeneration: number) => {
            generation = taskGeneration;
            markOldRequestStarted?.();
            await new Promise<void>((resolve) => {
                releaseOldRequest = resolve;
            });
        });

        await oldRequestStarted;
        registry.reset();
        registry.observeResponse(
            "gitlab",
            {
                url,
                statusCode: 200,
                headers: {
                    "ratelimit-limit": "1000",
                    "ratelimit-remaining": "100",
                    "ratelimit-reset": String(Math.ceil((Date.now() + 60_000) / 1000)),
                },
            },
            generation,
        );
        const postResetTask = vi.fn(async () => "ok");

        try {
            await expect(registry.run("gitlab", url, postResetTask)).resolves.toBe("ok");
            expect(postResetTask).toHaveBeenCalledTimes(1);
        } finally {
            releaseOldRequest?.();
            await oldRequest;
        }
    });

    it("ignores an old-generation retry-after error after reset", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE);
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        let rejectOldRequest: ((reason?: unknown) => void) | undefined;
        let markOldRequestStarted: (() => void) | undefined;
        const oldRequestStarted = new Promise<void>((resolve) => {
            markOldRequestStarted = resolve;
        });
        const oldRequest = registry.run("gitlab", url, async () => {
            markOldRequestStarted?.();
            await new Promise<void>((_resolve, reject) => {
                rejectOldRequest = reject;
            });
        });
        const staleRateError = new HttpError(429, "HTTP 429: slow down", { "retry-after": "60" });

        await oldRequestStarted;
        registry.reset();
        rejectOldRequest?.(staleRateError);
        await expect(oldRequest).rejects.toBe(staleRateError);

        const postResetTask = vi.fn(async () => "ok");
        await expect(registry.run("gitlab", url, postResetTask)).resolves.toBe("ok");
        expect(postResetTask).toHaveBeenCalledTimes(1);
    });

    it("runs every request once a github bucket has earned the local cap bypass from a usable quota pair", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                "x-ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 400; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        expect(task).toHaveBeenCalledTimes(400);
    });

    // Both resets below are "finite and non-negative" to Number(), and both defeat the future-reset
    // requirement the bypass depends on: 1e306 seconds overflows to Infinity once converted to
    // milliseconds, and 99999999999 lands in the year 5138. Either one would satisfy every
    // `resetAt > now()` test for the life of the window.
    async function expectGithubBucketStaysCapped(reset: string): Promise<void> {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                "x-ratelimit-reset": reset,
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    }

    it("refuses a github cap bypass when the reset overflows to Infinity in milliseconds", async () => {
        await expectGithubBucketStaysCapped("1e306");
    });

    it("refuses a github cap bypass when the reset is centuries beyond any real window", async () => {
        await expectGithubBucketStaysCapped("99999999999");
    });

    // A cooldown fails safe in the opposite direction from the cap bypass above. Discarding an
    // out-of-horizon value there withholds a permission; doing it here would discard the backoff
    // itself, drop to the 60-second fallback, and resume knocking on a server that asked for a day.
    async function expectRetryAfterClampedToOneWindow(retryAfter: string): Promise<void> {
        let clock = 1_000;
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => clock);
        const absurd = new HttpError(429, "HTTP 429: slow down", { "retry-after": retryAfter });

        await expect(
            registry.run("github", GITHUB_API_URL, async () => {
                throw absurd;
            }),
        ).rejects.toBe(absurd);

        clock = 61_001;
        const tooSoon = vi.fn(async () => "ok");
        await expect(registry.run("github", GITHUB_API_URL, tooSoon)).rejects.toMatchObject({
            statusCode: 429,
        });
        expect(tooSoon).not.toHaveBeenCalled();

        clock = 1_000 + REQUEST_WINDOW_MS + 1;
        const task = vi.fn(async () => "ok");
        await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        expect(task).toHaveBeenCalledTimes(1);
    }

    it("clamps a retry-after that overflows to Infinity rather than discarding the backoff", async () => {
        await expectRetryAfterClampedToOneWindow("1e306");
    });

    it("clamps a retry-after one second past the reset horizon rather than discarding it", async () => {
        await expectRetryAfterClampedToOneWindow("86401");
    });

    it("clamps a reserve cooldown to one window when the server publishes a day-long reset", async () => {
        let clock = 1_000;
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => clock);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "0",
                // Inside the reset horizon, so it is believed -- and would otherwise park this
                // bucket for a day on nothing but a server-supplied number.
                "x-ratelimit-reset": "86399",
            },
        });
        const task = vi.fn(async () => "ok");

        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).not.toHaveBeenCalled();

        clock = 1_000 + REQUEST_WINDOW_MS + 1;
        await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        expect(task).toHaveBeenCalledTimes(1);
    });

    it("returns a github bucket to the fallback cap once its reset passes with no further responses", async () => {
        let clock = 1_000;
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => clock);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                "x-ratelimit-reset": "3600",
            },
        });

        // Nothing is observed from here on. A bucket whose requests all fail at the transport layer
        // never reaches the observer at all, so a bypass that only expires on the next observation
        // would outlive every quota it was granted against.
        clock = 3_600_001;
        const task = vi.fn(async () => "ok");
        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("returns a gitlab bucket to the fallback cap once its reset passes with no further responses", async () => {
        let clock = 1_000;
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => clock);
        registry.observeResponse("gitlab", {
            url,
            statusCode: 200,
            headers: {
                "ratelimit-limit": "2000",
                "ratelimit-remaining": "1900",
                "ratelimit-reset": "3600",
            },
        });

        clock = 3_600_001;
        const task = vi.fn(async () => "ok");
        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("gitlab", url, task)).resolves.toBe("ok");
        }
        await expect(registry.run("gitlab", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("never throttles below the fallback cap when the advertised limit is smaller", async () => {
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        // GitLab quotes a per-minute quota, so its number is not this window's budget. Reading it
        // as one would throttle a bucket that reported its quota below the cap that governs a
        // bucket which reported nothing at all.
        registry.observeResponse("gitlab", {
            url,
            statusCode: 200,
            headers: {
                "ratelimit-limit": "60",
                "ratelimit-remaining": "59",
                "ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("gitlab", url, task)).resolves.toBe("ok");
        }
        expect(task).toHaveBeenCalledTimes(300);
        await expect(registry.run("gitlab", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
    });

    it("bounds an exempt github bucket at the quota the server advertised", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "500",
                "x-ratelimit-remaining": "499",
                "x-ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 500; index += 1) {
            await registry.run("github", GITHUB_API_URL, task);
        }
        expect(task).toHaveBeenCalledTimes(500);
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
    });

    it("bounds an exempt github bucket even when the server advertises an implausible quota", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "1000000000",
                "x-ratelimit-remaining": "999999999",
                "x-ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < MAX_OBSERVED_REQUESTS_PER_WINDOW; index += 1) {
            await registry.run("github", GITHUB_API_URL, task);
        }
        expect(task).toHaveBeenCalledTimes(MAX_OBSERVED_REQUESTS_PER_WINDOW);
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
    });

    it("bounds an exempt gitlab bucket at the quota the server advertised", async () => {
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("gitlab", {
            url,
            statusCode: 200,
            headers: {
                "ratelimit-limit": "400",
                "ratelimit-remaining": "399",
                "ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 400; index += 1) {
            await registry.run("gitlab", url, task);
        }
        expect(task).toHaveBeenCalledTimes(400);
        await expect(registry.run("gitlab", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
    });

    it("still rejects request 301 in a rolling hour when no quota has ever been observed", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("keeps a bitbucket-server bucket capped at 300 even after 400 successful responses are observed", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const url = "https://bitbucket.example.test/rest/build-status/1.0/commits/main";
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("bitbucket-server", url, task)).resolves.toBe("ok");
            registry.observeResponse("bitbucket-server", { url, statusCode: 200, headers: {} });
        }
        for (let index = 0; index < 100; index += 1) {
            registry.observeResponse("bitbucket-server", { url, statusCode: 200, headers: {} });
        }

        await expect(registry.run("bitbucket-server", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("keeps a bitbucket-cloud bucket capped at 300 even after 400 successful responses are observed", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const url = "https://api.bitbucket.org/2.0/repositories/acme/repo/commit/main/statuses";
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("bitbucket-cloud", url, task)).resolves.toBe("ok");
            registry.observeResponse("bitbucket-cloud", { url, statusCode: 200, headers: {} });
        }
        for (let index = 0; index < 100; index += 1) {
            registry.observeResponse("bitbucket-cloud", { url, statusCode: 200, headers: {} });
        }

        await expect(registry.run("bitbucket-cloud", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("still cools down on low reserve after a github bucket has earned the local cap bypass", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                "x-ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");
        for (let index = 0; index < 400; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }

        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "90",
                "x-ratelimit-reset": "3600",
            },
        });
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(400);
    });

    it("re-arms the local cap fallback for a github bucket after reset clears an earned bypass", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                "x-ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");
        for (let index = 0; index < 400; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }

        registry.reset();

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(700);
    });

    it("runs every request once a gitlab bucket has earned the local cap bypass from a usable quota pair", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        registry.observeResponse("gitlab", {
            url,
            statusCode: 200,
            headers: {
                "ratelimit-limit": "2000",
                "ratelimit-remaining": "1900",
                "ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 400; index += 1) {
            await expect(registry.run("gitlab", url, task)).resolves.toBe("ok");
        }
        expect(task).toHaveBeenCalledTimes(400);
    });

    it("keeps a github bucket on the fallback cap when quota headers carry no usable reset", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                // Limit and remaining without a reset: the reserve cooldown can never arm, so
                // surrendering the fallback cap here would leave the bucket wholly unguarded.
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("keeps a github bucket on the fallback cap when the observed reset is already in the past", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 5_000_000);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                "x-ratelimit-reset": "3600",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("revokes an earned github bypass once its observed reset has gone stale", async () => {
        let clock = 1_000;
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => clock);
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4900",
                "x-ratelimit-reset": "3600",
            },
        });

        // Past the observed reset, with the server no longer publishing a new one. The stored
        // reset can no longer arm the reserve cooldown, so a latched bypass would leave this
        // bucket with no guard at all; it must fall back to the cap instead.
        clock = 3_600_001;
        registry.observeResponse("github", {
            url: GITHUB_API_URL,
            statusCode: 200,
            headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4900" },
        });

        const task = vi.fn(async () => "ok");
        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("github", GITHUB_API_URL, task)).resolves.toBe("ok");
        }
        await expect(registry.run("github", GITHUB_API_URL, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });

    it("keeps a gitlab bucket on the fallback cap when quota headers carry no usable reset", async () => {
        const registry = new CommitChecksRequestGateRegistry(COOLDOWN_MESSAGE, () => 1_000);
        const url = "https://gitlab.example.test/api/v4/projects/1/statuses/main";
        registry.observeResponse("gitlab", {
            url,
            statusCode: 200,
            headers: {
                "ratelimit-limit": "2000",
                "ratelimit-remaining": "1900",
            },
        });
        const task = vi.fn(async () => "ok");

        for (let index = 0; index < 300; index += 1) {
            await expect(registry.run("gitlab", url, task)).resolves.toBe("ok");
        }
        await expect(registry.run("gitlab", url, task)).rejects.toMatchObject({
            statusCode: 429,
            message: COOLDOWN_MESSAGE,
        });
        expect(task).toHaveBeenCalledTimes(300);
    });
});
