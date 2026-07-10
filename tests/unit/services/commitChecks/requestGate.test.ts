import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../src/services/commitChecks/http";
import { GitHubRequestGate } from "../../../../src/services/commitChecks/requestGate";

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
        await expect(gate.run(task)).rejects.toThrow("HTTP 403: API rate limit exceeded");
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
                gate.observeResponse({ statusCode: 403, headers });
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
