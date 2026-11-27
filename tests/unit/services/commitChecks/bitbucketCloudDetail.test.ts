// Bitbucket Cloud CI detail (PLAN.md §15, Phase 17): a commit's pipelines and their steps as the
// run → job tree, the failed-step overflow scan, step logs through the redirect helper, cancel
// through stopPipeline under the action fence, the header fields, the "usually" baseline, and the
// flat list with a scope hint when the token lacks the `pipeline` scope (C3).

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as https from "https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import pipelineFixture from "../../../fixtures/commitChecks/bitbucket-cloud/pipeline.json";
import stepFixture from "../../../fixtures/commitChecks/bitbucket-cloud/step.json";
import {
    HttpError,
    type FetchJson,
    type FetchJsonWithMeta,
    type FetchResponse,
    type WriteJson,
} from "../../../../src/services/commitChecks/http";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type {
    CiFailedScanCursor,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";
import type { CiJob, CiRun, CommitCiDetail } from "../../../../src/types";
import type { GitOps } from "../../../../src/git/operations";

vi.mock("vscode", () => ({
    l10n: { t: interpolateL10n },
}));
// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

import { BitbucketCloudProvider } from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { RequestGateCooldownError } from "../../../../src/services/commitChecks/requestGate";
import {
    CommitCiDetailService,
    type CiFailedScanHooks,
} from "../../../../src/services/commitChecks/detailService";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import {
    ACTION_FENCE_KEY_PREFIX,
    CiActionFenceStore,
} from "../../../../src/services/commitChecks/ciActionFence";
import { runCiAction } from "../../../../src/services/commitChecks/ciActions";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import {
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
} from "../../../../src/services/commitChecks/persistentCache";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import { logicalCheckId } from "../../../../src/shared/ci/identity";

const SHA = pipelineFixture.target.commit.hash;
const TOKEN = "bb-token";
const PIPE = pipelineFixture.uuid;
const STEP = stepFixture.uuid;
const API = "https://api.bitbucket.org/2.0";
const REPO_API = `${API}/repositories/acme/app`;
const REPO_PATH = "/2.0/repositories/acme/app";
const RESULTS = "https://bitbucket.org/acme/app/pipelines/results";
const HELP_URL =
    "https://github.com/acme/tool/blob/HEAD/docs/commit-checks/README.md#bitbucket-cloud-pipeline-scope";
const ref = { host: "bitbucket.org", workspace: "acme", repo: "app" } as ProviderRepoRef;
const KEY = `bitbucket-cloud:repo@${SHA}:-#detail`;
const SERVE = { repoKey: "repo", capabilities: NO_CI_CAPABILITIES };
const REFUSED = "The provider's next-page link was refused.";
const EN = JSON.parse(
    readFileSync(join(__dirname, "../../../../src/webviews/i18n/en.json"), "utf8"),
) as Record<string, string>;

type Json = Record<string, unknown>;

function completed(result: string, extra: Json = {}): Json {
    return { name: "COMPLETED", result: { name: result, ...extra } };
}

/** A step from the recorded fixture, renumbered; its uuid keeps Bitbucket's braces. */
function step(id: number, result = "SUCCESSFUL", overrides: Json = {}): Json {
    return {
        ...stepFixture,
        uuid: `{step-${id}}`,
        name: `step ${id}`,
        state: completed(result),
        ...overrides,
    };
}

function steps(count: number, result = "SUCCESSFUL", from = 1): Json[] {
    return Array.from({ length: count }, (_, i) => step(from + i, result));
}

function pipeline(overrides: Json = {}): Json {
    return { ...pipelineFixture, ...overrides };
}

const FAILED = pipeline({ state: completed("FAILED") });

interface FakeBitbucket {
    pipelines: Json[];
    stepsByPipeline: Map<string, Json[]>;
    statuses: Json[];
    /** Throws for a URL the test wants to fail; consulted on every request. */
    fail?: (url: string) => Error | undefined;
    /** Replaces the body's `next` link of a list page. */
    nextOf?: (url: string, page: number) => string | undefined;
}

/** In-memory Bitbucket Cloud API 2.0: pipelines, one pipeline, its steps and commit statuses. */
function fakeBitbucket(state: FakeBitbucket) {
    const log: string[] = [];
    const headersSeen: Record<string, string>[] = [];
    const paged = (url: string, all: Json[]): FetchResponse => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page") ?? "1");
        // Bitbucket's default page length, so a request that omits pagelen gets fewer items.
        const pagelen = Number(parsed.searchParams.get("pagelen") ?? "10");
        parsed.searchParams.set("page", String(page + 1));
        const next =
            state.nextOf?.(url, page) ?? (page * pagelen < all.length ? parsed.href : undefined);
        return {
            statusCode: 200,
            headers: {},
            body: {
                page,
                pagelen,
                size: all.length,
                values: all.slice((page - 1) * pagelen, page * pagelen),
                ...(next !== undefined && { next }),
            },
        };
    };
    const respond = (url: string, headers: Record<string, string>): FetchResponse => {
        log.push(url);
        headersSeen.push(headers);
        const error = state.fail?.(url);
        if (error) throw error;
        const parsed = new URL(url);
        const path = parsed.pathname;
        if (path === `${REPO_PATH}/pipelines/`) {
            const hash = parsed.searchParams.get("target.commit.hash");
            const refName = parsed.searchParams.get("target.ref_name");
            const listed = state.pipelines
                .filter(
                    (p) =>
                        hash === null ||
                        ((p.target as { commit?: { hash?: string } }).commit?.hash ?? "") === hash,
                )
                .filter(
                    (p) =>
                        refName === null ||
                        (p.target as { ref_name?: string }).ref_name === refName,
                );
            if (parsed.searchParams.get("sort") === "-created_on") {
                listed.sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
            }
            return paged(url, listed);
        }
        if (path === `${REPO_PATH}/commit/${SHA}/statuses`) return paged(url, state.statuses);
        const one = new RegExp(`^${REPO_PATH}/pipelines/([^/]+)$`).exec(path);
        const found = one && state.pipelines.find((p) => p.uuid === decodeURIComponent(one[1]));
        if (found) return { statusCode: 200, headers: {}, body: found };
        const stepsMatch = new RegExp(`^${REPO_PATH}/pipelines/([^/]+)/steps/$`).exec(path);
        if (stepsMatch) {
            return paged(url, state.stepsByPipeline.get(decodeURIComponent(stepsMatch[1])) ?? []);
        }
        throw new HttpError(404, `HTTP 404: ${url}`, {});
    };
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async (url: string, headers) =>
        respond(url, headers),
    );
    const fetchJson: FetchJson = vi.fn(async (url: string, headers) => respond(url, headers).body);
    return { log, headersSeen, fetchJson, fetchWithMeta };
}

