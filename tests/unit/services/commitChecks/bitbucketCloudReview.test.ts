// Phase 17 review fixes for Bitbucket Cloud (fix round 1): the next-link guard stays inside the
// selected repository, a re-run between step pages is never saved as one tree, the overflow scan
// follows a link past a stale count, the run carries the start time the header reads, and Stop is
// not sent for a pipeline the fresh read shows as finished.

import { EventEmitter } from "node:events";
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
import type { CiRun } from "../../../../src/types";

vi.mock("vscode", () => ({
    l10n: { t: interpolateL10n },
}));
vi.mock("https");

import { BitbucketCloudProvider } from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { CommitCiDetailService } from "../../../../src/services/commitChecks/detailService";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import { CiActionFenceStore } from "../../../../src/services/commitChecks/ciActionFence";
import { runCiAction } from "../../../../src/services/commitChecks/ciActions";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import type { CommitChecksPersistentState } from "../../../../src/services/commitChecks/persistentCache";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import {
    formatCiDuration,
    spanOf,
} from "../../../../src/webviews/react/commit-info/checks/ciFormat";

const SHA = pipelineFixture.target.commit.hash;
const PIPE = pipelineFixture.uuid;
const REPO_PATH = "/2.0/repositories/acme/app";
const REPO_API = `https://api.bitbucket.org${REPO_PATH}`;
const ref = { host: "bitbucket.org", workspace: "acme", repo: "app" } as ProviderRepoRef;

type Json = Record<string, unknown>;

function completed(result: string): Json {
    return { name: "COMPLETED", result: { name: result } };
}

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

const FAILED = { ...pipelineFixture, state: completed("FAILED") } as Json;

interface Fake {
    pipelines: Json[];
    steps: Json[];
    /** Replaces the `next` link of every list page. */
    nextOf?: () => string | undefined;
}

/** A trimmed Bitbucket Cloud API 2.0: the commit's pipelines, one pipeline and its steps. */
function fakeBitbucket(state: Fake) {
    const log: string[] = [];
    const paged = (url: string, all: Json[]): FetchResponse => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page") ?? "1");
        const pagelen = Number(parsed.searchParams.get("pagelen") ?? "10");
        parsed.searchParams.set("page", String(page + 1));
        const next = state.nextOf?.() ?? (page * pagelen < all.length ? parsed.href : undefined);
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
    const respond = (url: string): FetchResponse => {
        log.push(url);
        const path = new URL(url).pathname;
        if (path === `${REPO_PATH}/pipelines/`) return paged(url, state.pipelines);
        if (path === `${REPO_PATH}/commit/${SHA}/statuses`) return paged(url, []);
        if (new RegExp(`^${REPO_PATH}/pipelines/[^/]+/steps/$`).test(path)) {
            return paged(url, state.steps);
        }
        if (new RegExp(`^${REPO_PATH}/pipelines/[^/]+$`).test(path)) {
            return { statusCode: 200, headers: {}, body: state.pipelines[0] };
        }
        throw new HttpError(404, `HTTP 404: ${url}`, {});
    };
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async (url: string) => respond(url));
    const fetchJson: FetchJson = vi.fn(async (url: string) => respond(url).body);
    return { log, fetchJson, fetchWithMeta };
}

function provider(bb: ReturnType<typeof fakeBitbucket>, write?: WriteJson) {
    const store = { get: vi.fn(async () => "bb-token") } as unknown as CredentialStore;
    return new BitbucketCloudProvider(
        bb.fetchJson,
        store,
        bb.fetchWithMeta,
        undefined,
        undefined,
        undefined,
        write,
    );
}

