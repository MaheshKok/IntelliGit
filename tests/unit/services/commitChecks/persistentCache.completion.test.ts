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

describe("CommitChecksPersistentCache completion and queue", () => {
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
