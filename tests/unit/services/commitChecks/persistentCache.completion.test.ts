import { describe, expect, it, vi } from "vitest";
import type {
    CommitCheckItem,
    CommitChecksSnapshot,
    CommitCiDetailData,
} from "../../../../src/types";
import {
    clearGenerationKey,
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
} from "../../../../src/services/commitChecks/persistentCache";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";

const KEY = "github:repo@abc1234:-";
const OLDER_KEY = "github:repo@def5678:-";
const STORE = "test.ci.store";

function item(state: CommitCheckItem["state"]): CommitCheckItem {
    return { name: state, description: "", state, source: "check-run" };
}

function snapshot(
    state: CommitChecksSnapshot["state"],
    items: CommitCheckItem[] = [item(state)],
): CommitChecksSnapshot {
    return { hash: "abc1234", state, summary: state, items };
}

function detail(): CommitCiDetailData {
    return {
        hash: "abc1234",
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

/** Memento whose writes land a macrotask later, like a real globalState flush. */
function slowMemento(initial: Record<string, unknown> = {}): CommitChecksPersistentState {
    const values = new Map<string, unknown>(Object.entries(initial));
    return {
        get: vi.fn((key: string) => values.get(key)),
        update: vi.fn(
            (key: string, value: unknown) =>
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        if (value === undefined) values.delete(key);
                        else values.set(key, value);
                        resolve();
                    }, 0);
                }),
        ),
    };
}

/**
 * globalState shared by two windows; while `hold` is set, every write started then waits
 * for it, like a flush from another window that lands late.
 */
function sharedMemento() {
    const values = new Map<string, unknown>();
    const state = {
        hold: undefined as Promise<void> | undefined,
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: vi.fn(async (key: string, value: unknown) => {
            await state.hold;
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }),
    };
    return state;
}

interface Store<T> {
    set(
        key: string,
        value: T,
        fetchedAt?: number,
        write?: { generation: string | undefined; id?: string },
    ): Promise<void>;
    get(key: string): Promise<unknown>;
    clear(): Promise<void>;
    delete(key: string, writeId?: string): Promise<void>;
    confirmWrite(key: string, writeId: string): Promise<void>;
    generation(): string | undefined;
}

/** Window A starts a fetch, window B clears, then A's fetch ends and A saves it. */
async function fetchStartedBeforeOtherWindowClear<T>(
    open: (state: CommitChecksPersistentState) => Store<T>,
    value: T,
): Promise<Store<T>> {
    const state = sharedMemento();
    const windowA = open(state);
    const generation = windowA.generation();
    await open(state).clear();
    await windowA.set(KEY, value, undefined, { generation });
    return open(state);
}

/** An unconfirmed write is unreadable, also after a restart, until its own id confirms it. */
async function unconfirmedWriteStaysUnreadable<T>(
    open: (state: CommitChecksPersistentState) => Store<T>,
    value: T,
): Promise<void> {
    const state = sharedMemento();
    const store = open(state);
    await store.set(KEY, value, undefined, { generation: store.generation(), id: "w1" });
    expect(await store.get(KEY), "unconfirmed write read back").toBeUndefined();
    expect(await open(state).get(KEY), "unconfirmed write read after restart").toBeUndefined();
    await store.confirmWrite(KEY, "w2");
    expect(await store.get(KEY), "another id confirmed the write").toBeUndefined();
    await store.confirmWrite(KEY, "w1");
    expect(await open(state).get(KEY), "confirmed write after restart").toBeDefined();
}

/** Two writes in the same millisecond: removing the first by its id keeps the second. */
async function deleteByWriteIdKeepsSameMillisecondWrite<T>(
    open: (state: CommitChecksPersistentState) => Store<T>,
    rejected: T,
    newer: T,
): Promise<{ afterOldDelete: unknown; afterOwnDelete: unknown }> {
    const store = open(slowMemento());
    await store.set(KEY, rejected, 1_000, { generation: store.generation(), id: "old" });
    await store.set(KEY, newer, 1_000);
    await store.delete(KEY, "old");
    const afterOldDelete = await store.get(KEY);
    await store.set(KEY, rejected, 1_000, { generation: store.generation(), id: "own" });
    await store.delete(KEY, "own");
    await store.confirmWrite(KEY, "own");
    return { afterOldDelete, afterOwnDelete: await store.get(KEY) };
}

/**
 * Window A runs `step` while window B's clear lands right after A's `nth` read of the store
 * (its payload or its clear generation), so between A's own reads and writes (or after
 * `step` when A reads fewer times). Returns a fresh window, where neither A's entry nor an
 * older one may be readable.
 */
