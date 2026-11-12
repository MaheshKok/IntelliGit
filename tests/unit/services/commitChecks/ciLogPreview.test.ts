// Host side of the Checks tab log messages (PLAN.md §5, Phase 7): `previewCiLog` fills the
// window's log store and replies with the excerpt only; `openCiLog` loads (a hit after the
// preview) and opens the read-only document at the first error line.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    e2e: true,
    registerTextDocumentContentProvider: vi.fn(),
    openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
    showTextDocument: vi.fn(async () => undefined),
    withProgress: vi.fn(),
    cancel: undefined as (() => void) | undefined,
}));

vi.mock("../../../../src/e2e/activationState", () => ({
    isE2eControlChannelActive: () => mocks.e2e,
}));

vi.mock("vscode", () => ({
    workspace: {
        registerTextDocumentContentProvider: mocks.registerTextDocumentContentProvider,
        onDidCloseTextDocument: () => ({ dispose: vi.fn() }),
        openTextDocument: mocks.openTextDocument,
    },
    window: { showTextDocument: mocks.showTextDocument, withProgress: mocks.withProgress },
    ProgressLocation: { Notification: 15 },
    Range: class {
        constructor(
            readonly startLine: number,
            readonly startCharacter: number,
            readonly endLine: number,
            readonly endCharacter: number,
        ) {}
    },
    Uri: {
        from: (parts: { scheme: string; path: string; query: string }) => ({
            ...parts,
            toString: () => `${parts.scheme}:${parts.path}?${parts.query}`,
        }),
    },
    l10n: {
        t: (message: string, ...args: unknown[]) =>
            message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])),
    },
}));

import type * as vscode from "vscode";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import { registerCiLogDocumentProvider } from "../../../../src/services/commitChecks/ciLogDocument";
import {
    CiLogMemoryStore,
    ciLogKey,
    type CiLogSource,
} from "../../../../src/services/commitChecks/ciLogMemoryStore";
import { HttpError } from "../../../../src/services/commitChecks/http";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import type { CiJob, CommitCiDetail } from "../../../../src/types";
import type { CommitCiDetailSource } from "../../../../src/views/ciDetailHandler";
import { answerCiLogMessage } from "../../../../src/views/ciLogHandler";

const HASH = "a".repeat(40);
const KEY = ciLogKey("github:github.com:o/r", "5", "77", 1);
const LOG = ["setup", "build", "##[error]tests failed", "cleanup"].join("\n");
const SOURCE: CiLogSource = {
    repoKey: "/repo",
    provider: "github",
    runId: "5",
    jobId: "77",
    attempt: 1,
};

function job(state: CiJob["state"]): CiJob {
    return {
        id: "77",
        logicalId: "wf\0unit tests",
        name: "unit tests",
        checkName: "unit tests",
        state,
        attempt: 1,
        steps: [],
    };
}

