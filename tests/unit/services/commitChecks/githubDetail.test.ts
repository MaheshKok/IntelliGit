import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import runFixture from "../../../fixtures/commitChecks/github/workflowRun.json";
import jobFixture from "../../../fixtures/commitChecks/github/workflowJob.json";
import twoPageJobs from "../../../fixtures/commitChecks/github/jobsTwoPages.json";
import {
    failedRunJobs,
    generatedJob as job,
} from "../../../fixtures/commitChecks/github/failedRun2000Jobs";
import {
    HttpError,
    type FetchJson,
    type FetchJsonWithMeta,
    type FetchResponse,
} from "../../../../src/services/commitChecks/http";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";
import type { CommitChecksPersistentState } from "../../../../src/services/commitChecks/persistentCache";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import type { CiJob, CommitCiDetail } from "../../../../src/types";

// `translations` stands in for a non-English bundle: a string missing from it stays English.
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), translations: new Map<string, string>() }));

vi.mock("vscode", () => ({
    authentication: { getSession: mocks.getSession },
    l10n: {
        t: (message: string, args?: Record<string, string | number | boolean>) =>
            interpolateL10n(mocks.translations.get(message) ?? message, args),
    },
}));

import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import {
    CommitChecksRequestGateRegistry,
    gatedFetchWithMeta,
    RequestGateCooldownError,
} from "../../../../src/services/commitChecks/requestGate";
import {
    CommitCiDetailService,
    type CiFailedScanHooks,
} from "../../../../src/services/commitChecks/detailService";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import { logicalCheckId } from "../../../../src/shared/ci/identity";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import type { GitOps } from "../../../../src/git/operations";

const SHA = runFixture.head_sha;
const REPO_ID = runFixture.repository.id;
const API = "https://api.github.com";
const ref = { host: "github.com", owner: "microsoft", repo: "vscode" } as ProviderRepoRef;
const KEY = `github:repo@${SHA}:-#detail`;
const SERVE = { repoKey: "repo", capabilities: NO_CI_CAPABILITIES };

type Job = Record<string, unknown>;
type Run = Record<string, unknown>;

function jobs(count: number, failedAt: readonly number[] = [], overrides: Job = {}): Job[] {
    return Array.from({ length: count }, (_, i) =>
        job(i + 1, failedAt.includes(i + 1) ? "failure" : "success", overrides),
    );
}

/** A run from the recorded fixture; its conclusion defaults to the fixture's. */
function run(overrides: Run = {}): Run {
    return { ...runFixture, ...overrides };
}

/** GitHub names next pages by repository id, as recorded from the live API. */
function jobsPageUrl(runId: unknown, page: number): string {
    return `${API}/repositories/${REPO_ID}/actions/runs/${String(runId)}/jobs?filter=latest&per_page=100&page=${page}`;
}

interface FakeGitHub {
    runs: Run[];
    jobsByRun: Map<string, Job[]>;
    /** Check runs besides the jobs' own; GitHub lists every Actions job as a check run too. */
    checkRuns: Record<string, unknown>[];
    /** False models a snapshot that has not caught up with the listed jobs yet. */
    jobCheckRuns?: boolean;
    /** The ref's check-suite count; past 1 000 GitHub leaves older suites out of the snapshot. */
    checkSuiteCount?: number;
    /** False models a suite whose check runs have not caught up with its jobs either. */
    suiteCheckRuns?: boolean;
    statuses: Record<string, unknown>[];
    /** Throws for a URL the test wants to fail; consulted on every request. */
    fail?: (url: string) => Error | undefined;
    /** Overrides the next link of a jobs or runs page. */
    nextLink?: (url: string, page: number) => string | undefined;
    /** Overrides the `total_count` a jobs page reports, given the run's real job count. */
    jobsTotal?: (total: number, page: number) => number | undefined;
    onRequest?: (url: string) => void;
}

/** Each job's own check run, under the id its `check_run_url` names. */
function jobCheckRuns(jobsByRun: Map<string, Job[]>): Record<string, unknown>[] {
    return [...jobsByRun.values()].flat().flatMap((j) => {
        const id = /\/check-runs\/(\d+)$/.exec(String(j.check_run_url ?? ""))?.[1];
        return id
            ? [{ id: Number(id), name: j.name, status: j.status, conclusion: j.conclusion }]
            : [];
    });
}

/** In-memory GitHub REST API: the snapshot endpoints plus `Link`-paged runs and jobs. */
function fakeGitHub(state: FakeGitHub) {
    const log: string[] = [];
    const respond = (url: string): FetchResponse => {
        log.push(url);
        state.onRequest?.(url);
        const error = state.fail?.(url);
        if (error) throw error;
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page") ?? "1");
        // A suite's own check runs are always complete: the ref limit does not apply to them.
        const suiteMatch = /\/check-suites\/(\d+)\/check-runs$/.exec(parsed.pathname);
        if (suiteMatch) {
            const inSuite = state.runs.filter((r) => String(r.check_suite_id) === suiteMatch[1]);
            const all =
                state.suiteCheckRuns === false
                    ? []
                    : jobCheckRuns(
                          new Map(
                              inSuite.map((r) => [
                                  String(r.id),
                                  state.jobsByRun.get(String(r.id)) ?? [],
                              ]),
                          ),
                      );
            return {
                statusCode: 200,
                headers: {},
                body: { total_count: all.length, check_runs: all },
            };
        }
        if (parsed.pathname.endsWith("/check-suites")) {
            return {
                statusCode: 200,
                headers: {},
                body: { total_count: state.checkSuiteCount ?? state.runs.length, check_suites: [] },
            };
        }
        if (parsed.pathname.endsWith("/check-runs")) {
            const all = [
                ...state.checkRuns,
                ...(state.jobCheckRuns === false ? [] : jobCheckRuns(state.jobsByRun)),
            ];
            return {
                statusCode: 200,
                headers: {},
                body: {
                    total_count: all.length,
                    check_runs: all.slice((page - 1) * 100, page * 100),
                },
            };
        }
        if (parsed.pathname.endsWith("/status")) {
            return { statusCode: 200, headers: {}, body: { statuses: state.statuses } };
        }
        if (parsed.pathname.endsWith("/actions/runs")) {
            const link = state.nextLink?.(url, page);
            return {
                statusCode: 200,
                headers: link ? { link: `<${link}>; rel="next"` } : {},
                body: { total_count: state.runs.length, workflow_runs: state.runs },
            };
        }
        const runMatch = /\/actions\/runs\/(\d+)$/.exec(parsed.pathname);
        const found = runMatch && state.runs.find((r) => String(r.id) === runMatch[1]);
        if (found) return { statusCode: 200, headers: {}, body: found };
        const jobsMatch = /\/actions\/runs\/(\d+)\/jobs$/.exec(parsed.pathname);
        if (jobsMatch) {
            const all = state.jobsByRun.get(jobsMatch[1]) ?? [];
            const slice = all.slice((page - 1) * 100, page * 100);
            const link =
                state.nextLink?.(url, page) ??
                (page * 100 < all.length ? jobsPageUrl(jobsMatch[1], page + 1) : undefined);
            return {
                statusCode: 200,
                headers: link ? { link: `<${link}>; rel="next"` } : {},
                body: {
                    total_count: state.jobsTotal ? state.jobsTotal(all.length, page) : all.length,
                    jobs: slice,
                },
            };
        }
        throw new HttpError(404, `HTTP 404: ${url}`, {});
    };
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async (url: string) => respond(url));
    const fetchJson: FetchJson = vi.fn(async (url: string) => respond(url).body);
    return { log, fetchJson, fetchWithMeta };
}

function state(partial: Partial<FakeGitHub> = {}): FakeGitHub {
    return {
        runs: [run()],
        jobsByRun: new Map([[String(runFixture.id), [jobFixture]]]),
        checkRuns: [],
        statuses: [],
        ...partial,
    };
}

function scanPages(log: readonly string[]): number[] {
    return log
        .filter((url) => url.includes("/jobs?"))
        .map((url) => Number(new URL(url).searchParams.get("page") ?? "1"))
        .filter((page) => page > 10);
}

/** Whether `url` asks for jobs page `page`; the snapshot's check-run pages carry `page=` too. */
function isJobsPage(url: string, page: number): boolean {
    return url.includes("/jobs?") && new URL(url).searchParams.get("page") === String(page);
}

const failedIds = (detail: CommitCiDetail): string[] =>
    detail.runs[0].jobs.filter((j: CiJob) => j.state === "failure").map((j) => j.name);

