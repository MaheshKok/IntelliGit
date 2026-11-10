import { describe, expect, it, vi } from "vitest";
import type { CommitCheckItem, CommitChecksSnapshot } from "../../../../src/types";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import {
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
} from "../../../../src/services/commitChecks/persistentCache";

const KEY = "github:repo@abc1234:-";

function item(state: CommitCheckItem["state"]): CommitCheckItem {
    return { name: state, description: "", state, source: "check-run" };
}

function snapshot(
    state: CommitChecksSnapshot["state"],
    items: CommitCheckItem[] = [item(state)],
): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: state, items };
}

function memento(): CommitChecksPersistentState {
    const values = new Map<string, unknown>();
    return {
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

describe("CommitChecksService completion and per-key fence", () => {
    it("failed plus running item uses the pending TTL and is not persisted", async () => {
        let now = 1_000;
        const state = memento();
        const persistent = new CommitChecksPersistentCache(state, { now: () => now });
        const service = new CommitChecksService({
            ttlMs: 30_000,
            now: () => now,
            persistentCache: persistent,
        });
        const runningFailure = snapshot("failure", [item("failure"), item("pending")]);
        const fetchSnapshot = vi.fn(async () => runningFailure);

        await service.getOrFetch(KEY, fetchSnapshot);
        now += 29_000;
        await service.getOrFetch(KEY, fetchSnapshot);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        now += 2_000;
        await service.getOrFetch(KEY, fetchSnapshot);
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);

        expect(await persistent.get(KEY)).toBeUndefined();
        const fresh = new CommitChecksService({ now: () => now, persistentCache: persistent });
        const refetch = vi.fn(async () => snapshot("success"));
        await fresh.getOrFetch(KEY, refetch);
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("a fetch started before invalidate is not cached", async () => {
        const state = memento();
        const persistent = new CommitChecksPersistentCache(state);
        const service = new CommitChecksService({ persistentCache: persistent });
        const before = deferred<CommitChecksSnapshot>();
        const preInvalidate = vi.fn(() => before.promise);
        const old = service.getOrFetch(KEY, preInvalidate);
        // The L2 miss is awaited first; the request itself must be in flight.
        await vi.waitFor(() => expect(preInvalidate).toHaveBeenCalledTimes(1));

        await service.invalidate(KEY);
        // The fenced caller asks again; that second request is the post-invalidate one.
        preInvalidate.mockImplementation(async () => snapshot("pending"));
        before.resolve(snapshot("failure"));
        await old;

        const after = vi.fn(async () => snapshot("success"));
        await expect(service.getOrFetch(KEY, after)).resolves.toMatchObject({ state: "pending" });
        expect(after).not.toHaveBeenCalled();
        expect(await persistent.get(KEY)).toBeUndefined();
    });

    it("a fetch started before invalidate does not hand its result to its caller", async () => {
        const service = new CommitChecksService();
        const before = deferred<CommitChecksSnapshot>();
        const fetchSnapshot = vi.fn(() => before.promise);
        const old = service.getOrFetch(KEY, fetchSnapshot);
        const joined = service.getOrFetch(KEY, fetchSnapshot);

        await service.invalidate(KEY);
        fetchSnapshot.mockImplementation(async () => snapshot("pending"));
        before.resolve(snapshot("failure"));

        await expect(old).resolves.toMatchObject({ state: "pending" });
        await expect(joined).resolves.toMatchObject({ state: "pending" });
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    });

    it("a rejected persistent clear fails closed: the previous entry is never served", async () => {
        const state = memento();
        const persistent = new CommitChecksPersistentCache(state);
        const service = new CommitChecksService({ persistentCache: persistent });
        await service.getOrFetch(KEY, async () => snapshot("failure"));
        vi.mocked(state.update).mockImplementation(async (_key, value) => {
            if (value === undefined) throw new Error("storage is read-only");
        });

        service.clear();

        const refetch = vi.fn(async () => snapshot("success"));
        await expect(service.getOrFetch(KEY, refetch)).resolves.toMatchObject({
            state: "success",
        });
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("a failed clear still keeps the previous entry from a restarted service", async () => {
        const state = memento();
        const values = new Map<string, unknown>();
        vi.mocked(state.get).mockImplementation((key: string) => values.get(key) as never);
        vi.mocked(state.update).mockImplementation(async (key, value) => {
            values.set(key, value);
        });
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        await service.getOrFetch(KEY, async () => snapshot("failure"));
        // Removing the key fails; writing a value still works.
        vi.mocked(state.update).mockImplementation(async (key, value) => {
            if (value === undefined) throw new Error("cannot delete");
            values.set(key, value);
        });
        service.clear();
        await vi.waitFor(() =>
            expect(state.update).toHaveBeenCalledWith(expect.any(String), undefined),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        const restarted = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const refetch = vi.fn(async () => snapshot("success"));
        await expect(restarted.getOrFetch(KEY, refetch)).resolves.toMatchObject({
            state: "success",
        });
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("a fetch started before clear does not hand its result to its caller", async () => {
        const service = new CommitChecksService();
        const before = deferred<CommitChecksSnapshot>();
        const fetchSnapshot = vi.fn(() => before.promise);
        const old = service.getOrFetch(KEY, fetchSnapshot);

        service.clear();
        fetchSnapshot.mockImplementation(async () => snapshot("success"));
        before.resolve(snapshot("failure"));

        await expect(old).resolves.toMatchObject({ state: "success" });
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    });

    it("a forced refresh that finds pending work drops the settled entry from L2", async () => {
        const state = memento();
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        await service.getOrFetch(KEY, async () => snapshot("failure"));
        await service.getOrFetch(KEY, async () => snapshot("pending"), { force: true });

        const restarted = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const refetch = vi.fn(async () => snapshot("pending"));
        await expect(restarted.getOrFetch(KEY, refetch)).resolves.toMatchObject({
            state: "pending",
        });
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("an unavailable forced refresh keeps the settled entry in L2", async () => {
        const state = memento();
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        await service.getOrFetch(KEY, async () => snapshot("failure"));
        await service.getOrFetch(KEY, async () => snapshot("unavailable", []), { force: true });

        const restarted = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const refetch = vi.fn(async () => snapshot("pending"));
        await expect(restarted.getOrFetch(KEY, refetch)).resolves.toMatchObject({
            state: "failure",
        });
        expect(refetch).not.toHaveBeenCalled();
    });

    it("traces snapshot fetches and cache hits without the cache key", async () => {
        const state = memento();
        await new CommitChecksPersistentCache(state).set(KEY, snapshot("success"));
        const trace = vi.fn();
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
            trace,
        });

        await service.getOrFetch(KEY, async () => snapshot("pending"), {}, "github");
        await service.getOrFetch(KEY, async () => snapshot("pending"), {}, "github");
        await service.getOrFetch(
            "other@def5678:-",
            async () => ({ ...snapshot("pending"), hash: "def5678" }),
            {},
            "gitlab",
        );

        expect(trace.mock.calls.map(([event]) => event)).toEqual([
            { kind: "snapshot", outcome: "hit-l2", provider: "github", hash: "abc1234" },
            { kind: "snapshot", outcome: "hit-l1", provider: "github", hash: "abc1234" },
            {
                kind: "snapshot",
                outcome: "incomplete",
                provider: "gitlab",
                hash: "def5678",
                ms: expect.any(Number),
            },
        ]);
        expect(JSON.stringify(trace.mock.calls)).not.toContain("github:repo");
    });

    it("traces a failed persistent save as a storage failure and keeps serving the answer from L1", async () => {
        const state = memento();
        state.update = async () => {
            throw new Error("storage write failed");
        };
        const trace = vi.fn();
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
            trace,
        });
        const fetchSnapshot = vi.fn(async () => snapshot("success"));

        await service.getOrFetch(KEY, fetchSnapshot, {}, "github");
        await service.getOrFetch(KEY, fetchSnapshot, {}, "github");

        expect(fetchSnapshot, "the answer was not kept in L1").toHaveBeenCalledTimes(1);
        const failures = trace.mock.calls
            .map(([event]) => event)
            .filter((event) => event.outcome === "failed");
        expect(failures, "the failed persistent save was not traced once").toEqual([
            {
                kind: "snapshot",
                outcome: "failed",
                reason: "storage",
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
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
            trace,
        });

        await service.getOrFetch(
            KEY,
            async () => snapshot("success"),
            {},
            "github",
            async () => {
                failWrites = true;
            },
        );

        expect(
            trace.mock.calls.map(([event]) => event),
            "the failed confirm of the persistent save was not traced",
        ).toContainEqual({
            kind: "snapshot",
            outcome: "failed",
            reason: "storage",
            provider: "github",
            hash: "abc1234",
        });
    });

    it("force after invalidate does not join the pre-invalidate fetch", async () => {
        const service = new CommitChecksService();
        const before = deferred<CommitChecksSnapshot>();
        const preInvalidate = vi.fn(() => before.promise);
        const old = service.getOrFetch(KEY, preInvalidate);

        await service.invalidate(KEY);
        const postInvalidate = vi.fn(async () => snapshot("pending"));
        const forced = service.getOrFetch(KEY, postInvalidate, { force: true });
        // Checked before the old request settles: joining it would never start this fetch.
        expect(postInvalidate, "forced fetch started without joining").toHaveBeenCalledTimes(1);

        before.resolve(snapshot("failure"));
        await expect(forced).resolves.toMatchObject({ state: "pending" });
        await old;
        expect(preInvalidate).toHaveBeenCalledTimes(1);
        expect(postInvalidate).toHaveBeenCalledTimes(1);
    });

    it("invalidate deletes the persisted entry (new service over the same Memento misses)", async () => {
        const state = memento();
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        await service.getOrFetch(KEY, async () => snapshot("failure"));

        await service.invalidate(KEY);

        const restarted = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const refetch = vi.fn(async () => snapshot("pending"));
        await expect(restarted.getOrFetch(KEY, refetch)).resolves.toMatchObject({
            state: "pending",
        });
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("a fetch that started before another window's clear() is not saved when it ends", async () => {
        const state = memento();
        const windowA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const fetched = deferred<CommitChecksSnapshot>();
        // Window A retries after the clear; the retry's answer is not one that is saved.
        const fetchSnapshot = vi
            .fn<() => Promise<CommitChecksSnapshot>>()
            .mockReturnValueOnce(fetched.promise)
            .mockResolvedValue(snapshot("pending"));
        const answer = windowA.getOrFetch(KEY, fetchSnapshot);
        await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalled());
        await new CommitChecksPersistentCache(state).clear();
        fetched.resolve(snapshot("failure"));
        await answer;

        const restarted = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const refetch = vi.fn(async () => snapshot("pending"));
        await restarted.getOrFetch(KEY, refetch);
        expect(refetch, "the pre-clear answer was read back after a restart").toHaveBeenCalledTimes(
            1,
        );
    });

    it("an answer its caller rejects stays unreadable after a restart when removing it fails", async () => {
        const state = memento();
        const update = state.update;
        let failWrites = false;
        state.update = async (key: string, value: unknown) => {
            if (failWrites) throw new Error("storage write failed");
            await update(key, value);
        };
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const rejected = new Error("caller rejected the answer");
        await expect(
            service.getOrFetch(
                KEY,
                async () => snapshot("failure"),
                {},
                undefined,
                async () => {
                    failWrites = true;
                    throw rejected;
                },
            ),
        ).rejects.toBe(rejected);
        failWrites = false;

        const restarted = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const refetch = vi.fn(async () => snapshot("pending"));
        await restarted.getOrFetch(KEY, refetch);
        expect(refetch, "the rejected answer was read back after a restart").toHaveBeenCalledTimes(
            1,
        );
    });

    it("a persisted read that ends while a forced refresh confirms its save shares the refresh's rejection", async () => {
        const persistent = new CommitChecksPersistentCache(memento());
        await persistent.set(KEY, snapshot("failure"));
        const service = new CommitChecksService({ persistentCache: persistent });
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

        const slow = service.getOrFetch(KEY, async () => snapshot("pending"));
        const forced = service.getOrFetch(
            KEY,
            async () => snapshot("success"),
            { force: true },
            undefined,
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

    it("a saved copy read after an expired in-memory entry replaces that entry", async () => {
        let now = 1_000;
        const persistent = new CommitChecksPersistentCache(memento(), { now: () => now });
        const service = new CommitChecksService({ now: () => now, persistentCache: persistent });
        await service.getOrFetch(KEY, async () => snapshot("pending"));
        // Another window saved the settled answer.
        await persistent.set(KEY, snapshot("success"));
        now += 31_000;
        const next = vi.fn(async () => snapshot("pending"));
        await expect(service.getOrFetch(KEY, next)).resolves.toMatchObject({ state: "success" });
        // With the saved copy gone, only the in-memory replacement can answer.
        await persistent.delete(KEY);
        await expect(service.getOrFetch(KEY, next)).resolves.toMatchObject({ state: "success" });
        expect(next).not.toHaveBeenCalled();
    });

    it("a persisted read that outlives a forced refresh's short-lived answer fetches again", async () => {
        let now = 1_000;
        const persistent = new CommitChecksPersistentCache(memento(), { now: () => now });
        await persistent.set(KEY, snapshot("failure"));
        const service = new CommitChecksService({ now: () => now, persistentCache: persistent });
        const releaseRead = deferred<void>();
        const read = persistent.get.bind(persistent);
        vi.spyOn(persistent, "get").mockImplementationOnce(async (key) => {
            const value = await read(key);
            await releaseRead.promise;
            return value;
        });

        const slow = service.getOrFetch(KEY, async () => snapshot("success"));
        await service.getOrFetch(KEY, async () => snapshot("pending"), { force: true });
        now += 31_000;
        releaseRead.resolve();

        // Neither the expired refresh nor the older saved copy is served.
        await expect(slow).resolves.toMatchObject({ state: "success" });
    });

    it("an answer its caller rejects after the save is removed, and a newer answer under the key is kept", async () => {
        const now = 1_000;
        const state = memento();
        const persistent = new CommitChecksPersistentCache(state, { now: () => now });
        const service = new CommitChecksService({ now: () => now, persistentCache: persistent });
        const rejected = new Error("caller rejected the answer");

        // Nothing newer: no layer keeps the rejected answer.
        await expect(
            service.getOrFetch(
                KEY,
                async () => snapshot("failure"),
                {},
                undefined,
                async () => {
                    throw rejected;
                },
            ),
        ).rejects.toBe(rejected);
        expect(await persistent.get(KEY)).toBeUndefined();
        const refetch = vi.fn(async () => snapshot("pending"));
        await service.getOrFetch(KEY, refetch);
        expect(refetch).toHaveBeenCalledTimes(1);

        // A newer answer saved while the caller decides, in the same millisecond, is never removed.
        const other = `${KEY}-2`;
        let reject!: (error: Error) => void;
        const confirm = vi.fn(() => new Promise<void>((_, fail) => (reject = fail)));
        const old = service.getOrFetch(
            other,
            async () => snapshot("failure"),
            {},
            undefined,
            confirm,
        );
        await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
        await service.invalidate(other);
        await service.getOrFetch(other, async () => snapshot("success"));
        reject(rejected);
        await expect(old).rejects.toBe(rejected);
        const next = vi.fn(async () => snapshot("pending"));
        await expect(service.getOrFetch(other, next)).resolves.toMatchObject({ state: "success" });
        expect(next).not.toHaveBeenCalled();
        expect(await persistent.get(other)).toMatchObject({ state: "success" });
    });

    it("a persisted read that started before invalidate is not served", async () => {
        const state = memento();
        const persistent = new CommitChecksPersistentCache(state);
        await persistent.set(KEY, snapshot("failure"));
        const service = new CommitChecksService({ persistentCache: persistent });

        // The L2 read is queued before the delete, so it still sees the old entry.
        const stale = service.getOrFetch(KEY, async () => snapshot("pending"));
        await service.invalidate(KEY);

        await expect(stale).resolves.toMatchObject({ state: "pending" });
        const next = vi.fn(async () => snapshot("pending"));
        await expect(service.getOrFetch(KEY, next)).resolves.toMatchObject({ state: "pending" });
        expect(next).not.toHaveBeenCalled();
    });

    it("a persisted read that ends after a forced refresh does not replace the refreshed answer", async () => {
        const persistent = new CommitChecksPersistentCache(memento());
        await persistent.set(KEY, snapshot("failure"));
        const service = new CommitChecksService({ persistentCache: persistent });
        const releaseRead = deferred<void>();
        const read = persistent.get.bind(persistent);
        vi.spyOn(persistent, "get").mockImplementationOnce(async (key) => {
            const value = await read(key);
            await releaseRead.promise;
            return value;
        });

        // The read has already seen the old entry when the forced refresh lands.
        const slow = service.getOrFetch(KEY, async () => snapshot("pending"));
        await expect(
            service.getOrFetch(KEY, async () => snapshot("success"), { force: true }),
        ).resolves.toMatchObject({ state: "success" });
        releaseRead.resolve();

        await expect(slow).resolves.toMatchObject({ state: "success" });
        const next = vi.fn(async () => snapshot("pending"));
        await expect(service.getOrFetch(KEY, next)).resolves.toMatchObject({ state: "success" });
        expect(next).not.toHaveBeenCalled();
    });

    it.each([
        ["invalidate", (service: CommitChecksService) => service.invalidate(KEY)],
        ["clear", (service: CommitChecksService) => service.clear()],
    ])(
        "%s during the persistent write: the caller gets the newer result and no layer keeps the older one",
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
            const persistent = new CommitChecksPersistentCache(state);
            const service = new CommitChecksService({ persistentCache: persistent });
            const fetchSnapshot = vi.fn(async () => snapshot("success"));
            const caller = service.getOrFetch(KEY, fetchSnapshot);
            await writeStarted.promise;

            const fenced = fence(service);
            fetchSnapshot.mockImplementation(async () => snapshot("failure"));
            releaseWrite.resolve();
            await fenced;

            await expect(caller).resolves.toMatchObject({ state: "failure" });
            const next = vi.fn(async () => snapshot("pending"));
            await expect(service.getOrFetch(KEY, next)).resolves.toMatchObject({
                state: "failure",
            });
            expect(next).not.toHaveBeenCalled();
            expect(await persistent.get(KEY)).toMatchObject({ state: "failure" });
        },
    );
});

/** Another window over the same globalState; `clear()` resolves once its store clear has landed. */
function otherWindow(state: CommitChecksPersistentState): { clear: () => Promise<void> } {
    const store = new CommitChecksPersistentCache(state);
    const service = new CommitChecksService({ persistentCache: store });
    return {
        clear: async () => {
            service.clear();
            // Queued behind the clear in the same store.
            await store.get(KEY);
        },
    };
}

describe("CommitChecksService once another window's clear() is visible", () => {
    it("an in-memory answer from before the clear is not served", async () => {
        const state = memento();
        const windowA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        await windowA.getOrFetch(KEY, async () => snapshot("failure"));
        await otherWindow(state).clear();

        const refetch = vi.fn(async () => snapshot("pending"));
        const answer = await windowA.getOrFetch(KEY, refetch);
        expect(answer.state, "the pre-clear in-memory answer was served").toBe("pending");
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    // A retry that joins its own request hangs; the short timeout names this test.
    it("a fetch in flight across the clear is not served, also to a caller that joined it", async () => {
        const state = memento();
        const windowA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const fetched = deferred<CommitChecksSnapshot>();
        const fetchSnapshot = vi
            .fn<() => Promise<CommitChecksSnapshot>>()
            .mockReturnValueOnce(fetched.promise)
            .mockResolvedValue(snapshot("pending"));
        const first = windowA.getOrFetch(KEY, fetchSnapshot);
        await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(1));
        const joined = windowA.getOrFetch(KEY, fetchSnapshot);
        await otherWindow(state).clear();
        fetched.resolve(snapshot("failure"));

        expect((await first).state, "the caller got the pre-clear answer").toBe("pending");
        expect((await joined).state, "the joined caller got the pre-clear answer").toBe("pending");
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        const next = vi.fn(async () => snapshot("success"));
        expect((await windowA.getOrFetch(KEY, next)).state, "the pre-clear answer was cached").toBe(
            "pending",
        );
    }, 10_000);

    it("an answer whose last wait (its confirm step) spans the clear is not served", async () => {
        const state = memento();
        const windowA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });
        const other = otherWindow(state);
        let cleared = false;
        const confirm = vi.fn(async () => {
            if (cleared) return;
            cleared = true;
            await other.clear();
        });
        const fetchSnapshot = vi
            .fn<() => Promise<CommitChecksSnapshot>>()
            .mockResolvedValueOnce(snapshot("failure"))
            .mockResolvedValue(snapshot("pending"));

        const answer = await windowA.getOrFetch(KEY, fetchSnapshot, {}, undefined, confirm);
        expect(answer.state, "the answer confirmed across the clear was served").toBe("pending");
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    });

    it("a saved answer read across the clear is not served", async () => {
        const state = memento();
        await new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        }).getOrFetch(KEY, async () => snapshot("failure"));
        const other = otherWindow(state);
        const update = state.update;
        let armed = true;
        // The clear lands while this window's read bumps the entry's last-access time.
        state.update = async (key: string, value: unknown) => {
            if (armed && key === "intelligit.commitChecks.cache.v1") {
                armed = false;
                await other.clear();
            }
            await update(key, value);
        };
        const windowA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(state),
        });

        const refetch = vi.fn(async () => snapshot("pending"));
        const answer = await windowA.getOrFetch(KEY, refetch);
        expect(armed, "the clear never ran inside the read").toBe(false);
        expect(answer.state, "the saved answer read across the clear was served").toBe("pending");
    });
});
