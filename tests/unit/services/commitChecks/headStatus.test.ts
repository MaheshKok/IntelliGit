import { mkdtemp, mkdir, readdir, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    NO_CI_CAPABILITIES,
    type ProviderCiCapabilities,
} from "../../../../src/shared/ci/capabilities";
import type {
    CiCoverage,
    CiState,
    CommitCheckState,
    CommitChecksSnapshot,
    CommitCiDetail,
} from "../../../../src/types";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

vi.mock("vscode", () => ({
    l10n: {
        t: (message: string, ...args: unknown[]) =>
            message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    },
}));

import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import {
    ACTION_FENCE_NOT_SEEN_MS,
    CiActionFenceStore,
} from "../../../../src/services/commitChecks/ciActionFence";
import {
    formatHeadStatusText,
    HeadCiStatus,
    HeadSettleToast,
    HeadStatusBar,
    PENDING_OBSERVED_KEY,
    readHeadStatusSettings,
    type HeadCiStatusDeps,
    type HeadStatusBarItem,
} from "../../../../src/services/commitChecks/headStatus";

const REPO = "/repo";
const HASH = "a".repeat(40);
const NEXT_HASH = "b".repeat(40);
const RUNS_CAPS: ProviderCiCapabilities = {
    ...NO_CI_CAPABILITIES,
    runs: true,
    jobs: true,
    logs: true,
    rerunFailed: true,
};

function snapshotOf(states: CommitCheckState[], hash = HASH): CommitChecksSnapshot {
    const state: CommitCheckState = states.includes("failure")
        ? "failure"
        : states.includes("pending")
          ? "pending"
          : states.length > 0
            ? "success"
            : "none";
    return {
        hash,
        state,
        summary: `summary:${state}`,
        items: states.map((itemState, index) => ({
            name: `check-${index}`,
            description: "",
            state: itemState,
            source: "check-run",
        })),
    };
}

function detailOf(
    jobs: CiState[],
    options: { runsCoverage?: CiCoverage; startedAt?: string; hash?: string } = {},
): CommitCiDetail {
    const running = jobs.some((state) => state === "queued" || state === "running");
    const failed = jobs.includes("failure");
    const runState: CiState = running ? "running" : failed ? "failure" : "success";
    return {
        hash: options.hash ?? HASH,
        provider: "github",
        complete: !running,
        outcome: running ? "pending" : failed ? "failure" : "success",
        runs: [
            {
                id: "run-1",
                name: "CI",
                state: runState,
                startedAt: options.startedAt,
                jobs: jobs.map((state, index) => ({
                    id: `job-${index}`,
                    logicalId: `ci/job-${index}`,
                    name: `job-${index}`,
                    checkName: `job-${index}`,
                    state,
                    steps: [],
                })),
                jobsCoverage: "full",
            },
        ],
        runsCoverage: options.runsCoverage ?? "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: RUNS_CAPS,
        repoKey: REPO,
    };
}

function fakeMemento(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        store,
        get<T>(key: string, fallback?: T): T | undefined {
            return (store.has(key) ? store.get(key) : fallback) as T | undefined;
        },
        keys: () => [...store.keys()],
        update: async (key: string, value: unknown): Promise<void> => {
            if (value === undefined) store.delete(key);
            else store.set(key, value);
        },
    };
}

interface FakeItem extends HeadStatusBarItem {
    shown: boolean;
}

function fakeItem(): FakeItem {
    const item: FakeItem = {
        text: "",
        tooltip: undefined,
        command: undefined,
        shown: false,
        show: () => {
            item.shown = true;
        },
        hide: () => {
            item.shown = false;
        },
        dispose: () => {
            item.shown = false;
        },
    };
    return item;
}

type Snapshots = (CommitChecksSnapshot | (() => Promise<CommitChecksSnapshot>))[];
type Details = (CommitCiDetail | (() => Promise<CommitCiDetail>))[];

