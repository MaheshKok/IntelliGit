// Re-run failed, re-run job and cancel run (PLAN.md §6, K30, journey 6): the action fence is
// written and awaited before the one POST, a definite failure deletes it, `ok` or `uncertain`
// keeps it and drops the commit from every cache before a forced fetch, and the fence's stored
// evidence rule decides when a fetched result shows the action took effect.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type { CiJob, CiRun, CommitChecksSnapshot, CommitCiDetailData } from "../../../../src/types";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("vscode", () => ({
    authentication: { getSession: mocks.getSession },
    l10n: {
        t: (message: string, args?: Record<string, string | number | boolean>) =>
            interpolateL10n(message, args),
    },
}));

import {
    ACTION_FENCE_KEY_PREFIX,
    ACTION_FENCE_NOT_SEEN_MS,
    CiActionFenceStore,
} from "../../../../src/services/commitChecks/ciActionFence";
import { refreshCiDetail, runCiAction } from "../../../../src/services/commitChecks/ciActions";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import { CommitCiDetailService } from "../../../../src/services/commitChecks/detailService";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import { HttpError, type WriteJson } from "../../../../src/services/commitChecks/http";
import {
    CommitChecksPersistentCache,
    type CommitChecksPersistentState,
} from "../../../../src/services/commitChecks/persistentCache";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import type { CommitChecksProvider } from "../../../../src/services/commitChecks/types";
import type { GitOps } from "../../../../src/git/operations";

const HASH = "a".repeat(40);
const REPO = "/repo";
const GITHUB_API = "https://api.github.com/repos/octo/app";
const GITLAB_API = "https://gitlab.com/api/v4/projects/group%2Fapp";
const EN = JSON.parse(
    readFileSync(join(__dirname, "../../../../src/webviews/i18n/en.json"), "utf8"),
) as Record<string, string>;

type Memento = CommitChecksPersistentState & {
    values: Map<string, unknown>;
    keys(): readonly string[];
};

function memento(onWrite?: (key: string) => void): Memento {
    const values = new Map<string, unknown>();
    return {
        values,
        get: vi.fn((key: string) => values.get(key)),
        keys: vi.fn(() => [...values.keys()]),
        update: vi.fn(async (key: string, value: unknown) => {
            onWrite?.(key);
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }),
    };
}

