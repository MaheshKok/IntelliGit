import { describe, expect, it, vi } from "vitest";
import type { CiJob, CiRun, CommitCiDetail, CommitCiDetailData } from "../../../../src/types";
import type { CommitChecksPersistentState } from "../../../../src/services/commitChecks/persistentCache";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import { CiActionFenceStore } from "../../../../src/services/commitChecks/ciActionFence";
import {
    CommitCiDetailService,
    type CiDetailServeContext,
    type CiFailedScanHooks,
} from "../../../../src/services/commitChecks/detailService";
import type {
    CiDetailFetch,
    CiFailedScanCursor,
    CiFailedScanPage,
} from "../../../../src/services/commitChecks/types";
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

function memento(): CommitChecksPersistentState & {
    values: Map<string, unknown>;
    keys(): readonly string[];
} {
    const values = new Map<string, unknown>();
    return {
        values,
        get: vi.fn((key: string) => values.get(key)),
        keys: vi.fn(() => [...values.keys()]),
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

    it("a fetch started before a fence began never ends it", async () => {
        const fences = new CiActionFenceStore(memento());
        const details = new CommitCiDetailService({ fences });
        const pending = deferred<CommitCiDetailData>();
        const served = details.getOrFetch(KEY, () => pending.promise, SERVE);
        await fences.begin({
            repoKey: "/repo",
            hash: "abc1234",
            provider: "github",
            action: "rerunFailed",
            targetId: "1",
            runId: "1",
            before: { attempt: 1, state: "failure" },
            evidence: "runAttempt",
        });
        pending.resolve(
            detail({
                complete: false,
                outcome: "pending",
                runs: [run({ attempt: 1, state: "running" })],
            }),
        );
        await served;
        expect(
            fences.isFenced("abc1234"),
            "a pre-click read showing running keeps the re-run fence",
        ).toBe(true);
        fences.dispose();
    });

    it("served actionFence follows the fence store", async () => {
        const fences = new CiActionFenceStore(memento());
        const details = new CommitCiDetailService({ fences });
        const fetchDetail = vi.fn(async () => detail());
        await expect(details.getOrFetch(KEY, fetchDetail, SERVE)).resolves.not.toHaveProperty(
            "actionFence",
        );

        await fences.begin({
            repoKey: "/repo",
            hash: "abc1234",
            provider: "github",
            action: "rerunFailed",
            targetId: "1",
            runId: "1",
            before: { attempt: 1, state: "failure" },
            evidence: "runAttempt",
        });
        await expect(details.getOrFetch(KEY, fetchDetail, SERVE)).resolves.toMatchObject({
            actionFence: { targetId: "1", action: "rerunFailed", notSeen: false },
        });
        // Another repository showing the same SHA has no fence of its own.
        await expect(
            details.getOrFetch(KEY, fetchDetail, { ...SERVE, repoKey: "/other" }),
        ).resolves.not.toHaveProperty("actionFence");

        await fences.fail("/repo", "abc1234", "1");
        await expect(details.getOrFetch(KEY, fetchDetail, SERVE)).resolves.not.toHaveProperty(
            "actionFence",
        );
        expect(fetchDetail).toHaveBeenCalledTimes(1);
        fences.dispose();
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

    it("the detail contract version is 3: details carry and accept 3, and an older entry is a miss", async () => {
        expect(CI_DETAIL_CONTRACT_VERSION).toBe(3);
        const state = memento();
        await service(state, () => 1_000).service.getOrFetch(KEY, async () => detail(), SERVE);
        const saved = state.values.get(STORAGE_KEY) as { entries: { contractVersion: number }[] };
        expect(saved.entries.map((entry) => entry.contractVersion)).toEqual([3]);

        const written = (contractVersion: number) => {
            const stored = memento();
            stored.values.set(STORAGE_KEY, {
                entries: [
                    {
                        key: KEY,
                        contractVersion,
                        data: detail(),
                        fetchedAt: 1_000,
                        lastAccessedAt: 1_000,
                    },
                ],
                unconfirmed: {},
            });
            return stored;
        };
        const fetchDetail = vi.fn(async () => detail({ outcome: "success" }));
        await expect(
            service(written(3), () => 1_000).service.getOrFetch(KEY, fetchDetail, SERVE),
        ).resolves.toMatchObject({ outcome: "failure" });
        expect(fetchDetail).not.toHaveBeenCalled();
        // Version 2 entries hold GitLab details as flat lists, before its pipelines were read.
        await expect(
            service(written(2), () => 1_000).service.getOrFetch(KEY, fetchDetail, SERVE),
        ).resolves.toMatchObject({ outcome: "success" });
        expect(fetchDetail).toHaveBeenCalledTimes(1);
    });

    describe("failed-job overflow scan", () => {
        const failed = (id: string): CiJob => ({
            id,
            logicalId: `ci\0${id}`,
            name: id,
            checkName: id,
            state: "failure",
            steps: [],
        });
        const capped = (): CiDetailFetch => ({
            ...detail({
                runs: [
                    run({
                        attempt: 1,
                        jobs: [failed("job 1")],
                        jobsCoverage: { reason: "pageBound", shown: 1000 },
                    }),
                ],
            }),
            scanCursors: [{ runId: "1", runAttempt: 1, runName: "CI", url: "page-11" }],
        });
        const pages: Record<string, CiFailedScanPage> = {
            "page-11": {
                failed: [failed("job 1050")],
                next: { runId: "1", runAttempt: 1, runName: "CI", url: "page-12" },
            },
            "page-12": { failed: [failed("job 1900")] },
        };

        it("scan detail is never persisted", async () => {
            const state = memento();
            const { service: details, persistent } = service(state);
            const posts: CommitCiDetail[] = [];
            await details.getOrFetch(KEY, async () => capped(), SERVE, {}, undefined, {
                continueScan: async (cursor) => pages[cursor.url],
                isCurrent: () => true,
                onUpdate: (served) => posts.push(served),
            });
            await vi.waitFor(() => expect(posts.at(-1)?.runs[0].failedScan?.state).toBe("done"));
            expect(posts.at(-1)?.runs[0].jobs.map((job) => job.id)).toEqual([
                "job 1",
                "job 1050",
                "job 1900",
            ]);
            expect(await persistent.get(KEY)).toBeUndefined();
            expect(state.values.has(STORAGE_KEY)).toBe(false);
        });

        it("a GitHub job found by the scan keeps a status context that only shares its number", async () => {
            const posts: CommitCiDetail[] = [];
            const status = {
                id: "1050",
                name: "1050",
                description: "external CI",
                source: "status" as const,
                state: "failure" as const,
            };
            await service().service.getOrFetch(
                KEY,
                async () => ({ ...capped(), otherChecks: [status] }),
                SERVE,
                {},
                undefined,
                {
                    continueScan: async () => ({ failed: [failed("1050")] }),
                    isCurrent: () => true,
                    onUpdate: (served) => posts.push(served),
                },
            );
            await vi.waitFor(() => expect(posts.at(-1)?.runs[0].failedScan?.state).toBe("done"));
            expect(
                posts.at(-1)?.otherChecks,
                "GitHub status contexts and job ids are separate identities",
            ).toEqual([status]);
        });

        const rerunFence = {
            repoKey: "/repo",
            hash: "abc1234",
            provider: "github",
            action: "rerunFailed",
            targetId: "1",
            runId: "1",
            before: { attempt: 1, state: "failure" },
            evidence: "runAttempt",
        } as const;

        it("a scan page update carries the commit's action fence", async () => {
            const fences = new CiActionFenceStore(memento());
            await fences.begin(rerunFence);
            const details = new CommitCiDetailService({ fences });
            const posts: CommitCiDetail[] = [];
            await details.getOrFetch(KEY, async () => capped(), SERVE, {}, undefined, {
                continueScan: async (cursor) => pages[cursor.url],
                isCurrent: () => true,
                onUpdate: (served) => posts.push(served),
            });
            await vi.waitFor(() => expect(posts.at(-1)?.runs[0].failedScan?.state).toBe("done"));
            expect(
                posts.map((served) => served.actionFence?.targetId),
                "every scan page re-post keeps the fence label",
            ).toEqual(posts.map(() => "1"));
            fences.dispose();
        });

        it("a fenced commit keeps the pending TTL even once its scan completes the detail", async () => {
            let now = 0;
            const fences = new CiActionFenceStore(memento(), { now: () => now });
            await fences.begin(rerunFence);
            const details = new CommitCiDetailService({ ttlMs: 30_000, now: () => now, fences });
            const fetchDetail = vi.fn(async () => capped());
            const posts: CommitCiDetail[] = [];
            await details.getOrFetch(KEY, fetchDetail, SERVE, {}, undefined, {
                continueScan: async (cursor) => pages[cursor.url],
                isCurrent: () => true,
                onUpdate: (served) => posts.push(served),
            });
            await vi.waitFor(() => expect(posts.at(-1)?.complete).toBe(true));
            now += 31_000;
            await details.getOrFetch(KEY, fetchDetail, SERVE);
            expect(
                fetchDetail,
                "a fenced commit past the pending TTL is fetched again",
            ).toHaveBeenCalledTimes(2);
            fences.dispose();
        });

        it("a cancel that ends its fence drops the old scan's found jobs instead of carrying them", async () => {
            const fences = new CiActionFenceStore(memento());
            const details = new CommitCiDetailService({ fences });
            const runningRun = (state: CiRun["state"]): CiDetailFetch => {
                const fetched = capped();
                return { ...fetched, runs: [{ ...fetched.runs[0], state }] };
            };
            const page12 = deferred<CiFailedScanPage>();
            const posts: CommitCiDetail[] = [];
            await details.getOrFetch(KEY, async () => runningRun("running"), SERVE, {}, undefined, {
                continueScan: (cursor) =>
                    cursor.url === "page-12" ? page12.promise : Promise.resolve(pages[cursor.url]),
                isCurrent: () => true,
                onUpdate: (served) => posts.push(served),
            });
            await vi.waitFor(() =>
                expect(posts.at(-1)?.runs[0].jobs.map((job) => job.id)).toContain("job 1050"),
            );

            await fences.begin({
                ...rerunFence,
                action: "cancel",
                before: { attempt: 1, state: "running" },
                evidence: "cancelled",
            });
            const after = await details.getOrFetch(
                KEY,
                async () => runningRun("cancelled"),
                SERVE,
                { force: true },
                undefined,
                {
                    continueScan: () => new Promise<CiFailedScanPage>(() => undefined),
                    isCurrent: () => true,
                    onUpdate: () => undefined,
                },
            );
            expect(
                after.runs[0].jobs.map((job) => job.id),
                "a pre-cancel scan's found jobs never reach the post-cancel detail",
            ).toEqual(["job 1"]);
            expect(fences.isFenced("abc1234")).toBe(false);
            page12.resolve(pages["page-12"]);
            fences.dispose();
        });

        it("each scan page re-posts with the original requestId", async () => {
            const { service: details } = service();
            const posts: { requestId: string; detail: CommitCiDetail }[] = [];
            const page12 = deferred<CiFailedScanPage>();
            const hooks = (requestId: string): CiFailedScanHooks => ({
                continueScan: (cursor) =>
                    cursor.url === "page-12" ? page12.promise : Promise.resolve(pages[cursor.url]),
                isCurrent: () => true,
                onUpdate: (served) => posts.push({ requestId, detail: served }),
            });
            const first = await details.getOrFetch(
                KEY,
                async () => capped(),
                SERVE,
                {},
                undefined,
                hooks("r1"),
            );
            expect(first.runs[0].failedScan).toEqual({ state: "running", found: 0 });
            await vi.waitFor(() => expect(posts).toHaveLength(1));
            expect(posts[0].requestId).toBe("r1");
            expect(posts[0].detail).toMatchObject({
                repoKey: "/repo",
                capabilities: NO_CI_CAPABILITIES,
            });
            expect(posts[0].detail.runs[0].failedScan).toEqual({ state: "running", found: 1 });

            // A newer request for the same commit takes over the posts; the scan is not restarted.
            const second = await details.getOrFetch(
                KEY,
                async () => capped(),
                SERVE,
                {},
                undefined,
                hooks("r2"),
            );
            expect(second.runs[0].failedScan).toEqual({ state: "running", found: 1 });
            page12.resolve(pages["page-12"]);
            await vi.waitFor(() => expect(posts).toHaveLength(2));
            expect(posts.map((post) => post.requestId)).toEqual(["r1", "r2"]);
            expect(posts[1].detail.runs[0].failedScan).toEqual({ state: "done", found: 2 });
        });

        it("a found job's pending flat check leaves the list; the provider's incomplete read stays incomplete", async () => {
            const flat = (id: string, source: "check-run" | "status") => ({
                id,
                name: id,
                description: "",
                state: "pending" as const,
                source,
            });
            const scanned = async (otherChecks: ReturnType<typeof flat>[]) => {
                const posts: CommitCiDetail[] = [];
                await service().service.getOrFetch(
                    KEY,
                    async () => ({
                        // The snapshot still listed job 1050's check run as running.
                        ...capped(),
                        complete: false,
                        otherChecks,
                    }),
                    SERVE,
                    {},
                    undefined,
                    {
                        continueScan: async (cursor) =>
                            cursor.url === "page-11"
                                ? { failed: [{ ...failed("job 1050"), checkRunId: "9050" }] }
                                : pages[cursor.url],
                        isCurrent: () => true,
                        onUpdate: (served) => posts.push(served),
                    },
                );
                await vi.waitFor(() =>
                    expect(posts.at(-1)?.runs[0].failedScan?.state).toBe("done"),
                );
                return posts.at(-1);
            };

            const alone = await scanned([flat("9050", "check-run")]);
            expect(alone?.otherChecks).toEqual([]);
            // The provider read the snapshot and the jobs apart, so its reason still holds.
            expect(alone, "the scan never overrides the provider's incomplete").toMatchObject({
                complete: false,
                outcome: "failure",
            });

            const withStatus = await scanned([flat("9050", "check-run"), flat("lint", "status")]);
            expect(withStatus?.otherChecks.map((check) => check.id)).toEqual(["lint"]);
            expect(withStatus, "a pending status still keeps the detail incomplete").toMatchObject({
                complete: false,
                outcome: "failure",
            });
        });

        it("a final read the provider marked incomplete stays incomplete through its scan and is fetched again after the pending TTL", async () => {
            let now = 0;
            const { service: details, persistent } = service(memento(), () => now);
            const posts: CommitCiDetail[] = [];
            // The provider's third read still saw the run re-run, so it is not complete.
            const fetchDetail = vi.fn(async (): Promise<CiDetailFetch> => ({
                ...capped(),
                complete: false,
            }));
            const hooks: CiFailedScanHooks = {
                continueScan: async (cursor) => pages[cursor.url],
                isCurrent: () => true,
                onUpdate: (served) => posts.push(served),
            };
            const first = await details.getOrFetch(KEY, fetchDetail, SERVE, {}, undefined, hooks);
            expect(first.complete, "served with its scan attached").toBe(false);
            await vi.waitFor(() => expect(posts.at(-1)?.runs[0].failedScan?.state).toBe("done"));
            expect(posts.at(-1)?.complete, "a finished scan keeps the provider's reason").toBe(
                false,
            );

            now += 29_000;
            await details.getOrFetch(KEY, fetchDetail, SERVE, {}, undefined, hooks);
            expect(fetchDetail).toHaveBeenCalledTimes(1);
            now += 2_000;
            await details.getOrFetch(KEY, fetchDetail, SERVE, {}, undefined, hooks);
            expect(
                fetchDetail,
                "the pending TTL expires it and it is fetched again",
            ).toHaveBeenCalledTimes(2);
            expect(await persistent.get(KEY)).toBeUndefined();
        });

        it("a page read while its requester goes stale is neither kept nor posted", async () => {
            const { service: details } = service();
            const posts: CommitCiDetail[] = [];
            const page11 = deferred<CiFailedScanPage>();
            let current = true;
            await details.getOrFetch(KEY, async () => capped(), SERVE, {}, undefined, {
                continueScan: () => page11.promise,
                isCurrent: () => current,
                onUpdate: (served) => posts.push(served),
            });
            // Sign-out or navigation while page 11 is in flight.
            current = false;
            page11.resolve(pages["page-11"]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(posts).toEqual([]);

            // The user comes back inside the TTL: the L1 hit resumes the scan from page 11.
            const continueScan = vi.fn(async (cursor: { url: string }) => pages[cursor.url]);
            const later = await details.getOrFetch(
                KEY,
                async () => capped(),
                SERVE,
                {},
                undefined,
                {
                    continueScan,
                    isCurrent: () => true,
                    onUpdate: (served) => posts.push(served),
                },
            );
            expect(later.runs[0].failedScan).toEqual({ state: "running", found: 0 });
            await vi.waitFor(() =>
                expect(
                    continueScan,
                    "an L1 hit restarts the scan its stale requester left",
                ).toHaveBeenCalledTimes(2),
            );
            expect(continueScan.mock.calls.map(([cursor]) => cursor.url)).toEqual([
                "page-11",
                "page-12",
            ]);
            await vi.waitFor(() => expect(posts.at(-1)?.runs[0].failedScan?.state).toBe("done"));
            expect(posts.at(-1)?.runs[0].jobs.map((job) => job.id)).toEqual([
                "job 1",
                "job 1050",
                "job 1900",
            ]);
        });

        it("a run re-run before every overflow page stops its scan without a refetch, and Refresh scans from scratch", async () => {
            const { service: details } = service();
            const posts: CommitCiDetail[] = [];
            const fetchDetail = vi.fn(async () => capped());
            const changed = "Remote data changed. Reload and try again.";
            let rerun = true;
            let checks = 0;
            const scan = {
                // Re-run before each page; the cap only ends an unbounded restart loop.
                continueScan: vi.fn(
                    async (cursor: CiFailedScanCursor): Promise<CiFailedScanPage> =>
                        rerun && ++checks <= 5
                            ? { runChanged: true, error: changed }
                            : pages[cursor.url],
                ),
                isCurrent: () => true,
                onUpdate: (served: CommitCiDetail) => posts.push(served),
            };
            await details.getOrFetch(KEY, fetchDetail, SERVE, {}, undefined, scan);
            await vi.waitFor(() => expect(scan.continueScan).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(fetchDetail, "no read restarts without bound").toHaveBeenCalledTimes(1);
            expect(posts.at(-1)?.runs[0].failedScan).toEqual({
                state: "stopped",
                found: 0,
                error: changed,
            });
            expect(posts.at(-1)?.complete, "a changed run's scan leaves it incomplete").toBe(false);

            rerun = false;
            scan.continueScan.mockClear();
            await details.getOrFetch(KEY, fetchDetail, SERVE, { force: true }, undefined, scan);
            await vi.waitFor(() => expect(posts.at(-1)?.runs[0].failedScan?.state).toBe("done"));
            expect(scan.continueScan.mock.calls.map(([cursor]) => cursor.url)).toEqual([
                "page-11",
                "page-12",
            ]);
            expect(posts.at(-1)?.complete).toBe(true);
        });
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
