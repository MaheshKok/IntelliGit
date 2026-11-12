// GitHub job logs and failure summaries (PLAN.md §5, Phase 7). The log endpoint answers with a
// redirect to a signed blob URL on another host: the token must stay on api.github.com, and an
// expired signed link gets exactly one fresh redirect from the API.

import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("vscode", () => ({
    authentication: { getSession: mocks.getSession },
    l10n: { t: (message: string) => message },
}));

import { HttpError, type FetchResponse } from "../../../../src/services/commitChecks/http";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";

const ref = { host: "github.com", owner: "octo", repo: "app" } as ProviderRepoRef;
const REPO = "https://api.github.com/repos/octo/app";
const LOGS_URL = `${REPO}/actions/jobs/77/logs`;
const BLOB_URL = "https://results-receiver.actions.githubusercontent.com/logs/77?sig=abc";
const JOB = { runId: "5", jobId: "77", attempt: 1 };

type Answer = { status: number; location?: string; body?: string };

/** An HTTPS server whose answers per URL are played in order; the last one repeats. */
function stubServer(routes: Record<string, Answer[]>) {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    vi.mocked(https.get).mockImplementation(((
        url: string,
        options: { headers: Record<string, string> },
        cb: (r: unknown) => void,
    ) => {
        sent.push({ url, headers: { ...options.headers } });
        const answers = routes[url];
        if (!answers) throw new Error(`unexpected request ${url}`);
        const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
        const req = Object.assign(new EventEmitter(), {
            setTimeout: vi.fn(() => req),
            destroy: vi.fn(() => req),
        });
        const res = Object.assign(new EventEmitter(), {
            statusCode: answer.status,
            headers: answer.location ? { location: answer.location } : {},
            resume: vi.fn(),
            destroy: vi.fn(),
        });
        queueMicrotask(() => cb(res));
        if (answer.body !== undefined) {
            setTimeout(() => {
                res.emit("data", Buffer.from(answer.body!, "utf8"));
                res.emit("end");
            }, 0);
        }
        return req;
    }) as unknown as typeof https.get);
    return sent;
}

function hasAuthorization(headers: Record<string, string>): boolean {
    return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function readLog(provider = new GitHubProvider()) {
    return provider.getJobLog(ref, JOB, new AbortController().signal);
}

beforeEach(() => {
    vi.mocked(https.get).mockReset();
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue({ accessToken: "gh-token", account: { id: "1" } });
});

describe("GitHub job log", () => {
    it("redirect download carries no Authorization", async () => {
        const sent = stubServer({
            [LOGS_URL]: [{ status: 302, location: BLOB_URL }],
            [BLOB_URL]: [{ status: 200, body: "##[error]boom\n" }],
        });

        const log = await readLog();

        expect(log).toEqual({ text: "##[error]boom\n", truncated: false });
        expect(sent.map((request) => request.url)).toEqual([LOGS_URL, BLOB_URL]);
        expect(sent[0]!.headers.Authorization, "the API request is signed").toBe("Bearer gh-token");
        expect(hasAuthorization(sent[1]!.headers), "the blob host never sees the token").toBe(
            false,
        );
    });

    it("403 on redirect target re-requests 302 once", async () => {
        // An expired signed link: the second redirect from the API is fresh and works.
        let sent = stubServer({
            [LOGS_URL]: [{ status: 302, location: BLOB_URL }],
            [BLOB_URL]: [{ status: 403 }, { status: 200, body: "fresh log" }],
        });
        await expect(readLog()).resolves.toEqual({ text: "fresh log", truncated: false });
        expect(sent.filter((request) => request.url === LOGS_URL)).toHaveLength(2);

        // A link that keeps failing: exactly one retry, then the error.
        sent = stubServer({
            [LOGS_URL]: [{ status: 302, location: BLOB_URL }],
            [BLOB_URL]: [{ status: 410 }],
        });
        const error = await readLog().catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).statusCode).toBe(410);
        expect(
            { url: (error as HttpError).url, requestUrl: (error as HttpError).requestUrl },
            "the error names both the signed link that refused and the API request",
        ).toEqual({ url: BLOB_URL, requestUrl: LOGS_URL });
        expect(sent.filter((request) => request.url === LOGS_URL)).toHaveLength(2);
    });

    it("a 403 from the API itself is not retried: the token cannot read the log", async () => {
        const sent = stubServer({ [LOGS_URL]: [{ status: 403 }] });
        const error = await readLog().catch((reason: unknown) => reason);
        expect((error as HttpError).statusCode).toBe(403);
        expect(sent).toHaveLength(1);
    });

    it("declares logs and the ##[error] marker", () => {
        const provider = new GitHubProvider();
        expect(provider.capabilities.logs).toBe(true);
        expect(provider.capabilities.failureSummary).toBe(true);
        expect(provider.firstErrorPatterns.some((pattern) => pattern.test("##[error]x"))).toBe(
            true,
        );
    });
});

