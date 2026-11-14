// Live timing rules for the Checks tab (PLAN.md K14, K15), shared by the webview and the host.

/** K14: a running item's elapsed time is redrawn once a second, client-side, with no request. */
export const ELAPSED_TICK_MS = 1_000;

/** K15: an item is overdue once it has run longer than this many times its usual duration. */
const OVERDUE_FACTOR = 1.5;

/**
 * Whether a running item is overdue (K15): its elapsed time is more than 1.5 × its usual one.
 *
 * @param elapsedMs - Time since the item started.
 * @param usualMs - The previous successful run's duration; null or undefined when unknown.
 */
export function isOverdue(elapsedMs: number, usualMs: number | null | undefined): boolean {
    return usualMs != null && elapsedMs > OVERDUE_FACTOR * usualMs;
}
