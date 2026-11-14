// "Usually" durations and the overdue rule (PLAN.md Phase 10, K15, K23). The fake GitHub and
// GitLab servers apply the same list filters the real APIs do, so a request that drops or
// swaps a filter gets a different baseline back.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import {
    HttpError,
    type FetchJson,
    type FetchJsonWithMeta,
    type FetchResponse,
} from "../../../../src/services/commitChecks/http";
import type { GitOps } from "../../../../src/git/operations";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";
import type { CiJob, CiRun, CommitCiDetailData } from "../../../../src/types";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("vscode", () => ({
    authentication: { getSession: mocks.getSession },
    l10n: { t: interpolateL10n },
}));

import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import { CommitCiDetailService } from "../../../../src/services/commitChecks/detailService";
import {
    UsualDurationCache,
    type UsualDuration,
} from "../../../../src/services/commitChecks/ciTiming";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import { logicalCheckId } from "../../../../src/shared/ci/identity";
import { isOverdue } from "../../../../src/shared/ci/timing";

type Json = Record<string, unknown>;

const SELECTED_CREATED = "2026-11-14T12:00:00Z";

function selectedRun(overrides: Partial<CiRun> = {}): CiRun {
    return {
        id: "300",
        name: "CI",
        state: "running",
        workflowId: "11",
        ref: "main",
        createdAt: SELECTED_CREATED,
        startedAt: SELECTED_CREATED,
        jobs: [],
        jobsCoverage: "full",
        ...overrides,
    };
}

function jobKey(scope: string, name: string): string {
    return logicalCheckId({ kind: "job", scope, name });
}