function storedFences(state: Memento): unknown[] {
    return [...state.values]
        .filter(([key]) => key.startsWith(ACTION_FENCE_KEY_PREFIX))
        .map(([, value]) => value);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function job(overrides: Partial<CiJob> = {}): CiJob {
    return {
        id: "5001",
        logicalId: "ci\0test",
        checkRunId: "9001",
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
        name: "CI",
        state: "failure",
        attempt: 1,
        jobs: [job()],
        jobsCoverage: "full",
        ...overrides,
    };
}

function detail(
    provider: "github" | "gitlab",
    runs: CiRun[],
    overrides: Partial<CommitCiDetailData> = {},
): CommitCiDetailData {
    const complete = runs.every((r) => r.state !== "queued" && r.state !== "running");
    const failed = runs.some((r) => r.state === "failure");
    return {
        hash: HASH,
        provider,
        complete,
        outcome: complete ? (failed ? "failure" : "success") : "pending",
        runs,
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        ...overrides,
    };
}

const GITHUB_FAILED = detail("github", [run()]);
const GITHUB_RUNNING = detail("github", [
    run({ state: "running", jobs: [job({ state: "running" })] }),
]);
const GITHUB_RERUN_STARTED = detail("github", [
    run({ attempt: 2, state: "queued", jobs: [job({ state: "queued" })] }),
]);
const GITLAB_FAILED = detail("gitlab", [
    run({
        id: "300",
        attempt: undefined,
        jobs: [
            job({ id: "401", logicalId: "pipe\0test", checkRunId: undefined }),
            job({
                id: "402",
                logicalId: "pipe\0lint",
                name: "lint",
                checkRunId: undefined,
                state: "success",
            }),
        ],
    }),
]);
const GITLAB_RETRY_FINISHED = detail("gitlab", [
    run({
        id: "300",
        attempt: undefined,
        state: "success",
        jobs: [
            job({ id: "401", logicalId: "pipe\0test", checkRunId: undefined }),
            job({
                id: "402",
                logicalId: "pipe\0lint",
                name: "lint",
                checkRunId: undefined,
                state: "success",
            }),
            job({ id: "410", logicalId: "pipe\0test", checkRunId: undefined, state: "success" }),
        ],
    }),
]);

function snapshotOf(data: CommitCiDetailData): CommitChecksSnapshot {
    return { hash: data.hash, state: data.outcome, summary: data.outcome, items: [] };
}

interface Served {
    /** What the provider's next detail fetch returns. */
    current: CommitCiDetailData;
    /** Set to hold the next detail fetch until resolved with what it returns. */
    hold?: Promise<CommitCiDetailData>;
}

/** The provider with its reads answered from `served`; its write path stays real. */
function serve<P extends GitHubProvider | GitLabProvider>(provider: P, served: Served): P {
    provider.getDetail = vi.fn(async () => {
        const held = served.hold;
        served.hold = undefined;
        return held ? await held : served.current;
    });
    provider.getChecks = vi.fn(async () => snapshotOf(served.current));
    return provider;
}

interface WriteCall {
    method: string;
    url: string;
}

function recordingWrite(
    calls: WriteCall[],
    answer: () => Promise<unknown> = async () => ({}),
): WriteJson {
    return vi.fn(async (method: string, url: string) => {
        calls.push({ method, url });
        return answer();
    });
}

function github(served: Served, write: WriteJson, cooldownEnd: () => number = () => 0) {
    return serve(
        new GitHubProvider(vi.fn(), undefined, vi.fn(), cooldownEnd, undefined, undefined, write),
        served,
    );
}

function gitlab(served: Served, write: WriteJson, cooldownEnd: () => number = () => 0) {
    const store = { get: vi.fn(async () => "glpat-token") } as unknown as CredentialStore;
    return serve(
        new GitLabProvider(
            vi.fn(),
            store,
            undefined,
            vi.fn(),
            cooldownEnd,
            undefined,
            undefined,
            write,
        ),
        served,
    );
}

const REMOTES: Record<string, string> = {
    github: "https://github.com/octo/app.git",
    gitlab: "https://gitlab.com/group/app.git",
};

/** One window: fence store, both caches over the given storage, and a coordinator. */
function windowOver(
    provider: CommitChecksProvider,
    storage: { workspace?: Memento; global?: Memento; now?: () => number } = {},
) {
    const workspace = storage.workspace ?? memento();
    const global = storage.global ?? memento();
    const fences = new CiActionFenceStore(workspace, { now: storage.now });
    const service = new CommitChecksService({
        persistentCache: new CommitChecksPersistentCache(global, { fence: fences }),
        fences,
    });
    const detailService = new CommitCiDetailService({
        persistentCache: new CiDetailPersistentCache(global, { fence: fences }),
        fences,
    });
    const generations = new CiGenerations();
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => REMOTES[provider.id]),
    } as unknown as GitOps;
    const coordinator = new CommitChecksCoordinator(
        gitOps,
        [provider],
        {},
        {
            service,
            detailService,
            generations,
        },
    );
    const ctx = generations.capture(REPO);
    windows.push(fences);
    return {
        workspace,
        global,
        fences,
        coordinator,
        generations,
        ctx,
        deps: { coordinator, fences },
    };
}

const windows: CiActionFenceStore[] = [];

beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue({ accessToken: "gho_token", account: { id: "42" } });
});

afterEach(() => {
    for (const fences of windows.splice(0)) fences.dispose();
});

