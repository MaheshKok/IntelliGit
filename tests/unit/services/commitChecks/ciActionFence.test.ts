import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CiJob, CiRun, CommitChecksSnapshot, CommitCiDetailData } from "../../../../src/types";
import {
    ACTION_FENCE_KEY_PREFIX,
    ACTION_FENCE_NOT_SEEN_MS,
    CiActionFenceStore,
    evidenceFor,
    type CiActionFenceStart,
} from "../../../../src/services/commitChecks/ciActionFence";
import {
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
} from "../../../../src/services/commitChecks/persistentCache";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import { CommitCiDetailService } from "../../../../src/services/commitChecks/detailService";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import { CommitChecksRequestGateRegistry } from "../../../../src/services/commitChecks/requestGate";
import type { CommitChecksProvider } from "../../../../src/services/commitChecks/types";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";

const HASH = "abc1234";
const REPO = "/repo";
const OTHER_REPO = "/other-repo";
const SNAPSHOT_KEY = `github:repo@${HASH}:-`;
const DETAIL_KEY = `${SNAPSHOT_KEY}#detail`;
const SERVE = { repoKey: REPO, capabilities: NO_CI_CAPABILITIES };
const DAY_MS = 24 * 60 * 60 * 1000;

type Memento = CommitChecksPersistentState & {
    values: Map<string, unknown>;
    keys(): readonly string[];
};

// Memento semantics: writing undefined removes the key.
function applyWrite(values: Map<string, unknown>, key: string, value: unknown): void {
    if (value === undefined) values.delete(key);
    else values.set(key, value);
}

function memento(values = new Map<string, unknown>()): Memento {
    return {
        values,
        get: vi.fn((key: string) => values.get(key)),
        keys: vi.fn(() => [...values.keys()]),
        update: vi.fn(async (key: string, value: unknown) => applyWrite(values, key, value)),
    };
}

/**
 * One workspaceState seen by several windows (extension hosts). A window sees its own
 * writes at once and another window's only after `propagate()`, which applies every
 * queued write in order, as VS Code passes them between hosts.
 */
function delayedMemento(): { window(): Memento; propagate(): void } {
    const shared = new Map<string, unknown>();
    const views: Map<string, unknown>[] = [];
    let queued: [string, unknown][] = [];
    return {
        window() {
            const state = memento(new Map(shared));
            views.push(state.values);
            state.update = vi.fn(async (key: string, value: unknown) => {
                applyWrite(state.values, key, value);
                queued.push([key, value]);
            });
            return state;
        },
        propagate() {
            for (const [key, value] of queued) {
                applyWrite(shared, key, value);
                for (const view of views) applyWrite(view, key, value);
            }
            queued = [];
        },
    };
}

/** The fence records stored under the per-fence key prefix. */
function storedFences(state: Memento): unknown[] {
    return [...state.values]
        .filter(([key]) => key.startsWith(ACTION_FENCE_KEY_PREFIX))
        .map(([, value]) => value);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function job(overrides: Partial<CiJob> = {}): CiJob {
    return {
        id: "100",
        logicalId: "pipe\0test",
        name: "test",
        checkName: "test",
        state: "failure",
        steps: [],
        ...overrides,
    };
}

function run(overrides: Partial<CiRun> = {}): CiRun {
    return {
        id: "77",
        name: "ci",
        state: "failure",
        attempt: 1,
        jobs: [job()],
        jobsCoverage: "full",
        ...overrides,
    };
}

function detail(runs: CiRun[] = [run()], overrides: Partial<CommitCiDetailData> = {}) {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs,
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        ...overrides,
    } satisfies CommitCiDetailData;
}

function snapshot(): CommitChecksSnapshot {
    return {
        hash: HASH,
        state: "failure",
        summary: "1 failed",
        items: [{ name: "test", description: "", state: "failure", source: "check-run" }],
    };
}

function start(overrides: Partial<CiActionFenceStart> = {}): CiActionFenceStart {
    return {
        repoKey: REPO,
        hash: HASH,
        provider: "github",
        action: "rerunFailed",
        targetId: "77",
        runId: "77",
        before: { attempt: 1, state: "failure" },
        evidence: "runAttempt",
        ...overrides,
    };
}

function persistedDetailKeys(state: Memento): string[] {
    const payload = state.values.get("intelligit.commitChecks.detailCache.v1") as
        { entries: { key: string }[] } | undefined;
    return payload?.entries.map((entry) => entry.key) ?? [];
}

afterEach(() => {
    vi.useRealTimers();
});

