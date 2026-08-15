/** How long `#root` must go unchanged, and how long to wait before giving up. */
export interface SettleOptions {
    readonly minStableMs: number;
    readonly maxWaitMs: number;
}

/**
 * Resolves once `#root`'s markup has been unchanged for `minStableMs` of continuous wall-clock
 * quiet time; rejects at `maxWaitMs`.
 *
 * This runs inside the page: `page.evaluate` serializes it and re-parses it there, so it must
 * close over nothing -- every identifier below is a browser global. That constraint is exactly why
 * it lives in its own module instead of inline at the call site: a function that closes over
 * nothing is one a unit test can drive with a fake clock and a fake `requestAnimationFrame`, and
 * the alternative was a 40-line predicate whose only proof was a scratch script nobody kept.
 *
 * Two properties are load-bearing and are what the unit tests pin:
 *
 * - **Samples come from inside a frame callback, never a synchronous pre-frame read.** A
 *   synchronous sample can equal the previous one merely because the scheduled commit has not
 *   landed yet, which satisfies a naive "matches last sample" check while nothing has settled.
 *   `previousSnapshot` starts at `null`, which no `innerHTML` can equal, so the first frame always
 *   counts as a change and the full quiet period is always served.
 * - **The requirement is elapsed time, not a frame count.** A 2-frame (~33ms) threshold was
 *   measured resolving in ~20ms against renders deferred by 100-250ms: it was satisfied by
 *   "nothing has changed yet" as readily as by "nothing will change again". Gating on each
 *   frame's own timestamp keeps the requirement meaningful whatever the page's frame rate.
 * - **The deadline is checked before the quiet period, and that order is load-bearing.** Quiet
 *   time is inferred from two samples, so a single stalled frame -- one long jank, one throttled
 *   tab -- can satisfy `minStableMs` from evidence that is merely stale, and checking it first
 *   would let the promise resolve at any elapsed time whatsoever. `maxWaitMs` would then bound
 *   nothing while the rejection message went on quoting it.
 */
export function settleRootSubtree({ minStableMs, maxWaitMs }: SettleOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const snapshot = (): string => document.querySelector("#root")?.innerHTML ?? "";

        const startTime = performance.now();
        let previousSnapshot: string | null = null;
        let lastChangeTime = startTime;

        function tick(now: number): void {
            const current = snapshot();
            if (current !== previousSnapshot) {
                previousSnapshot = current;
                lastChangeTime = now;
            }

            if (now - startTime >= maxWaitMs) {
                reject(
                    new Error(
                        `Visual harness fixture render did not settle under "#root" within ${maxWaitMs}ms.`,
                    ),
                );
                return;
            }
            if (now - lastChangeTime >= minStableMs) {
                resolve();
                return;
            }
            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    });
}
