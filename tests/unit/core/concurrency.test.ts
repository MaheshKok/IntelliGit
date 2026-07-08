import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../../src/utils/concurrency";

describe("mapWithConcurrency", () => {
    it("returns results in original item order regardless of completion order", async () => {
        // Later items resolve sooner, so completion order is the reverse of input order.
        const delays = [30, 20, 10, 0];
        const result = await mapWithConcurrency(delays, 4, async (ms, index) => {
            await new Promise((resolve) => setTimeout(resolve, ms));
            return index;
        });
        expect(result).toEqual([0, 1, 2, 3]);
    });

    it("never exceeds the concurrency limit", async () => {
        let active = 0;
        let peak = 0;
        await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
        });
        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThan(1);
    });

    it("processes every item exactly once", async () => {
        const seen = new Set<number>();
        let calls = 0;
        await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 7, async (item) => {
            calls += 1;
            seen.add(item);
        });
        expect(calls).toBe(50);
        expect(seen.size).toBe(50);
    });

    it("returns an empty array for empty input without invoking the mapper", async () => {
        let called = false;
        const result = await mapWithConcurrency([], 4, async () => {
            called = true;
        });
        expect(result).toEqual([]);
        expect(called).toBe(false);
    });

    it("treats a limit below one as a single worker", async () => {
        let active = 0;
        let peak = 0;
        await mapWithConcurrency([1, 2, 3], 0, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active -= 1;
        });
        expect(peak).toBe(1);
    });

    it("rejects when a mapper call rejects", async () => {
        await expect(
            mapWithConcurrency([1, 2, 3], 2, async (n) => {
                if (n === 2) throw new Error("boom");
                return n;
            }),
        ).rejects.toThrow("boom");
    });
});
