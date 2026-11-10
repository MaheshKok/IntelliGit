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
import { CI_DETAIL_CONTRACT_VERSION } from "../../../../src/shared/ci/contractVersion";

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

/** Settles to "ok" or to the error text, so a throw shows up under the assertion's label. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        (value) => value ?? "ok",
        (error: unknown) => `threw: ${String(error)}`,
    );
}

/**
 * Each bad entry is saved under KEY next to a valid entry under OLDER_KEY: reading KEY is a
 * miss, the valid entry stays readable, and a new save under KEY replaces the bad entry.
 */
async function badEntriesReadAsMissAndGetReplaced<T>(
    open: (state: CommitChecksPersistentState) => Store<T>,
    payload: (entries: unknown[]) => unknown,
    valid: unknown,
    badEntries: [string, unknown][],
    value: T,
): Promise<void> {
    for (const [name, bad] of badEntries) {
        const store = open(slowMemento({ [STORE]: payload([bad, valid]) }));
        expect(await outcome(store.get(KEY)), `${name}: read`).toBe("ok");
        expect(await outcome(store.get(OLDER_KEY)), `${name}: valid entry`).toMatchObject({
            hash: "abc1234",
        });
        expect(await outcome(store.set(KEY, value)), `${name}: replacement save`).toBe("ok");
        expect(await outcome(store.get(KEY)), `${name}: replacement read`).toMatchObject({
            hash: "abc1234",
        });
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

    it("an entry with a bad shape reads as a miss and the next save replaces it", async () => {
        const entry = (fields: Record<string, unknown>) => ({
            key: KEY,
            snapshot: snapshot("failure"),
            fetchedAt: 1_000,
            lastAccessedAt: 1_000,
            schemaVersion: 1,
            ...fields,
        });
        await badEntriesReadAsMissAndGetReplaced(
            (state) =>
                new CommitChecksPersistentCache(state, { storageKey: STORE, now: () => 1_000 }),
            (entries) => ({ schemaVersion: 1, entries, unconfirmed: {} }),
            entry({ key: OLDER_KEY }),
            [
                ["null entry", null],
                ["null snapshot", entry({ snapshot: null })],
                ["null check item", entry({ snapshot: { ...snapshot("failure"), items: [null] } })],
                ["invalid state", entry({ snapshot: { ...snapshot("failure"), state: "bogus" } })],
                [
                    "invalid item state",
                    entry({
                        snapshot: {
                            ...snapshot("failure"),
                            items: [{ ...item("failure"), state: "bogus" }],
                        },
                    }),
                ],
                [
                    "missing summary",
                    entry({ snapshot: { ...snapshot("failure"), summary: undefined } }),
                ],
                [
                    "numeric item url",
                    entry({
                        snapshot: {
                            ...snapshot("failure"),
                            items: [{ ...item("failure"), url: 1 }],
                        },
                    }),
                ],
            ],
            snapshot("failure"),
        );
    });

    it("a saved snapshot with every optional field set is served", async () => {
        const full: CommitChecksSnapshot = {
            ...snapshot("failure", [
                {
                    ...item("failure"),
                    source: "status",
                    url: "https://ci",
                    id: "1",
                    logicalId: "lint",
                },
            ]),
            error: "partial",
            signInHost: "github.com",
        };
        const cache = new CommitChecksPersistentCache(slowMemento(), { now: () => 1_000 });
        await cache.set(KEY, full);
        expect(await cache.get(KEY)).toEqual(full);
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

    it("an entry with a bad shape, also deep inside its runs, reads as a miss and the next save replaces it", async () => {
        const job = {
            id: "j",
            logicalId: "j",
            name: "j",
            checkName: "j",
            state: "failure",
            steps: [],
        };
        const run = { id: "r", name: "ci", state: "failure", jobs: [job], jobsCoverage: "full" };
        const entry = (data: Record<string, unknown> | null) => ({
            key: KEY,
            contractVersion: CI_DETAIL_CONTRACT_VERSION,
            data: data && { ...detail(), runs: [run], ...data },
            fetchedAt: 1_000,
            lastAccessedAt: 1_000,
        });
        await badEntriesReadAsMissAndGetReplaced(
            (state) => new CiDetailPersistentCache(state, { storageKey: STORE, now: () => 1_000 }),
            (entries) => ({ entries, unconfirmed: {} }),
            { ...entry({}), key: OLDER_KEY },
            [
                ["null entry", null],
                ["null data", entry(null)],
                ["null run", entry({ runs: [null] })],
                ["null job", entry({ runs: [{ ...run, jobs: [null] }] })],
                ["null step", entry({ runs: [{ ...run, jobs: [{ ...job, steps: [null] }] }] })],
                ["null other check", entry({ otherChecks: [null] })],
                ["null attempt history", entry({ attemptHistory: [null] })],
                [
                    "null attempt",
                    entry({ attemptHistory: [{ coverage: "full", attempts: [null] }] }),
                ],
                ["numeric job state", entry({ runs: [{ ...run, jobs: [{ ...job, state: 3 }] }] })],
                ["invalid run state", entry({ runs: [{ ...run, state: "bogus" }] })],
                [
                    "invalid step state",
                    entry({
                        runs: [
                            {
                                ...run,
                                jobs: [
                                    { ...job, steps: [{ number: 1, name: "s", state: "bogus" }] },
                                ],
                            },
                        ],
                    }),
                ],
                [
                    "invalid other check state",
                    entry({
                        otherChecks: [
                            { name: "c", description: "", state: "bogus", source: "status" },
                        ],
                    }),
                ],
                [
                    "invalid attempt state",
                    entry({
                        attemptHistory: [
                            {
                                runId: "r",
                                logicalId: "j",
                                coverage: "full",
                                attempts: [{ attempt: 1, executionId: "j", state: 7 }],
                            },
                        ],
                    }),
                ],
                ["invalid provider", entry({ provider: "nope" })],
                ["missing outcome", entry({ outcome: undefined })],
                [
                    "string job attempt",
                    entry({ runs: [{ ...run, jobs: [{ ...job, attempt: "1" }] }] }),
                ],
            ],
            detail(),
        );
    });

    it("a saved detail with every optional field set is served", async () => {
        const full: CommitCiDetailData = {
            ...detail(),
            runs: [
                {
                    id: "r",
                    name: "ci",
                    url: "https://ci/r",
                    state: "failure",
                    workflowId: "w",
                    event: "push",
                    actor: "me",
                    ref: "main",
                    runNumber: 4,
                    attempt: 2,
                    createdAt: "t0",
                    startedAt: "t1",
                    completedAt: "t2",
                    usualDurationMs: null,
                    jobs: [
                        {
                            id: "j",
                            logicalId: "lj",
                            checkRunId: "c",
                            name: "j",
                            checkName: "ci / j",
                            state: "failure",
                            url: "https://ci/j",
                            startedAt: "t1",
                            completedAt: "t2",
                            attempt: 2,
                            steps: [
                                {
                                    number: 1,
                                    name: "s",
                                    state: "success",
                                    startedAt: "t1",
                                    completedAt: "t2",
                                },
                            ],
                            annotationCount: 3,
                            optional: false,
                            required: "yes",
                            failureSummary: "boom",
                            usualDurationMs: 60_000,
                        },
                    ],
                    jobsCoverage: "full",
                },
            ],
            otherChecks: [
                {
                    id: "s",
                    logicalId: "ls",
                    name: "status",
                    description: "d",
                    state: "success",
                    source: "build",
                    url: "https://ci/s",
                    durationMs: null,
                    required: "unknown",
                    usualDurationMs: 5,
                },
            ],
            requiredStatus: "partial",
            attemptHistory: [
                {
                    runId: "r",
                    logicalId: "lj",
                    attempts: [
                        {
                            attempt: 1,
                            executionId: "j0",
                            state: "failure",
                            startedAt: "t0",
                            completedAt: "t1",
                        },
                    ],
                    coverage: "full",
                },
            ],
            error: "partial",
            signInHost: "github.com",
        };
        const cache = new CiDetailPersistentCache(slowMemento(), { now: () => 1_000 });
        await cache.set(KEY, full);
        expect(await cache.get(KEY)).toEqual(full);
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