interface Harness {
    deps: HeadCiStatusDeps;
    items: FakeItem[];
    snapshot: ReturnType<typeof vi.fn>;
    detail: ReturnType<typeof vi.fn>;
    invalidateDetail: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    openChecks: ReturnType<typeof vi.fn>;
    memento: ReturnType<typeof fakeMemento>;
    generations: CiGenerations;
    setHead(hash: string | undefined): void;
    setFocused(focused: boolean): void;
    setCooldown(until: number): void;
}

/**
 * A detail source like the real one: a forced fetch joins a request already running for the
 * hash unless `invalidateDetail` dropped it first (service.ts:81-82, detailService.ts:359).
 */
function makeHarness(
    options: {
        snapshots?: Snapshots;
        details?: Details;
        caps?: ProviderCiCapabilities | undefined;
        switchOn?: boolean;
        enabled?: boolean;
        statusBar?: boolean;
        notifyOnSettle?: boolean;
        unpushed?: boolean;
        memento?: ReturnType<typeof fakeMemento>;
        claimDir?: string;
        focused?: boolean;
        isFenced?: (hash: string) => boolean;
        mkdir?: HeadCiStatusDeps["mkdir"];
        show?: ReturnType<typeof vi.fn>;
    } = {},
): Harness {
    let head: string | undefined = HASH;
    let focused = options.focused ?? true;
    let cooldown = 0;
    const snapshots = options.snapshots ?? [snapshotOf(["pending"])];
    const details = options.details ?? [detailOf(["running"])];
    let snapshotIndex = 0;
    let detailIndex = 0;
    const inflight = new Map<string, Promise<CommitCiDetail>>();
    const items: FakeItem[] = [];
    const generations = new CiGenerations();
    const memento = options.memento ?? fakeMemento();
    const snapshot = vi.fn(async () => {
        const next = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return typeof next === "function" ? next() : next;
    });
    const detail = vi.fn((hash: string) => {
        const running = inflight.get(hash);
        if (running) return running;
        const next = details[Math.min(detailIndex, details.length - 1)];
        detailIndex += 1;
        const request = typeof next === "function" ? next() : Promise.resolve(next);
        inflight.set(hash, request);
        void request.finally(() => {
            if (inflight.get(hash) === request) inflight.delete(hash);
        });
        return request;
    });
    const invalidateDetail = vi.fn(async (hash: string) => {
        inflight.delete(hash);
    });
    const show =
        options.show ?? vi.fn(async (_message: string, ..._buttons: string[]) => undefined);
    const openChecks = vi.fn(async () => undefined);
    const deps: HeadCiStatusDeps = {
        switchOn: () => options.switchOn ?? true,
        enabled: () => options.enabled ?? true,
        settings: () => ({
            statusBar: options.statusBar ?? true,
            notifyOnSettle: options.notifyOnSettle ?? true,
        }),
        repoKey: () => REPO,
        headHash: async () => head,
        isUnpushed: async () => options.unpushed ?? false,
        capabilities: async () => ("caps" in options ? options.caps : RUNS_CAPS),
        snapshot,
        detail,
        invalidateDetail,
        cooldownUntil: () => cooldown,
        isFenced: options.isFenced ?? (() => false),
        generations,
        workspaceState: memento,
        claimDir: options.claimDir ?? path.join(os.tmpdir(), "unused-claims"),
        ...(options.mkdir && { mkdir: options.mkdir }),
        focused: () => focused,
        createStatusBarItem: () => {
            const item = fakeItem();
            items.push(item);
            return item;
        },
        showInformationMessage: show,
        openChecks,
        openLog: vi.fn(async () => undefined),
        rerunFailed: vi.fn(async () => undefined),
    };
    return {
        deps,
        items,
        snapshot,
        detail,
        invalidateDetail,
        show,
        openChecks,
        memento,
        generations,
        setHead: (hash) => {
            head = hash;
        },
        setFocused: (value) => {
            focused = value;
        },
        setCooldown: (until) => {
            cooldown = until;
        },
    };
}

let tempDir: string;
let claimDir: string;
const live: HeadCiStatus[] = [];

