// Required checks (PLAN.md §7, C2, K21): GitHub's rulesets plus branch protection, GitLab's
// "Pipelines must succeed", the one-hour L1 cache and how a served detail is marked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import {
    HttpError,
    type FetchJson,
    type FetchJsonWithMeta,
    type FetchResponse,
} from "../../../../src/services/commitChecks/http";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";
import type { CiJob, CommitCiDetail, CommitCiDetailData } from "../../../../src/types";
import type { GitOps } from "../../../../src/git/operations";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("vscode", () => ({
    authentication: { getSession: mocks.getSession },
    l10n: { t: interpolateL10n },
}));

import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import {
    applyRequired,
    RequiredChecksCache,
    type RequiredChecks,
} from "../../../../src/services/commitChecks/requiredChecks";
import { CommitChecksRequestGateRegistry } from "../../../../src/services/commitChecks/requestGate";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";

const GH_REPO = "https://api.github.com/repos/octo/app";
const ghRef = { host: "github.com", owner: "octo", repo: "app" } as ProviderRepoRef;
const glRef = { host: "gitlab.com", owner: "group", repo: "app" } as ProviderRepoRef;
const GL_PROJECT = "https://gitlab.com/api/v4/projects/group%2Fapp";

type Answer = unknown | Error;

const NOT_PROTECTED = new HttpError(
    404,
    'HTTP 404: {"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-status-checks-protection","status":"404"}',
    {},
);
const NOT_FOUND = new HttpError(
    404,
    'HTTP 404: {"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
    {},
);
const FORBIDDEN = new HttpError(
    403,
    'HTTP 403: {"message":"Resource not accessible by integration","status":"403"}',
    {},
);

/** One `required_status_checks` rule as GitHub's `rules/branches/{branch}` lists it. */
function statusRule(...contexts: string[]): Record<string, unknown> {
    return {
        type: "required_status_checks",
        ruleset_source_type: "Repository",
        ruleset_source: "octo/app",
        ruleset_id: 42,
        parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: contexts.map((context) => ({
                context,
                integration_id: 15368,
            })),
        },
    };
}

/** The 200 body of `branches/{branch}/protection/required_status_checks`. */
function protection(contexts: string[], checks: string[] = contexts): Record<string, unknown> {
    return {
        url: `${GH_REPO}/branches/trunk/protection/required_status_checks`,
        strict: true,
        contexts,
        contexts_url: `${GH_REPO}/branches/trunk/protection/required_status_checks/contexts`,
        checks: checks.map((context) => ({ context, app_id: null })),
    };
}

/** GitHub's two required-check endpoints; each page of rules is one answer. */
function fakeGitHub(rules: Answer[], protectionAnswer: Answer) {
    const log: string[] = [];
    const answer = (value: Answer) => {
        if (value instanceof Error) throw value;
        return value;
    };
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async (url: string) => {
        log.push(url);
        const parsed = new URL(url);
        if (!parsed.pathname.startsWith("/repos/octo/app/rules/branches/")) throw NOT_FOUND;
        const page = Number(parsed.searchParams.get("page") ?? "1");
        const body = answer(rules[page - 1]);
        const headers: FetchResponse["headers"] =
            page < rules.length
                ? {
                      link: `<${GH_REPO}/rules/branches/trunk?per_page=100&page=${page + 1}>; rel="next"`,
                  }
                : {};
        return { statusCode: 200, headers, body };
    });
    const fetchJson: FetchJson = vi.fn(async (url: string) => {
        log.push(url);
        if (!new URL(url).pathname.endsWith("/protection/required_status_checks")) throw NOT_FOUND;
        return answer(protectionAnswer);
    });
    return { log, provider: new GitHubProvider(fetchJson, undefined, fetchWithMeta) };
}

function signedIn(): void {
    mocks.getSession.mockResolvedValue({
        id: "session",
        accessToken: "gh-token",
        account: { id: "account", label: "GitHub User" },
        scopes: ["repo"],
    });
}

