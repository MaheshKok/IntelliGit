import { RepositoryLockBusyError } from "./repositoryLock";

/** How long a busy lock is retried, and how long to pause between attempts. */
export interface BoundedLockRetryOptions {
    readonly timeoutMs: number;
    readonly retryDelayMs: number;
}

/**
 * Retries a busy `RepositoryLock` acquisition until it succeeds or the caller's
 * own wait window elapses, capping every retry sleep at whatever time is left.
 *
 * A loop that always slept the full `retryDelayMs` after a busy failure, without
 * capping it to what remains before the deadline, can land its next attempt long
 * after the window the caller was promised: a 100ms timeout paired with a 1000ms
 * retry delay would still sleep the whole second on the first failure, and if the
 * holder released at 300ms the retry would succeed at ~1000ms -- ten times past
 * the 100ms the caller asked for. Capping the sleep at the remaining time keeps
 * every wake-up at or before the deadline, so the loop can only ever give up
 * close to when it said it would, never long after.
 */
export async function acquireWithBoundedWait<T>(
    acquire: () => Promise<T>,
    options: BoundedLockRetryOptions,
): Promise<T> {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        try {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ordered retries prevent a later acquire from overtaking an earlier request.
            return await acquire();
        } catch (error) {
            if (!(error instanceof RepositoryLockBusyError)) throw error;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw error;
            await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(options.retryDelayMs, remainingMs)),
            );
        }
    }
}