describe("overdue rule (K15)", () => {
    it("overdue past 1.5×", () => {
        expect(isOverdue(61_000, 60_000)).toBe(false);
        expect(isOverdue(90_000, 60_000)).toBe(false);
        expect(isOverdue(90_001, 60_000)).toBe(true);
        expect(isOverdue(10 * 60_000, null)).toBe(false);
        expect(isOverdue(10 * 60_000, undefined)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const ghRef = { host: "github.com", owner: "o", repo: "r" } as ProviderRepoRef;

function ghRun(
    id: number,
    workflowId: number,
    createdAt: string,
    conclusion: string | null,
    startedAt = createdAt,
    updatedAt = createdAt,
): Json {
    return {
        id,
        name: "CI",
        workflow_id: workflowId,
        head_branch: "main",
        status: conclusion === null ? "in_progress" : "completed",
        conclusion,
        created_at: createdAt,
        run_started_at: startedAt,
        updated_at: updatedAt,
    };
}

function ghJob(id: number, name: string, startedAt: string, completedAt: string): Json {
    return {
        id,
        name,
        workflow_name: "CI",
        status: "completed",
        conclusion: "success",
        started_at: startedAt,
        completed_at: completedAt,
    };
}

/** In-memory GitHub Actions API: lists runs per workflow or per repository with GitHub's filters. */
function fakeGitHub(runs: Json[], jobsByRun: Map<string, Json[]>) {
    const log: string[] = [];
    const respond = (url: string): FetchResponse => {
        log.push(url);
        const parsed = new URL(url);
        const path = parsed.pathname;
        const params = parsed.searchParams;
        const listed = /^\/repos\/o\/r\/actions\/(?:workflows\/(\d+)\/)?runs$/.exec(path);
        if (listed) {
            const created = params.get("created") ?? "";
            const before = created.startsWith("<") ? Date.parse(created.slice(1)) : undefined;
            const matching = runs
                .filter((run) => listed[1] === undefined || String(run.workflow_id) === listed[1])
                .filter((run) => !params.has("branch") || run.head_branch === params.get("branch"))
                .filter((run) => !params.has("status") || run.conclusion === params.get("status"))
                .filter(
                    (run) => before === undefined || Date.parse(String(run.created_at)) < before,
                )
                .sort(
                    (a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)),
                );
            const perPage = Number(params.get("per_page") ?? "30");
            return {
                statusCode: 200,
                headers: {},
                body: { total_count: matching.length, workflow_runs: matching.slice(0, perPage) },
            };
        }
        const jobs = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(path);
        if (jobs) {
            const all = jobsByRun.get(jobs[1]) ?? [];
            return { statusCode: 200, headers: {}, body: { total_count: all.length, jobs: all } };
        }
        throw new HttpError(404, `HTTP 404: ${url}`, {});
    };
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async (url: string) => respond(url));
    const fetchJson: FetchJson = vi.fn(async (url: string) => respond(url).body);
    return { log, fetchJson, fetchWithMeta };
}

/**
 * Workflow 11 on main: run 100 (oldest), 200 (newest success before the selected run), the
 * selected 300 (running) and 400 (a newer success). Workflow 22 has a success between 200 and 300.
 */
function githubWorld() {
    const runs = [
        ghRun(
            100,
            11,
            "2026-11-14T10:00:00Z",
            "success",
            "2026-11-14T10:00:00Z",
            "2026-11-14T10:02:00Z",
        ),
        ghRun(
            200,
            11,
            "2026-11-14T11:30:00Z",
            "success",
            "2026-11-14T11:30:00Z",
            "2026-11-14T11:40:00Z",
        ),
        ghRun(
            250,
            22,
            "2026-11-14T11:50:00Z",
            "success",
            "2026-11-14T11:50:00Z",
            "2026-11-14T11:51:30Z",
        ),
        ghRun(300, 11, SELECTED_CREATED, null),
        ghRun(
            400,
            11,
            "2026-11-14T12:30:00Z",
            "success",
            "2026-11-14T12:30:00Z",
            "2026-11-14T12:31:00Z",
        ),
    ];
    const jobs = new Map([
        [
            "200",
            [
                ghJob(1, "build", "2026-11-14T11:30:05Z", "2026-11-14T11:35:05Z"),
                ghJob(2, "test", "2026-11-14T11:35:05Z", "2026-11-14T11:36:05Z"),
                ghJob(3, "test", "2026-11-14T11:35:05Z", "2026-11-14T11:37:05Z"),
            ],
        ],
    ]);
    return fakeGitHub(runs, jobs);
}

describe("GitHub usual duration (K23)", () => {
    beforeEach(() => {
        mocks.getSession.mockResolvedValue({ accessToken: "gh-token", account: { id: "7" } });
    });

    it("baseline excludes the selected and newer runs", async () => {
        const gh = githubWorld();
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);

        const usual = await provider.getUsualDuration(ghRef, selectedRun());

        expect(usual).toEqual({
            baselineRunId: "200",
            runMs: 10 * 60_000,
            // "test" ran twice in the baseline, so it has no unique match.
            jobMs: { [jobKey("CI", "build")]: 5 * 60_000 },
        });
        const query = new URL(gh.log[0]!).searchParams;
        expect(query.get("created")).toBe(`<${SELECTED_CREATED}`);
        expect(query.get("status")).toBe("success");
        expect(query.get("branch")).toBe("main");
    });

    it("baseline uses the same workflow", async () => {
        const gh = githubWorld();
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);

        const usual = await provider.getUsualDuration(ghRef, selectedRun());

        // Workflow 22's run 250 is newer than run 200 but belongs to another workflow.
        expect(usual?.baselineRunId).toBe("200");
        expect(new URL(gh.log[0]!).pathname).toBe("/repos/o/r/actions/workflows/11/runs");
    });

    it("no previous run → null", async () => {
        const gh = fakeGitHub([ghRun(300, 11, SELECTED_CREATED, null)], new Map());
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);

        expect(await provider.getUsualDuration(ghRef, selectedRun())).toBeNull();
        // Without a workflow, branch or creation time there is nothing to compare with.
        const asked = gh.log.length;
        expect(
            await provider.getUsualDuration(ghRef, selectedRun({ workflowId: undefined })),
        ).toBeNull();
        expect(await provider.getUsualDuration(ghRef, selectedRun({ ref: undefined }))).toBeNull();
        expect(
            await provider.getUsualDuration(ghRef, selectedRun({ createdAt: undefined })),
        ).toBeNull();
        expect(gh.log.length).toBe(asked);
    });

    it("skips a listed run that is the selected run itself", async () => {
        const gh = fakeGitHub(
            [
                ghRun(
                    300,
                    11,
                    "2026-11-14T11:00:00Z",
                    "success",
                    "2026-11-14T11:00:00Z",
                    "2026-11-14T11:01:00Z",
                ),
            ],
            new Map(),
        );
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);

        expect(await provider.getUsualDuration(ghRef, selectedRun())).toBeNull();
    });

    it("a baseline job that did not succeed has no usual time", async () => {
        const gh = fakeGitHub(
            [
                ghRun(
                    200,
                    11,
                    "2026-11-14T11:30:00Z",
                    "success",
                    "2026-11-14T11:30:00Z",
                    "2026-11-14T11:40:00Z",
                ),
            ],
            new Map([
                [
                    "200",
                    [
                        ghJob(1, "build", "2026-11-14T11:30:05Z", "2026-11-14T11:35:05Z"),
                        // GitHub stamps a skipped job with the same start and end time.
                        {
                            ...ghJob(2, "deploy", "2026-11-14T11:36:05Z", "2026-11-14T11:36:05Z"),
                            conclusion: "skipped",
                        },
                        {
                            ...ghJob(3, "lint", "2026-11-14T11:30:05Z", "2026-11-14T11:31:05Z"),
                            conclusion: "failure",
                        },
                    ],
                ],
            ]),
        );
        const provider = new GitHubProvider(gh.fetchJson, undefined, gh.fetchWithMeta);

        const usual = await provider.getUsualDuration(ghRef, selectedRun());

        expect(usual?.jobMs, "only the job that succeeded has a usual time").toEqual({
            [jobKey("CI", "build")]: 5 * 60_000,
        });
    });

    it("a cut job list gives no job a usual time", async () => {
        const gh = githubWorld();
        // The jobs page links to a next page the provider refuses, so the list is cut.
        const cut: FetchJsonWithMeta = vi.fn(async (url: string) => {
            const response = await gh.fetchWithMeta(url);
            return url.includes("/jobs")
                ? { ...response, headers: { link: '<https://evil.example/next>; rel="next"' } }
                : response;
        });
        const provider = new GitHubProvider(gh.fetchJson, undefined, cut);

        const usual = await provider.getUsualDuration(ghRef, selectedRun());

        expect(usual?.runMs).toBe(10 * 60_000);
        expect(usual?.jobMs, "a cut list cannot show a job is unique").toEqual({});
    });

    it("reads a baseline's second jobs page from GitHub's repository-id link", async () => {
        const run200 = {
            ...ghRun(
                200,
                11,
                "2026-11-14T11:30:00Z",
                "success",
                "2026-11-14T11:30:00Z",
                "2026-11-14T11:40:00Z",
            ),
            repository: { id: 42 },
        };
        const gh = fakeGitHub(
            [run200],
            new Map([["200", [ghJob(1, "build", "2026-11-14T11:30:05Z", "2026-11-14T11:35:05Z")]]]),
        );
        // GitHub's Link header names the next page by repository id, not owner and name.
        const page2 =
            "https://api.github.com/repositories/42/actions/runs/200/jobs?filter=latest&per_page=100&page=2";
        const paged: FetchJsonWithMeta = vi.fn(async (url: string) => {
            if (url === page2) {
                const jobs = [ghJob(2, "lint", "2026-11-14T11:30:05Z", "2026-11-14T11:31:05Z")];
                return { statusCode: 200, headers: {}, body: { total_count: 2, jobs } };
            }
            const response = await gh.fetchWithMeta(url);
            return url.includes("/jobs")
                ? { ...response, headers: { link: `<${page2}>; rel="next"` } }
                : response;
        });
        const provider = new GitHubProvider(gh.fetchJson, undefined, paged);

        const usual = await provider.getUsualDuration(ghRef, selectedRun());

        expect(usual?.jobMs, "both jobs pages are read").toEqual({
            [jobKey("CI", "build")]: 5 * 60_000,
            [jobKey("CI", "lint")]: 60_000,
        });
    });

    it("rejects on a failed request so nothing is cached for it", async () => {
        const gh = githubWorld();
        const failing: FetchJsonWithMeta = vi.fn(async (url: string) => {
            throw new HttpError(502, `HTTP 502: ${url}`, {});
        });
        const provider = new GitHubProvider(gh.fetchJson, undefined, failing);

        await expect(provider.getUsualDuration(ghRef, selectedRun())).rejects.toThrow("502");
    });
});

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