const sorted = (rc: RequiredChecks) => ({ ...rc, names: [...(rc.names ?? [])].sort() });

describe("GitHubProvider.getRequiredChecks (C2)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        signedIn();
    });

    it("403 on protection yields unknown", async () => {
        const gh = fakeGitHub([[]], FORBIDDEN);

        await expect(gh.provider.getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "unknown",
            names: [],
        });
    });

    it("403 on protection with ruleset names yields partial", async () => {
        const gh = fakeGitHub([[statusRule("build")]], FORBIDDEN);

        await expect(gh.provider.getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "partial",
            names: ["build"],
        });
    });

    it("404 not protected is known-empty", async () => {
        const gh = fakeGitHub([[]], NOT_PROTECTED);

        await expect(gh.provider.getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "known",
            names: [],
        });
    });

    it("a 404 without the not-protected body is unknown", async () => {
        const gh = fakeGitHub([[]], NOT_FOUND);

        await expect(gh.provider.getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "unknown",
            names: [],
        });
    });

    it("union of rules and protection", async () => {
        const gh = fakeGitHub(
            [[{ type: "pull_request", parameters: {} }, statusRule("build", "lint")]],
            protection(["ci/legacy", "lint"], ["ci/legacy", "lint", "app-check"]),
        );

        const rc = await gh.provider.getRequiredChecks(ghRef, "trunk");

        expect(sorted(rc)).toEqual({
            status: "known",
            names: ["app-check", "build", "ci/legacy", "lint"],
        });
        expect(gh.log).toEqual([
            `${GH_REPO}/rules/branches/trunk?per_page=100`,
            `${GH_REPO}/branches/trunk/protection/required_status_checks`,
        ]);
    });

    it("reads every page of rules and encodes the branch name", async () => {
        const gh = fakeGitHub([[statusRule("build")], [statusRule("deploy")]], NOT_PROTECTED);

        const rc = await gh.provider.getRequiredChecks(ghRef, "release/2026");

        expect(sorted(rc)).toEqual({ status: "known", names: ["build", "deploy"] });
        expect(gh.log[0]).toBe(`${GH_REPO}/rules/branches/release%2F2026?per_page=100`);
        expect(gh.log).toContain(
            `${GH_REPO}/branches/release%2F2026/protection/required_status_checks`,
        );
    });

    it("a refused rules read keeps protection's names as partial", async () => {
        const gh = fakeGitHub([FORBIDDEN], protection(["ci/legacy"]));

        await expect(gh.provider.getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "partial",
            names: ["ci/legacy"],
        });
    });

    it("a transient failure rejects instead of answering unknown", async () => {
        const serverError = fakeGitHub([[]], new HttpError(502, "HTTP 502: Bad Gateway", {}));
        await expect(serverError.provider.getRequiredChecks(ghRef, "trunk")).rejects.toThrow("502");

        const rateLimited = new HttpError(403, "HTTP 403: API rate limit exceeded", {
            "x-ratelimit-remaining": "0",
        });
        const limited = fakeGitHub([rateLimited], NOT_PROTECTED);
        await expect(limited.provider.getRequiredChecks(ghRef, "trunk")).rejects.toBe(rateLimited);
    });

    it("signed out is unknown without a request", async () => {
        mocks.getSession.mockResolvedValue(undefined);
        const gh = fakeGitHub([[statusRule("build")]], protection(["build"]));

        await expect(gh.provider.getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "unknown",
        });
        expect(gh.log).toEqual([]);
    });
});

function fakeGitLab(project: Answer, token: string | null = "gl-token") {
    const log: string[] = [];
    const headersSeen: Record<string, string>[] = [];
    const fetchJson: FetchJson = vi.fn(async (url: string, headers) => {
        log.push(url);
        headersSeen.push(headers);
        if (project instanceof Error) throw project;
        return project;
    });
    const store = { get: vi.fn(async () => token) } as unknown as CredentialStore;
    return { log, headersSeen, provider: new GitLabProvider(fetchJson, store) };
}