function state(partial: Partial<FakeBitbucket> = {}): FakeBitbucket {
    return {
        pipelines: [pipeline()],
        stepsByPipeline: new Map([[PIPE, [stepFixture]]]),
        statuses: [],
        ...partial,
    };
}

function tokenStore(token: string | null = TOKEN): CredentialStore {
    return { get: vi.fn(async () => token) } as unknown as CredentialStore;
}

function provider(
    bb: ReturnType<typeof fakeBitbucket>,
    options: {
        fetchWithMeta?: FetchJsonWithMeta;
        cooldownEnd?: (url: string) => number;
        write?: WriteJson;
        store?: CredentialStore;
    } = {},
): BitbucketCloudProvider {
    return new BitbucketCloudProvider(
        bb.fetchJson,
        options.store ?? tokenStore(),
        options.fetchWithMeta ?? bb.fetchWithMeta,
        undefined,
        options.cooldownEnd,
        undefined,
        options.write,
        HELP_URL,
    );
}

/** Pages requested of a pipeline's step list, in order. */
function stepPages(log: readonly string[]): number[] {
    return log
        .filter((url) => new URL(url).pathname.endsWith("/steps/"))
        .map((url) => Number(new URL(url).searchParams.get("page") ?? "1"));
}

function isStepPage(url: string, page: number): boolean {
    const parsed = new URL(url);
    return parsed.pathname.endsWith("/steps/") && parsed.searchParams.get("page") === String(page);
}

const failedNames = (detail: CommitCiDetail): string[] =>
    detail.runs[0].jobs.filter((j: CiJob) => j.state === "failure").map((j) => j.name);

