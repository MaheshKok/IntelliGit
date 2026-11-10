import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../../../src/services/commitChecks/credentialStore";
import type { ProviderRepoRef } from "../../../src/services/commitChecks/types";

// `https.get` is the one place a request leaves the extension; counting its calls is the check.
const mocks = vi.hoisted(() => ({
    httpsGet: vi.fn(() => {
        throw new Error("a request reached the network");
    }),
}));

vi.mock("https", () => ({ get: mocks.httpsGet }));
vi.mock("vscode", () => ({
    authentication: {
        getSession: async () => ({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        }),
    },
    l10n: { t: (message: string) => message },
}));

import { createCommitChecksProviders } from "../../../src/activation/commitChecksProviders";
import { GitHubProvider } from "../../../src/services/commitChecks/githubProvider";
import { CommitChecksRequestGateRegistry } from "../../../src/services/commitChecks/requestGate";

const ref = { host: "github.com", owner: "microsoft", repo: "vscode" } as ProviderRepoRef;
const API = "https://api.github.com";

describe("createCommitChecksProviders", () => {
    it("sends no GitHub request, detail or scan page, while the gate cools down", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const github = createCommitChecksProviders(registry, {} as CredentialStore, undefined).find(
            (provider) => provider instanceof GitHubProvider,
        ) as GitHubProvider;
        expect(github).toBeInstanceOf(GitHubProvider);
        registry.observeResponse("github", {
            url: API,
            statusCode: 429,
            headers: { "retry-after": "60" },
        });

        const detail = await github.getDetail(ref, "abc1234");
        const page = await github.continueFailedScan(ref, {
            runId: "1",
            runAttempt: 1,
            runName: "CI",
            url: `${API}/repos/microsoft/vscode/actions/runs/1/jobs?filter=latest&per_page=100&page=11`,
        });

        expect(
            mocks.httpsGet,
            "no request may leave while the gate cools down",
        ).not.toHaveBeenCalled();
        expect(detail).toMatchObject({ outcome: "unavailable", error: "cooling down" });
        expect(page).toEqual({ pausedUntil: registry.cooldownEnd("github", API) });
    });

    it("pauses a scan page the server answers 429, so it resumes when the cooldown ends", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const github = createCommitChecksProviders(registry, {} as CredentialStore, undefined).find(
            (provider) => provider instanceof GitHubProvider,
        ) as GitHubProvider;
        const runUrl = `${API}/repos/microsoft/vscode/actions/runs/1`;
        const pageUrl = `${runUrl}/jobs?filter=latest&per_page=100&page=11`;
        mocks.httpsGet.mockImplementation(((
            url: string,
            _options: unknown,
            cb: (response: unknown) => void,
        ) => {
            // The run check before the page passes; the page itself is rate limited.
            const [statusCode, headers, body] =
                url === pageUrl
                    ? [429, { "retry-after": "60" }, "{}"]
                    : [200, {}, JSON.stringify({ id: 1, run_attempt: 1 })];
            const request = Object.assign(new EventEmitter(), {
                setTimeout: vi.fn(),
                destroy: vi.fn(),
            });
            const response = Object.assign(new EventEmitter(), { statusCode, headers });
            cb(response);
            queueMicrotask(() => {
                response.emit("data", Buffer.from(body));
                response.emit("end");
            });
            return request;
        }) as never);

        const page = await github.continueFailedScan(ref, {
            runId: "1",
            runAttempt: 1,
            runName: "CI",
            url: pageUrl,
        });

        expect(registry.cooldownEnd("github", API)).toBeGreaterThan(0);
        expect(page, "a rate-limited page pauses the scan, never stops it").toEqual({
            pausedUntil: registry.cooldownEnd("github", API),
        });
    });
});
