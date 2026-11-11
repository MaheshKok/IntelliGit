import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import pipelineFixture from "../../../fixtures/commitChecks/gitlab/pipeline.json";
import pipelinesFixture from "../../../fixtures/commitChecks/gitlab/pipelines.json";
import jobFixture from "../../../fixtures/commitChecks/gitlab/job.json";
import {
    HttpError,
    type FetchJson,
    type FetchJsonWithMeta,
    type FetchResponse,
} from "../../../../src/services/commitChecks/http";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type {
    CiFailedScanCursor,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";
import type { CiJob, CommitCiDetail } from "../../../../src/types";

vi.mock("vscode", () => ({
    l10n: { t: interpolateL10n },
}));

import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import { RequestGateCooldownError } from "../../../../src/services/commitChecks/requestGate";
import {
    CommitCiDetailService,
    type CiFailedScanHooks,
} from "../../../../src/services/commitChecks/detailService";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import { logicalCheckId } from "../../../../src/shared/ci/identity";

const SHA = pipelineFixture.sha;
const TOKEN = "gl-token";
const PIPELINE_ID = String(pipelineFixture.id);
const PROJECT = "https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner";
const ref = { host: "gitlab.com", owner: "gitlab-org", repo: "gitlab-runner" } as ProviderRepoRef;
const KEY = `gitlab:repo@${SHA}:-#detail`;
const SERVE = { repoKey: "repo", capabilities: NO_CI_CAPABILITIES };
const REFUSED = "The provider's next-page link was refused.";
const CHANGED = "Remote data changed. Reload and try again.";
const UNVERIFIED =
    "This pipeline has no update time, so a retry during the scan cannot be ruled out.";
/** The fields GitLab's project pipeline list carries, as recorded; no user, no duration. */
const LIST_FIELDS = Object.keys(pipelinesFixture[0]);

type Json = Record<string, unknown>;

/** A job from the recorded fixture, renumbered; `id` doubles as its commit-status id. */
function job(id: number, status = "success", overrides: Json = {}): Json {
    return {
        ...jobFixture,
        id,
        name: `job ${id}`,
        stage: "test",
        status,
        web_url: `https://gitlab.com/gitlab-org/gitlab-runner/-/jobs/${id}`,
        ...overrides,
    };
}

function jobs(count: number, status = "success", from = 1): Json[] {
    return Array.from({ length: count }, (_, i) => job(from + i, status));
}

function pipeline(overrides: Json = {}): Json {
    return { ...pipelineFixture, ...overrides };
}

interface FakeGitLab {
    /** Each pipeline as the single-pipeline request returns it. */
    pipelines: Json[];
    jobsByPipeline: Map<string, Json[]>;
    /** Commit statuses: GitLab lists every job as one too, under the job's id. */
    statuses: Json[];
    /** Throws for a URL the test wants to fail; consulted on every request. */
    fail?: (url: string) => Error | undefined;
    /** Overrides the `x-next-page` header of a list page. */
    nextPage?: (url: string, page: number) => string | undefined;
    onRequest?: (url: string) => void;
}

/** In-memory GitLab REST API v4: pipelines, one pipeline, its jobs and the commit statuses. */
function fakeGitLab(state: FakeGitLab) {
    const log: string[] = [];
    const headersSeen: Record<string, string>[] = [];
    const paged = (url: string, all: Json[], pick = (item: Json) => item): FetchResponse => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page") ?? "1");
        // GitLab's default page size, so a request that omits per_page gets fewer items.
        const perPage = Number(parsed.searchParams.get("per_page") ?? "20");
        const next =
            state.nextPage?.(url, page) ?? (page * perPage < all.length ? String(page + 1) : "");
        return {
            statusCode: 200,
            headers: {
                "x-page": String(page),
                "x-per-page": String(perPage),
                "x-next-page": next,
                "x-total": String(all.length),
            },
            body: all.slice((page - 1) * perPage, page * perPage).map(pick),
        };
    };
    const respond = (url: string, headers: Record<string, string>): FetchResponse => {
        log.push(url);
        headersSeen.push(headers);
        state.onRequest?.(url);
        const error = state.fail?.(url);
        if (error) throw error;
        const path = new URL(url).pathname;
        const project = "/api/v4/projects/gitlab-org%2Fgitlab-runner";
        if (path === `${project}/pipelines`) {
            return paged(url, state.pipelines, (p) =>
                Object.fromEntries(Object.entries(p).filter(([k]) => LIST_FIELDS.includes(k))),
            );
        }
        if (path === `${project}/repository/commits/${SHA}/statuses`) {
            return paged(url, state.statuses);
        }
        const one = new RegExp(`^${project}/pipelines/(\\d+)$`).exec(path);
        const found = one && state.pipelines.find((p) => String(p.id) === one[1]);
        if (found) return { statusCode: 200, headers: {}, body: found };
        const jobsMatch = new RegExp(`^${project}/pipelines/(\\d+)/jobs$`).exec(path);
        if (jobsMatch) {
            const scopes = new URL(url).searchParams.getAll("scope[]");
            const all = (state.jobsByPipeline.get(jobsMatch[1]) ?? []).filter(
                (j) => scopes.length === 0 || scopes.includes(String(j.status)),
            );
            return paged(url, all);
        }
        throw new HttpError(404, `HTTP 404: ${url}`, {});
    };
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async (url: string, headers) =>
        respond(url, headers),
    );
    const fetchJson: FetchJson = vi.fn(async (url: string, headers) => respond(url, headers).body);
    return { log, headersSeen, fetchJson, fetchWithMeta };
}

