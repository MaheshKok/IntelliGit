// @vitest-environment jsdom
// The Checks tab's write actions: Re-run failed, Re-run job and Cancel run (with its inline
// confirm), the busy state that stops a second click, the waiting and not-seen labels drawn
// from `detail.actionFence`, and the problem shown when the token cannot write.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiJob, CiRun, CommitCiDetail, CommitDetail } from "../../../src/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { PENDING_CHECK_RETRY_DELAYS_MS } from "../../../src/shared/ci/pollSchedule";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

const HASH = "a".repeat(40);
const HELP_URL =
    "https://github.com/o/intelligit/blob/HEAD/docs/commit-checks/README.md#write-actions";

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.getState.mockReturnValue({ commitInfoTab: "checks" });
    mockVscodeApi.setState.mockReset();
    window.intelligitE2E = true;
});

afterEach(() => {
    delete window.intelligitE2E;
    vi.useRealTimers();
});

function commit(): CommitDetail {
    return {
        hash: HASH,
        shortHash: HASH.slice(0, 7),
        message: "Commit a",
        body: "",
        author: "Mahesh Kokare",
        email: "mahesh@example.com",
        date: "2026-11-07T12:00:00.000Z",
        parentHashes: [],
        refs: [],
        files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }],
    };
}

const WRITE_CAPABILITIES = {
    ...NO_CI_CAPABILITIES,
    runs: true,
    jobs: true,
    steps: true,
    rerunFailed: true,
    rerunJob: true,
    cancel: true,
    writeScopeHelp: "commit.checks.tab.writeScopeHelpGithub",
};

function job(name: string, state: CiJob["state"]): CiJob {
    return {
        id: name,
        logicalId: `wf\0${name}`,
        name,
        checkName: name,
        state,
        startedAt: "2026-11-07T12:00:00.000Z",
        ...(state === "queued" || state === "running"
            ? {}
            : { completedAt: "2026-11-07T12:01:05.000Z" }),
        steps: [],
    };
}

function run(state: CiRun["state"], jobs: CiJob[]): CiRun {
    return {
        id: "77",
        name: "CI",
        state,
        attempt: 1,
        startedAt: "2026-11-07T12:00:00.000Z",
        jobs,
        jobsCoverage: "full",
    };
}

const failedDetail = (overrides: Partial<CommitCiDetail> = {}): CommitCiDetail => ({
    hash: HASH,
    provider: "github",
    complete: true,
    outcome: "failure",
    runs: [run("failure", [job("lint", "success"), job("unit-tests", "failure")])],
    runsCoverage: "full",
    otherChecks: [],
    otherChecksCoverage: "full",
    capabilities: WRITE_CAPABILITIES,
    repoKey: "/repo",
    ...overrides,
});

const runningDetail = (): CommitCiDetail =>
    failedDetail({
        complete: false,
        outcome: "pending",
        runs: [run("running", [job("unit-tests", "running")])],
    });

interface Posted {
    type: string;
    requestId: number;
    [key: string]: unknown;
}

function posted(type: string): Posted[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([message]) => message as Posted)
        .filter((message) => message.type === type);
}

function lastDetailRequest(): Posted {
    const requests = posted("requestCommitCiDetail");
    expect(requests.length, "a detail request was posted").toBeGreaterThan(0);
    return requests.at(-1)!;
}

function dispatch(data: Record<string, unknown>): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

function replyDetail(detail: CommitCiDetail, requestId = lastDetailRequest().requestId): void {
    dispatch({ type: "commitCiDetail", requestId, repoKey: "/repo", hash: HASH, detail });
}

function replyAction(outcome: string, extra: Record<string, unknown> = {}): void {
    const sent = posted("runCiAction").at(-1)!;
    dispatch({
        type: "ciActionResult",
        requestId: sent.requestId,
        repoKey: "/repo",
        hash: HASH,
        outcome,
        ...extra,
    });
}

function button(container: HTMLElement, name: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === name,
    );
}

function click(element: HTMLElement | undefined): void {
    expect(element, "the element to click").toBeDefined();
    act(() => element!.click());
}

function fenceLabel(container: HTMLElement): string | null | undefined {
    return container.querySelector('[data-testid="ci-action-fence"]')?.textContent;
}

function openPane(detail: CommitCiDetail) {
    const mounted = mount(
        <CommitInfoPane detail={commit()} ciRepoKey="/repo" commitChecksEnabled />,
    );
    replyDetail(detail);
    return mounted;
}