describe("CiActionFenceStore", () => {
    it("a fenced key is never persisted, even complete", async () => {
        const workspace = memento();
        const global = memento();
        const fences = new CiActionFenceStore(workspace);
        await fences.begin(start());
        const snapshots = new CommitChecksPersistentCache(global, { fence: fences });
        const details = new CiDetailPersistentCache(global, { fence: fences });

        await snapshots.set(SNAPSHOT_KEY, snapshot());
        await details.set(DETAIL_KEY, detail());
        await expect(snapshots.get(SNAPSHOT_KEY)).resolves.toBeUndefined();
        await expect(details.get(DETAIL_KEY)).resolves.toBeUndefined();

        // Through the services too: the complete answer stays in memory only.
        const service = new CommitCiDetailService({
            persistentCache: details,
            fences,
        });
        await service.getOrFetch(DETAIL_KEY, async () => detail(), SERVE);
        expect(persistedDetailKeys(global)).toEqual([]);
        fences.dispose();
    });

    it("a set queued before the fence but run after it is refused", async () => {
        const fences = new CiActionFenceStore(memento());
        const blocker = deferred();
        // Each store's first write waits for the blocker, holding its queue.
        const blockingMemento = (): Memento => {
            const state = memento();
            const realUpdate = state.update;
            let blocked = false;
            state.update = vi.fn(async (key: string, value: unknown) => {
                if (!blocked) {
                    blocked = true;
                    await blocker.promise;
                }
                return realUpdate(key, value);
            });
            return state;
        };
        const snapshots = new CommitChecksPersistentCache(blockingMemento(), { fence: fences });
        const details = new CiDetailPersistentCache(blockingMemento(), { fence: fences });

        // Occupy both queues with a write that waits, then queue the fenced hash's writes.
        const occupySnapshots = snapshots.set("other@zzz", { ...snapshot(), hash: "zzz" });
        const occupyDetails = details.set("other#detail", { ...detail(), hash: "zzz" });
        const queuedSnapshot = snapshots.set(SNAPSHOT_KEY, snapshot());
        const queuedDetail = details.set(DETAIL_KEY, detail());
        await fences.begin(start());
        blocker.resolve();
        await Promise.all([occupySnapshots, occupyDetails, queuedSnapshot, queuedDetail]);

        await expect(snapshots.get(SNAPSHOT_KEY)).resolves.toBeUndefined();
        await expect(details.get(DETAIL_KEY)).resolves.toBeUndefined();
        await expect(snapshots.get("other@zzz")).resolves.toMatchObject({ hash: "zzz" });
        fences.dispose();
    });

    it("fence survives a new instance over the same workspaceState", async () => {
        const workspace = memento();
        const first = new CiActionFenceStore(workspace);
        await first.begin(start({ action: "cancel", evidence: "cancelled" }));
        first.dispose();

        const second = new CiActionFenceStore(workspace);
        expect(second.isFenced(HASH)).toBe(true);
        expect(second.fenceFor(REPO, HASH)).toEqual({
            targetId: "77",
            action: "cancel",
            notSeen: false,
        });
        second.dispose();
    });

    it("reopen after 8 days with the provider still returning the old execution: fence kept, result not persisted", async () => {
        let now = 1_000;
        const clock = (): number => now;
        const workspace = memento();
        const global = memento();
        const first = new CiActionFenceStore(workspace, { now: clock });
        await first.begin(start());
        first.dispose();

        now += 8 * DAY_MS;
        const fences = new CiActionFenceStore(workspace, { now: clock });
        const persistent = new CiDetailPersistentCache(global, { now: clock, fence: fences });
        const service = new CommitCiDetailService({
            now: clock,
            persistentCache: persistent,
            fences,
        });
        const served = await service.getOrFetch(DETAIL_KEY, async () => detail(), SERVE);

        expect(fences.isFenced(HASH)).toBe(true);
        expect(served.actionFence).toEqual({
            targetId: "77",
            action: "rerunFailed",
            notSeen: true,
        });
        expect(persistedDetailKeys(global)).toEqual([]);
        fences.dispose();
    });

    it("GitHub: a run attempt rise or a move to queued/running ends a re-run fence", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());

        await expect(fences.resolve(REPO, HASH, detail([run()]))).resolves.toBe(false);
        await expect(
            fences.resolve(REPO, HASH, detail([run({ id: "78", attempt: 2, state: "running" })])),
        ).resolves.toBe(false);
        expect(fences.isFenced(HASH)).toBe(true);
        await expect(
            fences.resolve(REPO, HASH, detail([run({ attempt: 2, state: "failure" })])),
        ).resolves.toBe(true);
        expect(fences.isFenced(HASH)).toBe(false);

        await fences.begin(start({ action: "rerunJob", targetId: "100" }));
        await expect(fences.resolve(REPO, HASH, detail([run({ state: "queued" })]))).resolves.toBe(
            true,
        );
        expect(fences.isFenced(HASH)).toBe(false);
        fences.dispose();
    });

    it("GitLab job retry: a newer job id with the same logical id in the same pipeline ends the fence, even when that job already finished", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(
            start({
                provider: "gitlab",
                action: "rerunJob",
                targetId: "100",
                before: { state: "failure", jobId: "100", logicalId: "pipe\0test" },
                evidence: "newerJobSameLogicalId",
            }),
        );
        const old = detail([run({ attempt: undefined, jobs: [job()] })], { provider: "gitlab" });
        await expect(fences.resolve(REPO, HASH, old)).resolves.toBe(false);
        const retried = detail(
            [
                run({
                    attempt: undefined,
                    state: "success",
                    jobs: [job(), job({ id: "1005", state: "success" })],
                }),
            ],
            { provider: "gitlab", outcome: "success" },
        );
        await expect(fences.resolve(REPO, HASH, retried)).resolves.toBe(true);
        expect(fences.isFenced(HASH)).toBe(false);
        fences.dispose();
    });

    it("GitLab job retry: a newer job with another logical id does not end the fence", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(
            start({
                provider: "gitlab",
                action: "rerunJob",
                targetId: "100",
                before: { state: "failure", jobId: "100", logicalId: "pipe\0test" },
                evidence: "newerJobSameLogicalId",
            }),
        );
        const otherJob = detail(
            [run({ jobs: [job(), job({ id: "101", logicalId: "pipe\0lint" })] })],
            { provider: "gitlab" },
        );
        const otherPipeline = detail([run({ id: "78", jobs: [job({ id: "102" })] })], {
            provider: "gitlab",
        });
        await expect(fences.resolve(REPO, HASH, otherJob)).resolves.toBe(false);
        await expect(fences.resolve(REPO, HASH, otherPipeline)).resolves.toBe(false);
        expect(fences.isFenced(HASH)).toBe(true);
        fences.dispose();
    });

    it("GitLab pipeline retry: a job id above before.maxJobId ends the fence", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(
            start({
                provider: "gitlab",
                before: { state: "failure", maxJobId: "999" },
                evidence: "newerJobInPipeline",
            }),
        );
        const same = detail([run({ jobs: [job({ id: "999" }), job({ id: "150" })] })], {
            provider: "gitlab",
        });
        await expect(fences.resolve(REPO, HASH, same)).resolves.toBe(false);
        // Numeric, not string, order: "1000" > "999".
        const retried = detail([run({ jobs: [job({ id: "999" }), job({ id: "1000" })] })], {
            provider: "gitlab",
        });
        await expect(fences.resolve(REPO, HASH, retried)).resolves.toBe(true);
        fences.dispose();
    });

    it("cancel fence ends when the target run is cancelled or complete", async () => {
        const fences = new CiActionFenceStore(memento());
        const cancel = start({
            action: "cancel",
            before: { state: "running" },
            evidence: "cancelled",
        });
        await fences.begin(cancel);
        await expect(fences.resolve(REPO, HASH, detail([run({ state: "running" })]))).resolves.toBe(
            false,
        );
        await expect(fences.resolve(REPO, HASH, detail([run({ state: "queued" })]))).resolves.toBe(
            false,
        );
        await expect(
            fences.resolve(REPO, HASH, detail([run({ state: "cancelled" })])),
        ).resolves.toBe(true);

        await fences.begin(cancel);
        await expect(fences.resolve(REPO, HASH, detail([run({ state: "success" })]))).resolves.toBe(
            true,
        );
        expect(fences.isFenced(HASH)).toBe(false);
        fences.dispose();
    });

    it("cancel fence stays when the target run's state is unknown", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(
            start({ action: "cancel", before: { state: "running" }, evidence: "cancelled" }),
        );
        await expect(fences.resolve(REPO, HASH, detail([run({ state: "unknown" })]))).resolves.toBe(
            false,
        );
        expect(fences.isFenced(HASH)).toBe(true);
        fences.dispose();
    });

    it("the evidence rule is read from the stored record after a restart", async () => {
        const workspace = memento();
        const provider = {
            actionEvidence: vi.fn(() => "newerJobSameLogicalId" as const),
        } as unknown as CommitChecksProvider;
        const evidence = evidenceFor(provider, "rerunJob");
        expect(evidence).toBe("newerJobSameLogicalId");
        const first = new CiActionFenceStore(workspace);
        await first.begin(
            start({
                provider: "gitlab",
                action: "rerunJob",
                targetId: "100",
                before: { attempt: 1, state: "failure", jobId: "100", logicalId: "pipe\0test" },
                evidence: evidence!,
            }),
        );
        first.dispose();

        // The provider now declares another rule; the stored one still decides.
        vi.mocked(provider.actionEvidence!).mockReturnValue("runAttempt");
        const second = new CiActionFenceStore(workspace);
        const attemptRise = detail([run({ attempt: 2 })], { provider: "gitlab" });
        await expect(second.resolve(REPO, HASH, attemptRise)).resolves.toBe(false);
        const newerJob = detail([run({ jobs: [job(), job({ id: "101" })] })], {
            provider: "gitlab",
        });
        await expect(second.resolve(REPO, HASH, newerJob)).resolves.toBe(true);
        second.dispose();
    });

    it("notSeen switches at 10 min by timer with no fetch", async () => {
        vi.useFakeTimers({ now: 0 });
        const fences = new CiActionFenceStore(memento());
        const changed = vi.fn();
        fences.onDidChange(changed);
        const fetchDetail = vi.fn();
        await fences.begin(start());

        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS - 1);
        expect(changed).not.toHaveBeenCalled();
        expect(fences.fenceFor(REPO, HASH)?.notSeen).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledWith({ repoKey: REPO, hash: HASH });
        expect(fences.fenceFor(REPO, HASH)?.notSeen).toBe(true);
        expect(fetchDetail).not.toHaveBeenCalled();
        fences.dispose();
    });

    it("timer re-armed after restart from the stored time", async () => {
        vi.useFakeTimers({ now: 0 });
        const workspace = memento();
        const first = new CiActionFenceStore(workspace);
        await first.begin(start());
        first.dispose();

        vi.setSystemTime(9 * 60 * 1000);
        const second = new CiActionFenceStore(workspace);
        const changed = vi.fn();
        second.onDidChange(changed);
        await vi.advanceTimersByTimeAsync(60 * 1000 - 1);
        expect(changed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(second.fenceFor(REPO, HASH)?.notSeen).toBe(true);
        second.dispose();

        // Already past at activation: the switch fires at once.
        const third = new CiActionFenceStore(workspace);
        const late = vi.fn();
        third.onDidChange(late);
        await vi.advanceTimersByTimeAsync(0);
        expect(late).toHaveBeenCalledTimes(1);
        third.dispose();
    });

    it("notSeen switches while the request gate is in cooldown", async () => {
        vi.useFakeTimers({ now: 0 });
        const gate = new CommitChecksRequestGateRegistry("paused");
        const url = "https://api.github.com/repos/o/r/actions/runs";
        gate.observeResponse("github", {
            url,
            statusCode: 429,
            headers: { "retry-after": "3600" },
        });
        const task = vi.fn(async () => "never");
        const fences = new CiActionFenceStore(memento());
        const changed = vi.fn();
        fences.onDidChange(changed);
        await fences.begin(start());

        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        await expect(gate.run("github", url, task)).rejects.toMatchObject({ statusCode: 429 });
        expect(task).not.toHaveBeenCalled();
        expect(changed).toHaveBeenCalledTimes(1);
        expect(fences.fenceFor(REPO, HASH)?.notSeen).toBe(true);
        fences.dispose();
    });

    it("after 10 min reports notSeen and stays", async () => {
        vi.useFakeTimers({ now: 0 });
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        await fences.begin(start());
        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        expect(fences.fenceFor(REPO, HASH)?.notSeen).toBe(true);
        await vi.advanceTimersByTimeAsync(30 * DAY_MS);
        expect(fences.isFenced(HASH)).toBe(true);
        expect(fences.fenceFor(REPO, HASH)?.notSeen).toBe(true);
        fences.dispose();
        const reopened = new CiActionFenceStore(workspace);
        expect(reopened.isFenced(HASH)).toBe(true);
        reopened.dispose();
    });

    it("endByUserRefresh ends a not-seen fence and does nothing before", async () => {
        vi.useFakeTimers({ now: 0 });
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        await fences.begin(start());

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await expect(fences.endByUserRefresh(REPO, HASH, "77")).resolves.toBe(false);
        expect(fences.isFenced(HASH)).toBe(true);

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await expect(fences.endByUserRefresh(REPO, HASH, "other")).resolves.toBe(false);
        await expect(fences.endByUserRefresh(REPO, HASH, "77")).resolves.toBe(true);
        expect(fences.isFenced(HASH)).toBe(false);
        fences.dispose();
        expect(new CiActionFenceStore(workspace).isFenced(HASH)).toBe(false);
    });

    it("the same commit and target in a second repository keeps the first repository's fence", async () => {
        vi.useFakeTimers({ now: 0 });
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        const changes: string[] = [];
        fences.onDidChange((change) => changes.push(change.repoKey));
        await fences.begin(start());
        await vi.advanceTimersByTimeAsync(60 * 1000);
        await fences.begin(start({ repoKey: OTHER_REPO }));

        expect(fences.fenceFor(REPO, HASH)).toMatchObject({ targetId: "77" });
        expect(fences.fenceFor(OTHER_REPO, HASH)).toMatchObject({ targetId: "77" });
        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        expect(changes).toEqual([REPO, OTHER_REPO]);
        fences.dispose();
        const reopened = new CiActionFenceStore(workspace);
        expect(reopened.fenceFor(REPO, HASH)).toMatchObject({ targetId: "77" });
        expect(reopened.fenceFor(OTHER_REPO, HASH)).toMatchObject({ targetId: "77" });
        reopened.dispose();
    });

    it("fail and endByUserRefresh end only the named repository's fence", async () => {
        vi.useFakeTimers({ now: 0 });
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        await fences.begin(start());
        await fences.begin(start({ repoKey: OTHER_REPO }));

        await fences.fail(OTHER_REPO, HASH, "77");
        expect(fences.fenceFor(OTHER_REPO, HASH)).toBeUndefined();
        expect(fences.fenceFor(REPO, HASH)).toMatchObject({ targetId: "77" });

        await fences.begin(start({ repoKey: OTHER_REPO }));
        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        await expect(fences.endByUserRefresh(REPO, HASH, "77")).resolves.toBe(true);
        expect(fences.fenceFor(REPO, HASH)).toBeUndefined();
        expect(fences.fenceFor(OTHER_REPO, HASH)).toMatchObject({ targetId: "77" });
        fences.dispose();
    });

    it("a detail for one repository never ends the same commit's fence in another repository", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        await fences.begin(start({ repoKey: OTHER_REPO }));
        const rerunStarted = detail([run({ attempt: 2, state: "running" })]);

        await expect(fences.resolve(REPO, HASH, rerunStarted)).resolves.toBe(true);
        expect(fences.fenceFor(REPO, HASH)).toBeUndefined();
        expect(fences.fenceFor(OTHER_REPO, HASH)).toMatchObject({ targetId: "77" });

        // The detail service resolves with the repository it serves.
        const details = new CommitCiDetailService({ fences });
        await details.getOrFetch(DETAIL_KEY, async () => rerunStarted, SERVE);
        expect(fences.fenceFor(OTHER_REPO, HASH)).toMatchObject({ targetId: "77" });
        await details.getOrFetch(
            DETAIL_KEY,
            async () => rerunStarted,
            {
                ...SERVE,
                repoKey: OTHER_REPO,
            },
            { force: true },
        );
        expect(fences.fenceFor(OTHER_REPO, HASH)).toBeUndefined();
        fences.dispose();
    });

    it("a failed fence write rejects begin and leaves no fence", async () => {
        const workspace = memento();
        workspace.update = vi.fn(async () => {
            throw new Error("disk full");
        });
        const fences = new CiActionFenceStore(workspace);
        await expect(fences.begin(start())).rejects.toThrow("disk full");
        expect(fences.isFenced(HASH)).toBe(false);
        fences.dispose();
    });

    it("a fence write that stores and then rejects leaves no fence after a restart", async () => {
        const workspace = memento();
        const realUpdate = workspace.update;
        let failed = false;
        workspace.update = vi.fn(async (key: string, value: unknown) => {
            await realUpdate(key, value);
            if (!failed) {
                failed = true;
                throw new Error("write reported failure");
            }
        });
        const fences = new CiActionFenceStore(workspace);
        await expect(fences.begin(start())).rejects.toThrow("write reported failure");
        fences.dispose();

        const restarted = new CiActionFenceStore(workspace);
        expect(restarted.isFenced(HASH)).toBe(false);
        restarted.dispose();
    });

    it("the fence is in memory before its write finishes and fail removes it", async () => {
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        const begun = fences.begin(start());
        expect(fences.isFenced(HASH)).toBe(true);
        await begun;
        expect(storedFences(workspace)).toHaveLength(1);
        await fences.fail(REPO, HASH, "77");
        expect(fences.isFenced(HASH)).toBe(false);
        expect(storedFences(workspace)).toEqual([]);
        fences.dispose();
    });

    it("a failed removal write rejects fail and keeps the fence until a retry removes it", async () => {
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        await fences.begin(start());
        const realUpdate = workspace.update;
        workspace.update = vi.fn(async () => {
            throw new Error("disk full");
        });
        await expect(fences.fail(REPO, HASH, "77")).rejects.toThrow("disk full");
        expect(fences.isFenced(HASH)).toBe(true);
        const restarted = new CiActionFenceStore(workspace);
        expect(restarted.isFenced(HASH)).toBe(true);
        restarted.dispose();

        workspace.update = realUpdate;
        await fences.fail(REPO, HASH, "77");
        expect(fences.isFenced(HASH)).toBe(false);
        expect(storedFences(workspace)).toEqual([]);
        fences.dispose();
    });

    it("a detail fetched while the fence is still being written does not end it", async () => {
        const workspace = memento();
        const realUpdate = workspace.update;
        const hold = deferred();
        workspace.update = vi.fn(async (key: string, value: unknown) => {
            await hold.promise;
            return realUpdate(key, value);
        });
        const fences = new CiActionFenceStore(workspace);
        const shown = detail([run({ attempt: 2, state: "running" })]);

        const begun = fences.begin(start());
        // The action is not sent yet, so this detail cannot show it.
        const resolved = fences.resolve(REPO, HASH, shown);
        expect(fences.isFenced(HASH)).toBe(true);
        hold.resolve();
        await begun;
        await expect(resolved).resolves.toBe(false);

        expect(fences.isFenced(HASH)).toBe(true);
        expect(storedFences(workspace)).toHaveLength(1);
        await expect(fences.resolve(REPO, HASH, shown)).resolves.toBe(true);
        fences.dispose();
    });

    it("a ten-minute slow begin must not succeed after Refresh has removed its fence", async () => {
        vi.useFakeTimers({ now: 0 });
        const workspace = memento();
        const realUpdate = workspace.update;
        const hold = deferred();
        workspace.update = vi.fn(async (key: string, value: unknown) => {
            await hold.promise;
            return realUpdate(key, value);
        });
        const fences = new CiActionFenceStore(workspace);
        const send = vi.fn();
        // The caller sends the action only once begin resolves.
        const caller = fences.begin(start()).then(send, () => undefined);

        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        expect(fences.fenceFor(REPO, HASH)?.notSeen).toBe(true);
        const refreshed = fences.endByUserRefresh(REPO, HASH, "77");
        expect(fences.isFenced(HASH)).toBe(false);
        hold.resolve();
        await caller;
        await expect(refreshed).resolves.toBe(true);

        expect(
            send,
            "awaited begin must not authorize a send after its fence was removed",
        ).toHaveBeenCalledTimes(0);
        expect(storedFences(workspace)).toEqual([]);
        fences.dispose();
        expect(new CiActionFenceStore(workspace).isFenced(HASH)).toBe(false);
    });

    it("a slow begin racing fail must not authorize a send with no stored fence", async () => {
        const workspace = memento();
        const realUpdate = workspace.update;
        const hold = deferred();
        workspace.update = vi.fn(async (key: string, value: unknown) => {
            await hold.promise;
            return realUpdate(key, value);
        });
        const fences = new CiActionFenceStore(workspace);
        const storedAtSend: number[] = [];
        // The caller sends the action only once begin resolves.
        const caller = fences.begin(start()).then(
            () => storedAtSend.push(storedFences(workspace).length),
            () => undefined,
        );

        const failed = fences.fail(REPO, HASH, "77");
        hold.resolve();
        await caller;
        await failed;

        expect(storedAtSend, "begin must reject once fail started removing its fence").toEqual([]);
        expect(fences.isFenced(HASH)).toBe(false);
        expect(storedFences(workspace)).toEqual([]);
        fences.dispose();
    });

    it("a second action on a target whose action is still waiting is refused, in either order", async () => {
        const rerun = start();
        const cancel = start({ action: "cancel", evidence: "cancelled" });
        for (const [first, second] of [
            [rerun, rerun],
            [rerun, cancel],
            [cancel, rerun],
        ]) {
            const workspace = memento();
            const fences = new CiActionFenceStore(workspace);
            await fences.begin(first);
            await expect(fences.begin(second)).rejects.toThrow(
                "An earlier action on this target is still waiting.",
            );

            expect(fences.fenceFor(REPO, HASH)).toMatchObject({ action: first.action });
            expect(storedFences(workspace)).toEqual([
                expect.objectContaining({ action: first.action }),
            ]);
            fences.dispose();
        }
    });

    it("a second re-run is accepted once the first one's fence has ended", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        await fences.resolve(REPO, HASH, detail([run({ attempt: 2, state: "failure" })]));
        await fences.begin(start({ before: { attempt: 2, state: "failure" } }));

        // Evidence for the first re-run does not end the second.
        await expect(
            fences.resolve(REPO, HASH, detail([run({ attempt: 2, state: "failure" })])),
        ).resolves.toBe(false);
        expect(fences.fenceFor(REPO, HASH)).toMatchObject({ action: "rerunFailed" });
        fences.dispose();
    });

    it("a slow fail of an ended fence keeps the not-seen timer of the newer fence on its target", async () => {
        vi.useFakeTimers({ now: 0 });
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        const changed = vi.fn();
        fences.onDidChange(changed);
        await fences.begin(start());
        const realUpdate = workspace.update;
        const hold = deferred();
        workspace.update = vi.fn(async (key: string, value: unknown) => {
            await hold.promise;
            return realUpdate(key, value);
        });

        const failing = fences.fail(REPO, HASH, "77");
        await vi.advanceTimersByTimeAsync(0);
        // Evidence ends the old fence while its removal write waits; a new action starts.
        const resolved = fences.resolve(REPO, HASH, detail([run({ attempt: 2 })]));
        const begun = fences.begin(start({ before: { attempt: 2, state: "failure" } }));
        hold.resolve();
        await Promise.all([failing, resolved, begun]);

        expect(fences.fenceFor(REPO, HASH)).toMatchObject({ notSeen: false });
        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        expect(
            changed,
            "the newer fence must keep its not-seen notification timer",
        ).toHaveBeenCalledTimes(1);
        expect(fences.fenceFor(REPO, HASH)).toMatchObject({ notSeen: true });
        fences.dispose();
    });

    it("drops malformed stored fences and keeps valid ones", () => {
        const workspace = memento();
        workspace.values.set(`${ACTION_FENCE_KEY_PREFIX}%2Frepo/${HASH}/77`, { ...start(), at: 0 });
        workspace.values.set(`${ACTION_FENCE_KEY_PREFIX}%2Frepo/def5678/77`, {
            ...start({ hash: "def5678" }),
            at: 0,
            evidence: "whatever",
        });
        workspace.values.set(`${ACTION_FENCE_KEY_PREFIX}%2Frepo/fff0000/77`, "junk");
        // A record stored under another fence's key: ending it would write elsewhere.
        workspace.values.set(`${ACTION_FENCE_KEY_PREFIX}%2Frepo/aaa1111/77`, {
            ...start({ hash: "bbb2222" }),
            at: 0,
        });
        // Not a fence key at all.
        workspace.values.set("intelligit.other", { ...start({ hash: "ccc3333" }), at: 0 });
        // No repository: stored under the key its missing repoKey would spell.
        const { repoKey: _repoKey, ...noRepo } = start({ hash: "eee4444" });
        workspace.values.set(`${ACTION_FENCE_KEY_PREFIX}undefined/eee4444/77`, {
            ...noRepo,
            at: 0,
        });
        const fences = new CiActionFenceStore(workspace);
        expect(fences.isFenced(HASH)).toBe(true);
        expect(fences.isFenced("def5678")).toBe(false);
        expect(fences.isFenced("bbb2222")).toBe(false);
        expect(fences.isFenced("ccc3333")).toBe(false);
        expect(fences.isFenced("eee4444"), "a stored fence without a repoKey is dropped").toBe(
            false,
        );
        fences.dispose();
    });

    it("drops a stored fence whose before.state is not a CI state", () => {
        const workspace = memento();
        // Loaded, this record would end on an unchanged queued run: "queued" differs from
        // "bogus", so the runAttempt rule would read it as a restart.
        workspace.values.set(`${ACTION_FENCE_KEY_PREFIX}%2Frepo/${HASH}/77`, {
            ...start({ before: { attempt: 1, state: "bogus" as never } }),
            at: 0,
        });
        workspace.values.set(`${ACTION_FENCE_KEY_PREFIX}%2Frepo/def5678/77`, {
            ...start({ hash: "def5678", before: { attempt: 1, state: "queued" } }),
            at: 0,
        });
        const fences = new CiActionFenceStore(workspace);
        expect(fences.isFenced(HASH)).toBe(false);
        expect(fences.isFenced("def5678")).toBe(true);
        fences.dispose();
    });

    it("a provider without actionEvidence gets cancelled for cancel and nothing for re-runs", () => {
        const provider = {} as CommitChecksProvider;
        expect(evidenceFor(provider, "cancel")).toBe("cancelled");
        expect(evidenceFor(provider, "rerunFailed")).toBeUndefined();
        expect(evidenceFor(provider, "rerunJob")).toBeUndefined();
    });

    it("a fenced hash uses the pending TTL in L1 for snapshots and details", async () => {
        let now = 0;
        const clock = (): number => now;
        const fences = new CiActionFenceStore(memento(), { now: clock });
        await fences.begin(start());
        const snapshots = new CommitChecksService({ ttlMs: 30_000, now: clock, fences });
        const details = new CommitCiDetailService({ ttlMs: 30_000, now: clock, fences });
        const fetchSnapshot = vi.fn(async () => snapshot());
        const fetchDetail = vi.fn(async () => detail());

        await snapshots.getOrFetch(SNAPSHOT_KEY, fetchSnapshot);
        await details.getOrFetch(DETAIL_KEY, fetchDetail, SERVE);
        now += 29_000;
        await snapshots.getOrFetch(SNAPSHOT_KEY, fetchSnapshot);
        await details.getOrFetch(DETAIL_KEY, fetchDetail, SERVE);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        expect(fetchDetail).toHaveBeenCalledTimes(1);
        now += 2_000;
        await snapshots.getOrFetch(SNAPSHOT_KEY, fetchSnapshot);
        await details.getOrFetch(DETAIL_KEY, fetchDetail, SERVE);
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        expect(fetchDetail).toHaveBeenCalledTimes(2);
        fences.dispose();
    });

    it("with no stored fence, activation arms no timer and never writes workspaceState, even after a badge fetch", async () => {
        vi.useFakeTimers();
        // Other extension keys only, as every user has today while nothing calls begin.
        const workspace = memento(
            new Map<string, unknown>([
                ["intelligit.selectedRepositoryRoot", "/repo"],
                ["intelligit.changelists.v1", { lists: [] }],
            ]),
        );
        const fences = new CiActionFenceStore(workspace);
        const snapshots = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(memento(), { fence: fences }),
            fences,
        });
        await snapshots.getOrFetch(SNAPSHOT_KEY, async () => snapshot());
        expect(vi.getTimerCount(), "no fence timer is armed without a stored fence").toBe(0);
        expect(
            workspace.update,
            "the fence store never writes workspaceState",
        ).not.toHaveBeenCalled();
        fences.dispose();
    });

    it("an unfenced commit keeps its complete-result L1 lifetime beside a fence store", async () => {
        let now = 0;
        const clock = (): number => now;
        const fences = new CiActionFenceStore(memento(), { now: clock });
        // A fence on another commit only.
        await fences.begin(start({ hash: "def5678" }));
        const snapshots = new CommitChecksService({ ttlMs: 30_000, now: clock, fences });
        const details = new CommitCiDetailService({ ttlMs: 30_000, now: clock, fences });
        const fetchSnapshot = vi.fn(async () => snapshot());
        const fetchDetail = vi.fn(async () => detail());

        await snapshots.getOrFetch(SNAPSHOT_KEY, fetchSnapshot);
        await details.getOrFetch(DETAIL_KEY, fetchDetail, SERVE);
        now += 7 * DAY_MS;
        await snapshots.getOrFetch(SNAPSHOT_KEY, fetchSnapshot);
        await details.getOrFetch(DETAIL_KEY, fetchDetail, SERVE);
        expect(fetchSnapshot, "an unfenced complete snapshot stays in L1").toHaveBeenCalledTimes(1);
        expect(fetchDetail, "an unfenced complete detail stays in L1").toHaveBeenCalledTimes(1);
        fences.dispose();
    });

    it("reading a fenced commit's stored entries is a miss that never rewrites shared storage", async () => {
        const global = memento();
        const fences = new CiActionFenceStore(memento());
        const snapshots = new CommitChecksPersistentCache(global, { fence: fences });
        const details = new CiDetailPersistentCache(global, { fence: fences });
        await snapshots.set(SNAPSHOT_KEY, snapshot());
        await details.set(DETAIL_KEY, detail());
        await fences.begin(start());
        vi.mocked(global.update).mockClear();

        expect(
            await snapshots.get(SNAPSHOT_KEY),
            "a fenced stored snapshot is a miss",
        ).toBeUndefined();
        expect(await details.get(DETAIL_KEY), "a fenced stored detail is a miss").toBeUndefined();
        expect(
            global.update,
            "reading a fenced commit never rewrites shared storage",
        ).not.toHaveBeenCalled();
        fences.dispose();
    });

    it("a persisted entry for a fenced hash is not read back", async () => {
        const global = memento();
        const fences = new CiActionFenceStore(memento());
        const persistent = new CommitChecksPersistentCache(global);
        await persistent.set(SNAPSHOT_KEY, snapshot());
        await fences.begin(start());
        const service = new CommitChecksService({ persistentCache: persistent, fences });
        const fetchSnapshot = vi.fn(async () => ({ ...snapshot(), state: "pending" as const }));
        await expect(service.getOrFetch(SNAPSHOT_KEY, fetchSnapshot)).resolves.toMatchObject({
            state: "pending",
        });
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        fences.dispose();
    });

    it("a persisted detail for a fenced hash is not read back", async () => {
        const global = memento();
        const fences = new CiActionFenceStore(memento());
        const persistent = new CiDetailPersistentCache(global);
        await new CommitCiDetailService({ persistentCache: persistent }).getOrFetch(
            DETAIL_KEY,
            async () => detail(),
            SERVE,
        );
        expect(persistedDetailKeys(global)).toEqual([DETAIL_KEY]);
        await fences.begin(start());
        const service = new CommitCiDetailService({ persistentCache: persistent, fences });
        const fetchDetail = vi.fn(async () =>
            detail([run({ state: "running" })], { complete: false, outcome: "pending" }),
        );
        await expect(service.getOrFetch(DETAIL_KEY, fetchDetail, SERVE)).resolves.toMatchObject({
            outcome: "pending",
        });
        expect(fetchDetail).toHaveBeenCalledTimes(1);
        fences.dispose();
    });

    it("a fetched detail that shows the action ends the fence and is cached by the normal rules", async () => {
        const global = memento();
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const persistent = new CiDetailPersistentCache(global);
        const service = new CommitCiDetailService({ persistentCache: persistent, fences });
        const fetchDetail = vi.fn(async () =>
            detail([run({ attempt: 2, state: "success" })], { outcome: "success" }),
        );
        const served = await service.getOrFetch(DETAIL_KEY, fetchDetail, SERVE, { force: true });
        // The detail that ends the fence is the evidence: its own end does not outdate it.
        expect(fetchDetail).toHaveBeenCalledTimes(1);
        expect(fences.isFenced(HASH)).toBe(false);
        expect(served.actionFence).toBeUndefined();
        expect(persistedDetailKeys(global)).toEqual([DETAIL_KEY]);
        fences.dispose();
    });
});