describe("GitHub failure summary", () => {
    const HASH = "c".repeat(40);

    /** One failed and one passed job; check run 555 is the failed job's, 900 is a decoy. */
    function fakeApi(
        summary: string,
        overrides: Record<string, unknown> = {},
    ): (url: string) => Promise<FetchResponse> {
        const routes: Record<string, unknown> = {
            [`${REPO}/actions/runs`]: {
                workflow_runs: [
                    {
                        id: 5,
                        name: "CI",
                        status: "completed",
                        conclusion: "failure",
                        run_attempt: 1,
                        repository: { id: 1 },
                    },
                ],
            },
            [`${REPO}/actions/runs/5/jobs`]: {
                total_count: 2,
                jobs: [
                    {
                        id: 900,
                        name: "unit-tests",
                        status: "completed",
                        conclusion: "failure",
                        run_attempt: 1,
                        check_run_url: `${REPO}/check-runs/555`,
                        steps: [],
                    },
                    {
                        id: 901,
                        name: "lint",
                        status: "completed",
                        conclusion: "success",
                        run_attempt: 1,
                        check_run_url: `${REPO}/check-runs/556`,
                        steps: [],
                    },
                ],
            },
            [`${REPO}/actions/runs/5`]: { id: 5, run_attempt: 1 },
            [`${REPO}/commits/${HASH}/check-suites`]: { total_count: 1 },
            [`${REPO}/commits/${HASH}/check-runs`]: {
                total_count: 3,
                check_runs: [
                    {
                        id: 555,
                        name: "unit-tests",
                        status: "completed",
                        conclusion: "failure",
                        output: { title: "2 tests failed", summary },
                    },
                    {
                        id: 556,
                        name: "lint",
                        status: "completed",
                        conclusion: "success",
                        output: { title: "Lint passed", summary: "No problems" },
                    },
                    {
                        // Shares its id with the failed job's Actions job id.
                        id: 900,
                        name: "external",
                        status: "completed",
                        conclusion: "failure",
                        output: { title: "WRONG: matched by the Actions job id", summary: "" },
                    },
                ],
            },
            [`${REPO}/commits/${HASH}/status`]: { statuses: [] },
            ...overrides,
        };
        return async (url) => {
            const body = routes[new URL(url).origin + new URL(url).pathname];
            if (body === undefined) throw new Error(`unexpected request ${url}`);
            return { statusCode: 200, headers: {}, body };
        };
    }

    it("failure summary uses checkRunId, not the Actions job id", async () => {
        const api = fakeApi("sum.test.ts > adds numbers\nexpected 3 to be 4");
        const provider = new GitHubProvider(async (url) => (await api(url)).body, undefined, api);

        const detail = await provider.getDetail(ref, HASH);

        const jobs = detail.runs.flatMap((run) => run.jobs);
        const failed = jobs.find((job) => job.id === "900");
        expect(failed?.checkRunId).toBe("555");
        expect(failed?.failureSummary).toBe(
            "2 tests failed\nsum.test.ts > adds numbers\nexpected 3 to be 4",
        );
        expect(
            jobs.find((job) => job.id === "901")?.failureSummary,
            "a passed job gets no summary",
        ).toBeUndefined();
    });

    it("a failed job absent from the summary listing gets its selected check-run summary", async () => {
        // At GitHub's suite limit the commit's check-run listing misses check run 557; the job
        // is found in its own suite, and its summary is read from its own check run.
        const api = fakeApi("unused", {
            [`${REPO}/actions/runs`]: {
                workflow_runs: [
                    {
                        id: 5,
                        name: "CI",
                        status: "completed",
                        conclusion: "failure",
                        run_attempt: 1,
                        check_suite_id: 77,
                        repository: { id: 1 },
                    },
                ],
            },
            [`${REPO}/actions/runs/5/jobs`]: {
                total_count: 1,
                jobs: [
                    {
                        id: 900,
                        name: "unit-tests",
                        status: "completed",
                        conclusion: "failure",
                        run_attempt: 1,
                        check_run_url: `${REPO}/check-runs/557`,
                        steps: [],
                    },
                ],
            },
            [`${REPO}/commits/${HASH}/check-suites`]: { total_count: 1000 },
            [`${REPO}/check-suites/77/check-runs`]: { check_runs: [{ id: 557 }] },
            [`${REPO}/check-runs/557`]: {
                id: 557,
                output: { title: "selected failure", summary: "direct summary" },
            },
        });
        const provider = new GitHubProvider(async (url) => (await api(url)).body, undefined, api);

        const detail = await provider.getDetail(ref, HASH);

        const failed = detail.runs.flatMap((run) => run.jobs).find((job) => job.id === "900");
        expect(failed?.checkRunId).toBe("557");
        expect(failed?.failureSummary).toBe("selected failure\ndirect summary");
    });

    it("the summary is cut to 2 000 characters and stripped of control characters", async () => {
        const api = fakeApi(`\u001b[31mred\u001b[0m ${"x".repeat(5000)}`);
        const provider = new GitHubProvider(async (url) => (await api(url)).body, undefined, api);

        const detail = await provider.getDetail(ref, HASH);

        const summary = detail.runs[0]!.jobs.find((job) => job.id === "900")!.failureSummary!;
        expect(summary.length).toBe(2000);
        expect(summary.startsWith("2 tests failed\nred x")).toBe(true);
    });
});
