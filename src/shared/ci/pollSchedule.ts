// Poll schedules for commit checks, shared by the webview badge ladder and host code.
// Failed fetches never get a schedule: only pending work is re-polled.

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
