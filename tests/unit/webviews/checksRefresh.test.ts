import { describe, expect, it } from "vitest";
import * as shared from "../../../src/shared/ci/pollSchedule";
import {
    HEAD_NONE_CHECK_RETRY_DELAYS_MS,
    MAX_COMMIT_CHECK_RETRIES_PER_HASH,
    PENDING_CHECK_RETRY_DELAYS_MS,
    retryDelaysForCommitChecks,
} from "../../../src/webviews/react/commit-list/checksRefresh";
import type { CommitCheckItem, CommitChecksSnapshot } from "../../../src/types";

function item(state: CommitCheckItem["state"]): CommitCheckItem {
    return { name: state, description: "", state, source: "check-run" };
}

function snapshot(
    state: CommitChecksSnapshot["state"],
    items: CommitCheckItem[] = [],
): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: state, items };
}

const visible = { isCurrentHead: false, isUnpushed: false };
const pushedHead = { isCurrentHead: true, isUnpushed: false };

describe("retryDelaysForCommitChecks", () => {
    it("unavailable gets no schedule", () => {
        expect(retryDelaysForCommitChecks(snapshot("unavailable"), pushedHead)).toEqual([]);
        expect(retryDelaysForCommitChecks(snapshot("unavailable"), visible)).toEqual([]);
    });

    it("incomplete failure keeps the ladder", () => {
        const runningFailure = snapshot("failure", [item("failure"), item("pending")]);
        expect(retryDelaysForCommitChecks(runningFailure, visible)).toBe(
            PENDING_CHECK_RETRY_DELAYS_MS,
        );
        const settledFailure = snapshot("failure", [item("failure"), item("success")]);
        expect(retryDelaysForCommitChecks(settledFailure, visible)).toEqual([]);
    });

    it("keeps today's schedule for every other input", () => {
        expect(retryDelaysForCommitChecks(snapshot("pending", [item("pending")]), visible)).toBe(
            PENDING_CHECK_RETRY_DELAYS_MS,
        );
        expect(retryDelaysForCommitChecks(snapshot("pending"), visible)).toBe(
            PENDING_CHECK_RETRY_DELAYS_MS,
        );
        expect(retryDelaysForCommitChecks(snapshot("none"), pushedHead)).toBe(
            HEAD_NONE_CHECK_RETRY_DELAYS_MS,
        );
        expect(
            retryDelaysForCommitChecks(snapshot("none"), { isCurrentHead: true, isUnpushed: true }),
        ).toEqual([]);
        expect(retryDelaysForCommitChecks(snapshot("none"), visible)).toEqual([]);
        expect(retryDelaysForCommitChecks(snapshot("success", [item("success")]), visible)).toEqual(
            [],
        );
    });

    it("re-exports are identical", () => {
        expect(PENDING_CHECK_RETRY_DELAYS_MS).toBe(shared.PENDING_CHECK_RETRY_DELAYS_MS);
        expect(HEAD_NONE_CHECK_RETRY_DELAYS_MS).toBe(shared.HEAD_NONE_CHECK_RETRY_DELAYS_MS);
        expect(MAX_COMMIT_CHECK_RETRIES_PER_HASH).toBe(shared.MAX_COMMIT_CHECK_RETRIES_PER_HASH);
        // Values unchanged from the ladder before the move (K11).
        expect([...PENDING_CHECK_RETRY_DELAYS_MS]).toEqual([
            3_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 120_000,
        ]);
        expect([...HEAD_NONE_CHECK_RETRY_DELAYS_MS]).toEqual([3_000, 5_000, 10_000, 30_000]);
        expect(MAX_COMMIT_CHECK_RETRIES_PER_HASH).toBe(20);
    });
});