describe("GitLabProvider.getRequiredChecks (§7)", () => {
    it("Pipelines must succeed on: every job not allowed to fail is required", async () => {
        const gl = fakeGitLab({ id: 7, only_allow_merge_if_pipeline_succeeds: true });

        await expect(gl.provider.getRequiredChecks(glRef, "main")).resolves.toEqual({
            status: "known",
            nonOptionalJobs: true,
        });
        expect(gl.log).toEqual([GL_PROJECT]);
        expect(gl.headersSeen[0]["PRIVATE-TOKEN"]).toBe("gl-token");
    });

    it("Pipelines must succeed off: nothing is required", async () => {
        const gl = fakeGitLab({ id: 7, only_allow_merge_if_pipeline_succeeds: false });

        await expect(gl.provider.getRequiredChecks(glRef, "main")).resolves.toEqual({
            status: "known",
            nonOptionalJobs: false,
        });
    });

    it("a missing field, a refusal or no token is unknown", async () => {
        await expect(
            fakeGitLab({ id: 7 }).provider.getRequiredChecks(glRef, "main"),
        ).resolves.toEqual({ status: "unknown" });
        await expect(
            fakeGitLab(new HttpError(403, "HTTP 403: Forbidden", {})).provider.getRequiredChecks(
                glRef,
                "main",
            ),
        ).resolves.toEqual({ status: "unknown" });
        const signedOut = fakeGitLab({ only_allow_merge_if_pipeline_succeeds: true }, null);
        await expect(signedOut.provider.getRequiredChecks(glRef, "main")).resolves.toEqual({
            status: "unknown",
        });
        expect(signedOut.log).toEqual([]);
    });

    it("a server error rejects", async () => {
        const gl = fakeGitLab(new HttpError(500, "HTTP 500: oops", {}));

        await expect(gl.provider.getRequiredChecks(glRef, "main")).rejects.toThrow("500");
    });
});

function ciJob(name: string, extra: Partial<CiJob> = {}): CiJob {
    return {
        id: name,
        logicalId: `job\0CI\0${name}`,
        name,
        checkName: name,
        state: "failure",
        steps: [],
        ...extra,
    };
}

function detailData(jobs: CiJob[] = [ciJob("build"), ciJob("lint")]): CommitCiDetailData {
    return {
        hash: "abc",
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [{ id: "1", name: "CI", state: "failure", jobs, jobsCoverage: "full" }],
        runsCoverage: "full",
        otherChecks: [{ name: "ci/legacy", description: "", state: "failure", source: "status" }],
        otherChecksCoverage: "full",
    };
}

function served(jobs?: CiJob[]): CommitCiDetail {
    return { ...detailData(jobs), capabilities: NO_CI_CAPABILITIES, repoKey: "/repo" };
}

const marks = (detail: CommitCiDetail) => ({
    status: detail.requiredStatus,
    jobs: detail.runs[0].jobs.map((j) => [j.name, j.required]),
    checks: detail.otherChecks.map((c) => [c.name, c.required]),
});

