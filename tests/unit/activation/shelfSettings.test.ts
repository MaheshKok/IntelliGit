import { describe, expect, it } from "vitest";
import { readShelfSettings } from "../../../src/activation/shelfSettings";

describe("readShelfSettings", () => {
    it("reads defaults, clamps invalid values, converts recovery hours, and normalizes the path", () => {
        const configuration = {
            get: <T>(key: string, fallback?: T): T | undefined =>
                (({
                    "shelf.path": "",
                    "shelf.recordBaseRevisions": undefined,
                    "shelf.cleanupAfterDays": -2,
                    "shelf.removeOnUnshelve": undefined,
                    "shelf.recoveryRetentionHours": 0,
                })[key] as T | undefined) ?? fallback,
        };

        expect(readShelfSettings(configuration)).toEqual({
            pathOverride: undefined,
            recordBaseRevisions: true,
            cleanupAfterDays: 0,
            removeOnUnshelve: true,
            recoveryRetentionMs: 24 * 60 * 60 * 1000,
        });
        expect(
            readShelfSettings({
                get: <T>(key: string): T | undefined =>
                    ({
                        "shelf.path": "/tmp/shelves",
                        "shelf.recordBaseRevisions": false,
                        "shelf.cleanupAfterDays": 3,
                        "shelf.removeOnUnshelve": false,
                        "shelf.recoveryRetentionHours": 2,
                    })[key] as T | undefined,
            }),
        ).toEqual({
            pathOverride: "/tmp/shelves",
            recordBaseRevisions: false,
            cleanupAfterDays: 3,
            removeOnUnshelve: false,
            recoveryRetentionMs: 2 * 60 * 60 * 1000,
        });
    });
});