describe("Bitbucket Cloud review fixes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("K33 refuses a next link outside the first repository's API prefix", async () => {
        const foreign = [
            `https://api.bitbucket.org/2.0/repositories/acme/other/pipelines/?pagelen=100&page=2`,
            `https://api.bitbucket.org/2.0/repositories/evil/app/pipelines/?pagelen=100&page=2`,
            `https://api.bitbucket.org/2.0/user`,
        ];
        const run: CiRun = {
            id: "{selected}",
            name: "main",
            state: "failure",
            ref: "main",
            createdAt: "2026-11-19T10:00:00.000000Z",
            jobs: [],
            jobsCoverage: "full",
        };
        for (const url of foreign) {
            const bb = fakeBitbucket({
                pipelines: [{ ...FAILED, created_on: "2026-11-20T10:00:00.000000Z" }],
                steps: [stepFixture],
                nextOf: () => url,
            });
            const bitbucket = provider(bb);
            expect(bitbucket.allowNext(ref, url), url).toBe(false);

            await bitbucket.getDetail(ref, SHA);
            await bitbucket.getUsualDuration(ref, run);
            const cursor: CiFailedScanCursor = {
                runId: PIPE,
                runAttempt: 1,
                runName: "main",
                url,
            };
            await bitbucket.continueFailedScan(ref, cursor);

            expect(
                bb.log.filter((requested) => !requested.startsWith(`${REPO_API}/`)),
                "requests remain inside the first repository's API prefix",
            ).toEqual([]);
        }
        expect(
            provider(fakeBitbucket({ pipelines: [], steps: [] })).allowNext(
                ref,
                `${REPO_API}/pipelines/?page=2`,
            ),
        ).toBe(true);
    });

    it("a re-run between step pages cannot persist mixed attempts", async () => {
        // The first step page belongs to attempt 1; the pipeline is re-run before the second.
        const all = Array.from({ length: 150 }, (_, i) =>
            step(i + 1, "SUCCESSFUL", { run_number: i < 100 ? 1 : 2 }),
        );
        const bb = fakeBitbucket({ pipelines: [{ ...pipelineFixture }], steps: all });
        const values = new Map<string, unknown>();
        const memento = {
            get: vi.fn((key: string) => values.get(key)),
            keys: vi.fn(() => [...values.keys()]),
            update: vi.fn(async (key: string, value: unknown) => {
                if (value === undefined) values.delete(key);
                else values.set(key, value);
            }),
        } as unknown as CommitChecksPersistentState;
        const fences = new CiActionFenceStore(memento);
        const service = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(memento, { fence: fences }),
            fences,
        });
        const bitbucket = provider(bb);

        const detail = await service.getOrFetch(
            "bitbucket-cloud:repo@sha:-#detail",
            () => bitbucket.getDetail(ref, SHA),
            { repoKey: "repo", capabilities: NO_CI_CAPABILITIES },
            { force: true },
        );
        fences.dispose();

        const attempts = new Set(detail.runs.flatMap((r) => r.jobs.map((job) => job.attempt)));
        expect(
            attempts.size,
            `a mixed read must not be shown: attempts ${[...attempts].join(" and ")}`,
        ).toBeLessThanOrEqual(1);
        const persisted = [...values.entries()].find(([, value]) =>
            JSON.stringify(value).includes("{step-150}"),
        );
        expect(persisted, "persisted detail must never mix step attempts 1 and 2").toBeUndefined();
    });

    it("O1 keeps scanning while an accepted continuation remains after a short page", async () => {
        // The first page said 1 000 steps; the pipeline has 1 300 by the time the scan reads it.
        const bb = fakeBitbucket({ pipelines: [FAILED], steps: steps(1300) });
        const cursor: CiFailedScanCursor = {
            runId: PIPE,
            runAttempt: 1,
            runName: "main",
            url: `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/?pagelen=100&page=11`,
            jobsRead: 1000,
            jobsTotal: 1000,
        };

        const page = await provider(bb).continueFailedScan(ref, cursor);

        expect(
            page,
            "a present next link remains usable when the reported count is stale",
        ).toMatchObject({
            next: { url: expect.stringContaining("page=12") },
        });
        expect(page).not.toHaveProperty("error");
    });

    it("a timed completed pipeline gives the Checks header a duration", async () => {
        const bb = fakeBitbucket({ pipelines: [{ ...pipelineFixture }], steps: [stepFixture] });

        const detail = await provider(bb).getDetail(ref, SHA);

        const run = detail.runs[0];
        expect(
            run.startedAt,
            "the run with a known duration needs a start time for ChecksHeader",
        ).toBeDefined();
        const span = spanOf(detail.runs);
        expect(Date.parse(span.completedAt!) - Date.parse(span.startedAt!)).toBe(330_000);
        expect(formatCiDuration(span.startedAt, span.completedAt)).not.toBe(
            formatCiDuration(undefined, undefined),
        );
    });

    it("independent already finished pipeline sends no Stop", async () => {
        // The window's cache may still show the run as running; the fresh read shows it finished.
        const bb = fakeBitbucket({ pipelines: [{ ...pipelineFixture }], steps: [stepFixture] });
        const write: WriteJson = vi.fn(async () => ({}));
        const bitbucket = provider(bb, write);
        const begin = vi.fn(async () => {});
        const deps = {
            coordinator: {
                actionTarget: async () => ({ provider: bitbucket, ref }),
                actionGuard: () => () => true,
                getChecks: vi.fn(async () => ({})),
                getDetail: async () => bitbucket.getDetail(ref, SHA),
                invalidate: vi.fn(async () => {}),
            },
            fences: { begin, fail: vi.fn(), fenceFor: vi.fn(), endByUserRefresh: vi.fn() },
        };

        const outcome = await runCiAction(
            deps as never,
            SHA,
            { action: "cancel", runId: PIPE },
            new CiGenerations().capture("/repo"),
        );

        expect(write, "a fresh read already showed the pipeline finished").not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(outcome.outcome).toBe("failed");
    });
});

