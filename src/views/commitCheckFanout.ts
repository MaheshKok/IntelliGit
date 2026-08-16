// Pure, VS Code-independent bounded-concurrency fan-out for a viewport's commit-check
// fetches. Kept free of extension-host types so it is unit-testable without the
// extension host (see tests/unit/views/commitCheckFanout.test.ts).

/**
 * Concurrent commit-check fetches dispatched per viewport demand.
 *
 * Matches `MAX_CONCURRENT_REQUESTS` in `services/commitChecks/requestGate.ts` — that shared
 * per-provider/API-origin HTTP gate already allows 4 concurrent requests, which a single
 * sequential viewport loop could never use. This lets one viewport actually spend that budget.
 */
export const COMMIT_CHECK_FANOUT_LIMIT = 4;

/**
 * Runs `task` over `items` with at most `limit` concurrent invocations in flight.
 *
 * Before starting each item, `isCurrent()` is re-checked; once it returns false, no further
 * items are started. Items already in flight are never aborted — they are left to settle,
 * since callers gate their own side effects (e.g. posting a result to a webview) on their own
 * generation checks. A rejecting task is caught here: it does not stop the remaining items from
 * starting, and it never rejects the promise this function returns.
 *
 * @param items - Ordered work items; an item only begins once a worker claims it.
 * @param limit - Maximum concurrent in-flight tasks. Zero or negative behaves as 1.
 * @param isCurrent - Re-checked before every start; once it returns false, no further item starts.
 * @param task - Unit of work for one item. A rejection is caught and swallowed by this helper.
 */
export async function runBoundedFanout<T>(
    items: readonly T[],
    limit: number,
    isCurrent: () => boolean,
    task: (item: T) => Promise<void>,
): Promise<void> {
    const boundedLimit = limit > 0 ? limit : 1;
    const workerCount = Math.min(boundedLimit, items.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
        // `nextIndex++` is atomic between awaits on the single-threaded event loop, so each
        // index is claimed by exactly one worker.
        for (;;) {
            if (!isCurrent()) return;
            if (nextIndex >= items.length) return;
            const index = nextIndex++;
            try {
                // Each worker waits for its claimed item before checking out the next index.
                // react-doctor-disable-next-line react-doctor/async-await-in-loop
                await task(items[index]);
            } catch {
                // One item's failure must not abandon the rest of the viewport, and must not
                // reject the caller of runBoundedFanout.
            }
        }
    };

    await Promise.all(Array.from({ length: workerCount }, runWorker));
}