describe("GitHubProvider.getDetail", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("maps runs, jobs, steps", async () => {
        const failedJob = job(2, "failure", { started_at: "2026-11-08T14:44:00Z" });
        const gh = fakeGitHub(
            state({
                runs: [run({ conclusion: "failure" })],
                jobsByRun: new Map([[String(runFixture.id), [jobFixture, failedJob]]]),
            }),
        );
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);

        const detail = await provider.getDetail(ref, SHA);

        expect(detail).toMatchObject({
            hash: SHA,
            provider: "github",
            complete: true,
            outcome: "failure",
            runsCoverage: "full",
            otherChecks: [],
            otherChecksCoverage: "full",
        });
        expect(detail.scanCursors).toBeUndefined();
        expect(detail.runs).toEqual([
            {
                id: String(runFixture.id),
                name: "Code OSS",
                url: runFixture.html_url,
                state: "failure",
                workflowId: String(runFixture.workflow_id),
                event: "pull_request",
                actor: "alexdima",
                ref: runFixture.head_branch,
                runNumber: 79153,
                attempt: 1,
                createdAt: runFixture.created_at,
                startedAt: runFixture.run_started_at,
                completedAt: runFixture.updated_at,
                jobsCoverage: "full",
                jobs: [
                    {
                        id: String(jobFixture.id),
                        logicalId: logicalCheckId({
                            source: "job",
                            scope: "Code OSS",
                            name: "Detect Changes",
                        }),
                        checkRunId: String(jobFixture.id),
                        name: "Detect Changes",
                        checkName: "Detect Changes",
                        state: "success",
                        url: jobFixture.html_url,
                        startedAt: jobFixture.started_at,
                        completedAt: jobFixture.completed_at,
                        attempt: 1,
                        steps: jobFixture.steps.map((step) => ({
                            number: step.number,
                            name: step.name,
                            state: "success",
                            startedAt: step.started_at,
                            completedAt: step.completed_at,
                        })),
                    },
                    expect.objectContaining({ name: "job 2", state: "failure" }),
                ],
            },
        ]);
    });

    it("maps every Actions status and conclusion to its CI state", async () => {
        const cases: [string, string | null, string][] = [
            ["in_progress", null, "running"],
            ["queued", null, "queued"],
            ["waiting", null, "queued"],
            ["completed", "success", "success"],
            ["completed", "failure", "failure"],
            ["completed", "timed_out", "failure"],
            ["completed", "startup_failure", "failure"],
            ["completed", "action_required", "failure"],
            ["completed", "cancelled", "cancelled"],
            ["completed", "skipped", "skipped"],
            ["completed", "neutral", "neutral"],
            ["completed", "stale", "unknown"],
        ];
        const gh = fakeGitHub(
            state({
                jobsByRun: new Map([
                    [
                        String(runFixture.id),
                        cases.map(([status, conclusion], i) =>
                            job(i + 1, conclusion ?? "", { status, conclusion }),
                        ),
                    ],
                ]),
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.runs[0].jobs.map((j) => j.state)).toEqual(cases.map(([, , s]) => s));
        expect(detail.complete).toBe(false);
        expect(detail.outcome).toBe("failure");
    });

    it("Actions job id and check-run id are distinct", async () => {
        const gh = fakeGitHub(
            state({
                jobsByRun: new Map([
                    [
                        String(runFixture.id),
                        [
                            {
                                ...jobFixture,
                                check_run_url: `${API}/repos/microsoft/vscode/check-runs/999`,
                            },
                        ],
                    ],
                ]),
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.runs[0].jobs[0]).toMatchObject({
            id: String(jobFixture.id),
            checkRunId: "999",
        });
    });

    it("null started_at stays undefined", async () => {
        const queued = job(1, "", {
            status: "queued",
            conclusion: null,
            started_at: null,
            completed_at: null,
            steps: [
                {
                    name: "Set up job",
                    status: "queued",
                    conclusion: null,
                    number: 1,
                    started_at: null,
                    completed_at: null,
                },
            ],
        });
        const gh = fakeGitHub(
            state({
                runs: [run({ status: "queued", conclusion: null, run_started_at: null })],
                jobsByRun: new Map([[String(runFixture.id), [queued]]]),
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        const [ciRun] = detail.runs;
        expect(ciRun.startedAt).toBeUndefined();
        expect(ciRun.completedAt).toBeUndefined();
        expect(ciRun.jobs[0].startedAt).toBeUndefined();
        expect(ciRun.jobs[0].completedAt).toBeUndefined();
        expect(ciRun.jobs[0].steps[0].startedAt).toBeUndefined();
        expect(detail.complete).toBe(false);
        expect(detail.outcome).toBe("pending");
    });

    it.each([
        ["second page fails → unavailable", 2],
        ["final page fails → unavailable", 3],
    ])("%s", async (_name, failingPage) => {
        const gh = fakeGitHub(
            state({
                jobsByRun: new Map([[String(runFixture.id), jobs(250)]]),
                fail: (url) =>
                    url.includes(`/jobs?`) && url.includes(`page=${failingPage}`)
                        ? new HttpError(502, "HTTP 502: bad gateway", {})
                        : undefined,
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail).toMatchObject({
            outcome: "unavailable",
            complete: false,
            runs: [],
            error: "HTTP 502: bad gateway",
        });
    });

    it("a failed check-run page makes the detail unavailable while the status list loads", async () => {
        const checkRuns = Array.from({ length: 150 }, (_, i) => ({
            id: 3_000_000 + i,
            name: `build ${i}`,
            status: "completed",
            conclusion: "success",
        }));
        const gh = fakeGitHub(
            state({
                checkRuns,
                statuses: [{ context: "ci/legacy", state: "success", description: "build ok" }],
                fail: (url) =>
                    url.includes("/check-runs?") && url.includes("page=2")
                        ? new HttpError(502, "HTTP 502: bad gateway", {})
                        : undefined,
            }),
        );
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);
        expect(await provider.getDetail(ref, SHA)).toMatchObject({
            outcome: "unavailable",
            complete: false,
            runs: [],
            error: "HTTP 502: bad gateway",
        });
        // The badge snapshot keeps its partial-endpoint behaviour: the status list still shows.
        expect((await provider.getChecks(ref, SHA)).items.map((item) => item.id)).toEqual([
            "ci/legacy",
        ]);
    });

    it("dedup by check-run id, not name", async () => {
        const gh = fakeGitHub(
            state({
                jobsByRun: new Map([
                    [String(runFixture.id), [job(1, "success", { name: "build" })]],
                ]),
                checkRuns: [
                    // The job's own check run, and a third-party check run with the same name.
                    { id: 2_000_001, name: "build", status: "completed", conclusion: "success" },
                    { id: 555, name: "build", status: "completed", conclusion: "failure" },
                ],
                statuses: [{ context: "ci/legacy", state: "success", description: "build ok" }],
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.otherChecks.map((check) => [check.id, check.source])).toEqual([
            ["555", "check-run"],
            ["ci/legacy", "status"],
        ]);
        expect(detail.outcome).toBe("failure");
    });

    it("requests go through the gate", async () => {
        const gh = fakeGitHub(state());
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const transport = vi.fn(
            (
                onResponse?: (meta: {
                    url: string;
                    statusCode: number;
                    headers: Record<string, string>;
                }) => void,
            ): FetchJsonWithMeta =>
                async (url, headers) => {
                    const response = await gh.fetchWithMeta(url, headers);
                    onResponse?.({ url, statusCode: 429, headers: { "retry-after": "60" } });
                    return response;
                },
        );
        const provider = new GitHubProvider(
            gh.fetchJson,
            undefined,
            gatedFetchWithMeta(registry, "github", transport),
        );

        // The first detail request answers 429; the gate must see it and refuse the next one.
        await provider.getDetail(ref, SHA);
        const sent = vi.mocked(gh.fetchWithMeta).mock.calls.length;
        const detail = await provider.getDetail(ref, SHA);

        expect(sent).toBeGreaterThan(0);
        expect(vi.mocked(gh.fetchWithMeta).mock.calls.length).toBe(sent);
        expect(detail).toMatchObject({ outcome: "unavailable", error: "cooling down" });
    });

    it("fetch error returns unavailable, does not throw", async () => {
        const gh = fakeGitHub(
            state({
                fail: (url) =>
                    url.includes("/actions/runs?")
                        ? new Error("connect ECONNREFUSED gh-token")
                        : undefined,
            }),
        );
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);
        const detail = await provider.getDetail(ref, SHA);
        expect(detail).toMatchObject({ outcome: "unavailable", complete: false, runs: [] });
        expect(detail.error).toContain("ECONNREFUSED");
        expect(detail.error).not.toContain("gh-token");

        const revoked = fakeGitHub(
            state({
                fail: (url) =>
                    url.includes("/actions/runs?") ? new HttpError(401, "HTTP 401", {}) : undefined,
            }),
        );
        const signIn = await new GitHubProvider(
            revoked.fetchJson,
            undefined,
            revoked.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(signIn).toMatchObject({ outcome: "unavailable", signInHost: "github.com" });
    });

    it("a missing session is a none detail that is never complete", async () => {
        mocks.getSession.mockResolvedValue(undefined);
        const gh = fakeGitHub(state());
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail).toMatchObject({ outcome: "none", complete: false, runs: [] });
        expect(gh.log).toEqual([]);
    });

    it("requests carry per_page=100", async () => {
        const gh = fakeGitHub(state({ jobsByRun: new Map([[String(runFixture.id), jobs(150)]]) }));
        await new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta).getDetail(ref, SHA);
        // The run lists, not the single-run read that checks the attempt after the jobs.
        const listRequests = gh.log.filter(
            (url) => url.includes("/actions/") && !/\/actions\/runs\/\d+$/.test(url),
        );
        expect(listRequests.length).toBe(3);
        for (const url of listRequests) {
            expect(new URL(url).searchParams.get("per_page"), url).toBe("100");
        }
        expect(listRequests[0]).toBe(
            `${API}/repos/microsoft/vscode/actions/runs?head_sha=${SHA}&per_page=100`,
        );
        expect(listRequests[1]).toBe(
            `${API}/repos/microsoft/vscode/actions/runs/${runFixture.id}/jobs?filter=latest&per_page=100`,
        );
    });

    it("1 001+ items: 1 000 kept, coverage pageBound shown 1000", async () => {
        const gh = fakeGitHub(state({ jobsByRun: new Map([[String(runFixture.id), jobs(1001)]]) }));
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.runs[0].jobs).toHaveLength(1000);
        expect(detail.runs[0].jobsCoverage).toEqual({ reason: "pageBound", shown: 1000 });
        // A passing run needs no scan for failed jobs.
        expect(detail.scanCursors).toBeUndefined();
        expect(gh.log.some((url) => isJobsPage(url, 11))).toBe(false);
    });

    it.each([
        ["http", `http://api.github.com/repositories/${REPO_ID}/actions/runs?page=2`],
        ["other host", `https://evil.example/repositories/${REPO_ID}/actions/runs?page=2`],
        ["other port", `https://api.github.com:8443/repositories/${REPO_ID}/actions/runs?page=2`],
        ["other path prefix", `https://api.github.com/repositories/1/actions/runs?page=2`],
    ])("hostile next link: %s", async (_name, hostile) => {
        const gh = fakeGitHub(
            state({ nextLink: (url) => (url.includes("/actions/runs?") ? hostile : undefined) }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(gh.log).not.toContain(hostile);
        expect(detail.runsCoverage).toEqual({ reason: "rejectedNext", shown: 1 });
        expect(detail.runs).toHaveLength(1);
    });

    it("follows GitHub's repository-id next link on a recorded two-page jobs list", async () => {
        // The snapshot lists the recorded jobs' check runs, as GitHub does.
        const recorded: Job[] = twoPageJobs.pages.flatMap((page) => page.body.jobs);
        const gh = fakeGitHub(state({ jobsByRun: new Map([[String(runFixture.id), recorded]]) }));
        // The jobs list answers with the recorded pages and their Link headers, verbatim.
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            if (!url.includes("/jobs?")) return gh.fetchWithMeta(url, headers);
            gh.log.push(url);
            const page =
                twoPageJobs.pages[Number(new URL(url).searchParams.get("page") ?? "1") - 1];
            return { statusCode: 200, headers: { link: page.link }, body: page.body };
        };
        const detail = await new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta).getDetail(
            ref,
            SHA,
        );
        expect(detail.runs[0].jobs.map((j) => [j.name, j.state])).toEqual([
            ["Detect Changes", "success"],
            ["Compile & Hygiene", "success"],
            ["Linux / Electron", "failure"],
        ]);
        expect(detail.runs[0].jobsCoverage).toBe("full");
        // Page 2's prev and first links are not followed.
        expect(gh.log.filter((url) => url.includes("/jobs?"))).toEqual([
            `${API}/repos/microsoft/vscode/actions/runs/${runFixture.id}/jobs?filter=latest&per_page=100`,
            jobsPageUrl(runFixture.id, 2),
        ]);
    });

    it.each(["rel=", "rel", 'rel=""', 'rel="  "'])(
        "an empty relation (%s) on a jobs page fails the detail, never reads as the last page",
        async (param) => {
            const gh = fakeGitHub(
                state({ jobsByRun: new Map([[String(runFixture.id), jobs(2000)]]) }),
            );
            const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
                const response = await gh.fetchWithMeta(url, headers);
                if (!url.includes("/jobs?")) return response;
                return {
                    ...response,
                    headers: { link: `<${jobsPageUrl(runFixture.id, 2)}>; ${param}` },
                };
            };
            const detail = await new GitHubProvider(
                gh.fetchJson,
                undefined,
                fetchWithMeta,
            ).getDetail(ref, SHA);
            expect(detail).toMatchObject({
                outcome: "unavailable",
                complete: false,
                runs: [],
                error: "Malformed Link header.",
            });
        },
    );

    // An empty relation, and text left over after the last entry (an unterminated quote).
    it.each(["rel=", 'title="open; rel=next'])(
        "an unreadable Link header (%s) is reported in the user's language",
        async (param) => {
            mocks.translations.set("Malformed Link header.", "Fehlerhafter Link-Header.");
            try {
                const gh = fakeGitHub(
                    state({ jobsByRun: new Map([[String(runFixture.id), jobs(2000)]]) }),
                );
                const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
                    const response = await gh.fetchWithMeta(url, headers);
                    if (!url.includes("/jobs?")) return response;
                    return {
                        ...response,
                        headers: { link: `<${jobsPageUrl(runFixture.id, 2)}>; ${param}` },
                    };
                };
                const detail = await new GitHubProvider(
                    gh.fetchJson,
                    undefined,
                    fetchWithMeta,
                ).getDetail(ref, SHA);
                expect(detail.error).toBe("Fehlerhafter Link-Header.");
            } finally {
                mocks.translations.clear();
            }
        },
    );

    it("a re-run while the jobs are read never pairs the old attempt with the new attempt's jobs", async () => {
        let rerunOnce = true;
        const attempt2 = Array.from({ length: 50 }, (_, i) =>
            job(i + 1, "success", { name: `attempt 2 job ${i + 1}`, run_attempt: 2 }),
        );
        const st = state({
            runs: [run({ conclusion: "success", run_attempt: 1 })],
            jobsByRun: new Map([[String(runFixture.id), jobs(3)]]),
            onRequest: (url) => {
                // The re-run lands after the run list answered, before the jobs page answers.
                if (!url.includes("/jobs?") || !rerunOnce) return;
                rerunOnce = false;
                st.runs = [run({ conclusion: "success", run_attempt: 2 })];
                st.jobsByRun.set(String(runFixture.id), attempt2);
            },
        });
        const gh = fakeGitHub(st);
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.runs[0].attempt, "the run's attempt matches its jobs").toBe(2);
        expect(detail.runs[0].jobs.map((j) => j.name)).toEqual(attempt2.map((j) => j.name));
    });

    // The re-run lands just before the named request answers: the check runs, the run list
    // or the jobs list. Attempt 1's failed check run must leave with attempt 1's jobs.
    it.each([
        ["the check runs", "/check-runs?"],
        ["the run list", "/actions/runs?"],
        ["the jobs list", "/jobs?"],
    ])(
        "a re-run before %s answers discards the old attempt's check runs with its jobs",
        async (_name, landsOn) => {
            let rerunOnce = true;
            // Each job's check run, named so the CI/CD filter keeps it in the snapshot.
            const checkRunsOf = (positions: number[], failed: number[]) =>
                positions.map((n) => ({
                    id: 2_000_000 + n,
                    name: `build ${n}`,
                    status: "completed",
                    conclusion: failed.includes(n) ? "failure" : "success",
                }));
            const attempt2 = [101, 102, 103].map((n) => job(n, "success", { run_attempt: 2 }));
            const st = state({
                runs: [run({ status: "completed", conclusion: "failure", run_attempt: 1 })],
                jobsByRun: new Map([[String(runFixture.id), jobs(3, [1])]]),
                checkRuns: checkRunsOf([1, 2, 3], [1]),
                onRequest: (url) => {
                    if (!url.includes(landsOn) || !rerunOnce) return;
                    rerunOnce = false;
                    st.runs = [run({ status: "completed", conclusion: "success", run_attempt: 2 })];
                    st.jobsByRun.set(String(runFixture.id), attempt2);
                    st.checkRuns = checkRunsOf([101, 102, 103], []);
                },
            });
            const gh = fakeGitHub(st);
            const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);
            const store = memento();
            const service = new CommitCiDetailService({
                persistentCache: new CiDetailPersistentCache(store),
            });

            const detail = await service.getOrFetch(KEY, () => provider.getDetail(ref, SHA), SERVE);
            expect(
                detail.otherChecks.map((check) => check.id),
                "old attempt check-runs are not third-party checks",
            ).toEqual([]);
            expect(detail.outcome, "a passing rerun never retains the old failure").toBe("success");
            expect(detail.runs[0].attempt).toBe(2);

            const restarted = new CommitCiDetailService({
                persistentCache: new CiDetailPersistentCache(store),
            });
            const refetch = vi.fn(() => provider.getDetail(ref, SHA));
            const afterRestart = await restarted.getOrFetch(KEY, refetch, SERVE);
            expect(afterRestart.outcome, "the stale failure must not survive a restart").toBe(
                "success",
            );
        },
    );

    it("a run that re-runs during every read stops after three reads and is never complete", async () => {
        let attempt = 1;
        const st = state({
            runs: [run({ status: "completed", conclusion: "success", run_attempt: attempt })],
            onRequest: (url) => {
                if (!url.includes("/jobs?")) return;
                attempt += 1;
                st.runs = [
                    run({ status: "completed", conclusion: "success", run_attempt: attempt }),
                ];
            },
        });
        const gh = fakeGitHub(st);
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(gh.log.filter((url) => url.includes("/actions/runs?"))).toHaveLength(3);
        expect(detail).toMatchObject({ outcome: "success", complete: false });
    });

    // GitHub publishes a re-run's attempt on the run before its jobs and check runs catch up.
    // Live runs of MaheshKok/IntelliGit re-run with `--failed` (2026-11-10) list every latest
    // job under the run's attempt and every job's check run in the snapshot.
    const attempt2Run = () => run({ status: "completed", conclusion: "success", run_attempt: 2 });
    const staleFailedCheckRun = {
        id: 2_000_001,
        name: "build 1",
        status: "completed",
        conclusion: "failure",
    };
    const freshCheckRun = {
        id: 2_000_101,
        name: "build 101",
        status: "completed",
        conclusion: "success",
    };

    it("a run that announces attempt 2 while its jobs still return attempt 1 is not complete", async () => {
        const gh = fakeGitHub(
            state({
                runs: [attempt2Run()],
                jobsByRun: new Map([
                    [String(runFixture.id), [job(1, "success", { run_attempt: 1 })]],
                ]),
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.complete, "attempt 2 with attempt 1's jobs is not complete").toBe(false);
        expect(
            gh.log.filter((url) => url.includes("/actions/runs?")),
            "the mismatch restarts the whole read",
        ).toHaveLength(3);
    });

    it("a job that names no attempt or check run does not hold the read open", async () => {
        const bare = job(1, "success");
        delete bare.run_attempt;
        delete bare.check_run_url;
        const gh = fakeGitHub(
            state({
                runs: [run({ status: "completed", conclusion: "success" })],
                jobsByRun: new Map([[String(runFixture.id), [bare]]]),
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.complete, "nothing to compare is not a mismatch").toBe(true);
        expect(gh.log.filter((url) => url.includes("/actions/runs?"))).toHaveLength(1);
    });

    it("a snapshot still holding attempt 1's failed check run is read again: never shown, never saved", async () => {
        let checkRunReads = 0;
        const st = state({
            runs: [attempt2Run()],
            jobsByRun: new Map([
                [String(runFixture.id), [job(101, "success", { run_attempt: 2 })]],
            ]),
            jobCheckRuns: false,
            checkRuns: [staleFailedCheckRun],
            onRequest: (url) => {
                // The first snapshot lags behind the run list; the next one has caught up.
                if (url.includes("/check-runs?") && ++checkRunReads === 2) {
                    st.checkRuns = [freshCheckRun];
                }
            },
        });
        const gh = fakeGitHub(st);
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);
        const store = memento();
        const written: string[] = [];
        const recording: CommitChecksPersistentState = {
            get: store.get,
            update: async (key, value) => {
                written.push(JSON.stringify(value) ?? "");
                await store.update(key, value);
            },
        };
        const service = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(recording),
        });

        const detail = await service.getOrFetch(KEY, () => provider.getDetail(ref, SHA), SERVE);
        expect(detail.otherChecks, "attempt 1's check run is not a third-party check").toEqual([]);
        expect(detail.outcome, "the stale failure is not the outcome").toBe("success");
        expect(gh.log.filter((url) => url.includes("/actions/runs?"))).toHaveLength(2);
        expect(
            written.filter((payload) => payload.includes(String(staleFailedCheckRun.id))),
            "the stale read never reaches storage",
        ).toEqual([]);
    });

    it("a snapshot that lags through every read is incomplete and unsaved; a restart fetches it again", async () => {
        const st = state({
            runs: [attempt2Run()],
            jobsByRun: new Map([
                [String(runFixture.id), [job(101, "success", { run_attempt: 2 })]],
            ]),
            jobCheckRuns: false,
            checkRuns: [staleFailedCheckRun],
        });
        const gh = fakeGitHub(st);
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);
        const store = memento();
        const first = await new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(store),
        }).getOrFetch(KEY, () => provider.getDetail(ref, SHA), SERVE);
        expect(first.complete, "a mismatched last read is never complete").toBe(false);
        expect(await new CiDetailPersistentCache(store).get(KEY)).toBeUndefined();

        st.checkRuns = [freshCheckRun];
        const refetch = vi.fn(() => provider.getDetail(ref, SHA));
        const afterRestart = await new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(store),
        }).getOrFetch(KEY, refetch, SERVE);
        expect(afterRestart.outcome, "the stale failure must not survive a restart").toBe(
            "success",
        );
        expect(refetch).toHaveBeenCalledOnce();
    });

    it.each([1000, 1001])(
        "at %i check suites, a job whose check suite GitHub leaves out of the ref's snapshot is found in its suite: complete, flat list partial, one read per fetch",
        async (checkSuiteCount) => {
            const gh = fakeGitHub(
                state({
                    runs: [run({ status: "completed", conclusion: "success" })],
                    jobsByRun: new Map([[String(runFixture.id), [job(1, "success")]]]),
                    // At GitHub's 1 000-suite ref limit: this run's suite is not in the snapshot.
                    jobCheckRuns: false,
                    checkSuiteCount,
                }),
            );
            const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);
            let clock = 0;
            const store = memento();
            const service = new CommitCiDetailService({
                now: () => clock,
                persistentCache: new CiDetailPersistentCache(store),
            });
            const reads = () => gh.log.filter((url) => url.includes("/actions/runs?")).length;

            const detail = await service.getOrFetch(KEY, () => provider.getDetail(ref, SHA), SERVE);
            expect(detail.complete, "every job finished: execution is complete").toBe(true);
            expect(detail.otherChecksCoverage, "the suite limit is a coverage gap").toEqual({
                reason: "pageBound",
                shown: 0,
            });
            expect(
                gh.log.some((url) =>
                    url.includes(`/check-suites/${runFixture.check_suite_id}/check-runs?`),
                ),
                "the job's check run is read from its own suite",
            ).toBe(true);
            expect(reads(), "a found check run does not restart the read").toBe(1);
            expect(await new CiDetailPersistentCache(store).get(KEY)).toBeUndefined();

            clock = 31_000;
            await service.getOrFetch(KEY, () => provider.getDetail(ref, SHA), SERVE);
            expect(reads(), "one read per fetch after the pending TTL").toBe(2);
        },
    );

    it.each([1000, 1001])(
        "at %i check suites with every job in the snapshot, the flat list is still partial and the detail is never saved",
        async (checkSuiteCount) => {
            const gh = fakeGitHub(
                state({
                    runs: [run({ status: "completed", conclusion: "success" })],
                    jobsByRun: new Map([[String(runFixture.id), [job(1, "success")]]]),
                    checkSuiteCount,
                }),
            );
            const store = memento();
            const detail = await new CommitCiDetailService({
                persistentCache: new CiDetailPersistentCache(store),
            }).getOrFetch(
                KEY,
                () =>
                    new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta).getDetail(
                        ref,
                        SHA,
                    ),
                SERVE,
            );
            expect(detail.complete, "every job finished: execution is complete").toBe(true);
            expect(
                detail.otherChecksCoverage,
                "older suites' third-party checks may be hidden",
            ).toEqual({ reason: "pageBound", shown: 0 });
            expect(
                await new CiDetailPersistentCache(store).get(KEY),
                "a partial flat list never reaches storage",
            ).toBeUndefined();
        },
    );

    it("below the suite limit with every job in the snapshot, the flat list is full and the detail is saved", async () => {
        const gh = fakeGitHub(
            state({
                runs: [run({ status: "completed", conclusion: "success" })],
                jobsByRun: new Map([[String(runFixture.id), [job(1, "success")]]]),
                checkSuiteCount: 999,
            }),
        );
        const store = memento();
        const detail = await new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(store),
        }).getOrFetch(
            KEY,
            () => new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta).getDetail(ref, SHA),
            SERVE,
        );
        expect(detail.otherChecksCoverage, "999 suites are all in the snapshot").toBe("full");
        expect(await new CiDetailPersistentCache(store).get(KEY)).toBeDefined();
    });

    it("past the suite limit, a job missing from its own suite too still restarts the read", async () => {
        const gh = fakeGitHub(
            state({
                runs: [run({ status: "completed", conclusion: "success" })],
                jobsByRun: new Map([[String(runFixture.id), [job(1, "success")]]]),
                jobCheckRuns: false,
                suiteCheckRuns: false,
                checkSuiteCount: 1001,
            }),
        );
        const detail = await new GitHubProvider(
            gh.fetchJson,
            undefined,
            gh.fetchWithMeta,
        ).getDetail(ref, SHA);
        expect(detail.complete, "a check run found nowhere is a lagging read").toBe(false);
        expect(gh.log.filter((url) => url.includes("/actions/runs?"))).toHaveLength(3);
    });
});

