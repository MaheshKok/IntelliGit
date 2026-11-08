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
        const fetchDetail = vi.fn(() => fetched.promise);
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