const GL_PROJECT = "/api/v4/projects/o%2Fr";
const glRef = { host: "gitlab.com", owner: "o", repo: "r" } as ProviderRepoRef;
/** The fields GitLab's pipeline list carries: no name, no duration. */
const GL_LIST_FIELDS = [
    "id",
    "iid",
    "project_id",
    "sha",
    "ref",
    "status",
    "source",
    "created_at",
    "updated_at",
    "web_url",
];

function glPipeline(
    id: number,
    ref: string,
    status: string,
    createdAt: string,
    updatedAt: string,
    duration: number | null,
): Json {
    return {
        id,
        iid: id,
        ref,
        status,
        name: "",
        created_at: createdAt,
        updated_at: updatedAt,
        duration,
    };
}

/** In-memory GitLab REST API v4 pipeline list (with its filters), single pipeline and jobs. */
function fakeGitLab(pipelines: Json[], jobsByPipeline: Map<string, Json[]>) {
    const log: string[] = [];
    const respond = (url: string): FetchResponse => {
        log.push(url);
        const parsed = new URL(url);
        const params = parsed.searchParams;
        const path = parsed.pathname;
        if (path === `${GL_PROJECT}/pipelines`) {
            const createdBefore = params.get("created_before");
            const updatedBefore = params.get("updated_before");
            const matching = pipelines
                .filter((p) => !params.has("ref") || p.ref === params.get("ref"))
                .filter((p) => !params.has("status") || p.status === params.get("status"))
                .filter(
                    (p) =>
                        createdBefore === null ||
                        Date.parse(String(p.created_at)) < Date.parse(createdBefore),
                )
                .filter(
                    (p) =>
                        updatedBefore === null ||
                        Date.parse(String(p.updated_at)) < Date.parse(updatedBefore),
                )
                .sort((a, b) =>
                    params.get("sort") === "asc"
                        ? Number(a.id) - Number(b.id)
                        : Number(b.id) - Number(a.id),
                );
            const perPage = Number(params.get("per_page") ?? "20");
            return {
                statusCode: 200,
                headers: { "x-next-page": "" },
                body: matching
                    .slice(0, perPage)
                    .map((p) =>
                        Object.fromEntries(
                            Object.entries(p).filter(([k]) => GL_LIST_FIELDS.includes(k)),
                        ),
                    ),
            };
        }
        const one = new RegExp(`^${GL_PROJECT}/pipelines/(\\d+)$`).exec(path);
        const found = one && pipelines.find((p) => String(p.id) === one[1]);
        if (found) return { statusCode: 200, headers: {}, body: found };
        const jobs = new RegExp(`^${GL_PROJECT}/pipelines/(\\d+)/jobs$`).exec(path);
        if (jobs) {
            return {
                statusCode: 200,
                headers: { "x-next-page": "" },
                body: jobsByPipeline.get(jobs[1]) ?? [],
            };
        }
        throw new HttpError(404, `HTTP 404: ${url}`, {});
    };
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async (url: string) => respond(url));
    const fetchJson: FetchJson = vi.fn(async (url: string) => respond(url).body);
    return { log, fetchJson, fetchWithMeta };
}

