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
});
