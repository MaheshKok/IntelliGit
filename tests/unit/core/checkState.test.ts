// Unit tests for the commit-check "not settled yet" predicates that drive
// auto-refresh. These guard the single source of truth shared by the host and
// the webview: a snapshot is re-fetched while "pending" or "none", and never
// once it reaches a terminal state. Adversarial over every CommitCheckState.

import { describe, expect, it } from "vitest";
import {
    isPendingCheckState,
    type CommitCheckState,
    type CommitChecksSnapshot,
} from "../../../src/types";
import {
    commitChecksSnapshotEqual,
    shouldRequestCommitChecks,
} from "../../../src/webviews/react/commit-list/checksRefresh";

const ALL_STATES: CommitCheckState[] = [
    "success",
    "failure",
    "pending",
    "skipped",
    "neutral",
    "cancelled",
    "timed_out",
    "action_required",
    "unknown",
    "none",
    "unavailable",
];

const NON_TERMINAL: CommitCheckState[] = ["pending", "none"];

function snapshot(state: CommitCheckState): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: "", items: [] };
}

describe("isPendingCheckState", () => {
    it("treats pending and none as not-yet-settled", () => {
        expect(isPendingCheckState("pending")).toBe(true);
        expect(isPendingCheckState("none")).toBe(true);
    });

    it("treats every other state as terminal", () => {
        const terminal = ALL_STATES.filter((state) => !NON_TERMINAL.includes(state));
        for (const state of terminal) {
            expect(isPendingCheckState(state)).toBe(false);
        }
    });
});

describe("shouldRequestCommitChecks", () => {
    it("requests when nothing is cached", () => {
        expect(shouldRequestCommitChecks(undefined)).toBe(true);
    });

    it("does not request while a fetch is already in flight", () => {
        expect(shouldRequestCommitChecks("loading")).toBe(false);
    });

    it("requests for non-terminal cached snapshots", () => {
        for (const state of NON_TERMINAL) {
            expect(shouldRequestCommitChecks(snapshot(state))).toBe(true);
        }
    });

    it("does not request for terminal cached snapshots", () => {
        const terminal = ALL_STATES.filter((state) => !NON_TERMINAL.includes(state));
        for (const state of terminal) {
            expect(shouldRequestCommitChecks(snapshot(state))).toBe(false);
        }
    });
});

describe("commitChecksSnapshotEqual", () => {
    function withItem(
        overrides: Partial<CommitChecksSnapshot["items"][number]> = {},
    ): CommitChecksSnapshot {
        return {
            hash: "abc1234",
            state: "success",
            summary: "1 passed",
            items: [
                {
                    name: "build",
                    description: "passed",
                    state: "success",
                    source: "check-run",
                    url: "https://ci/build",
                    ...overrides,
                },
            ],
        };
    }

    it("treats identical snapshots as equal", () => {
        expect(commitChecksSnapshotEqual(withItem(), withItem())).toBe(true);
    });

    it("treats two empty-item snapshots of the same state as equal", () => {
        expect(commitChecksSnapshotEqual(snapshot("none"), snapshot("none"))).toBe(true);
    });

    it("differs when the aggregate state changes", () => {
        const a = withItem();
        const b = { ...withItem(), state: "failure" as const };
        expect(commitChecksSnapshotEqual(a, b)).toBe(false);
    });

    it("differs when the summary changes", () => {
        const a = withItem();
        const b = { ...withItem(), summary: "1 failed" };
        expect(commitChecksSnapshotEqual(a, b)).toBe(false);
    });

    it("differs when the error field changes", () => {
        const a = withItem();
        const b = { ...withItem(), error: "rate limited" };
        expect(commitChecksSnapshotEqual(a, b)).toBe(false);
    });

    it("differs when the item count changes", () => {
        const a = withItem();
        const b: CommitChecksSnapshot = { ...withItem(), items: [] };
        expect(commitChecksSnapshotEqual(a, b)).toBe(false);
    });

    it("differs when an item's state changes but order is preserved", () => {
        expect(commitChecksSnapshotEqual(withItem(), withItem({ state: "pending" }))).toBe(false);
    });

    it("differs when an item's url changes", () => {
        expect(commitChecksSnapshotEqual(withItem(), withItem({ url: "https://ci/other" }))).toBe(
            false,
        );
    });
});
