import { describe, expect, it, vi } from "vitest";
import type { CommitChecksSnapshot } from "../../../../src/types";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";

function snapshot(state: CommitChecksSnapshot["state"]): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: state, items: [] };
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
});