function detail(state: CiJob["state"]): CommitCiDetail {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [
            {
                id: "5",
                name: "CI",
                state: "failure",
                attempt: 1,
                jobs: [job(state)],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: { ...NO_CI_CAPABILITIES, logs: true },
        repoKey: "/repo",
    };
}

function setup(
    state: CiJob["state"] = "failure",
    download = vi.fn(async () => ({ text: LOG, truncated: false })),
) {
    const store = new CiLogMemoryStore({
        download,
        errorRules: () => ({ patterns: [/##\[error\]/] }),
    });
    const source = SOURCE;
    const target = vi.fn(async () => ({ key: KEY, source }));
    const getDetail = vi.fn(async () => detail(state));
    const generations = new CiGenerations();
    const host: CommitCiDetailSource = {
        repoKey: () => "/repo",
        generations,
        getDetail,
        logs: { store, target },
    };
    const replies: Record<string, unknown>[] = [];
    const send = (type: "previewCiLog" | "openCiLog", requestId: number) =>
        answerCiLogMessage(
            host,
            {
                type,
                requestId,
                repoKey: "/repo",
                hash: HASH,
                runId: "5",
                jobId: "77",
                attempt: 1,
                ...(type === "previewCiLog" && { selectionToken: 9 }),
            },
            (reply) => replies.push(reply as unknown as Record<string, unknown>),
        );
    return { store, download, target, getDetail, generations, replies, send };
}

beforeEach(() => {
    mocks.e2e = true;
    mocks.registerTextDocumentContentProvider.mockReset();
    mocks.registerTextDocumentContentProvider.mockReturnValue({ dispose: vi.fn() });
    mocks.openTextDocument.mockClear();
    mocks.showTextDocument.mockClear();
    mocks.withProgress.mockReset();
    mocks.withProgress.mockImplementation(
        async (
            _options: unknown,
            task: (progress: unknown, token: unknown) => Promise<unknown>,
        ) => {
            const listeners: (() => void)[] = [];
            mocks.cancel = () => listeners.forEach((listener) => listener());
            return task(
                { report: vi.fn() },
                {
                    isCancellationRequested: false,
                    onCancellationRequested: (listener: () => void) => {
                        listeners.push(listener);
                        return { dispose: vi.fn() };
                    },
                },
            );
        },
    );
});

describe("Checks tab log messages", () => {
    it("preview opens no editor", async () => {
        const { replies, send, download } = setup();

        await send("previewCiLog", 1);

        expect(mocks.openTextDocument).not.toHaveBeenCalled();
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
        expect(download).toHaveBeenCalledTimes(1);
        expect(replies).toEqual([
            {
                type: "ciLogPreview",
                requestId: 1,
                repoKey: "/repo",
                hash: HASH,
                runId: "5",
                jobId: "77",
                selectionToken: 9,
                outcome: "ready",
                excerpt: LOG,
                truncated: false,
            },
        ]);
    });

    it("open after preview makes no second request", async () => {
        const { replies, send, download } = setup();

        await send("previewCiLog", 1);
        await send("openCiLog", 2);

        expect(download).toHaveBeenCalledTimes(1);
        expect(mocks.withProgress).toHaveBeenCalledTimes(1);
        expect(mocks.openTextDocument).toHaveBeenCalledTimes(1);
        const uri = mocks.openTextDocument.mock.calls[0]![0] as { path: string; query: string };
        expect(uri).toMatchObject({
            scheme: "intelligit-ci-log",
            path: "/unit-tests.log",
            query: `k=${KEY}`,
        });
        // Opened at the first error line, 0-based.
        expect(mocks.showTextDocument).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                selection: expect.objectContaining({ startLine: 2, endLine: 2 }),
            }),
        );
        expect(replies[1]).toEqual({
            type: "ciLogResult",
            requestId: 2,
            repoKey: "/repo",
            hash: HASH,
            outcome: "opened",
        });
    });

    it("running job gets outcome running and no request", async () => {
        for (const state of ["running", "queued"] as const) {
            const { replies, send, download, target } = setup(state);

            await send("previewCiLog", 1);
            await send("openCiLog", 2);

            expect(download, state).not.toHaveBeenCalled();
            expect(target, state).not.toHaveBeenCalled();
            expect(mocks.withProgress).not.toHaveBeenCalled();
            expect(replies.map((reply) => [reply.type, reply.outcome])).toEqual([
                ["ciLogPreview", "running"],
                ["ciLogResult", "running"],
            ]);
        }
    });

    it("a 403 is forbidden; other failures carry their message", async () => {
        const forbidden = setup(
            "failure",
            vi.fn(async () => {
                throw new HttpError(403, "HTTP 403", {});
            }),
        );
        await forbidden.send("previewCiLog", 1);
        await forbidden.send("openCiLog", 2);
        expect(forbidden.replies.map((reply) => reply.outcome)).toEqual(["forbidden", "forbidden"]);
        expect(mocks.openTextDocument).not.toHaveBeenCalled();

        const broken = setup(
            "failure",
            vi.fn(async () => {
                throw new Error("socket hang up");
            }),
        );
        await broken.send("previewCiLog", 1);
        expect(broken.replies[0]).toMatchObject({ outcome: "failed", message: "socket hang up" });
    });

    it("a rate-limit 403 is a failure with its message, not forbidden", async () => {
        const limited = setup(
            "failure",
            vi.fn(async () => {
                throw new HttpError(403, "API rate limit exceeded", {
                    "x-ratelimit-remaining": "0",
                });
            }),
        );
        await limited.send("previewCiLog", 1);
        await limited.send("openCiLog", 2);
        expect(
            limited.replies.map((reply) => reply.outcome),
            "signing in again cannot fix a quota",
        ).toEqual(["failed", "failed"]);
    });

    it("a secondary rate-limit 403 with Retry-After is failed, not forbidden", async () => {
        const limited = setup(
            "failure",
            vi.fn(async () => {
                throw new HttpError(403, "You have exceeded a secondary rate limit", {
                    "retry-after": "60",
                    "x-ratelimit-remaining": "4999",
                });
            }),
        );
        await limited.send("previewCiLog", 1);
        await limited.send("openCiLog", 2);
        expect(
            limited.replies.map((reply) => reply.outcome),
            "a retry-after cooldown is not a token permission error",
        ).toEqual(["failed", "failed"]);
    });

    it("an already cancelled progress token does not open a cached log", async () => {
        const { replies, send } = setup();
        await send("previewCiLog", 1);
        mocks.withProgress.mockImplementationOnce(
            async (
                _options: unknown,
                task: (progress: unknown, token: unknown) => Promise<unknown>,
            ) =>
                task(
                    { report: vi.fn() },
                    {
                        isCancellationRequested: true,
                        onCancellationRequested: () => ({ dispose: vi.fn() }),
                    },
                ),
        );

        await send("openCiLog", 2);

        expect(
            mocks.showTextDocument,
            "cancellation must win even on a cache hit",
        ).not.toHaveBeenCalled();
        expect(mocks.openTextDocument).not.toHaveBeenCalled();
        expect(
            replies.map((reply) => reply.type),
            "a cancelled open replies nothing",
        ).toEqual(["ciLogPreview"]);
    });

    it("an editor that fails to open or show replies failed after the log was stored", async () => {
        for (const failing of [mocks.openTextDocument, mocks.showTextDocument]) {
            const { replies, send } = setup();
            failing.mockRejectedValueOnce(new Error("cannot open editor"));

            // The host logs an escaping rejection; only a reply reaches the webview.
            await send("openCiLog", 1).catch(() => undefined);

            expect(replies, "the webview gets the editor failure").toEqual([
                expect.objectContaining({
                    type: "ciLogResult",
                    requestId: 1,
                    outcome: "failed",
                    message: "cannot open editor",
                }),
            ]);
        }
    });

    it("the job's first failed step reaches the log target", async () => {
        const { getDetail, target, send } = setup();
        const failing = detail("failure");
        failing.runs[0]!.jobs[0]!.steps = [
            { number: 1, name: "Set up job", state: "success" },
            { number: 2, name: "Run npm test", state: "failure" },
            { number: 3, name: "Post job cleanup", state: "failure" },
        ];
        getDetail.mockResolvedValueOnce(failing);

        await send("previewCiLog", 1);

        expect(target).toHaveBeenCalledWith(
            HASH,
            { runId: "5", jobId: "77", attempt: 1, failedStep: "Run npm test" },
            expect.anything(),
        );
    });

    describe("a sign-out mid-operation drops the stale result", () => {
        it("while the detail loads: no log request and no reply", async () => {
            const { getDetail, generations, target, download, replies, send } = setup();
            getDetail.mockImplementationOnce(async () => {
                generations.bumpAuth();
                return detail("failure");
            });
            await send("previewCiLog", 1);
            expect(target, "guard after the detail fetch").not.toHaveBeenCalled();
            expect(download).not.toHaveBeenCalled();
            expect(replies).toEqual([]);
        });

        it("while the log target resolves: no download and no reply", async () => {
            const { target, generations, download, replies, send } = setup();
            target.mockImplementationOnce(async () => {
                generations.bumpAuth();
                return { key: KEY, source: { ...SOURCE } };
            });
            await send("openCiLog", 1);
            expect(download, "guard after the log target").not.toHaveBeenCalled();
            expect(mocks.withProgress).not.toHaveBeenCalled();
            expect(replies).toEqual([]);
        });

        it("while the preview downloads: no excerpt reply", async () => {
            const download = vi.fn(async () => {
                generations.bumpAuth();
                return { text: LOG, truncated: false };
            });
            const { generations, replies, send } = setup("failure", download);
            await send("previewCiLog", 1);
            expect(download).toHaveBeenCalledTimes(1);
            expect(replies, "guard after the preview fetch").toEqual([]);
        });

        it("while the full log loads: no editor and no reply", async () => {
            const download = vi.fn(async () => {
                generations.bumpAuth();
                return { text: LOG, truncated: false };
            });
            const { generations, replies, send } = setup("failure", download);
            await send("openCiLog", 1);
            expect(mocks.openTextDocument, "guard after the open fetch").not.toHaveBeenCalled();
            expect(mocks.showTextDocument).not.toHaveBeenCalled();
            expect(replies).toEqual([]);
        });

        it("sign-out while openTextDocument waits prevents showing the old log", async () => {
            const { generations, replies, send } = setup();
            mocks.openTextDocument.mockImplementationOnce(async (uri: unknown) => {
                generations.bumpAuth();
                return { uri };
            });
            await send("openCiLog", 1);
            expect(mocks.openTextDocument).toHaveBeenCalledTimes(1);
            expect(
                mocks.showTextDocument,
                "a stale operation must not publish an editor",
            ).not.toHaveBeenCalled();
            expect(replies).toEqual([]);
        });
    });

    it("cancelling Open full log stops this waiter only", async () => {
        let finish: (value: { text: string; truncated: boolean }) => void = () => {};
        const download = vi.fn(
            () =>
                new Promise<{ text: string; truncated: boolean }>((resolve) => {
                    finish = resolve;
                }),
        );
        const { replies, send, store } = setup("failure", download);

        const opening = send("openCiLog", 1);
        await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
        mocks.cancel?.();
        await opening;
        expect(replies, "a cancelled open replies nothing").toEqual([]);
        expect(mocks.openTextDocument).not.toHaveBeenCalled();

        // The shared download goes on and lands in the store.
        finish({ text: LOG, truncated: false });
        await vi.waitFor(() => expect(store.get(KEY)?.text).toBe(LOG));
    });

    it("a job no longer in the detail, or another attempt, is refused without a request", async () => {
        const { replies, download, target } = setup();
        const host: CommitCiDetailSource = {
            repoKey: () => "/repo",
            getDetail: async () => detail("failure"),
            logs: { store: new CiLogMemoryStore({ download }), target },
        };
        await answerCiLogMessage(
            host,
            {
                type: "openCiLog",
                requestId: 3,
                repoKey: "/repo",
                hash: HASH,
                runId: "5",
                jobId: "77",
                attempt: 2,
            },
            (reply) => replies.push(reply as unknown as Record<string, unknown>),
        );
        expect(replies[0]).toMatchObject({ type: "ciLogResult", outcome: "failed" });
        expect(target).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
    });

    it("a run or job id that is not in the commit's detail is refused without a request", async () => {
        // Two runs with two jobs each, so a lookup that ignores the id finds a real job.
        const twoRuns = (): CommitCiDetail => {
            const base = detail("failure");
            const first = base.runs[0]!;
            first.jobs = [job("failure"), { ...job("failure"), id: "78", name: "lint" }];
            base.runs = [first, { ...first, id: "6", name: "Nightly" }];
            return base;
        };
        for (const [runId, jobId] of [
            ["999", "77"],
            ["5", "999"],
            ["6", "999"],
        ]) {
            const { replies, download, target, getDetail } = setup();
            getDetail.mockResolvedValue(twoRuns());
            const host: CommitCiDetailSource = {
                repoKey: () => "/repo",
                getDetail,
                logs: { store: new CiLogMemoryStore({ download }), target },
            };
            for (const type of ["previewCiLog", "openCiLog"] as const) {
                await answerCiLogMessage(
                    host,
                    {
                        type,
                        requestId: 1,
                        repoKey: "/repo",
                        hash: HASH,
                        runId,
                        jobId,
                        attempt: 1,
                        ...(type === "previewCiLog" && { selectionToken: 9 }),
                    },
                    (reply) => replies.push(reply as unknown as Record<string, unknown>),
                );
            }
            expect(
                replies.map((reply) => reply.outcome),
                `run ${runId} job ${jobId} is not in the detail, so it is refused`,
            ).toEqual(["failed", "failed"]);
            expect(target, `no log target for run ${runId} job ${jobId}`).not.toHaveBeenCalled();
            expect(download).not.toHaveBeenCalled();
        }
    });

    it("a job without its own attempt takes its run's attempt", async () => {
        const { replies, send, getDetail } = setup();
        const noAttempt = detail("failure");
        delete noAttempt.runs[0]!.jobs[0]!.attempt;
        getDetail.mockResolvedValue(noAttempt);

        await send("previewCiLog", 1);

        expect(
            replies.map((reply) => reply.outcome),
            "the run's attempt 1 matches the request's attempt 1",
        ).toEqual(["ready"]);
    });

    it("a truncated log tells the webview it was truncated", async () => {
        const { replies, send } = setup(
            "failure",
            vi.fn(async () => ({ text: LOG, truncated: true })),
        );

        await send("previewCiLog", 1);

        expect(replies[0], "the preview reply carries the store's truncated flag").toMatchObject({
            outcome: "ready",
            truncated: true,
        });
    });

    it("selecting or opening a job reads the detail from the cache, not by force", async () => {
        const { getDetail, send } = setup();

        await send("previewCiLog", 1);
        await send("openCiLog", 2);

        expect(getDetail).toHaveBeenCalledTimes(2);
        for (const call of getDetail.mock.calls as unknown[][]) {
            expect(call.slice(0, 2), "a job selection never bypasses the caches").toEqual([
                HASH,
                { force: false },
            ]);
        }
    });

    it("Open full log shows a cancellable notification", async () => {
        const { send } = setup();

        await send("openCiLog", 1);

        expect(mocks.withProgress).toHaveBeenCalledTimes(1);
        expect(
            mocks.withProgress.mock.calls[0]![0],
            "the notification offers Cancel",
        ).toMatchObject({ cancellable: true, location: 15 });
    });

    it("a 401 is forbidden", async () => {
        const refused = setup(
            "failure",
            vi.fn(async () => {
                throw new HttpError(401, "HTTP 401", {});
            }),
        );
        await refused.send("previewCiLog", 1);
        await refused.send("openCiLog", 2);
        expect(
            refused.replies.map((reply) => reply.outcome),
            "a refused sign-in asks the user to sign in again",
        ).toEqual(["forbidden", "forbidden"]);
    });

    it("rejects malformed messages and ignores them outside the E2E switch", async () => {
        const { send, replies, download } = setup();
        const host: CommitCiDetailSource = {
            repoKey: () => "/repo",
            getDetail: async () => detail("failure"),
        };
        await expect(
            answerCiLogMessage(
                host,
                { type: "openCiLog", requestId: 1, repoKey: "/repo", hash: "x" },
                vi.fn(),
            ),
        ).rejects.toThrow();
        await expect(
            answerCiLogMessage(
                host,
                {
                    type: "previewCiLog",
                    requestId: 1,
                    repoKey: "/repo",
                    hash: HASH,
                    runId: "5",
                    jobId: "77",
                },
                vi.fn(),
            ),
        ).rejects.toThrow();

        mocks.e2e = false;
        await send("previewCiLog", 1);
        expect(replies).toEqual([]);
        expect(download).not.toHaveBeenCalled();
    });

    it("reload → placeholder tab → Open full log → tab shows the real text", async () => {
        // A new window: a new store and provider, and a tab restored with this key.
        const { send, store } = setup();
        registerCiLogDocumentProvider(store);
        const provider = mocks.registerTextDocumentContentProvider.mock
            .calls[0]![1] as vscode.TextDocumentContentProvider;
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        const tab = {
            scheme: "intelligit-ci-log",
            path: "/unit-tests.log",
            query: `k=${KEY}`,
            toString: () => `intelligit-ci-log:/unit-tests.log?k=${KEY}`,
        } as unknown as vscode.Uri;
        const token = {} as vscode.CancellationToken;
        await expect(provider.provideTextDocumentContent(tab, token)).resolves.toBe(
            "[IntelliGit: this CI log is no longer loaded. Open it again from the Checks tab.]",
        );

        await send("openCiLog", 1);

        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledWith(tab);
        await expect(provider.provideTextDocumentContent(tab, token)).resolves.toBe(LOG);
    });
});