describe("applyRequired", () => {
    it("GitHub names: in the union is yes, else no when known and unknown otherwise", () => {
        expect(
            marks(applyRequired(served(), { status: "known", names: ["build", "ci/legacy"] })),
        ).toEqual({
            status: "known",
            jobs: [
                ["build", "yes"],
                ["lint", "no"],
            ],
            checks: [["ci/legacy", "yes"]],
        });
        expect(marks(applyRequired(served(), { status: "partial", names: ["build"] }))).toEqual({
            status: "partial",
            jobs: [
                ["build", "yes"],
                ["lint", "unknown"],
            ],
            checks: [["ci/legacy", "unknown"]],
        });
    });

    it("matches a GitHub job by its check-run name", () => {
        const job = ciJob("test (ubuntu)", { checkName: "test (ubuntu-latest)" });

        const marked = applyRequired(served([job]), {
            status: "known",
            names: ["test (ubuntu-latest)"],
        });

        expect(marked.runs[0].jobs[0].required).toBe("yes");
    });

    it("GitLab: a job allowed to fail is not required when Pipelines must succeed is on", () => {
        const jobs = [ciJob("unit"), ciJob("pages", { optional: true })];

        expect(
            marks(applyRequired(served(jobs), { status: "known", nonOptionalJobs: true })),
        ).toEqual({
            status: "known",
            jobs: [
                ["unit", "yes"],
                ["pages", "no"],
            ],
            checks: [["ci/legacy", "unknown"]],
        });
        expect(
            marks(applyRequired(served(jobs), { status: "known", nonOptionalJobs: false })),
        ).toEqual({
            status: "known",
            jobs: [
                ["unit", "no"],
                ["pages", "no"],
            ],
            checks: [["ci/legacy", "no"]],
        });
    });

    it("unknown marks everything unknown and leaves the input untouched", () => {
        const input = served();

        const marked = applyRequired(input, { status: "unknown" }, true);

        expect(marks(marked)).toEqual({
            status: "unknown",
            jobs: [
                ["build", "unknown"],
                ["lint", "unknown"],
            ],
            checks: [["ci/legacy", "unknown"]],
        });
        expect(marked.defaultBranchUnknown).toBe(true);
        expect(input.requiredStatus).toBeUndefined();
        expect(input.runs[0].jobs[0].required).toBeUndefined();
    });
});

/** A coordinator over one provider whose detail and rule the test controls. */
function coordinatorWith(options: {
    rule?: () => Promise<RequiredChecks>;
    branches?: ({ name: string; tipHash: string } | null)[];
    requiredChecks?: boolean;
}) {
    let clock = 1_000_000;
    const getRequiredChecks = vi.fn(
        async (_ref: ProviderRepoRef, _branch: string) =>
            options.rule?.() ?? { status: "known" as const, names: ["build"] },
    );
    const provider: CommitChecksProvider = {
        id: "github",
        capabilities: { ...NO_CI_CAPABILITIES, requiredChecks: options.requiredChecks ?? true },
        match: () => ghRef,
        keyFor: () => "github:github.com:octo/app",
        getChecks: vi.fn(),
        getDetail: vi.fn(async () => detailData()),
        getRequiredChecks,
    };
    const branches = options.branches ?? [{ name: "trunk", tipHash: "t1" }];
    let read = 0;
    const readDefaultBranch = vi.fn(async () => branches[Math.min(read++, branches.length - 1)]);
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/octo/app.git"),
        readDefaultBranch,
    } as unknown as GitOps;
    const generations = new CiGenerations();
    const coordinator = new CommitChecksCoordinator(
        gitOps,
        [provider],
        {},
        {
            generations,
            now: () => clock,
        },
    );
    return {
        coordinator,
        getRequiredChecks,
        readDefaultBranch,
        advance: (ms: number) => {
            clock += ms;
        },
        detail: () => coordinator.getDetail("abc", {}, generations.capture("/repo")),
    };
}

