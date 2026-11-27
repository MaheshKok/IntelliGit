// A failed forced Refresh shows its error, then the overflow scan's next page erases it: red on origin/main.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import type { CommitCiDetail } from "../../../src/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { CommitCiDetailService } from "../../../src/services/commitChecks/detailService";
import {
    answerCommitCiDetailRequest,
    CommitCiDetailLoops,
} from "../../../src/views/ciDetailHandler";

vi.mock("vscode", () => ({}));
const HASH = "a".repeat(40);
beforeEach(() => setE2eControlChannelActive(true));
afterEach(() => setE2eControlChannelActive(false));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

it("a failed Refresh's error survives the scan's next page", async () => {
    const service = new CommitCiDetailService({ now: () => Date.now() });
    const serve = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };
    const cursor = { runId: "1", runAttempt: 1, runName: "CI", url: "page-11" };
    const base = {
        hash: HASH,
        provider: "github",
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: NO_CI_CAPABILITIES,
        repoKey: "/repo",
    };
    const pageGates = [deferred<void>(), deferred<void>()];
    let fetches = 0;
    let pages = 0;
    const fetchDetail = async () => {
        fetches += 1;
        if (fetches === 1) {
            return {
                ...base,
                complete: false,
                outcome: "failure",
                runs: [
                    {
                        id: "1",
                        name: "CI",
                        state: "failure",
                        jobs: [],
                        jobsCoverage: { reason: "pageBound", shown: 1000 },
                    },
                ],
                scanCursors: [cursor],
            } as never;
        }
        return {
            ...base,
            runs: [],
            complete: false,
            outcome: "unavailable",
            error: "HTTP 502",
        } as never;
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
            service.getOrFetch("k#detail", fetchDetail, serve, options, undefined, {
                continueScan: async () => {
                    const gate = pageGates[pages];
                    pages += 1;
                    if (!gate) return new Promise(() => undefined);
                    await gate.promise;
                    return { failed: [], next: { ...cursor, url: `page-${11 + pages}` } };
                },
                isCurrent: () => true,
                onUpdate: (update) => onScanUpdate?.(update),
            } as never),
    };
    const loops = new CommitCiDetailLoops();
    const firstPost = vi.fn();
    const first = answerCommitCiDetailRequest(
        source as never,
        { type: "requestCommitCiDetail", requestId: 1, repoKey: "/repo", hash: HASH },
        firstPost,
        loops,
    );
    await vi.waitFor(() => expect(firstPost).toHaveBeenCalled());
    const post = vi.fn();
    const forced = answerCommitCiDetailRequest(
        source as never,
        { type: "requestCommitCiDetail", requestId: 2, repoKey: "/repo", hash: HASH, force: true },
        post,
        loops,
    );
    await forced;
    expect(post.mock.calls.at(-1)?.[0].detail?.refreshError).toBe("HTTP 502");
    pageGates[0].resolve();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    loops.dispose();
    void first;
    expect(post.mock.calls.at(-1)?.[0].detail?.refreshError, "error after the next page").toBe(
        "HTTP 502",
    );
});

const JOB = {
    id: "1001",
    logicalId: "1001",
    name: "test",
    checkName: "test",
    state: "failure",
    steps: [],
};

/**
 * A failed run whose overflow scan is running; the second read (a Refresh) fails with HTTP 502
 * and every later read succeeds with the same run. The scan's first page finds one job once
 * `page` resolves; a failed reply waits on `replyHeld`, as a cold merge-rule read holds it.
 */
