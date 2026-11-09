// @vitest-environment jsdom
// The Checks tab in the commit details pane: a run -> job -> step tree for the selected commit,
// fed by `requestCommitCiDetail` / `commitCiDetail`. Only the reply to the newest request for
// the commit and repository on screen may render (PLAN.md journeys 1, 2, 15 and 16).

import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CiJob, CiRun, CommitCiDetail, CommitDetail } from "../../../src/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { PENDING_CHECK_RETRY_DELAYS_MS } from "../../../src/shared/ci/pollSchedule";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { formatCiStart } from "../../../src/webviews/react/commit-info/checks/ciFormat";
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

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.getState.mockReturnValue({ commitInfoTab: "checks" });
    mockVscodeApi.setState.mockReset();
});

function commit(hash: string): CommitDetail {
    return {
        hash,
        shortHash: hash.slice(0, 7),
        message: `Commit ${hash.slice(0, 1)}`,
        body: "",
        author: "Mahesh Kokare",
        email: "mahesh@example.com",
        date: "2026-11-07T12:00:00.000Z",
        parentHashes: [],
        refs: [],
        files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }],
    };
}

const TREE_CAPABILITIES = {
    ...NO_CI_CAPABILITIES,
    runs: true,
    jobs: true,
    steps: true,
    runHeader: true,
};

function job(name: string, state: CiJob["state"], overrides: Partial<CiJob> = {}): CiJob {
    return {
        id: name,
        logicalId: `wf\0${name}`,
        name,
        checkName: name,
        state,
        startedAt: "2026-11-07T12:00:00.000Z",
        completedAt: "2026-11-07T12:01:05.000Z",
        steps: [],
        ...overrides,
    };
}

function run(jobs: CiJob[], overrides: Partial<CiRun> = {}): CiRun {
    return {
        id: "1",
        name: "CI",
        url: "https://github.com/o/r/actions/runs/1",
        state: jobs.some((j) => j.state === "failure") ? "failure" : "success",
        event: "push",
        actor: "octo",
        ref: "main",
        runNumber: 42,
        startedAt: "2026-11-07T12:00:00.000Z",
        completedAt: "2026-11-07T12:03:00.000Z",
        jobs,
        jobsCoverage: "full",
        ...overrides,
    };
}

function ciDetail(hash: string, overrides: Partial<CommitCiDetail> = {}): CommitCiDetail {
    return {
        hash,
        provider: "github",
        complete: true,
        outcome: "success",
        runs: [run([job("unit-tests", "success")])],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: TREE_CAPABILITIES,
        repoKey: "/repo",
        ...overrides,
    };
}

interface DetailRequest {
    type: "requestCommitCiDetail";
    requestId: number;
    repoKey: string;
    hash: string;
    force?: boolean;
}

function detailRequests(): DetailRequest[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([message]) => message as DetailRequest)
        .filter((message) => message.type === "requestCommitCiDetail");
}

function lastRequest(): DetailRequest {
    const requests = detailRequests();
    expect(requests.length, "a detail request was posted").toBeGreaterThan(0);
    return requests[requests.length - 1]!;
}

function reply(
    request: Pick<DetailRequest, "requestId" | "repoKey" | "hash">,
    detail: CommitCiDetail | null,
): void {
    act(() => {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    type: "commitCiDetail",
                    requestId: request.requestId,
                    repoKey: request.repoKey,
                    hash: request.hash,
                    detail,
                },
            }),
        );
    });
}

function pane(hash: string, props: Partial<React.ComponentProps<typeof CommitInfoPane>> = {}) {
    return (
        <CommitInfoPane detail={commit(hash)} ciRepoKey="/repo" commitChecksEnabled {...props} />
    );
}

function checksTab(container: HTMLElement): HTMLElement {
    const tab = container.querySelector<HTMLElement>('[data-testid="checks-tab"]');
    expect(tab, "the Checks tab body").not.toBeNull();
    return tab!;
}

