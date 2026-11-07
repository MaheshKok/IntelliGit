import { describe, expect, it, vi } from "vitest";
import type { CiRun, CommitCiDetailData } from "../../../../src/types";
import type { CommitChecksPersistentState } from "../../../../src/services/commitChecks/persistentCache";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import {
    CommitCiDetailService,
    type CiDetailServeContext,
} from "../../../../src/services/commitChecks/detailService";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import { CI_DETAIL_CONTRACT_VERSION } from "../../../../src/shared/ci/contractVersion";

const KEY = "github:repo@abc1234:-#detail";
const STORAGE_KEY = "intelligit.commitChecks.detailCache.v1";
const SERVE: CiDetailServeContext = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };

function run(overrides: Partial<CiRun> = {}): CiRun {
    return { id: "1", name: "ci", state: "failure", jobs: [], jobsCoverage: "full", ...overrides };
}

function detail(overrides: Partial<CommitCiDetailData> = {}): CommitCiDetailData {
    return {
        hash: "abc1234",
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [run()],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        ...overrides,
    };
}

function memento(): CommitChecksPersistentState & { values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    return {
        values,
        get: vi.fn((key: string) => values.get(key)),
        update: vi.fn(async (key: string, value: unknown) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }),
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function service(
    state = memento(),
    now: () => number = Date.now,
): { service: CommitCiDetailService; persistent: CiDetailPersistentCache } {
    const persistent = new CiDetailPersistentCache(state, { now });
    return {
        persistent,
        service: new CommitCiDetailService({ ttlMs: 30_000, now, persistentCache: persistent }),
    };
}

describe("CommitCiDetailService", () => {
    it("shares concurrent fetches for one cache key", async () => {
        const { service: details } = service();
        const pending = deferred<CommitCiDetailData>();
        const fetchDetail = vi.fn(() => pending.promise);
        const first = details.getOrFetch(KEY, fetchDetail, SERVE);
        const second = details.getOrFetch(KEY, fetchDetail, SERVE);
        pending.resolve(detail({ complete: false, outcome: "pending" }));
        await Promise.all([first, second]);
        expect(fetchDetail).toHaveBeenCalledTimes(1);
    });

    it("complete detail served from L1 without refetch", async () => {
        let now = 0;
        const { service: details } = service(memento(), () => now);
        const fetchDetail = vi.fn(async () => detail());
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        now += 7 * 24 * 60 * 60 * 1000;
        await expect(details.getOrFetch(KEY, fetchDetail, SERVE)).resolves.toMatchObject({
            outcome: "failure",
        });
        expect(fetchDetail).toHaveBeenCalledTimes(1);
    });

    it("incomplete refetches after TTL", async () => {
        let now = 0;
        const { service: details } = service(memento(), () => now);
        const fetchDetail = vi.fn(async () => detail({ complete: false }));
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        now += 29_000;
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        expect(fetchDetail).toHaveBeenCalledTimes(1);
        now += 2_000;
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        expect(fetchDetail).toHaveBeenCalledTimes(2);
    });

    it("pageBound detail is served from L1 but never persisted", async () => {
        const state = memento();
        const { service: details, persistent } = service(state);
        const capped = detail({
            runs: [run({ jobsCoverage: { reason: "pageBound", shown: 1000 } })],
        });
        const fetchDetail = vi.fn(async () => capped);
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        expect(fetchDetail).toHaveBeenCalledTimes(1);
        expect(await persistent.get(KEY)).toBeUndefined();
        expect(state.values.has(STORAGE_KEY)).toBe(false);
    });

    it("persisted contractVersion ≠ current is a miss", async () => {
        const state = memento();
        const now = 1_000;
        state.values.set(STORAGE_KEY, {
            entries: [
                {
                    key: KEY,
                    contractVersion: CI_DETAIL_CONTRACT_VERSION + 1,
                    data: detail(),
                    fetchedAt: now,
                    lastAccessedAt: now,
                },
            ],
        });
        const { service: details } = service(state, () => now);
        const fetchDetail = vi.fn(async () => detail({ outcome: "success" }));
        await expect(details.getOrFetch(KEY, fetchDetail, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(fetchDetail).toHaveBeenCalledTimes(1);
    });

    it("a persisted complete detail survives a restart", async () => {
        const state = memento();
        await service(state).service.getOrFetch(KEY, async () => detail(), SERVE);
        const fetchDetail = vi.fn(async () => detail({ outcome: "success" }));
        await expect(
            service(state).service.getOrFetch(KEY, fetchDetail, SERVE),
        ).resolves.toMatchObject({ outcome: "failure" });
        expect(fetchDetail).not.toHaveBeenCalled();
    });

    it("served capabilities follow the provider, persisted JSON has none", async () => {
        const state = memento();
        const { service: details } = service(state);
        const fetched = await details.getOrFetch(KEY, async () => detail(), SERVE);
        expect(fetched.capabilities).toEqual(NO_CI_CAPABILITIES);
        expect(fetched.repoKey).toBe("/repo");

        const persisted = JSON.stringify(state.values.get(STORAGE_KEY));
        expect(persisted).toContain('"hash":"abc1234"');
        expect(persisted).not.toContain("capabilities");
        expect(persisted).not.toContain("repoKey");

        // A newer release turns a flag on: an L2 hit carries the installed provider's flags.
        const upgraded = { ...NO_CI_CAPABILITIES, runs: true, jobs: true };
        const restarted = service(state).service;
        const served = await restarted.getOrFetch(KEY, vi.fn(), {
            repoKey: "/repo",
            capabilities: upgraded,
        });
        expect(served.capabilities).toEqual(upgraded);
        // And so does an L1 hit.
        const again = await restarted.getOrFetch(KEY, vi.fn(), {
            repoKey: "/other",
            capabilities: NO_CI_CAPABILITIES,
        });
        expect(again.capabilities).toEqual(NO_CI_CAPABILITIES);
        expect(again.repoKey).toBe("/other");
    });

    it("a wire detail passed in is stripped before it is persisted", async () => {
        const state = memento();
        const { persistent } = service(state);
        await persistent.set(KEY, {
            ...detail(),
            capabilities: NO_CI_CAPABILITIES,
            repoKey: "/repo",
            actionFence: { targetId: "1", action: "cancel", notSeen: false },
        } as CommitCiDetailData);
        const persisted = JSON.stringify(state.values.get(STORAGE_KEY));
        expect(persisted).not.toContain("capabilities");
        expect(persisted).not.toContain("actionFence");
        expect(persisted).not.toContain("repoKey");
    });

    it("clear() drops a late result", async () => {
        const state = memento();
        const { service: details, persistent } = service(state);
        const before = deferred<CommitCiDetailData>();
        const preClear = vi.fn(() => before.promise);
        const old = details.getOrFetch(KEY, preClear, SERVE);
        await vi.waitFor(() => expect(preClear).toHaveBeenCalledTimes(1));
        details.clear();
        before.resolve(detail());
        await old;

        const after = vi.fn(async () => detail({ outcome: "success" }));
        await expect(details.getOrFetch(KEY, after, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(after).toHaveBeenCalledTimes(1);
        await details.invalidate(KEY);
        expect(await persistent.get(KEY)).toBeUndefined();
    });

    it("a fetch started before invalidate is not cached, and force does not join it", async () => {
        const state = memento();
        const { service: details, persistent } = service(state);
        const before = deferred<CommitCiDetailData>();
        const preInvalidate = vi.fn(() => before.promise);
        const old = details.getOrFetch(KEY, preInvalidate, SERVE);
        await vi.waitFor(() => expect(preInvalidate).toHaveBeenCalledTimes(1));

        await details.invalidate(KEY);
        const postInvalidate = vi.fn(async () => detail({ complete: false, outcome: "pending" }));
        const forced = details.getOrFetch(KEY, postInvalidate, SERVE, { force: true });
        before.resolve(detail());
        await old;
        await expect(forced).resolves.toMatchObject({ outcome: "pending" });
        expect(postInvalidate).toHaveBeenCalledTimes(1);
        expect(await persistent.get(KEY)).toBeUndefined();
        await expect(details.getOrFetch(KEY, vi.fn(), SERVE)).resolves.toMatchObject({
            outcome: "pending",
        });
    });

    it("a fetch started before invalidate does not hand its result to its caller", async () => {
        const { service: details } = service();
        const before = deferred<CommitCiDetailData>();
        const fetchDetail = vi.fn(() => before.promise);
        const old = details.getOrFetch(KEY, fetchDetail, SERVE);
        await vi.waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(1));

        await details.invalidate(KEY);
        fetchDetail.mockImplementation(async () => detail({ complete: false, outcome: "pending" }));
        before.resolve(detail());

        await expect(old).resolves.toMatchObject({ outcome: "pending", repoKey: "/repo" });
        expect(fetchDetail).toHaveBeenCalledTimes(2);
    });

    it("a rejected persistent clear fails closed: the previous entry is never served", async () => {
        const state = memento();
        const { service: details } = service(state);
        await details.getOrFetch(KEY, async () => detail(), SERVE);
        vi.mocked(state.update).mockImplementation(async (_key, value) => {
            if (value === undefined) throw new Error("storage is read-only");
        });

        details.clear();

        const refetch = vi.fn(async () => detail({ outcome: "success" }));
        await expect(details.getOrFetch(KEY, refetch, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("a forced refresh that finds pending work drops the settled entry from L2", async () => {
        const state = memento();
        const { service: details } = service(state);
        await details.getOrFetch(KEY, async () => detail(), SERVE);
        await details.getOrFetch(
            KEY,
            async () => detail({ complete: false, outcome: "pending" }),
            SERVE,
            { force: true },
        );

        const refetch = vi.fn(async () => detail({ complete: false, outcome: "pending" }));
        await expect(service(state).service.getOrFetch(KEY, refetch, SERVE)).resolves.toMatchObject(
            { outcome: "pending" },
        );
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("invalidate deletes the persisted entry (new service over the same Memento misses)", async () => {
        const state = memento();
        const { service: details } = service(state);
        await details.getOrFetch(KEY, async () => detail(), SERVE);
        await details.invalidate(KEY);
        const refetch = vi.fn(async () => detail({ outcome: "success" }));
        await service(state).service.getOrFetch(KEY, refetch, SERVE);
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("unknown settlement is never cached as complete", async () => {
        let now = 0;
        const state = memento();
        const { service: details, persistent } = service(state, () => now);
        const truncatedRuns = detail({
            complete: true,
            runsCoverage: { reason: "pageBound", shown: 1000 },
        });
        const fetchDetail = vi.fn(async () => truncatedRuns);
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        now += 31_000;
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        expect(fetchDetail).toHaveBeenCalledTimes(2);
        expect(await persistent.get(KEY)).toBeUndefined();
    });
});
