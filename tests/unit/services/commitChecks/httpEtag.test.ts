import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");
vi.mock("vscode", () => ({
    authentication: {
        getSession: async () => ({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        }),
    },
    l10n: { t: (message: string) => message },
}));

import { createCommitChecksProviders } from "../../../../src/activation/commitChecksProviders";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { EtagStore } from "../../../../src/services/commitChecks/etagStore";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import {
    createHttpGetJsonWithMeta,
    HttpError,
    type HttpResponseMetadata,
} from "../../../../src/services/commitChecks/http";
import { linkHeaderNext, paginate } from "../../../../src/services/commitChecks/paginate";
import {
    CommitChecksRequestGateRegistry,
    gatedFetchWithMeta,
} from "../../../../src/services/commitChecks/requestGate";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";

type Headers = Record<string, string | string[] | undefined>;
interface Sent {
    url: string;
    headers: Record<string, string>;
}
interface Reply {
    status: number;
    headers?: Headers;
    body?: string;
}

const URL_1 = "https://api.github.com/repos/o/r/actions/runs?head_sha=abc&per_page=100";
const URL_2 = `${URL_1}&page=2`;

/** Answers `https.get` calls in order from `replies` and records what each request sent. */
function stubSequence(replies: Reply[]): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(https.get).mockImplementation(((
        url: string,
        options: { headers: Record<string, string> },
        cb: (r: unknown) => void,
    ) => {
        sent.push({ url, headers: { ...options.headers } });
        const reply = replies.shift();
        if (!reply) throw new Error(`unexpected request ${url}`);
        return respond(reply, cb);
    }) as unknown as typeof https.get);
    return sent;
}

function respond(reply: Reply, cb: (r: unknown) => void): EventEmitter {
    const req = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(() => req),
        destroy: vi.fn(() => req),
    });
    const res = Object.assign(new EventEmitter(), {
        statusCode: reply.status,
        headers: reply.headers ?? {},
    });
    cb(res);
    queueMicrotask(() => {
        if (reply.body) res.emit("data", Buffer.from(reply.body));
        res.emit("end");
    });
    return req;
}

/**
 * A conditional server: every 200 carries an `ETag` of its body, and a request naming the
 * current one gets a header-minimal 304 (quota headers only, no `Link` or `x-next-page`).
 */
function stubServer(route: (url: string) => { headers?: Headers; body: unknown }): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(https.get).mockImplementation(((
        url: string,
        options: { headers: Record<string, string> },
        cb: (r: unknown) => void,
    ) => {
        sent.push({ url, headers: { ...options.headers } });
        const { headers, body } = route(url);
        const text = JSON.stringify(body);
        const etag = `W/"${createHash("sha1").update(text).digest("hex")}"`;
        if (options.headers["If-None-Match"] === etag) {
            return respond({ status: 304, headers: { "x-ratelimit-remaining": "4990" } }, cb);
        }
        return respond({ status: 200, headers: { etag, ...headers }, body: text }, cb);
    }) as unknown as typeof https.get);
    return sent;
}

const conditionalOf = (sent: readonly Sent[]) =>
    sent.filter((request) => request.headers["If-None-Match"] !== undefined);