describe("BitbucketCloudProvider.getDetail", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("maps pipeline → steps as jobs", async () => {
        const failedPipeline = pipeline({
            state: completed("FAILED", { error: { message: "Pipeline failed: 2 steps failed" } }),
        });
        const bb = fakeBitbucket(
            state({
                pipelines: [failedPipeline],
                stepsByPipeline: new Map([
                    [
                        PIPE,
                        [
                            stepFixture,
                            step(2, "FAILED", {
                                state: completed("FAILED", {
                                    error: { message: "Container 'build' exceeded memory limit." },
                                }),
                            }),
                            step(3, "FAILED"),
                            // A manual step left waiting in a finished pipeline settles as neutral.
                            step(4, "", { state: { name: "PENDING" }, started_on: undefined }),
                        ],
                    ],
                ]),
                statuses: [
                    {
                        key: "8f2a1c4e",
                        name: "Pipeline #42 for main",
                        state: "FAILED",
                        url: "https://bitbucket.org/acme/app/addon/pipelines/home#!/results/42",
                    },
                    {
                        key: "sonar",
                        name: "SonarCloud",
                        state: "SUCCESSFUL",
                        url: "https://sonarcloud.io/dashboard?id=acme_app",
                    },
                ],
            }),
        );
        const bitbucket = provider(bb);

        const detail = await bitbucket.getDetail(ref, SHA);

        expect(bitbucket.capabilities).toMatchObject({
            runs: true,
            jobs: true,
            runHeader: true,
            logs: true,
            failureSummary: true,
            cancel: true,
            usualDuration: true,
            steps: false,
        });
        expect(detail).toMatchObject({
            hash: SHA,
            provider: "bitbucket-cloud",
            complete: true,
            outcome: "failure",
            runsCoverage: "full",
            otherChecksCoverage: "full",
        });
        expect(detail.runs).toHaveLength(1);
        const run = detail.runs[0];
        expect(run).toMatchObject({
            id: PIPE,
            name: "main",
            url: `${RESULTS}/42`,
            state: "failure",
            event: "push",
            actor: "Ada Lovelace",
            ref: "main",
            runNumber: 42,
            attempt: 1,
            createdAt: pipelineFixture.created_on,
            completedAt: pipelineFixture.completed_on,
            jobsCoverage: "full",
        });
        expect(run.jobs.map((j) => [j.name, j.state])).toEqual([
            ["Unit tests", "success"],
            ["step 2", "failure"],
            ["step 3", "failure"],
            ["step 4", "neutral"],
        ]);
        expect(run.jobs[0]).toEqual({
            id: STEP,
            logicalId: logicalCheckId({ kind: "job", scope: "main", name: "Unit tests" }),
            name: "Unit tests",
            checkName: "Unit tests",
            state: "success",
            url: `${RESULTS}/42/steps/${encodeURIComponent(STEP)}`,
            startedAt: stepFixture.started_on,
            completedAt: stepFixture.completed_on,
            attempt: 1,
            steps: [],
        });
        expect(run.jobs[1].failureSummary).toBe("Container 'build' exceeded memory limit.");
        expect(run.jobs[2].failureSummary, "a step without its own text shows the pipeline's").toBe(
            "Pipeline failed: 2 steps failed",
        );
        expect(run.jobs.every((j) => j.steps.length === 0)).toBe(true);
        // The pipeline's own build status is the run; only the external one is an other check.
        expect(detail.otherChecks.map((c) => c.name)).toEqual(["SonarCloud"]);
        expect(bb.headersSeen.every((h) => h.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    });

    it("403 on pipeline discovery keeps flat list with hint", async () => {
        const bb = fakeBitbucket(
            state({
                statuses: [
                    { key: "a", name: "Jenkins", state: "FAILED", url: "https://ci.example/1" },
                    { key: "b", name: "SonarCloud", state: "SUCCESSFUL" },
                ],
                fail: (url) =>
                    new URL(url).pathname === `${REPO_PATH}/pipelines/`
                        ? new HttpError(403, "HTTP 403: Forbidden", {})
                        : undefined,
            }),
        );

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail).toMatchObject({
            provider: "bitbucket-cloud",
            outcome: "failure",
            runs: [],
            scopeHelp: { key: "commit.checks.tab.pipelineScopeHint", url: HELP_URL },
            sessionOnly: true,
        });
        expect(detail.otherChecks.map((c) => c.name)).toEqual(["Jenkins", "SonarCloud"]);
        // C3: the plan's `pipeline` code span is plain text, as the webview shows it literally.
        expect(EN["commit.checks.tab.pipelineScopeHint"]).toBe("Steps need the pipeline scope.");
    });

    it("403 on steps keeps flat list with hint", async () => {
        const bb = fakeBitbucket(
            state({
                statuses: [{ key: "a", name: "Jenkins", state: "SUCCESSFUL" }],
                fail: (url) =>
                    new URL(url).pathname.endsWith("/steps/")
                        ? new HttpError(403, "HTTP 403: Forbidden", {})
                        : undefined,
            }),
        );

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail).toMatchObject({
            outcome: "success",
            runs: [],
            scopeHelp: { key: "commit.checks.tab.pipelineScopeHint", url: HELP_URL },
            sessionOnly: true,
        });
        expect(detail.otherChecks.map((c) => c.name)).toEqual(["Jenkins"]);
    });

    it("second page fails → unavailable", async () => {
        const bb = fakeBitbucket(
            state({
                stepsByPipeline: new Map([[PIPE, steps(150)]]),
                fail: (url) =>
                    isStepPage(url, 2) ? new HttpError(500, "HTTP 500: boom", {}) : undefined,
            }),
        );

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail).toMatchObject({
            provider: "bitbucket-cloud",
            outcome: "unavailable",
            complete: false,
            runs: [],
            error: "HTTP 500: boom",
        });
        expect(detail).not.toHaveProperty("scopeHelp");
    });

    it("a refused token asks to sign in; no token sends nothing", async () => {
        const refused = fakeBitbucket(
            state({ fail: () => new HttpError(401, "HTTP 401: Unauthorized", {}) }),
        );
        expect(await provider(refused).getDetail(ref, SHA)).toMatchObject({
            outcome: "unavailable",
            signInHost: "bitbucket.org",
            error: "Sign in to bitbucket.org to view commit checks.",
        });

        const bb = fakeBitbucket(state());
        expect(await provider(bb, { store: tokenStore(null) }).getDetail(ref, SHA)).toMatchObject({
            outcome: "unavailable",
            signInHost: "bitbucket.org",
        });
        expect(bb.log).toEqual([]);
    });

    it("a token echoed by a transport error is redacted", async () => {
        const bb = fakeBitbucket(
            state({ fail: () => new Error(`socket hang up near Bearer ${TOKEN}`) }),
        );
        expect(await provider(bb).getDetail(ref, SHA)).toMatchObject({
            outcome: "unavailable",
            error: "socket hang up near Bearer ***",
        });
    });

    it("requests carry pagelen=100", async () => {
        const bb = fakeBitbucket(
            state({
                pipelines: [FAILED],
                stepsByPipeline: new Map([[PIPE, steps(150)]]),
                statuses: [{ key: "a", name: "Jenkins", state: "SUCCESSFUL" }],
            }),
        );

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail.runs[0].jobs).toHaveLength(150);
        expect(detail.runs[0].jobsCoverage).toBe("full");
        const lists = bb.log.filter(
            (url) => !new RegExp(`^${REPO_PATH}/pipelines/[^/]+$`).test(new URL(url).pathname),
        );
        expect(lists.length).toBeGreaterThanOrEqual(4);
        for (const url of lists) {
            expect(new URL(url).searchParams.get("pagelen"), url).toBe("100");
        }
        expect(stepPages(bb.log)).toEqual([1, 2]);
    });

    it("1 001+ steps: 1 000 kept, coverage pageBound shown 1000", async () => {
        const bb = fakeBitbucket(state({ stepsByPipeline: new Map([[PIPE, steps(1100)]]) }));

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail.runs[0].jobs).toHaveLength(1000);
        expect(detail.runs[0].jobsCoverage).toEqual({ reason: "pageBound", shown: 1000 });
        expect(detail).not.toHaveProperty("scanCursors");
        expect(stepPages(bb.log)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("hostile next link: http, other host, other port, other path prefix", async () => {
        const hostile = [
            `http://api.bitbucket.org${REPO_PATH}/pipelines/?pagelen=100&page=2`,
            `https://evil.example${REPO_PATH}/pipelines/?pagelen=100&page=2`,
            `https://api.bitbucket.org:8443${REPO_PATH}/pipelines/?pagelen=100&page=2`,
            `https://api.bitbucket.org/internal/repositories/acme/app/pipelines/?page=2`,
            `https://api.bitbucket.org/2.0/../internal/repositories/acme/app/pipelines/?page=2`,
        ];
        for (const url of hostile) {
            const bb = fakeBitbucket(
                state({
                    statuses: [{ key: "a", name: "Jenkins", state: "SUCCESSFUL" }],
                    nextOf: () => url,
                }),
            );
            const bitbucket = provider(bb);
            expect(bitbucket.allowNext(ref, url), url).toBe(false);
            const page = await bitbucket.continueFailedScan(ref, {
                runId: PIPE,
                runAttempt: 1,
                runName: "main",
                url,
            });
            expect(page, url).toEqual({ error: REFUSED });
            expect(bb.log, `${url}: a refused link is never requested`).toEqual([]);

            const detail = await bitbucket.getDetail(ref, SHA);
            expect(detail.runsCoverage, url).toEqual({ reason: "rejectedNext", shown: 1 });
            // The snapshot path keeps calling the same rule.
            expect((await bitbucket.getChecks(ref, SHA)).partial, url).toBe(true);
            expect(bb.log.includes(url), `${url}: never requested`).toBe(false);
        }
        expect(
            provider(fakeBitbucket(state())).allowNext(ref, `${REPO_API}/pipelines/?page=2`),
        ).toBe(true);
    });

    it("rerunFailed/rerunJob stay false", () => {
        const bitbucket = provider(fakeBitbucket(state()));
        expect(bitbucket.capabilities.rerunFailed).toBe(false);
        expect(bitbucket.capabilities.rerunJob).toBe(false);
        expect(bitbucket.capabilities.attemptHistory).toBe(false);
        expect(bitbucket.capabilities.requiredChecks).toBe(false);
    });

    it("maps every Bitbucket pipeline and step state to its CI state", async () => {
        const cases: [Json, CiJob["state"]][] = [
            [{ name: "PENDING" }, "queued"],
            [{ name: "READY" }, "queued"],
            [{ name: "IN_PROGRESS", stage: { name: "RUNNING" } }, "running"],
            [{ name: "IN_PROGRESS", stage: { name: "PAUSED" } }, "neutral"],
            [{ name: "IN_PROGRESS", stage: { name: "HALTED" } }, "unknown"],
            [completed("SUCCESSFUL"), "success"],
            [completed("FAILED"), "failure"],
            [completed("ERROR"), "failure"],
            [completed("STOPPED"), "cancelled"],
            [completed("EXPIRED"), "cancelled"],
            [completed("NOT_RUN"), "skipped"],
            [completed("SKIPPED"), "skipped"],
        ];
        for (const [raw, expected] of cases) {
            const bb = fakeBitbucket(
                state({
                    pipelines: [pipeline({ state: raw })],
                    stepsByPipeline: new Map([[PIPE, [step(1, "", { state: raw })]]]),
                }),
            );
            const detail = await provider(bb).getDetail(ref, SHA);
            expect(detail.runs[0].state, JSON.stringify(raw)).toBe(expected);
            expect(detail.runs[0].jobs[0].state, JSON.stringify(raw)).toBe(expected);
        }
    });
});

