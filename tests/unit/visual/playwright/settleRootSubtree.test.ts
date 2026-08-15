import { afterEach, describe, expect, it, vi } from "vitest";

import { settleRootSubtree } from "../../../visual/playwright/settleRootSubtree";

const MIN_STABLE_MS = 100;
const MAX_WAIT_MS = 3000;
const FRAME_MS = 16;

/**
 * A page whose clock, frames, and `#root` markup are all driven by the test.
 *
 * `settleRootSubtree` runs in the browser and closes over nothing, so the only thing standing
 * between it and a unit test is three globals. Driving them by hand is what makes the timing
 * assertions exact rather than approximate: the real thing measures wall-clock quiet time, and a
 * test that waited on a real 100ms could not tell that apart from a frame count.
 */
function fakePage() {
    let now = 0;
    let markup = "<div>initial</div>";
    let pending: ((now: number) => void) | null = null;

    vi.stubGlobal("document", {
        querySelector: (selector: string) =>
            selector === "#root" ? { innerHTML: markup } : undefined,
    });
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) => {
        pending = callback;
        return 1;
    });

    return {
        render: (next: string) => {
            markup = next;
        },
        /** Advances the clock and runs the frame callback that was waiting on it. */
        frame: (deltaMs: number = FRAME_MS) => {
            now += deltaMs;
            const callback = pending;
            pending = null;
            callback?.(now);
        },
        elapsed: () => now,
        isWaitingForAFrame: () => pending !== null,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("settleRootSubtree", () => {
    it("can fail: does not resolve on the first quiet frame", async () => {
        // The anti-no-op property. A predicate that returned as soon as two samples matched would
        // pass every other test here while proving nothing -- the very first frame's sample always
        // matches the one before it when nothing has been scheduled yet.
        const page = fakePage();
        let resolved = false;
        void settleRootSubtree({ minStableMs: MIN_STABLE_MS, maxWaitMs: MAX_WAIT_MS }).then(() => {
            resolved = true;
        });

        for (let i = 0; i < 5; i += 1) {
            page.frame();
            await Promise.resolve();
        }

        expect(page.elapsed()).toBeLessThan(MIN_STABLE_MS);
        expect(resolved).toBe(false);
    });

    it("can fail: waits the full quiet period measured in time, not in frames", async () => {
        // One long frame carries more quiet time than six short ones. A frame-count threshold
        // resolves on the sixth short frame and never on the single long one; this pins the
        // opposite, which is what a wall-clock requirement means.
        const page = fakePage();
        let resolved = false;
        void settleRootSubtree({ minStableMs: MIN_STABLE_MS, maxWaitMs: MAX_WAIT_MS }).then(() => {
            resolved = true;
        });

        page.frame(1); // first frame: always counts as a change, starts the quiet period
        await Promise.resolve();
        page.frame(MIN_STABLE_MS - 1);
        await Promise.resolve();
        expect(resolved).toBe(false);

        page.frame(1);
        await Promise.resolve();
        expect(resolved).toBe(true);
    });

    it("can fail: a late change restarts the quiet period instead of being ignored", async () => {
        // The staged-flicker case: React commits an intermediate tree, then the final one. A
        // predicate that never reset its timer would hand back the flicker.
        const page = fakePage();
        let resolved = false;
        void settleRootSubtree({ minStableMs: MIN_STABLE_MS, maxWaitMs: MAX_WAIT_MS }).then(() => {
            resolved = true;
        });

        page.frame(1);
        await Promise.resolve();
        page.frame(MIN_STABLE_MS - 10);
        await Promise.resolve();
        expect(resolved).toBe(false);

        page.render("<div>final</div>");
        page.frame(5);
        await Promise.resolve();

        // 95ms of quiet had accumulated before the change; if it were not discarded the next
        // 10ms frame would resolve. It must take a further full period instead.
        page.frame(MIN_STABLE_MS - 1);
        await Promise.resolve();
        expect(resolved).toBe(false);

        page.frame(1);
        await Promise.resolve();
        expect(resolved).toBe(true);
    });

    it("can fail: rejects with the budget in the message when the page never settles", async () => {
        const page = fakePage();
        let outcome: string | undefined;
        // Deliberately not awaited: a predicate that never rejects would hang the test instead of
        // failing it, and a timeout is not evidence about the assertion under test.
        void settleRootSubtree({ minStableMs: MIN_STABLE_MS, maxWaitMs: MAX_WAIT_MS }).catch(
            (error: Error) => {
                outcome = error.message;
            },
        );

        // Re-render on every frame so quiet time can never accumulate.
        let counter = 0;
        while (outcome === undefined && counter < 400) {
            page.render(`<div>${(counter += 1)}</div>`);
            page.frame();
            await Promise.resolve();
        }

        expect(outcome).toMatch(/did not settle under "#root" within 3000ms/);
        expect(page.elapsed()).toBeGreaterThanOrEqual(MAX_WAIT_MS);
    });

    it("can fail: a quiet frame arriving past the budget rejects instead of resolving", async () => {
        // Quiet time is inferred from two samples, so a single stalled frame satisfies it from
        // evidence that is merely stale rather than settled. Consulting quiet before the deadline
        // therefore lets that one frame resolve at any elapsed time at all -- 3s, 30s, whatever the
        // jank was -- which leaves `maxWaitMs` bounding nothing while its message still quotes it.
        const page = fakePage();
        let outcome: string | undefined;
        let resolved = false;
        void settleRootSubtree({ minStableMs: MIN_STABLE_MS, maxWaitMs: MAX_WAIT_MS }).then(
            () => {
                resolved = true;
            },
            (error: Error) => {
                outcome = error.message;
            },
        );

        page.frame(1); // first frame: always counts as a change, starts the quiet period
        await Promise.resolve();
        expect(resolved).toBe(false);

        // One stalled frame, markup untouched across it. Both conditions now hold at once.
        page.frame(MAX_WAIT_MS);
        await Promise.resolve();

        expect(resolved).toBe(false);
        expect(outcome).toMatch(/did not settle under "#root" within 3000ms/);
    });

    it("can fail: a quiet frame arriving inside the budget still resolves", async () => {
        // The far side of the same boundary, so the deadline cannot be "tightened" into rejecting
        // everything: one millisecond earlier, the identical stalled frame must settle. Without
        // this the every-other test sits within 210ms of the start and a deadline mutated to half
        // the budget would go unnoticed.
        const page = fakePage();
        let outcome: string | undefined;
        let resolved = false;
        void settleRootSubtree({ minStableMs: MIN_STABLE_MS, maxWaitMs: MAX_WAIT_MS }).then(
            () => {
                resolved = true;
            },
            (error: Error) => {
                outcome = error.message;
            },
        );

        page.frame(1);
        await Promise.resolve();
        page.frame(MAX_WAIT_MS - 2); // lands at 2999ms -- one millisecond inside the budget
        await Promise.resolve();

        expect(outcome).toBeUndefined();
        expect(resolved).toBe(true);
    });

    it("stops scheduling frames once it has settled", async () => {
        const page = fakePage();
        let resolved = false;
        void settleRootSubtree({ minStableMs: MIN_STABLE_MS, maxWaitMs: MAX_WAIT_MS }).then(() => {
            resolved = true;
        });

        page.frame(1);
        await Promise.resolve();
        page.frame(MIN_STABLE_MS);
        await Promise.resolve();

        expect(resolved).toBe(true);
        expect(page.isWaitingForAFrame()).toBe(false);
    });
});