function state(partial: Partial<FakeGitLab> = {}): FakeGitLab {
    return {
        pipelines: [pipeline({ status: "success" })],
        jobsByPipeline: new Map([[PIPELINE_ID, [jobFixture]]]),
        statuses: [],
        ...partial,
    };
}

function tokenStore(token: string | null = TOKEN): CredentialStore {
    return { get: vi.fn(async () => token) } as unknown as CredentialStore;
}

function provider(
    gl: ReturnType<typeof fakeGitLab>,
    fetchWithMeta: FetchJsonWithMeta = gl.fetchWithMeta,
    cooldownEnd?: (url: string) => number,
): GitLabProvider {
    return new GitLabProvider(gl.fetchJson, tokenStore(), undefined, fetchWithMeta, cooldownEnd);
}

/** Pages requested of the failed-jobs collection, in order. */
function scanPages(log: readonly string[]): number[] {
    return log
        .filter((url) => new URL(url).searchParams.getAll("scope[]").includes("failed"))
        .map((url) => Number(new URL(url).searchParams.get("page") ?? "1"));
}

function jobPages(log: readonly string[]): number[] {
    return log
        .filter((url) => new URL(url).pathname.endsWith("/jobs"))
        .filter((url) => new URL(url).searchParams.getAll("scope[]").length === 0)
        .map((url) => Number(new URL(url).searchParams.get("page") ?? "1"));
}

function isScanPage(url: string, page: number): boolean {
    const parsed = new URL(url);
    return (
        parsed.searchParams.getAll("scope[]").includes("failed") &&
        parsed.searchParams.get("page") === String(page)
    );
}

const failedNames = (detail: CommitCiDetail): string[] =>
    detail.runs[0].jobs.filter((j: CiJob) => j.state === "failure").map((j) => j.name);

