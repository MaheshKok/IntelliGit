import { describe, expect, it } from "vitest";
import { spanOf } from "../../../src/webviews/react/commit-info/checks/ciFormat";

describe("spanOf", () => {
    it("orders run times by instant, not by text, across timezone offsets", () => {
        // 10:00+02:00 is 08:00Z, the earliest start; 10:10+02:00 is 08:10Z, not the latest end.
        expect(
            spanOf([
                { startedAt: "2024-01-01T09:00:00Z", completedAt: "2024-01-01T09:30:00Z" },
                {
                    startedAt: "2024-01-01T10:00:00+02:00",
                    completedAt: "2024-01-01T10:10:00+02:00",
                },
            ]),
        ).toEqual({
            startedAt: "2024-01-01T10:00:00+02:00",
            completedAt: "2024-01-01T09:30:00Z",
        });
    });
});