describe("CI write actions", () => {
    it("GitHub endpoints per action", async () => {
        const cases = [
            ["rerunFailed", GITHUB_FAILED, `${GITHUB_API}/actions/runs/77/rerun-failed-jobs`],
            ["cancel", GITHUB_RUNNING, `${GITHUB_API}/actions/runs/77/cancel`],
            ["rerunJob", GITHUB_FAILED, `${GITHUB_API}/actions/jobs/5001/rerun`],
        ] as const;
        for (const [action, current, url] of cases) {
            const calls: WriteCall[] = [];
            const { deps, ctx } = windowOver(github({ current }, recordingWrite(calls)));
            const outcome = await runCiAction(
                deps,
                HASH,
                { action, runId: "77", ...(action === "rerunJob" ? { jobId: "5001" } : {}) },
                ctx,
            );
            expect(outcome, action).toEqual({ outcome: "ok" });
            expect(calls, action).toEqual([{ method: "POST", url }]);
        }
    });

    it("GitLab endpoints per action", async () => {
        const cases = [
            ["rerunFailed", `${GITLAB_API}/pipelines/300/retry`],
            ["cancel", `${GITLAB_API}/pipelines/300/cancel`],
            ["rerunJob", `${GITLAB_API}/jobs/401/retry`],
        ] as const;
        for (const [action, url] of cases) {
            const calls: WriteCall[] = [];
            const { deps, ctx } = windowOver(
                gitlab({ current: GITLAB_FAILED }, recordingWrite(calls)),
            );
            await runCiAction(
                deps,
                HASH,
                { action, runId: "300", ...(action === "rerunJob" ? { jobId: "401" } : {}) },
                ctx,
            );
            expect(calls, action).toEqual([{ method: "POST", url }]);
        }
    });

    it("rerun job uses the Actions job id", async () => {
        const calls: WriteCall[] = [];
        const { deps, ctx } = windowOver(github({ current: GITHUB_FAILED }, recordingWrite(calls)));

        await runCiAction(deps, HASH, { action: "rerunJob", runId: "77", jobId: "5001" }, ctx);

        expect(calls.map((call) => call.url)).toEqual([`${GITHUB_API}/actions/jobs/5001/rerun`]);
        expect(calls[0]!.url).not.toContain("9001");
    });

    it("fence written before the POST", async () => {
        const order: string[] = [];
        const workspace = memento((key) => order.push(`write ${key.slice(0, 26)}`));
        const write = vi.fn(async () => {
            order.push("POST");
            return {};
        });
        const { deps, ctx } = windowOver(github({ current: GITHUB_FAILED }, write), { workspace });

        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(order[0]).toBe(`write ${ACTION_FENCE_KEY_PREFIX.slice(0, 26)}`);
        expect(order.indexOf("POST")).toBeGreaterThan(0);
        // The fence the POST relied on was stored with the provider's evidence rule.
        expect(storedFences(workspace)).toEqual([
            expect.objectContaining({
                action: "rerunFailed",
                targetId: "77",
                runId: "77",
                evidence: "runAttempt",
                before: { attempt: 1, state: "failure" },
            }),
        ]);
    });

    it("sign-out while the fence is written sends nothing and clears the fence", async () => {
        const calls: WriteCall[] = [];
        let signOut = (): void => {};
        const workspace = memento(() => signOut());
        const { deps, ctx, fences, generations } = windowOver(
            github({ current: GITHUB_FAILED }, recordingWrite(calls)),
            { workspace },
        );
        signOut = () => generations.bumpAuth();

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(calls, "stale authorization must not send a write").toEqual([]);
        expect(outcome).toEqual({
            outcome: "failed",
            message: "Remote data changed. Reload and try again.",
        });
        expect(fences.isFenced(HASH), "the fence is cleared").toBe(false);
        expect(storedFences(workspace)).toEqual([]);
    });

    it("GitLab 403 maps to forbidden with scope help", async () => {
        const write = vi.fn(async () => {
            throw new HttpError(403, "HTTP 403: insufficient_scope", {});
        });
        const provider = gitlab({ current: GITLAB_FAILED }, write);
        const { deps, ctx } = windowOver(provider);

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "300" }, ctx);

        expect(outcome).toEqual({ outcome: "forbidden" });
        // The plan's `api` code span is plain text here: the webview shows backticks literally.
        expect(EN[provider.capabilities.writeScopeHelp!]).toBe(
            "Your GitLab token is read-only. Create one with the api scope to re-run or cancel.",
        );
    });

    it("forbidden removes the fence", async () => {
        const write = vi.fn(async () => {
            throw new HttpError(403, "HTTP 403: Resource not accessible by integration", {});
        });
        const { deps, ctx, fences, workspace } = windowOver(
            github({ current: GITHUB_FAILED }, write),
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({ outcome: "forbidden" });
        expect(fences.isFenced(HASH)).toBe(false);
        expect(storedFences(workspace)).toEqual([]);
    });

    it("401 removes the fence and asks to sign in again", async () => {
        const write = vi.fn(async () => {
            throw new HttpError(401, "HTTP 401: Bad credentials", {});
        });
        const { deps, ctx, fences } = windowOver(github({ current: GITHUB_FAILED }, write));

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({
            outcome: "failed",
            message: "Sign in to github.com to view commit checks.",
        });
        expect(fences.isFenced(HASH)).toBe(false);
    });

    it("another HTTP error fails and removes the fence", async () => {
        const write = vi.fn(async () => {
            throw new HttpError(422, "HTTP 422: run is not re-runnable", {});
        });
        const { deps, ctx, fences } = windowOver(github({ current: GITHUB_FAILED }, write));

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({ outcome: "failed", message: "HTTP 422: run is not re-runnable" });
        expect(fences.isFenced(HASH)).toBe(false);
    });

    it("uncertain keeps the fence and invalidates", async () => {
        const order: string[] = [];
        const write = vi.fn(async () => {
            throw new Error("socket hang up");
        });
        const provider = github({ current: GITHUB_FAILED }, write);
        const { deps, ctx, fences, coordinator } = windowOver(provider);
        await coordinator.getDetail(HASH, {}, ctx);
        const invalidate = vi.spyOn(coordinator, "invalidate").mockImplementation(async (hash) => {
            order.push("invalidate");
            await CommitChecksCoordinator.prototype.invalidate.call(coordinator, hash);
        });
        vi.mocked(provider.getDetail).mockImplementation(async () => {
            order.push("fetch");
            return GITHUB_FAILED;
        });

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({ outcome: "uncertain" });
        expect(invalidate).toHaveBeenCalledWith(HASH);
        expect(order).toEqual(["invalidate", "fetch"]);
        expect(fences.fenceFor(REPO, HASH)).toEqual({
            targetId: "77",
            action: "rerunFailed",
            notSeen: false,
        });
    });

    it("re-run on a cached failed commit never shows the old result again", async () => {
        const served: Served = { current: GITHUB_FAILED };
        const provider = github(served, recordingWrite([]));
        const { deps, ctx, coordinator, global, workspace } = windowOver(provider);
        // The failed result sits in L1 and in storage.
        await coordinator.getDetail(HASH, {}, ctx);
        // A forced read started before the click is still in flight with the old answer.
        const slow = deferred<CommitCiDetailData>();
        served.hold = slow.promise;
        const preAction = coordinator.getDetail(HASH, { force: true }, ctx);
        await vi.waitFor(() => expect(provider.getDetail).toHaveBeenCalledTimes(2));
        served.current = GITHUB_RERUN_STARTED;

        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);
        slow.resolve(GITHUB_FAILED);
        await preAction;

        const shown = await coordinator.getDetail(HASH, {}, ctx);
        expect(shown.runs[0]).toMatchObject({ attempt: 2, state: "queued" });
        // Nor after a restart: nothing saved still holds the failed attempt.
        const restarted = windowOver(github({ current: GITHUB_RERUN_STARTED }, vi.fn()), {
            global,
            workspace,
        });
        const reread = await restarted.coordinator.getDetail(HASH, {}, restarted.ctx);
        expect(reread.runs[0]).toMatchObject({ attempt: 2 });
    });

    it("restart while waiting shows waiting, never the old failure", async () => {
        const provider = github({ current: GITHUB_FAILED }, recordingWrite([]));
        const { deps, ctx, coordinator, global, workspace } = windowOver(provider);
        await coordinator.getDetail(HASH, {}, ctx);
        // The provider has not shown the new attempt yet.
        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        // Restart: new stores and a new coordinator over the same storage.
        const lagging = github({ current: GITHUB_FAILED }, vi.fn());
        const restarted = windowOver(lagging, { global, workspace });
        const shown = await restarted.coordinator.getDetail(HASH, {}, restarted.ctx);

        expect(shown.actionFence).toEqual({
            targetId: "77",
            action: "rerunFailed",
            notSeen: false,
        });
        // Read from the provider, not served from storage as a final answer.
        expect(lagging.getDetail).toHaveBeenCalledTimes(1);
    });

    it("no POST without runCiAction", async () => {
        const calls: WriteCall[] = [];
        const forbidden = recordingWrite(calls, async () => {
            throw new HttpError(403, "HTTP 403: forbidden", {});
        });
        const { deps, ctx, coordinator } = windowOver(
            github({ current: GITHUB_FAILED }, forbidden),
        );

        await coordinator.getDetail(HASH, {}, ctx);
        await coordinator.getDetail(HASH, { force: true }, ctx);
        await coordinator.getChecks(HASH, { force: true });
        await refreshCiDetail(deps, HASH, ctx);
        expect(calls).toEqual([]);

        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);
        // A refused action is never sent again on its own.
        await new Promise((done) => setTimeout(done, 0));
        expect(calls).toHaveLength(1);
    });

    it("cooldown sends nothing and writes no fence", async () => {
        const calls: WriteCall[] = [];
        const workspace = memento();
        const until = Date.now() + 60_000;
        const { deps, ctx, fences } = windowOver(
            github({ current: GITHUB_FAILED }, recordingWrite(calls), () => until),
            { workspace },
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({
            outcome: "failed",
            message: "Commit-check requests are temporarily paused due to rate limiting.",
        });
        expect(calls).toEqual([]);
        expect(workspace.update).not.toHaveBeenCalled();
        expect(fences.isFenced(HASH)).toBe(false);
    });

    it("GitLab retry finishing before the next poll resolves the fence", async () => {
        const served: Served = { current: GITLAB_FAILED };
        const provider = gitlab(served, async () => {
            // The retried job ran and finished before the first fetch after the POST.
            served.current = GITLAB_RETRY_FINISHED;
            return {};
        });
        const { deps, ctx, fences, workspace } = windowOver(provider);

        const outcome = await runCiAction(
            deps,
            HASH,
            { action: "rerunJob", runId: "300", jobId: "401" },
            ctx,
        );

        expect(outcome).toEqual({ outcome: "ok" });
        expect(fences.isFenced(HASH)).toBe(false);
        await vi.waitFor(() => expect(storedFences(workspace)).toEqual([]));
    });

    it("GitHub re-run job is resolved by the run attempt, not the old job id", async () => {
        const served: Served = { current: GITHUB_FAILED };
        const provider = github(served, async () => {
            // The new attempt reuses the job's id in this read; only the run attempt moved.
            served.current = detail("github", [
                run({ attempt: 2, state: "queued", jobs: [job({ state: "queued" })] }),
            ]);
            return {};
        });
        const { deps, ctx, fences } = windowOver(provider);

        await runCiAction(deps, HASH, { action: "rerunJob", runId: "77", jobId: "5001" }, ctx);

        expect(fences.isFenced(HASH)).toBe(false);
    });

    it("Refresh on a not-seen target ends the fence and caches the fetched result", async () => {
        let now = 1_000_000;
        const provider = github({ current: GITHUB_FAILED }, recordingWrite([]));
        const { deps, ctx, fences, coordinator, global, workspace } = windowOver(provider, {
            now: () => now,
        });
        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);
        now += ACTION_FENCE_NOT_SEEN_MS;
        expect(fences.fenceFor(REPO, HASH)?.notSeen).toBe(true);

        const refreshed = await refreshCiDetail(deps, HASH, ctx);

        expect(refreshed?.actionFence).toBeUndefined();
        expect(fences.isFenced(HASH)).toBe(false);
        // The fetched result is cached by the normal rules: served from L1, and saved.
        const fetches = vi.mocked(provider.getDetail).mock.calls.length;
        await coordinator.getDetail(HASH, {}, ctx);
        expect(provider.getDetail).toHaveBeenCalledTimes(fetches);
        await vi.waitFor(() => expect(storedFences(workspace)).toEqual([]));
        const restarted = github({ current: GITHUB_RERUN_STARTED }, vi.fn());
        const reopened = windowOver(restarted, { global, workspace });
        const saved = await reopened.coordinator.getDetail(HASH, {}, reopened.ctx);
        expect(saved.runs[0]).toMatchObject({ attempt: 1, state: "failure" });
        expect(restarted.getDetail).not.toHaveBeenCalled();
    });

    it("Refresh before not-seen keeps the fence", async () => {
        const provider = github({ current: GITHUB_FAILED }, recordingWrite([]));
        const { deps, ctx, fences } = windowOver(provider);
        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        const refreshed = await refreshCiDetail(deps, HASH, ctx);

        expect(refreshed?.actionFence).toEqual({
            targetId: "77",
            action: "rerunFailed",
            notSeen: false,
        });
        expect(fences.isFenced(HASH)).toBe(true);
    });

    it("a new service after a failed fenced delete never serves the old failure", async () => {
        let failWrites = false;
        const global = memento();
        const realUpdate = global.update;
        global.update = vi.fn(async (key: string, value: unknown) => {
            if (failWrites) throw new Error("disk full");
            return realUpdate(key, value);
        });
        const workspace = memento();
        const served: Served = { current: GITHUB_FAILED };
        const { deps, ctx, coordinator } = windowOver(github(served, recordingWrite([])), {
            global,
            workspace,
        });
        await coordinator.getDetail(HASH, {}, ctx);
        // From here every removal of the stored failure fails, the fence end's included.
        failWrites = true;
        served.current = GITHUB_RERUN_STARTED;

        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        // Restart over the same storage; the provider lags behind and still shows the old attempt.
        const lagging = github({ current: GITHUB_FAILED }, vi.fn());
        const restarted = windowOver(lagging, { global, workspace });
        const shown = await restarted.coordinator.getDetail(HASH, {}, restarted.ctx);

        expect(lagging.getDetail).toHaveBeenCalledTimes(1);
        expect(shown.actionFence).toEqual({
            targetId: "77",
            action: "rerunFailed",
            notSeen: false,
        });
    });
});