describe("GitLabProvider.getDetail", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("maps pipeline → jobs", async () => {
        // API order is not stage order: a retried build job has the highest id.
        const pipelineJobs = [
            job(13, "success", { stage: "test", name: "unit" }),
            job(14, "failed", { stage: "deploy", name: "pages", allow_failure: true }),
            job(11, "success", { stage: "build", name: "lint" }),
            job(15, "success", { stage: "build", name: "compile" }),
        ];
        const gl = fakeGitLab(
            state({
                pipelines: [pipeline()],
                jobsByPipeline: new Map([[PIPELINE_ID, pipelineJobs]]),
                statuses: pipelineJobs,
            }),
        );

        const detail = await provider(gl).getDetail(ref, SHA);

        expect(detail).toMatchObject({
            hash: SHA,
            provider: "gitlab",
            complete: true,
            outcome: "failure",
            runsCoverage: "full",
            otherChecks: [],
            otherChecksCoverage: "full",
        });
        expect(detail.scanCursors).toBeUndefined();
        const mapped = (id: number, name: string, extra: Json = {}) => ({
            id: String(id),
            logicalId: logicalCheckId({ kind: "job", scope: "Build pipeline", name }),
            name,
            checkName: name,
            state: "success",
            url: `https://gitlab.com/gitlab-org/gitlab-runner/-/jobs/${id}`,
            startedAt: jobFixture.started_at,
            completedAt: jobFixture.finished_at,
            steps: [],
            ...extra,
        });
        expect(detail.runs).toEqual([
            {
                id: PIPELINE_ID,
                name: "Build pipeline",
                url: pipelineFixture.web_url,
                state: "failure",
                event: "push",
                actor: "jdoe",
                ref: "main",
                runNumber: 312,
                createdAt: pipelineFixture.created_at,
                startedAt: pipelineFixture.started_at,
                completedAt: pipelineFixture.finished_at,
                jobsCoverage: "full",
                // Grouped by stage, stages in creation order, as GitLab's pipeline view shows.
                jobs: [
                    mapped(11, "lint"),
                    mapped(15, "compile"),
                    mapped(13, "unit"),
                    mapped(14, "pages", { state: "failure", optional: true }),
                ],
            },
        ]);
        expect(gl.headersSeen.every((h) => h["PRIVATE-TOKEN"] === TOKEN)).toBe(true);
    });

    it("maps every GitLab pipeline and job status to its CI state", async () => {
        const cases: [string, string][] = [
            ["created", "queued"],
            ["waiting_for_resource", "queued"],
            ["preparing", "queued"],
            ["pending", "queued"],
            ["scheduled", "queued"],
            ["waiting_for_callback", "queued"],
            ["running", "running"],
            ["canceling", "running"],
            ["success", "success"],
            ["failed", "failure"],
            ["canceled", "cancelled"],
            ["skipped", "skipped"],
            ["manual", "neutral"],
            ["bogus", "unknown"],
        ];
        const gl = fakeGitLab(
            state({
                jobsByPipeline: new Map([
                    [PIPELINE_ID, cases.map(([status], i) => job(i + 1, status))],
                ]),
            }),
        );
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail.runs[0].jobs.map((j) => j.state)).toEqual(cases.map(([, s]) => s));
        expect(detail.complete).toBe(false);
        expect(detail.outcome).toBe("failure");
    });

    it("a pipeline whose jobs all finished is complete; a running job keeps it incomplete", async () => {
        const done = await provider(fakeGitLab(state())).getDetail(ref, SHA);
        expect(done).toMatchObject({ complete: true, outcome: "success" });

        const running = await provider(
            fakeGitLab(
                state({
                    pipelines: [pipeline({ status: "running" })],
                    jobsByPipeline: new Map([[PIPELINE_ID, [job(1, "failed"), job(2, "running")]]]),
                }),
            ),
        ).getDetail(ref, SHA);
        expect(running).toMatchObject({ complete: false, outcome: "failure" });
    });

    it("header comes from the single-pipeline request", async () => {
        const gl = fakeGitLab(state({ pipelines: [pipeline()] }));
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail.runs[0]).toMatchObject({
            actor: "jdoe",
            startedAt: pipelineFixture.started_at,
            completedAt: pipelineFixture.finished_at,
        });
        expect(gl.log).toContain(`${PROJECT}/pipelines/${PIPELINE_ID}`);
    });

    it("a pipeline with no name keeps an empty logical scope and shows its id", async () => {
        const gl = fakeGitLab(
            state({
                pipelines: [pipeline({ name: null })],
                jobsByPipeline: new Map([[PIPELINE_ID, [job(1, "success", { name: "unit" })]]]),
            }),
        );
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail.runs[0].name).toBe(PIPELINE_ID);
        expect(detail.runs[0].jobs[0].logicalId).toBe(
            logicalCheckId({ kind: "job", scope: "", name: "unit" }),
        );
    });

    it("pages jobs by x-next-page", async () => {
        const gl = fakeGitLab(state({ jobsByPipeline: new Map([[PIPELINE_ID, jobs(150)]]) }));
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail.runs[0].jobs).toHaveLength(150);
        expect(detail.runs[0].jobsCoverage).toBe("full");
        expect(jobPages(gl.log)).toEqual([1, 2]);
    });

    it("requests carry per_page=100", async () => {
        const gl = fakeGitLab(
            state({
                pipelines: Array.from({ length: 30 }, (_, i) =>
                    pipeline({ id: i + 1, status: "success" }),
                ),
                jobsByPipeline: new Map(
                    Array.from({ length: 30 }, (_, i) => [
                        String(i + 1),
                        jobs(1, "success", i + 1),
                    ]),
                ),
                statuses: jobs(30),
            }),
        );
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail.runs).toHaveLength(30);
        const lists = gl.log.filter((url) => !/\/pipelines\/\d+$/.test(new URL(url).pathname));
        expect(lists.length).toBeGreaterThan(30);
        for (const url of lists) {
            expect(new URL(url).searchParams.get("per_page"), url).toBe("100");
        }
        expect(gl.log[0]).toBe(`${PROJECT}/pipelines?sha=${SHA}&per_page=100`);
    });

    it("second page fails → unavailable", async () => {
        const gl = fakeGitLab(
            state({
                jobsByPipeline: new Map([[PIPELINE_ID, jobs(250)]]),
                fail: (url) =>
                    url.includes("/jobs?") && new URL(url).searchParams.get("page") === "2"
                        ? new HttpError(500, "HTTP 500: boom", {})
                        : undefined,
            }),
        );
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail).toMatchObject({ outcome: "unavailable", runs: [], complete: false });
        expect(detail.error).toBe("HTTP 500: boom");
    });

    it("final page fails → unavailable", async () => {
        const gl = fakeGitLab(
            state({
                jobsByPipeline: new Map([[PIPELINE_ID, jobs(250)]]),
                fail: (url) =>
                    url.includes("/jobs?") && new URL(url).searchParams.get("page") === "3"
                        ? new HttpError(502, "HTTP 502: bad gateway", {})
                        : undefined,
            }),
        );
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail).toMatchObject({ outcome: "unavailable", runs: [], complete: false });
    });

    it("a malformed or backward x-next-page makes the detail unavailable, never a short full list", async () => {
        for (const next of ["abc", "1", "-2"]) {
            const gl = fakeGitLab(
                state({
                    jobsByPipeline: new Map([[PIPELINE_ID, jobs(150)]]),
                    nextPage: (url, page) =>
                        url.includes("/jobs?") && page === 1 ? next : undefined,
                }),
            );
            const detail = await provider(gl).getDetail(ref, SHA);
            expect(detail.outcome, next).toBe("unavailable");
            expect(detail.error, next).toBe("Malformed x-next-page header.");
        }
    });

    it("1 001+ items: 1 000 kept, coverage pageBound shown 1000", async () => {
        const gl = fakeGitLab(state({ jobsByPipeline: new Map([[PIPELINE_ID, jobs(1005)]]) }));
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail.runs[0].jobs).toHaveLength(1000);
        expect(detail.runs[0].jobsCoverage).toEqual({ reason: "pageBound", shown: 1000 });
        expect(jobPages(gl.log)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        // A pipeline that did not fail has no overflow scan.
        expect(detail.scanCursors).toBeUndefined();
    });

    it.each([
        ["green", "success", "2026-11-11T10:00:00.000Z"],
        // Failed again: only the rewritten record tells the attempts apart.
        ["failed again", "failed", "2026-11-11T10:00:00.000Z"],
        // No update time on either read: only the status can.
        ["green, no update time", "success", null],
    ])(
        "a pipeline retried (%s) while its jobs are paged is never a settled tree",
        async (_case, status, updatedAt) => {
            const retried = pipeline({
                status: "failed",
                ...(updatedAt === null && { updated_at: null }),
            });
            const st = state({
                pipelines: [retried],
                jobsByPipeline: new Map([[PIPELINE_ID, jobs(150, "failed")]]),
            });
            // The retry finishes while job page 2 is in flight: new job ids and a rewritten
            // pipeline record.
            st.onRequest = (url) => {
                if (jobPages([url])[0] !== 2) return;
                retried.status = status;
                retried.updated_at = updatedAt;
                st.jobsByPipeline.set(PIPELINE_ID, jobs(150, status, 2001));
            };
            const gl = fakeGitLab(st);

            const detail = await provider(gl).getDetail(ref, SHA);

            expect(jobPages(gl.log)).toEqual([1, 2]);
            const ids = detail.runs[0].jobs.map((j: CiJob) => Number(j.id));
            expect(ids.filter((id) => id < 2000)).toHaveLength(100);
            expect(ids.filter((id) => id > 2000)).toHaveLength(50);
            expect(detail.complete, "a tree mixing two attempts is read again, never settled").toBe(
                false,
            );
        },
    );

    it("a pipeline list entry without status or update time is not taken for a retry", async () => {
        const gl = fakeGitLab(state());
        // A list that names only the id: nothing to compare the header with.
        const gitlab = provider(gl, async (url, headers) => {
            const response = await gl.fetchWithMeta(url, headers);
            if (!new URL(url).pathname.endsWith("/pipelines")) return response;
            return { ...response, body: (response.body as Json[]).map(({ id }) => ({ id })) };
        });
        const detail = await gitlab.getDetail(ref, SHA);
        expect(detail.runs[0].state).toBe("success");
        expect(detail.complete, "a field the list left out is no sign of a retry").toBe(true);
    });

    it("statuses that belong to no pipeline go to other checks with their identity", async () => {
        const pipelineJobs = [job(1, "success", { name: "unit tests" })];
        const external = {
            id: 900,
            name: "jenkins build",
            status: "failed",
            description: "Build #41 failed",
            target_url: "https://ci.acme.com/job/41",
            allow_failure: false,
        };
        const bot = { id: 901, name: "coderabbit review", status: "success" };
        const gl = fakeGitLab(
            state({
                jobsByPipeline: new Map([[PIPELINE_ID, pipelineJobs]]),
                statuses: [...pipelineJobs, external, bot],
            }),
        );
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail.otherChecks).toEqual([
            {
                id: "900",
                name: "jenkins build",
                description: "Build #41 failed",
                state: "failure",
                source: "status",
                url: "https://ci.acme.com/job/41",
            },
        ]);
        expect(detail.otherChecksCoverage).toBe("full");
        expect(detail.outcome).toBe("failure");
    });

    it("hostile next link: http, other host, other port, other path prefix", async () => {
        const gl = fakeGitLab(state());
        const gitlab = provider(gl);
        const hostile = [
            `http://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/pipelines/1/jobs?page=2`,
            `https://evil.example/api/v4/projects/gitlab-org%2Fgitlab-runner/pipelines/1/jobs?page=2`,
            `https://gitlab.com:8443/api/v4/projects/gitlab-org%2Fgitlab-runner/pipelines/1/jobs?page=2`,
            `https://gitlab.com/api/v4/projects/other%2Frepo/pipelines/1/jobs?page=2`,
            `https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/../other%2Frepo/jobs`,
        ];
        for (const url of hostile) {
            expect(gitlab.allowNext(ref, url), url).toBe(false);
            const page = await gitlab.continueFailedScan(ref, {
                runId: PIPELINE_ID,
                runName: "Build pipeline",
                url,
            });
            expect(page, url).toEqual({ error: REFUSED });
        }
        expect(gl.log, "a refused link is never requested").toEqual([]);
        expect(gitlab.allowNext(ref, `${PROJECT}/pipelines/1/jobs?page=2`)).toBe(true);
    });

    it("error → unavailable", async () => {
        const gl = fakeGitLab(
            state({ fail: () => new Error(`socket hang up near PRIVATE-TOKEN ${TOKEN}`) }),
        );
        const detail = await provider(gl).getDetail(ref, SHA);
        expect(detail).toMatchObject({
            provider: "gitlab",
            outcome: "unavailable",
            complete: false,
            runs: [],
            error: "socket hang up near PRIVATE-TOKEN ***",
        });
    });

    it("a refused token asks to sign in; no token sends nothing", async () => {
        const refused = fakeGitLab(
            state({ fail: () => new HttpError(401, "HTTP 401: Unauthorized", {}) }),
        );
        expect(await provider(refused).getDetail(ref, SHA)).toMatchObject({
            outcome: "unavailable",
            signInHost: "gitlab.com",
            error: "Sign in to gitlab.com to view commit checks.",
        });

        const gl = fakeGitLab(state());
        const signedOut = new GitLabProvider(
            gl.fetchJson,
            tokenStore(null),
            undefined,
            gl.fetchWithMeta,
        );
        expect(await signedOut.getDetail(ref, SHA)).toMatchObject({
            outcome: "unavailable",
            signInHost: "gitlab.com",
        });
        expect(gl.log).toEqual([]);
    });

    it("steps capability stays false", () => {
        const gitlab = provider(fakeGitLab(state()));
        expect(gitlab.capabilities).toMatchObject({
            runs: true,
            jobs: true,
            runHeader: true,
            steps: false,
        });
    });
});