describe("two windows on one workspaceState", () => {
    const OTHER_HASH = "def5678";

    it("a write from the other window keeps this window's fence across a restart", async () => {
        const workspace = memento();
        const first = new CiActionFenceStore(workspace);
        const second = new CiActionFenceStore(workspace);
        await first.begin(start());
        await second.begin(start({ hash: OTHER_HASH, targetId: "88", runId: "88" }));
        first.dispose();
        second.dispose();

        const reopened = new CiActionFenceStore(workspace);
        expect(reopened.fenceFor(REPO, HASH)).toMatchObject({ targetId: "77" });
        expect(reopened.fenceFor(REPO, OTHER_HASH)).toMatchObject({ targetId: "88" });
        // The pre-action failure stored before the click is not served after the restart.
        const global = memento();
        const persistent = new CommitChecksPersistentCache(global);
        await persistent.set(SNAPSHOT_KEY, snapshot());
        const service = new CommitChecksService({ persistentCache: persistent, fences: reopened });
        const fetchSnapshot = vi.fn(async () => ({ ...snapshot(), state: "pending" as const }));
        await expect(service.getOrFetch(SNAPSHOT_KEY, fetchSnapshot)).resolves.toMatchObject({
            state: "pending",
        });
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        reopened.dispose();
    });

    it("fences begun in both windows at the same moment are both stored", async () => {
        const workspace = memento();
        const first = new CiActionFenceStore(workspace);
        const second = new CiActionFenceStore(workspace);
        await Promise.all([
            first.begin(start()),
            second.begin(start({ hash: OTHER_HASH, targetId: "88", runId: "88" })),
        ]);
        first.dispose();
        second.dispose();

        const reopened = new CiActionFenceStore(workspace);
        expect(reopened.isFenced(HASH)).toBe(true);
        expect(reopened.isFenced(OTHER_HASH)).toBe(true);
        reopened.dispose();
    });

    it("ending a fence in one window keeps the other window's fence and drops its own", async () => {
        const workspace = memento();
        const first = new CiActionFenceStore(workspace);
        const second = new CiActionFenceStore(workspace);
        await first.begin(start());
        await second.begin(start({ hash: OTHER_HASH, targetId: "88", runId: "88" }));
        await second.fail(REPO, OTHER_HASH, "88");
        first.dispose();
        second.dispose();

        const reopened = new CiActionFenceStore(workspace);
        expect(reopened.isFenced(HASH)).toBe(true);
        expect(reopened.isFenced(OTHER_HASH)).toBe(false);
        reopened.dispose();
    });

    const END_FENCE_1 = {
        "a definite failure": (fences: CiActionFenceStore) => fences.fail(REPO, HASH, "77"),
        "evidence in a fetched detail": (fences: CiActionFenceStore) =>
            fences.resolve(REPO, HASH, detail([run({ attempt: 2, state: "running" })])),
    };

    for (const [how, endFence1] of Object.entries(END_FENCE_1)) {
        it(`two windows over one workspaceState with delayed propagation: neither a begin nor an end in one window drops or revives the other window's fence (end by ${how})`, async () => {
            const storage = delayedMemento();
            const windowA = new CiActionFenceStore(storage.window());
            const windowB = new CiActionFenceStore(storage.window());
            await windowA.begin(start());
            // B has not seen A's fence yet when it begins its own.
            await windowB.begin(start({ hash: OTHER_HASH, targetId: "88", runId: "88" }));
            await endFence1(windowA);
            storage.propagate();
            windowA.dispose();
            windowB.dispose();

            const view = storage.window();
            const reopened = new CiActionFenceStore(view);
            expect(reopened.isFenced(OTHER_HASH)).toBe(true);
            expect(reopened.isFenced(HASH)).toBe(false);
            expect(storedFences(view)).toEqual([
                expect.objectContaining({ hash: OTHER_HASH, targetId: "88" }),
            ]);
            reopened.dispose();
        });

        it(`a begin from a window that still sees an ended fence does not bring it back (end by ${how})`, async () => {
            const storage = delayedMemento();
            const windowA = new CiActionFenceStore(storage.window());
            await windowA.begin(start());
            storage.propagate();
            // B loads fence 1, then A ends it; B has not seen the end when it begins fence 2.
            const windowB = new CiActionFenceStore(storage.window());
            await endFence1(windowA);
            await windowB.begin(start({ hash: OTHER_HASH, targetId: "88", runId: "88" }));
            storage.propagate();
            windowA.dispose();
            windowB.dispose();

            const view = storage.window();
            const reopened = new CiActionFenceStore(view);
            expect(reopened.isFenced(HASH)).toBe(false);
            expect(reopened.isFenced(OTHER_HASH)).toBe(true);
            expect(storedFences(view)).toEqual([
                expect.objectContaining({ hash: OTHER_HASH, targetId: "88" }),
            ]);
            reopened.dispose();
        });
    }

    it("each fence is stored under its own key and ending it removes only that key", async () => {
        const workspace = memento();
        const fences = new CiActionFenceStore(workspace);
        await fences.begin(start({ repoKey: "/a b", targetId: "7/7" }));
        await fences.begin(start({ hash: OTHER_HASH, targetId: "88", runId: "88" }));
        expect([...workspace.values.keys()].sort()).toEqual([
            `${ACTION_FENCE_KEY_PREFIX}%2Fa%20b/${HASH}/7%2F7`,
            `${ACTION_FENCE_KEY_PREFIX}%2Frepo/${OTHER_HASH}/88`,
        ]);
        await fences.fail(REPO, OTHER_HASH, "88");
        expect([...workspace.values.keys()]).toEqual([
            `${ACTION_FENCE_KEY_PREFIX}%2Fa%20b/${HASH}/7%2F7`,
        ]);
        fences.dispose();
    });

    // Literal keys, never built from ACTION_FENCE_KEY_PREFIX: renaming the stored key
    // would lose every fence already in workspaceState after an update.
    it("keeps the stored key format intelligit.ci.actionFence.v1: across releases", async () => {
        const workspace = memento();
        workspace.values.set(`intelligit.ci.actionFence.v1:%2Frepo/${HASH}/77`, {
            ...start(),
            at: 0,
        });
        const reopened = new CiActionFenceStore(workspace);
        expect(reopened.isFenced(HASH), "a fence stored by an earlier release must load").toBe(
            true,
        );
        await reopened.begin(start({ hash: OTHER_HASH, targetId: "88", runId: "88" }));
        expect(workspace.values.has(`intelligit.ci.actionFence.v1:%2Frepo/${OTHER_HASH}/88`)).toBe(
            true,
        );
        reopened.dispose();
    });
});