describe("Bitbucket Cloud failed-step overflow scan", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** The coordinator's wiring: scan pages read by the provider, posts to the requester. */
    function scanning(bitbucket: BitbucketCloudProvider) {
        const service = new CommitCiDetailService();
        const posts: CommitCiDetail[] = [];
        const hooks: CiFailedScanHooks = {
            continueScan: (cursor) => bitbucket.continueFailedScan(ref, cursor),
            isCurrent: () => true,
            onUpdate: (detail) => posts.push(detail),
        };
        const get = (force = false) =>
            service.getOrFetch(
                KEY,
                () => bitbucket.getDetail(ref, SHA),
                SERVE,
                { force },
                undefined,
                hooks,
            );
        const last = () => posts[posts.length - 1];
        return { get, last };
    }

    it("failed steps past the bound are listed", async () => {
        // 1 200 steps: one failed inside the first 1 000, two past it.
        const all = steps(1200);
        all[4] = step(5, "FAILED");
        all[1049] = step(1050, "FAILED");
        all[1149] = step(1150, "FAILED");
        const bb = fakeBitbucket(
            state({ pipelines: [FAILED], stepsByPipeline: new Map([[PIPE, all]]) }),
        );
        const { get, last } = scanning(provider(bb));

        const first = await get();
        expect(first.runs[0].jobs).toHaveLength(1000);
        expect(first.runs[0].failedScan).toEqual({ state: "running", found: 0 });

        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(failedNames(last())).toEqual(["step 5", "step 1050", "step 1150"]);
        expect(last().runs[0].failedScan).toEqual({ state: "done", found: 2 });
        expect(last().runs[0].jobsCoverage).toEqual({ reason: "pageBound", shown: 1000 });
        // The scan continues the same collection past page 10; the first 1 000 are not re-read.
        expect(stepPages(bb.log)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it("failed jobs past 1 000 survive a cooldown pause and a failed page, and resume from the saved cursor", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        let cooldownOnce = true;
        let failOnce = true;
        const bb = fakeBitbucket(
            state({
                pipelines: [FAILED],
                stepsByPipeline: new Map([[PIPE, [...steps(1000), ...steps(250, "FAILED", 1001)]]]),
            }),
        );
        // The gate refuses step page 12 once (cooldown); step page 13 fails once with a 500.
        const fetchWithMeta: FetchJsonWithMeta = async (url, headers) => {
            if (isStepPage(url, 12) && cooldownOnce) {
                cooldownOnce = false;
                throw new RequestGateCooldownError("paused", Date.now() + 30_000);
            }
            if (isStepPage(url, 13) && failOnce) {
                failOnce = false;
                throw new HttpError(500, "HTTP 500: boom", {});
            }
            return bb.fetchWithMeta(url, headers);
        };
        const { get, last } = scanning(provider(bb, { fetchWithMeta }));

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
        // Each scan page reached the API once: the refresh resumed at page 13.
        expect(stepPages(bb.log).filter((page) => page > 10)).toEqual([11, 12, 13]);
    });

    it("a 429 that starts a gate cooldown pauses the scan; a 403 stops it", async () => {
        const cursor: CiFailedScanCursor = {
            runId: PIPE,
            runAttempt: 1,
            runName: "main",
            url: `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/?pagelen=100&page=11`,
        };
        const st = state({ pipelines: [FAILED] });
        const rateLimited = fakeBitbucket({
            ...st,
            fail: (url) =>
                url === cursor.url ? new HttpError(429, "HTTP 429: slow down", {}) : undefined,
        });
        expect(
            await provider(rateLimited, { cooldownEnd: () => 12_345 }).continueFailedScan(
                ref,
                cursor,
            ),
        ).toEqual({ pausedUntil: 12_345 });

        const forbidden = fakeBitbucket({
            ...st,
            fail: (url) =>
                url === cursor.url ? new HttpError(403, "HTTP 403: Forbidden", {}) : undefined,
        });
        expect(
            await provider(forbidden, { cooldownEnd: () => 12_345 }).continueFailedScan(
                ref,
                cursor,
            ),
        ).toEqual({ error: "Sign in to bitbucket.org to view commit checks." });
    });

    it("a pipeline re-run before a scan page stops the scan without reading it", async () => {
        const cursor: CiFailedScanCursor = {
            runId: PIPE,
            runAttempt: 1,
            runName: "main",
            url: `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/?pagelen=100&page=11`,
        };
        const bb = fakeBitbucket(
            state({ pipelines: [pipeline({ state: completed("FAILED"), run_number: 2 })] }),
        );

        const page = await provider(bb).continueFailedScan(ref, cursor);

        expect(page).toEqual({
            runChanged: true,
            error: "Remote data changed. Reload and try again.",
        });
        expect(stepPages(bb.log)).toEqual([]);
    });

    it("a pipeline without run_number scans its steps by the attempt the first read accepted", async () => {
        // Every fixture step names attempt 1; the pipeline itself names none.
        const bb = fakeBitbucket(
            state({
                pipelines: [pipeline({ state: completed("FAILED"), run_number: undefined })],
                stepsByPipeline: new Map([[PIPE, [...steps(1000), ...steps(50, "FAILED", 1001)]]]),
            }),
        );
        const { get, last } = scanning(provider(bb));

        await get();

        await vi.waitFor(() => expect(last()?.runs[0].failedScan?.state).toBe("done"));
        expect(
            last().runs[0].failedScan,
            "steps of the same attempt on a later page are kept",
        ).toEqual({ state: "done", found: 50 });

        // A later page of another attempt still stops the scan.
        const rerun = fakeBitbucket(
            state({
                pipelines: [pipeline({ state: completed("FAILED"), run_number: undefined })],
                stepsByPipeline: new Map([[PIPE, [step(1, "FAILED", { run_number: 2 })]]]),
            }),
        );
        const page = await provider(rerun).continueFailedScan(ref, {
            runId: PIPE,
            stepAttempt: 1,
            runName: "main",
            url: `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/?pagelen=100&page=1`,
        });
        expect(page, "a step of attempt 2 after attempt 1 was accepted").toEqual({
            runChanged: true,
            error: "Remote data changed. Reload and try again.",
        });
    });
});

describe("Bitbucket Cloud step log", () => {
    const LOG_URL = `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/${encodeURIComponent(STEP)}/log`;
    const BLOB_URL = "https://bbuseruploads.s3.amazonaws.com/logs/step-1.log?Signature=abc";

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

    beforeEach(() => {
        vi.mocked(https.get).mockReset();
    });

    it("307 log redirect carries no Authorization", async () => {
        const sent = stubServer({
            [LOG_URL]: [{ status: 307, location: BLOB_URL }],
            [BLOB_URL]: [{ status: 200, body: "+ npm test\nFAIL src/a.test.ts\n" }],
        });

        const log = await provider(fakeBitbucket(state())).getJobLog(
            ref,
            { runId: PIPE, jobId: STEP },
            new AbortController().signal,
        );

        expect(log).toEqual({ text: "+ npm test\nFAIL src/a.test.ts\n", truncated: false });
        expect(sent.map((request) => request.url)).toEqual([LOG_URL, BLOB_URL]);
        expect(sent[0]!.headers.Authorization, "the API request is signed").toBe(`Bearer ${TOKEN}`);
        expect(
            Object.keys(sent[1]!.headers).some((name) => name.toLowerCase() === "authorization"),
            "the log storage host never sees the token",
        ).toBe(false);
    });
});

describe("Bitbucket Cloud usual duration", () => {
    it("usual baseline created before the selected pipeline", async () => {
        const at = (day: number) => `2026-11-${day}T10:00:00.000000Z`;
        const selected = pipeline({
            uuid: "{selected}",
            created_on: at(20),
            state: completed("FAILED"),
        });
        const newer = pipeline({ uuid: "{newer}", created_on: at(21), duration_in_seconds: 100 });
        const baseline = pipeline({
            uuid: "{baseline}",
            created_on: at(19),
            duration_in_seconds: 300,
        });
        const oldest = pipeline({ uuid: "{oldest}", created_on: at(18), duration_in_seconds: 999 });
        const failedBefore = pipeline({
            uuid: "{failed-before}",
            created_on: at(19).replace("10:00", "12:00"),
            state: completed("FAILED"),
        });
        const otherRef = pipeline({
            uuid: "{other-ref}",
            created_on: at(19).replace("10:00", "13:00"),
            target: { ...pipelineFixture.target, ref_name: "feature" },
        });
        const bb = fakeBitbucket(
            state({
                pipelines: [newer, selected, otherRef, failedBefore, baseline, oldest],
                stepsByPipeline: new Map([
                    [
                        "{baseline}",
                        [
                            step(1, "SUCCESSFUL", { duration_in_seconds: 120 }),
                            step(2, "SUCCESSFUL", { duration_in_seconds: 60 }),
                            step(3, "SKIPPED", { duration_in_seconds: 0 }),
                        ],
                    ],
                ]),
            }),
        );
        const run: CiRun = {
            id: "{selected}",
            name: "main",
            state: "failure",
            ref: "main",
            createdAt: at(20),
            jobs: [],
            jobsCoverage: "full",
        };

        const usual = await provider(bb).getUsualDuration(ref, run);

        expect(usual).toEqual({
            baselineRunId: "{baseline}",
            runMs: 300_000,
            jobMs: {
                [logicalCheckId({ kind: "job", scope: "main", name: "step 1" })]: 120_000,
                [logicalCheckId({ kind: "job", scope: "main", name: "step 2" })]: 60_000,
            },
        });
        const listed = bb.log.filter((url) => new URL(url).pathname === `${REPO_PATH}/pipelines/`);
        expect(listed.length).toBeGreaterThan(0);
        for (const url of listed) {
            expect(new URL(url).searchParams.get("target.ref_name")).toBe("main");
            expect(new URL(url).searchParams.get("pagelen")).toBe("100");
        }
    });

    it("no baseline, no ref or no token is null", async () => {
        const run: CiRun = {
            id: PIPE,
            name: "main",
            state: "success",
            ref: "main",
            createdAt: pipelineFixture.created_on,
            jobs: [],
            jobsCoverage: "full",
        };
        const bb = fakeBitbucket(state());
        expect(await provider(bb).getUsualDuration(ref, run)).toBeNull();
        expect(await provider(bb).getUsualDuration(ref, { ...run, ref: undefined })).toBeNull();
        const before = bb.log.length;
        expect(
            await provider(bb, { store: tokenStore(null) }).getUsualDuration(ref, run),
        ).toBeNull();
        expect(bb.log.length).toBe(before);
    });
});

type Memento = CommitChecksPersistentState & {
    values: Map<string, unknown>;
    keys(): readonly string[];
};

function memento(): Memento {
    const values = new Map<string, unknown>();
    return {
        values,
        get: vi.fn((key: string) => values.get(key)),
        keys: vi.fn(() => [...values.keys()]),
        update: vi.fn(async (key: string, value: unknown) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }),
    } as unknown as Memento;
}