async function otherWindowClearsMidStep<T>(
    open: (state: CommitChecksPersistentState) => Store<T>,
    value: T,
    nth: number,
    step: (windowA: Store<T>) => Promise<unknown>,
): Promise<Store<T>> {
    const values = new Map<string, unknown>();
    let reads: number | undefined;
    const clearFromWindowB = () => {
        reads = undefined;
        values.set(clearGenerationKey(STORE), "window-b-clear");
        values.delete(STORE);
    };
    const state: CommitChecksPersistentState = {
        get: <V>(key: string) => {
            const current = values.get(key) as V | undefined;
            const storeKey = key === STORE || key === clearGenerationKey(STORE);
            if (reads !== undefined && storeKey && ++reads === nth) {
                clearFromWindowB();
            }
            return current;
        },
        update: async (key: string, next: unknown) => {
            if (next === undefined) values.delete(key);
            else values.set(key, next);
        },
    };
    const windowA = open(state);
    await windowA.set(OLDER_KEY, value);
    reads = 0;
    await step(windowA);
    if (reads !== undefined) clearFromWindowB();
    return open(state);
}

/** A fetch's whole save: capture the generation, save unconfirmed, confirm. */
async function saveAndConfirm<T>(windowA: Store<T>, value: T): Promise<void> {
    await windowA.set(KEY, value, undefined, { generation: windowA.generation(), id: "w1" });
    await windowA.confirmWrite(KEY, "w1");
}

async function expectNothingSurvivesMidStepClears<T>(
    open: (state: CommitChecksPersistentState) => Store<T>,
    value: T,
): Promise<void> {
    const steps: [string, number, (windowA: Store<T>) => Promise<unknown>][] = [
        ["save", 8, (windowA) => saveAndConfirm(windowA, value)],
        ["get", 3, (windowA) => windowA.get(OLDER_KEY)],
    ];
    for (const [name, reads, step] of steps) {
        for (let nth = 1; nth <= reads; nth++) {
            const restarted = await otherWindowClearsMidStep(open, value, nth, step);
            expect(await restarted.get(KEY), `${name}, clear after read ${nth}`).toBeUndefined();
            expect(
                await restarted.get(OLDER_KEY),
                `${name}, clear after read ${nth}: older entry`,
            ).toBeUndefined();
        }
    }
}

/** Window A's write is held, window B clears, then A's write lands. */
async function lateWriteAfterOtherWindowClear<T>(
    open: (state: CommitChecksPersistentState) => Store<T>,
    value: T,
): Promise<{ windowA: Store<T>; windowB: Store<T>; restarted: Store<T> }> {
    const state = sharedMemento();
    const windowA = open(state);
    const windowB = open(state);
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    const write = windowA.set(KEY, value);
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    state.hold = undefined;
    await windowB.clear();
    release();
    await write;
    return { windowA, windowB, restarted: open(state) };
}

describe("CommitChecksPersistentCache completion and queue", () => {
    it("a write from another window that lands after clear() never brings the old entry back", async () => {
        const { windowA, windowB, restarted } = await lateWriteAfterOtherWindowClear(
            (state) => new CommitChecksPersistentCache(state),
            snapshot("failure"),
        );
        expect(await windowB.get(KEY)).toBeUndefined();
        expect(await windowA.get(KEY)).toBeUndefined();
        expect(await restarted.get(KEY)).toBeUndefined();

        // A write made after the clear is kept.
        await windowA.set(KEY, snapshot("success"));
        expect(await windowB.get(KEY)).toMatchObject({ state: "success" });
    });

    it("a write whose fetch started before another window's clear() is refused", async () => {
        const restarted = await fetchStartedBeforeOtherWindowClear(
            (state) => new CommitChecksPersistentCache(state, { now: () => 1_000 }),
            snapshot("failure"),
        );
        expect(await restarted.get(KEY)).toBeUndefined();
    });

    it("a clear from another window between a save's or a read's own steps leaves nothing readable", async () => {
        await expectNothingSurvivesMidStepClears(
            (state) => new CommitChecksPersistentCache(state, { storageKey: STORE }),
            snapshot("failure"),
        );
    });

    it("an unconfirmed write stays unreadable, also after a restart, until its id confirms it", async () => {
        await unconfirmedWriteStaysUnreadable(
            (state) => new CommitChecksPersistentCache(state, { now: () => 1_000 }),
            snapshot("failure"),
        );
    });

    it("delete with a write id removes only that write, never a newer one from the same millisecond", async () => {
        const result = await deleteByWriteIdKeepsSameMillisecondWrite(
            (state) => new CommitChecksPersistentCache(state, { now: () => 1_000 }),
            snapshot("failure"),
            snapshot("success"),
        );
        expect(result.afterOldDelete).toMatchObject({ state: "success" });
        expect(result.afterOwnDelete).toBeUndefined();
    });

    it("incomplete failure is not stored", async () => {
        const cache = new CommitChecksPersistentCache(slowMemento());
        await cache.set(KEY, snapshot("failure", [item("failure"), item("pending")]));
        expect(await cache.get(KEY)).toBeUndefined();

        await cache.set(KEY, snapshot("failure", [item("failure"), item("success")]));
        expect(await cache.get(KEY)).toMatchObject({ state: "failure" });

        await cache.set("none-key", snapshot("none", []));
        expect(await cache.get("none-key")).toMatchObject({ state: "none" });
    });

    it("an incomplete entry written by an older version is ignored", async () => {
        const now = 10_000;
        const state = slowMemento({
            "intelligit.commitChecks.cache.v1": {
                schemaVersion: 1,
                entries: [
                    {
                        key: KEY,
                        snapshot: snapshot("failure", [item("failure"), item("pending")]),
                        fetchedAt: now,
                        lastAccessedAt: now,
                        schemaVersion: 1,
                    },
                ],
            },
        });
        const cache = new CommitChecksPersistentCache(state, { now: () => now });
        expect(await cache.get(KEY)).toBeUndefined();
    });

    it("delete runs inside the enqueue chain", async () => {
        const cache = new CommitChecksPersistentCache(slowMemento());
        const write = cache.set(KEY, snapshot("failure"));
        const remove = cache.delete(KEY);
        await Promise.all([write, remove]);
        expect(await cache.get(KEY)).toBeUndefined();
    });

    it("pending work found later removes the settled entry; unavailable keeps it", async () => {
        const cache = new CommitChecksPersistentCache(slowMemento());
        await cache.set(KEY, snapshot("failure"));
        await cache.set(KEY, snapshot("unavailable", []));
        expect(await cache.get(KEY)).toMatchObject({ state: "failure" });

        await cache.set(KEY, snapshot("failure", [item("failure"), item("pending")]));
        expect(await cache.get(KEY)).toBeUndefined();
    });

    it("generation change while an old set is queued → the old entry never reappears", async () => {
        const cache = new CommitChecksPersistentCache(slowMemento());
        const write = cache.set(KEY, snapshot("failure"));
        const clear = cache.clear();
        await Promise.all([write, clear]);
        expect(await cache.get(KEY)).toBeUndefined();
    });
});