describe("ETag conditional requests on the metadata fetch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("sends If-None-Match from store", async () => {
        const store = new EtagStore(() => 0);
        const sent = stubSequence([
            { status: 200, headers: { etag: 'W/"e1"' }, body: '{"a":1}' },
            { status: 304, headers: {} },
        ]);
        const fetch = createHttpGetJsonWithMeta();

        await fetch(URL_1, { Authorization: "Bearer t" }, store);
        await fetch(URL_1, { Authorization: "Bearer t" }, store);

        expect(sent[0].headers["If-None-Match"], "nothing stored yet").toBeUndefined();
        expect(sent[1].headers).toEqual({ Authorization: "Bearer t", "If-None-Match": 'W/"e1"' });
    });

    it("304 returns stored body", async () => {
        const store = new EtagStore(() => 0);
        stubSequence([
            { status: 200, headers: { etag: 'W/"e1"' }, body: '{"a":1}' },
            { status: 304, headers: { "x-ratelimit-remaining": "10" } },
        ]);
        const fetch = createHttpGetJsonWithMeta();

        await fetch(URL_1, {}, store);
        const response = await fetch(URL_1, {}, store);

        expect(response.body).toEqual({ a: 1 });
        expect(response.headers["x-ratelimit-remaining"]).toBe("10");
    });

    it("a 304 hands out a fresh copy, so a caller's edit never changes the stored body", async () => {
        const store = new EtagStore(() => 0);
        stubSequence([
            { status: 200, headers: { etag: 'W/"e1"' }, body: '{"list":[1]}' },
            { status: 304 },
            { status: 304 },
        ]);
        const fetch = createHttpGetJsonWithMeta();

        ((await fetch(URL_1, {}, store)).body as { list: number[] }).list.push(2);
        ((await fetch(URL_1, {}, store)).body as { list: number[] }).list.push(3);
        const third = await fetch(URL_1, {}, store);

        expect(third.body).toEqual({ list: [1] });
    });

    it("304 without stored body re-requests", async () => {
        const store = new EtagStore(() => 0);
        const sent = stubSequence([{ status: 304 }, { status: 200, body: '{"b":2}' }]);

        const response = await createHttpGetJsonWithMeta()(URL_1, {}, store);

        expect(response.body).toEqual({ b: 2 });
        expect(sent).toHaveLength(2);
        expect(conditionalOf(sent)).toEqual([]);
    });

    it("re-requests a body-less 304 only once", async () => {
        const store = new EtagStore(() => 0);
        const sent = stubSequence([{ status: 304 }, { status: 304 }]);

        const failure = createHttpGetJsonWithMeta()(URL_1, {}, store);

        await expect(failure).rejects.toBeInstanceOf(HttpError);
        await expect(failure).rejects.toMatchObject({ statusCode: 304 });
        expect(sent).toHaveLength(2);
    });

    it("the re-request after a body-less 304 drops a caller's If-None-Match in any case", async () => {
        const sent = stubSequence([{ status: 304 }, { status: 200, body: "{}" }]);

        await createHttpGetJsonWithMeta()(
            URL_1,
            { "if-none-match": '"external"', Authorization: "Bearer t" },
            new EtagStore(() => 0),
        );

        expect(
            Object.keys(sent[1].headers).filter((name) => name.toLowerCase() === "if-none-match"),
            "the re-request must be unconditional",
        ).toEqual([]);
        expect(sent[1].headers.Authorization).toBe("Bearer t");
    });

    it("the re-request after a body-less 304 is refused while that 304 reported a cooldown", async () => {
        const now = Date.now();
        const registry = new CommitChecksRequestGateRegistry("cooling down", () => now);
        const sent = stubSequence([
            {
                status: 304,
                headers: {
                    "x-ratelimit-limit": "5000",
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": String(Math.floor(now / 1000) + 60),
                },
            },
            { status: 200, body: "{}" },
        ]);

        const failure = gatedFetchWithMeta(registry, "github")(URL_1, {}, new EtagStore(() => 0));

        await expect(failure).rejects.toMatchObject({ statusCode: 429 });
        expect(sent, "the re-request waits for the cooldown like any request").toHaveLength(1);
    });

    it("the re-request after a body-less 304 counts against the gate's request budget", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const store = new EtagStore(() => 0);
        const sent = stubSequence(
            Array.from({ length: 200 }, (): Reply[] => [
                { status: 304 },
                { status: 200, body: "{}" },
            ]).flat(),
        );
        const fetch = gatedFetchWithMeta(registry, "github");

        // The fallback budget is 300 requests an hour; each read here costs two.
        for (let read = 0; read < 150; read += 1) await fetch(URL_1, {}, store);

        await expect(fetch(URL_1, {}, store)).rejects.toMatchObject({ statusCode: 429 });
        expect(sent).toHaveLength(300);
    });

    it("a request queued under an old token never stores a body the new token is answered with", async () => {
        let generation = 0;
        const store = new EtagStore(() => generation);
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const releases: Array<() => void> = [];
        // Fill the bucket's four slots so the next request waits in the queue.
        const blockers = Array.from({ length: 4 }, () =>
            registry.run("github", URL_1, () => new Promise<void>((done) => releases.push(done))),
        );
        await vi.waitFor(() => expect(releases).toHaveLength(4));
        const sent = stubSequence([
            { status: 200, headers: { etag: 'W/"old"' }, body: '{"who":"old"}' },
            { status: 200, headers: { etag: 'W/"new"' }, body: '{"who":"new"}' },
        ]);
        const fetch = gatedFetchWithMeta(registry, "github");

        const queued = fetch(URL_1, { Authorization: "Bearer old" }, store);
        generation = 1;
        for (const release of releases) release();
        await Promise.all(blockers);
        await queued;
        const response = await fetch(URL_1, { Authorization: "Bearer new" }, store);

        expect(
            sent[1].headers["If-None-Match"],
            "the old token's etag is not sent",
        ).toBeUndefined();
        expect(response.body).toEqual({ who: "new" });
    });

    it("without a store nothing is conditional and a 304 still rejects, as before", async () => {
        const sent = stubSequence([
            { status: 200, headers: { etag: 'W/"e1"' }, body: '{"a":1}' },
            { status: 304 },
        ]);
        const fetch = createHttpGetJsonWithMeta();

        await fetch(URL_1, {});
        await expect(fetch(URL_1, {})).rejects.toMatchObject({ statusCode: 304 });
        expect(conditionalOf(sent)).toEqual([]);
    });

    it("304 headers reach the gate", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const observe = vi.spyOn(registry, "observeResponse");
        const store = new EtagStore(() => 0);
        stubSequence([
            { status: 200, headers: { etag: 'W/"e1"' }, body: '{"a":1}' },
            {
                status: 304,
                headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4321" },
            },
        ]);
        const fetch = gatedFetchWithMeta(registry, "github");

        await fetch(URL_1, {}, store);
        const response = await fetch(URL_1, {}, store);

        expect(response.body).toEqual({ a: 1 });
        const seen = observe.mock.calls.map(([, metadata]) => metadata);
        expect(seen.at(-1)).toMatchObject({
            url: URL_1,
            statusCode: 304,
            headers: { "x-ratelimit-remaining": "4321" },
        });
    });

    it("a new auth generation does not reuse the body", async () => {
        let generation = 0;
        const store = new EtagStore(() => generation);
        const sent = stubSequence([
            { status: 200, headers: { etag: 'W/"e1"' }, body: '{"who":"old"}' },
            { status: 200, headers: { etag: 'W/"e2"' }, body: '{"who":"new"}' },
        ]);
        const fetch = createHttpGetJsonWithMeta();

        await fetch(URL_1, {}, store);
        generation = 1;
        const response = await fetch(URL_1, {}, store);

        expect(sent[1].headers["If-None-Match"]).toBeUndefined();
        expect(response.body).toEqual({ who: "new" });
    });

    it("a body read under an old auth generation is never offered under the new one", async () => {
        let generation = 0;
        const store = new EtagStore(() => generation);
        const replies: Reply[] = [
            { status: 200, headers: { etag: 'W/"e1"' }, body: '{"who":"old"}' },
            { status: 200, headers: { etag: 'W/"e2"' }, body: '{"who":"new"}' },
        ];
        const sent = stubSequence(replies);
        // The sign-in changes while the first request is on the wire.
        vi.mocked(https.get).mockImplementationOnce(((
            url: string,
            options: { headers: Record<string, string> },
            cb: (r: unknown) => void,
        ) => {
            sent.push({ url, headers: { ...options.headers } });
            generation = 1;
            return respond(replies.shift() as Reply, cb);
        }) as unknown as typeof https.get);
        const fetch = createHttpGetJsonWithMeta();

        await fetch(URL_1, {}, store);
        await fetch(URL_1, {}, store);

        expect(sent[1].headers["If-None-Match"]).toBeUndefined();
    });

    it("multi-page 200 then header-minimal 304 → coverage unchanged", async () => {
        const store = new EtagStore(() => 0);
        const sent = stubSequence([
            {
                status: 200,
                headers: { etag: 'W/"p1"', link: `<${URL_2}>; rel="next"` },
                body: '{"items":[1,2]}',
            },
            { status: 200, headers: { etag: 'W/"p2"' }, body: '{"items":[3]}' },
            { status: 304, headers: { "x-ratelimit-remaining": "4998" } },
            { status: 304, headers: { "x-ratelimit-remaining": "4997" } },
        ]);
        const observed: HttpResponseMetadata[] = [];
        const fetch = createHttpGetJsonWithMeta((metadata) => observed.push(metadata));
        const read = () =>
            paginate(
                (url) => fetch(url, {}, store),
                URL_1,
                linkHeaderNext,
                (body) => (body as { items: number[] }).items,
                10,
                () => true,
            );

        const first = await read();
        const second = await read();

        expect(first).toEqual({ items: [1, 2, 3], coverage: "full" });
        expect(second, "the 304 for page 1 keeps its stored next link").toEqual(first);
        expect(sent.map((request) => request.url)).toEqual([URL_1, URL_2, URL_1, URL_2]);
        expect(
            observed.slice(2).map((metadata) => metadata.headers["x-ratelimit-remaining"]),
            "quota comes from the fresh 304s",
        ).toEqual(["4998", "4997"]);
    });

    it("keeps the 500 most recently used entries", () => {
        const store = new EtagStore(() => 0);
        const entry = (n: number) => ({
            etag: `"${n}"`,
            body: "{}",
            pagination: {},
            requestHash: "",
        });
        for (let n = 0; n < 500; n += 1) store.set(store.keyFor(`u${n}`), entry(n));
        expect(store.get(store.keyFor("u0")), "u0 is now the most recent").toBeDefined();

        store.set(store.keyFor("u500"), entry(500));

        expect(store.get(store.keyFor("u1")), "the least recent entry is evicted").toBeUndefined();
        expect(store.get(store.keyFor("u0"))).toBeDefined();
        expect(store.get(store.keyFor("u500"))).toBeDefined();
    });
});