describe("Bitbucket Cloud cancel", () => {
    const windows: CiActionFenceStore[] = [];

    afterEach(() => {
        for (const fences of windows.splice(0)) fences.dispose();
    });

    /** `write` behind an always-open gate: the fence and its checks, then the request. */
    function admitted(write: WriteJson): WriteJson {
        return async (method, url, headers, body, beforeSend) => {
            await beforeSend?.();
            return write(method, url, headers, body);
        };
    }

    /** One window over the provider: fence store, both caches and a coordinator. */
    function windowOver(bitbucket: BitbucketCloudProvider) {
        const workspace = memento();
        const global = memento();
        const fences = new CiActionFenceStore(workspace);
        windows.push(fences);
        const generations = new CiGenerations();
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(async () => "https://bitbucket.org/acme/app.git"),
        } as unknown as GitOps;
        const coordinator = new CommitChecksCoordinator(
            gitOps,
            [bitbucket],
            {},
            {
                service: new CommitChecksService({
                    persistentCache: new CommitChecksPersistentCache(global, { fence: fences }),
                    fences,
                }),
                detailService: new CommitCiDetailService({
                    persistentCache: new CiDetailPersistentCache(global, { fence: fences }),
                    fences,
                }),
                generations,
            },
        );
        return {
            workspace,
            fences,
            deps: { coordinator, fences },
            ctx: generations.capture("/repo"),
        };
    }

    const RUNNING = pipeline({ state: { name: "IN_PROGRESS", stage: { name: "RUNNING" } } });

    it("cancel posts stopPipeline with the token after the fence", async () => {
        const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
        const write: WriteJson = vi.fn(async (method, url, headers) => {
            calls.push({ method, url, headers });
            return {};
        });
        const bb = fakeBitbucket(state({ pipelines: [RUNNING] }));
        const { deps, ctx, workspace } = windowOver(provider(bb, { write: admitted(write) }));

        const outcome = await runCiAction(
            deps,
            SHA,
            { action: "cancel", runId: PIPE, attempt: 1 },
            ctx,
        );

        expect(outcome).toEqual({ outcome: "ok" });
        expect(calls).toEqual([
            {
                method: "POST",
                url: `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/stopPipeline`,
                headers: { Authorization: `Bearer ${TOKEN}` },
            },
        ]);
        expect(
            [...workspace.values.keys()].filter((key) => key.startsWith(ACTION_FENCE_KEY_PREFIX)),
        ).toHaveLength(1);
    });

    it("stopPipeline maps 403 to forbidden with pipeline:write help and removes the fence", async () => {
        const write: WriteJson = vi.fn(async () => {
            throw new HttpError(403, "HTTP 403: Forbidden", {});
        });
        const bb = fakeBitbucket(state({ pipelines: [RUNNING] }));
        const bitbucket = provider(bb, { write: admitted(write) });
        const { deps, ctx, fences, workspace } = windowOver(bitbucket);

        const outcome = await runCiAction(
            deps,
            SHA,
            { action: "cancel", runId: PIPE, attempt: 1 },
            ctx,
        );

        expect(write).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({ outcome: "forbidden" });
        expect(fences.isFenced(SHA)).toBe(false);
        expect(
            [...workspace.values.keys()].filter((key) => key.startsWith(ACTION_FENCE_KEY_PREFIX)),
        ).toEqual([]);
        // The plan's `pipeline:write` code span is plain text here: the webview shows backticks.
        expect(EN[bitbucket.capabilities.writeScopeHelp!]).toBe(
            "Your Bitbucket Cloud token cannot stop pipelines. Add the pipeline:write scope to stop one.",
        );
    });
});