// Fix round 2: the log redirect, the pipeline-versus-step attempt, Stop at admission, a malformed
// step page, an empty overflow page and the repeated overflow link.
describe("Bitbucket Cloud review fixes, round 2", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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

    const stepLog = `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/${encodeURIComponent(stepFixture.uuid)}/log`;

    async function logRequests(routes: Record<string, Answer[]>) {
        const sent = stubServer(routes);
        // The real download, so the redirect rule under test is the production one.
        const store = { get: vi.fn(async () => "bb-token") } as unknown as CredentialStore;
        const bitbucket = new BitbucketCloudProvider(
            vi.fn() as unknown as FetchJson,
            store,
            vi.fn() as unknown as FetchJsonWithMeta,
        );
        await bitbucket
            .getJobLog(ref, { runId: PIPE, jobId: stepFixture.uuid }, new AbortController().signal)
            .catch(() => undefined);
        return sent;
    }

    it("does not send the stored token outside the repository after a same-origin log redirect", async () => {
        const elsewhere = `https://api.bitbucket.org/2.0/repositories/acme/another/log`;
        const sent = await logRequests({
            [stepLog]: [{ status: 307, location: elsewhere }],
            [elsewhere]: [{ status: 200, body: "example log" }],
        });

        expect(
            sent.some(({ url, headers }) => url === elsewhere && !!headers.Authorization),
            "no authorization outside the selected repository",
        ).toBe(false);
    });

    it("keeps the token stripped after a log redirect leaves the repository and comes back", async () => {
        const elsewhere = `https://api.bitbucket.org/2.0/repositories/acme/another/log`;
        const back = `${REPO_API}/pipelines/other/log`;
        const sent = await logRequests({
            [stepLog]: [{ status: 307, location: elsewhere }],
            [elsewhere]: [{ status: 302, location: back }],
            [back]: [{ status: 200, body: "example log" }],
        });

        expect(sent.map(({ url }) => url)).toEqual([stepLog, elsewhere, back]);
        expect(sent[0].headers.Authorization).toBe("Bearer bb-token");
        expect(sent[2].headers.Authorization, "never restored on a later hop").toBeUndefined();
    });

    it("keeps the token on a log redirect inside the repository", async () => {
        const inside = `${REPO_API}/downloads/log`;
        const sent = await logRequests({
            [stepLog]: [{ status: 307, location: inside }],
            [inside]: [{ status: 200, body: "example log" }],
        });

        expect(sent[1].headers.Authorization).toBe("Bearer bb-token");
    });

    it("does not accept a coherent tree whose steps belong to a later pipeline attempt", async () => {
        // The pipeline was listed as attempt 1 and re-run before its steps were read.
        const bb = fakeBitbucket({
            pipelines: [{ ...pipelineFixture, run_number: 1 }],
            steps: [step(1, "SUCCESSFUL", { run_number: 2 })],
        });

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail.outcome, "steps of attempt 2 cannot be shown under attempt 1").toBe(
            "unavailable",
        );
        expect(detail.runs).toEqual([]);
    });

    it("still accepts steps that carry the pipeline's own attempt", async () => {
        const bb = fakeBitbucket({
            pipelines: [{ ...pipelineFixture, run_number: 3 }],
            steps: [step(1, "SUCCESSFUL", { run_number: 3 })],
        });

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail.outcome).not.toBe("unavailable");
        expect(detail.runs[0]?.jobs).toHaveLength(1);
    });

    describe("Stop at admission", () => {
        const running = { name: "IN_PROGRESS", stage: { name: "RUNNING" } };

        /** Stop while the write waits in the gate: `change` runs after the click-time read. */
        async function stopWhileQueued(change: Json) {
            const before = fakeBitbucket({
                pipelines: [{ ...pipelineFixture, state: running }],
                steps: [stepFixture],
            });
            const after = fakeBitbucket({
                pipelines: [{ ...pipelineFixture, state: running, ...change }],
                steps: [stepFixture],
            });
            let admitted = false;
            const posted = vi.fn();
            const begin = vi.fn(async () => {});
            const bitbucket = provider(
                {
                    ...before,
                    fetchWithMeta: (url, headers) =>
                        (admitted ? after : before).fetchWithMeta(url, headers),
                },
                async (_method, _url, _headers, _body, beforeSend) => {
                    // The write waited for the gate; the pipeline changed meanwhile.
                    admitted = true;
                    await beforeSend?.();
                    posted();
                    return {};
                },
            );
            const outcome = await runCiAction(
                {
                    coordinator: {
                        actionTarget: async () => ({ provider: bitbucket, ref }),
                        actionGuard: () => () => true,
                        getChecks: vi.fn(async () => ({})),
                        getDetail: async () => bitbucket.getDetail(ref, SHA),
                        invalidate: vi.fn(async () => {}),
                    },
                    fences: { begin, fail: vi.fn(), fenceFor: vi.fn(), endByUserRefresh: vi.fn() },
                } as never,
                SHA,
                { action: "cancel", runId: PIPE },
                new CiGenerations().capture("/repo"),
            );
            return { posted, begin, outcome };
        }

        it("checks the pipeline again after Stop waited for the request gate", async () => {
            const { posted, begin } = await stopWhileQueued({ state: completed("SUCCESSFUL") });

            expect(
                posted,
                "a pipeline finished while Stop was queued must not receive a POST",
            ).not.toHaveBeenCalled();
            expect(begin, "no fence for a Stop that is not sent").not.toHaveBeenCalled();
        });

        it("sends no Stop to a pipeline that was re-run while Stop was queued", async () => {
            const { posted, begin } = await stopWhileQueued({
                run_number: Number(pipelineFixture.run_number) + 1,
            });

            expect(posted, "another attempt than the one the user saw").not.toHaveBeenCalled();
            expect(begin).not.toHaveBeenCalled();
        });

        it("still sends Stop to the pipeline the user saw", async () => {
            const { posted, begin, outcome } = await stopWhileQueued({});

            expect(posted).toHaveBeenCalledTimes(1);
            expect(begin).toHaveBeenCalledTimes(1);
            expect(outcome.outcome).toBe("ok");
        });
    });

    it("does not report a malformed middle page as complete", async () => {
        const bb = fakeBitbucket({ pipelines: [{ ...pipelineFixture }], steps: steps(101) });
        const fetch: FetchJsonWithMeta = async (url, headers) =>
            url.includes("/steps/") && url.includes("page=2")
                ? { statusCode: 200, headers: {}, body: { message: "pending page replacement" } }
                : bb.fetchWithMeta(url, headers);

        const detail = await provider({ ...bb, fetchWithMeta: fetch }).getDetail(ref, SHA);

        expect(detail.outcome, "a malformed step page must not produce a complete tree").toBe(
            "unavailable",
        );
    });

    describe("failed-step overflow scan", () => {
        const first = `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/?pagelen=100&page=11`;
        const second = first.replace("page=11", "page=12");
        const cursor = (url: string): CiFailedScanCursor => ({
            runId: PIPE,
            runAttempt: 1,
            runName: "main",
            url,
        });

        it("keeps scanning past an empty page with a valid advancing next link", async () => {
            const bb = fakeBitbucket({ pipelines: [FAILED], steps: [] });
            const bitbucket = provider({
                ...bb,
                fetchWithMeta: (url, headers) =>
                    url === first
                        ? Promise.resolve({
                              statusCode: 200,
                              headers: {},
                              body: { values: [], next: second },
                          })
                        : bb.fetchWithMeta(url, headers),
            });

            const page = await bitbucket.continueFailedScan(ref, cursor(first));

            expect(page.next?.url, "a new cursor is progress even when a page has zero rows").toBe(
                second,
            );
            expect(page.error).toBeUndefined();
        });

        it("retains found failures but refuses a repeated overflow continuation", async () => {
            const bb = fakeBitbucket({
                pipelines: [FAILED],
                steps: steps(1001, "FAILED"),
                nextOf: () => first,
            });

            const page = await provider(bb).continueFailedScan(ref, cursor(first));

            expect(page.failed, "failures already found stay visible").toHaveLength(1);
            expect(page.error, "the repeated link is reported").toBeDefined();
            // The kept cursor is the one given: it never moves on to the repeated page.
            expect(page.next).not.toHaveProperty("read");
        });
    });
});
