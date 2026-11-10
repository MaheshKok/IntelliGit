import { describe, expect, it } from "vitest";
import {
    hasUnfinishedWork,
    isCompleteDetail,
    isCompleteSnapshot,
    isFullyCovered,
    settlementOf,
} from "../../../../src/shared/ci/completion";
import type {
    CiRun,
    CommitCheckItem,
    CommitChecksSnapshot,
    CommitCiDetailData,
} from "../../../../src/types";

function item(state: CommitCheckItem["state"], name = state): CommitCheckItem {
    return { name, description: "", state, source: "check-run" };
}

function snapshot(
    state: CommitChecksSnapshot["state"],
    items: CommitCheckItem[] = [],
): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: state, items };
}

function run(overrides: Partial<CiRun> = {}): CiRun {
    return {
        id: "1",
        name: "ci",
        state: "success",
        jobs: [],
        jobsCoverage: "full",
        ...overrides,
    };
}

function detail(overrides: Partial<CommitCiDetailData> = {}): CommitCiDetailData {
    return {
        hash: "abc1234",
        provider: "github",
        complete: true,
        outcome: "success",
        runs: [run()],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        ...overrides,
    };
}

describe("isCompleteSnapshot", () => {
    it("failure with a pending item is not complete", () => {
        // aggregateState reports `failure` as soon as one item failed, even while
        // another is still running; completion must look at the items too.
        expect(isCompleteSnapshot(snapshot("failure", [item("failure"), item("pending")]))).toBe(
            false,
        );
        expect(isCompleteSnapshot(snapshot("failure", [item("failure"), item("success")]))).toBe(
            true,
        );
    });

    it("none and unavailable are not complete", () => {
        expect(isCompleteSnapshot(snapshot("none"))).toBe(false);
        expect(isCompleteSnapshot(snapshot("unavailable"))).toBe(false);
        expect(isCompleteSnapshot(snapshot("pending", [item("pending")]))).toBe(false);
        expect(isCompleteSnapshot(snapshot("success", [item("success")]))).toBe(true);
        expect(isCompleteSnapshot(snapshot("cancelled", [item("cancelled")]))).toBe(true);
    });
});

describe("hasUnfinishedWork", () => {
    it("a pending flat check is unfinished work while every run and job has finished", () => {
        const finished = [run({ jobs: [] })];
        const flat = (state: CommitCheckItem["state"]) => [{ ...item(state), id: "7" }];
        expect(hasUnfinishedWork(finished, flat("pending")), "a pending status").toBe(true);
        expect(hasUnfinishedWork(finished, flat("success"))).toBe(false);
        expect(hasUnfinishedWork(finished, [])).toBe(false);
    });
});

describe("isFullyCovered", () => {
    it("isFullyCovered is false when any run, jobs, attempt or otherChecks coverage is not full", () => {
        const bound = { reason: "pageBound", shown: 1000 } as const;
        expect(isFullyCovered(detail())).toBe(true);
        expect(isFullyCovered(detail({ runsCoverage: bound }))).toBe(false);
        expect(
            isFullyCovered(detail({ runs: [run(), run({ id: "2", jobsCoverage: bound })] })),
        ).toBe(false);
        expect(
            isFullyCovered(
                detail({
                    attemptHistory: [
                        { runId: "1", logicalId: "w\0j", attempts: [], coverage: "full" },
                        {
                            runId: "1",
                            logicalId: "w\0k",
                            attempts: [],
                            coverage: { reason: "rejectedNext", shown: 3 },
                        },
                    ],
                }),
            ),
        ).toBe(false);
        expect(isFullyCovered(detail({ otherChecksCoverage: bound }))).toBe(false);
    });
});

describe("settlementOf", () => {
    it("settlementOf is unknown when runsCoverage is pageBound even if every returned item finished", () => {
        const d = detail({ complete: true, runsCoverage: { reason: "pageBound", shown: 1000 } });
        expect(settlementOf(d)).toBe("unknown");
        expect(isCompleteDetail(d)).toBe(false);
    });

    it("settlementOf is unknown when otherChecksCoverage is pageBound", () => {
        const d = detail({
            complete: true,
            otherChecksCoverage: { reason: "pageBound", shown: 125 },
        });
        expect(settlementOf(d)).toBe("unknown");
        expect(isCompleteDetail(d)).toBe(false);
    });

    it("a capped job list alone does not make settlement unknown", () => {
        const d = detail({ runs: [run({ jobsCoverage: { reason: "pageBound", shown: 1000 } })] });
        expect(settlementOf(d)).toBe("settled");
    });

    it("settles only when execution is complete", () => {
        expect(settlementOf(detail({ complete: false }))).toBe("pending");
        expect(isCompleteDetail(detail({ complete: false }))).toBe(false);
        expect(settlementOf(detail())).toBe("settled");
        expect(isCompleteDetail(detail())).toBe(true);
    });
});