describe("CommitChecksCoordinator required checks", () => {
    it("cached for 1 h", async () => {
        const c = coordinatorWith({});

        const first = await c.detail();
        const second = await c.detail();
        // K21's hour as literals, so the test does not follow a changed constant.
        c.advance(3_599_999);
        await c.detail();

        expect(c.getRequiredChecks).toHaveBeenCalledTimes(1);
        expect(c.getRequiredChecks).toHaveBeenCalledWith(ghRef, "trunk");
        expect(first && marks(first)).toEqual({
            status: "known",
            jobs: [
                ["build", "yes"],
                ["lint", "no"],
            ],
            checks: [["ci/legacy", "no"]],
        });
        expect(second?.requiredStatus).toBe("known");

        c.advance(1);
        await c.detail();
        expect(c.getRequiredChecks).toHaveBeenCalledTimes(2);
    });

    it("reads the default branch on every call; a renamed branch gets its own entry", async () => {
        const c = coordinatorWith({
            branches: [
                { name: "trunk", tipHash: "t1" },
                { name: "trunk", tipHash: "t2" },
                { name: "develop", tipHash: "d1" },
            ],
        });

        await c.detail();
        await c.detail();
        await c.detail();

        expect(c.readDefaultBranch).toHaveBeenCalledTimes(3);
        expect(c.getRequiredChecks.mock.calls.map(([, branch]) => branch)).toEqual([
            "trunk",
            "develop",
        ]);
    });

    it("missing origin/HEAD: required unknown, no provider request", async () => {
        const c = coordinatorWith({ branches: [null] });

        const detail = await c.detail();

        expect(c.getRequiredChecks).not.toHaveBeenCalled();
        expect(detail?.requiredStatus).toBe("unknown");
        expect(detail?.defaultBranchUnknown).toBe(true);
        expect(detail?.runs[0].jobs.map((j) => j.required)).toEqual(["unknown", "unknown"]);
    });

    it("a transient failure shows unknown and is not cached", async () => {
        let calls = 0;
        const c = coordinatorWith({
            rule: async () => {
                calls += 1;
                if (calls === 1) throw new HttpError(502, "HTTP 502: Bad Gateway", {});
                return { status: "known", names: [] };
            },
        });

        const first = await c.detail();
        const second = await c.detail();

        expect(first?.requiredStatus).toBe("unknown");
        expect(first?.defaultBranchUnknown).toBeUndefined();
        expect(second?.requiredStatus).toBe("known");
        expect(c.getRequiredChecks).toHaveBeenCalledTimes(2);
    });

    it("clear() drops the cached rule", async () => {
        const c = coordinatorWith({});

        await c.detail();
        c.coordinator.clear();
        await c.detail();

        expect(c.getRequiredChecks).toHaveBeenCalledTimes(2);
    });

    it("a provider without the capability gets no required marks and no request", async () => {
        const c = coordinatorWith({ requiredChecks: false });

        const detail = await c.detail();

        expect(c.getRequiredChecks).not.toHaveBeenCalled();
        expect(c.readDefaultBranch).not.toHaveBeenCalled();
        expect(detail?.requiredStatus).toBeUndefined();
        expect(detail?.runs[0].jobs[0].required).toBeUndefined();
    });
});

/**
 * The real GitHub provider's rule read behind the real request gate, wired as activation wires
 * it (commitChecksProviders.ts), inside the real coordinator and its hour cache, on one clock.
 * Rulesets always answer `build`; protection gives `protectionAnswers` in order, the last one
 * repeating. Only the run detail is stubbed, so `requests` holds the two rule endpoints only.
 */
function gatedGitHub(protectionAnswers: Answer[]) {
    let clock = 1_000_000;
    const now = () => clock;
    const registry = new CommitChecksRequestGateRegistry("Paused for rate limiting.", now);
    const requests: string[] = [];
    let protectionReads = 0;
    const fetchJson: FetchJson = (url) =>
        registry.run("github", url, async () => {
            requests.push(url);
            const answer =
                protectionAnswers[Math.min(protectionReads++, protectionAnswers.length - 1)];
            if (answer instanceof Error) throw answer;
            return answer;
        });
    const fetchWithMeta: FetchJsonWithMeta = (url) =>
        registry.run("github", url, async () => {
            requests.push(url);
            return { statusCode: 200, headers: {}, body: [statusRule("build")] };
        });
    const provider = new GitHubProvider(fetchJson, undefined, fetchWithMeta, (url) =>
        registry.cooldownEnd("github", url),
    );
    provider.getDetail = vi.fn(async () =>
        detailData([ciJob("build"), ciJob("deploy"), ciJob("lint")]),
    );
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/octo/app.git"),
        readDefaultBranch: vi.fn(async () => ({ name: "trunk", tipHash: "t1" })),
    } as unknown as GitOps;
    const generations = new CiGenerations();
    const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { generations, now });
    return {
        requests,
        advance: (ms: number) => {
            clock += ms;
        },
        detail: () => coordinator.getDetail("abc", {}, generations.capture("/repo")),
    };
}

