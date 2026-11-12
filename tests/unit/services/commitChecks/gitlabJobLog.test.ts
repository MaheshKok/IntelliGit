// GitLab job logs (the job trace) and failure reasons (PLAN.md §5, Phase 7).

import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

import type { FetchResponse } from "../../../../src/services/commitChecks/http";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";

const TOKEN = "glpat-test-token";
const ref = { host: "gitlab.com", owner: "group", repo: "app" } as ProviderRepoRef;
const PROJECT = "https://gitlab.com/api/v4/projects/group%2Fapp";
const store = { get: vi.fn(async () => TOKEN) } as unknown as CredentialStore;

function stubTrace(status: number, body: string) {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    vi.mocked(https.get).mockImplementation(((
        url: string,
        options: { headers: Record<string, string> },
        cb: (r: unknown) => void,
    ) => {
        sent.push({ url, headers: { ...options.headers } });
        const req = Object.assign(new EventEmitter(), {
            setTimeout: vi.fn(() => req),
            destroy: vi.fn(() => req),
        });
        const res = Object.assign(new EventEmitter(), {
            statusCode: status,
            headers: {},
            resume: vi.fn(),
            destroy: vi.fn(),
        });
        queueMicrotask(() => cb(res));
        setTimeout(() => {
            res.emit("data", Buffer.from(body, "utf8"));
            res.emit("end");
        }, 0);
        return req;
    }) as unknown as typeof https.get);
    return sent;
}

beforeEach(() => {
    vi.mocked(https.get).mockReset();
});

describe("GitLab job log", () => {
    it("trace downloaded with the auth header", async () => {
        const sent = stubTrace(200, "ERROR: Job failed: exit code 1\n");
        const provider = new GitLabProvider(vi.fn(), store);

        const log = await provider.getJobLog(
            ref,
            { runId: "9", jobId: "77" },
            new AbortController().signal,
        );

        expect(log).toEqual({ text: "ERROR: Job failed: exit code 1\n", truncated: false });
        expect(sent.map((request) => request.url)).toEqual([`${PROJECT}/jobs/77/trace`]);
        expect(sent[0]!.headers["PRIVATE-TOKEN"]).toBe(TOKEN);
        expect(provider.capabilities.logs).toBe(true);
        expect(provider.capabilities.failureSummary).toBe(true);
    });

    it("a signed-out GitLab reads no trace", async () => {
        const sent = stubTrace(200, "never read");
        const signedOut = { get: vi.fn(async () => undefined) } as unknown as CredentialStore;
        const provider = new GitLabProvider(vi.fn(), signedOut);

        await expect(
            provider.getJobLog(ref, { runId: "9", jobId: "77" }, new AbortController().signal),
        ).rejects.toThrow("Sign in to {host} to view commit checks.");
        expect(sent).toHaveLength(0);
    });
});

describe("GitLab failure reason", () => {
    it("failure_reason mapped", async () => {
        const HASH = "d".repeat(40);
        const routes: Record<string, unknown> = {
            [`${PROJECT}/pipelines`]: [{ id: 9, status: "failed", updated_at: "t1" }],
            [`${PROJECT}/pipelines/9/jobs`]: [
                {
                    id: 77,
                    name: "unit",
                    stage: "test",
                    status: "failed",
                    failure_reason: "script_failure",
                },
                { id: 78, name: "lint", stage: "test", status: "success" },
            ],
            [`${PROJECT}/pipelines/9`]: { id: 9, status: "failed", updated_at: "t1" },
            [`${PROJECT}/repository/commits/${HASH}/statuses`]: [],
        };
        const fetchWithMeta = async (url: string): Promise<FetchResponse> => {
            const parsed = new URL(url);
            const body = routes[parsed.origin + parsed.pathname];
            if (body === undefined) throw new Error(`unexpected request ${url}`);
            return { statusCode: 200, headers: {}, body };
        };
        const provider = new GitLabProvider(vi.fn(), store, undefined, fetchWithMeta);

        const detail = await provider.getDetail(ref, HASH);

        const jobs = detail.runs.flatMap((run) => run.jobs);
        expect(jobs.find((job) => job.id === "77")?.failureSummary).toBe("script failure");
        expect(jobs.find((job) => job.id === "78")?.failureSummary).toBeUndefined();
    });
});
