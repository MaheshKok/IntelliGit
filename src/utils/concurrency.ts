// Small async concurrency helper used to bound how many Git subprocesses run at
// once during multi-repository operations (repository discovery, collapsed-row
// count scans). Keeping a fixed worker pool avoids the thundering herd of one
// subprocess per repository that made activation slow with many repositories.

/**
 * Maps `items` through `mapper` while running at most `limit` calls concurrently.
 *
 * Results are returned in the original item order regardless of completion order.
 * A rejected mapper call rejects the returned promise, mirroring `Promise.all`;
 * callers that must not abort the batch should catch inside `mapper`.
 *
 * @param items - Items to process; an empty list resolves to an empty array.
 * @param limit - Maximum number of concurrent `mapper` executions (floored at 1).
 * @param mapper - Async transform invoked with each item and its original index.
 * @returns Mapper results in the same order as `items`.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) return [];
    const bound = Math.max(1, Math.min(Math.floor(limit), items.length));
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
        // `nextIndex++` is atomic between awaits on the single-threaded event loop,
        // so each index is claimed by exactly one worker.
        while (nextIndex < items.length) {
            const index = nextIndex++;
            // Each worker waits for its assigned item before taking the next index.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            results[index] = await mapper(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: bound }, runWorker));
    return results;
}