const SHA = "a".repeat(40);
const GITHUB = "https://api.github.com/repos/o/r";
const githubRef = { host: "github.com", owner: "o", repo: "r" } as ProviderRepoRef;
const GITLAB = "https://gitlab.com/api/v4/projects/group%2Fapp";
const gitlabRef = { host: "gitlab.com", owner: "group", repo: "app" } as ProviderRepoRef;

function providers(generations = new CiGenerations(), token = () => "glpat-token") {
    const store = { get: async () => token() } as unknown as CredentialStore;
    const all = createCommitChecksProviders(
        new CommitChecksRequestGateRegistry("cooling down"),
        store,
        undefined,
        generations,
    );
    return {
        github: all.find((provider) => provider instanceof GitHubProvider) as GitHubProvider,
        gitlab: all.find((provider) => provider instanceof GitLabProvider) as GitLabProvider,
        byId: (id: string) => all.find((provider) => provider.id === id) as CommitChecksProvider,
    };
}

function checkRun(id: number, status: string, conclusion: string | null = null) {
    return { id, name: `build ${id}`, status, conclusion };
}

/** GitHub's snapshot endpoints over `checkRuns`, paged by 100 with `total_count`. */
function githubSnapshotRoute(checkRuns: readonly unknown[]) {
    return (url: string) => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page") ?? "1");
        if (parsed.pathname.endsWith("/check-runs")) {
            return {
                body: {
                    total_count: checkRuns.length,
                    check_runs: checkRuns.slice((page - 1) * 100, page * 100),
                },
            };
        }
        if (parsed.pathname.endsWith("/status")) return { body: { statuses: [] } };
        throw new Error(`unrouted ${url}`);
    };
}

