import { describe, expect, it, vi } from "vitest";
import type {
    CommitCheckItem,
    CommitChecksSnapshot,
    CommitCiDetailData,
} from "../../../../src/types";
import {
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
} from "../../../../src/services/commitChecks/persistentCache";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";

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
    set(key: string, value: T): Promise<void>;
    get(key: string): Promise<unknown>;
    clear(): Promise<void>;
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

    it("delete with a fetch time removes only the entry written at that time", async () => {
        let now = 1_000;
        const cache = new CommitChecksPersistentCache(slowMemento(), { now: () => now });
        await cache.set(KEY, snapshot("failure"), 1_000);
        now = 2_000;
        await cache.set(KEY, snapshot("success"), 2_000);
        await cache.delete(KEY, 1_000);
        expect(await cache.get(KEY)).toMatchObject({ state: "success" });
        await cache.delete(KEY, 2_000);
        expect(await cache.get(KEY)).toBeUndefined();
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

    it("delete with a fetch time removes only the entry written at that time", async () => {
        let now = 1_000;
        const cache = new CiDetailPersistentCache(slowMemento(), { now: () => now });
        await cache.set(KEY, detail(), 1_000);
        now = 2_000;
        await cache.set(KEY, { ...detail(), outcome: "success" }, 2_000);
        await cache.delete(KEY, 1_000);
        expect(await cache.get(KEY)).toMatchObject({ outcome: "success" });
        await cache.delete(KEY, 2_000);
        expect(await cache.get(KEY)).toBeUndefined();
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