function glProvider(gl: ReturnType<typeof fakeGitLab>): GitLabProvider {
    const store = { get: vi.fn(async () => "gl-token") } as unknown as CredentialStore;
    return new GitLabProvider(gl.fetchJson, store, undefined, gl.fetchWithMeta);
}

describe("GitLab usual duration (K23)", () => {
    it("earlier-created pipeline updated after the selected run began is the baseline", async () => {
        const gl = fakeGitLab(
            [
                glPipeline(
                    10,
                    "main",
                    "success",
                    "2026-11-14T10:00:00Z",
                    "2026-11-14T10:20:00Z",
                    1200,
                ),
                // Created before the selected pipeline, still running when it began.
                glPipeline(
                    20,
                    "main",
                    "success",
                    "2026-11-14T11:30:00Z",
                    "2026-11-14T12:10:00Z",
                    2400,
                ),
                glPipeline(
                    25,
                    "other",
                    "success",
                    "2026-11-14T11:45:00Z",
                    "2026-11-14T11:50:00Z",
                    300,
                ),
                glPipeline(30, "main", "running", SELECTED_CREATED, SELECTED_CREATED, null),
                glPipeline(
                    40,
                    "main",
                    "success",
                    "2026-11-14T12:30:00Z",
                    "2026-11-14T12:35:00Z",
                    300,
                ),
            ],
            new Map([
                [
                    "20",
                    [
                        { id: 1, name: "build", status: "success", duration: 600.5 },
                        { id: 2, name: "test", status: "success", duration: 60 },
                        { id: 3, name: "test", status: "success", duration: 61 },
                    ],
                ],
            ]),
        );

        const usual = await glProvider(gl).getUsualDuration(
            glRef,
            selectedRun({ id: "30", workflowId: undefined }),
        );

        expect(usual).toEqual({
            baselineRunId: "20",
            runMs: 2_400_000,
            jobMs: { [jobKey("", "build")]: 600_500 },
        });
        const query = new URL(gl.log[0]!).searchParams;
        expect(query.get("created_before")).toBe(SELECTED_CREATED);
        expect(query.has("updated_before")).toBe(false);
        expect(query.get("order_by")).toBe("id");
        expect(query.get("sort")).toBe("desc");
        expect(query.get("ref")).toBe("main");
    });

    it("no previous pipeline → null", async () => {
        const gl = fakeGitLab(
            [glPipeline(30, "main", "running", SELECTED_CREATED, SELECTED_CREATED, null)],
            new Map(),
        );
        expect(await glProvider(gl).getUsualDuration(glRef, selectedRun({ id: "30" }))).toBeNull();
    });

    it("a baseline without a duration has an unknown run time", async () => {
        const gl = fakeGitLab(
            [
                glPipeline(
                    20,
                    "main",
                    "success",
                    "2026-11-14T11:30:00Z",
                    "2026-11-14T11:40:00Z",
                    null,
                ),
            ],
            new Map([["20", [{ id: 1, name: "build", status: "success", duration: null }]]]),
        );
        expect(await glProvider(gl).getUsualDuration(glRef, selectedRun({ id: "30" }))).toEqual({
            baselineRunId: "20",
            runMs: null,
            jobMs: {},
        });
    });

    it("skips a listed pipeline that is the selected pipeline itself", async () => {
        const gl = fakeGitLab(
            [glPipeline(30, "main", "success", "2026-11-14T11:00:00Z", "2026-11-14T11:01:00Z", 60)],
            new Map(),
        );
        expect(await glProvider(gl).getUsualDuration(glRef, selectedRun({ id: "30" }))).toBeNull();
    });

    it("a baseline job that did not succeed has no usual time", async () => {
        const gl = fakeGitLab(
            [
                glPipeline(
                    20,
                    "main",
                    "success",
                    "2026-11-14T11:30:00Z",
                    "2026-11-14T11:40:00Z",
                    600,
                ),
            ],
            new Map([
                [
                    "20",
                    [
                        { id: 1, name: "build", status: "success", duration: 300 },
                        { id: 2, name: "deploy", status: "skipped", duration: 0 },
                        { id: 3, name: "lint", status: "failed", duration: 30 },
                    ],
                ],
            ]),
        );

        const usual = await glProvider(gl).getUsualDuration(glRef, selectedRun({ id: "30" }));

        expect(usual?.jobMs, "only the job that succeeded has a usual time").toEqual({
            [jobKey("", "build")]: 300_000,
        });
    });

    it("a cut job list gives no job a usual time", async () => {
        const gl = fakeGitLab(
            [
                glPipeline(
                    20,
                    "main",
                    "success",
                    "2026-11-14T11:30:00Z",
                    "2026-11-14T11:40:00Z",
                    600,
                ),
            ],
            new Map([["20", [{ id: 1, name: "build", status: "success", duration: 300 }]]]),
        );
        // Every jobs page names a next page, so reading stops at the page bound; only the
        // first page holds the job.
        const paged: FetchJsonWithMeta = vi.fn(async (url: string) => {
            const response = await gl.fetchWithMeta(url);
            if (!url.includes("/jobs")) return response;
            const page = Number(new URL(url).searchParams.get("page") ?? "1");
            return {
                statusCode: 200,
                headers: { "x-next-page": String(page + 1) },
                body: page === 1 ? response.body : [],
            };
        });
        const store = { get: vi.fn(async () => "gl-token") } as unknown as CredentialStore;
        const provider = new GitLabProvider(gl.fetchJson, store, undefined, paged);

        const usual = await provider.getUsualDuration(glRef, selectedRun({ id: "30" }));

        expect(usual?.runMs).toBe(600_000);
        expect(usual?.jobMs, "a cut list cannot show a job is unique").toEqual({});
    });
});

