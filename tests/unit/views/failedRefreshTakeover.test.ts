// Repro (local only, never pushed): after a failed forced Refresh the Checks tab stops
// re-reading, and once a second view asks for the same commit the scan's pages go to that view
// only, so the first view keeps a scan state that is no longer true.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CiActionFenceStore } from "../../../src/services/commitChecks/ciActionFence";
import {
    CiGenerations,
    type CiOperationContext,
} from "../../../src/services/commitChecks/ciGenerations";
import {
    CommitCiDetailService,
    type CommitCiDetailServiceOptions,
} from "../../../src/services/commitChecks/detailService";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { PENDING_CHECK_RETRY_DELAYS_MS } from "../../../src/shared/ci/pollSchedule";
import type { CommitCiDetail } from "../../../src/types";
import {
    answerCommitCiDetailRequest,
    CommitCiDetailLoops,
} from "../../../src/views/ciDetailHandler";

vi.mock("vscode", () => ({}));

const HASH = "a".repeat(40);

const running: CommitCiDetail = {
    hash: HASH,
    provider: "github",
    complete: false,
    outcome: "failure",
    runs: [
        {
            id: "1",
            name: "CI",
            state: "failure",
            jobs: [],
            jobsCoverage: { reason: "pageBound", shown: 1000 },
            failedScan: { state: "running", found: 0 },
        },
    ],
    runsCoverage: "full",
    otherChecks: [],
    otherChecksCoverage: "full",
    capabilities: NO_CI_CAPABILITIES,
    repoKey: "/repo",
};

beforeEach(() => setE2eControlChannelActive(true));
afterEach(() => setE2eControlChannelActive(false));

