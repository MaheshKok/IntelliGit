import { describe, expect, it, vi } from "vitest";
import type { CommitChecksSnapshot } from "../../../../src/types";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import {
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
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

describe("CommitChecksService", () => {
    it("shares concurrent fetches for one cache key", async () => {
        const service = new CommitChecksService({ ttlMs: 15_000 });
        const fetchSnapshot = vi.fn(
            () =>
                new Promise<CommitChecksSnapshot>((resolve) => {
                    setTimeout(() => resolve(snapshot("pending")), 0);
                }),
        );

        const [first, second] = await Promise.all([
            service.getOrFetch("github:repo@abc1234:-", fetchSnapshot),
            service.getOrFetch("github:repo@abc1234:-", fetchSnapshot),
        ]);

        expect(first).toBe(second);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    });

    it("does not cache or detach requests that resolve after clear", async () => {
        const service = new CommitChecksService({ ttlMs: 15_000 });
        const key = "github:repo@abc1234:-";
        let resolveFirst!: (value: CommitChecksSnapshot) => void;
        let resolveSecond!: (value: CommitChecksSnapshot) => void;
        const firstFetch = vi.fn(
            () =>
                new Promise<CommitChecksSnapshot>((resolve) => {
                    resolveFirst = resolve;
                }),
        );
        const secondFetch = vi.fn(
            () =>
                new Promise<CommitChecksSnapshot>((resolve) => {
                    resolveSecond = resolve;
                }),
        );
        const thirdFetch = vi.fn(async () => snapshot("failure"));

        const first = service.getOrFetch(key, firstFetch);
        service.clear();
        const second = service.getOrFetch(key, secondFetch);
        resolveFirst(snapshot("pending"));
        await first;

        const third = service.getOrFetch(key, thirdFetch);
        resolveSecond(snapshot("success"));

        await expect(second).resolves.toEqual(expect.objectContaining({ state: "success" }));
        await expect(third).resolves.toEqual(expect.objectContaining({ state: "success" }));
        expect(firstFetch).toHaveBeenCalledTimes(1);
        expect(secondFetch).toHaveBeenCalledTimes(1);
        expect(thirdFetch).not.toHaveBeenCalled();
    });

    it("serves pending snapshots within TTL and re-fetches after TTL", async () => {
        let clock = 0;
        const service = new CommitChecksService({ ttlMs: 10_000, now: () => clock });
        const fetchSnapshot = vi
            .fn()
            .mockResolvedValueOnce(snapshot("pending"))
            .mockResolvedValueOnce(snapshot("success"));

        await service.getOrFetch("github:repo@abc1234:-", fetchSnapshot);
        clock = 5_000;
        await service.getOrFetch("github:repo@abc1234:-", fetchSnapshot);
        clock = 11_000;
        const recovered = await service.getOrFetch("github:repo@abc1234:-", fetchSnapshot);

        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        expect(recovered.state).toBe("success");
    });

    it("evicts oldest entries when the L1 cap is exceeded", async () => {
        const service = new CommitChecksService({ maxEntries: 1 });
        const firstFetch = vi.fn(async () => snapshot("success"));
        const secondFetch = vi.fn(async () => ({ ...snapshot("success"), hash: "def5678" }));

        await service.getOrFetch("github:repo@abc1234:-", firstFetch);
        await service.getOrFetch("github:repo@def5678:-", secondFetch);
        await service.getOrFetch("github:repo@abc1234:-", firstFetch);

        expect(firstFetch).toHaveBeenCalledTimes(2);
        expect(secondFetch).toHaveBeenCalledTimes(1);
    });

    it("serves terminal snapshots from persistent cache across service instances", async () => {
        const store = state();
        const persistentCache = new CommitChecksPersistentCache(store);
        const first = new CommitChecksService({ persistentCache });
        const second = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(store),
        });
        const firstFetch = vi.fn(async () => snapshot("success"));
        const secondFetch = vi.fn(async () => snapshot("failure"));

        await first.getOrFetch("github:repo@abc1234:-", firstFetch);
        const restored = await second.getOrFetch("github:repo@abc1234:-", secondFetch);

        expect(restored.state).toBe("success");
        expect(firstFetch).toHaveBeenCalledTimes(1);
        expect(secondFetch).not.toHaveBeenCalled();
    });

    it("does not persist non-terminal snapshots", async () => {
        const store = state();
        const first = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(store),
        });
        const second = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(store),
        });
        const firstFetch = vi.fn(async () => snapshot("pending"));
        const secondFetch = vi.fn(async () => snapshot("success"));

        await first.getOrFetch("github:repo@abc1234:-", firstFetch);
        const fetched = await second.getOrFetch("github:repo@abc1234:-", secondFetch);

        expect(fetched.state).toBe("success");
        expect(secondFetch).toHaveBeenCalledTimes(1);
    });

    it("misses persistent cache when the settings fingerprint changes", async () => {
        const store = state();
        const first = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(store),
        });
        const second = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(store),
        });
        const firstFetch = vi.fn(async () => snapshot("success"));
        const secondFetch = vi.fn(async () => snapshot("failure"));

        await first.getOrFetch("github:repo@abc1234:build/i", firstFetch);
        const fetched = await second.getOrFetch("github:repo@abc1234:deploy/i", secondFetch);

        expect(fetched.state).toBe("failure");
        expect(secondFetch).toHaveBeenCalledTimes(1);
    });

    it("clear removes persistent snapshots before the next fetch", async () => {
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state()),
        });
        const firstFetch = vi.fn(async () => snapshot("success"));
        const secondFetch = vi.fn(async () => snapshot("failure"));

        await service.getOrFetch("github:repo@abc1234:-", firstFetch);
        service.clear();
        const fetched = await service.getOrFetch("github:repo@abc1234:-", secondFetch);

        expect(fetched.state).toBe("failure");
        expect(secondFetch).toHaveBeenCalledTimes(1);
    });
});