function track(status: HeadCiStatus): HeadCiStatus {
    live.push(status);
    return status;
}

/** Lets fire-and-forget detail requests and real file system calls finish. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "intelligit-head-status-"));
    claimDir = path.join(tempDir, "ci-toast-claims");
});

afterEach(async () => {
    for (const status of live.splice(0)) status.dispose();
    vi.useRealTimers();
    await removeScratchDirectories(tempDir);
});

function pendingObserved(memento: ReturnType<typeof fakeMemento>): { hash: string }[] {
    return (memento.get<{ hash: string }[]>(PENDING_OBSERVED_KEY) ?? []).map(({ hash }) => ({
        hash,
    }));
}

describe("HeadCiStatus", () => {
    it("formats counts and elapsed", () => {
        expect(formatHeadStatusText({ failed: 2, pending: 3, passed: 5 }, 65_000)).toBe(
            "$(error) 2 · $(sync~spin) 3 · $(check) 5 · 1:05",
        );
        expect(formatHeadStatusText({ failed: 0, pending: 1, passed: 7 }, 3_725_000)).toBe(
            "$(error) 0 · $(sync~spin) 1 · $(check) 7 · 1:02:05",
        );
        expect(formatHeadStatusText({ failed: 1, pending: 0, passed: 4 }, undefined)).toBe(
            "$(error) 1 · $(sync~spin) 0 · $(check) 4",
        );
    });

    it("failed plus running job keeps polling and does not toast", async () => {
        vi.useFakeTimers();
        const h = makeHarness({
            snapshots: [snapshotOf(["failure", "pending"])],
            details: [detailOf(["failure", "running"])],
            claimDir,
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(400_000);
        expect(h.snapshot.mock.calls.length).toBeGreaterThan(5);
        expect(h.show).not.toHaveBeenCalled();
        expect(existsSync(claimDir)).toBe(false);
    });

    it("keeps polling every 120 s past the ladder until complete", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ caps: NO_CI_CAPABILITIES });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(308_000);
        expect(h.snapshot).toHaveBeenCalledTimes(9);
        await vi.advanceTimersByTimeAsync(119_999);
        expect(h.snapshot).toHaveBeenCalledTimes(9);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.snapshot).toHaveBeenCalledTimes(10);
        await vi.advanceTimersByTimeAsync(120_000 * 5);
        expect(h.snapshot).toHaveBeenCalledTimes(15);
    });

    it("exactly 36 snapshot fetches in one incomplete hour", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ caps: RUNS_CAPS });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(3_600_000 - 1);
        expect(h.snapshot).toHaveBeenCalledTimes(36);
        // The same number of detail fetches when the provider has runs (§10 budget).
        expect(h.detail).toHaveBeenCalledTimes(36);
        // Only the first fetch on a new HEAD reads the caches; every poll after it is forced.
        expect(h.snapshot.mock.calls[0][1]).toEqual({});
        expect(h.snapshot.mock.calls.slice(1).every((call) => call[1].force === true)).toBe(true);
    });

    it("pauses during cooldown and shows paused", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ caps: NO_CI_CAPABILITIES });
        const status = track(new HeadCiStatus(h.deps));
        h.setCooldown(Date.now() + 60_000);
        await status.onRepositoryChanged();
        expect(h.snapshot).not.toHaveBeenCalled();
        expect(h.items[0]?.shown).toBe(true);
        expect(h.items[0]?.text).toBe("$(debug-pause) CI paused");
        expect(h.items[0]?.command).toBe("intelligit.ci.refreshHeadChecks");
        await vi.advanceTimersByTimeAsync(59_000);
        expect(h.snapshot).not.toHaveBeenCalled();
        h.setCooldown(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.snapshot).toHaveBeenCalledTimes(1);
        expect(h.items[0]?.text).toBe("$(error) 0 · $(sync~spin) 1 · $(check) 0");
        expect(h.items[0]?.command).toBe("intelligit.ci.showHeadChecks");
    });

    it("settled failing HEAD on first load fetches detail", async () => {
        const h = makeHarness({
            snapshots: [snapshotOf(["failure", "success"])],
            details: [detailOf(["failure", "success"])],
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        expect(h.detail).toHaveBeenCalledTimes(1);
        // Cache first: a HEAD that was already complete is not forced.
        expect(h.detail.mock.calls[0][1]).toEqual({});
        expect(h.invalidateDetail).not.toHaveBeenCalled();
    });

    it("pending→settled fetches detail once more before stopping", async () => {
        const h = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["failure", "success"])],
            details: [detailOf(["running", "success"]), detailOf(["failure", "success"])],
            claimDir,
        });
        const order: string[] = [];
        h.invalidateDetail.mockImplementation(async () => {
            order.push("invalidate");
        });
        h.detail.mockImplementation(async (_hash: string, options: { force?: boolean }) => {
            order.push(options.force ? "detail:force" : "detail");
            return order.includes("invalidate")
                ? detailOf(["failure", "success"])
                : detailOf(["running", "success"]);
        });
        h.show.mockImplementation(async () => {
            order.push("toast");
            return undefined;
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await settle();
        await status.refresh();
        await settle();
        expect(order.slice(-3)).toEqual(["invalidate", "detail:force", "toast"]);
        const calls = h.snapshot.mock.calls.length;
        await status.refresh();
        // Stopped: a settled HEAD with no fence is not polled again by the schedule.
        expect(status.isPolling()).toBe(false);
        expect(h.snapshot.mock.calls.length).toBe(calls + 1);
    });

    it("settlement detail comes from a request started after settlement", async () => {
        let releaseHeld: (detail: CommitCiDetail) => void = () => undefined;
        const held = new Promise<CommitCiDetail>((resolve) => {
            releaseHeld = resolve;
        });
        const h = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["failure", "success"])],
            details: [() => held, detailOf(["failure", "success"])],
            claimDir,
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        expect(h.detail).toHaveBeenCalledTimes(1);
        // Not awaited: joining the held request would never settle.
        const settling = status.refresh();
        await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
        // Job states come from the second request: one failed job, one passed.
        expect(h.show.mock.calls[0][0]).toContain("1 failed, 1 passed");
        releaseHeld(detailOf(["running", "running"]));
        await settling;
        await settle();
        expect(h.show).toHaveBeenCalledTimes(1);
    });

    it("a running execution past the run bound keeps polling and sends no toast", async () => {
        vi.useFakeTimers();
        const h = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["success"])],
            details: [
                detailOf(["running"]),
                detailOf(["success"], { runsCoverage: { reason: "pageBound", shown: 1000 } }),
            ],
            claimDir,
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(3_000);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(h.show).not.toHaveBeenCalled();
        expect(status.isPolling()).toBe(true);
        const before = h.snapshot.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(h.snapshot.mock.calls.length).toBe(before + 1);
    });

    it("fenced HEAD keeps polling after complete, across restart and cooldown", async () => {
        vi.useFakeTimers();
        const state = fakeMemento();
        const fences = new CiActionFenceStore(state);
        await fences.begin({
            repoKey: REPO,
            hash: HASH,
            provider: "github",
            action: "rerunFailed",
            targetId: "run-1",
            runId: "run-1",
            evidence: "runAttempt",
            before: { attempt: 1, state: "failure" },
        });
        const make = () =>
            makeHarness({
                snapshots: [snapshotOf(["failure"])],
                details: [detailOf(["failure"])],
                memento: state,
                claimDir,
                isFenced: (hash) => fences.isFenced(hash),
            });
        const first = make();
        const status = track(new HeadCiStatus(first.deps));
        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(first.snapshot).toHaveBeenCalledTimes(2);
        expect(status.isPolling()).toBe(true);
        status.dispose();

        const restarted = make();
        const fences2 = new CiActionFenceStore(state);
        const second = track(
            new HeadCiStatus({ ...restarted.deps, isFenced: (hash) => fences2.isFenced(hash) }),
        );
        await second.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(restarted.snapshot).toHaveBeenCalledTimes(2);
        restarted.setCooldown(Date.now() + 20 * 60_000);
        const during = restarted.snapshot.mock.calls.length;
        expect(fences2.fenceFor(REPO, HASH)?.notSeen).toBe(false);
        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        // No request while cooling down, but the fence label still switched at 10 min.
        expect(restarted.snapshot.mock.calls.length).toBe(during);
        expect(fences2.fenceFor(REPO, HASH)?.notSeen).toBe(true);
        fences.dispose();
        fences2.dispose();
    });

    it("toasts once per hash across a simulated reload", async () => {
        const memento = fakeMemento();
        const first = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["success"])],
            details: [detailOf(["running"]), detailOf(["success"])],
            memento,
            claimDir,
        });
        const a = track(new HeadCiStatus(first.deps));
        await a.onRepositoryChanged();
        await a.refresh();
        await settle();
        expect(first.show).toHaveBeenCalledTimes(1);
        a.dispose();

        // After the reload a re-run makes the same commit pending again, and it settles again.
        const second = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["success"])],
            details: [detailOf(["running"]), detailOf(["success"])],
            memento,
            claimDir,
        });
        const b = track(new HeadCiStatus(second.deps));
        await b.onRepositoryChanged();
        await b.refresh();
        await settle();
        expect(second.show).not.toHaveBeenCalled();
        expect(pendingObserved(memento)).toEqual([]);
    });

    it("settles during the restart gap → one toast", async () => {
        const memento = fakeMemento();
        const first = makeHarness({ memento, claimDir });
        const a = track(new HeadCiStatus(first.deps));
        await a.onRepositoryChanged();
        expect(pendingObserved(memento)).toEqual([{ hash: HASH }]);
        a.dispose();

        const second = makeHarness({
            snapshots: [snapshotOf(["success"])],
            details: [detailOf(["success"])],
            memento,
            claimDir,
        });
        const b = track(new HeadCiStatus(second.deps));
        await b.onRepositoryChanged();
        await settle();
        expect(second.show).toHaveBeenCalledTimes(1);
        expect(pendingObserved(memento)).toEqual([]);
    });

    it("no toast when the hash was never seen incomplete", async () => {
        const h = makeHarness({
            snapshots: [snapshotOf(["success"])],
            details: [detailOf(["success"])],
            claimDir,
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await settle();
        expect(h.show).not.toHaveBeenCalled();
        expect(existsSync(claimDir)).toBe(false);
    });

    it("claim taken before toast", async () => {
        const seen: boolean[] = [];
        const show = vi.fn(async () => {
            const entries = existsSync(claimDir) ? await readdir(claimDir) : [];
            seen.push(entries.length === 1);
            return undefined;
        });
        const h = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["success"])],
            details: [detailOf(["running"]), detailOf(["success"])],
            claimDir,
            show,
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await status.refresh();
        expect(show).toHaveBeenCalledTimes(1);
        // The fake reads the claim folder asynchronously; wait for that read, not a tick count.
        await show.mock.results[0]?.value;
        expect(seen).toEqual([true]);
    });

    it("two hosts, one toast", async () => {
        const settledHarness = (focused: boolean) =>
            makeHarness({
                snapshots: [snapshotOf(["success"])],
                details: [detailOf(["success"])],
                memento: fakeMemento({
                    [PENDING_OBSERVED_KEY]: [{ repoKey: REPO, hash: HASH, observedAt: Date.now() }],
                }),
                claimDir,
                focused,
            });
        const unfocused = settledHarness(false);
        const focused = settledHarness(true);
        const b = track(new HeadCiStatus(unfocused.deps));
        const a = track(new HeadCiStatus(focused.deps));
        // The unfocused window sees completion first; it must leave the toast to the focused one.
        await b.onRepositoryChanged();
        await settle();
        await a.onRepositoryChanged();
        await settle();
        expect(focused.show).toHaveBeenCalledTimes(1);
        expect(unfocused.show).not.toHaveBeenCalled();
        expect(pendingObserved(unfocused.memento)).toEqual([{ hash: HASH }]);
        // Focus moves to the other window: it re-runs the claim, finds it taken, and stays quiet.
        unfocused.setFocused(true);
        await b.onWindowFocused();
        await settle();
        expect(unfocused.show).not.toHaveBeenCalled();
        expect(pendingObserved(unfocused.memento)).toEqual([]);
    });

    it("both pass the focus check, one mkdir wins", async () => {
        const realMkdir = (target: string, options?: { recursive?: boolean }) =>
            mkdir(target, options);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let parentCalls = 0;
        const heldMkdir: HeadCiStatusDeps["mkdir"] = async (target, options) => {
            if (options?.recursive) {
                parentCalls += 1;
                await gate;
            }
            return realMkdir(target, options);
        };
        const harnesses = [0, 1].map(() =>
            makeHarness({
                snapshots: [snapshotOf(["success"])],
                details: [detailOf(["success"])],
                memento: fakeMemento({
                    [PENDING_OBSERVED_KEY]: [{ repoKey: REPO, hash: HASH, observedAt: Date.now() }],
                }),
                claimDir,
                mkdir: heldMkdir,
            }),
        );
        const statuses = harnesses.map((h) => track(new HeadCiStatus(h.deps)));
        const runs = statuses.map((status) => status.onRepositoryChanged());
        await vi.waitFor(() => expect(parentCalls).toBe(2));
        release();
        await Promise.all(runs);
        await settle();
        const toasts = harnesses.reduce((sum, h) => sum + h.show.mock.calls.length, 0);
        expect(toasts).toBe(1);
        expect(await readdir(claimDir)).toHaveLength(1);
    });

    it("mkdir error other than EEXIST → no toast, hash kept", async () => {
        const failing: HeadCiStatusDeps["mkdir"] = async (target, options) => {
            if (options?.recursive) return mkdir(target, options);
            const error = new Error("denied") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
        };
        const h = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["success"])],
            details: [detailOf(["running"]), detailOf(["success"])],
            claimDir,
            mkdir: failing,
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await status.refresh();
        await settle();
        expect(h.show).not.toHaveBeenCalled();
        expect(pendingObserved(h.memento)).toEqual([{ hash: HASH }]);
    });

    it("claims are never pruned and have no count cap", async () => {
        await mkdir(claimDir, { recursive: true });
        const names = Array.from({ length: 250 }, (_unused, index) =>
            index.toString(16).padStart(64, "0"),
        );
        await Promise.all(names.map((name) => mkdir(path.join(claimDir, name))));
        const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
        await utimes(path.join(claimDir, names[0]), old, old);
        const h = makeHarness({
            snapshots: [snapshotOf(["pending"]), snapshotOf(["success"])],
            details: [detailOf(["running"]), detailOf(["success"])],
            claimDir,
        });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await status.refresh();
        await settle();
        expect(h.show).toHaveBeenCalledTimes(1);
        const after = await readdir(claimDir);
        expect(after).toHaveLength(251);
        expect(after).toEqual(expect.arrayContaining(names));
        expect((await stat(path.join(claimDir, names[0]))).mtimeMs).toBeLessThan(
            Date.now() - 399 * 24 * 60 * 60 * 1000,
        );
    });

    it("hidden when disabled / unpushed none / no provider", async () => {
        const disabled = makeHarness({ statusBar: false, notifyOnSettle: true });
        await track(new HeadCiStatus(disabled.deps)).onRepositoryChanged();
        expect(disabled.items.some((item) => item.shown)).toBe(false);

        const unpushedNone = makeHarness({
            snapshots: [snapshotOf([])],
            unpushed: true,
            caps: NO_CI_CAPABILITIES,
        });
        await track(new HeadCiStatus(unpushedNone.deps)).onRepositoryChanged();
        expect(unpushedNone.items.some((item) => item.shown)).toBe(false);

        const noProvider = makeHarness({ caps: undefined });
        await track(new HeadCiStatus(noProvider.deps)).onRepositoryChanged();
        expect(noProvider.items.some((item) => item.shown)).toBe(false);
        expect(noProvider.snapshot).not.toHaveBeenCalled();

        // Control: a pushed HEAD with no checks yet still shows its (empty) counts.
        const pushedNone = makeHarness({ snapshots: [snapshotOf([])], caps: NO_CI_CAPABILITIES });
        await track(new HeadCiStatus(pushedNone.deps)).onRepositoryChanged();
        expect(pushedNone.items[0]?.shown).toBe(true);
    });

    it("zero requests when commitChecks.enabled is false", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ enabled: false });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await status.refresh();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(h.snapshot).not.toHaveBeenCalled();
        expect(h.detail).not.toHaveBeenCalled();
        expect(h.items.some((item) => item.shown)).toBe(false);
        // Both settings off: the monitor does not run either.
        const off = makeHarness({ statusBar: false, notifyOnSettle: false });
        await track(new HeadCiStatus(off.deps)).onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(off.snapshot).not.toHaveBeenCalled();
    });

    it("a result after sign-out does not update the status bar", async () => {
        let resolve: (snapshot: CommitChecksSnapshot) => void = () => undefined;
        const h = makeHarness({
            caps: NO_CI_CAPABILITIES,
            snapshots: [
                () =>
                    new Promise<CommitChecksSnapshot>((done) => {
                        resolve = done;
                    }),
            ],
        });
        const status = track(new HeadCiStatus(h.deps));
        const run = status.onRepositoryChanged();
        await vi.waitFor(() => expect(h.snapshot).toHaveBeenCalledTimes(1));
        h.generations.bumpAuth();
        resolve(snapshotOf(["pending"]));
        await run;
        expect(h.items.some((item) => item.shown)).toBe(false);
        expect(pendingObserved(h.memento)).toEqual([]);
    });

    it("a new HEAD restarts the ladder and the old HEAD's late result is dropped", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ caps: NO_CI_CAPABILITIES });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(8_000);
        expect(h.snapshot).toHaveBeenCalledTimes(3);
        h.setHead(NEXT_HASH);
        await status.onRepositoryChanged();
        expect(h.snapshot.mock.calls[3][0]).toBe(NEXT_HASH);
        // The same HEAD again keeps its schedule instead of restarting it.
        await status.onRepositoryChanged();
        expect(h.snapshot).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(h.snapshot).toHaveBeenCalledTimes(5);
        expect(h.snapshot.mock.calls[4][0]).toBe(NEXT_HASH);
    });

    it("toast buttons appear per capability", async () => {
        const settled = (caps: ProviderCiCapabilities) => {
            const h = makeHarness({
                snapshots: [snapshotOf(["failure"])],
                details: [{ ...detailOf(["failure"]), capabilities: caps }],
                caps,
                memento: fakeMemento({
                    [PENDING_OBSERVED_KEY]: [{ repoKey: REPO, hash: HASH, observedAt: Date.now() }],
                }),
                claimDir: path.join(tempDir, `claims-${caps.logs}-${caps.rerunFailed}`),
            });
            return h;
        };
        const all = settled(RUNS_CAPS);
        await track(new HeadCiStatus(all.deps)).onRepositoryChanged();
        await settle();
        expect(all.show.mock.calls[0].slice(1)).toEqual([
            "Open Checks",
            "Open log",
            "Re-run failed",
        ]);
        const none = settled({ ...RUNS_CAPS, logs: false, rerunFailed: false });
        await track(new HeadCiStatus(none.deps)).onRepositoryChanged();
        await settle();
        expect(none.show.mock.calls[0].slice(1)).toEqual(["Open Checks"]);
    });

    it("reads both settings, defaulting to on and treating a non-boolean as on", () => {
        const values: Record<string, unknown> = {
            "commitChecks.statusBar": false,
            "commitChecks.notifyOnSettle": "no",
        };
        const config = {
            get: <T>(key: string, fallback: T): T => (key in values ? values[key] : fallback) as T,
        };
        expect(readHeadStatusSettings(config)).toEqual({ statusBar: false, notifyOnSettle: true });
        expect(readHeadStatusSettings({ get: <T>(_key: string, fallback: T) => fallback })).toEqual(
            { statusBar: true, notifyOnSettle: true },
        );
    });

    it("drops pending-observed entries older than 7 days", async () => {
        const memento = fakeMemento({
            [PENDING_OBSERVED_KEY]: [
                { repoKey: REPO, hash: HASH, observedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
            ],
        });
        const h = makeHarness({
            snapshots: [snapshotOf(["success"])],
            details: [detailOf(["success"])],
            memento,
            claimDir,
        });
        await track(new HeadCiStatus(h.deps)).onRepositoryChanged();
        await settle();
        expect(h.show).not.toHaveBeenCalled();
    });

    it("shows no status bar item while the Checks tab switch is off", () => {
        const items: FakeItem[] = [];
        const bar = new HeadStatusBar({
            switchOn: () => false,
            settings: () => ({ statusBar: true, notifyOnSettle: true }),
            createStatusBarItem: () => {
                const item = fakeItem();
                items.push(item);
                return item;
            },
        });
        bar.render({
            kind: "status",
            counts: { failed: 0, pending: 2, passed: 1 },
            summary: "running",
        });
        bar.render({ kind: "paused", message: "paused" });
        expect(items).toEqual([]);
        bar.dispose();
    });

    it("shows no notification while the Checks tab switch is off", async () => {
        const memento = fakeMemento({
            [PENDING_OBSERVED_KEY]: [{ repoKey: REPO, hash: HASH, observedAt: Date.now() }],
        });
        const show = vi.fn(async () => undefined);
        const toast = new HeadSettleToast({
            switchOn: () => false,
            settings: () => ({ statusBar: true, notifyOnSettle: true }),
            workspaceState: memento,
            claimDir,
            focused: () => true,
            showInformationMessage: show,
            openChecks: vi.fn(),
            openLog: vi.fn(),
            rerunFailed: vi.fn(),
        });
        await toast.settled({
            repoKey: REPO,
            hash: HASH,
            ctx: new CiGenerations().capture(REPO),
            isCurrent: () => true,
            capabilities: RUNS_CAPS,
            snapshot: snapshotOf(["failure"]),
            detail: detailOf(["failure"]),
        });
        await settle();
        expect(show).not.toHaveBeenCalled();
        expect(existsSync(claimDir)).toBe(false);
    });

    it("starts no timer and sends no CI request for HEAD while the Checks tab switch is off", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ switchOn: false, claimDir });
        const status = track(new HeadCiStatus(h.deps));
        await status.onRepositoryChanged();
        await status.restart();
        await status.onWindowFocused();
        expect(vi.getTimerCount()).toBe(0);
        expect(h.snapshot).not.toHaveBeenCalled();
        expect(h.detail).not.toHaveBeenCalled();
        expect(pendingObserved(h.memento)).toEqual([]);
        expect(existsSync(claimDir)).toBe(false);
    });

    it("both commands do nothing while the Checks tab switch is off", async () => {
        const h = makeHarness({ switchOn: false });
        const status = track(new HeadCiStatus(h.deps));
        await status.showHeadChecks();
        await status.refresh();
        expect(h.openChecks).not.toHaveBeenCalled();
        expect(h.snapshot).not.toHaveBeenCalled();
        // A monitor already watching HEAD sends nothing on Refresh once the switch is off.
        let switchOn = true;
        const late = makeHarness();
        late.deps.switchOn = () => switchOn;
        const watching = track(new HeadCiStatus(late.deps));
        await watching.onRepositoryChanged();
        const before = late.snapshot.mock.calls.length;
        expect(before).toBeGreaterThan(0);
        switchOn = false;
        await watching.refresh();
        expect(late.snapshot).toHaveBeenCalledTimes(before);
        // Control: with the switch on, Show opens the Checks tab for HEAD.
        const on = makeHarness();
        await track(new HeadCiStatus(on.deps)).showHeadChecks();
        expect(on.openChecks).toHaveBeenCalledWith(HASH);
    });
});