describe("when a fence ends", () => {
    const RERUN_STARTED = detail([run({ attempt: 2, state: "running" })], {
        complete: false,
        outcome: "pending",
    });
    const pendingSnapshot = (): CommitChecksSnapshot => ({
        ...snapshot(),
        state: "pending",
        items: [{ name: "test", description: "", state: "pending", source: "check-run" }],
    });

    it("a snapshot held while fenced is fetched again once the fence ends", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const service = new CommitChecksService({ fences });
        const fetchSnapshot = vi
            .fn<() => Promise<CommitChecksSnapshot>>()
            .mockResolvedValueOnce(snapshot())
            .mockResolvedValueOnce(pendingSnapshot());

        await service.getOrFetch(SNAPSHOT_KEY, fetchSnapshot);
        await fences.resolve(REPO, HASH, RERUN_STARTED);
        await expect(service.getOrFetch(SNAPSHOT_KEY, fetchSnapshot)).resolves.toMatchObject({
            state: "pending",
        });
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        fences.dispose();
    });

    it("a detail held while fenced is fetched again once another answer ends the fence", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const service = new CommitCiDetailService({ fences });
        const fetchDetail = vi
            .fn<() => Promise<CommitCiDetailData>>()
            .mockResolvedValueOnce(detail())
            .mockResolvedValueOnce(RERUN_STARTED);

        await service.getOrFetch(DETAIL_KEY, fetchDetail, SERVE);
        // Another answer for this repository showed the re-run.
        await fences.resolve(REPO, HASH, RERUN_STARTED);
        await expect(service.getOrFetch(DETAIL_KEY, fetchDetail, SERVE)).resolves.toMatchObject({
            outcome: "pending",
        });
        expect(fetchDetail).toHaveBeenCalledTimes(2);
        fences.dispose();
    });

    it("a detail fetch started while fenced and answered after the end is fetched again", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const service = new CommitCiDetailService({ fences });
        const answer = deferred();
        const fetchDetail = vi
            .fn<() => Promise<CommitCiDetailData>>()
            .mockImplementationOnce(async () => {
                await answer.promise;
                return detail();
            })
            .mockResolvedValueOnce(RERUN_STARTED);

        const first = service.getOrFetch(DETAIL_KEY, fetchDetail, SERVE);
        await vi.waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(1));
        await fences.resolve(REPO, HASH, RERUN_STARTED);
        answer.resolve();

        await expect(first).resolves.toMatchObject({ outcome: "pending" });
        expect(fetchDetail).toHaveBeenCalledTimes(2);
        fences.dispose();
    });

    it("a snapshot fetch started while fenced and answered after the end is fetched again", async () => {
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const global = memento();
        const service = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(global, { fence: fences }),
            fences,
        });
        const answer = deferred();
        const fetchSnapshot = vi
            .fn<() => Promise<CommitChecksSnapshot>>()
            .mockImplementationOnce(async () => {
                await answer.promise;
                return snapshot();
            })
            .mockResolvedValueOnce(pendingSnapshot());

        const first = service.getOrFetch(SNAPSHOT_KEY, fetchSnapshot);
        await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(1));
        await fences.resolve(REPO, HASH, RERUN_STARTED);
        answer.resolve();

        await expect(first).resolves.toMatchObject({ state: "pending" });
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        expect(global.values.get("intelligit.commitChecks.cache.v1")).toBeUndefined();
        fences.dispose();
    });

    it("an old result another window saved while this one was fenced is not read back", async () => {
        const global = memento();
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const snapshotsA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(global, { fence: fences }),
            fences,
        });
        const detailsA = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(global, { fence: fences }),
            fences,
        });
        // Window B has no fence: its fetches save the pre-action failure to shared storage.
        await new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(global),
        }).getOrFetch(SNAPSHOT_KEY, async () => snapshot());
        await new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(global),
        }).getOrFetch(DETAIL_KEY, async () => detail(), SERVE);

        await fences.resolve(REPO, HASH, RERUN_STARTED);

        await expect(
            snapshotsA.getOrFetch(SNAPSHOT_KEY, async () => pendingSnapshot()),
        ).resolves.toMatchObject({ state: "pending" });
        await expect(
            detailsA.getOrFetch(DETAIL_KEY, async () => RERUN_STARTED, SERVE),
        ).resolves.toMatchObject({ outcome: "pending" });
        fences.dispose();
    });

    it("an old stored result stays unreadable when its removal at the fence end fails once", async () => {
        const snapshotGlobal = memento();
        const detailGlobal = memento();
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const snapshotsA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(snapshotGlobal, { fence: fences }),
            fences,
        });
        const detailsA = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(detailGlobal, { fence: fences }),
            fences,
        });
        // Window B has no fence: its fetches save the pre-action failure to shared storage.
        await new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(snapshotGlobal),
        }).getOrFetch(SNAPSHOT_KEY, async () => snapshot());
        await new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(detailGlobal),
        }).getOrFetch(DETAIL_KEY, async () => detail(), SERVE);
        // The next write of each store (the removal at the fence end) fails once.
        for (const state of [snapshotGlobal, detailGlobal]) {
            const realUpdate = state.update;
            let failed = false;
            state.update = vi.fn(async (key: string, value: unknown) => {
                if (!failed) {
                    failed = true;
                    throw new Error("disk full");
                }
                return realUpdate(key, value);
            });
        }

        await fences.resolve(REPO, HASH, RERUN_STARTED);

        await expect(
            snapshotsA.getOrFetch(SNAPSHOT_KEY, async () => pendingSnapshot()),
        ).resolves.toMatchObject({ state: "pending" });
        await expect(
            detailsA.getOrFetch(DETAIL_KEY, async () => RERUN_STARTED, SERVE),
        ).resolves.toMatchObject({ outcome: "pending" });
        fences.dispose();
    });

    it("an old stored result stays unreadable after a restart when its removal at the fence end failed once", async () => {
        // Either cache's failed removal alone must keep the fence stored.
        for (const failing of ["snapshot", "detail"] as const) {
            const workspace = memento();
            const snapshotGlobal = memento();
            const detailGlobal = memento();
            const fences = new CiActionFenceStore(workspace);
            await fences.begin(start());
            const windowA = [
                new CommitChecksService({
                    persistentCache: new CommitChecksPersistentCache(snapshotGlobal, {
                        fence: fences,
                    }),
                    fences,
                }),
                new CommitCiDetailService({
                    persistentCache: new CiDetailPersistentCache(detailGlobal, { fence: fences }),
                    fences,
                }),
            ];
            expect(windowA).toHaveLength(2);
            // Window B has no fence: its fetches save the pre-action failure to shared storage.
            await new CommitChecksService({
                persistentCache: new CommitChecksPersistentCache(snapshotGlobal),
            }).getOrFetch(SNAPSHOT_KEY, async () => snapshot());
            await new CommitCiDetailService({
                persistentCache: new CiDetailPersistentCache(detailGlobal),
            }).getOrFetch(DETAIL_KEY, async () => detail(), SERVE);
            // That store's next write (the removal at the fence end) fails once.
            const state = failing === "snapshot" ? snapshotGlobal : detailGlobal;
            const realUpdate = state.update;
            let failed = false;
            state.update = vi.fn(async (key: string, value: unknown) => {
                if (!failed) {
                    failed = true;
                    throw new Error("disk full");
                }
                return realUpdate(key, value);
            });

            await fences.resolve(REPO, HASH, RERUN_STARTED);
            // A later fence write for another commit must not drop the one still needed.
            await fences.begin(start({ hash: "def5678", targetId: "88", runId: "88" }));
            await fences.fail(REPO, "def5678", "88");
            fences.dispose();

            // Restart: new stores over the same storage.
            const restarted = new CiActionFenceStore(workspace);
            const snapshotsB = new CommitChecksService({
                persistentCache: new CommitChecksPersistentCache(snapshotGlobal, {
                    fence: restarted,
                }),
                fences: restarted,
            });
            const detailsB = new CommitCiDetailService({
                persistentCache: new CiDetailPersistentCache(detailGlobal, { fence: restarted }),
                fences: restarted,
            });
            await expect(
                snapshotsB.getOrFetch(SNAPSHOT_KEY, async () => pendingSnapshot()),
            ).resolves.toMatchObject({ state: "pending" });
            await expect(
                detailsB.getOrFetch(DETAIL_KEY, async () => RERUN_STARTED, SERVE),
            ).resolves.toMatchObject({ outcome: "pending" });
            // The detail ended the fence again; this time both removals succeed and it goes.
            await vi.waitFor(() => expect(storedFences(workspace)).toEqual([]));
            restarted.dispose();
        }
    });

    it("an earlier end's removal succeeding does not make a later end's failed removal readable", async () => {
        // Stores whose removals settle when the test says, and whose reads return the old answer.
        const store = <T>(old: T) => {
            const removals: { resolve: () => void; reject: () => void }[] = [];
            return {
                removals,
                cache: {
                    get: vi.fn(async () => old),
                    set: vi.fn(async () => undefined),
                    delete: vi.fn(async () => undefined),
                    confirmWrite: vi.fn(async () => undefined),
                    generation: () => undefined,
                    deleteHash: vi.fn(
                        () =>
                            new Promise<void>((resolve, reject) => {
                                removals.push({ resolve, reject: () => reject(new Error("disk")) });
                            }),
                    ),
                },
            };
        };
        const snapshots = store(snapshot());
        const details = store(detail());
        const fences = new CiActionFenceStore(memento());
        const snapshotService = new CommitChecksService({
            persistentCache: snapshots.cache as unknown as CommitChecksPersistentCache,
            fences,
        });
        const detailService = new CommitCiDetailService({
            persistentCache: details.cache as unknown as CiDetailPersistentCache,
            fences,
        });

        await fences.begin(start());
        // Each end waits for its removals, which settle below.
        const firstEnd = fences.resolve(
            REPO,
            HASH,
            detail([run({ attempt: 2, state: "failure" })]),
        );
        await fences.begin(start({ before: { attempt: 2, state: "failure" } }));
        const secondEnd = fences.resolve(
            REPO,
            HASH,
            detail([run({ attempt: 3, state: "failure" })]),
        );
        for (const { removals } of [snapshots, details]) {
            expect(removals).toHaveLength(2);
            removals[0].resolve();
            removals[1].reject();
        }
        await Promise.all([firstEnd, secondEnd]);

        await expect(
            snapshotService.getOrFetch(SNAPSHOT_KEY, async () => pendingSnapshot()),
        ).resolves.toMatchObject({ state: "pending" });
        await expect(
            detailService.getOrFetch(DETAIL_KEY, async () => RERUN_STARTED, SERVE),
        ).resolves.toMatchObject({ outcome: "pending" });
        fences.dispose();
    });

    it("an old stored result whose read was queued before the fence ended is not served", async () => {
        const global = memento();
        const fences = new CiActionFenceStore(memento());
        await fences.begin(start());
        const snapshotsA = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(global, { fence: fences }),
            fences,
        });
        const detailsA = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(global, { fence: fences }),
            fences,
        });
        await new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(global),
        }).getOrFetch(SNAPSHOT_KEY, async () => snapshot());
        await new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(global),
        }).getOrFetch(DETAIL_KEY, async () => detail(), SERVE);
        // Holds the next storage write (the read's recency bump), so the read is still
        // queued when the fence ends.
        const realUpdate = global.update;
        const hold = deferred();
        let held = 0;
        global.update = vi.fn(async (key: string, value: unknown) => {
            held += 1;
            await hold.promise;
            return realUpdate(key, value);
        });

        const servedSnapshot = snapshotsA.getOrFetch(SNAPSHOT_KEY, async () => pendingSnapshot());
        const servedDetail = detailsA.getOrFetch(DETAIL_KEY, async () => RERUN_STARTED, SERVE);
        await vi.waitFor(() => expect(held).toBe(2));
        // The fence leaves memory at once; its end waits for the removals behind the hold.
        const ended = fences.resolve(REPO, HASH, RERUN_STARTED);
        hold.resolve();
        await ended;

        await expect(servedSnapshot).resolves.toMatchObject({ state: "pending" });
        await expect(servedDetail).resolves.toMatchObject({ outcome: "pending" });
        fences.dispose();
    });
});

describe("commit checks README", () => {
    it("documents the action fence with the not-seen interval the store uses", () => {
        const readme = readFileSync(join(process.cwd(), "docs/commit-checks/README.md"), "utf8");
        const section = readme.split(/^## /m).find((part) => part.startsWith("Re-run and cancel"));

        expect(section, "README needs a 'Re-run and cancel' section").toBeDefined();
        expect(section).toContain(`${ACTION_FENCE_NOT_SEEN_MS / 60_000} minutes`);
        expect(section).toContain("not seen yet");
        expect(section).toContain("restart");
    });
});
