import { isCompleteSnapshot } from "../../../shared/ci/completion";
import {
    HEAD_NONE_CHECK_RETRY_DELAYS_MS,
    PENDING_CHECK_RETRY_DELAYS_MS,
} from "../../../shared/ci/pollSchedule";
import { isPendingCheckState, type CommitChecksSnapshot } from "../../../types";

export {
    HEAD_NONE_CHECK_RETRY_DELAYS_MS,
    MAX_COMMIT_CHECK_RETRIES_PER_HASH,
    PENDING_CHECK_RETRY_DELAYS_MS,
} from "../../../shared/ci/pollSchedule";

const MIN_GIT_ABBREVIATION_LENGTH = 7;

/**
 * Compares full or Git-produced abbreviated commit hashes.
 *
 * Exact values always match. Prefix matching requires the shorter value to
 * meet Git's minimum abbreviation length so malformed tiny prefixes cannot
 * identify an unrelated commit.
 */
export function commitHashesMatch(first: string, second: string): boolean {
    if (first === second) return true;
    const [shorter, longer] = first.length < second.length ? [first, second] : [second, first];
    return shorter.length >= MIN_GIT_ABBREVIATION_LENGTH && longer.startsWith(shorter);
}

/**
 * Selects the bounded retry schedule for a visible commit-check snapshot.
 *
 * Pending CI retries regardless of branch position, and so does a failure whose
 * other checks are still running. A `none` snapshot retries only for the pushed
 * current local HEAD; unavailable and complete snapshots never schedule automatic
 * requests.
 */
export function retryDelaysForCommitChecks(
    snapshot: CommitChecksSnapshot,
    options: { isCurrentHead: boolean; isUnpushed: boolean },
): readonly number[] {
    const { state } = snapshot;
    if (state !== "none" && state !== "unavailable" && !isCompleteSnapshot(snapshot)) {
        return PENDING_CHECK_RETRY_DELAYS_MS;
    }
    if (state === "none" && options.isCurrentHead && !options.isUnpushed) {
        return HEAD_NONE_CHECK_RETRY_DELAYS_MS;
    }
    return [];
}

/**
 * Reports whether an uncached or non-terminal entry is eligible for an explicit request.
 *
 * This requestability rule remains separate from automatic retry schedules:
 * unavailable entries can be user-refreshed without receiving a timer.
 */
export function shouldRequestCommitChecks(
    cached: CommitChecksSnapshot | "loading" | undefined,
): boolean {
    if (cached === undefined) return true;
    if (cached === "loading") return false;
    return isPendingCheckState(cached.state) || cached.state === "unavailable";
}