describe("GitLab failed-job overflow scan", () => {
    const FAILED = pipeline({ status: "failed" });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** The coordinator's wiring: scan pages read by the provider, posts to the requester. */
    function scanning(gitlab: GitLabProvider) {
        const service = new CommitCiDetailService();
        const posts: CommitCiDetail[] = [];
        const hooks: CiFailedScanHooks = {
            continueScan: (cursor) => gitlab.continueFailedScan(ref, cursor),
            isCurrent: () => true,
            onUpdate: (detail) => posts.push(detail),
        };
        const get = (force = false) =>
            service.getOrFetch(
                KEY,
                () => gitlab.getDetail(ref, SHA),
                SERVE,
                { force },
                undefined,
                hooks,
            );
        const last = () => posts[posts.length - 1];
        return { get, last };
    }

    it("scope[]=failed filtered pages add failed jobs past the bound without duplicates", async () => {
        // 1 200 jobs: one failed inside the first 1 000, two past it.
        const all = jobs(1200);
        all[4] = job(5, "failed");
        all[1049] = job(1050, "failed");
        all[1149] = job(1150, "failed");
        const gl = fakeGitLab(
            state({ pipelines: [FAILED], jobsByPipeline: new Map([[PIPELINE_ID, all]]) }),
        );
        const { get, last } = scanning(provider(gl));

        const first = await get();
        expect(first.runs[0].jobs).toHaveLength(1000);
        expect(first.runs[0].failedScan).toEqual({ state: "running", found: 0 });

        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedNames(last())).toEqual(["job 5", "job 1050", "job 1150"]);
        expect(last().runs[0].failedScan).toEqual({ state: "done", found: 2 });
        expect(last().runs[0].jobsCoverage).toEqual({ reason: "pageBound", shown: 1000 });
        // The filtered collection is read from its first page; the first 1 000 are not re-read.
        expect(scanPages(gl.log)).toEqual([1]);
        expect(jobPages(gl.log)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        let cooldownOnce = true;
        let failOnce = true;
        const gl = fakeGitLab(
            state({
                pipelines: [FAILED],
                jobsByPipeline: new Map([
                    [PIPELINE_ID, [...jobs(1000), ...jobs(250, "failed", 1001)]],
                ]),
            }),
        );
        // The gate refuses scan page 2 once (cooldown); scan page 3 fails once with a 500.
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            if (isScanPage(url, 2) && cooldownOnce) {
                cooldownOnce = false;
                throw new RequestGateCooldownError("paused", Date.now() + 30_000);
            }
            if (isScanPage(url, 3) && failOnce) {
                failOnce = false;
                throw new HttpError(500, "HTTP 500: boom", {});
            }
            return gl.fetchWithMeta(url, headers);
        };
        const { get, last } = scanning(provider(gl, fetchWithMeta));

        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("paused"));
        expect(last().runs[0].failedScan).toEqual({ state: "paused", found: 100 });

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(last().runs[0].failedScan).toEqual({
            state: "stopped",
            found: 200,
            error: "HTTP 500: boom",
        });

        const refreshed = await get(true);
        expect(failedNames(refreshed)).toHaveLength(200);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(last().runs[0].failedScan).toEqual({ state: "done", found: 250 });
        expect(new Set(failedNames(last())).size).toBe(250);
        // Each scan page reached the API once: the refresh resumed at page 3.
        expect(scanPages(gl.log)).toEqual([1, 2, 3]);
    });

    it("a 429 that starts a gate cooldown pauses the scan; a 403 stops it", async () => {
        const cursor: CiFailedScanCursor = {
            runId: PIPELINE_ID,
            runVersion: pipelineFixture.updated_at,
            runName: "Build pipeline",
            url: `${PROJECT}/pipelines/${PIPELINE_ID}/jobs?scope%5B%5D=failed&per_page=100`,
        };
        const st = state({ pipelines: [FAILED] });
        const rateLimited = fakeGitLab({
            ...st,
            fail: (url) =>
                url === cursor.url ? new HttpError(429, "HTTP 429: slow down", {}) : undefined,
        });
        expect(
            await provider(rateLimited, rateLimited.fetchWithMeta, () => 12_345).continueFailedScan(
                ref,
                cursor,
            ),
        ).toEqual({ pausedUntil: 12_345 });

        const forbidden = fakeGitLab({
            ...st,
            fail: (url) =>
                url === cursor.url ? new HttpError(403, "HTTP 403: Forbidden", {}) : undefined,
        });
        expect(
            await provider(forbidden, forbidden.fetchWithMeta, () => 12_345).continueFailedScan(
                ref,
                cursor,
            ),
        ).toEqual({ error: "Sign in to gitlab.com to view commit checks." });
    });

    it("a pipeline retried before a scan page stops the scan without reading it", async () => {
        const cursor: CiFailedScanCursor = {
            runId: PIPELINE_ID,
            runVersion: pipelineFixture.updated_at,
            runName: "Build pipeline",
            url: `${PROJECT}/pipelines/${PIPELINE_ID}/jobs?scope%5B%5D=failed&per_page=100`,
        };
        const before = fakeGitLab(
            state({
                pipelines: [pipeline({ status: "running" })],
                jobsByPipeline: new Map([[PIPELINE_ID, jobs(3, "failed")]]),
            }),
        );
        expect(await provider(before).continueFailedScan(ref, cursor)).toEqual({
            runChanged: true,
            error: CHANGED,
        });
        expect(scanPages(before.log), "nothing is read of a retried pipeline").toEqual([]);
    });

    it("a pipeline retried during a scan page discards the page it read", async () => {
        const cursor: CiFailedScanCursor = {
            runId: PIPELINE_ID,
            runVersion: pipelineFixture.updated_at,
            runName: "Build pipeline",
            url: `${PROJECT}/pipelines/${PIPELINE_ID}/jobs?scope%5B%5D=failed&per_page=100`,
        };
        const retried = pipeline({ status: "failed" });
        const during = fakeGitLab(
            state({
                pipelines: [retried],
                jobsByPipeline: new Map([[PIPELINE_ID, jobs(3, "failed")]]),
                onRequest: (url) => {
                    if (url === cursor.url) retried.status = "pending";
                },
            }),
        );
        // No `failed` key: the three jobs the page returned are dropped.
        expect(await provider(during).continueFailedScan(ref, cursor)).toEqual({
            runChanged: true,
            error: CHANGED,
        });
        expect(scanPages(during.log), "the page itself was requested").toEqual([1]);
        expect(retried.status, "the retry happened while the page was read").toBe("pending");
    });

    it("a scan stops once it has read the failed-job count its first page named", async () => {
        const gl = fakeGitLab(
            state({
                pipelines: [FAILED],
                jobsByPipeline: new Map([[PIPELINE_ID, jobs(250, "failed")]]),
                // A server that always names another page.
                nextPage: (url, page) => (url.includes("scope") ? String(page + 1) : undefined),
            }),
        );
        // And a failed-job count that grows on every page.
        let total = 150;
        const gitlab = provider(gl, async (url, headers) => {
            const response = await gl.fetchWithMeta(url, headers);
            if (!url.includes("scope")) return response;
            const answer = {
                ...response,
                headers: { ...response.headers, "x-total": String(total) },
            };
            total += 1000;
            return answer;
        });
        let cursor: CiFailedScanCursor | undefined = {
            runId: PIPELINE_ID,
            runVersion: pipelineFixture.updated_at,
            runName: "Build pipeline",
            url: `${PROJECT}/pipelines/${PIPELINE_ID}/jobs?scope%5B%5D=failed&per_page=100`,
        };
        const pages = [];
        while (cursor) {
            const page = await gitlab.continueFailedScan(ref, cursor);
            pages.push(page);
            cursor = "failed" in page && !page.error ? page.next : undefined;
        }
        expect(scanPages(gl.log)).toEqual([1, 2]);
        expect(pages[1]).toMatchObject({ error: REFUSED, next: { jobsTotal: 150 } });
    });

    it("a scan whose pages name no x-total still reads every failed page", async () => {
        const gl = fakeGitLab(
            state({
                pipelines: [FAILED],
                jobsByPipeline: new Map([
                    [PIPELINE_ID, [...jobs(1000), ...jobs(101, "failed", 1001)]],
                ]),
            }),
        );
        // GitLab leaves out x-total on very large collections.
        const gitlab = provider(gl, async (url, headers) => {
            const response = await gl.fetchWithMeta(url, headers);
            const { "x-total": _total, ...rest } = response.headers;
            return { ...response, headers: rest };
        });
        const { get, last } = scanning(gitlab);

        await get();
        await vi.waitFor(() =>
            expect(["stopped", "done"]).toContain(last()?.runs[0].failedScan?.state),
        );
        expect(last().runs[0].failedScan, "no total header is no next-link refusal").toEqual({
            state: "done",
            found: 101,
        });
        expect(scanPages(gl.log)).toEqual([1, 2]);
    });

    it("a pipeline retried and failed again between scan pages never mixes old and new jobs", async () => {
        const retried = pipeline({ status: "failed" });
        const st = state({
            pipelines: [retried],
            jobsByPipeline: new Map([[PIPELINE_ID, [...jobs(1000), ...jobs(250, "failed", 1001)]]]),
        });
        // The retry finishes, failed again, while scan page 2 is in flight: new job ids, the
        // same status, and a pipeline record GitLab rewrote.
        st.onRequest = (url) => {
            if (!isScanPage(url, 2) || retried.updated_at === "2026-11-11T10:00:00.000Z") return;
            st.jobsByPipeline.set(PIPELINE_ID, [...jobs(1000), ...jobs(250, "failed", 2001)]);
            retried.updated_at = "2026-11-11T10:00:00.000Z";
        };
        const { get, last } = scanning(provider(fakeGitLab(st)));

        await get();
        await vi.waitFor(() =>
            expect(["stopped", "done"]).toContain(last()?.runs[0].failedScan?.state),
        );
        expect(last().runs[0].failedScan?.state, "the status stayed failed across the retry").toBe(
            "stopped",
        );
        expect(last().runs[0].failedScan?.error).toBe(CHANGED);
        expect(last().complete).toBe(false);

        // A read from scratch shows only the new attempt's failed jobs.
        await get(true);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        const shown = last().runs[0].jobs.map((j: CiJob) => Number(j.id));
        expect(shown.filter((id) => id > 1000 && id < 2000)).toEqual([]);
        expect(shown.filter((id) => id > 2000)).toHaveLength(250);
    });

    it("a refresh after the pipeline was retried rescans instead of keeping the old attempt's jobs", async () => {
        const retried = pipeline({ status: "failed" });
        const st = state({
            pipelines: [retried],
            jobsByPipeline: new Map([[PIPELINE_ID, [...jobs(1000), ...jobs(50, "failed", 1001)]]]),
        });
        const { get, last } = scanning(provider(fakeGitLab(st)));
        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));

        st.jobsByPipeline.set(PIPELINE_ID, [...jobs(1000), ...jobs(50, "failed", 2001)]);
        retried.updated_at = "2026-11-11T10:00:00.000Z";
        const refreshed = await get(true);
        const ids = refreshed.runs[0].jobs.map((j: CiJob) => Number(j.id));
        expect(
            ids.filter((id) => id > 1000 && id < 2000),
            "the old attempt's failed jobs are not carried",
        ).toEqual([]);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(last().runs[0].jobs.filter((j: CiJob) => Number(j.id) > 2000)).toHaveLength(50);
    });

    it("a refresh of a pipeline with no updated_at rescans instead of keeping the old attempt's jobs", async () => {
        const st = state({
            pipelines: [pipeline({ status: "failed", updated_at: null })],
            jobsByPipeline: new Map([[PIPELINE_ID, [...jobs(1000), ...jobs(50, "failed", 1001)]]]),
        });
        const { get, last } = scanning(provider(fakeGitLab(st)));
        await get();
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));

        // A retry that failed again; with no version GitLab gives nothing else to compare.
        st.jobsByPipeline.set(PIPELINE_ID, [...jobs(1000), ...jobs(50, "failed", 2001)]);
        const refreshed = await get(true);
        expect(
            refreshed.runs[0].jobs.filter((j: CiJob) => Number(j.id) > 1000 && Number(j.id) < 2001),
            "unknown version must not reuse old-attempt jobs",
        ).toEqual([]);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("stopped"));
        expect(last().runs[0].jobs.filter((j: CiJob) => Number(j.id) > 2000)).toHaveLength(50);
    });

    it("a scan with no update time to compare ends stopped, never done", async () => {
        const st = state({
            pipelines: [pipeline({ status: "failed", updated_at: null })],
            jobsByPipeline: new Map([[PIPELINE_ID, [...jobs(1000), ...jobs(250, "failed", 1001)]]]),
        });
        // A retry that fails again while scan page 2 is in flight; the record GitLab returns
        // stays the same, so nothing shows the switch.
        st.onRequest = (url) => {
            if (!isScanPage(url, 2)) return;
            st.jobsByPipeline.set(PIPELINE_ID, [...jobs(1000), ...jobs(250, "failed", 2001)]);
        };
        const gl = fakeGitLab(st);
        const { get, last } = scanning(provider(gl));

        await get();
        await vi.waitFor(() =>
            expect(["stopped", "done"]).toContain(last()?.runs[0].failedScan?.state),
        );
        expect(scanPages(gl.log)).toEqual([1, 2, 3]);
        expect(
            last().runs[0].failedScan,
            "with no retry identity the scan reports it, keeping the failed jobs it found",
        ).toEqual({ state: "stopped", found: 250, error: UNVERIFIED });
    });

    it("a scan started with no updated_at stops once the pipeline names one", async () => {
        const cursor: CiFailedScanCursor = {
            runId: PIPELINE_ID,
            runName: "Build pipeline",
            url: `${PROJECT}/pipelines/${PIPELINE_ID}/jobs?scope%5B%5D=failed&per_page=100`,
        };
        const gl = fakeGitLab(
            state({
                pipelines: [pipeline({ status: "failed", updated_at: "2026-11-11T10:00:00.000Z" })],
                jobsByPipeline: new Map([[PIPELINE_ID, jobs(3, "failed")]]),
            }),
        );
        expect(await provider(gl).continueFailedScan(ref, cursor)).toEqual({
            runChanged: true,
            error: CHANGED,
        });
    });

    it("a status whose job the scan finds past the bound leaves other checks", async () => {
        const all = jobs(1200);
        all[1049] = job(1050, "failed", { name: "unit tests" });
        const external = { id: 9001, name: "external/ci", status: "success" };
        const gl = fakeGitLab(
            state({
                pipelines: [FAILED],
                jobsByPipeline: new Map([[PIPELINE_ID, all]]),
                statuses: [all[1049], external],
            }),
        );
        const { get, last } = scanning(provider(gl));

        const first = await get();
        expect(first.otherChecks.map((c) => c.id)).toEqual(["1050", "9001"]);
        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(last().runs[0].jobs.some((j: CiJob) => j.id === "1050")).toBe(true);
        expect(
            last().otherChecks.map((c) => c.id),
            "this status belongs to the job the scan found",
        ).toEqual(["9001"]);
    });
});
