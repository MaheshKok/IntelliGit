// Phase 17 review fixes for Bitbucket Cloud (fix round 1): the next-link guard stays inside the
// selected repository, a re-run between step pages is never saved as one tree, the overflow scan
// follows a link past a stale count, the run carries the start time the header reads, and Stop is
// not sent for a pipeline the fresh read shows as finished.

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