describe("Checks tab write actions", () => {
    it("cancel needs confirm, then refreshes", () => {
        const { container } = openPane(runningDetail());
        expect(button(container, "Re-run failed"), "no re-run while running").toBeUndefined();

        click(button(container, "Cancel run"));
        expect(posted("runCiAction"), "the first click only asks").toHaveLength(0);
        expect(button(container, "Keep running")).toBeDefined();

        click(button(container, "Keep running"));
        expect(
            button(container, "Confirm cancel"),
            "Keep running closes the confirm",
        ).toBeUndefined();
        expect(posted("runCiAction")).toHaveLength(0);

        click(button(container, "Cancel run"));
        click(button(container, "Confirm cancel"));
        expect(posted("runCiAction")).toEqual([
            expect.objectContaining({
                repoKey: "/repo",
                hash: HASH,
                action: "cancel",
                runId: "77",
            }),
        ]);
        expect(posted("runCiAction")[0]).not.toHaveProperty("jobId");

        const before = posted("requestCommitCiDetail").length;
        replyAction("ok");
        const after = posted("requestCommitCiDetail");
        expect(after.length, "the detail is asked for again").toBe(before + 1);
        expect(after.at(-1), "through the host's refilled caches").not.toHaveProperty("force");
    });

    it("forbidden keeps the tree", () => {
        const { container } = openPane(failedDetail());
        click(button(container, "Re-run failed"));
        replyAction("forbidden", { helpUrl: HELP_URL });

        const alert = container.querySelector('[data-testid="ci-action-alert"]');
        expect(alert?.textContent).toContain(
            "You don't have permission to re-run or cancel workflows in this repository.",
        );
        expect(
            container.querySelectorAll('[data-testid="ci-job-row"]'),
            "the tree stays",
        ).toHaveLength(2);
        expect(button(container, "Re-run failed")?.disabled, "the button is usable again").toBe(
            false,
        );

        click(button(container, "How to get a token that can"));
        expect(posted("openCommitCheckUrl")).toEqual([expect.objectContaining({ url: HELP_URL })]);
    });

    it("busy state blocks double click", () => {
        const { container } = openPane(failedDetail());
        const rerun = button(container, "Re-run failed")!;
        act(() => {
            rerun.click();
            rerun.click();
        });
        click(button(container, "Re-run job"));

        expect(posted("runCiAction"), "one action while one is in flight").toHaveLength(1);
        expect(button(container, "Re-run failed")?.disabled).toBe(true);
        expect(button(container, "Re-run failed")?.getAttribute("aria-busy")).toBe("true");
        expect(button(container, "Re-run job")?.disabled).toBe(true);

        replyAction("failed", { message: "boom" });
        expect(button(container, "Re-run failed")?.disabled).toBe(false);
        expect(container.querySelector('[data-testid="ci-action-alert"]')?.textContent).toContain(
            "Could not start the action: boom",
        );
    });

    it("re-run job sends the selected job", () => {
        const { container } = openPane(failedDetail());
        click(button(container, "Re-run job"));
        expect(posted("runCiAction")).toEqual([
            expect.objectContaining({ action: "rerunJob", runId: "77", jobId: "unit-tests" }),
        ]);
    });

    it("an unsure send says it may have gone and asks again", () => {
        const { container } = openPane(failedDetail());
        click(button(container, "Re-run failed"));
        const before = posted("requestCommitCiDetail").length;
        replyAction("uncertain");
        expect(container.querySelector('[data-testid="ci-action-alert"]')?.textContent).toContain(
            "The request may have been sent; refreshing",
        );
        expect(posted("requestCommitCiDetail")).toHaveLength(before + 1);
    });

    it("shows waiting for re-run to start", () => {
        const { container } = openPane(
            failedDetail({
                actionFence: { targetId: "77", action: "rerunFailed", notSeen: false },
            }),
        );
        expect(fenceLabel(container)).toBe("Waiting for re-run to start");
        expect(
            button(container, "Re-run failed"),
            "no second action while one is pending",
        ).toBeUndefined();
        expect(button(container, "Re-run job")).toBeUndefined();
    });

    it("shows re-run not seen yet after 10 min", () => {
        const { container } = openPane(
            failedDetail({ actionFence: { targetId: "77", action: "rerunFailed", notSeen: true } }),
        );
        expect(fenceLabel(container)).toBe("Re-run not seen yet — Refresh");

        click(button(container, "Re-run not seen yet — Refresh"));
        expect(lastDetailRequest(), "the label is a Refresh").toMatchObject({ force: true });
    });

    it("shows waiting for cancel and its not-seen label", () => {
        const { container } = openPane(
            failedDetail({ actionFence: { targetId: "77", action: "cancel", notSeen: false } }),
        );
        expect(fenceLabel(container)).toBe("Waiting for cancel to take effect");
        replyDetail(
            failedDetail({ actionFence: { targetId: "77", action: "cancel", notSeen: true } }),
        );
        expect(fenceLabel(container)).toBe("Cancel not seen yet — Refresh");
    });

    it("a fenced complete detail keeps polling on the pending ladder", () => {
        vi.useFakeTimers();
        const { container } = openPane(
            failedDetail({
                actionFence: { targetId: "77", action: "rerunFailed", notSeen: false },
            }),
        );
        const before = posted("requestCommitCiDetail").length;
        act(() => vi.advanceTimersByTime(PENDING_CHECK_RETRY_DELAYS_MS[0]!));
        expect(posted("requestCommitCiDetail"), "the fence keeps the ladder going").toHaveLength(
            before + 1,
        );

        // Once the fence ends, the complete detail stops polling.
        replyDetail(failedDetail());
        const settled = posted("requestCommitCiDetail").length;
        act(() => vi.advanceTimersByTime(10 * 60_000));
        expect(posted("requestCommitCiDetail")).toHaveLength(settled);
        expect(fenceLabel(container)).toBeUndefined();
    });

    it("the not-seen label appears by timer with no request", () => {
        vi.useFakeTimers();
        const { container } = openPane(
            failedDetail({
                actionFence: { targetId: "77", action: "rerunFailed", notSeen: false },
            }),
        );
        const request = lastDetailRequest();
        const before = posted("requestCommitCiDetail").length;

        // The host re-posts the shown detail under the same request id when the fence's timer fires.
        replyDetail(
            failedDetail({ actionFence: { targetId: "77", action: "rerunFailed", notSeen: true } }),
            request.requestId,
        );

        expect(fenceLabel(container)).toBe("Re-run not seen yet — Refresh");
        expect(posted("requestCommitCiDetail"), "no request was needed").toHaveLength(before);
    });
});
