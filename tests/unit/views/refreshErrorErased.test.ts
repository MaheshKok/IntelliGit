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
