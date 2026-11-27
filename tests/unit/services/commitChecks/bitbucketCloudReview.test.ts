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
    downloadCiLog,
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

    it("hands the log download the provider's credential header list", async () => {
        const downloadLog = vi.fn(async () => ({ text: "", truncated: false }));
        const store = { get: vi.fn(async () => "bb-token") } as unknown as CredentialStore;
        const bitbucket = new BitbucketCloudProvider(
            vi.fn() as unknown as FetchJson,
            store,
            vi.fn() as unknown as FetchJsonWithMeta,
            undefined,
            undefined,
            downloadLog,
        );

        await bitbucket.getJobLog(
            ref,
            { runId: PIPE, jobId: stepFixture.uuid },
            new AbortController().signal,
        );

        expect(downloadLog.mock.calls[0]?.[4], "Cloud's credential headers").toEqual([
            "authorization",
        ]);
    });

    it("the log download strips the credential headers it is given on an origin change", async () => {
        const storage = "https://bbuseruploads.s3.amazonaws.com/log?sig=abc";
        const sent = stubServer({
            [stepLog]: [{ status: 307, location: storage }],
            [storage]: [{ status: 200, body: "example log" }],
        });

        await downloadCiLog(
            stepLog,
            { Authorization: "Bearer bb-token", "X-Provider-Token": "secret" },
            new AbortController().signal,
            undefined,
            ["x-provider-token"],
        );

        expect(
            sent[1]?.headers,
            "a provider-listed header never leaves its origin",
        ).not.toHaveProperty("X-Provider-Token");
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
                { action: "cancel", runId: PIPE, attempt: Number(pipelineFixture.run_number) },
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

// Phase 17 takeover: the status pager's next-link rule, the attempt the user saw carried to Stop,
// a re-check after the fence, attempt evidence on the first read and the overflow scan, and
// cancel as the only action the provider sends.
describe("Bitbucket Cloud review fixes, takeover", () => {
    const running = { name: "IN_PROGRESS" };

    /** A provider whose write runs its admission callback, then counts the POST. */
    function stopper(bb: ReturnType<typeof fakeBitbucket>) {
        const posted = vi.fn();
        const bitbucket = provider(bb, async (_method, _url, _headers, _body, beforeSend) => {
            await beforeSend?.();
            posted();
            return {};
        });
        return { bitbucket, posted };
    }

    function stopFor(
        bitbucket: BitbucketCloudProvider,
        begin: () => Promise<void>,
        attempt: number | undefined,
    ) {
        return runCiAction(
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
            { action: "cancel", runId: PIPE, ...(attempt !== undefined && { attempt }) },
            new CiGenerations().capture("/repo"),
        );
    }

    it("the C3 fallback never follows a status cursor to another repository", async () => {
        const otherRepo =
            "https://api.bitbucket.org/2.0/repositories/acme/other/commit/statuses?page=2";
        const fetchJson = vi.fn(async (url: string) =>
            url === otherRepo ? { values: [] } : { values: [], next: otherRepo },
        );
        const bitbucket = provider({
            log: [],
            fetchJson,
            fetchWithMeta: async () => {
                throw new HttpError(403, "HTTP 403: Forbidden", {});
            },
        });

        const detail = await bitbucket.getDetail(ref, SHA);

        expect(detail).toHaveProperty("scopeHelp");
        expect(
            fetchJson.mock.calls.map(([url]) => url),
            "fallback must not send a signed request to another repository",
        ).not.toContain(otherRepo);
        expect(detail.otherChecksCoverage, "the refused page leaves the list partial").not.toBe(
            "full",
        );
    });

    it("the snapshot keeps following a status cursor inside the repository", async () => {
        const second = `${REPO_API}/commit/${SHA}/statuses?pagelen=100&page=2`;
        const fetchJson = vi.fn(async (url: string) =>
            url === second ? { values: [] } : { values: [], next: second },
        );
        const bitbucket = provider({ log: [], fetchJson, fetchWithMeta: vi.fn() });

        const snapshot = await bitbucket.getChecks(ref, SHA);

        expect(fetchJson.mock.calls.map(([url]) => url)).toContain(second);
        expect(snapshot.partial).toBeUndefined();
    });

    it("Stop refuses the re-run already present at the first fresh read", async () => {
        const { bitbucket, posted } = stopper(
            fakeBitbucket({
                pipelines: [{ ...pipelineFixture, run_number: 2, state: running }],
                steps: [step(1, "SUCCESSFUL", { run_number: 2 })],
            }),
        );
        const begin = vi.fn(async () => {});

        const outcome = await stopFor(bitbucket, begin, 1);

        expect(
            posted,
            "a Stop confirmed for attempt 1 never posts against attempt 2",
        ).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(outcome.outcome).toBe("failed");
    });

    it("Stop refuses a pipeline that changes while the fence is storing", async () => {
        const pipeline = { ...pipelineFixture, state: running };
        const { bitbucket, posted } = stopper(
            fakeBitbucket({ pipelines: [pipeline], steps: [stepFixture] }),
        );
        const begin = vi.fn(async () => {
            pipeline.run_number = 2;
        });
        const fail = vi.fn();

        await runCiAction(
            {
                coordinator: {
                    actionTarget: async () => ({ provider: bitbucket, ref }),
                    actionGuard: () => () => true,
                    getChecks: vi.fn(async () => ({})),
                    getDetail: async () => bitbucket.getDetail(ref, SHA),
                    invalidate: vi.fn(async () => {}),
                },
                fences: { begin, fail, fenceFor: vi.fn(), endByUserRefresh: vi.fn() },
            } as never,
            SHA,
            { action: "cancel", runId: PIPE, attempt: 1 },
            new CiGenerations().capture("/repo"),
        );

        expect(begin).toHaveBeenCalledOnce();
        expect(
            posted,
            "the pipeline switched attempts during the fence write",
        ).not.toHaveBeenCalled();
        expect(fail, "the fence of the refused Stop is removed").toHaveBeenCalledOnce();
    });

    it("Stop still reaches the pipeline the user saw", async () => {
        const { bitbucket, posted } = stopper(
            fakeBitbucket({
                pipelines: [{ ...pipelineFixture, state: running }],
                steps: [stepFixture],
            }),
        );

        const outcome = await stopFor(
            bitbucket,
            vi.fn(async () => {}),
            1,
        );

        expect(posted).toHaveBeenCalledOnce();
        expect(outcome.outcome).toBe("ok");
    });

    it("the Cloud provider rejects an unsupported re-run action", async () => {
        const { bitbucket, posted } = stopper(
            fakeBitbucket({
                pipelines: [{ ...pipelineFixture, state: running }],
                steps: [stepFixture],
            }),
        );

        await expect(
            bitbucket.runAction(ref, { action: "rerunFailed", runId: PIPE }, async () => {}),
        ).rejects.toThrow();
        expect(posted, "unsupported actions must never send stopPipeline").not.toHaveBeenCalled();
    });

    it("the detail revalidates an attempt when step evidence is absent", async () => {
        const bb = fakeBitbucket({
            pipelines: [FAILED],
            steps: [step(1, "SUCCESSFUL", { run_number: undefined })],
        });
        const bitbucket = provider({
            ...bb,
            fetchWithMeta: (url, headers) =>
                new URL(url).pathname.endsWith(`/pipelines/${encodeURIComponent(PIPE)}`)
                    ? Promise.resolve({
                          statusCode: 200,
                          headers: {},
                          body: { ...FAILED, run_number: 2 },
                      })
                    : bb.fetchWithMeta(url, headers),
        });

        const detail = await bitbucket.getDetail(ref, SHA);

        expect(detail.outcome, "no step attempt evidence requires a fresh pipeline read").toBe(
            "unavailable",
        );
    });

    it("keeps the tree when steps name no attempt and the pipeline is unchanged", async () => {
        const bb = fakeBitbucket({
            pipelines: [FAILED],
            steps: [step(1, "FAILED", { run_number: undefined })],
        });

        const detail = await provider(bb).getDetail(ref, SHA);

        expect(detail.outcome).toBe("failure");
        expect(detail.runs[0]?.jobs).toHaveLength(1);
    });

    it("the overflow scan refuses a step page from another attempt", async () => {
        const bb = fakeBitbucket({
            pipelines: [FAILED],
            steps: [step(1, "FAILED", { run_number: 2 })],
        });

        const page = await provider(bb).continueFailedScan(ref, {
            runId: PIPE,
            runAttempt: 1,
            runName: "main",
            url: `${REPO_API}/pipelines/${encodeURIComponent(PIPE)}/steps/?pagelen=100`,
        });

        expect(page, "attempt 2 overflow must never merge into attempt 1").toHaveProperty("error");
        expect(page.failed).toBeUndefined();
    });
});

// Phase 17 independent review: Stop needs the attempt the user confirmed and the repository it
// started in up to the POST, a failed admission read is a Stop not sent, the C3 fallback names a
// refused status link, and steps of two attempts never make a tree.
describe("Bitbucket Cloud review fixes, independent review", () => {
    const RUNNING: Json = { ...pipelineFixture, state: { name: "IN_PROGRESS" } };

    const noFence = () => ({
        begin: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
        fenceFor: vi.fn(),
        endByUserRefresh: vi.fn(),
    });

    /** Stop through `runCiAction`; `current` is the repository guard it checks before sending. */
    function makeAction(
        bitbucket: BitbucketCloudProvider,
        fences = noFence(),
        current = () => true,
    ) {
        return {
            fences,
            action: (attempt?: number) =>
                runCiAction(
                    {
                        coordinator: {
                            actionTarget: async () => ({ provider: bitbucket, ref }),
                            actionGuard: () => current,
                            getDetail: async () => bitbucket.getDetail(ref, SHA),
                            getChecks: vi.fn(async () => ({})),
                            invalidate: vi.fn(async () => {}),
                        },
                        fences,
                    } as never,
                    SHA,
                    { action: "cancel", runId: PIPE, ...(attempt !== undefined && { attempt }) },
                    new CiGenerations().capture("/repo"),
                ),
        };
    }

    /** One pipeline; `readOne` answers the Stop's own pipeline reads, numbered from 1. */
    function fixtureStop(pipeline: Json = { ...RUNNING }, readOne?: (read: number) => unknown) {
        const fake = fakeBitbucket({ pipelines: [pipeline], steps: [] });
        const sent = vi.fn();
        let reads = 0;
        const cloud = provider(
            {
                ...fake,
                fetchWithMeta: async (url, headers) =>
                    new URL(url).pathname.endsWith(`/pipelines/${encodeURIComponent(PIPE)}`)
                        ? {
                              statusCode: 200,
                              headers: {},
                              body: readOne ? readOne(++reads) : pipeline,
                          }
                        : fake.fetchWithMeta(url, headers),
            },
            async (_method, _url, _headers, _body, beforeSend) => {
                await beforeSend?.();
                sent();
                return {};
            },
        );
        return { cloud, sent };
    }

    it("a Stop without confirmation evidence cannot adopt a newly visible attempt", async () => {
        const { cloud, sent } = fixtureStop({ ...RUNNING, run_number: 2 });
        const { action, fences } = makeAction(cloud);

        await action();

        expect(sent, "the host has no confirmed attempt to authorize Stop").not.toHaveBeenCalled();
        expect(fences.begin).not.toHaveBeenCalled();
    });

    it("switching repository during the final pipeline read leaves no Stop", async () => {
        let current = true;
        const { cloud, sent } = fixtureStop({ ...RUNNING }, (read) => {
            if (read === 2) current = false;
            return RUNNING;
        });
        const { action, fences } = makeAction(cloud, noFence(), () => current);

        await action(1);

        expect(sent, "the original repository no longer owns the action").not.toHaveBeenCalled();
        expect(fences.fail, "the fence of the unsent Stop is removed").toHaveBeenCalledOnce();
    });

    it.each([
        [503, "admission read unavailable"],
        [403, "admission read forbidden"],
    ])(
        "a %i on the final admission GET is a Stop not sent, shown with the read's error",
        async (status, message) => {
            const { cloud, sent } = fixtureStop({ ...RUNNING }, (read) => {
                if (read === 2) throw new HttpError(status, message, {});
                return RUNNING;
            });
            const { action, fences } = makeAction(cloud);

            const result = await action(1);

            expect(sent).not.toHaveBeenCalled();
            expect(
                result,
                "a failed read is neither an uncertain POST nor missing write scope",
            ).toEqual({ outcome: "failed", message });
            expect(fences.fail, "the fence of the unsent Stop is removed").toHaveBeenCalledOnce();
        },
    );

    it("C3 displays a refused-continuation warning instead of a page-limit warning", async () => {
        const fetchJson = vi.fn(async () => ({
            values: [{ key: "one", name: "one", state: "SUCCESSFUL" }],
            next: "https://api.bitbucket.org/2.0/repositories/acme/other/statuses",
        }));
        const bitbucket = provider({
            log: [],
            fetchJson,
            fetchWithMeta: async () => {
                throw new HttpError(403, "HTTP 403: Forbidden", {});
            },
        });

        const detail = await bitbucket.getDetail(ref, SHA);

        expect(
            detail.otherChecksCoverage,
            "K33: a refused link is named as refused, with the rows shown",
        ).toEqual({ reason: "rejectedNext", shown: 1 });
    });

    it("mixed step attempts are unavailable when the pipeline listing has no attempt", async () => {
        const bitbucket = provider(
            fakeBitbucket({
                pipelines: [{ ...FAILED, run_number: undefined }],
                steps: [step(1, "FAILED", { run_number: 1 }), step(2, "FAILED", { run_number: 2 })],
            }),
        );

        const detail = await bitbucket.getDetail(ref, SHA);

        expect(detail.outcome, "mixed steps lack one coherent attempt").toBe("unavailable");
    });
});