function tabButton(container: HTMLElement, name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (candidate) => candidate.textContent?.trim() === name,
    );
    expect(button, `the ${name} tab`).toBeDefined();
    return button!;
}

function button(container: HTMLElement, label: RegExp): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((candidate) =>
        label.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? ""),
    );
}

function jobRow(container: HTMLElement, name: string): HTMLElement {
    const row = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="ci-job-row"]'),
    ).find((candidate) => candidate.getAttribute("data-name") === name);
    expect(row, `job row ${name}`).toBeDefined();
    return row!;
}

describe("Commit details Checks tab", () => {
    it("shows the tree for the selected commit", () => {
        const { container } = mount(pane(HASH_A));
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                otherChecks: [
                    {
                        name: "codecov/patch",
                        description: "90%",
                        state: "success",
                        source: "status",
                    },
                ],
            }),
        );

        const tab = checksTab(container);
        expect(tab.getAttribute("data-state")).toBe("detail");
        // Every run, job and step row shows state, duration and start time.
        const runRow = tab.querySelector('[data-testid="ci-run-row"]')?.textContent;
        expect(runRow).toContain("CI");
        expect(runRow, "run state").toContain("Passed");
        expect(runRow, "run duration").toContain("3m 00s");
        expect(runRow, "run start time").toContain(formatCiStart("2026-11-07T12:00:00.000Z"));
        expect(jobRow(container, "unit-tests").textContent).toContain("1m 05s");
        expect(jobRow(container, "unit-tests").textContent, "job start time").toContain(
            formatCiStart("2026-11-07T12:00:00.000Z"),
        );
        expect(tab.textContent).toContain("Other checks");
        expect(tab.querySelector('[data-testid="ci-check-row"]')?.textContent).toContain(
            "codecov/patch",
        );
        expect(tab.querySelector('[data-testid="ci-header"]')?.textContent).toContain(
            "push by octo · main · #42",
        );

        act(() => jobRow(container, "unit-tests").click());
        expect(tab.querySelector('[data-testid="ci-job-detail"]')?.textContent).toContain(
            "unit-tests",
        );
    });

    it("shows a spinner row while the detail loads", () => {
        const { container } = mount(pane(HASH_A));
        const tab = checksTab(container);
        expect(tab.getAttribute("data-state")).toBe("loading");
        const row = tab.querySelector<HTMLElement>('[data-testid="ci-loading-row"]');
        expect(row, "loading row").not.toBeNull();
        expect(row!.getAttribute("role")).toBe("status");
        expect(row!.textContent).toContain("Loading");
        const spinner = row!.querySelector<SVGElement>('[data-testid="ci-loading-spinner"]');
        expect(spinner, "spinner icon in the loading row").not.toBeNull();
        expect(spinner!.style.animation).toContain("intelligit-spin");

        reply(lastRequest(), ciDetail(HASH_A));
        expect(tab.querySelector('[data-testid="ci-loading-row"]')).toBeNull();
    });

    it("run line keeps placeholders when the provider omits a field", () => {
        const { container } = mount(pane(HASH_A));
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                runs: [run([job("unit-tests", "success")], { actor: undefined })],
            }),
        );
        expect(
            checksTab(container).querySelector('[data-testid="ci-header-run-line"]')?.textContent,
        ).toBe("push by — · main · #42");
    });

    it("run line stays hidden when the provider does not declare runHeader", () => {
        const { container } = mount(pane(HASH_A));
        reply(
            lastRequest(),
            ciDetail(HASH_A, { capabilities: { ...TREE_CAPABILITIES, runHeader: false } }),
        );
        const tab = checksTab(container);
        expect(
            tab.querySelector('[data-testid="ci-run-row"]'),
            "the run still renders",
        ).not.toBeNull();
        expect(
            tab.querySelector('[data-testid="ci-header-run-line"]'),
            "run header requires its capability",
        ).toBeNull();
        expect(tab.querySelector('[data-testid="ci-header"]')?.textContent).not.toContain("#42");
    });

    it("expands failed job to failing step", () => {
        const { container } = mount(pane(HASH_A));
        const steps = [
            { number: 1, name: "Checkout", state: "success" as const },
            {
                number: 2,
                name: "Run tests",
                state: "failure" as const,
                startedAt: "2026-11-07T12:00:30.000Z",
                completedAt: "2026-11-07T12:01:00.000Z",
            },
        ];
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                outcome: "failure",
                runs: [
                    run([
                        job("lint", "success", { steps }),
                        job("unit-tests", "failure", { steps }),
                    ]),
                ],
            }),
        );

        expect(jobRow(container, "unit-tests").getAttribute("aria-expanded")).toBe("true");
        expect(jobRow(container, "lint").getAttribute("aria-expanded")).toBe("false");
        const failingStep = container.querySelector<HTMLElement>(
            '[data-testid="ci-step-row"][data-failed="true"]',
        );
        expect(failingStep?.textContent).toContain("Run tests");
        // State, duration and start time, like the job row above it.
        expect(failingStep?.textContent).toContain("30s");
        expect(failingStep?.textContent, "step start time").toContain(
            formatCiStart("2026-11-07T12:00:30.000Z"),
        );
        expect(container.querySelector('[data-testid="ci-job-detail"]')?.textContent).toContain(
            "unit-tests",
        );
    });

    it("drops a detail reply for a commit that is no longer selected", () => {
        const { container, root } = mount(pane(HASH_A));
        const requestA = lastRequest();
        reply(requestA, ciDetail(HASH_A, { runs: [run([job("from-a", "success")])] }));
        expect(container.textContent).toContain("from-a");

        act(() => root.render(pane(HASH_B)));
        const requestB = lastRequest();
        expect(requestB.hash).toBe(HASH_B);
        expect(container.textContent).not.toContain("from-a");
        expect(checksTab(container).getAttribute("data-state")).toBe("loading");

        // A late reply for A, even one carrying the newest request id, is not B's answer.
        reply(requestA, ciDetail(HASH_A, { runs: [run([job("from-a", "success")])] }));
        reply(
            { ...requestB, hash: HASH_A },
            ciDetail(HASH_A, { runs: [run([job("from-a", "success")])] }),
        );
        expect(container.textContent).not.toContain("from-a");

        reply(requestB, ciDetail(HASH_B, { runs: [run([job("from-b", "success")])] }));
        expect(container.textContent).toContain("from-b");
    });

    it("A→B→A drops the first A reply", () => {
        const { container, root } = mount(pane(HASH_A));
        const first = lastRequest();
        act(() => root.render(pane(HASH_B)));
        act(() => root.render(pane(HASH_A)));
        const third = lastRequest();
        expect(third.requestId).toBeGreaterThan(first.requestId);

        reply(first, ciDetail(HASH_A, { runs: [run([job("stale-a", "success")])] }));
        expect(container.textContent).not.toContain("stale-a");
        expect(checksTab(container).getAttribute("data-state")).toBe("loading");

        reply(third, ciDetail(HASH_A, { runs: [run([job("fresh-a", "success")])] }));
        expect(container.textContent).toContain("fresh-a");
    });

    it("A→B→A after a rendered A waits for the newest A reply", () => {
        const { container, root } = mount(pane(HASH_A));
        reply(lastRequest(), ciDetail(HASH_A, { runs: [run([job("old-a", "success")])] }));
        expect(container.textContent).toContain("old-a");

        act(() => root.render(pane(HASH_B)));
        act(() => root.render(pane(HASH_A)));
        expect(
            checksTab(container).getAttribute("data-state"),
            "returning to A awaits its own reply",
        ).toBe("loading");
        expect(container.textContent).not.toContain("old-a");

        reply(lastRequest(), ciDetail(HASH_A, { runs: [run([job("new-a", "success")])] }));
        expect(container.textContent).toContain("new-a");
    });

    it("Refresh keeps the shown detail until its reply arrives", () => {
        const { container } = mount(pane(HASH_A));
        reply(lastRequest(), ciDetail(HASH_A, { runs: [run([job("before-refresh", "success")])] }));

        act(() => button(container, /^Refresh$/)!.click());
        expect(lastRequest().force).toBe(true);
        expect(container.textContent, "shown while Refresh runs").toContain("before-refresh");

        reply(lastRequest(), ciDetail(HASH_A, { runs: [run([job("after-refresh", "success")])] }));
        expect(container.textContent).toContain("after-refresh");
    });

    it("same-hash out-of-order refresh keeps the newest", () => {
        const { container } = mount(pane(HASH_A));
        reply(lastRequest(), ciDetail(HASH_A, { runs: [run([job("v1", "success")])] }));

        const refresh = button(container, /^Refresh$/);
        expect(refresh, "Refresh button").toBeDefined();
        act(() => refresh!.click());
        const second = lastRequest();
        act(() => refresh!.click());
        const third = lastRequest();
        expect(second.force).toBe(true);
        expect(third.requestId).toBeGreaterThan(second.requestId);

        reply(third, ciDetail(HASH_A, { runs: [run([job("v3", "success")])] }));
        reply(second, ciDetail(HASH_A, { runs: [run([job("v2", "success")])] }));
        expect(container.textContent).toContain("v3");
        expect(container.textContent).not.toContain("v2");
    });

    it("drops a reply whose request id is newer than the active request", () => {
        const { container } = mount(pane(HASH_A));
        const active = lastRequest();

        // No request with this id was sent from this pane, so it is not the newest request's answer.
        reply(
            { ...active, requestId: active.requestId + 1 },
            ciDetail(HASH_A, { runs: [run([job("unsolicited", "success")])] }),
        );
        expect(container.textContent, "an unsolicited newer reply is dropped").not.toContain(
            "unsolicited",
        );
        expect(checksTab(container).getAttribute("data-state")).toBe("loading");

        reply(active, ciDetail(HASH_A, { runs: [run([job("answer", "success")])] }));
        expect(container.textContent).toContain("answer");
    });

    it("same SHA in another repository is not reused", () => {
        const { container, root } = mount(pane(HASH_A));
        reply(lastRequest(), ciDetail(HASH_A, { runs: [run([job("repo-one", "success")])] }));
        expect(container.textContent).toContain("repo-one");

        act(() => root.render(pane(HASH_A, { ciRepoKey: "/other" })));
        const request = lastRequest();
        expect(request.repoKey).toBe("/other");
        expect(container.textContent).not.toContain("repo-one");

        reply(
            { ...request, repoKey: "/repo" },
            ciDetail(HASH_A, { runs: [run([job("repo-one", "success")])] }),
        );
        expect(container.textContent).not.toContain("repo-one");

        reply(
            request,
            ciDetail(HASH_A, { repoKey: "/other", runs: [run([job("repo-two", "success")])] }),
        );
        expect(container.textContent).toContain("repo-two");
    });

    it("a job picked on one commit does not carry over to another commit or repository", () => {
        const jobDetail = (container: HTMLElement) =>
            container.querySelector('[data-testid="ci-job-detail"]')?.textContent;
        // Job ids are unique only inside one commit, so the next commit may reuse "shared-id".
        const otherCommitRuns = (prefix: string) => [
            run([
                job(`unrelated-${prefix}`, "success", { id: "shared-id" }),
                job(`failed-${prefix}`, "failure"),
            ]),
        ];
        const { container, root } = mount(pane(HASH_A));
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                runs: [
                    run([
                        job("failed-a", "failure"),
                        job("picked-a", "success", { id: "shared-id" }),
                    ]),
                ],
            }),
        );
        act(() => jobRow(container, "picked-a").click());
        expect(jobDetail(container)).toContain("picked-a");

        act(() => root.render(pane(HASH_B)));
        reply(lastRequest(), ciDetail(HASH_B, { outcome: "failure", runs: otherCommitRuns("b") }));
        expect(jobDetail(container), "commit B opens its first failed job").toContain("failed-b");

        act(() => jobRow(container, "unrelated-b").click());
        act(() => root.render(pane(HASH_B, { ciRepoKey: "/other" })));
        reply(
            lastRequest(),
            ciDetail(HASH_B, { repoKey: "/other", outcome: "failure", runs: otherCommitRuns("o") }),
        );
        expect(jobDetail(container), "another repository opens its first failed job").toContain(
            "failed-o",
        );
    });

    it("no detail request while the Files tab is active", () => {
        mockVscodeApi.getState.mockReturnValue(undefined);
        const { container } = mount(pane(HASH_A));
        expect(tabButton(container, "Files").getAttribute("aria-selected")).toBe("true");
        expect(detailRequests()).toHaveLength(0);
        expect(container.querySelector('[data-testid="checks-tab"]')).toBeNull();

        act(() => tabButton(container, "Checks").click());
        expect(detailRequests()).toHaveLength(1);
    });

    it("hiding the Checks tab or the pane cancels the host's re-posts for the newest request", () => {
        const cancels = () =>
            mockVscodeApi.postMessage.mock.calls
                .map(([message]) => message as { type: string; requestId?: number })
                .filter((message) => message.type === "cancelCommitCiDetail");
        const { container, root } = mount(pane(HASH_A));
        const shown = lastRequest();
        expect(cancels()).toEqual([]);

        act(() => tabButton(container, "Files").click());
        expect(cancels()).toEqual([{ type: "cancelCommitCiDetail", requestId: shown.requestId }]);

        act(() => tabButton(container, "Checks").click());
        const reshown = lastRequest();
        expect(reshown.requestId).toBeGreaterThan(shown.requestId);
        act(() => root.unmount());
        expect(cancels().at(-1)).toEqual({
            type: "cancelCommitCiDetail",
            requestId: reshown.requestId,
        });
    });

    it("floor provider renders flat list without dead controls", () => {
        const { container } = mount(pane(HASH_A));
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                provider: "bitbucket-server",
                capabilities: NO_CI_CAPABILITIES,
                runs: [],
                otherChecks: [
                    {
                        name: "build #12",
                        description: "Passed",
                        state: "success",
                        source: "build",
                        durationMs: 125_000,
                    },
                    {
                        name: "deploy",
                        description: "",
                        state: "failure",
                        source: "build",
                        durationMs: null,
                    },
                ],
            }),
        );

        const tab = checksTab(container);
        const rows = Array.from(tab.querySelectorAll<HTMLElement>('[data-testid="ci-check-row"]'));
        expect(rows).toHaveLength(2);
        expect(
            rows.map((row) => row.querySelector('[data-testid="ci-check-duration"]')?.textContent),
        ).toEqual(["2m 05s", "—"]);
        expect(tab.textContent).not.toContain("Other checks");
        expect(tab.querySelector('[data-testid="ci-run-row"]')).toBeNull();
        expect(tab.querySelector('[data-testid="ci-step-row"]')).toBeNull();
        expect(tab.querySelector('[data-testid="ci-header-run-line"]')).toBeNull();
        expect(button(tab, /log|re-run|cancel/i)).toBeUndefined();
        expect(button(tab, /^Refresh$/)).toBeDefined();
    });

    it("a provider without steps shows no steps, even when a run carries them", () => {
        const { container } = mount(pane(HASH_A));
        const steps = [{ number: 1, name: "Run tests", state: "failure" as const }];
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                outcome: "failure",
                capabilities: { ...TREE_CAPABILITIES, steps: false },
                runs: [run([job("unit-tests", "failure", { steps })])],
            }),
        );

        const tab = checksTab(container);
        expect(jobRow(container, "unit-tests").getAttribute("aria-expanded")).toBeNull();
        expect(tab.querySelector('[data-testid="ci-step-row"]'), "step row").toBeNull();
        expect(tab.querySelector('[data-testid="ci-job-detail"]')?.textContent).toContain(
            "unit-tests",
        );
        expect(
            tab.querySelector('[data-testid="ci-job-detail"] ol'),
            "job detail steps",
        ).toBeNull();
    });

    it("renders signed-out, unavailable and cooldown states", () => {
        const { container, root } = mount(pane(HASH_A));
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                outcome: "unavailable",
                runs: [],
                error: "Sign in to gitlab.example.com to see checks",
                signInHost: "gitlab.example.com",
            }),
        );
        expect(checksTab(container).getAttribute("data-state")).toBe("signedOut");
        const signIn = button(container, /^Sign in$/);
        expect(signIn, "Sign in button").toBeDefined();
        act(() => signIn!.click());
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "signInForCommitChecks",
            host: "gitlab.example.com",
        });

        act(() => root.render(pane(HASH_B)));
        reply(
            lastRequest(),
            ciDetail(HASH_B, { outcome: "unavailable", runs: [], error: "connect ECONNREFUSED" }),
        );
        expect(checksTab(container).getAttribute("data-state")).toBe("unavailable");
        expect(checksTab(container).textContent).toContain("connect ECONNREFUSED");
        expect(button(container, /^Refresh$/)).toBeDefined();

        act(() => root.render(pane(HASH_A)));
        const cooldown = "Commit-check requests are temporarily paused due to rate limiting.";
        reply(
            lastRequest(),
            ciDetail(HASH_A, { outcome: "unavailable", runs: [], error: cooldown }),
        );
        expect(checksTab(container).textContent).toContain(cooldown);

        act(() => root.render(pane(HASH_B)));
        reply(lastRequest(), null);
        expect(checksTab(container).getAttribute("data-state")).toBe("none");
        expect(checksTab(container).textContent).toContain("No CI checks for this commit");

        mockVscodeApi.postMessage.mockReset();
        act(() => root.render(pane(HASH_A, { commitChecksEnabled: false })));
        expect(checksTab(container).getAttribute("data-state")).toBe("disabled");
        expect(detailRequests()).toHaveLength(0);
        act(() => button(container, /settings/i)!.click());
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openCommitChecksSettings",
        });
    });

    it("partial coverage shows the open-in-browser note", () => {
        const { container } = mount(pane(HASH_A));
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                runs: [
                    run([job("shard-1", "success")], {
                        jobsCoverage: { reason: "pageBound", shown: 1000 },
                    }),
                    run([job("other", "success")], {
                        id: "2",
                        name: "Release",
                        url: "https://github.com/o/r/actions/runs/2",
                        jobsCoverage: { reason: "rejectedNext", shown: 100 },
                    }),
                ],
            }),
        );

        const notes = Array.from(
            container.querySelectorAll<HTMLElement>('[data-testid="ci-coverage-note"]'),
        );
        expect(notes.map((note) => note.textContent)).toEqual([
            expect.stringContaining(
                "Showing the first 1000 jobs — open the run in the browser for the rest",
            ),
            expect.stringContaining(
                "Showing the first 100 jobs — the provider's next-page link was refused",
            ),
        ]);
        act(() => button(notes[0]!, /Open in browser/)!.click());
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openCommitCheckUrl",
            url: "https://github.com/o/r/actions/runs/1",
        });
    });

    it("failed jobs past the first 1 000 are listed", () => {
        const { container } = mount(pane(HASH_A));
        const bounded = Array.from({ length: 1000 }, (_, index) =>
            job(`shard-${index}`, "success"),
        );
        reply(
            lastRequest(),
            ciDetail(HASH_A, {
                outcome: "failure",
                runs: [
                    run(
                        [...bounded, job("late-fail-1", "failure"), job("late-fail-2", "failure")],
                        {
                            jobsCoverage: { reason: "pageBound", shown: 1000 },
                            failedScan: { state: "done", found: 2 },
                        },
                    ),
                ],
            }),
        );

        expect(jobRow(container, "late-fail-1")).toBeDefined();
        expect(jobRow(container, "late-fail-2")).toBeDefined();
    });

    it("overflow scan paused shows the paused note", () => {
        const { container, root } = mount(pane(HASH_A));
        const scanned = (state: "running" | "paused" | "stopped") =>
            ciDetail(HASH_A, {
                outcome: "failure",
                complete: true,
                runs: [
                    run([job("unit-tests", "failure")], {
                        jobsCoverage: { reason: "pageBound", shown: 1000 },
                        failedScan: {
                            state,
                            found: 1,
                            ...(state === "stopped" ? { error: "HTTP 500" } : {}),
                        },
                    }),
                ],
            });
        const request = lastRequest();
        reply(request, scanned("paused"));
        const scanNote = () => container.querySelector('[data-testid="ci-scan-note"]')?.textContent;
        expect(scanNote()).toContain("Loading more failed jobs — paused for rate limit");
        expect(jobRow(container, "unit-tests")).toBeDefined();

        // The host re-posts after each scan page with the same request id.
        reply(request, scanned("running"));
        expect(scanNote()).toContain("Loading more failed jobs…");
        reply(request, scanned("stopped"));
        expect(scanNote()).toContain("Could not load more failed jobs");
        act(() => root.render(pane(HASH_A)));
    });

    it("tab choice persists", () => {
        mockVscodeApi.getState.mockReturnValue({ branchColumn: { scrollTop: 7 } });
        const { container } = mount(pane(HASH_A));
        act(() => tabButton(container, "Checks").click());
        expect(mockVscodeApi.setState).toHaveBeenLastCalledWith({
            branchColumn: { scrollTop: 7 },
            commitInfoTab: "checks",
        });

        mockVscodeApi.getState.mockReturnValue({ commitInfoTab: "checks" });
        const restored = mount(pane(HASH_A));
        expect(tabButton(restored.container, "Checks").getAttribute("aria-selected")).toBe("true");
    });

    it("re-polls incomplete detail on the pending ladder and never retries a failed fetch", () => {
        vi.useFakeTimers();
        try {
            const { root } = mount(pane(HASH_A));
            reply(lastRequest(), ciDetail(HASH_A, { complete: false, outcome: "pending" }));
            const before = detailRequests().length;
            act(() => vi.advanceTimersByTime(PENDING_CHECK_RETRY_DELAYS_MS[0]));
            expect(detailRequests().length).toBe(before + 1);
            expect(lastRequest().force).toBeUndefined();

            act(() => root.render(pane(HASH_B)));
            reply(
                lastRequest(),
                ciDetail(HASH_B, { outcome: "unavailable", complete: false, runs: [], error: "x" }),
            );
            const afterFailure = detailRequests().length;
            act(() => vi.advanceTimersByTime(10 * 60_000));
            expect(detailRequests().length).toBe(afterFailure);
        } finally {
            vi.useRealTimers();
        }
    });

    it("review: a failed forced Refresh of pending detail is not retried automatically", () => {
        vi.useFakeTimers();
        try {
            const { container } = mount(pane(HASH_A));
            reply(lastRequest(), ciDetail(HASH_A, { complete: false, outcome: "pending" }));
            const refresh = button(container, /^Refresh$/);
            expect(refresh, "Refresh button").toBeDefined();
            act(() => refresh!.click());
            const forced = lastRequest();
            expect(forced.force).toBe(true);

            // The host keeps the previous pending detail and reports the failed fetch beside it.
            reply(
                forced,
                ciDetail(HASH_A, { complete: false, outcome: "pending", refreshError: "HTTP 502" }),
            );
            expect(container.textContent).toContain("HTTP 502");
            const afterFailure = detailRequests().length;
            act(() => vi.advanceTimersByTime(10 * 60_000));
            expect(detailRequests().length, "requests after a failed forced Refresh").toBe(
                afterFailure,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("complete detail is not re-polled", () => {
        vi.useFakeTimers();
        try {
            mount(pane(HASH_A));
            reply(lastRequest(), ciDetail(HASH_A, { complete: true, outcome: "success" }));
            const afterComplete = detailRequests().length;
            act(() => vi.advanceTimersByTime(10 * 60_000));
            expect(detailRequests().length, "detail requests after a complete reply").toBe(
                afterComplete,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("each incomplete reply waits for the next rung before asking again, with a new request id", () => {
        vi.useFakeTimers();
        try {
            mount(pane(HASH_A));
            const first = lastRequest();
            reply(first, ciDetail(HASH_A, { complete: false, outcome: "pending" }));
            act(() => vi.advanceTimersByTime(PENDING_CHECK_RETRY_DELAYS_MS[0] - 1));
            expect(detailRequests(), "requests before the first rung").toHaveLength(1);
            act(() => vi.advanceTimersByTime(1));
            const second = lastRequest();
            expect(detailRequests(), "requests after the first rung").toHaveLength(2);
            expect(second.requestId).toBeGreaterThan(first.requestId);
            expect(second).toMatchObject({ repoKey: "/repo", hash: HASH_A });

            reply(second, ciDetail(HASH_A, { complete: false, outcome: "pending" }));
            act(() => vi.advanceTimersByTime(PENDING_CHECK_RETRY_DELAYS_MS[1] - 1));
            expect(detailRequests(), "requests before the second rung").toHaveLength(2);
            act(() => vi.advanceTimersByTime(1));
            expect(detailRequests(), "requests after the second rung").toHaveLength(3);
            expect(lastRequest().requestId).toBeGreaterThan(second.requestId);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a commit with no checks is not re-polled", () => {
        vi.useFakeTimers();
        try {
            mount(pane(HASH_A));
            reply(lastRequest(), ciDetail(HASH_A, { complete: false, outcome: "none", runs: [] }));
            act(() => vi.advanceTimersByTime(Math.max(...PENDING_CHECK_RETRY_DELAYS_MS)));
            expect(detailRequests(), "requests after a no-checks reply").toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("leaving the Checks tab stops the pending re-poll", () => {
        vi.useFakeTimers();
        try {
            const { container } = mount(pane(HASH_A));
            reply(lastRequest(), ciDetail(HASH_A, { complete: false, outcome: "pending" }));
            act(() => tabButton(container, "Files").click());
            act(() => vi.advanceTimersByTime(Math.max(...PENDING_CHECK_RETRY_DELAYS_MS)));
            expect(detailRequests(), "requests after leaving the Checks tab").toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a sign-in or sign-out drops the shown detail and asks again", () => {
        const { container } = mount(pane(HASH_A));
        const first = lastRequest();
        reply(first, ciDetail(HASH_A, { runs: [run([job("old-account", "success")])] }));
        expect(container.textContent).toContain("old-account");

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: "commitCiDetailInvalidated" } }),
            );
        });
        expect(container.textContent, "the previous account's detail").not.toContain("old-account");
        expect(checksTab(container).getAttribute("data-state")).toBe("loading");
        const again = lastRequest();
        expect(again.requestId).toBeGreaterThan(first.requestId);
        expect(again).toMatchObject({ repoKey: "/repo", hash: HASH_A });

        // A late reply to the request made before the change is still refused.
        reply(first, ciDetail(HASH_A, { runs: [run([job("old-account", "success")])] }));
        expect(container.textContent).not.toContain("old-account");
        reply(again, ciDetail(HASH_A, { runs: [run([job("new-account", "success")])] }));
        expect(container.textContent).toContain("new-account");
    });
});
