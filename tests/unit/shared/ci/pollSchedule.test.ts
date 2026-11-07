import { describe, expect, it } from "vitest";
import {
    PENDING_CHECK_RETRY_DELAYS_MS,
    headMonitorDelayMs,
} from "../../../../src/shared/ci/pollSchedule";

describe("HEAD monitor schedule (K26)", () => {
    it("runs the pending ladder, then every 120 s with no cap", () => {
        const ladder = PENDING_CHECK_RETRY_DELAYS_MS.map((_, attempt) =>
            headMonitorDelayMs(attempt),
        );
        expect(ladder).toEqual([...PENDING_CHECK_RETRY_DELAYS_MS]);
        expect(headMonitorDelayMs(PENDING_CHECK_RETRY_DELAYS_MS.length)).toBe(120_000);
        expect(headMonitorDelayMs(10_000)).toBe(120_000);
    });

    it("makes 36 snapshot fetches in an incomplete hour", () => {
        const hourMs = 60 * 60 * 1000;
        let fetches = 1;
        for (let at = headMonitorDelayMs(0), attempt = 1; at < hourMs; attempt += 1) {
            fetches += 1;
            at += headMonitorDelayMs(attempt);
        }
        expect(fetches).toBe(36);
    });
});