describe("CiDetailPersistentCache queue", () => {
    it("a write from another window that lands after clear() never brings the old entry back", async () => {
        const { windowA, windowB, restarted } = await lateWriteAfterOtherWindowClear(
            (state) => new CiDetailPersistentCache(state),
            detail(),
        );
        expect(await windowB.get(KEY)).toBeUndefined();
        expect(await windowA.get(KEY)).toBeUndefined();
        expect(await restarted.get(KEY)).toBeUndefined();

        await windowA.set(KEY, { ...detail(), outcome: "success" });
        expect(await windowB.get(KEY)).toMatchObject({ outcome: "success" });
    });

    it("a write whose fetch started before another window's clear() is refused", async () => {
        const restarted = await fetchStartedBeforeOtherWindowClear(
            (state) => new CiDetailPersistentCache(state, { now: () => 1_000 }),
            detail(),
        );
        expect(await restarted.get(KEY)).toBeUndefined();
    });

    it("a clear from another window between a save's or a read's own steps leaves nothing readable", async () => {
        await expectNothingSurvivesMidStepClears(
            (state) => new CiDetailPersistentCache(state, { storageKey: STORE }),
            detail(),
        );
    });

    it("an unconfirmed write stays unreadable, also after a restart, until its id confirms it", async () => {
        await unconfirmedWriteStaysUnreadable(
            (state) => new CiDetailPersistentCache(state, { now: () => 1_000 }),
            detail(),
        );
    });

    it("delete with a write id removes only that write, never a newer one from the same millisecond", async () => {
        const result = await deleteByWriteIdKeepsSameMillisecondWrite(
            (state) => new CiDetailPersistentCache(state, { now: () => 1_000 }),
            detail(),
            { ...detail(), outcome: "success" },
        );
        expect(result.afterOldDelete).toMatchObject({ outcome: "success" });
        expect(result.afterOwnDelete).toBeUndefined();
    });

    it("delete runs inside the enqueue chain", async () => {
        const cache = new CiDetailPersistentCache(slowMemento());
        const write = cache.set(KEY, detail());
        const remove = cache.delete(KEY);
        await Promise.all([write, remove]);
        expect(await cache.get(KEY)).toBeUndefined();
    });

    it("pending work found later removes the settled entry; unavailable keeps it", async () => {
        const cache = new CiDetailPersistentCache(slowMemento());
        await cache.set(KEY, detail());
        await cache.set(KEY, { ...detail(), complete: false, outcome: "unavailable" });
        expect(await cache.get(KEY)).toMatchObject({ outcome: "failure" });

        await cache.set(KEY, { ...detail(), complete: false, outcome: "pending" });
        expect(await cache.get(KEY)).toBeUndefined();
    });

    it("generation change while an old set is queued → the old entry never reappears", async () => {
        const cache = new CiDetailPersistentCache(slowMemento());
        const write = cache.set(KEY, detail());
        const clear = cache.clear();
        await Promise.all([write, clear]);
        expect(await cache.get(KEY)).toBeUndefined();

        await cache.set(KEY, detail());
        expect(await cache.get(KEY)).toMatchObject({ outcome: "failure" });
    });
});
