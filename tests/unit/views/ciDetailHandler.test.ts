// The host side of the Checks tab: a detail request is answered only while the world it
// started in still exists (same repository, same sign-in, same CI settings).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import type { CiFailedScan, CommitCiDetail } from "../../../src/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { CommitCiDetailService } from "../../../src/services/commitChecks/detailService";
import {
    answerCommitCiDetailRequest,
    CommitCiDetailLoops,
} from "../../../src/views/ciDetailHandler";

// The hash validator lives in a module that imports the VS Code API.
vi.mock("vscode", () => ({}));

const HASH = "a".repeat(40);

function detail(repoKey: string): CommitCiDetail {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: "success",
        runs: [],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: NO_CI_CAPABILITIES,
        repoKey,
    };
}

/** A failed run past the job bound whose overflow scan is at `state` with `found` jobs. */
function scanned(state: CiFailedScan["state"], found: number): CommitCiDetail {
    return {
        ...detail("/repo"),
        outcome: "failure",
        runs: [
            {
                id: "1",
                name: "CI",
                state: "failure",
                jobs: [],
                jobsCoverage: { reason: "pageBound", shown: 1000 },
                failedScan: { state, found },
            },
        ],
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

// The Checks tab switch is on only while the E2E control channel is; these tests turn it on.
beforeEach(() => setE2eControlChannelActive(true));
afterEach(() => setE2eControlChannelActive(false));

describe("answerCommitCiDetailRequest", () => {
    it("answers no request while the Checks tab switch is off", async () => {
        setE2eControlChannelActive(false);
        const getDetail = vi.fn(async () => detail("/repo"));
        const post = vi.fn();
        await answerCommitCiDetailRequest(
            { repoKey: () => "/repo", generations: new CiGenerations(), getDetail },
            { type: "requestCommitCiDetail", requestId: 1, repoKey: "/repo", hash: HASH },
            post,
            new CommitCiDetailLoops(),
        );
        expect(getDetail, "no CI detail is fetched").not.toHaveBeenCalled();
        expect(post, "no reply is posted").not.toHaveBeenCalled();
    });

    it("a failed forced Refresh of a running overflow scan is not re-read automatically", async () => {
        vi.useFakeTimers();
        try {
            const service = new CommitCiDetailService({ now: () => Date.now() });
            const serve = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };
            const key = "snapshot#detail";
            await service.getOrFetch(
                key,
                async () => ({ ...scanned("running", 1), complete: false }),
                serve,
            );
            const fetchProvider = vi.fn(async () => ({
                ...detail("/repo"),
                complete: false,
                outcome: "unavailable" as const,
                error: "HTTP 502",
            }));
            const loops = new CommitCiDetailLoops();
            const post = vi.fn();
            const answered = answerCommitCiDetailRequest(
                {
                    repoKey: () => "/repo",
                    generations: new CiGenerations(),
                    getDetail: (_hash, options) =>
                        service.getOrFetch(key, fetchProvider, serve, options),
                },
                {
                    type: "requestCommitCiDetail",
                    requestId: 1,
                    repoKey: "/repo",
                    hash: HASH,
                    force: true,
                },
                post,
                loops,
            );
            // Long enough for the pending cache entry to expire and the ladder to re-read it.
            await vi.advanceTimersByTimeAsync(60_000);
            loops.dispose();
            await vi.advanceTimersByTimeAsync(0);
            await answered;
            expect(post.mock.calls[0]?.[0].detail.refreshError).toBe("HTTP 502");
            expect(fetchProvider, "provider reads after the failed Refresh").toHaveBeenCalledTimes(
                1,
            );
            expect(post, "the failure stays shown until the next Refresh").toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("posts the detail with the request's id, repository and hash", async () => {
        const generations = new CiGenerations();
        const post = vi.fn();
        const getDetail = vi.fn(async () => detail("/repo"));
        await answerCommitCiDetailRequest(
            { repoKey: () => "/repo", generations, getDetail },
            {
                type: "requestCommitCiDetail",
                requestId: 7,
                repoKey: "/repo",
                hash: HASH,
                force: true,
            },
            post,
            new CommitCiDetailLoops(),
        );
        expect(getDetail).toHaveBeenCalledWith(
            HASH,
            { force: true },
            expect.objectContaining({ repoKey: "/repo" }),
            expect.any(Function),
        );
        expect(post).toHaveBeenCalledWith({
            type: "commitCiDetail",
            requestId: 7,
            repoKey: "/repo",
            hash: HASH,
            detail: detail("/repo"),
        });
    });

    it("posts null when no provider serves the repository", async () => {
        const post = vi.fn();
        await answerCommitCiDetailRequest(
            {
                repoKey: () => "/repo",
                generations: new CiGenerations(),
                getDetail: async () => undefined,
            },
            { type: "requestCommitCiDetail", requestId: 1, repoKey: "/repo", hash: HASH },
            post,
            new CommitCiDetailLoops(),
        );
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ requestId: 1, detail: null }));
    });

    it("host drops a reply after a generation bump", async () => {
        const generations = new CiGenerations();
        const post = vi.fn();
        const pending = deferred<CommitCiDetail | undefined>();
        const answered = answerCommitCiDetailRequest(
            { repoKey: () => "/repo", generations, getDetail: () => pending.promise },
            { type: "requestCommitCiDetail", requestId: 3, repoKey: "/repo", hash: HASH },
            post,
            new CommitCiDetailLoops(),
        );
        generations.bumpAuth();
        pending.resolve(detail("/repo"));
        await answered;
        expect(post).not.toHaveBeenCalled();
    });

    it("re-posts overflow-scan progress under the same request id until the scan finishes", async () => {
        vi.useFakeTimers();
        try {
            const steps = [
                scanned("running", 0),
                scanned("paused", 1),
                scanned("running", 2),
                scanned("done", 3),
            ];
            const getDetail = vi.fn(async () => steps.shift());
            const post = vi.fn();
            const answered = answerCommitCiDetailRequest(
                { repoKey: () => "/repo", generations: new CiGenerations(), getDetail },
                { type: "requestCommitCiDetail", requestId: 9, repoKey: "/repo", hash: HASH },
                post,
                new CommitCiDetailLoops(),
            );
            await vi.runAllTimersAsync();
            await answered;

            const posted = post.mock.calls.map(([reply]) => reply);
            expect(posted.map((reply) => reply.requestId)).toEqual([9, 9, 9, 9]);
            expect(posted.map((reply) => reply.detail.runs[0].failedScan)).toEqual([
                { state: "running", found: 0 },
                { state: "paused", found: 1 },
                { state: "running", found: 2 },
                { state: "done", found: 3 },
            ]);
            // Re-reads join the scan's cached progress; they never force a new fetch.
            expect(getDetail.mock.calls.slice(1).map(([, options]) => options)).toEqual([
                { force: false },
                { force: false },
                { force: false },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("each scan page re-posts the detail with the same requestId", async () => {
        vi.useFakeTimers();
        try {
            let onScanUpdate: ((update: CommitCiDetail) => void) | undefined;
            const loops = new CommitCiDetailLoops();
            const post = vi.fn();
            const answered = answerCommitCiDetailRequest(
                {
                    repoKey: () => "/repo",
                    generations: new CiGenerations(),
                    getDetail: async (_hash, _options, _ctx, onUpdate) => {
                        onScanUpdate = onUpdate;
                        return scanned("running", 0);
                    },
                },
                { type: "requestCommitCiDetail", requestId: 6, repoKey: "/repo", hash: HASH },
                post,
                loops,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(post).toHaveBeenCalledTimes(1);

            // Two pages arrive before the ladder's first re-read.
            onScanUpdate?.(scanned("running", 1));
            onScanUpdate?.(scanned("running", 2));
            expect(
                post.mock.calls.map(([reply]) => [
                    reply.requestId,
                    reply.detail.runs[0].failedScan,
                ]),
                "each scan page reaches the webview under the request's id",
            ).toEqual([
                [6, { state: "running", found: 0 }],
                [6, { state: "running", found: 1 }],
                [6, { state: "running", found: 2 }],
            ]);

            loops.dispose();
            onScanUpdate?.(scanned("done", 3));
            await vi.advanceTimersByTimeAsync(LONG_MS);
            await answered;
            expect(
                post,
                "a scan page after the loop was stopped posts nothing",
            ).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a scan page that arrives after the repository switched is not posted", async () => {
        let current = "/repo";
        let onScanUpdate: ((update: CommitCiDetail) => void) | undefined;
        const post = vi.fn();
        const pending = deferred<CommitCiDetail | undefined>();
        const answered = answerCommitCiDetailRequest(
            {
                repoKey: () => current,
                generations: new CiGenerations(),
                getDetail: (_hash, _options, _ctx, onUpdate) => {
                    onScanUpdate = onUpdate;
                    return pending.promise;
                },
            },
            { type: "requestCommitCiDetail", requestId: 2, repoKey: "/repo", hash: HASH },
            post,
            new CommitCiDetailLoops(),
        );
        current = "/other";
        onScanUpdate?.(scanned("running", 1));
        expect(post, "a scan page posted for a repository no longer shown").not.toHaveBeenCalled();
        pending.resolve(undefined);
        await answered;
    });

    it("a scan page delivered during a ladder re-read is posted under the request's id", async () => {
        vi.useFakeTimers();
        try {
            let reads = 0;
            const post = vi.fn();
            const answered = answerCommitCiDetailRequest(
                {
                    repoKey: () => "/repo",
                    generations: new CiGenerations(),
                    getDetail: async (_hash, _options, _ctx, onUpdate) => {
                        reads += 1;
                        if (reads === 1) return scanned("running", 0);
                        // As in the coordinator: a read's reply is the snapshot taken before
                        // the pages it starts, so its own page is newer than the reply.
                        onUpdate?.(scanned("done", 2));
                        return scanned("running", 1);
                    },
                },
                { type: "requestCommitCiDetail", requestId: 8, repoKey: "/repo", hash: HASH },
                post,
                new CommitCiDetailLoops(),
            );
            await vi.runAllTimersAsync();
            await answered;
            expect(
                post.mock.calls.map(([reply]) => [
                    reply.requestId,
                    reply.detail.runs[0].failedScan,
                ]),
                "the page from the ladder's re-read reaches the webview",
            ).toEqual([
                [8, { state: "running", found: 0 }],
                [8, { state: "done", found: 2 }],
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a reply that arrives after its own read's scan page does not overwrite it", async () => {
        const post = vi.fn();
        await answerCommitCiDetailRequest(
            {
                repoKey: () => "/repo",
                generations: new CiGenerations(),
                getDetail: async (_hash, _options, _ctx, onUpdate) => {
                    // The reply waited on the merge-rule read while the scan found a page.
                    onUpdate?.(scanned("done", 2));
                    return scanned("done", 1);
                },
            },
            { type: "requestCommitCiDetail", requestId: 9, repoKey: "/repo", hash: HASH },
            post,
            new CommitCiDetailLoops(),
        );

        expect(
            post.mock.calls.at(-1)?.[0].detail.runs[0].failedScan.found,
            "the older reply must not replace the newer scan page",
        ).toBe(2);
    });

    it("a scan page from an earlier read that lands after a newer reply is dropped", async () => {
        vi.useFakeTimers();
        try {
            let firstOnUpdate: ((update: CommitCiDetail) => void) | undefined;
            let reads = 0;
            const post = vi.fn();
            const answered = answerCommitCiDetailRequest(
                {
                    repoKey: () => "/repo",
                    generations: new CiGenerations(),
                    getDetail: async (_hash, _options, _ctx, onUpdate) => {
                        reads += 1;
                        if (reads > 1) return scanned("done", 2);
                        firstOnUpdate = onUpdate;
                        return scanned("running", 0);
                    },
                },
                { type: "requestCommitCiDetail", requestId: 10, repoKey: "/repo", hash: HASH },
                post,
                new CommitCiDetailLoops(),
            );
            await vi.runAllTimersAsync();
            await answered;

            // The first read's page was decorated slowly and lands after the re-read's reply.
            firstOnUpdate?.(scanned("running", 1));

            expect(
                post.mock.calls.map(([reply]) => reply.detail.runs[0].failedScan.found),
                "a late page from an older read must not replace the newer reply",
            ).toEqual([0, 2]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops re-posting scan progress when the scan stops or the sign-in changes", async () => {
        vi.useFakeTimers();
        try {
            const stopped = vi.fn();
            const steps = [scanned("running", 0), scanned("stopped", 1), scanned("done", 2)];
            const answeredStopped = answerCommitCiDetailRequest(
                {
                    repoKey: () => "/repo",
                    generations: new CiGenerations(),
                    getDetail: async () => steps.shift(),
                },
                { type: "requestCommitCiDetail", requestId: 4, repoKey: "/repo", hash: HASH },
                stopped,
                new CommitCiDetailLoops(),
            );
            await vi.runAllTimersAsync();
            await answeredStopped;
            expect(
                stopped.mock.calls.map(([reply]) => reply.detail.runs[0].failedScan.state),
            ).toEqual(["running", "stopped"]);

            const generations = new CiGenerations();
            const signedOut = vi.fn((reply) => {
                if (reply.detail.runs[0].failedScan.found === 0) generations.bumpAuth();
            });
            const answered = answerCommitCiDetailRequest(
                {
                    repoKey: () => "/repo",
                    generations,
                    getDetail: async () => scanned("running", signedOut.mock.calls.length),
                },
                { type: "requestCommitCiDetail", requestId: 5, repoKey: "/repo", hash: HASH },
                signedOut,
                new CommitCiDetailLoops(),
            );
            await vi.runAllTimersAsync();
            await answered;
            expect(signedOut).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    /** Starts request `requestId` on `loops` against a scan that never ends. */
    function endlessScan(loops: CommitCiDetailLoops, requestId: number, post: Post) {
        return answerCommitCiDetailRequest(
            {
                repoKey: () => "/repo",
                generations: new CiGenerations(),
                getDetail: async () => scanned("running", 0),
            },
            { type: "requestCommitCiDetail", requestId, repoKey: "/repo", hash: HASH },
            post,
            loops,
        );
    }
    type Post = (reply: { requestId: number }) => void;
    const LONG_MS = 10 * 60_000;

    it("repeated Refresh keeps only the newest request's re-post loop running", async () => {
        vi.useFakeTimers();
        try {
            const loops = new CommitCiDetailLoops();
            const post = vi.fn<Post>();
            const answered = [1, 2, 3].map((id) => endlessScan(loops, id, post));
            await vi.advanceTimersByTimeAsync(0);
            post.mockClear();

            await vi.advanceTimersByTimeAsync(LONG_MS);
            const ids = post.mock.calls.map(([reply]) => reply.requestId);
            expect(ids.length, "the newest loop keeps posting").toBeGreaterThan(1);
            expect(new Set(ids), "re-posts after replacement").toEqual(new Set([3]));
            // Replaced loops have finished, not merely gone quiet.
            await Promise.all(answered.slice(0, 2));
            loops.dispose();
            await vi.advanceTimersByTimeAsync(0);
            await Promise.all(answered);
            expect(vi.getTimerCount(), "timers left after dispose").toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("hiding the tab stops its loop at once; showing it again starts a new one", async () => {
        vi.useFakeTimers();
        try {
            const loops = new CommitCiDetailLoops();
            const post = vi.fn<Post>();
            const hidden = endlessScan(loops, 1, post);
            await vi.advanceTimersByTimeAsync(0);
            expect(post).toHaveBeenCalledTimes(1);

            loops.cancel(1);
            expect(vi.getTimerCount(), "re-post timer left after hide").toBe(0);
            await vi.advanceTimersByTimeAsync(LONG_MS);
            expect(post, "posts after hide").toHaveBeenCalledTimes(1);
            await hidden;

            const shown = endlessScan(loops, 2, post);
            await vi.advanceTimersByTimeAsync(LONG_MS);
            const ids = post.mock.calls.slice(1).map(([reply]) => reply.requestId);
            expect(ids.length, "the re-shown loop posts").toBeGreaterThan(1);
            expect(new Set(ids)).toEqual(new Set([2]));

            // A late cancel for the hidden request must not stop the re-shown one.
            loops.cancel(1);
            post.mockClear();
            await vi.advanceTimersByTimeAsync(LONG_MS);
            expect(post, "re-shown loop after a stale cancel").toHaveBeenCalled();
            loops.cancel(2);
            await shown;
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ["the tab is hidden", (loops: CommitCiDetailLoops) => loops.cancel(1)],
        ["a newer request starts", (loops: CommitCiDetailLoops) => void loops.start(2)],
        ["the view is disposed", (loops: CommitCiDetailLoops) => loops.dispose()],
    ])("a loop stopped during its wait fetches nothing more when %s", async (_, stop) => {
        vi.useFakeTimers();
        try {
            const loops = new CommitCiDetailLoops();
            const getDetail = vi.fn(async () => scanned("running", 0));
            const answered = answerCommitCiDetailRequest(
                { repoKey: () => "/repo", generations: new CiGenerations(), getDetail },
                { type: "requestCommitCiDetail", requestId: 1, repoKey: "/repo", hash: HASH },
                vi.fn(),
                loops,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(getDetail).toHaveBeenCalledTimes(1);

            stop(loops);
            await vi.advanceTimersByTimeAsync(LONG_MS);
            await answered;
            expect(getDetail, "detail fetches after the loop stopped").toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([1.5, "1", undefined])("rejects a malformed cancel id %o", (requestId) => {
        expect(() => new CommitCiDetailLoops().cancel(requestId)).toThrow();
    });

    it("drops a reply when the host switched repository while fetching", async () => {
        let current = "/repo";
        const post = vi.fn();
        const pending = deferred<CommitCiDetail | undefined>();
        const answered = answerCommitCiDetailRequest(
            {
                repoKey: () => current,
                generations: new CiGenerations(),
                getDetail: () => pending.promise,
            },
            { type: "requestCommitCiDetail", requestId: 3, repoKey: "/repo", hash: HASH },
            post,
            new CommitCiDetailLoops(),
        );
        current = "/other";
        pending.resolve(detail("/repo"));
        await answered;
        expect(post).not.toHaveBeenCalled();
    });

    // Not answered at all: every host re-sends its repository after a switch (see the host
    // tests), and the tab then asks again under the new key, so it never waits on this one.
    it("ignores a request for a repository the host no longer shows", async () => {
        const getDetail = vi.fn(async () => detail("/repo"));
        const post = vi.fn();
        await answerCommitCiDetailRequest(
            { repoKey: () => "/repo", generations: new CiGenerations(), getDetail },
            { type: "requestCommitCiDetail", requestId: 3, repoKey: "/old", hash: HASH },
            post,
            new CommitCiDetailLoops(),
        );
        expect(getDetail).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it.each([
        { requestId: 1.5, repoKey: "/repo", hash: HASH },
        { requestId: 1, repoKey: 4, hash: HASH },
        { requestId: 1, repoKey: "/repo", hash: "--upload-pack=x" },
        { requestId: 1, repoKey: "/repo", hash: HASH, force: "yes" },
    ])("rejects a malformed request %o", async (fields) => {
        await expect(
            answerCommitCiDetailRequest(
                {
                    repoKey: () => "/repo",
                    generations: new CiGenerations(),
                    getDetail: async () => undefined,
                },
                { type: "requestCommitCiDetail", ...fields },
                vi.fn(),
                new CommitCiDetailLoops(),
            ),
        ).rejects.toThrow();
    });
});
