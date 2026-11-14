// Re-run failed, re-run job and cancel run (PLAN.md §6, K30, journey 6): the action fence is
// written and awaited before the one POST, a definite failure deletes it, `ok` or `uncertain`
// keeps it and drops the commit from every cache before a forced fetch, and the fence's stored
// evidence rule decides when a fetched result shows the action took effect.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as https from "https";
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
// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

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
import {
    HttpError,
    httpRequestJson,
    RequestNotSentError,
    type WriteJson,
} from "../../../../src/services/commitChecks/http";
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

/**
 * Makes `https.request` fail with `code` on its own socket: fresh and never connected, or
 * reused from the keep-alive pool.
 */
function failingTransport(code: string, reused: boolean): void {
    vi.mocked(https.request).mockImplementation((() => {
        const req = Object.assign(new EventEmitter(), {
            reusedSocket: reused,
            setTimeout: vi.fn(),
            destroy: vi.fn(),
            end: vi.fn(() => {
                req.emit("socket", Object.assign(new EventEmitter(), { connecting: !reused }));
                queueMicrotask(() =>
                    req.emit(
                        "error",
                        Object.assign(new Error(`connect ${code}`), { code, syscall: "connect" }),
                    ),
                );
            }),
        });
        return req;
    }) as unknown as typeof https.request);
}

/** Makes `https.request` answer with `statusCode`, then cut the body off before it ends. */
function cutOffTransport(statusCode: number): void {
    vi.mocked(https.request).mockImplementation(((
        _url: string,
        _options: unknown,
        onAnswer: (res: unknown) => void,
    ) => {
        const req = Object.assign(new EventEmitter(), {
            setTimeout: vi.fn(),
            destroy: vi.fn(),
            end: vi.fn(() => {
                const res = Object.assign(new EventEmitter(), { statusCode, headers: {} });
                onAnswer(res);
                queueMicrotask(() => {
                    res.emit("data", Buffer.from('{"message":"Resource not acc'));
                    res.emit("close");
                });
            }),
        });
        return req;
    }) as unknown as typeof https.request);
}

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

/** `write` behind an always-open gate: the fence and its checks, then the request. */
function admitted(write: WriteJson): WriteJson {
    return async (method, url, headers, body, beforeSend) => {
        await beforeSend?.();
        return write(method, url, headers, body);
    };
}

