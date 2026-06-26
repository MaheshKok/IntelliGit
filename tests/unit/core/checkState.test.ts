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
import { shouldRequestCommitChecks } from "../../../src/webviews/react/commit-list/checksRefresh";

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

// States the webview re-requests: the non-terminal pair plus "unavailable",
// which is recoverable (a sign-in, or a transient 429 that clears after the
// coordinator TTL) and so must be re-asked even though it is not "pending".
const REQUESTABLE: CommitCheckState[] = ["pending", "none", "unavailable"];

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

    it("requests for a recoverable unavailable snapshot", () => {
        // "unavailable" is terminal for isPendingCheckState but recoverable: a
        // sign-in or a TTL-expired 429 can flip it to a real state, so the
        // webview must keep re-asking (the coordinator TTL throttles the fetch).
        expect(shouldRequestCommitChecks(snapshot("unavailable"))).toBe(true);
    });

    it("does not request for genuinely terminal cached snapshots", () => {
        const terminal = ALL_STATES.filter((state) => !REQUESTABLE.includes(state));
        for (const state of terminal) {
            expect(shouldRequestCommitChecks(snapshot(state))).toBe(false);
        }
    });
});