function memento(): CommitChecksPersistentState {
    const values = new Map<string, unknown>();
    return {
        get: (key: string) => values.get(key),
        update: async (key: string, value: unknown) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        },
    };
}

describe("failed-job overflow scan", () => {
    const FAILED_RUN = run({ conclusion: "failure" });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** The coordinator's wiring: scan pages read by the provider, posts to the requester. */
    function scanning(
        gh: ReturnType<typeof fakeGitHub>,
        provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta),
    ) {
        const service = new CommitCiDetailService();
        const posts: CommitCiDetail[] = [];
        const hooks: CiFailedScanHooks = {
            continueScan: (cursor) => provider.continueFailedScan(ref, cursor),
            isCurrent: () => true,
            onUpdate: (detail) => posts.push(detail),
        };
        const get = (force = false) =>
            service.getOrFetch(
                KEY,
                () => provider.getDetail(ref, SHA),
                SERVE,
                { force },
                undefined,
                hooks,
            );
        const last = () => posts[posts.length - 1];
        return { service, posts, get, last };
    }

    it("failed jobs at positions 1 050 and 1 900 are listed", async () => {
        const all = failedRunJobs();
        // Plus one failed job inside the bound, which the scan must not count as found.
        all[4] = job(5, "failure");
        const gh = fakeGitHub(
            state({ runs: [FAILED_RUN], jobsByRun: new Map([[String(runFixture.id), all]]) }),
        );
        const { get, last } = scanning(gh);

        const first = await get();
        expect(first.runs[0].jobs).toHaveLength(1000);
        expect(first.runs[0].failedScan).toEqual({ state: "running", found: 0 });

        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedIds(last())).toEqual(["job 5", "job 1050", "job 1900"]);
        expect(last().runs[0].failedScan).toEqual({ state: "done", found: 2 });
        expect(last().runs[0].jobsCoverage).toEqual({ reason: "pageBound", shown: 1000 });
        expect(scanPages(gh.log)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        // An L1 hit serves the found jobs too.
        expect(failedIds(await get())).toEqual(["job 5", "job 1050", "job 1900"]);
    });

    it("failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        let cooldownOnce = true;
        let failOnce = true;
        const st = state({
            runs: [FAILED_RUN],
            jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
        });
        const gh = fakeGitHub(st);
        // The gate refuses page 12 once (cooldown); page 15 fails once with a server error.
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            if (isJobsPage(url, 12) && cooldownOnce) {
                cooldownOnce = false;
                throw new RequestGateCooldownError("paused", Date.now() + 30_000);
            }
            if (isJobsPage(url, 15) && failOnce) {
                failOnce = false;
                throw new HttpError(500, "HTTP 500: boom", {});
            }
            return gh.fetchWithMeta(url, headers);
        };
        const { get, last } = scanning(
            gh,
            new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta),
        );

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("paused"));
        expect(last().runs[0].failedScan).toEqual({ state: "paused", found: 1 });
        expect(failedIds(last())).toEqual(["job 1050"]);

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(last().runs[0].failedScan).toEqual({
            state: "stopped",
            found: 1,
            error: "HTTP 500: boom",
        });
        expect(failedIds(last())).toEqual(["job 1050"]);

        const refreshed = await get(true);
        expect(failedIds(refreshed)).toEqual(["job 1050"]);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedIds(last())).toEqual(["job 1050", "job 1900"]);
        // Each page past the bound reached the API once: the refresh resumed at page 15.
        expect(scanPages(gh.log)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });

    it("run attempt changed → scan restarts", async () => {
        let failPage12 = true;
        const st = state({
            runs: [run({ conclusion: "failure", run_attempt: 1 })],
            jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
            fail: (url) =>
                isJobsPage(url, 12) && failPage12 ? new HttpError(500, "HTTP 500", {}) : undefined,
        });
        const gh = fakeGitHub(st);
        const { get, last } = scanning(gh);

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(failedIds(last())).toEqual(["job 1050"]);

        // A re-run: attempt 2 whose only failure past the bound is job 1900.
        failPage12 = false;
        st.runs = [run({ conclusion: "failure", run_attempt: 2 })];
        st.jobsByRun.set(String(runFixture.id), jobs(2000, [1900], { run_attempt: 2 }));
        gh.log.length = 0;

        const refreshed = await get(true);
        expect(refreshed.runs[0].failedScan).toEqual({ state: "running", found: 0 });
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedIds(last())).toEqual(["job 1900"]);
        expect(scanPages(gh.log)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });

    it("a next link back to a page the scan already read stops it with the jobs found so far", async () => {
        const refused = "The provider's next-page link was refused.";
        // Page 11 links to itself; page 13 links back to page 12. Each loop answers at most
        // five times, so a scan that follows it ends instead of hanging the test.
        const loops = (from: number, to: number) => {
            let left = 5;
            return (url: string, page: number) =>
                url.includes("/jobs?") && page === from && left-- > 0
                    ? jobsPageUrl(runFixture.id, to)
                    : undefined;
        };
        for (const [from, to, read] of [
            [11, 11, [11]],
            [13, 12, [11, 12, 13]],
        ] as const) {
            const gh = fakeGitHub(
                state({
                    runs: [FAILED_RUN],
                    jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                    nextLink: loops(from, to),
                }),
            );
            const { get, last, posts } = scanning(gh);

            await get();
            await vi.waitFor(() =>
                expect(["stopped", "done"]).toContain(last()?.runs[0].failedScan?.state),
            );
            expect(scanPages(gh.log), `loop ${from}->${to} reads each page once`).toEqual(read);
            expect(last().runs[0].failedScan).toEqual({
                state: "stopped",
                found: 1,
                error: refused,
            });
            expect(failedIds(last())).toEqual(["job 1050"]);

            // Refresh resumes at the looping page: one request, then the same refusal.
            gh.log.length = 0;
            const before = posts.length;
            await get(true);
            await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
            expect(last().runs[0].failedScan?.state).toBe("stopped");
            expect(scanPages(gh.log), `loop ${from}->${to} Refresh reads one page`).toEqual([from]);
            expect(failedIds(last())).toEqual(["job 1050"]);
        }
    });

    it("a next link that respells a read page or reads no jobs stays bounded by the run's job count", async () => {
        const refused = "The provider's next-page link was refused.";
        // Each case answers with a fresh link at most 50 times, so an unbounded scan ends the test.
        const cases: readonly {
            name: string;
            link: (page: number, n: number) => string | undefined;
            read: readonly number[];
        }[] = [
            // Node drops the fragment, so every alias requests page 11 again.
            {
                name: "fragment alias",
                link: (page, n) =>
                    page === 11 ? `${jobsPageUrl(runFixture.id, 11)}#a${n}` : undefined,
                read: [11],
            },
            // A distinct query each time: only the run's 2 000 jobs bound it, 10 pages past 1 000.
            {
                name: "query alias",
                link: (page, n) =>
                    page === 11 ? `${jobsPageUrl(runFixture.id, 11)}&nonce=${n}` : undefined,
                read: Array.from({ length: 10 }, () => 11),
            },
            // Pages past the end hold no jobs; one of them linking onward makes no progress.
            {
                name: "empty pages",
                link: (page) =>
                    page === 12 || page >= 30
                        ? jobsPageUrl(runFixture.id, Math.max(page + 1, 30))
                        : undefined,
                read: [11, 12, 30],
            },
        ];
        for (const { name, link, read } of cases) {
            let n = 0;
            const gh = fakeGitHub(
                state({
                    runs: [FAILED_RUN],
                    jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                    nextLink: (url, page) =>
                        url.includes("/jobs?") && n < 50 ? link(page, ++n) : undefined,
                }),
            );
            const { get, last, posts } = scanning(gh);

            await get();
            await vi.waitFor(() =>
                expect(["stopped", "done"]).toContain(last()?.runs[0].failedScan?.state),
            );
            expect(scanPages(gh.log), `${name} reads a bounded set of pages`).toEqual(read);
            expect(last().runs[0].failedScan, name).toEqual({
                state: "stopped",
                found: 1,
                error: refused,
            });
            expect(failedIds(last())).toEqual(["job 1050"]);

            gh.log.length = 0;
            const before = posts.length;
            await get(true);
            await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
            expect(last().runs[0].failedScan?.state, name).toBe("stopped");
            expect(scanPages(gh.log), `${name} Refresh reads one page`).toEqual([read.at(-1)]);
        }
    });

    it("a total_count that grows on every response never raises the scan's job budget", async () => {
        const refused = "The provider's next-page link was refused.";
        // Each response reports 100 more jobs than the last; the second case's first 1 000 report
        // none, so the budget is the first scan page's count.
        for (const [name, firstPagesCarryTotal] of [
            ["first read total", true],
            ["first scan page total", false],
        ] as const) {
            let responses = 0;
            let n = 0;
            const gh = fakeGitHub(
                state({
                    runs: [FAILED_RUN],
                    jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                    // Page 11 again under a new query, at most 50 times so an unbounded scan ends.
                    nextLink: (url, page) =>
                        url.includes("/jobs?") && page === 11 && n < 50
                            ? `${jobsPageUrl(runFixture.id, 11)}&nonce=${++n}`
                            : undefined,
                    jobsTotal: (total, page) =>
                        firstPagesCarryTotal || page > 10 ? total + 100 * responses++ : undefined,
                }),
            );
            const { get, last, posts } = scanning(gh);

            await get();
            await vi.waitFor(() =>
                expect(["stopped", "done"]).toContain(last()?.runs[0].failedScan?.state),
            );
            // The first count read said 2 000 jobs: 1 000 read, so ten pages of 100 past the bound.
            expect(scanPages(gh.log), `${name} reads only the first budget`).toEqual(
                Array.from({ length: 10 }, () => 11),
            );
            expect(last().runs[0].failedScan, name).toEqual({
                state: "stopped",
                found: 1,
                error: refused,
            });

            gh.log.length = 0;
            const before = posts.length;
            await get(true);
            await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
            expect(last().runs[0].failedScan?.state, name).toBe("stopped");
            expect(scanPages(gh.log), `${name} Refresh reads one page`).toEqual([11]);
        }
    });

    it("the first scan total is retained even when that page refuses its next link", async () => {
        let responses = 0;
        let n = 0;
        const gh = fakeGitHub(
            state({
                runs: [FAILED_RUN],
                jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                nextLink: (url, page) =>
                    url.includes("/jobs?") && page === 11 && n < 50
                        ? `${jobsPageUrl(runFixture.id, 11)}&nonce=${++n}`
                        : undefined,
                // The first 1 000 name no count; the first scan page says 1 100, every later one 2 000.
                jobsTotal: (_total, page) =>
                    page > 10 ? (responses++ === 0 ? 1100 : 2000) : undefined,
            }),
        );
        const { get, last, posts } = scanning(gh);

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(scanPages(gh.log), "the first scan page reaches its own 1 100-job budget").toEqual([
            11,
        ]);

        gh.log.length = 0;
        const before = posts.length;
        await get(true);
        await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
        expect(last().runs[0].failedScan?.state).toBe("stopped");
        expect(scanPages(gh.log), "Refresh must retain the first scan's 1100-job budget").toEqual([
            11,
        ]);
    });

    it.each(["malformed Link", "post-page run read fails", "post-page cooldown"] as const)(
        "the first scan total is retained when the scan stops or pauses after that page on a %s",
        async (boundary) => {
            const cooldown = boundary === "post-page cooldown";
            if (cooldown) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            let responses = 0;
            let n = 0;
            const gh = fakeGitHub(
                state({
                    runs: [FAILED_RUN],
                    jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                    nextLink: (url, page) =>
                        url.includes("/jobs?") && page === 11 && n < 50
                            ? `${jobsPageUrl(runFixture.id, 11)}&nonce=${++n}`
                            : undefined,
                    // The first scan page says 1 100 jobs, every later response 2 000.
                    jobsTotal: (_total, page) =>
                        page > 10 ? (responses++ === 0 ? 1100 : 2000) : undefined,
                }),
            );
            let failRunRead = false;
            let injected = false;
            // The first scan page answers, then its Link header or the run check after it fails.
            const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
                if (failRunRead && /\/actions\/runs\/\d+$/.test(url)) {
                    failRunRead = false;
                    if (cooldown) throw new RequestGateCooldownError("paused", Date.now() + 1000);
                    throw new HttpError(500, "HTTP 500: boom", {});
                }
                const response = await gh.fetchWithMeta(url, headers);
                if (!injected && isJobsPage(url, 11)) {
                    injected = true;
                    if (boundary === "malformed Link") {
                        return { ...response, headers: { link: "<bad>; rel=" } };
                    }
                    failRunRead = true;
                }
                return response;
            };
            const { get, last, posts } = scanning(
                gh,
                new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta),
            );

            await get();
            await vi.waitFor(() =>
                expect(last()?.runs[0].failedScan?.state).toBe(cooldown ? "paused" : "stopped"),
            );
            expect(scanPages(gh.log), "the first 1 100-job response was read once").toEqual([11]);

            gh.log.length = 0;
            const before = posts.length;
            if (cooldown) await vi.advanceTimersByTimeAsync(1000);
            else await get(true);
            await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
            await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
            expect(
                scanPages(gh.log),
                `${boundary}: the resumed scan must retain the first 1100-job budget`,
            ).toEqual([11]);
        },
    );

    it("a missing first scan total cannot become a larger budget on Refresh", async () => {
        let responses = 0;
        let n = 0;
        const gh = fakeGitHub(
            state({
                runs: [FAILED_RUN],
                jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                nextLink: (url, page) =>
                    url.includes("/jobs?") && page === 11 && n < 30
                        ? `${jobsPageUrl(runFixture.id, 11)}&nonce=${++n}`
                        : undefined,
                // Neither the first 1 000 nor the first scan page name a count; later ones say 2 000.
                jobsTotal: (_total, page) => (page > 10 && responses++ > 0 ? 2000 : undefined),
            }),
        );
        const { get, last, posts } = scanning(gh);

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(scanPages(gh.log), "a missing first total refuses the next link").toEqual([11]);

        gh.log.length = 0;
        const before = posts.length;
        await get(true);
        await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(
            scanPages(gh.log),
            "a missing first total still refuses the next link after Refresh",
        ).toEqual([11]);
    });

    it.each<[string, number | undefined]>([
        [
            "a scan page dropped by a lifecycle bump still hands its missing first total to the scan",
            undefined,
        ],
        // A named total gives the dropped page an onward link the cursor must not take.
        ["a scan page dropped by a lifecycle bump never moves the scan to its next link", 2000],
    ])("%s", async (_name, firstTotal) => {
        let responses = 0;
        let n = 0;
        const gh = fakeGitHub(
            state({
                runs: [FAILED_RUN],
                jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                nextLink: (url, page) =>
                    url.includes("/jobs?") && page === 11 && n < 30
                        ? `${jobsPageUrl(runFixture.id, 11)}&nonce=${++n}`
                        : undefined,
                // The first 1 000 never name a count; the first scan page names `firstTotal`, later ones 2 000.
                jobsTotal: (_total, page) =>
                    page <= 10 ? undefined : responses++ > 0 ? 2000 : firstTotal,
            }),
        );
        let release!: () => void;
        const held = new Promise<void>((done) => {
            release = done;
        });
        let holdFirstScanPage = true;
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            const response = await gh.fetchWithMeta(url, headers);
            if (holdFirstScanPage && isJobsPage(url, 11)) {
                holdFirstScanPage = false;
                await held;
            }
            return response;
        };
        const generations = new CiGenerations();
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(async () => "https://github.com/microsoft/vscode.git"),
        } as unknown as GitOps;
        const coordinator = new CommitChecksCoordinator(
            gitOps,
            [new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta)],
            {},
            { generations },
        );
        const stalePosts: CommitCiDetail[] = [];
        await coordinator.getDetail(SHA, {}, generations.capture("/repo"), (detail) =>
            stalePosts.push(detail),
        );
        await vi.waitFor(() => expect(scanPages(gh.log)).toEqual([11]));

        // A discovered repository closes while the first scan page is in flight.
        generations.bumpLifecycle();
        release();
        // Lets the dropped page's scan loop finish before the next request starts one.
        await new Promise((done) => setTimeout(done, 0));

        const droppedUrl = gh.log.find((url) => isJobsPage(url, 11));
        gh.log.length = 0;
        const posts: CommitCiDetail[] = [];
        await coordinator.getDetail(SHA, {}, generations.capture("/repo"), (detail) =>
            posts.push(detail),
        );
        await vi.waitFor(() =>
            expect(["stopped", "done"]).toContain(posts.at(-1)?.runs[0].failedScan?.state),
        );
        expect(stalePosts, "the dropped page is never published").toEqual([]);
        expect(
            gh.log.find((url) => isJobsPage(url, 11)),
            "the cursor never moves to the dropped page's next link",
        ).toBe(droppedUrl);
        if (firstTotal === undefined) {
            expect(
                scanPages(gh.log),
                "same scan retains its first missing budget after a lifecycle interruption",
            ).toEqual([11]);
        }
    });

    it("a scan page holding another attempt's job is discarded on a stable run, never posted as a failure", async () => {
        const attempt2Jobs = () => jobs(2000, [1900], { run_attempt: 2 });
        const lagging = attempt2Jobs();
        // GitHub's job list still answers page 11 with attempt 1's failed job 1050.
        lagging[1049] = job(1050, "failure", { run_attempt: 1 });
        const st = state({
            runs: [run({ conclusion: "failure", run_attempt: 2 })],
            jobsByRun: new Map([[String(runFixture.id), lagging]]),
        });
        const gh = fakeGitHub(st);
        const { get, last } = scanning(gh);

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(failedIds(last()), "attempt 1's job is not a current failure").toEqual([]);
        expect(last().runs[0].failedScan).toEqual({
            state: "stopped",
            found: 0,
            error: "Remote data changed. Reload and try again.",
        });

        // Once GitHub catches up, a refresh scans again from the first page past the bound.
        st.jobsByRun.set(String(runFixture.id), attempt2Jobs());
        await get(true);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedIds(last())).toEqual(["job 1900"]);
        expect(scanPages(gh.log)).toEqual([11, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });

    it("a later scan page holding another attempt's job leaves the detail incomplete, and Refresh scans from scratch", async () => {
        const attempt2Jobs = () => jobs(2000, [1050, 1900], { run_attempt: 2 });
        const lagging = attempt2Jobs();
        // Page 11 is attempt 2's; page 12 still answers with one of attempt 1's jobs.
        lagging[1149] = job(1150, "success", { run_attempt: 1 });
        const st = state({
            runs: [run({ conclusion: "failure", run_attempt: 2 })],
            jobsByRun: new Map([[String(runFixture.id), lagging]]),
        });
        const gh = fakeGitHub(st);
        const { get, last } = scanning(gh);

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(last().runs[0].failedScan?.error).toBe("Remote data changed. Reload and try again.");
        expect(last().complete, "an attempt-mismatched scan stays incomplete").toBe(false);

        st.jobsByRun.set(String(runFixture.id), attempt2Jobs());
        gh.log.length = 0;
        await get(true);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(scanPages(gh.log), "Refresh starts the stopped scan from scratch").toEqual([
            11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        ]);
        expect(failedIds(last())).toEqual(["job 1050", "job 1900"]);
    });

    it("a re-run between the run check and a scan page's answer stops the scan, never mixes attempts, and Refresh scans the new attempt", async () => {
        let rerunOnce = true;
        const st = state({
            runs: [run({ conclusion: "failure", run_attempt: 1 })],
            jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
            onRequest: (url) => {
                // The re-run lands after the provider checked the run, before the last page
                // answers, so no later page check can catch it.
                if (!isJobsPage(url, 20) || !rerunOnce) return;
                rerunOnce = false;
                st.runs = [run({ conclusion: "failure", run_attempt: 2 })];
                st.jobsByRun.set(String(runFixture.id), jobs(2000, [1950], { run_attempt: 2 }));
            },
        });
        const gh = fakeGitHub(st);
        const { get, last } = scanning(gh);

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(last().runs[0].failedScan?.error).toBe("Remote data changed. Reload and try again.");
        expect(last().complete).toBe(false);
        expect(last().runs[0].attempt).toBe(1);
        expect(failedIds(last()), "only attempt 1's own failed jobs").toEqual([
            "job 1050",
            "job 1900",
        ]);

        await get(true);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(last().runs[0].attempt, "the scan finished on the new attempt").toBe(2);
        expect(failedIds(last()), "only the new attempt's failed job").toEqual(["job 1950"]);
        expect(last().runs[0].failedScan).toEqual({ state: "done", found: 1 });
    });

    it("a run list and single-run read that keep disagreeing on the attempt end the scan, never refetch without bound", async () => {
        const gh = fakeGitHub(
            state({
                runs: [run({ conclusion: "failure", run_attempt: 1 })],
                jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
            }),
        );
        const runCheck = `${API}/repos/microsoft/vscode/actions/runs/${runFixture.id}`;
        // The single-run endpoint already names attempt 2; the run and job lists still say 1.
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            const response = await gh.fetchWithMeta(url, headers);
            if (url !== runCheck) return response;
            // A real request yields to timers; a refetch loop must not starve the test's own.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return { ...response, body: { ...(response.body as Run), run_attempt: 2 } };
        };
        const provider = new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta);
        const getDetail = vi.spyOn(provider, "getDetail");
        const { get, posts } = scanning(gh, provider);

        const first = await get();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
            getDetail.mock.calls.length,
            "the endpoints' disagreement must not refetch the detail without bound",
        ).toBeLessThanOrEqual(2);
        // The read never agreed on one attempt, so no scan page is read or posted.
        const shown = posts.at(-1) ?? first;
        expect(shown.runs[0].failedScan).toEqual({
            state: "stopped",
            found: 0,
            error: "Remote data changed. Reload and try again.",
        });
        expect(failedIds(shown), "attempt 1's jobs are not attempt 2's failures").toEqual([]);
    });

    it("an attempt-2 single-run read and attempt-2 pages past the bound never put an attempt-2 job under attempt 1", async () => {
        // The first 1 000 jobs are attempt 1's but one already caught up; the pages past the
        // bound hold attempt 2's jobs, failed at 1 050 and 1 900.
        const mixed = [
            ...jobs(1000, [], { run_attempt: 1 }),
            ...jobs(2000, [1050, 1900], { run_attempt: 2 }).slice(1000),
        ];
        // Named so the CI/CD filter keeps its check run in the snapshot.
        mixed[998] = job(999, "failure", { run_attempt: 2, name: "unit tests 999" });
        const gh = fakeGitHub(
            state({
                runs: [run({ conclusion: "failure", run_attempt: 1 })],
                jobsByRun: new Map([[String(runFixture.id), mixed]]),
            }),
        );
        const runCheck = `${API}/repos/microsoft/vscode/actions/runs/${runFixture.id}`;
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            const response = await gh.fetchWithMeta(url, headers);
            if (url !== runCheck) return response;
            await new Promise((resolve) => setTimeout(resolve, 0));
            return { ...response, body: { ...(response.body as Run), run_attempt: 2 } };
        };
        const provider = new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta);
        const getDetail = vi.spyOn(provider, "getDetail");
        const { get, posts } = scanning(gh, provider);

        const first = await get();
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (const detail of [first, ...posts]) {
            expect(detail.runs[0].attempt).toBe(1);
            expect(
                detail.runs[0].jobs.filter((j) => j.attempt !== 1).map((j) => j.name),
                "no attempt-2 job is shown under attempt 1",
            ).toEqual([]);
        }
        const shown = posts.at(-1) ?? first;
        expect(
            shown.otherChecks.map((check) => check.name),
            "a hidden job's check run does not come back as a flat check",
        ).toEqual([]);
        expect(shown.complete, "a detail read across two attempts is never complete").toBe(false);
        expect(shown.runs[0].failedScan).toEqual({
            state: "stopped",
            found: 0,
            error: "Remote data changed. Reload and try again.",
        });
        expect(getDetail.mock.calls.length, "no read restarts without bound").toBe(1);
    });

    it("automatic cooldown resume rechecks a run changed from another device and stops; Refresh scans the new attempt", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        let cooldownOnce = true;
        const st = state({
            runs: [run({ conclusion: "failure", run_attempt: 1 })],
            jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
        });
        const gh = fakeGitHub(st);
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            if (isJobsPage(url, 12) && cooldownOnce) {
                cooldownOnce = false;
                // Another device re-runs the run while this scan waits out the cooldown.
                st.runs = [run({ conclusion: "failure", run_attempt: 2 })];
                st.jobsByRun.set(String(runFixture.id), jobs(2000, [1900], { run_attempt: 2 }));
                throw new RequestGateCooldownError("paused", Date.now() + 30_000);
            }
            return gh.fetchWithMeta(url, headers);
        };
        const { get, last } = scanning(
            gh,
            new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta),
        );

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("paused"));
        expect(failedIds(last())).toEqual(["job 1050"]);

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(last().runs[0].failedScan?.error).toBe("Remote data changed. Reload and try again.");
        expect(last().complete).toBe(false);

        await get(true);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedIds(last())).toEqual(["job 1900"]);
        expect(last().runs[0].attempt).toBe(2);
        expect(last().runs[0].failedScan).toEqual({ state: "done", found: 1 });
    });

    it("cooldown that begins after the precheck pauses the scan and keeps the cursor", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const blockers: (() => void)[] = [];
        const blocked: Promise<unknown>[] = [];
        const runCheck = `${API}/repos/microsoft/vscode/actions/runs/${runFixture.id}`;
        let page11Read = false;
        const st = state({
            runs: [FAILED_RUN],
            jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
            onRequest: (url) => {
                page11Read ||= isJobsPage(url, 11);
                // While page 11's run check holds a slot, fill the bucket so page 12's must queue.
                if (!page11Read || url !== runCheck || blockers.length > 0) return;
                for (let i = 0; i < 4; i++) {
                    blocked.push(
                        registry
                            .run(
                                "github",
                                API,
                                () => new Promise<void>((resolve) => blockers.push(resolve)),
                            )
                            .catch(() => undefined),
                    );
                }
            },
        });
        const gh = fakeGitHub(st);
        const entered: string[] = [];
        const gated = gatedFetchWithMeta(registry, "github", () => gh.fetchWithMeta);
        const provider = new GitHubProvider(gh.fetchJson, undefined, (url, headers) => {
            entered.push(url);
            return gated(url, headers);
        });
        const { get, last } = scanning(gh, provider);

        await get();
        // Run checks: after the bounded jobs, before and after page 11, then page 12's
        // precheck, which waits for a slot.
        await vi.waitFor(() => expect(entered.filter((url) => url === runCheck)).toHaveLength(4));
        expect(gh.log.filter((url) => url === runCheck)).toHaveLength(3);
        expect(gh.log.some((url) => isJobsPage(url, 12))).toBe(false);
        registry.observeResponse("github", {
            url: API,
            statusCode: 429,
            headers: { "retry-after": "30" },
        });
        for (const release of blockers) release();
        await Promise.all(blocked);

        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("paused"));
        expect(last().runs[0].failedScan).toEqual({ state: "paused", found: 1 });
        expect(failedIds(last())).toEqual(["job 1050"]);

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedIds(last())).toEqual(["job 1050", "job 1900"]);
        expect(scanPages(gh.log)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });

    /** A provider whose scan pages go through a real gate, with one page answered by `error`. */
    function gatedScan(failPage: number, error: () => HttpError) {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        let failOnce = true;
        const gh = fakeGitHub(
            state({
                runs: [FAILED_RUN],
                jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                fail: (url) => {
                    if (!failOnce || !isJobsPage(url, failPage)) return undefined;
                    failOnce = false;
                    return error();
                },
            }),
        );
        const provider = new GitHubProvider(
            gh.fetchJson,
            undefined,
            gatedFetchWithMeta(registry, "github", () => gh.fetchWithMeta),
            (url) => registry.cooldownEnd("github", url),
        );
        return { gh, ...scanning(gh, provider) };
    }

    it.each([
        ["a server 429", () => new HttpError(429, "HTTP 429", { "retry-after": "30" })],
        [
            "a quota 403",
            () =>
                new HttpError(403, "HTTP 403", {
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 30),
                }),
        ],
    ])(
        "%s on a scan page pauses the scan, keeps the cursor and resumes at the cooldown end",
        async (_name, error) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            const { gh, get, last } = gatedScan(12, error);

            await get();
            await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("paused"));
            expect(last().runs[0].failedScan).toEqual({ state: "paused", found: 1 });
            expect(failedIds(last())).toEqual(["job 1050"]);

            await vi.advanceTimersByTimeAsync(31_000);
            await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
            expect(failedIds(last())).toEqual(["job 1050", "job 1900"]);
            // Page 12 was requested twice (refused, then resumed); no page was skipped.
            expect(scanPages(gh.log)).toEqual([11, 12, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        },
    );

    it("a permission 403 on a scan page stops the scan with its error", async () => {
        const { get, last } = gatedScan(
            12,
            () => new HttpError(403, "HTTP 403: Resource not accessible", {}),
        );

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(last().runs[0].failedScan).toMatchObject({ state: "stopped", found: 1 });
        expect(failedIds(last())).toEqual(["job 1050"]);
    });

    it("a failed job the scan finds is listed once, never again as a flat check", async () => {
        const gh = fakeGitHub(
            state({
                runs: [FAILED_RUN],
                jobsByRun: new Map([[String(runFixture.id), jobs(1100, [1050])]]),
                checkRuns: [
                    // Job 1050's own check run, and a check run of no job.
                    { id: 2_001_050, name: "build", status: "completed", conclusion: "failure" },
                    { id: 555, name: "lint", status: "completed", conclusion: "success" },
                ],
            }),
        );
        const { get, last } = scanning(gh);
        // Before the scan reaches job 1050, its check run is a flat check.
        expect((await get()).otherChecks.map((check) => check.id)).toEqual(["2001050", "555"]);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedIds(last())).toEqual(["job 1050"]);
        expect(last().otherChecks.map((check) => check.id)).toEqual(["555"]);
        expect((await get()).otherChecks.map((check) => check.id)).toEqual(["555"]);
    });

    it("a scanned job without workflow_name takes its run's name, as on the normal path", async () => {
        const all = jobs(1100, [5, 1050]).map((j) => ({ ...j, workflow_name: undefined }));
        const gh = fakeGitHub(
            state({ runs: [FAILED_RUN], jobsByRun: new Map([[String(runFixture.id), all]]) }),
        );
        const { get, last } = scanning(gh);
        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        const failed = last().runs[0].jobs.filter((j) => j.state === "failure");
        expect(failed.map((j) => j.logicalId)).toEqual([
            logicalCheckId({ kind: "job", scope: runFixture.name, name: "job 5" }),
            logicalCheckId({ kind: "job", scope: runFixture.name, name: "job 1050" }),
        ]);
    });

    it("a refused next link during the scan keeps that page's failed jobs, stops, and sends nothing", async () => {
        const hostile = "https://evil.example/steal?page=12";
        const gh = fakeGitHub(
            state({
                runs: [FAILED_RUN],
                // Job 1050 is on page 11; job 1900 sits behind the refused link.
                jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                nextLink: (url, page) =>
                    url.includes("/jobs?") && page === 11 ? hostile : undefined,
            }),
        );
        const { get, last, posts } = scanning(gh);
        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(gh.log).not.toContain(hostile);
        // The page that named the refused link stops the scan at once: the refused URL never
        // becomes the cursor of a "running" update.
        expect(posts.map((p) => p.runs[0].failedScan?.state)).toEqual(["stopped"]);
        expect(last().runs[0].failedScan).toEqual({
            state: "stopped",
            found: 1,
            error: "The provider's next-page link was refused.",
        });
        expect(failedIds(last())).toEqual(["job 1050"]);
    });

    it("an unreadable Link header on a scan page stops the scan with the error in the user's language", async () => {
        mocks.translations.set("Malformed Link header.", "Fehlerhafter Link-Header.");
        try {
            const gh = fakeGitHub(
                state({
                    runs: [FAILED_RUN],
                    // Job 1050 is on page 11, whose Link header cannot be read.
                    jobsByRun: new Map([[String(runFixture.id), failedRunJobs()]]),
                }),
            );
            const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
                const response = await gh.fetchWithMeta(url, headers);
                if (!url.includes("/jobs?") || !url.endsWith("&page=11")) return response;
                return {
                    ...response,
                    headers: { link: `<${jobsPageUrl(runFixture.id, 12)}>; rel` },
                };
            };
            const { get, last } = scanning(
                gh,
                new GitHubProvider(gh.fetchJson, undefined, fetchWithMeta),
            );
            await get();
            await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
            expect(last().runs[0].failedScan).toEqual({
                state: "stopped",
                found: 0,
                error: "Fehlerhafter Link-Header.",
            });
        } finally {
            mocks.translations.clear();
        }
    });
});