// ---------------------------------------------------------------------------
// Cache and coordinator
// ---------------------------------------------------------------------------

function job(name: string, state: CiJob["state"] = "running"): CiJob {
    return { id: name, logicalId: jobKey("CI", name), name, checkName: name, state, steps: [] };
}

function detailWith(runs: CiRun[]): CommitCiDetailData {
    return {
        hash: "abc1234",
        provider: "github",
        complete: false,
        outcome: "pending",
        runs,
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

function coordinatorFor(
    runs: CiRun[],
    getUsualDuration: (ref: ProviderRepoRef, run: CiRun) => Promise<UsualDuration | null>,
    usualDurations = new UsualDurationCache(),
    accountKey?: () => Promise<string>,
) {
    const provider: CommitChecksProvider = {
        id: "github",
        accountKey,
        capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true, usualDuration: true },
        match: () => ({ host: "github.com" }),
        keyFor: () => "github:github.com:o/r",
        getChecks: vi.fn(),
        getDetail: vi.fn(async () => detailWith(runs)),
        getUsualDuration: vi.fn(getUsualDuration),
    };
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/o/r.git"),
    } as unknown as GitOps;
    const coordinator = new CommitChecksCoordinator(
        gitOps,
        [provider],
        {},
        {
            detailService: new CommitCiDetailService({ usualDurations }),
        },
    );
    const read = () =>
        coordinator.getDetail(
            "abc1234",
            { force: true },
            { repoKey: "/repo", authGeneration: 0, lifecycleGeneration: 0 },
        );
    return { provider, coordinator, read };
}