describe("Bitbucket Cloud detail edge rows (PR #461 review)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a malformed status row in the scope fallback yields an unavailable detail, not a rejection", async () => {
        const bb = fakeBitbucket(
            state({
                statuses: [null as unknown as Json],
                fail: (url) =>
                    new URL(url).pathname.startsWith(`${REPO_PATH}/pipelines/`)
                        ? new HttpError(403, "HTTP 403: Forbidden", {})
                        : undefined,
            }),
        );

        const detail = await provider(bb)
            .getDetail(ref, SHA)
            .catch((err: unknown) => ({ rejected: String(err) }));

        expect(detail, "getDetail never throws").toMatchObject({
            outcome: "unavailable",
            complete: false,
        });
    });

    it("an empty next link on a steps page is refused, not read as the last page", async () => {
        const bb = fakeBitbucket(
            state({
                nextOf: (url, page) =>
                    new URL(url).pathname.endsWith("/steps/") && page === 1 ? "" : undefined,
            }),
        );

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail.runs[0].jobsCoverage, "an empty next link leaves its page unread").toEqual({
            reason: "rejectedNext",
            shown: 1,
        });
    });

    it("only a status that links to the pipeline's result is folded into its run", async () => {
        const bb = fakeBitbucket(
            state({
                statuses: [
                    {
                        key: "pipe-new",
                        name: "Pipeline #42",
                        state: "SUCCESSFUL",
                        url: `${RESULTS}/42`,
                    },
                    {
                        key: "pipe-old",
                        name: "Pipeline #42 (old link)",
                        state: "SUCCESSFUL",
                        url: "https://bitbucket.org/acme/app/addon/pipelines/home#!/results/42",
                    },
                    {
                        key: "report",
                        name: "Coverage report",
                        state: "FAILED",
                        url: "https://bitbucket.org/acme/app/downloads/results/42-report.html",
                    },
                ],
            }),
        );

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(
            detail.otherChecks.map((check) => check.name),
            "an unrelated link containing /results/42 is kept",
        ).toEqual(["Coverage report"]);
        expect(detail.outcome).toBe("failure");
    });

    it("a pipeline paused at a manual step is unfinished and never a success", async () => {
        const bb = fakeBitbucket(
            state({
                pipelines: [
                    pipeline({ state: { name: "IN_PROGRESS", stage: { name: "PAUSED" } } }),
                ],
                stepsByPipeline: new Map([[PIPE, [stepFixture]]]),
            }),
        );

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail.runs[0].state, "the run still shows as waiting").toBe("neutral");
        expect(detail.outcome, "a paused pipeline with a passed step").toBe("pending");
        expect(detail.complete, "a paused pipeline still waits for a person").toBe(false);
    });
});