describe("providers use the store only for requests about incomplete commits", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a running GitHub commit's later polls are conditional and keep their checks", async () => {
        const sent = stubServer(githubSnapshotRoute([checkRun(1, "in_progress")]));
        const { github } = providers();

        const first = await github.getChecks(githubRef, SHA);
        await github.getChecks(githubRef, SHA);
        const before = sent.length;
        const third = await github.getChecks(githubRef, SHA);

        expect(first.state).toBe("pending");
        expect(conditionalOf(sent.slice(0, before)), "an unknown commit is asked plainly").toEqual(
            [],
        );
        expect(
            conditionalOf(sent.slice(before)).map((request) => request.url),
            "both snapshot requests of the still-running commit are conditional",
        ).toEqual([
            `${GITHUB}/commits/${SHA}/check-runs?per_page=100&filter=latest&page=1`,
            `${GITHUB}/commits/${SHA}/status?per_page=100&page=1`,
        ]);
        expect(third).toEqual(first);
    });

    it("complete requests do not use the store", async () => {
        const sent = stubServer(githubSnapshotRoute([checkRun(1, "completed", "success")]));
        const { github } = providers();

        for (let poll = 0; poll < 3; poll += 1) await github.getChecks(githubRef, SHA);

        expect(conditionalOf(sent)).toEqual([]);
    });

    it("a commit that finishes stops using the store", async () => {
        let status = "in_progress";
        const sent = stubServer((url) =>
            githubSnapshotRoute([checkRun(1, status, status === "completed" ? "success" : null)])(
                url,
            ),
        );
        const { github } = providers();
        await github.getChecks(githubRef, SHA);
        await github.getChecks(githubRef, SHA);
        status = "completed";
        await github.getChecks(githubRef, SHA);
        const before = sent.length;

        await github.getChecks(githubRef, SHA);

        expect(conditionalOf(sent.slice(before))).toEqual([]);
    });

    it("multi-page check runs polled with 304s are never counted twice", async () => {
        const runs = Array.from({ length: 150 }, (_, i) => checkRun(i + 1, "in_progress"));
        const sent = stubServer(githubSnapshotRoute(runs));
        const { github } = providers();

        for (let poll = 0; poll < 3; poll += 1) await github.getChecks(githubRef, SHA);
        const before = sent.length;
        const polled = await github.getChecks(githubRef, SHA);

        expect(conditionalOf(sent.slice(before))).toHaveLength(3);
        expect(polled.items).toHaveLength(150);
    });

    it("a sign-in change makes the next poll unconditional", async () => {
        const generations = new CiGenerations();
        const sent = stubServer(githubSnapshotRoute([checkRun(1, "queued")]));
        const { github } = providers(generations);
        for (let poll = 0; poll < 3; poll += 1) await github.getChecks(githubRef, SHA);
        expect(conditionalOf(sent)).not.toEqual([]);
        const before = sent.length;

        generations.bumpAuth();
        await github.getChecks(githubRef, SHA);

        expect(conditionalOf(sent.slice(before))).toEqual([]);
    });

    it("a running GitHub detail's later reads are conditional, a settled one's are not", async () => {
        let state = { status: "in_progress", conclusion: null as string | null };
        const job = () => ({
            id: 11,
            name: "build",
            status: state.status,
            conclusion: state.conclusion,
            run_attempt: 1,
            check_run_url: `${GITHUB}/check-runs/11`,
        });
        const workflowRun = () => ({
            id: 7,
            name: "CI",
            status: state.status,
            conclusion: state.conclusion,
            run_attempt: 1,
            check_suite_id: 3,
            repository: { id: 99 },
        });
        const sent = stubServer((url) => {
            const path = new URL(url).pathname;
            if (path.endsWith("/actions/runs")) return { body: { workflow_runs: [workflowRun()] } };
            if (path.endsWith("/actions/runs/7/jobs")) return { body: { jobs: [job()] } };
            if (path.endsWith("/actions/runs/7")) return { body: workflowRun() };
            if (path.endsWith("/check-suites")) return { body: { total_count: 1 } };
            return githubSnapshotRoute([checkRun(11, state.status, state.conclusion)])(url);
        });
        const { github } = providers();

        const first = await github.getDetail(githubRef, SHA);
        await github.getDetail(githubRef, SHA);
        const before = sent.length;
        await github.getDetail(githubRef, SHA);

        expect(first.complete).toBe(false);
        expect(conditionalOf(sent.slice(before)).map((request) => request.url)).toEqual(
            sent.slice(before).map((request) => request.url),
        );

        state = { status: "completed", conclusion: "success" };
        await github.getDetail(githubRef, SHA);
        const settled = sent.length;
        await github.getDetail(githubRef, SHA);
        expect(conditionalOf(sent.slice(settled))).toEqual([]);
    });

    it("a running GitLab commit's later polls and detail reads are conditional", async () => {
        const sent = stubServer((url) => {
            const path = new URL(url).pathname;
            if (path.endsWith("/statuses")) {
                return { body: [{ id: 5, name: "build", status: "running" }] };
            }
            if (path.endsWith("/pipelines")) {
                return { body: [{ id: 7, status: "running", updated_at: "t1" }] };
            }
            if (path.endsWith("/pipelines/7/jobs")) {
                return { body: [{ id: 5, name: "build", status: "running", stage: "test" }] };
            }
            if (path.endsWith("/pipelines/7")) {
                return { body: { id: 7, status: "running", updated_at: "t1", name: "CI" } };
            }
            throw new Error(`unrouted ${url}`);
        });
        const { gitlab } = providers();

        for (let poll = 0; poll < 2; poll += 1) await gitlab.getChecks(gitlabRef, SHA);
        const checks = sent.length;
        const polled = await gitlab.getChecks(gitlabRef, SHA);
        for (let read = 0; read < 2; read += 1) await gitlab.getDetail(gitlabRef, SHA);
        const details = sent.length;
        const detail = await gitlab.getDetail(gitlabRef, SHA);

        expect(polled.state).toBe("pending");
        expect(conditionalOf(sent.slice(checks, checks + 1)).map((r) => r.url)).toEqual([
            `${GITLAB}/repository/commits/${SHA}/statuses?per_page=100`,
        ]);
        expect(detail.complete).toBe(false);
        expect(conditionalOf(sent.slice(details)).map((request) => request.url)).toEqual(
            sent.slice(details).map((request) => request.url),
        );
    });

    it("a GitLab token changed by another window makes this window's next poll unconditional", async () => {
        let token = "first";
        const sent = stubServer(() => ({ body: [{ id: 5, name: "build", status: "running" }] }));
        const { gitlab } = providers(new CiGenerations(), () => token);
        for (let poll = 0; poll < 3; poll += 1) await gitlab.getChecks(gitlabRef, SHA);
        expect(conditionalOf(sent)).not.toEqual([]);
        const before = sent.length;

        // Another window saved a new token; this window's auth generation never moved.
        token = "changed-by-another-window";
        await gitlab.getChecks(gitlabRef, SHA);

        expect(conditionalOf(sent.slice(before))).toEqual([]);
    });

    it.each([
        ["bitbucket-cloud", { host: "bitbucket.org", workspace: "w", repo: "r" }],
        ["bitbucket-server", { host: "bitbucket.example.com", project: "p", repo: "r" }],
    ])(
        "a running %s commit's later polls are conditional, a settled one's are not",
        async (id, ref) => {
            let state = "INPROGRESS";
            const sent = stubServer(() => ({
                body: { values: [{ key: "build", name: "build", state }], isLastPage: true },
            }));
            const provider = providers().byId(id);
            const bitbucketRef = ref as unknown as ProviderRepoRef;

            for (let poll = 0; poll < 2; poll += 1) await provider.getChecks(bitbucketRef, SHA);
            const before = sent.length;
            const polled = await provider.getChecks(bitbucketRef, SHA);

            expect(polled.state).toBe("pending");
            expect(conditionalOf(sent.slice(before)).map((request) => request.url)).toEqual(
                sent.slice(before).map((request) => request.url),
            );

            state = "SUCCESSFUL";
            await provider.getChecks(bitbucketRef, SHA);
            const settled = sent.length;
            await provider.getChecks(bitbucketRef, SHA);
            expect(conditionalOf(sent.slice(settled))).toEqual([]);
        },
    );
});
