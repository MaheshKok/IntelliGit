import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
    window: {},
    workspace: {},
    commands: {},
    StatusBarAlignment: { Left: 1 },
    l10n: { t: (message: string) => message },
}));

import { headCooldownEnd } from "../../../src/activation/headChecks";
import { HttpError } from "../../../src/services/commitChecks/http";
import { CommitChecksRequestGateRegistry } from "../../../src/services/commitChecks/requestGate";

const HASH = "a".repeat(40);

describe("headCooldownEnd", () => {
    it("a GitLab cooldown does not pause an unrelated healthy GitHub HEAD", async () => {
        const gates = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
        await expect(
            gates.run("gitlab", "https://gitlab.com/api/v4/projects/o%2Fr", async () => {
                throw new HttpError(429, "HTTP 429", { "retry-after": "60" });
            }),
        ).rejects.toThrow();
        const gitlab = {
            requestBucket: async () => ({
                providerId: "gitlab" as const,
                url: "https://gitlab.com/api/v4/x",
            }),
        };
        const github = {
            requestBucket: async () => ({
                providerId: "github" as const,
                url: "https://api.github.com",
            }),
        };
        await expect(headCooldownEnd(gitlab, gates, HASH)).resolves.toBe(61_000);
        await expect(headCooldownEnd(github, gates, HASH)).resolves.toBe(0);
    });

    it("is 0 when HEAD has no provider bucket", async () => {
        const gates = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
        const none = { requestBucket: vi.fn(async () => undefined) };
        await expect(headCooldownEnd(none, gates, HASH)).resolves.toBe(0);
        expect(none.requestBucket).toHaveBeenCalledWith(HASH);
    });
});