function scanFixture() {
    const service = new CommitCiDetailService({ now: () => Date.now() });
    const serve = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };
    const cursor = { runId: "1", runAttempt: 1, runName: "CI", url: "page-11" };
    const base = {
        hash: HASH,
        provider: "github",
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: NO_CI_CAPABILITIES,
        repoKey: "/repo",
    };
    const page = deferred<void>();
    const failedReply = deferred<void>();
    const replyHeld = deferred<void>();
    let fetches = 0;
    let pages = 0;
    const fetchDetail = async () => {
        fetches += 1;
        if (fetches === 2) {
            return {
                ...base,
                runs: [],
                complete: false,
                outcome: "unavailable",
                error: "HTTP 502",
            } as never;
        }
        return {
            ...base,
            complete: false,
            outcome: "failure",
            runs: [
                {
                    id: "1",
                    name: "CI",
                    state: "failure",
                    jobs: [],
                    jobsCoverage: { reason: "pageBound", shown: 1000 },
                },
            ],
            scanCursors: [cursor],
        } as never;
    };
    const source = {
        repoKey: () => "/repo",
        generations: new CiGenerations(),
        getDetail: async (
            _hash: string,
            options: { force?: boolean },
            _ctx: unknown,
            onScanUpdate?: (update: CommitCiDetail) => void,
        ) => {
            const reply = await service.getOrFetch(
                "k#detail",
                fetchDetail,
                serve,
                options,
                undefined,
                {
                    continueScan: async () => {
                        pages += 1;
                        if (pages > 1) return new Promise(() => undefined);
                        await page.promise;
                        return { failed: [JOB], next: { ...cursor, url: "page-12" } };
                    },
                    isCurrent: () => true,
                    onUpdate: (update) => onScanUpdate?.(update),
                } as never,
            );
            if (reply.refreshError !== undefined) {
                failedReply.resolve();
                await replyHeld.promise;
            }
            return reply;
        },
    };
    return { source, page, failedReply, replyHeld };
}

const request = (requestId: number, force?: boolean) => ({
    type: "requestCommitCiDetail",
    requestId,
    repoKey: "/repo",
    hash: HASH,
    ...(force && { force }),
});

it("a failed Refresh's error does not stay over newer data", async () => {
    const { source, page, replyHeld } = scanFixture();
    replyHeld.resolve();
    const firstLoops = new CommitCiDetailLoops();
    const firstPost = vi.fn();
    const opened = answerCommitCiDetailRequest(source as never, request(1), firstPost, firstLoops);
    await vi.waitFor(() => expect(firstPost).toHaveBeenCalled());
    await answerCommitCiDetailRequest(source as never, request(2, true), firstPost, firstLoops);
    await opened;
    expect(firstPost.mock.calls.at(-1)?.[0].detail?.refreshError, "setup").toBe("HTTP 502");

    // A second view's Refresh succeeds: newer data, which the running scan carries over to.
    const secondLoops = new CommitCiDetailLoops();
    const secondPost = vi.fn();
    const second = answerCommitCiDetailRequest(
        source as never,
        request(3, true),
        secondPost,
        secondLoops,
    );
    await vi.waitFor(() => expect(secondPost).toHaveBeenCalled());
    page.resolve();
    await vi.waitFor(() =>
        expect(secondPost.mock.calls.at(-1)?.[0].detail?.runs[0].failedScan.found).toBe(1),
    );
    secondLoops.dispose();
    firstLoops.dispose();
    await second;

    const last = firstPost.mock.calls.at(-1)?.[0].detail;
    expect(last?.refreshError, "the error must not stay over newer data").toBeUndefined();
    expect(last?.runs[0].failedScan.found, "the newer data's scan page reaches the view").toBe(1);
});

it("a failed Refresh's late reply does not put its error on newer data", async () => {
    const { source, page, failedReply, replyHeld } = scanFixture();
    const firstLoops = new CommitCiDetailLoops();
    const firstPost = vi.fn();
    const opened = answerCommitCiDetailRequest(source as never, request(1), firstPost, firstLoops);
    await vi.waitFor(() => expect(firstPost).toHaveBeenCalled());
    const forced = answerCommitCiDetailRequest(
        source as never,
        request(2, true),
        firstPost,
        firstLoops,
    );
    await failedReply.promise;
    await opened;

    // While the failed reply is held, a second view's Refresh succeeds and the scan pages it.
    const secondLoops = new CommitCiDetailLoops();
    const secondPost = vi.fn();
    const second = answerCommitCiDetailRequest(
        source as never,
        request(3, true),
        secondPost,
        secondLoops,
    );
    await vi.waitFor(() => expect(secondPost).toHaveBeenCalled());
    page.resolve();
    await vi.waitFor(() =>
        expect(secondPost.mock.calls.at(-1)?.[0].detail?.runs[0].failedScan.found).toBe(1),
    );
    expect(
        firstPost.mock.calls.at(-1)?.[0].detail?.runs[0].failedScan.found,
        "setup: the newer data's scan page reaches the first view",
    ).toBe(1);
    replyHeld.resolve();
    // Lets the released reply reach the view before its loop is stopped.
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstLoops.dispose();
    secondLoops.dispose();
    await Promise.all([forced, second]);

    expect(
        firstPost.mock.calls.at(-1)?.[0].detail?.refreshError,
        "a late failed reply must not put its error on newer data",
    ).toBeUndefined();
});
