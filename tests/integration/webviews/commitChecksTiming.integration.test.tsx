// @vitest-environment jsdom
// Checks tab timing (PLAN.md Phase 10, K14, K15, K23): a running item's elapsed time ticks
// once a second in the webview with no request, the tick stops when nothing runs, and the
// "usually" hint reads from the previous run's duration or says it is unknown.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiJob, CiRun, CommitCiDetail } from "../../../src/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { CheckTree } from "../../../src/webviews/react/commit-info/checks/CheckTree";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const START = Date.parse("2026-11-14T12:00:00.000Z");

beforeEach(() => {
    installWebviewI18n();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

function job(state: CiJob["state"], overrides: Partial<CiJob> = {}): CiJob {
    return {
        id: "build",
        logicalId: "CI\0build",
        name: "build",
        checkName: "build",
        state,
        startedAt: new Date(START).toISOString(),
        steps: [],
        ...overrides,
    };
}

function run(jobs: CiJob[], overrides: Partial<CiRun> = {}): CiRun {
    return {
        id: "7",
        name: "CI",
        state: jobs.some((j) => j.state === "running") ? "running" : "success",
        startedAt: new Date(START).toISOString(),
        jobs,
        jobsCoverage: "full",
        ...overrides,
    };
}

function detail(runs: CiRun[]): CommitCiDetail {
    return {
        hash: "a".repeat(40),
        provider: "github",
        complete: !runs.some((r) => r.state === "running"),
        outcome: "pending",
        runs,
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true, usualDuration: true },
        repoKey: "/repo",
    };
}

function tree(value: CommitCiDetail): React.ReactElement {
    return (
        <CheckTree
            detail={value}
            selectedJobId={null}
            onSelectJob={() => undefined}
            onOpenUrl={() => undefined}
            onRefresh={() => undefined}
        />
    );
}

function jobRow(container: HTMLElement): HTMLElement {
    const row = container.querySelector<HTMLElement>('[data-testid="ci-job-row"]');
    expect(row, "the job row is rendered").not.toBeNull();
    return row!;
}

function elapsedOf(row: HTMLElement): string {
    return row.querySelector('[data-testid="ci-elapsed"]')?.textContent ?? "";
}

describe("Checks tab timing", () => {
    it("elapsed ticks with fake timers", () => {
        vi.setSystemTime(START + 10_000);
        const { container } = mount(tree(detail([run([job("running")])])));

        expect(elapsedOf(jobRow(container))).toBe("10s");
        act(() => {
            vi.advanceTimersByTime(1_000);
        });
        expect(elapsedOf(jobRow(container))).toBe("11s");
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(elapsedOf(jobRow(container))).toBe("1m 11s");
        const runRow = container.querySelector<HTMLElement>('[data-testid="ci-run-row"]')!;
        expect(elapsedOf(runRow)).toBe("1m 11s");
    });

    it("overdue appears once elapsed passes 1.5 times the usual duration", () => {
        vi.setSystemTime(START + 89_000);
        const { container } = mount(
            tree(detail([run([job("running", { usualDurationMs: 60_000 })])])),
        );
        const row = jobRow(container);
        expect(row.textContent).toContain("usually ~1m 00s");
        expect(row.querySelector('[data-testid="ci-tag-overdue"]')).toBeNull();

        act(() => {
            vi.advanceTimersByTime(2_000);
        });
        expect(jobRow(container).querySelector('[data-testid="ci-tag-overdue"]')?.textContent).toBe(
            "overdue",
        );
    });

    it("timer cleared when complete", () => {
        vi.setSystemTime(START + 5_000);
        const { root, container } = mount(tree(detail([run([job("running")])])));
        expect(vi.getTimerCount()).toBe(1);

        const finished = job("success", { completedAt: new Date(START + 30_000).toISOString() });
        act(() => {
            root.render(tree(detail([run([finished], { state: "success" })])));
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(jobRow(container).querySelector('[data-testid="ci-usually"]')).toBeNull();

        act(() => {
            root.render(tree(detail([run([job("running")])])));
        });
        expect(vi.getTimerCount()).toBe(1);
        act(() => {
            root.unmount();
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("usually: unknown shown for null", () => {
        vi.setSystemTime(START + 5_000);
        const { container } = mount(
            tree(
                detail([
                    run([job("running", { usualDurationMs: null })], { usualDurationMs: null }),
                ]),
            ),
        );
        const row = jobRow(container);
        expect(row.querySelector('[data-testid="ci-usually"]')?.textContent).toBe(
            "usually: unknown",
        );
        expect(row.querySelector('[data-testid="ci-tag-overdue"]')).toBeNull();
        const runRow = container.querySelector<HTMLElement>('[data-testid="ci-run-row"]')!;
        expect(runRow.querySelector('[data-testid="ci-usually"]')?.textContent).toBe(
            "usually: unknown",
        );
    });

    it("a running run whose jobs are all queued still ticks", () => {
        vi.setSystemTime(START + 10_000);
        const queued = job("queued", { startedAt: undefined });
        const { container } = mount(tree(detail([run([queued], { state: "running" })])));
        const runRow = () => container.querySelector<HTMLElement>('[data-testid="ci-run-row"]')!;

        expect(elapsedOf(runRow())).toBe("10s");
        act(() => {
            vi.advanceTimersByTime(1_000);
        });
        expect(elapsedOf(runRow()), "the run's elapsed time moves on its own").toBe("11s");
    });

    it("a queued job shows its usual time", () => {
        vi.setSystemTime(START + 5_000);
        const queued = job("queued", { startedAt: undefined, usualDurationMs: 60_000 });
        const { container } = mount(tree(detail([run([queued], { state: "running" })])));

        expect(
            jobRow(container).querySelector('[data-testid="ci-usually"]')?.textContent,
            "a queued job says how long it usually takes",
        ).toBe("usually ~1m 00s");
    });

    it("shows no usually hint when the provider was never asked", () => {
        vi.setSystemTime(START + 5_000);
        const { container } = mount(tree(detail([run([job("running")])])));
        expect(container.querySelector('[data-testid="ci-usually"]')).toBeNull();
    });
});