function github(served: Served, write: WriteJson, cooldownEnd: () => number = () => 0) {
    return serve(
        new GitHubProvider(
            vi.fn(),
            undefined,
            vi.fn(),
            cooldownEnd,
            undefined,
            undefined,
            admitted(write),
        ),
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
            admitted(write),
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

    const SENT_TO = [
        { name: "GitHub", make: github, served: GITHUB_FAILED, runId: "77" },
        { name: "GitLab", make: gitlab, served: GITLAB_FAILED, runId: "300" },
    ] as const;

    it.each(SENT_TO)(
        "a 403 whose body times out still removes the fence on $name",
        async (target) => {
            vi.mocked(https.request).mockImplementation(((
                _url: string,
                _options: unknown,
                onAnswer: (res: unknown) => void,
            ) => {
                let timeout: (() => void) | undefined;
                const req = Object.assign(new EventEmitter(), {
                    setTimeout: vi.fn((_ms: number, callback?: () => void) => {
                        if (callback) timeout = callback;
                    }),
                    destroy: vi.fn((error: Error) => req.emit("error", error)),
                    end: vi.fn(() => {
                        req.emit(
                            "socket",
                            Object.assign(new EventEmitter(), { connecting: false }),
                        );
                        const res = Object.assign(new EventEmitter(), {
                            statusCode: 403,
                            headers: {},
                        });
                        onAnswer(res);
                        // The idle timeout fires mid-body: the request errors before the response does.
                        queueMicrotask(() => {
                            timeout?.();
                            res.emit("error", new Error("aborted"));
                            res.emit("close");
                        });
                    }),
                });
                return req;
            }) as unknown as typeof https.request);
            const { deps, ctx, fences } = windowOver(
                target.make({ current: target.served }, httpRequestJson),
            );

            const outcome = await runCiAction(
                deps,
                HASH,
                { action: "rerunFailed", runId: target.runId },
                ctx,
            );

            expect(
                { outcome: outcome.outcome, fenced: fences.isFenced(HASH) },
                "a received 403 is a refusal even if its body times out",
            ).toEqual({ outcome: "forbidden", fenced: false });
        },
    );

    it("a 5xx after the request was sent is uncertain: the fence stays and the detail is fetched again", async () => {
        for (const target of SENT_TO) {
            for (const status of [500, 502, 503, 504]) {
                const write = vi.fn(async () => {
                    throw new HttpError(status, `HTTP ${status}: upstream error`, {});
                });
                const provider = target.make({ current: target.served }, write);
                const { deps, ctx, fences, coordinator } = windowOver(provider);
                const invalidate = vi.spyOn(coordinator, "invalidate");

                const outcome = await runCiAction(
                    deps,
                    HASH,
                    { action: "rerunFailed", runId: target.runId },
                    ctx,
                );

                expect(
                    {
                        outcome,
                        fenced: fences.isFenced(HASH),
                        invalidated: invalidate.mock.calls.length,
                        fetches: vi.mocked(provider.getDetail).mock.calls.length,
                    },
                    `${target.name} ${status}: the server may have started the action before failing`,
                ).toEqual({
                    outcome: { outcome: "uncertain" },
                    fenced: true,
                    invalidated: 1,
                    fetches: 2,
                });
                expect(write, "an unknown outcome is never retried").toHaveBeenCalledTimes(1);
            }
        }
    });

    it("a redirect or other 4xx after the request was sent is still a definite failure and removes the fence", async () => {
        // A POST that is redirected was not run, so a 3xx is as definite as a 4xx.
        for (const [target, status] of SENT_TO.flatMap((t) =>
            [302, 404, 499].map((s) => [t, s] as const),
        )) {
            const write = vi.fn(async () => {
                throw new HttpError(status, `HTTP ${status}`, {});
            });
            const { deps, ctx, fences, workspace } = windowOver(
                target.make({ current: target.served }, write),
            );

            const outcome = await runCiAction(
                deps,
                HASH,
                { action: "rerunFailed", runId: target.runId },
                ctx,
            );

            expect(
                { outcome: outcome.outcome, fenced: fences.isFenced(HASH) },
                `${target.name} ${status} is a definite refusal`,
            ).toEqual({ outcome: "failed", fenced: false });
            expect(storedFences(workspace)).toEqual([]);
        }
    });

    it("401 removes the fence, rereads the detail and enters the sign-in state", async () => {
        const write = vi.fn(async () => {
            throw new HttpError(401, "HTTP 401: Bad credentials", {});
        });
        const provider = github({ current: GITHUB_FAILED }, write);
        const { deps, ctx, fences, coordinator } = windowOver(provider);
        const invalidate = vi.spyOn(coordinator, "invalidate");

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({
            outcome: "signedOut",
            message: "Sign in to github.com to view commit checks.",
        });
        expect(fences.isFenced(HASH)).toBe(false);
        expect(
            invalidate,
            "the cached tree is dropped so the sign-in state is read",
        ).toHaveBeenCalledWith(HASH);
        expect(
            provider.getDetail,
            "the detail is fetched again, once more than the start",
        ).toHaveBeenCalledTimes(2);
        expect(write, "a rejected credential is never retried").toHaveBeenCalledTimes(1);
    });

    it("signed out before the fence is the same sign-in outcome and sends nothing", async () => {
        const calls: WriteCall[] = [];
        mocks.getSession.mockResolvedValue(undefined);
        const { deps, ctx, workspace } = windowOver(
            github({ current: GITHUB_FAILED }, recordingWrite(calls)),
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toMatchObject({ outcome: "signedOut" });
        expect(calls).toEqual([]);
        expect(storedFences(workspace)).toEqual([]);
    });

    it("a request the transport never created removes the fence and is a definite failure", async () => {
        const write = vi.fn(async () => {
            throw new RequestNotSentError('Invalid character in header content ["Authorization"]');
        });
        const { deps, ctx, fences, workspace } = windowOver(
            github({ current: GITHUB_FAILED }, write),
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome, "a request that was never created is a definite failure").toEqual({
            outcome: "failed",
            message: 'Invalid character in header content ["Authorization"]',
        });
        expect(fences.isFenced(HASH)).toBe(false);
        expect(storedFences(workspace)).toEqual([]);
    });

    it("a real transport that never connected is a definite failure and removes the fence", async () => {
        for (const code of ["ENETUNREACH", "EPERM"]) {
            failingTransport(code, false);
            const { deps, ctx, fences } = windowOver(
                github({ current: GITHUB_FAILED }, httpRequestJson),
            );

            const outcome = await runCiAction(
                deps,
                HASH,
                { action: "rerunFailed", runId: "77" },
                ctx,
            );

            expect(
                { outcome: outcome.outcome, fenced: fences.isFenced(HASH) },
                `${code} before the socket connected sent nothing`,
            ).toEqual({ outcome: "failed", fenced: false });
        }
    });

    it("a real transport reset on a reused socket stays uncertain and keeps the fence", async () => {
        failingTransport("ECONNRESET", true);
        const { deps, ctx, fences } = windowOver(
            github({ current: GITHUB_FAILED }, httpRequestJson),
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(
            { outcome: outcome.outcome, fenced: fences.isFenced(HASH) },
            "a reused keep-alive socket may have carried the POST",
        ).toEqual({ outcome: "uncertain", fenced: true });
    });

    it("a real transport whose 403 body is cut off is forbidden and removes the fence", async () => {
        cutOffTransport(403);
        const { deps, ctx, fences } = windowOver(
            github({ current: GITHUB_FAILED }, httpRequestJson),
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(
            { outcome: outcome.outcome, fenced: fences.isFenced(HASH) },
            "the 403 status line decided the outcome before the body was cut off",
        ).toEqual({ outcome: "forbidden", fenced: false });
    });

    it("a real transport whose 503 body is cut off stays uncertain and keeps the fence", async () => {
        cutOffTransport(503);
        const { deps, ctx, fences } = windowOver(
            github({ current: GITHUB_FAILED }, httpRequestJson),
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(
            { outcome: outcome.outcome, fenced: fences.isFenced(HASH) },
            "a cut-off 503 is the same unknown outcome as a whole 503",
        ).toEqual({ outcome: "uncertain", fenced: true });
    });

    it("a write the gate dropped because the sign-in changed shows stale data and removes the fence", async () => {
        const write = vi.fn(async () => {
            throw new RequestNotSentError("credentials changed", true);
        });
        const { deps, ctx, fences } = windowOver(github({ current: GITHUB_FAILED }, write));

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({
            outcome: "failed",
            message: "Remote data changed. Reload and try again.",
        });
        expect(fences.isFenced(HASH)).toBe(false);
    });

    it("switching repository during the fence write sends nothing and removes the fence", async () => {
        const calls: WriteCall[] = [];
        let shown = REPO;
        const workspace = memento(() => {
            shown = "/other";
        });
        const { deps, ctx, fences } = windowOver(
            github({ current: GITHUB_FAILED }, recordingWrite(calls)),
            { workspace },
        );

        const outcome = await runCiAction(
            deps,
            HASH,
            { action: "rerunFailed", runId: "77" },
            ctx,
            () => shown,
        );

        expect(calls, "switching repository before the POST must send nothing").toEqual([]);
        expect(outcome).toEqual({
            outcome: "failed",
            message: "Remote data changed. Reload and try again.",
        });
        expect(fences.isFenced(HASH)).toBe(false);
    });

    it("a provider resolution change during the fence write sends nothing", async () => {
        const calls: WriteCall[] = [];
        let change = (): void => {};
        const workspace = memento(() => change());
        const w = windowOver(github({ current: GITHUB_FAILED }, recordingWrite(calls)), {
            workspace,
        });
        change = () => w.coordinator.clearProviderResolution();

        await runCiAction(w.deps, HASH, { action: "rerunFailed", runId: "77" }, w.ctx);

        expect(calls, "the repository the write was resolved for is gone").toEqual([]);
        expect(w.fences.isFenced(HASH)).toBe(false);
    });

    it("a provider error that echoes the token never reaches the reply, and keeps its status", async () => {
        const cases = [
            {
                make: github,
                token: "gho_token",
                api: "github.com",
                runId: "77",
                current: GITHUB_FAILED,
            },
            {
                make: gitlab,
                token: "glpat-token",
                api: "gitlab.com",
                runId: "300",
                current: GITLAB_FAILED,
            },
        ] as const;
        for (const { make, token, runId, current } of cases) {
            const write = vi.fn(async () => {
                throw new HttpError(422, `HTTP 422: echoed ${token}`, { "x-trace": "1" });
            });
            const provider = make({ current }, write);
            const { deps, ctx } = windowOver(provider);

            const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId }, ctx);

            expect(JSON.stringify(outcome), `${token} must be redacted in the reply`).not.toContain(
                token,
            );
            expect(outcome).toEqual({ outcome: "failed", message: "HTTP 422: echoed ***" });
            const ref = (await deps.coordinator.actionTarget(HASH))!.ref;
            await expect(
                provider.runAction!(ref, { action: "cancel", runId }, async () => undefined),
                "the status stays on the error",
            ).rejects.toMatchObject({ statusCode: 422, headers: { "x-trace": "1" } });
        }
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
        // The first fetch is the fresh baseline read before the fence.
        expect(order).toEqual(["fetch", "invalidate", "fetch"]);
        expect(fences.fenceFor(REPO, HASH)).toEqual({
            targetId: "77",
            action: "rerunFailed",
            notSeen: false,
        });
    });

    it("re-run on a cached failed commit never shows the old result again", async () => {
        const served: Served = { current: GITHUB_FAILED };
        const slow = deferred<CommitCiDetailData>();
        let preAction: Promise<unknown> | undefined;
        const provider = github(
            served,
            recordingWrite([], async () => {
                // A forced read that started after the action read its baseline is still in
                // flight with the old answer when the POST goes out.
                served.hold = slow.promise;
                preAction = coordinator.getDetail(HASH, { force: true }, ctx);
                await vi.waitFor(() => expect(provider.getDetail).toHaveBeenCalledTimes(3));
                served.current = GITHUB_RERUN_STARTED;
                return {};
            }),
        );
        const { deps, ctx, coordinator, global, workspace } = windowOver(provider);
        // The failed result sits in L1 and in storage.
        await coordinator.getDetail(HASH, {}, ctx);

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

    it("the fence's baseline is read fresh, so a lagging read of an external re-run never ends it", async () => {
        const served: Served = { current: GITHUB_FAILED };
        const { deps, ctx, coordinator, fences, workspace } = windowOver(
            github(served, recordingWrite([])),
        );
        // Attempt 1 sits in the cache while someone else already re-ran the run as attempt 2.
        await coordinator.getDetail(HASH, {}, ctx);
        served.current = detail("github", [run({ attempt: 2 })]);

        await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);
        await coordinator.getDetail(HASH, { force: true }, ctx);

        expect(
            storedFences(workspace),
            "the fence records the attempt the provider shows at the click, not the cached one",
        ).toEqual([expect.objectContaining({ before: { attempt: 2, state: "failure" } })]);
        expect(
            fences.isFenced(HASH),
            "a later read still showing attempt 2 says nothing about the clicked re-run",
        ).toBe(true);
    });

    it("a failed fresh baseline read stops the action before any fence or write", async () => {
        const calls: WriteCall[] = [];
        const served: Served = { current: GITHUB_FAILED };
        const { deps, ctx, coordinator, workspace } = windowOver(
            github(served, recordingWrite(calls)),
        );
        await coordinator.getDetail(HASH, {}, ctx);
        // The forced read fails, so the service serves the cached copy with refreshError.
        served.current = {
            ...GITHUB_FAILED,
            outcome: "unavailable",
            error: "The host did not answer.",
        };

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(
            outcome,
            "the cached copy a failed read serves is never the fence's baseline",
        ).toEqual({
            outcome: "failed",
            message: "The host did not answer.",
        });
        expect(calls, "nothing is sent").toEqual([]);
        expect(storedFences(workspace), "no fence is written").toEqual([]);
    });

    it("a failed refresh with no error text still stops the action before any write", async () => {
        const calls: WriteCall[] = [];
        const served: Served = { current: GITHUB_FAILED };
        const { deps, ctx, coordinator, workspace } = windowOver(
            github(served, recordingWrite(calls)),
        );
        await coordinator.getDetail(HASH, {}, ctx);
        served.current = { ...GITHUB_FAILED, outcome: "unavailable" };

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome).toEqual({
            outcome: "failed",
            message: "Remote data changed. Reload and try again.",
        });
        expect(calls, "an empty refreshError still marks the cached copy as stale").toEqual([]);
        expect(storedFences(workspace)).toEqual([]);
    });

    it("a failed fresh read with nothing cached shows the provider's error and sends nothing", async () => {
        const calls: WriteCall[] = [];
        const { deps, ctx, workspace } = windowOver(
            github(
                {
                    current: {
                        ...GITHUB_FAILED,
                        outcome: "unavailable",
                        runs: [],
                        error: "The host did not answer.",
                    },
                },
                recordingWrite(calls),
            ),
        );

        const outcome = await runCiAction(deps, HASH, { action: "rerunFailed", runId: "77" }, ctx);

        expect(outcome, "the user sees why the read failed, not a stale-data message").toEqual({
            outcome: "failed",
            message: "The host did not answer.",
        });
        expect(calls).toEqual([]);
        expect(storedFences(workspace)).toEqual([]);
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
