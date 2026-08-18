import { describe, expect, it } from "vitest";
import { runBoundedFanout } from "../../../src/views/commitCheckFanout";

/** A promise the test drives manually, plus the settle functions that control it. */
function createDeferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

/** Drains the microtask queue a fixed number of turns; no real timer, so this stays deterministic. */
async function flushMicrotasks(turns = 20): Promise<void> {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
    }
}

describe("runBoundedFanout", () => {
    it("never exceeds the concurrency limit", async () => {
        const items = Array.from({ length: 9 }, (_, i) => i);
        const deferreds = items.map(() => createDeferred<void>());
        let active = 0;
        let highWaterMark = 0;

        const done = runBoundedFanout(
            items,
            3,
            () => true,
            async (item) => {
                active += 1;
                highWaterMark = Math.max(highWaterMark, active);
                await deferreds[item].promise;
                active -= 1;
            },
        );

        await flushMicrotasks();
        expect(highWaterMark).toBeLessThanOrEqual(3);

        for (const deferred of deferreds) {
            deferred.resolve();
            await flushMicrotasks();
            expect(highWaterMark).toBeLessThanOrEqual(3);
        }
        await done;
        expect(highWaterMark).toBe(3);
    });

    it("actually achieves concurrency: at least 4 of 8 start before any complete", async () => {
        const items = Array.from({ length: 8 }, (_, i) => i);
        const deferreds = items.map(() => createDeferred<void>());
        const started: number[] = [];
        const completed: number[] = [];

        const done = runBoundedFanout(
            items,
            4,
            () => true,
            async (item) => {
                started.push(item);
                await deferreds[item].promise;
                completed.push(item);
            },
        );

        await flushMicrotasks();
        expect(started.length).toBeGreaterThanOrEqual(4);
        expect(completed.length).toBe(0);

        for (const deferred of deferreds) deferred.resolve();
        await done;
        expect(completed.length).toBe(8);
    });

    it("processes all items while isCurrent stays true", async () => {
        const items = ["a", "b", "c", "d", "e"];
        const started: string[] = [];

        await runBoundedFanout(
            items,
            2,
            () => true,
            async (item) => {
                started.push(item);
            },
        );

        expect([...started].sort()).toEqual([...items].sort());
        expect(started.length).toBe(items.length);
    });

    it("stops starting further items once isCurrent flips false, and still settles", async () => {
        const items = [0, 1, 2, 3, 4, 5];
        const deferreds = items.map(() => createDeferred<void>());
        const started: number[] = [];
        let current = true;

        const done = runBoundedFanout(
            items,
            2,
            () => current,
            async (item) => {
                started.push(item);
                await deferreds[item].promise;
            },
        );

        await flushMicrotasks();
        expect(started).toEqual([0, 1]);

        current = false;
        // Resolve every deferred, not just the two legitimately in flight: under a correct
        // implementation nothing else is waiting on them, so this is a no-op. It exists so
        // that a broken implementation which keeps claiming items after cancellation drains
        // to completion and fails on the assertion below, instead of hanging forever on
        // `await done` waiting for a deferred this test never resolves.
        for (const deferred of deferreds) deferred.resolve();
        await done;

        expect(started).toEqual([0, 1]);
    });

    it("treats limit <= 0 as 1", async () => {
        const runWithLimit = async (limit: number): Promise<number> => {
            let active = 0;
            let highWaterMark = 0;
            await runBoundedFanout(
                [0, 1, 2, 3],
                limit,
                () => true,
                async () => {
                    active += 1;
                    highWaterMark = Math.max(highWaterMark, active);
                    await Promise.resolve();
                    active -= 1;
                },
            );
            return highWaterMark;
        };

        expect(await runWithLimit(0)).toBe(1);
        expect(await runWithLimit(-5)).toBe(1);
    });

    it("does not abandon remaining items when a task rejects, and never rejects the caller", async () => {
        const items = [0, 1, 2, 3];
        const started: number[] = [];

        await expect(
            runBoundedFanout(
                items,
                2,
                () => true,
                async (item) => {
                    started.push(item);
                    if (item === 1) throw new Error("boom");
                },
            ),
        ).resolves.toBeUndefined();

        expect([...started].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    });
});