describe("failed Refresh, then another view takes the scan", () => {
    it("the first view does not stay on a stale scan state", async () => {
        const service = new CommitCiDetailService({ now: () => Date.now() });
        const serve = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };
        let releaseLastPage!: () => void;
        const lastPage = new Promise<void>((resolve) => (releaseLastPage = resolve));
        let fetches = 0;
        const fetchDetail = async () => {
            fetches += 1;
            if (fetches === 1) {
                return {
                    ...running,
                    scanCursors: [{ runId: "1", runAttempt: 1, runName: "CI", url: "page-11" }],
                } as never;
            }
            return { ...running, outcome: "unavailable", error: "HTTP 502" } as never;
        };
        const source = {
            repoKey: () => "/repo",
            generations: new CiGenerations(),
            getDetail: (
                _hash: string,
                options: { force?: boolean },
                _ctx: unknown,
                onScanUpdate?: (update: CommitCiDetail) => void,
            ) =>
                service.getOrFetch("snapshot#detail", fetchDetail, serve, options, undefined, {
                    continueScan: async () => {
                        await lastPage;
                        return { failed: [] };
                    },
                    isCurrent: () => true,
                    onUpdate: (update) => onScanUpdate?.(update),
                } as never),
        };
        const request = (requestId: number, force?: boolean) => ({
            type: "requestCommitCiDetail",
            requestId,
            repoKey: "/repo",
            hash: HASH,
            ...(force && { force }),
        });

        // First view: opens the tab, then its Refresh fails.
        const firstLoops = new CommitCiDetailLoops();
        const firstPost = vi.fn();
        const opened = answerCommitCiDetailRequest(
            source as never,
            request(1),
            firstPost,
            firstLoops,
        );
        await vi.waitFor(() => expect(firstPost).toHaveBeenCalled());
        await answerCommitCiDetailRequest(source as never, request(2, true), firstPost, firstLoops);
        await opened;
        expect(firstPost.mock.calls.at(-1)?.[0].detail.refreshError, "setup").toBe("HTTP 502");

        // Second view asks for the same commit and takes the scan's pages over.
        const secondLoops = new CommitCiDetailLoops();
        const secondPost = vi.fn();
        const second = answerCommitCiDetailRequest(
            source as never,
            request(3),
            secondPost,
            secondLoops,
        );
        await vi.waitFor(() => expect(secondPost).toHaveBeenCalled());
        releaseLastPage();
        await vi.waitFor(() =>
            expect(secondPost.mock.calls.at(-1)?.[0].detail.runs[0].failedScan.state).toBe("done"),
        );
        secondLoops.dispose();
        firstLoops.dispose();
        await second;

        expect(
            firstPost.mock.calls.at(-1)?.[0].detail.runs[0].failedScan.state,
            "the first view must not keep a scan state that is no longer true",
        ).toBe("done");
    });

    it("the first view learns a paused page and then the final page", async () => {
        vi.useFakeTimers();
        try {
            const service = new CommitCiDetailService({ now: () => Date.now() });
            const serve = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };
            const cursor = { runId: "1", runAttempt: 1, runName: "CI", url: "page-11" };
            let releasePausedPage!: () => void;
            const pausedPage = new Promise<void>((resolve) => (releasePausedPage = resolve));
            let fetches = 0;
            let pages = 0;
            const fetchDetail = async () => {
                fetches += 1;
                if (fetches === 1) return { ...running, scanCursors: [cursor] } as never;
                return { ...running, outcome: "unavailable", error: "HTTP 502" } as never;
            };
            const source = {
                repoKey: () => "/repo",
                generations: new CiGenerations(),
                getDetail: (
                    _hash: string,
                    options: { force?: boolean },
                    _ctx: unknown,
                    onScanUpdate?: (update: CommitCiDetail) => void,
                ) =>
                    service.getOrFetch("snapshot#detail", fetchDetail, serve, options, undefined, {
                        continueScan: async () => {
                            pages += 1;
                            if (pages > 1) return { failed: [] };
                            await pausedPage;
                            // The request gate's cooldown: the scan pauses for a second.
                            return {
                                pausedUntil: Date.now() + 1_000,
                                next: { ...cursor, url: "page-12" },
                            };
                        },
                        isCurrent: () => true,
                        onUpdate: (update) => onScanUpdate?.(update),
                    } as never),
            };
            const request = (requestId: number, force?: boolean) => ({
                type: "requestCommitCiDetail",
                requestId,
                repoKey: "/repo",
                hash: HASH,
                ...(force && { force }),
            });

            const firstLoops = new CommitCiDetailLoops();
            const firstPost = vi.fn();
            const opened = answerCommitCiDetailRequest(
                source as never,
                request(1),
                firstPost,
                firstLoops,
            );
            await vi.advanceTimersByTimeAsync(0);
            await answerCommitCiDetailRequest(
                source as never,
                request(2, true),
                firstPost,
                firstLoops,
            );
            await opened;
            expect(firstPost.mock.calls.at(-1)?.[0].detail.refreshError, "setup").toBe("HTTP 502");

            const secondLoops = new CommitCiDetailLoops();
            const secondPost = vi.fn();
            const second = answerCommitCiDetailRequest(
                source as never,
                request(3),
                secondPost,
                secondLoops,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(secondPost, "setup: the second view is shown").toHaveBeenCalled();

            releasePausedPage();
            await vi.advanceTimersByTimeAsync(0);
            expect(
                firstPost.mock.calls.at(-1)?.[0].detail.runs[0].failedScan.state,
                "the first view learns the pause",
            ).toBe("paused");
            await vi.advanceTimersByTimeAsync(1_000);
            const last = firstPost.mock.calls.at(-1)?.[0].detail;
            secondLoops.dispose();
            firstLoops.dispose();
            await vi.advanceTimersByTimeAsync(0);
            await second;

            expect(
                last.runs[0].failedScan.state,
                "the first view learns the final page after the pause",
            ).toBe("done");
            expect(last.refreshError, "the failed Refresh's error stays shown").toBe("HTTP 502");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("failed Refresh during a running scan: fix round 1", () => {
    const KEY = "snapshot#detail";
    const serve = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };
    const cursor = { runId: "1", runAttempt: 1, runName: "CI", url: "page-11" };
    const terminal = { failed: [] };
    const loops: CommitCiDetailLoops[] = [];

    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((done) => (resolve = done));
        return { resolve, promise };
    }

    function fetched(attempt = 1, overflow = true) {
        return {
            hash: HASH,
            provider: "github" as const,
            outcome: "failure" as const,
            complete: !overflow,
            runsCoverage: "full" as const,
            otherChecksCoverage: "full" as const,
            otherChecks: [],
            runs: [
                {
                    id: "1",
                    name: "CI",
                    state: "failure" as const,
                    attempt,
                    jobs: [],
                    jobsCoverage: overflow
                        ? { reason: "pageBound" as const, shown: 1000 }
                        : ("full" as const),
                },
            ],
            ...(overflow && { scanCursors: [{ ...cursor, runAttempt: attempt }] }),
        };
    }

    function failed(error = "HTTP 502") {
        return {
            ...fetched(),
            outcome: "unavailable" as const,
            runs: [],
            error,
            signInHost: "github.com",
        };
    }

    function fixture(options: CommitCiDetailServiceOptions = {}, fences?: CiActionFenceStore) {
        const service = new CommitCiDetailService({ ...options, fences });
        const generations = new CiGenerations();
        const fetch = vi.fn(
            async (): Promise<ReturnType<typeof fetched> | ReturnType<typeof failed>> => fetched(),
        );
        const page = vi.fn(async (_cursor: typeof cursor): Promise<object> => terminal);
        const deliver = vi.fn();
        // Lets a test hold a fan-out callback back, to see what a late callback does.
        let publish = (emit: () => void, _data: CommitCiDetail) => emit();
        const read = (
            _hash: string,
            options: { force?: boolean },
            ctx: CiOperationContext,
            update?: (data: CommitCiDetail) => void,
        ) =>
            service.getOrFetch(KEY, fetch, serve, options, undefined, {
                continueScan: page,
                isCurrent: () => generations.isCurrent(ctx, "/repo"),
                onUpdate: (data: CommitCiDetail) => {
                    deliver(update, data);
                    publish(() => update?.(data), data);
                },
            } as never);
        const source = {
            generations,
            repoKey: () => "/repo",
            getDetail: read,
            ...(fences && {
                actions: {
                    fences,
                    run: vi.fn(),
                    refresh: (h: string, ctx: CiOperationContext, update?: never) =>
                        read(h, { force: true }, ctx, update),
                },
            }),
        };
        // Reads the service's private list of failed-Refresh hooks, for the cleanup paths
        // (eviction, clear, invalidate, a closed request) that no public behaviour shows.
        const retained = () =>
            (service as unknown as { failedRefreshHooks: Map<string, unknown[]> })
                .failedRefreshHooks;
        return {
            source: source as never,
            getDetail: source,
            service,
            generations,
            fetch,
            deliver,
            interceptDelivery: (next: typeof publish) => {
                publish = next;
            },
            page,
            retained,
            read: vi.spyOn(source, "getDetail"),
        };
    }

    function view(source: never) {
        const requests = new CommitCiDetailLoops();
        loops.push(requests);
        const post = vi.fn();
        let id = 0;
        return {
            post,
            last: () => post.mock.calls.at(-1)?.[0]?.detail as CommitCiDetail | undefined,
            ask: (force = false) =>
                answerCommitCiDetailRequest(
                    source,
                    { requestId: ++id, repoKey: "/repo", hash: HASH, force },
                    post,
                    requests,
                ),
            hide: () => requests.cancel(id),
            close: () => requests.dispose(),
        };
    }

    const settle = () => vi.advanceTimersByTimeAsync(0);
    const state = (v: ReturnType<typeof view>) => v.last()?.runs[0]?.failedScan?.state;

    async function openAndFail(f: ReturnType<typeof fixture>) {
        const a = view(f.source);
        void a.ask();
        await settle();
        expect(state(a), "initial scan").toBe("running");
        f.fetch.mockResolvedValueOnce(failed());
        await a.ask(true);
        expect(a.last()?.refreshError, "initial failed Refresh").toBe("HTTP 502");
        return a;
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(async () => {
        for (const loop of loops.splice(0)) loop.dispose();
        await settle();
        vi.useRealTimers();
    });

    it("F1: a late failed reply dropped for newer data never starts a re-read ladder", async () => {
        const f = fixture({ ttlMs: 1000 });
        const inFlightPage = deferred<object>();
        const failureCaptured = deferred<void>();
        const releaseFailure = deferred<void>();
        f.page.mockReturnValueOnce(inFlightPage.promise).mockReturnValue(new Promise(() => {}));
        const underlyingRead = f.getDetail.getDetail.bind(f.getDetail);
        f.getDetail.getDetail = async (...args) => {
            const reply = await underlyingRead(...args);
            if (reply?.refreshError) {
                failureCaptured.resolve();
                await releaseFailure.promise;
            }
            return reply;
        };
        const a = view(f.source);
        void a.ask();
        await settle();
        f.fetch.mockResolvedValueOnce(failed());
        void a.ask(true);
        await failureCaptured.promise;
        const b = view(f.source);
        f.fetch.mockResolvedValueOnce(fetched());
        void b.ask(true);
        await settle();
        inFlightPage.resolve({ failed: [], next: { ...cursor, url: "page-12" } });
        await settle();
        expect(state(a), "setup: the Refresh request gets the newer scan page").toBe("running");
        expect(f.fetch, "setup: the open and two presses").toHaveBeenCalledTimes(3);
        // The second view's own ladder is not under test: only the Refresh request's is.
        b.close();
        releaseFailure.resolve();
        await settle();
        expect(a.last()?.refreshError, "the newer data never shows the late error").toBeUndefined();
        const reads = f.read.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.read, "no ladder read after the failed Refresh").toHaveBeenCalledTimes(reads);
        expect(f.fetch, "no provider detail fetch after the failed Refresh").toHaveBeenCalledTimes(
            3,
        );
        expect(a.last()?.refreshError, "the last post carries no error").toBeUndefined();
    });

    it("F2: a terminal page landing while the failed reply settles reaches the first view", async () => {
        const f = fixture();
        const pending = deferred<object>();
        const failure = deferred<ReturnType<typeof failed>>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = view(f.source);
        void a.ask();
        await settle();
        f.fetch.mockReturnValueOnce(failure.promise);
        const refresh = a.ask(true);
        await settle();
        const b = view(f.source);
        void b.ask();
        await settle();
        failure.resolve(failed());
        pending.resolve(terminal);
        await refresh;
        await settle();
        expect(state(b), "setup: the newest requester saw the terminal page").toBe("done");
        expect(a.last()?.refreshError, "the first view keeps its Refresh error").toBe("HTTP 502");
        expect(state(a), "the first view shows the terminal page").toBe("done");
    });

    it("F3: a newer attempt without overflow retires the first view's running scan", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        const b = view(f.source);
        f.fetch.mockResolvedValueOnce(fetched(2, false));
        await b.ask(true);
        pending.resolve({ runChanged: true, error: "new attempt" });
        await settle();
        expect(b.last()?.runs[0].attempt, "setup: the second view shows attempt 2").toBe(2);
        expect(["running", "paused"], "the first view shows no live scan").not.toContain(state(a));
        expect(a.last()?.runs[0].attempt, "the first view shows attempt 2").toBe(2);
    });

    it("F4: an evicted key releases its failed-Refresh hooks", async () => {
        const f = fixture({ maxEntries: 1 });
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        await openAndFail(f);
        expect(f.retained().has(KEY), "setup: the failed Refresh is listed").toBe(true);
        await f.service.getOrFetch("other", async () => fetched(2, false), serve, {});
        expect(f.retained().has(KEY), "eviction releases the key's hooks").toBe(false);
        pending.resolve(terminal);
        await settle();
    });

    it("F4: a new failed Refresh drops listed hooks that are no longer current", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        await openAndFail(f);
        f.generations.bumpAuth();
        const b = view(f.source);
        f.fetch.mockResolvedValueOnce(failed("HTTP 503"));
        await b.ask(true);
        expect(f.retained().get(KEY), "only the live request stays listed").toHaveLength(1);
        pending.resolve(terminal);
        await settle();
    });

    it("F5: a fence-end re-read and the listed Refresh hooks post one page once", async () => {
        const fences = new CiActionFenceStore(
            { get: () => undefined, keys: () => [], update: async () => {} },
            () => Date.now(),
        );
        try {
            const f = fixture({}, fences);
            const oldPage = deferred<object>();
            const newPage = deferred<object>();
            f.page.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise);
            const a = await openAndFail(f);
            await fences.begin({
                repoKey: "/repo",
                hash: HASH,
                provider: "github",
                action: "rerunFailed",
                targetId: "1",
                runId: "1",
                before: { attempt: 1, state: "failure" },
                evidence: "runAttempt",
            });
            const b = view(f.source);
            f.fetch.mockResolvedValueOnce(fetched(2));
            void b.ask(true);
            await settle();
            expect(a.last()?.runs[0].attempt, "setup: the fence-end re-read shows attempt 2").toBe(
                2,
            );
            const before = a.post.mock.calls.length;
            oldPage.resolve(terminal);
            await settle();
            expect(a.post, "setup: the old attempt's page is dropped").toHaveBeenCalledTimes(
                before,
            );
            newPage.resolve(terminal);
            await settle();
            expect(state(a), "the new attempt's page reached the view").toBe("done");
            expect(a.post, "one post for the single new page").toHaveBeenCalledTimes(before + 1);
        } finally {
            fences.dispose();
        }
    });

    it("F7 M7: a failed Refresh while the scan is paused still gets the resumed final page", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = view(f.source);
        void a.ask();
        await settle();
        pending.resolve({ pausedUntil: Date.now() + 1000, next: cursor });
        await settle();
        expect(state(a), "setup: paused before the Refresh").toBe("paused");
        f.fetch.mockResolvedValueOnce(failed());
        await a.ask(true);
        const b = view(f.source);
        void b.ask();
        await settle();
        await vi.advanceTimersByTimeAsync(1000);
        expect(state(a), "the Refresh that failed while paused gets the final page").toBe("done");
        expect(a.last()?.refreshError).toBe("HTTP 502");
    });

    it("F7 M8: the newest requester, itself listed, gets one page once", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        const b = view(f.source);
        f.fetch.mockResolvedValueOnce(failed("HTTP 503"));
        await b.ask(true);
        const posts = [a, b].map((each) => each.post.mock.calls.length);
        f.deliver.mockClear();
        pending.resolve(terminal);
        await settle();
        expect(f.deliver, "one hook call per requester").toHaveBeenCalledTimes(2);
        expect(a.post, "the first view posts the page once").toHaveBeenCalledTimes(posts[0] + 1);
        expect(b.post, "the newest view posts the page once").toHaveBeenCalledTimes(posts[1] + 1);
    });

    it("F7 M9: a listed request that is no longer current gets no page", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        await openAndFail(f);
        const b = view(f.source);
        f.fetch.mockResolvedValueOnce(failed("HTTP 503"));
        await b.ask(true);
        expect(f.retained().get(KEY), "setup: both failed Refreshes are listed").toHaveLength(2);
        // Both listed requests go stale after they were listed; only the newest read is current.
        f.generations.bumpAuth();
        const c = view(f.source);
        void c.ask();
        await settle();
        pending.resolve(terminal);
        await settle();
        expect(f.deliver, "one hook call, none for the stale listed hooks").toHaveBeenCalledTimes(
            1,
        );
    });

    it("F7 M10: clear() releases the failed-Refresh hooks", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        const posts = a.post.mock.calls.length;
        f.generations.bumpAuth();
        f.service.clear();
        pending.resolve(terminal);
        await settle();
        expect(a.post, "a late page of the old account is not posted").toHaveBeenCalledTimes(posts);
        expect(f.retained().size, "clear releases the hooks").toBe(0);
    });

    it("F7 M11: invalidate() releases the failed-Refresh hooks", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        await openAndFail(f);
        await f.service.invalidate(KEY);
        expect(f.retained().has(KEY), "invalidation releases the key").toBe(false);
        pending.resolve(terminal);
        await settle();
    });

    it("F7 M12: a posted detail carries no internal symbol key", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        const b = view(f.source);
        void b.ask();
        await settle();
        pending.resolve(terminal);
        await settle();
        expect(state(a), "setup: the page reached the first view").toBe("done");
        for (const call of a.post.mock.calls) {
            const posted = call[0].detail as object;
            expect(Object.getOwnPropertySymbols(posted), "symbol keys on a posted detail").toEqual(
                [],
            );
        }
    });

    it("G1: a newest read without a page callback still fans out and cleans up", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        // An action or log read: it takes the scan hooks but has no onUpdate.
        await f.service.getOrFetch(KEY, f.fetch, serve, {}, undefined, {
            continueScan: f.page,
            isCurrent: () => true,
        } as never);
        pending.resolve(terminal);
        await settle();
        expect(state(a), "the failed Refresh sees the terminal page").toBe("done");
        expect(f.retained().has(KEY), "the terminal page releases the hooks").toBe(false);
        expect(f.fetch, "the read hit L1 and the page made no extra fetch").toHaveBeenCalledTimes(
            2,
        );
    });

    it.each(["clear", "invalidate"] as const)(
        "G2: %s between building a failed reply and listing it keeps the key released",
        async (operation) => {
            const ref: { f?: ReturnType<typeof fixture> } = {};
            const f = fixture({
                trace: (event) => {
                    if (event.kind !== "detail" || event.outcome !== "failed") return;
                    queueMicrotask(() => {
                        ref.f?.generations.bumpAuth();
                        if (operation === "clear") ref.f?.service.clear();
                        else void ref.f?.service.invalidate(KEY);
                    });
                },
            });
            ref.f = f;
            const pending = deferred<object>();
            f.page.mockReturnValueOnce(pending.promise);
            const a = view(f.source);
            void a.ask();
            await settle();
            f.fetch.mockResolvedValueOnce(failed());
            await a.ask(true);
            pending.resolve(terminal);
            await settle();
            expect(a.last()?.refreshError, "the old request was dropped").toBeUndefined();
            expect(f.retained().has(KEY), "a late failed reply cannot list a cleared key").toBe(
                false,
            );
        },
    );

    it("G3: two listed failed views re-reading on one fence end post the replacement once each", async () => {
        const fences = new CiActionFenceStore(
            { get: () => undefined, keys: () => [], update: async () => {} },
            () => Date.now(),
        );
        try {
            const f = fixture({}, fences);
            const p1 = deferred<object>();
            const p2 = deferred<object>();
            f.page.mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise);
            const a = await openAndFail(f);
            const b = view(f.source);
            f.fetch.mockResolvedValueOnce(failed("HTTP 503"));
            await b.ask(true);
            await fences.begin({
                repoKey: "/repo",
                hash: HASH,
                provider: "github",
                action: "rerunFailed",
                targetId: "1",
                runId: "1",
                before: { attempt: 1, state: "failure" },
                evidence: "runAttempt",
            });
            const c = view(f.source);
            f.fetch.mockResolvedValueOnce(fetched(2));
            void c.ask(true);
            await settle();
            const attempt2Posts = (v: typeof a) =>
                v.post.mock.calls.filter(([msg]) => msg.detail?.runs[0]?.attempt === 2).length;
            expect(attempt2Posts(a), "the first failed view shows the replacement once").toBe(1);
            expect(attempt2Posts(b), "the second failed view shows the replacement once").toBe(1);
        } finally {
            fences.dispose();
        }
    });

    it("a running ladder stops when its read joins another view's failed Refresh", async () => {
        const f = fixture({ ttlMs: 1 });
        const pendingPage = deferred<object>();
        const pendingRefresh = deferred<ReturnType<typeof failed>>();
        f.page.mockReturnValueOnce(pendingPage.promise);
        const a = view(f.source);
        void a.ask();
        await settle();
        expect(state(a), "setup: the first view's scan is running").toBe("running");
        const b = view(f.source);
        f.fetch.mockReturnValueOnce(pendingRefresh.promise);
        const forced = b.ask(true);
        await vi.advanceTimersByTimeAsync(PENDING_CHECK_RETRY_DELAYS_MS[0]);
        expect(f.fetch, "setup: the open and the forced Refresh fetched").toHaveBeenCalledTimes(2);
        expect(f.read, "setup: both views and the ladder's first read").toHaveBeenCalledTimes(3);
        pendingRefresh.resolve(failed());
        await forced;
        await settle();
        expect(a.last()?.refreshError, "the ladder joined the failed forced Refresh").toBe(
            "HTTP 502",
        );
        await vi.advanceTimersByTimeAsync(PENDING_CHECK_RETRY_DELAYS_MS[1]);
        expect(
            f.read,
            "a ladder that already started does not read again after a failed Refresh",
        ).toHaveBeenCalledTimes(3);
        expect(
            f.fetch,
            "the already-started ladder made no extra provider fetch",
        ).toHaveBeenCalledTimes(2);
    });

    it("a shared replacement appears once when the callback trails the joined reply", async () => {
        const fences = new CiActionFenceStore(
            { get: () => undefined, keys: () => [], update: async () => {} },
            () => Date.now(),
        );
        try {
            const f = fixture({}, fences);
            f.page.mockReturnValue(new Promise(() => {}));
            const a = await openAndFail(f);
            const b = view(f.source);
            f.fetch.mockResolvedValueOnce(failed("HTTP 503"));
            await b.ask(true);
            // Hold back the fan-out callbacks that carry the replacement (attempt 2).
            const queued: Array<() => void> = [];
            f.interceptDelivery((emit, data) => {
                if (data.runs[0]?.attempt === 2) queued.push(emit);
                else emit();
            });
            await fences.begin({
                repoKey: "/repo",
                hash: HASH,
                provider: "github",
                action: "rerunFailed",
                targetId: "1",
                runId: "1",
                before: { attempt: 1, state: "failure" },
                evidence: "runAttempt",
            });
            const c = view(f.source);
            f.fetch.mockResolvedValueOnce(fetched(2));
            void c.ask(true);
            await settle();
            expect(queued, "setup: one held callback per failed view").toHaveLength(2);
            const attempt2Posts = (v: typeof a) =>
                v.post.mock.calls.filter(([msg]) => msg.detail?.runs[0]?.attempt === 2).length;
            expect(
                [a, b, c].map(attempt2Posts),
                "all three joined replies arrived before the two callbacks",
            ).toEqual([1, 1, 1]);
            for (const emit of queued) emit();
            await settle();
            expect(
                [a, b, c].map(attempt2Posts),
                "a late fan-out callback cannot repost the joined reply",
            ).toEqual([1, 1, 1]);
        } finally {
            fences.dispose();
        }
    });

    it("P3: another view's failed normal read never blanks a failed Refresh's tree", async () => {
        const f = fixture({ ttlMs: 1000 });
        f.page.mockReturnValueOnce(new Promise(() => {}));
        const a = await openAndFail(f);
        expect(state(a), "setup: A is on a running scan").toBe("running");
        vi.setSystemTime(Date.now() + 5_000); // past the entry's TTL, so B reads the provider
        const b = view(f.source);
        // A provider that is down gives no scan cursors.
        const { scanCursors: _none, ...down } = failed("HTTP 503");
        f.fetch.mockResolvedValueOnce(down as never);
        await b.ask();
        await settle();
        expect(b.last()?.outcome, "setup: B's normal read came back unavailable").toBe(
            "unavailable",
        );
        expect(
            [a.last()?.outcome, a.last()?.runs.length, a.last()?.refreshError],
            "A keeps its last data and its own Refresh error after B's failed read",
        ).toEqual(["failure", 1, "HTTP 502"]);
    });

    // #463: the cache entry a failed-Refresh view was showing is replaced or dropped and its
    // scan ends, but nothing tells that view.
    it("P1a: invalidate leaves A on a running scan", async () => {
        const f = fixture();
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        await f.service.invalidate(KEY);
        pending.resolve(terminal);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(a.last()?.refreshError, "P1a: error still shown").toBe("HTTP 502");
        expect(state(a), "P1a: A's last post scan state after invalidate").not.toBe("running");
    });

    it("P1b: eviction leaves A on a running scan", async () => {
        const f = fixture({ maxEntries: 1 });
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        await f.service.getOrFetch("other", async () => fetched(2, false), serve, {});
        pending.resolve(terminal);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(a.last()?.refreshError, "P1b: error still shown").toBe("HTTP 502");
        expect(state(a), "P1b: A's last post scan state after eviction").not.toBe("running");
    });

    it("P2: Y's L2-awaiting read supersedes A, A never joined", async () => {
        const l2 = deferred<undefined>();
        const persistentCache = {
            get: vi.fn(() => l2.promise),
            set: vi.fn(async () => {}),
            delete: vi.fn(async () => {}),
            deleteHash: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            confirmWrite: vi.fn(async () => {}),
            generation: () => undefined,
        };
        const f = fixture({ ttlMs: 1000, persistentCache: persistentCache as never });
        // The open read also goes through the (held) L2 read: release it for this one only.
        persistentCache.get.mockImplementationOnce(async () => undefined);
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = view(f.source);
        void a.ask();
        await settle();
        expect(state(a), "setup: scan running").toBe("running");
        // Entry now past its TTL (clock only; no ladder timer fires).
        vi.setSystemTime(Date.now() + 5_000);
        const y = view(f.source);
        void y.ask(); // non-forced, now waiting on the held L2 read
        await settle();
        expect(persistentCache.get, "setup: Y is awaiting the stored read").toHaveBeenCalledTimes(
            2,
        );
        f.fetch.mockResolvedValueOnce(failed());
        await a.ask(true); // A's forced Refresh fails fast; A is listed + newest scan requester
        expect(a.last()?.refreshError, "setup: A's Refresh failed").toBe("HTTP 502");
        f.fetch.mockResolvedValueOnce(fetched(2, false));
        l2.resolve(undefined);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(y.last()?.runs[0]?.attempt, "setup: Y shows the newer entry (attempt 2)").toBe(2);
        pending.resolve(terminal);
        await settle();
        expect(
            [a.last()?.runs[0]?.attempt, state(a)],
            "P2: A's last post [attempt, scan state]",
        ).toEqual([2, undefined]);
    });

    const down = (error: string, signInHost?: string) => {
        const { scanCursors: _, signInHost: _host, ...data } = failed(error);
        return { ...data, signInHost };
    };

    async function afterSkippedFailure(f: ReturnType<typeof fixture>) {
        const pending = deferred<object>();
        f.page.mockReturnValueOnce(pending.promise);
        const a = await openAndFail(f);
        vi.setSystemTime(Date.now() + 5_000);
        const b = view(f.source);
        f.fetch.mockResolvedValueOnce(down("HTTP 503") as never);
        await b.ask();
        expect(b.last()?.outcome, "B received its own outage").toBe("unavailable");
        expect(
            [a.last()?.runs.length, a.last()?.refreshError],
            "A keeps its last tree and error",
        ).toEqual([1, "HTTP 502"]);
        return { a, b, pending };
    }

    it("R4 outage replacement retires an orphaned running scan", async () => {
        const f = fixture({ ttlMs: 1000, unavailableTtlMs: 1000 });
        const { a, pending } = await afterSkippedFailure(f);
        pending.resolve({ error: "HTTP 503" });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.fetch, "neither view has a scheduled provider retry").toHaveBeenCalledTimes(3);
        expect(f.page, "the only page request already settled").toHaveBeenCalledTimes(1);
        expect(
            await f.service.getCached(KEY, serve),
            "there is no fresh scan entry",
        ).toBeUndefined();
        expect(
            [a.last()?.runs.length, a.last()?.refreshError],
            "the tree and error remain",
        ).toEqual([1, "HTTP 502"]);
        expect(
            ["running", "paused"],
            "A must not promise progress after the only scan settled",
        ).not.toContain(state(a));
    });

    it("R4 then invalidate: the outage entry with no scan never reaches A", async () => {
        const f = fixture({ ttlMs: 1000, unavailableTtlMs: 60_000 });
        const { a } = await afterSkippedFailure(f);
        const posts = a.post.mock.calls.length;
        await f.service.invalidate(KEY);
        await settle();
        expect(
            [a.post.mock.calls.length, a.last()?.runs.length, a.last()?.refreshError],
            "invalidating the outage entry posts nothing to A, which keeps its tree and error",
        ).toEqual([posts, 1, "HTTP 502"]);
    });
});