const jobMarks = (detail: CommitCiDetail | undefined) =>
    detail?.runs[0].jobs.map((job) => [job.name, job.required]);

describe("a rate-limited protection read (owner's decision B, 2026-11-14)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        signedIn();
    });

    it.each([
        [
            "a 403 with retry-after and quota left",
            new HttpError(403, "HTTP 403: You have exceeded a secondary rate limit", {
                "retry-after": "60",
                "x-ratelimit-remaining": "4000",
            }),
        ],
        [
            "a 403 with no quota left and a reset time",
            new HttpError(403, "HTTP 403: API rate limit exceeded", {
                "x-ratelimit-remaining": "0",
                // The fake clock starts at 1 000 s, so the quota resets 60 s later.
                "x-ratelimit-reset": "1060",
            }),
        ],
    ])(
        "%s is not saved, and GitHub is not asked again until the pause ends",
        async (_, limited) => {
            const gh = gatedGitHub([limited, protection(["deploy"])]);

            const first = await gh.detail();
            expect(first?.requiredStatus, "the rate-limited answer must not be shown as read").toBe(
                "unknown",
            );

            gh.advance(10_000);
            const asked = gh.requests.length;
            const paused = await gh.detail();
            expect(gh.requests.length - asked, "no request may reach GitHub during the pause").toBe(
                0,
            );
            expect(paused?.requiredStatus).toBe("unknown");

            gh.advance(51_000);
            const after = await gh.detail();
            expect(after?.requiredStatus, "the rule must be read again once the pause ends").toBe(
                "known",
            );
            expect(jobMarks(after), "both requests' names must be required").toEqual([
                ["build", "yes"],
                ["deploy", "yes"],
                ["lint", "no"],
            ]);
        },
    );

    it("a plain 403 with quota left and no retry-after stays partial and is saved for the hour", async () => {
        const gh = gatedGitHub([FORBIDDEN, protection(["deploy"])]);

        const first = await gh.detail();
        gh.advance(10_000);
        const asked = gh.requests.length;
        const later = await gh.detail();
        gh.advance(3_589_999);
        await gh.detail();

        expect(first?.requiredStatus).toBe("partial");
        expect(later?.requiredStatus).toBe("partial");
        expect(gh.requests.length - asked, "the saved partial answer is used for the hour").toBe(0);
        gh.advance(1);
        await gh.detail();
        expect(gh.requests.length - asked, "the hour's end reads both endpoints again").toBe(2);
    });
});

describe("RequiredChecksCache", () => {
    it("a fetch that fails after a clear() never drops the newer fetch's rule", async () => {
        const cache = new RequiredChecksCache();
        let failOld!: (error: Error) => void;
        const old = cache.get(
            "/repo",
            "trunk",
            () => new Promise<RequiredChecks>((_resolve, reject) => (failOld = reject)),
        );
        cache.clear();
        const newer: RequiredChecks = { status: "known", names: ["build"] };
        await cache.get("/repo", "trunk", async () => newer);

        failOld(new Error("HTTP 502"));
        await expect(old).rejects.toThrow("HTTP 502");
        const refetch = vi.fn(async (): Promise<RequiredChecks> => ({ status: "unknown" }));

        expect(
            await cache.get("/repo", "trunk", refetch),
            "the old fetch's failure must not remove the newer rule",
        ).toBe(newer);
        expect(refetch).not.toHaveBeenCalled();
    });
});
