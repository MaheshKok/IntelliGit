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

    it("the detail contract version starts at 1, and persisted details carry and accept 1", async () => {
        expect(CI_DETAIL_CONTRACT_VERSION).toBe(1);
        const state = memento();
        await service(state, () => 1_000).service.getOrFetch(KEY, async () => detail(), SERVE);
        const saved = state.values.get(STORAGE_KEY) as { entries: { contractVersion: number }[] };
        expect(saved.entries.map((entry) => entry.contractVersion)).toEqual([1]);

        const written = memento();
        written.values.set(STORAGE_KEY, {
            entries: [
                {
                    key: KEY,
                    contractVersion: 1,
                    data: detail(),
                    fetchedAt: 1_000,
                    lastAccessedAt: 1_000,
                },
            ],
            unconfirmed: {},
        });
        const fetchDetail = vi.fn(async () => detail({ outcome: "success" }));
        await expect(
            service(written, () => 1_000).service.getOrFetch(KEY, fetchDetail, SERVE),
        ).resolves.toMatchObject({ outcome: "failure" });
        expect(fetchDetail).not.toHaveBeenCalled();
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

    it("a persisted read that ends after a forced refresh does not replace the refreshed detail", async () => {
        const state = memento();
        await service(state).service.getOrFetch(KEY, async () => detail(), SERVE);
        const { service: details, persistent } = service(state);
        const releaseRead = deferred<void>();
        const read = persistent.get.bind(persistent);
        vi.spyOn(persistent, "get").mockImplementationOnce(async (key) => {
            const value = await read(key);
            await releaseRead.promise;
            return value;
        });

        // The read has already seen the old entry when the forced refresh lands.
        const slow = details.getOrFetch(KEY, async () => detail(), SERVE);
        await expect(
            details.getOrFetch(KEY, async () => detail({ outcome: "success" }), SERVE, {
                force: true,
            }),
        ).resolves.toMatchObject({ outcome: "success" });
        releaseRead.resolve();

        await expect(slow).resolves.toMatchObject({ outcome: "success" });
        const next = vi.fn(async () => detail());
        await expect(details.getOrFetch(KEY, next, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(next).not.toHaveBeenCalled();
    });

    it("a persisted read that ends while a forced refresh confirms its save shares the refresh's rejection", async () => {
        const state = memento();
        await service(state).service.getOrFetch(KEY, async () => detail(), SERVE);
        const { service: details, persistent } = service(state);
        const releaseRead = deferred<void>();
        const read = persistent.get.bind(persistent);
        vi.spyOn(persistent, "get").mockImplementationOnce(async (key) => {
            const value = await read(key);
            await releaseRead.promise;
            return value;
        });
        const rejected = new Error("caller rejected the answer");
        let reject!: (error: Error) => void;
        const confirm = vi.fn(() => new Promise<void>((_, fail) => (reject = fail)));

        const slow = details.getOrFetch(KEY, async () => detail(), SERVE);
        const forced = details.getOrFetch(
            KEY,
            async () => detail({ outcome: "success" }),
            SERVE,
            { force: true },
            confirm,
        );
        await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
        releaseRead.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        reject(rejected);

        // The unconfirmed refresh is never served on its own.
        await expect(forced).rejects.toBe(rejected);
        await expect(slow).rejects.toBe(rejected);
    });

    it("a saved detail read after an expired in-memory entry replaces that entry", async () => {
        let now = 1_000;
        const { service: details, persistent } = service(memento(), () => now);
        await details.getOrFetch(KEY, async () => detail({ complete: false }), SERVE);
        // Another window saved the finished detail.
        await persistent.set(KEY, detail({ outcome: "success" }));
        now += 31_000;
        const next = vi.fn(async () => detail({ complete: false }));
        await expect(details.getOrFetch(KEY, next, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        // With the saved copy gone, only the in-memory replacement can answer.
        await persistent.delete(KEY);
        await expect(details.getOrFetch(KEY, next, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(next).not.toHaveBeenCalled();
    });

    it("a persisted read that outlives a forced refresh's short-lived detail fetches again", async () => {
        let now = 1_000;
        const state = memento();
        await service(state, () => now).service.getOrFetch(KEY, async () => detail(), SERVE);
        const { service: details, persistent } = service(state, () => now);
        const releaseRead = deferred<void>();
        const read = persistent.get.bind(persistent);
        vi.spyOn(persistent, "get").mockImplementationOnce(async (key) => {
            const value = await read(key);
            await releaseRead.promise;
            return value;
        });

        const slow = details.getOrFetch(KEY, async () => detail({ outcome: "success" }), SERVE);
        await details.getOrFetch(
            KEY,
            async () => detail({ complete: false, outcome: "pending" }),
            SERVE,
            { force: true },
        );
        now += 31_000;
        releaseRead.resolve();

        // Neither the expired refresh nor the older saved copy is served.
        await expect(slow).resolves.toMatchObject({ outcome: "success" });
    });

    it("a detail saved copy that invalidate() failed to delete is not served again", async () => {
        const state = memento();
        await service(state).service.getOrFetch(KEY, async () => detail(), SERVE);
        const { service: details, persistent } = service(state);
        const failed = new Error("storage down");
        vi.spyOn(persistent, "delete").mockRejectedValueOnce(failed);

        await expect(details.invalidate(KEY)).rejects.toBe(failed);
        const next = vi.fn(async () => detail({ outcome: "success" }));
        await expect(details.getOrFetch(KEY, next, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("an unavailable detail marked complete is retried after its TTL and never saved", async () => {
        let now = 0;
        const { service: details, persistent } = service(memento(), () => now);
        const fetchDetail = vi.fn(async () => detail({ outcome: "unavailable" }));
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        expect(await persistent.get(KEY)).toBeUndefined();
        now += 15 * 60 * 1000;
        await details.getOrFetch(KEY, fetchDetail, SERVE);
        expect(fetchDetail).toHaveBeenCalledTimes(2);
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

    it("failedScan stays in memory and is never persisted", async () => {
        const state = memento();
        const { persistent } = service(state);
        const scanned = detail({ runs: [run({ failedScan: { state: "done", found: 2 } })] });
        await persistent.set(KEY, scanned);

        expect(JSON.stringify(state.values.get(STORAGE_KEY))).not.toContain("failedScan");
        const restored = await persistent.get(KEY);
        expect(restored?.runs).toHaveLength(1);
        expect(restored?.runs[0]).not.toHaveProperty("failedScan");
        // The in-memory detail the caller still holds keeps its scan progress.
        expect(scanned.runs[0].failedScan).toEqual({ state: "done", found: 2 });
    });

    it("a forced refresh that fails keeps the previous detail and reports the error separately", async () => {
        const { service: details } = service();
        await details.getOrFetch(KEY, async () => detail(), SERVE);

        const refreshed = await details.getOrFetch(
            KEY,
            async () =>
                detail({ complete: false, outcome: "unavailable", runs: [], error: "HTTP 502" }),
            SERVE,
            { force: true },
        );
        expect(refreshed).toMatchObject({
            outcome: "failure",
            runs: [run()],
            refreshError: "HTTP 502",
        });
        expect(refreshed.error).toBeUndefined();

        // The next ordinary read still serves the previous tree, without the refresh error.
        const fetchAgain = vi.fn(async () => detail({ outcome: "success" }));
        const next = await details.getOrFetch(KEY, fetchAgain, SERVE);
        expect(next).toMatchObject({ outcome: "failure", runs: [run()] });
        expect(next).not.toHaveProperty("refreshError");
        expect(fetchAgain).not.toHaveBeenCalled();
    });

    it("an ordinary refetch that fails replaces the expired entry, so the failure is not retried", async () => {
        let now = 0;
        const { service: details } = service(memento(), () => now);
        await details.getOrFetch(KEY, async () => detail({ complete: false }), SERVE);
        now += 31_000;
        const failing = vi.fn(async () =>
            detail({ complete: false, outcome: "unavailable", runs: [], error: "HTTP 502" }),
        );
        const served = await details.getOrFetch(KEY, failing, SERVE);
        expect(served).toMatchObject({ outcome: "unavailable", error: "HTTP 502" });
        expect(served).not.toHaveProperty("refreshError");
        await details.getOrFetch(KEY, failing, SERVE);
        expect(failing).toHaveBeenCalledTimes(1);
    });

    it("a forced refresh that fails after an earlier failure serves the newer error", async () => {
        const { service: details } = service();
        const unavailable = (error: string) =>
            detail({ complete: false, outcome: "unavailable", runs: [], error });
        await details.getOrFetch(KEY, async () => unavailable("HTTP 500"), SERVE);
        const served = await details.getOrFetch(KEY, async () => unavailable("HTTP 502"), SERVE, {
            force: true,
        });
        expect(served).toMatchObject({ outcome: "unavailable", error: "HTTP 502" });
        expect(served).not.toHaveProperty("refreshError");
    });

    it("a forced refresh that fails with nothing cached returns the unavailable detail", async () => {
        const { service: details } = service();
        const served = await details.getOrFetch(
            KEY,
            async () =>
                detail({ complete: false, outcome: "unavailable", runs: [], error: "HTTP 502" }),
            SERVE,
            { force: true },
        );
        expect(served).toMatchObject({ outcome: "unavailable", error: "HTTP 502" });
        expect(served).not.toHaveProperty("refreshError");
    });

    it("clear() drops a late result", async () => {
        const state = memento();
        const { service: details, persistent } = service(state);
        const before = deferred<CommitCiDetailData>();
        const preClear = vi.fn(() => before.promise);
        const old = details.getOrFetch(KEY, preClear, SERVE);
        await vi.waitFor(() => expect(preClear).toHaveBeenCalledTimes(1));
        details.clear();
        preClear.mockImplementation(async () => detail({ complete: false, outcome: "pending" }));
        before.resolve(detail());
        await expect(old).resolves.toMatchObject({ outcome: "pending" });

        const after = vi.fn(async () => detail({ outcome: "success" }));
        await expect(details.getOrFetch(KEY, after, SERVE)).resolves.toMatchObject({
            outcome: "pending",
        });
        expect(after).not.toHaveBeenCalled();
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

    it("a failed clear still keeps the previous entry from a restarted service", async () => {
        const state = memento();
        const { service: details } = service(state);
        await details.getOrFetch(KEY, async () => detail(), SERVE);
        // Removing the key fails; writing a value still works.
        vi.mocked(state.update).mockImplementation(async (key, value) => {
            if (value === undefined) throw new Error("cannot delete");
            state.values.set(key, value);
        });
        details.clear();
        await vi.waitFor(() => expect(state.update).toHaveBeenCalledWith(STORAGE_KEY, undefined));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const refetch = vi.fn(async () => detail({ outcome: "success" }));
        await expect(service(state).service.getOrFetch(KEY, refetch, SERVE)).resolves.toMatchObject(
            { outcome: "success" },
        );
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("a fetch started before clear does not hand its result to its caller", async () => {
        const { service: details } = service();
        const before = deferred<CommitCiDetailData>();
        const fetchDetail = vi.fn(() => before.promise);
        const old = details.getOrFetch(KEY, fetchDetail, SERVE);
        await vi.waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(1));

        details.clear();
        fetchDetail.mockImplementation(async () => detail({ outcome: "success" }));
        before.resolve(detail());

        await expect(old).resolves.toMatchObject({ outcome: "success" });
        expect(fetchDetail).toHaveBeenCalledTimes(2);
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

    it("a fetch that started before another window's clear() is not saved when it ends", async () => {
        const state = memento();
        const { service: windowA } = service(state);
        const fetched = deferred<CommitCiDetailData>();
        // Window A retries after the clear; the retry's detail is not one that is saved.
        const fetchDetail = vi
            .fn<() => Promise<CommitCiDetailData>>()
            .mockReturnValueOnce(fetched.promise)
            .mockResolvedValue(detail({ complete: false, outcome: "pending" }));
        const answer = windowA.getOrFetch(KEY, fetchDetail, SERVE);
        await vi.waitFor(() => expect(fetchDetail).toHaveBeenCalled());
        await new CiDetailPersistentCache(state).clear();
        fetched.resolve(detail());
        await answer;

        const { service: restarted } = service(state);
        const refetch = vi.fn(async () => detail({ complete: false, outcome: "pending" }));
        await restarted.getOrFetch(KEY, refetch, SERVE);
        expect(refetch, "the pre-clear detail was read back after a restart").toHaveBeenCalledTimes(
            1,
        );
    });

    it("a detail its caller rejects stays unreadable after a restart when removing it fails", async () => {
        const state = memento();
        const update = state.update;
        let failWrites = false;
        state.update = async (key: string, value: unknown) => {
            if (failWrites) throw new Error("storage write failed");
            await update(key, value);
        };
        const { service: details } = service(state);
        const rejected = new Error("caller rejected the detail");
        await expect(
            details.getOrFetch(
                KEY,
                async () => detail(),
                SERVE,
                {},
                async () => {
                    failWrites = true;
                    throw rejected;
                },
            ),
        ).rejects.toBe(rejected);
        failWrites = false;

        const { service: restarted } = service(state);
        const refetch = vi.fn(async () => detail({ complete: false, outcome: "pending" }));
        await restarted.getOrFetch(KEY, refetch, SERVE);
        expect(refetch, "the rejected detail was read back after a restart").toHaveBeenCalledTimes(
            1,
        );
    });

    it("traces a failed persistent save as a storage failure and keeps serving the detail from L1", async () => {
        const state = memento();
        state.update = async () => {
            throw new Error("storage write failed");
        };
        const trace = vi.fn();
        const details = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(state),
            trace,
        });
        const fetchDetail = vi.fn(async () => detail());

        await details.getOrFetch(KEY, fetchDetail, SERVE);
        await details.getOrFetch(KEY, fetchDetail, SERVE);

        expect(fetchDetail, "the detail was not kept in L1").toHaveBeenCalledTimes(1);
        const failures = trace.mock.calls
            .map(([event]) => event)
            .filter((event) => event.outcome === "failed");
        expect(failures, "the failed persistent save was not traced once").toEqual([
            {
                kind: "detail",
                outcome: "failed",
                reason: "storage",
                repoKey: "/repo",
                provider: "github",
                hash: "abc1234",
            },
        ]);
    });

    it("traces a failed confirm of the persistent save as a storage failure", async () => {
        const state = memento();
        const update = state.update;
        let failWrites = false;
        state.update = async (key: string, value: unknown) => {
            if (failWrites) throw new Error("storage write failed");
            await update(key, value);
        };
        const trace = vi.fn();
        const details = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(state),
            trace,
        });

        await details.getOrFetch(
            KEY,
            async () => detail(),
            SERVE,
            {},
            async () => {
                failWrites = true;
            },
        );

        expect(
            trace.mock.calls.map(([event]) => event),
            "the failed confirm of the persistent save was not traced",
        ).toContainEqual({
            kind: "detail",
            outcome: "failed",
            reason: "storage",
            repoKey: "/repo",
            provider: "github",
            hash: "abc1234",
        });
    });

    it("a detail its caller rejects after the save is removed, and a newer detail under the key is kept", async () => {
        const now = 1_000;
        const { service: details, persistent } = service(memento(), () => now);
        const rejected = new Error("caller rejected the detail");

        // Nothing newer: no layer keeps the rejected detail.
        await expect(
            details.getOrFetch(
                KEY,
                async () => detail(),
                SERVE,
                {},
                async () => {
                    throw rejected;
                },
            ),
        ).rejects.toBe(rejected);
        expect(await persistent.get(KEY)).toBeUndefined();
        const refetch = vi.fn(async () => detail({ complete: false, outcome: "pending" }));
        await details.getOrFetch(KEY, refetch, SERVE);
        expect(refetch).toHaveBeenCalledTimes(1);

        // A newer detail saved while the caller decides, in the same millisecond, is never removed.
        const other = `${KEY}-2`;
        let reject!: (error: Error) => void;
        const confirm = vi.fn(() => new Promise<void>((_, fail) => (reject = fail)));
        const old = details.getOrFetch(other, async () => detail(), SERVE, {}, confirm);
        await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
        await details.invalidate(other);
        await details.getOrFetch(other, async () => detail({ outcome: "success" }), SERVE);
        reject(rejected);
        await expect(old).rejects.toBe(rejected);
        const next = vi.fn(async () => detail({ complete: false, outcome: "pending" }));
        await expect(details.getOrFetch(other, next, SERVE)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(next).not.toHaveBeenCalled();
        expect(await persistent.get(other)).toMatchObject({ outcome: "success" });
    });

    it.each([
        ["invalidate", (details: CommitCiDetailService) => details.invalidate(KEY)],
        ["clear", (details: CommitCiDetailService) => details.clear()],
    ])(
        "%s during the persistent write: the caller gets the newer detail and no layer keeps the older one",
        async (_fence, fence) => {
            const state = memento();
            const writeStarted = deferred<void>();
            const releaseWrite = deferred<void>();
            const write = state.update;
            state.update = async (key, value) => {
                writeStarted.resolve();
                await releaseWrite.promise;
                await write(key, value);
            };
            const { service: details, persistent } = service(state);
            const fetchDetail = vi.fn(async () => detail({ outcome: "success" }));
            const caller = details.getOrFetch(KEY, fetchDetail, SERVE);
            await writeStarted.promise;

            const fenced = fence(details);
            fetchDetail.mockImplementation(async () => detail());
            releaseWrite.resolve();
            await fenced;

            await expect(caller).resolves.toMatchObject({ outcome: "failure" });
            const next = vi.fn(async () => detail({ complete: false, outcome: "pending" }));
            await expect(details.getOrFetch(KEY, next, SERVE)).resolves.toMatchObject({
                outcome: "failure",
            });
            expect(next).not.toHaveBeenCalled();
            expect(await persistent.get(KEY)).toMatchObject({ outcome: "failure" });
        },
    );
});

/** Another window over the same globalState; `clear()` resolves once its store clear has landed. */
function otherWindow(state: CommitChecksPersistentState): { clear: () => Promise<void> } {
    const { service: other, persistent } = service(state);
    return {
        clear: async () => {
            other.clear();
            // Queued behind the clear in the same store.
            await persistent.get(KEY);
        },
    };
}

describe("CommitCiDetailService once another window's clear() is visible", () => {
    const pending = (): CommitCiDetailData => detail({ complete: false, outcome: "pending" });

    it("an in-memory detail from before the clear is not served", async () => {
        const state = memento();
        const { service: windowA } = service(state);
        await windowA.getOrFetch(KEY, async () => detail(), SERVE);
        await otherWindow(state).clear();

        const refetch = vi.fn(async () => pending());
        const answer = await windowA.getOrFetch(KEY, refetch, SERVE);
        expect(answer.outcome, "the pre-clear in-memory detail was served").toBe("pending");
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("a forced refresh that fails after the clear does not fall back to the pre-clear detail", async () => {
        const state = memento();
        const { service: windowA } = service(state);
        await windowA.getOrFetch(KEY, async () => detail(), SERVE);
        await otherWindow(state).clear();

        const answer = await windowA.getOrFetch(
            KEY,
            async () =>
                detail({ complete: false, outcome: "unavailable", runs: [], error: "HTTP 502" }),
            SERVE,
            { force: true },
        );
        expect(answer.outcome, "the refresh fell back to the pre-clear detail").toBe("unavailable");
    });

    // A retry that joins its own request hangs; the short timeout names this test.
    it("a fetch in flight across the clear is not served, also to a caller that joined it", async () => {
        const state = memento();
        const { service: windowA } = service(state);
        const fetched = deferred<CommitCiDetailData>();
        const fetchDetail = vi
            .fn<() => Promise<CommitCiDetailData>>()
            .mockReturnValueOnce(fetched.promise)
            .mockResolvedValue(pending());
        const first = windowA.getOrFetch(KEY, fetchDetail, SERVE);
        await vi.waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(1));
        const joined = windowA.getOrFetch(KEY, fetchDetail, SERVE);
        await otherWindow(state).clear();
        fetched.resolve(detail());

        expect((await first).outcome, "the caller got the pre-clear detail").toBe("pending");
        expect((await joined).outcome, "the joined caller got the pre-clear detail").toBe(
            "pending",
        );
        expect(fetchDetail).toHaveBeenCalledTimes(2);
        const next = vi.fn(async () => detail({ outcome: "success" }));
        expect(
            (await windowA.getOrFetch(KEY, next, SERVE)).outcome,
            "the pre-clear detail was cached",
        ).toBe("pending");
    }, 10_000);

    it("a detail whose last wait (its confirm step) spans the clear is not served", async () => {
        const state = memento();
        const { service: windowA } = service(state);
        const other = otherWindow(state);
        let cleared = false;
        const confirm = vi.fn(async () => {
            if (cleared) return;
            cleared = true;
            await other.clear();
        });
        const fetchDetail = vi
            .fn<() => Promise<CommitCiDetailData>>()
            .mockResolvedValueOnce(detail())
            .mockResolvedValue(pending());

        const answer = await windowA.getOrFetch(KEY, fetchDetail, SERVE, {}, confirm);
        expect(answer.outcome, "the detail confirmed across the clear was served").toBe("pending");
        expect(fetchDetail).toHaveBeenCalledTimes(2);
    });

    it("a saved detail read across the clear is not served", async () => {
        const state = memento();
        await service(state).service.getOrFetch(KEY, async () => detail(), SERVE);
        const other = otherWindow(state);
        const update = state.update;
        let armed = true;
        // The clear lands while this window's read bumps the entry's last-access time.
        state.update = async (key: string, value: unknown) => {
            if (armed && key === STORAGE_KEY) {
                armed = false;
                await other.clear();
            }
            await update(key, value);
        };
        const { service: windowA } = service(state);

        const refetch = vi.fn(async () => pending());
        const answer = await windowA.getOrFetch(KEY, refetch, SERVE);
        expect(armed, "the clear never ran inside the read").toBe(false);
        expect(answer.outcome, "the saved detail read across the clear was served").toBe("pending");
    });
});
