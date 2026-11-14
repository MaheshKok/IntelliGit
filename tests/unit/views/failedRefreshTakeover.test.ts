// Repro (local only, never pushed): after a failed forced Refresh the Checks tab stops
// re-reading, and once a second view asks for the same commit the scan's pages go to that view
// only, so the first view keeps a scan state that is no longer true.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import { CommitCiDetailService } from "../../../src/services/commitChecks/detailService";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
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
});
