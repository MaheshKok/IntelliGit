import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../src/services/commitChecks/http";
import {
    CommitChecksRequestGateRegistry,
    GitHubRequestGate,
} from "../../../../src/services/commitChecks/requestGate";

const GITHUB_API_URL = "https://api.github.com/repos/acme/repo/commits/main/status";
const COOLDOWN_MESSAGE = "Commit checks rate limit cooldown is active.";

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
    ])("blocks a request when observed remaining quota reaches its reserve", async ({ limit, remaining }) => {
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
    });

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
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "500",
                "x-ratelimit-reset": "3600",
            },
        });
        const blockedTask = vi.fn(async () => "blocked");

        await expect(gate.run(blockedTask)).rejects.toThrow("GitHub rate limit cooldown is active.");
        expect(blockedTask).not.toHaveBeenCalled();

        clock = 3_600_001;
        const task = vi.fn(async () => "ok");
        for (let index = 0; index < 300; index += 1) {
            await expect(gate.run(task)).resolves.toBe("ok");
        }
        await expect(gate.run(task)).rejects.toThrow("GitHub rate limit cooldown is active.");
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
        await expect(registry.run("gitlab", cooledUrl, async () => "blocked")).rejects.toMatchObject({
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
});
