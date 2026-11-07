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
        before.resolve(snapshot("failure"));
        await old;

        const after = vi.fn(async () => snapshot("pending"));
        await expect(service.getOrFetch(KEY, after)).resolves.toMatchObject({ state: "pending" });
        expect(after).toHaveBeenCalledTimes(1);
        expect(await persistent.get(KEY)).toBeUndefined();
    });

    it("force after invalidate does not join the pre-invalidate fetch", async () => {
        const service = new CommitChecksService();
        const before = deferred<CommitChecksSnapshot>();
        const preInvalidate = vi.fn(() => before.promise);
        const old = service.getOrFetch(KEY, preInvalidate);

        await service.invalidate(KEY);
        const postInvalidate = vi.fn(async () => snapshot("pending"));
        const forced = service.getOrFetch(KEY, postInvalidate, { force: true });

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
});