describe("usual duration cache and serving", () => {
    it("cache keyed by selected run", async () => {
        // Two running runs on the same branch: each has its own baseline.
        const runs = [selectedRun({ id: "300" }), selectedRun({ id: "301" })];
        const { provider, read } = coordinatorFor(runs, async (_ref, run) => ({
            baselineRunId: `before-${run.id}`,
            runMs: run.id === "300" ? 60_000 : 120_000,
            jobMs: {},
        }));

        const first = await read();
        const second = await read();

        expect(first?.runs.map((run) => run.usualDurationMs)).toEqual([60_000, 120_000]);
        expect(second?.runs.map((run) => run.usualDurationMs)).toEqual([60_000, 120_000]);
        expect(provider.getUsualDuration).toHaveBeenCalledTimes(2);
    });

    it("job usual is a unique logical-id match; finished runs are never asked", async () => {
        const running = selectedRun({
            jobs: [job("build"), job("test"), job("test"), job("lint")],
        });
        const finished = selectedRun({
            id: "299",
            state: "success",
            jobs: [job("build", "success")],
        });
        const { provider, read } = coordinatorFor([running, finished], async () => ({
            baselineRunId: "200",
            runMs: 600_000,
            jobMs: { [jobKey("CI", "build")]: 300_000, [jobKey("CI", "test")]: 60_000 },
        }));

        const detail = await read();

        expect(detail?.runs[0]?.jobs.map((j) => j.usualDurationMs)).toEqual([
            300_000,
            null,
            null,
            null,
        ]);
        expect(detail?.runs[1]?.usualDurationMs).toBeUndefined();
        expect(detail?.runs[1]?.jobs[0]?.usualDurationMs).toBeUndefined();
        expect(provider.getUsualDuration).toHaveBeenCalledTimes(1);
    });

    it("a run whose own job list is cut gives its jobs no usual time", async () => {
        // "build" is the only job on the read page; a second "build" may sit past the bound.
        const cut = selectedRun({
            jobs: [job("build")],
            jobsCoverage: { reason: "pageBound", shown: 1 },
        });
        const { read } = coordinatorFor([cut], async () => ({
            baselineRunId: "200",
            runMs: 600_000,
            jobMs: { [jobKey("CI", "build")]: 300_000 },
        }));

        const detail = await read();

        expect(detail?.runs[0]?.usualDurationMs).toBe(600_000);
        expect(
            detail?.runs[0]?.jobs[0]?.usualDurationMs,
            "a cut list cannot show the job is unique",
        ).toBeNull();
    });

    it("a queued run is asked for its usual time", async () => {
        const { provider, read } = coordinatorFor(
            [selectedRun({ state: "queued", startedAt: undefined })],
            async () => ({ baselineRunId: "200", runMs: 60_000, jobMs: {} }),
        );

        const detail = await read();

        expect(detail?.runs[0]?.usualDurationMs, "a queued run shows its usual time").toBe(60_000);
        expect(provider.getUsualDuration).toHaveBeenCalledTimes(1);
    });

    it("no baseline shows unknown and a failed lookup leaves the hint out, both asked again", async () => {
        let answer: () => Promise<UsualDuration | null> = async () => null;
        const { provider, read } = coordinatorFor([selectedRun({ jobs: [job("build")] })], () =>
            answer(),
        );

        const none = await read();
        expect(none?.runs[0]?.usualDurationMs).toBeNull();
        expect(none?.runs[0]?.jobs[0]?.usualDurationMs).toBeNull();

        answer = async () => {
            throw new Error("HTTP 502");
        };
        const failed = await read();
        expect(failed?.runs[0]?.usualDurationMs).toBeUndefined();
        expect(failed?.runs[0]?.jobs[0]?.usualDurationMs).toBeUndefined();
        expect(provider.getUsualDuration).toHaveBeenCalledTimes(2);
    });

    it("a baseline read while the account changed is never kept under the old account", async () => {
        let account = "account-a";
        let calls = 0;
        const { provider, read } = coordinatorFor(
            [selectedRun()],
            async () => {
                calls += 1;
                // The first lookup runs while the user switches accounts.
                if (calls === 1) account = "account-b";
                return { baselineRunId: "200", runMs: calls * 1_000, jobMs: {} };
            },
            new UsualDurationCache(),
            async () => account,
        );

        const switched = await read();
        expect(switched?.runs[0]?.usualDurationMs).toBe(2_000);

        // Back on the first account: its lookup was dropped, so it is asked again.
        account = "account-a";
        const back = await read();
        expect(back?.runs[0]?.usualDurationMs).toBe(3_000);
        expect(provider.getUsualDuration).toHaveBeenCalledTimes(3);
    });

    it("an account switch and switch back during a lookup still retries the rejected lookup", async () => {
        // The account reads as "account-b" exactly once, right after the first lookup, and is
        // "account-a" again before the read's final confirm: A -> B -> A.
        let readOtherAccountOnce = false;
        let calls = 0;
        const { provider, read } = coordinatorFor(
            [selectedRun()],
            async () => {
                calls += 1;
                if (calls === 1) readOtherAccountOnce = true;
                return { baselineRunId: "200", runMs: calls * 1_000, jobMs: {} };
            },
            new UsualDurationCache(),
            async () => {
                if (!readOtherAccountOnce) return "account-a";
                readOtherAccountOnce = false;
                return "account-b";
            },
        );

        const detail = await read();

        expect(
            detail?.runs[0]?.usualDurationMs,
            "the lookup rejected by the switch is asked again under account-a",
        ).toBe(2_000);
        expect(provider.getUsualDuration).toHaveBeenCalledTimes(2);
    });

    it("a found baseline is kept across sessions for 24 hours", async () => {
        const saved = new Map<string, unknown>();
        const store = {
            get: (key: string) => saved.get(key),
            update: async (key: string, value: unknown) => {
                saved.set(key, value);
            },
        };
        let now = Date.parse("2026-11-14T12:00:00Z");
        const clock = () => now;
        const baseline: UsualDuration = {
            baselineRunId: "200",
            runMs: 600_000,
            jobMs: { a: 1_000 },
        };
        const fetch = vi.fn(async () => baseline);

        expect(
            await new UsualDurationCache({ store, now: clock }).get("usual:k:300", fetch),
        ).toEqual(baseline);
        await vi.waitFor(() => expect(saved.size).toBe(1));

        // A new window reads the saved baseline without asking the provider.
        expect(
            await new UsualDurationCache({ store, now: clock }).get("usual:k:300", fetch),
        ).toEqual(baseline);
        expect(fetch).toHaveBeenCalledTimes(1);

        now += 24 * 60 * 60 * 1000;
        await new UsualDurationCache({ store, now: clock }).get("usual:k:300", fetch);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("clearing the detail cache (sign-in or settings change) clears the baselines", async () => {
        const usualDurations = new UsualDurationCache();
        const details = new CommitCiDetailService({ usualDurations });
        const fetch = vi.fn(async () => ({ baselineRunId: "200", runMs: 1, jobMs: {} }));
        await usualDurations.get("usual:k:300", fetch);
        await usualDurations.get("usual:k:300", fetch);
        expect(fetch).toHaveBeenCalledTimes(1);

        details.clear();
        await usualDurations.get("usual:k:300", fetch);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("clear drops kept baselines and a fetch that started before it", async () => {
        const saved = new Map<string, unknown>();
        const store = {
            get: (key: string) => saved.get(key),
            update: async (key: string, value: unknown) => {
                saved.set(key, value);
            },
        };
        const cache = new UsualDurationCache({ store });
        const kept: UsualDuration = { baselineRunId: "199", runMs: 1, jobMs: {} };
        await cache.get("usual:k:299", async () => kept);
        await vi.waitFor(() => expect(saved.size).toBe(1));
        let resolve!: (value: UsualDuration) => void;
        const pending = cache.get("usual:k:300", () => new Promise((r) => (resolve = r)));
        cache.clear();
        resolve({ baselineRunId: "200", runMs: 1, jobMs: {} });
        await pending;
        // Lets every queued write land.
        await new Promise((done) => setTimeout(done, 0));

        // Neither this window nor the next one (a restart) gets either baseline back.
        const fetch = vi.fn(async () => null);
        await cache.get("usual:k:299", fetch);
        const restarted = new UsualDurationCache({ store });
        await restarted.get("usual:k:299", fetch);
        await restarted.get("usual:k:300", fetch);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    function sharedStore() {
        const saved = new Map<string, unknown>();
        return {
            get: (key: string) => saved.get(key),
            update: async (key: string, value: unknown) => {
                saved.set(key, value);
            },
        };
    }

    it("a clear in another window drops this window's kept baseline", async () => {
        const store = sharedStore();
        const windowA = new UsualDurationCache({ store });
        const windowB = new UsualDurationCache({ store });
        let runMs = 1_000;
        const fetch = vi.fn(async () => ({ baselineRunId: "200", runMs, jobMs: {} }));
        expect((await windowA.get("usual:k:300", fetch))?.runMs).toBe(1_000);

        // Another window signs in to a different account and clears its detail cache.
        new CommitCiDetailService({ usualDurations: windowB }).clear();
        runMs = 2_000;

        expect((await windowA.get("usual:k:300", fetch))?.runMs).toBe(2_000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("a clear in another window fences a fetch already under way, across a restart", async () => {
        const store = sharedStore();
        const windowA = new UsualDurationCache({ store });
        const windowB = new UsualDurationCache({ store });
        let resolve!: (value: UsualDuration) => void;
        const pending = windowA.get("usual:k:300", () => new Promise((r) => (resolve = r)));

        windowB.clear();
        resolve({ baselineRunId: "200", runMs: 1_000, jobMs: {} });
        await pending;
        // Lets every queued write land.
        await new Promise((done) => setTimeout(done, 0));

        const fetch = vi.fn(async () => null);
        await new UsualDurationCache({ store }).get("usual:k:300", fetch);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    // A store whose first write is held back, so it lands after a clear that started later.
    function storeWithSlowFirstWrite() {
        const store = sharedStore();
        const update = store.update;
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>((r) => (started = r));
        let first = true;
        store.update = async (key: string, value: unknown) => {
            if (first) {
                first = false;
                started();
                await new Promise<void>((r) => (release = r));
            }
            await update(key, value);
        };
        return { store, entered, release: () => release() };
    }

    it("a save already awaiting storage cannot bring back baselines a clear dropped, across a restart", async () => {
        const { store, entered, release } = storeWithSlowFirstWrite();
        const windowA = new UsualDurationCache({ store });
        const windowB = new UsualDurationCache({ store });
        await windowA.get("usual:k:300", async () => ({
            baselineRunId: "200",
            runMs: 1,
            jobMs: {},
        }));
        await entered;

        windowB.clear();
        release();
        await new Promise((done) => setTimeout(done, 0));

        const fetch = vi.fn(async () => null);
        await new UsualDurationCache({ store }).get("usual:k:300", fetch);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("a clear in the same window cannot be overtaken by its older save", async () => {
        const { store, entered, release } = storeWithSlowFirstWrite();
        const cache = new UsualDurationCache({ store });
        await cache.get("usual:k:300", async () => ({ baselineRunId: "200", runMs: 1, jobMs: {} }));
        await entered;

        cache.clear();
        release();
        await new Promise((done) => setTimeout(done, 0));

        const fetch = vi.fn(async () => null);
        await new UsualDurationCache({ store }).get("usual:k:300", fetch);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("a clear whose shared write failed never serves this window its own saved baseline", async () => {
        const store = sharedStore();
        const update = store.update;
        const cache = new UsualDurationCache({ store });
        await cache.get("usual:k:300", async () => ({
            baselineRunId: "200",
            runMs: 1_000,
            jobMs: {},
        }));
        await new Promise((done) => setTimeout(done, 0));

        store.update = async () => {
            throw new Error("disk full");
        };
        cache.clear();
        await new Promise((done) => setTimeout(done, 0));

        const fetch = vi.fn(async () => ({ baselineRunId: "201", runMs: 2_000, jobMs: {} }));
        expect((await cache.get("usual:k:300", fetch))?.runMs).toBe(2_000);
        store.update = update;
    });

    it("a failed clear is retried by the next save, so it still reaches a restart", async () => {
        const store = sharedStore();
        const update = store.update;
        const cache = new UsualDurationCache({ store });
        await cache.get("usual:k:300", async () => ({
            baselineRunId: "200",
            runMs: 1_000,
            jobMs: {},
        }));
        await new Promise((done) => setTimeout(done, 0));

        store.update = async () => {
            throw new Error("disk full");
        };
        cache.clear();
        await new Promise((done) => setTimeout(done, 0));
        store.update = update;

        await cache.get("usual:k:300", async () => ({
            baselineRunId: "201",
            runMs: 2_000,
            jobMs: {},
        }));
        await new Promise((done) => setTimeout(done, 0));

        // The restart gets the new baseline, not the one the clear dropped.
        const fetch = vi.fn(async () => null);
        expect((await new UsualDurationCache({ store }).get("usual:k:300", fetch))?.runMs).toBe(
            2_000,
        );
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "an older clear's late write cannot undo a newer clear across a restart (other window: %s)",
        async (otherWindow) => {
            const store = sharedStore();
            const update = store.update;
            let release!: () => void;
            let firstEpochWrite = true;
            store.update = async (key: string, value: unknown) => {
                if (key.endsWith("Epoch") && firstEpochWrite) {
                    firstEpochWrite = false;
                    await new Promise<void>((r) => (release = r));
                }
                await update(key, value);
            };
            const windowA = new UsualDurationCache({ store });
            const windowB = otherWindow ? new UsualDurationCache({ store }) : windowA;

            // Clear 1's write is held; a baseline is saved between the two clears.
            windowA.clear();
            await windowA.get("usual:k:300", async () => ({
                baselineRunId: "200",
                runMs: 1_000,
                jobMs: {},
            }));
            await new Promise((done) => setTimeout(done, 0));
            windowB.clear();
            await new Promise((done) => setTimeout(done, 0));
            // Clear 1's write lands last.
            release();
            await new Promise((done) => setTimeout(done, 0));

            const fetch = vi.fn(async () => ({ baselineRunId: "201", runMs: 2_000, jobMs: {} }));
            const restarted = await new UsualDurationCache({ store }).get("usual:k:300", fetch);
            expect(restarted?.runMs, "clear 2 dropped the baseline saved before it").toBe(2_000);
            // The window that saved it, still running, does not serve it from memory either.
            const again = await windowA.get("usual:k:300", fetch);
            expect(again?.runMs, "clear 2 also reaches the saving window's memory").toBe(2_000);
        },
    );

    it("a running job in a failed but incomplete run still gets its usual duration", async () => {
        const failedRun = selectedRun({
            state: "failure",
            jobs: [job("lint", "failure"), job("build", "running")],
        });
        const { provider, read } = coordinatorFor([failedRun], async () => ({
            baselineRunId: "200",
            runMs: 600_000,
            jobMs: { [jobKey("CI", "build")]: 30_000 },
        }));

        const detail = await read();

        expect(detail?.runs[0]?.jobs[1]?.usualDurationMs).toBe(30_000);
        expect(provider.getUsualDuration).toHaveBeenCalledTimes(1);
    });
});
