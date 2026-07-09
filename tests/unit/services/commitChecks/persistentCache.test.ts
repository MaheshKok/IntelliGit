import { describe, expect, it, vi } from "vitest";
import type { CommitChecksSnapshot } from "../../../../src/types";
import {
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
    isPersistentCommitCheckState,
} from "../../../../src/services/commitChecks/persistentCache";

function snapshot(state: CommitChecksSnapshot["state"]): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: state, items: [] };
}

function state(): CommitChecksPersistentState {
    const values = new Map<string, unknown>();
    return {
        get: vi.fn((key: string) => values.get(key)),
        update: vi.fn(async (key: string, value: unknown) => {
            if (value === undefined) {
                values.delete(key);
                return;
            }
            values.set(key, value);
        }),
    };
}

describe("CommitChecksPersistentCache", () => {
    it("stores only terminal states", () => {
        expect(isPersistentCommitCheckState("success")).toBe(true);
        expect(isPersistentCommitCheckState("unknown")).toBe(true);
        expect(isPersistentCommitCheckState("pending")).toBe(false);
        expect(isPersistentCommitCheckState("none")).toBe(false);
        expect(isPersistentCommitCheckState("unavailable")).toBe(false);
    });

    it("ignores expired terminal snapshots", async () => {
        let clock = 0;
        const cache = new CommitChecksPersistentCache(state(), {
            maxAgeMs: 10,
            now: () => clock,
        });

        await cache.set("github:repo@abc1234:-", snapshot("success"));
        clock = 11;

        await expect(cache.get("github:repo@abc1234:-")).resolves.toBeUndefined();
    });

    it("evicts the least recently accessed entry when capped", async () => {
        let clock = 0;
        const cache = new CommitChecksPersistentCache(state(), {
            maxEntries: 1,
            now: () => clock,
        });

        await cache.set("github:repo@abc1234:-", snapshot("success"));
        clock = 1;
        await cache.set("github:repo@def5678:-", { ...snapshot("failure"), hash: "def5678" });

        await expect(cache.get("github:repo@abc1234:-")).resolves.toBeUndefined();
        await expect(cache.get("github:repo@def5678:-")).resolves.toEqual(
            expect.objectContaining({ state: "failure" }),
        );
    });
});
