import { isPendingCheckState, type CommitChecksSnapshot } from "../../../types";

const MIN_GIT_ABBREVIATION_LENGTH = 7;

/** Cumulative retry intervals while a visible commit's CI remains pending. */
export const PENDING_CHECK_RETRY_DELAYS_MS = [
    3_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 120_000,
] as const;

/** Cumulative retry intervals while a pushed current HEAD has no registered checks. */
export const HEAD_NONE_CHECK_RETRY_DELAYS_MS = [3_000, 5_000, 10_000, 30_000] as const;

/**
 * Hard ceiling on retry attempts for a single commit hash, counted across ladder
 * resets rather than within one ladder.
 *
 * A visible commit's aggregate state can flap between "pending" and "none" across
 * successive polls (GitHub's two check endpoints are fetched with Promise.allSettled,
 * so one transient failure empties `items` for a single poll). Both ladders above open
 * at rung 0, so a per-state attempt counter that resets on every state change re-arms
 * rung 0 forever and polls indefinitely. This bound survives ladder resets instead: it
 * comfortably covers a full HEAD_NONE_CHECK_RETRY_DELAYS_MS ladder plus a full
 * PENDING_CHECK_RETRY_DELAYS_MS ladder (4 + 8 = 12 rungs) with slack for a couple of
 * extra resets before a flapping hash is forced to stop.
 */
export const MAX_COMMIT_CHECK_RETRIES_PER_HASH = 20;

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
 * Pending CI retries regardless of branch position. A `none` snapshot retries
 * only for the pushed current local HEAD; unavailable and terminal snapshots
 * never schedule automatic requests.
 */
export function retryDelaysForCommitChecks(
    snapshot: CommitChecksSnapshot,
    options: { isCurrentHead: boolean; isUnpushed: boolean },
): readonly number[] {
    if (snapshot.state === "pending") return PENDING_CHECK_RETRY_DELAYS_MS;
    if (snapshot.state === "none" && options.isCurrentHead && !options.isUnpushed) {
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
