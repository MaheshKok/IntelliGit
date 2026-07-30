import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
    class TestCancellationToken {
        isCancellationRequested = false;
        private readonly listeners = new Set<() => void>();

        onCancellationRequested(listener: () => void): { dispose(): void } {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
        }

        cancel(): void {
            if (this.isCancellationRequested) return;
            this.isCancellationRequested = true;
            for (const listener of this.listeners) listener();
        }
    }

    return {
        CancellationTokenSource: class {
            readonly token = new TestCancellationToken();

            cancel(): void {
                this.token.cancel();
            }

            dispose(): void {
                this.cancel();
            }
        },
    };
});

import {
    CommitMessageGenerationCoordinator,
    type CommitMessageGenerationEvent,
    type CommitMessageGenerationHost,
    type CommitMessageGenerationRequest,
    type CommitMessageGenerationRootContext,
} from "../../../src/ai/commitMessageGenerationCoordinator";
import { GenerationRequestError } from "../../../src/ai/commitMessageGenerator";

type Deferred<T> = {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
    const result = Promise.withResolvers<T>();
    return result;
}

function host(): { host: CommitMessageGenerationHost; events: CommitMessageGenerationEvent[] } {
    const events: CommitMessageGenerationEvent[] = [];
    return { host: { emit: (event) => events.push(event) }, events };
}

function context(
    overrides: Partial<CommitMessageGenerationRootContext> = {},
): CommitMessageGenerationRootContext {
    return {
        workspaceFolder: { uri: { fsPath: "/workspace" } } as never,
        gitOps: {
            getDiffForPaths: vi.fn(async () => ({
                diff: "diff",
                summarizedPaths: [],
                truncated: false,
            })),
            getRecentCommitSubjects: vi.fn(async () => ["fix: style"]),
            hasWholeIndexOperationInProgress: vi.fn(async () => false),
        },
        watchWholeIndexOperation: vi.fn(() => ({ dispose: vi.fn() })),
        ...overrides,
    };
}

function coordinator(
    rootContext: CommitMessageGenerationRootContext = context(),
    prepare = vi.fn(async () => ({
        model: {} as never,
        prompt: "prompt",
        text: (async function* () {
            yield "fix: ";
            yield "streamed";
        })(),
    })),
) {
    return new CommitMessageGenerationCoordinator({
        resolveRoot: vi.fn(() => rootContext),
        prepare,
    });
}

function requestGeneration(
    subject: CommitMessageGenerationCoordinator,
    request: Omit<CommitMessageGenerationRequest, "validatedStatusSnapshot"> & {
        validatedStatusSnapshot?: CommitMessageGenerationRequest["validatedStatusSnapshot"];
    },
): void {
    subject.request({ ...request, validatedStatusSnapshot: request.validatedStatusSnapshot ?? [] });
}

async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
}

afterEach(() => vi.restoreAllMocks());

describe("CommitMessageGenerationCoordinator", () => {
    it("emits one correlated terminal and matches cancellation by host object identity", async () => {
        const current = host();
        const other = host();
        const subject = coordinator();

        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "request-1",
            paths: ["file.ts"],
            amend: false,
            host: current.host,
        });
        await settle();
        subject.cancel({ repositoryRoot: "/repo", requestId: "request-1", host: other.host });

        expect(current.events).toEqual([
            { repositoryRoot: "/repo", requestId: "request-1", kind: "start" },
            { repositoryRoot: "/repo", requestId: "request-1", kind: "chunk", text: "fix: " },
            { repositoryRoot: "/repo", requestId: "request-1", kind: "chunk", text: "streamed" },
            { repositoryRoot: "/repo", requestId: "request-1", kind: "done" },
        ]);
        expect(other.events).toEqual([]);
    });

    it("supersedes an active same-root request across hosts and suppresses its stale work", async () => {
        const pendingDiff = deferred<{
            diff: string;
            summarizedPaths: string[];
            truncated: boolean;
        }>();
        const rootContext = context({
            gitOps: {
                getDiffForPaths: vi
                    .fn()
                    .mockImplementationOnce(() => pendingDiff.promise)
                    .mockResolvedValue({
                        diff: "winner diff",
                        summarizedPaths: [],
                        truncated: false,
                    }),
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subject = coordinator(rootContext);
        const superseded = host();
        const winner = host();

        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "old",
            paths: ["old.ts"],
            amend: false,
            host: superseded.host,
        });
        await settle();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "new",
            paths: ["new.ts"],
            amend: false,
            host: winner.host,
        });

        expect(superseded.events).toEqual([
            { repositoryRoot: "/repo", requestId: "old", kind: "cancelled", superseded: true },
        ]);
        pendingDiff.resolve({ diff: "stale diff", summarizedPaths: [], truncated: false });
        await settle();

        expect(superseded.events).toHaveLength(1);
        expect(winner.events.at(-1)).toEqual({
            repositoryRoot: "/repo",
            requestId: "new",
            kind: "done",
        });
    });

    it("cancels only the exact root, request id, and host identity match", async () => {
        const pendingDiff = deferred<{
            diff: string;
            summarizedPaths: string[];
            truncated: boolean;
        }>();
        const rootContext = context({
            gitOps: {
                getDiffForPaths: vi.fn(() => pendingDiff.promise),
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subject = coordinator(rootContext);
        const owner = host();
        const other = host();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "request-2",
            paths: ["file.ts"],
            amend: false,
            host: owner.host,
        });
        await settle();

        subject.cancel({ repositoryRoot: "/repo", requestId: "request-2", host: other.host });
        expect(owner.events).toEqual([]);
        subject.cancel({ repositoryRoot: "/repo", requestId: "request-2", host: owner.host });

        expect(owner.events).toEqual([
            { repositoryRoot: "/repo", requestId: "request-2", kind: "cancelled" },
        ]);
    });

    it("suppresses all later events when cancelled during subject acquisition or P3 preparation", async () => {
        const subjects = deferred<string[]>();
        const subjectContext = context({
            gitOps: {
                getDiffForPaths: vi.fn(async () => ({
                    diff: "diff",
                    summarizedPaths: [],
                    truncated: false,
                })),
                getRecentCommitSubjects: vi.fn(() => subjects.promise),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subjectCoordinator = coordinator(subjectContext);
        const subjectOwner = host();
        requestGeneration(subjectCoordinator, {
            repositoryRoot: "/subjects",
            requestId: "subjects",
            paths: ["file.ts"],
            amend: false,
            host: subjectOwner.host,
        });
        await settle();
        expect(subjectContext.gitOps.getRecentCommitSubjects).toHaveBeenCalledOnce();
        subjectCoordinator.cancel({
            repositoryRoot: "/subjects",
            requestId: "subjects",
            host: subjectOwner.host,
        });
        subjects.resolve(["stale subject"]);
        await settle();

        const preparation = deferred<{
            model: never;
            prompt: string;
            text: AsyncIterable<string>;
        }>();
        const prepare = vi.fn(() => preparation.promise);
        const preparationCoordinator = coordinator(context(), prepare);
        const preparationOwner = host();
        requestGeneration(preparationCoordinator, {
            repositoryRoot: "/preparation",
            requestId: "preparation",
            paths: ["file.ts"],
            amend: false,
            host: preparationOwner.host,
        });
        await settle();
        expect(prepare).toHaveBeenCalledOnce();
        preparationCoordinator.cancel({
            repositoryRoot: "/preparation",
            requestId: "preparation",
            host: preparationOwner.host,
        });
        preparation.resolve({
            model: {} as never,
            prompt: "stale prompt",
            text: (async function* () {
                yield "stale chunk";
            })(),
        });
        await settle();

        expect(subjectOwner.events).toEqual([
            { repositoryRoot: "/subjects", requestId: "subjects", kind: "cancelled" },
        ]);
        expect(preparationOwner.events).toEqual([
            { repositoryRoot: "/preparation", requestId: "preparation", kind: "cancelled" },
        ]);
    });

    it("serializes same-root acquisition and never starts a cancelled request that was waiting for its slot", async () => {
        const firstDiff = deferred<{
            diff: string;
            summarizedPaths: string[];
            truncated: boolean;
        }>();
        const getDiffForPaths = vi.fn(() => firstDiff.promise);
        const rootContext = context({
            gitOps: {
                getDiffForPaths,
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subject = coordinator(rootContext);
        const active = host();
        const waiting = host();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "active",
            paths: ["active.ts"],
            amend: false,
            host: active.host,
        });
        await settle();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "waiting",
            paths: ["waiting.ts"],
            amend: false,
            host: waiting.host,
        });
        await settle();
        subject.cancel({ repositoryRoot: "/repo", requestId: "waiting", host: waiting.host });
        firstDiff.resolve({ diff: "active diff", summarizedPaths: [], truncated: false });
        await settle();

        expect(getDiffForPaths).toHaveBeenCalledTimes(1);
        expect(waiting.events).toEqual([
            { repositoryRoot: "/repo", requestId: "waiting", kind: "cancelled" },
        ]);
    });

    it("measures one maximum same-root acquisition under rapid regeneration and skips a queued cancellation", async () => {
        const gates: Deferred<{ diff: string; summarizedPaths: string[]; truncated: boolean }>[] =
            [];
        let concurrent = 0;
        let maximumConcurrent = 0;
        const getDiffForPaths = vi.fn(() => {
            const gate = deferred<{
                diff: string;
                summarizedPaths: string[];
                truncated: boolean;
            }>();
            gates.push(gate);
            concurrent += 1;
            maximumConcurrent = Math.max(maximumConcurrent, concurrent);
            return gate.promise.finally(() => {
                concurrent -= 1;
            });
        });
        const rootContext = context({
            gitOps: {
                getDiffForPaths,
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subject = coordinator(rootContext);
        const first = host();
        const second = host();
        const queued = host();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "first",
            paths: ["first.ts"],
            amend: false,
            host: first.host,
        });
        await settle();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "second",
            paths: ["second.ts"],
            amend: false,
            host: second.host,
        });
        await settle();

        gates[0].resolve({ diff: "first", summarizedPaths: [], truncated: false });
        await settle();
        expect(getDiffForPaths).toHaveBeenCalledTimes(2);
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "queued",
            paths: ["queued.ts"],
            amend: false,
            host: queued.host,
        });
        subject.cancel({ repositoryRoot: "/repo", requestId: "queued", host: queued.host });
        gates[1].resolve({ diff: "second", summarizedPaths: [], truncated: false });
        await settle();

        expect(maximumConcurrent).toBe(1);
        expect(getDiffForPaths).toHaveBeenCalledTimes(2);
        expect(queued.events).toEqual([
            { repositoryRoot: "/repo", requestId: "queued", kind: "cancelled" },
        ]);
    });

    it("reference-counts a root generation fence, cancels active work, and reopens only after its final release", async () => {
        const pendingDiff = deferred<{
            diff: string;
            summarizedPaths: string[];
            truncated: boolean;
        }>();
        const rootContext = context({
            gitOps: {
                getDiffForPaths: vi
                    .fn()
                    .mockImplementationOnce(() => pendingDiff.promise)
                    .mockResolvedValue({
                        diff: "reopened",
                        summarizedPaths: [],
                        truncated: false,
                    }),
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subject = coordinator(rootContext);
        const active = host();
        const blocked = host();
        const reopened = host();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "active",
            paths: ["active.ts"],
            amend: false,
            host: active.host,
        });
        await settle();

        const releaseFirst = subject.acquireCommitLease("/repo");
        const releaseSecond = subject.acquireCommitLease("/repo");
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "blocked",
            paths: ["blocked.ts"],
            amend: false,
            host: blocked.host,
        });
        releaseFirst();
        releaseFirst();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "still-blocked",
            paths: ["still-blocked.ts"],
            amend: false,
            host: blocked.host,
        });
        releaseSecond();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "reopened",
            paths: ["reopened.ts"],
            amend: false,
            host: reopened.host,
        });
        pendingDiff.resolve({ diff: "stale", summarizedPaths: [], truncated: false });
        await settle();

        expect(active.events).toEqual([
            { repositoryRoot: "/repo", requestId: "active", kind: "cancelled", superseded: true },
        ]);
        expect(blocked.events).toEqual([
            {
                repositoryRoot: "/repo",
                requestId: "blocked",
                kind: "error",
                errorKind: "commitInProgress",
            },
            {
                repositoryRoot: "/repo",
                requestId: "still-blocked",
                kind: "error",
                errorKind: "commitInProgress",
            },
        ]);
        expect(reopened.events.at(-1)).toEqual({
            repositoryRoot: "/repo",
            requestId: "reopened",
            kind: "done",
        });
    });

    it("arms the watcher before its first predicate, ignores a false signal, and cancels once when a later signal is true", async () => {
        const streamResume = deferred<void>();
        let signal: (() => void) | undefined;
        const disposable = { dispose: vi.fn() };
        const callOrder: string[] = [];
        const rootContext = context({
            gitOps: {
                getDiffForPaths: vi.fn(async () => ({
                    diff: "diff",
                    summarizedPaths: [],
                    truncated: false,
                })),
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi
                    .fn()
                    .mockImplementationOnce(async () => {
                        callOrder.push("predicate");
                        return false;
                    })
                    .mockResolvedValueOnce(false)
                    .mockResolvedValueOnce(true),
            },
            watchWholeIndexOperation: vi.fn((onDidChange) => {
                callOrder.push("watch");
                signal = onDidChange;
                return disposable;
            }),
        });
        const subject = coordinator(
            rootContext,
            vi.fn(async () => ({
                model: {} as never,
                prompt: "prompt",
                text: (async function* () {
                    yield "fix: first";
                    await streamResume.promise;
                    yield "stale second";
                })(),
            })),
        );
        const owner = host();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "watch",
            paths: ["file.ts"],
            amend: false,
            host: owner.host,
        });
        await settle();

        expect(callOrder).toEqual(["watch", "predicate"]);
        signal?.();
        await settle();
        expect(owner.events).toEqual([
            { repositoryRoot: "/repo", requestId: "watch", kind: "start" },
            { repositoryRoot: "/repo", requestId: "watch", kind: "chunk", text: "fix: first" },
        ]);

        signal?.();
        await settle();
        streamResume.resolve();
        await settle();

        expect(owner.events).toEqual([
            { repositoryRoot: "/repo", requestId: "watch", kind: "start" },
            { repositoryRoot: "/repo", requestId: "watch", kind: "chunk", text: "fix: first" },
            { repositoryRoot: "/repo", requestId: "watch", kind: "cancelled" },
        ]);
        expect(disposable.dispose).toHaveBeenCalledTimes(1);
    });

    it("waits for an in-flight watcher predicate before making the final terminal decision", async () => {
        const streamResume = deferred<void>();
        const watcherResult = deferred<boolean>();
        let signal: (() => void) | undefined;
        const disposable = { dispose: vi.fn() };
        const predicate = vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockImplementationOnce(() => watcherResult.promise)
            .mockResolvedValueOnce(false);
        const rootContext = context({
            gitOps: {
                getDiffForPaths: vi.fn(async () => ({
                    diff: "diff",
                    summarizedPaths: [],
                    truncated: false,
                })),
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: predicate,
            },
            watchWholeIndexOperation: vi.fn((onDidChange) => {
                signal = onDidChange;
                return disposable;
            }),
        });
        const subject = coordinator(
            rootContext,
            vi.fn(async () => ({
                model: {} as never,
                prompt: "prompt",
                text: (async function* () {
                    yield "fix: overlap";
                    await streamResume.promise;
                })(),
            })),
        );
        const owner = host();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "overlap",
            paths: ["file.ts"],
            amend: false,
            host: owner.host,
        });
        await settle();

        signal?.();
        await settle();
        expect(predicate).toHaveBeenCalledTimes(2);
        streamResume.resolve();
        await settle();

        expect(owner.events).toEqual([
            { repositoryRoot: "/repo", requestId: "overlap", kind: "start" },
            { repositoryRoot: "/repo", requestId: "overlap", kind: "chunk", text: "fix: overlap" },
        ]);
        watcherResult.resolve(true);
        await settle();

        expect(owner.events).toEqual([
            { repositoryRoot: "/repo", requestId: "overlap", kind: "start" },
            { repositoryRoot: "/repo", requestId: "overlap", kind: "chunk", text: "fix: overlap" },
            { repositoryRoot: "/repo", requestId: "overlap", kind: "cancelled" },
        ]);
        expect(disposable.dispose).toHaveBeenCalledTimes(1);
    });

    it.each([
        { watcherResult: true, terminalKind: "cancelled" as const, predicateCount: 3 },
        { watcherResult: false, terminalKind: "done" as const, predicateCount: 4 },
    ])(
        "reaches one $terminalKind terminal when a $watcherResult watcher signal arrives during the final predicate",
        async ({ watcherResult, terminalKind, predicateCount }) => {
            const finalResult = deferred<boolean>();
            const queuedWatcherResult = deferred<boolean>();
            let signal: (() => void) | undefined;
            const predicate = vi
                .fn()
                .mockResolvedValueOnce(false)
                .mockImplementationOnce(() => finalResult.promise)
                .mockImplementationOnce(() => queuedWatcherResult.promise)
                .mockResolvedValueOnce(false);
            const rootContext = context({
                gitOps: {
                    getDiffForPaths: vi.fn(async () => ({
                        diff: "diff",
                        summarizedPaths: [],
                        truncated: false,
                    })),
                    getRecentCommitSubjects: vi.fn(async () => []),
                    hasWholeIndexOperationInProgress: predicate,
                },
                watchWholeIndexOperation: vi.fn((onDidChange) => {
                    signal = onDidChange;
                    return { dispose: vi.fn() };
                }),
            });
            const subject = coordinator(rootContext);
            const owner = host();
            subject.request({
                repositoryRoot: "/repo",
                requestId: "during-final",
                paths: ["file.ts"],
                amend: false,
                host: owner.host,
            });
            await settle();

            expect(predicate).toHaveBeenCalledTimes(2);
            signal?.();
            await settle();
            expect(predicate).toHaveBeenCalledTimes(2);

            finalResult.resolve(false);
            await settle();
            expect(predicate).toHaveBeenCalledTimes(3);
            expect(owner.events).toEqual([
                { repositoryRoot: "/repo", requestId: "during-final", kind: "start" },
                {
                    repositoryRoot: "/repo",
                    requestId: "during-final",
                    kind: "chunk",
                    text: "fix: ",
                },
                {
                    repositoryRoot: "/repo",
                    requestId: "during-final",
                    kind: "chunk",
                    text: "streamed",
                },
            ]);

            queuedWatcherResult.resolve(watcherResult);
            await settle();

            expect(predicate).toHaveBeenCalledTimes(predicateCount);
            expect(owner.events.at(-1)).toEqual({
                repositoryRoot: "/repo",
                requestId: "during-final",
                kind: terminalKind,
            });
            expect(owner.events.filter((event) => event.kind === "done")).toHaveLength(
                terminalKind === "done" ? 1 : 0,
            );
            expect(
                owner.events.filter((event) => ["done", "cancelled", "error"].includes(event.kind)),
            ).toHaveLength(1);
        },
    );

    it("maps watcher setup failures to unknown and converts a just-before-done operation marker into cancellation", async () => {
        const setupFailureContext = context({
            watchWholeIndexOperation: vi.fn(() => {
                throw new Error("watch failed");
            }),
        });
        const setupFailure = host();
        requestGeneration(coordinator(setupFailureContext), {
            repositoryRoot: "/setup-failure",
            requestId: "setup-failure",
            paths: ["file.ts"],
            amend: false,
            host: setupFailure.host,
        });
        await settle();

        const markerContext = context({
            gitOps: {
                getDiffForPaths: vi.fn(async () => ({
                    diff: "diff",
                    summarizedPaths: [],
                    truncated: false,
                })),
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi
                    .fn()
                    .mockResolvedValueOnce(false)
                    .mockResolvedValueOnce(true),
            },
        });
        const marker = host();
        requestGeneration(coordinator(markerContext), {
            repositoryRoot: "/marker",
            requestId: "marker",
            paths: ["file.ts"],
            amend: false,
            host: marker.host,
        });
        await settle();

        expect(setupFailure.events).toEqual([
            {
                repositoryRoot: "/setup-failure",
                requestId: "setup-failure",
                kind: "error",
                errorKind: "unknown",
            },
        ]);
        expect(marker.events.at(-1)).toEqual({
            repositoryRoot: "/marker",
            requestId: "marker",
            kind: "cancelled",
        });
    });

    it("maps resolver, initial predicate, and watcher predicate throws to one correlated unknown error", async () => {
        const resolverFailure = host();
        new CommitMessageGenerationCoordinator({
            resolveRoot: vi.fn(() => {
                throw new Error("resolve failed");
            }),
        }).request({
            repositoryRoot: "/resolver",
            requestId: "resolver",
            paths: ["file.ts"],
            amend: false,
            host: resolverFailure.host,
        });

        const initialDisposable = { dispose: vi.fn() };
        const initialFailure = host();
        coordinator(
            context({
                gitOps: {
                    getDiffForPaths: vi.fn(),
                    getRecentCommitSubjects: vi.fn(),
                    hasWholeIndexOperationInProgress: vi.fn(async () => {
                        throw new Error("initial predicate failed");
                    }),
                },
                watchWholeIndexOperation: vi.fn(() => initialDisposable),
            }),
        ).request({
            repositoryRoot: "/initial",
            requestId: "initial",
            paths: ["file.ts"],
            amend: false,
            host: initialFailure.host,
        });
        await settle();

        let signal: (() => void) | undefined;
        const watcherDisposable = { dispose: vi.fn() };
        const streamResume = deferred<void>();
        const watcherFailure = host();
        coordinator(
            context({
                gitOps: {
                    getDiffForPaths: vi.fn(async () => ({
                        diff: "diff",
                        summarizedPaths: [],
                        truncated: false,
                    })),
                    getRecentCommitSubjects: vi.fn(async () => []),
                    hasWholeIndexOperationInProgress: vi
                        .fn()
                        .mockResolvedValueOnce(false)
                        .mockRejectedValueOnce(new Error("watcher predicate failed")),
                },
                watchWholeIndexOperation: vi.fn((onDidChange) => {
                    signal = onDidChange;
                    return watcherDisposable;
                }),
            }),
            vi.fn(async () => ({
                model: {} as never,
                prompt: "prompt",
                text: (async function* () {
                    await streamResume.promise;
                    yield "stale chunk";
                })(),
            })),
        ).request({
            repositoryRoot: "/watcher",
            requestId: "watcher",
            paths: ["file.ts"],
            amend: false,
            host: watcherFailure.host,
        });
        await settle();
        signal?.();
        await settle();
        streamResume.resolve();
        await settle();

        expect(resolverFailure.events).toEqual([
            {
                repositoryRoot: "/resolver",
                requestId: "resolver",
                kind: "error",
                errorKind: "unknown",
            },
        ]);
        expect(initialFailure.events).toEqual([
            {
                repositoryRoot: "/initial",
                requestId: "initial",
                kind: "error",
                errorKind: "unknown",
            },
        ]);
        expect(watcherFailure.events).toEqual([
            { repositoryRoot: "/watcher", requestId: "watcher", kind: "start" },
            {
                repositoryRoot: "/watcher",
                requestId: "watcher",
                kind: "error",
                errorKind: "unknown",
            },
        ]);
        expect(initialDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(watcherDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it("maps P3 preparation and stream failures to their stable correlated terminal events", async () => {
        const prepare = vi
            .fn()
            .mockRejectedValueOnce(new GenerationRequestError("blocked", "blocked before start"))
            .mockRejectedValueOnce(
                new GenerationRequestError("cancelled", "cancelled before start"),
            )
            .mockResolvedValueOnce({
                model: {} as never,
                prompt: "prompt",
                text: (async function* () {
                    yield "fix: before failure";
                    throw new GenerationRequestError("emptyResult", "empty result");
                })(),
            });
        const subject = coordinator(context(), prepare);
        const preStart = host();
        const cancelled = host();
        const streamFailure = host();
        for (const [requestId, requestHost] of [
            ["pre-start", preStart],
            ["cancelled", cancelled],
            ["stream", streamFailure],
        ] as const) {
            subject.request({
                repositoryRoot: `/${requestId}`,
                requestId,
                paths: ["file.ts"],
                amend: false,
                host: requestHost.host,
            });
            await settle();
        }

        expect(preStart.events).toEqual([
            {
                repositoryRoot: "/pre-start",
                requestId: "pre-start",
                kind: "error",
                errorKind: "blocked",
            },
        ]);
        expect(cancelled.events).toEqual([
            { repositoryRoot: "/cancelled", requestId: "cancelled", kind: "cancelled" },
        ]);
        expect(streamFailure.events).toEqual([
            { repositoryRoot: "/stream", requestId: "stream", kind: "start" },
            {
                repositoryRoot: "/stream",
                requestId: "stream",
                kind: "chunk",
                text: "fix: before failure",
            },
            {
                repositoryRoot: "/stream",
                requestId: "stream",
                kind: "error",
                errorKind: "emptyResult",
            },
        ]);
    });

    it("suppresses a stale preparation rejection after same-root supersession", async () => {
        const stalePreparation = deferred<{
            model: never;
            prompt: string;
            text: AsyncIterable<string>;
        }>();
        const prepare = vi
            .fn()
            .mockImplementationOnce(() => stalePreparation.promise)
            .mockResolvedValueOnce({
                model: {} as never,
                prompt: "winner",
                text: (async function* () {
                    yield "fix: winner";
                })(),
            });
        const subject = coordinator(context(), prepare);
        const stale = host();
        const winner = host();
        requestGeneration(subject, {
            repositoryRoot: "/repo",
            requestId: "stale",
            paths: ["stale.ts"],
            amend: false,
            host: stale.host,
        });
        await settle();
        expect(prepare).toHaveBeenCalledOnce();
        subject.request({
            repositoryRoot: "/repo",
            requestId: "winner",
            paths: ["winner.ts"],
            amend: false,
            host: winner.host,
        });
        stalePreparation.reject(new GenerationRequestError("blocked", "stale rejection"));
        await settle();

        expect(stale.events).toEqual([
            { repositoryRoot: "/repo", requestId: "stale", kind: "cancelled", superseded: true },
        ]);
        expect(winner.events.at(-1)).toEqual({
            repositoryRoot: "/repo",
            requestId: "winner",
            kind: "done",
        });
    });

    it("drops only the specified host, disposes all active roots, and rejects a future request deterministically", async () => {
        const pendingDiff = deferred<{
            diff: string;
            summarizedPaths: string[];
            truncated: boolean;
        }>();
        const rootContext = context({
            gitOps: {
                getDiffForPaths: vi.fn(() => pendingDiff.promise),
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subject = coordinator(rootContext);
        const first = host();
        const second = host();
        const future = host();
        subject.request({
            repositoryRoot: "/first",
            requestId: "first",
            paths: ["first.ts"],
            amend: false,
            host: first.host,
        });
        subject.request({
            repositoryRoot: "/second",
            requestId: "second",
            paths: ["second.ts"],
            amend: false,
            host: second.host,
        });
        await settle();

        subject.dropHost(first.host);
        expect(first.events).toEqual([
            { repositoryRoot: "/first", requestId: "first", kind: "cancelled" },
        ]);
        expect(second.events).toEqual([]);

        subject.dispose();
        subject.request({
            repositoryRoot: "/future",
            requestId: "future",
            paths: ["future.ts"],
            amend: false,
            host: future.host,
        });
        pendingDiff.resolve({ diff: "stale", summarizedPaths: [], truncated: false });
        await settle();

        expect(second.events).toEqual([
            { repositoryRoot: "/second", requestId: "second", kind: "cancelled" },
        ]);
        expect(future.events).toEqual([
            {
                repositoryRoot: "/future",
                requestId: "future",
                kind: "error",
                errorKind: "unknown",
            },
        ]);
    });

    it("keeps different roots independent and rejects an initially marked whole-index operation before acquisition", async () => {
        const firstDiff = deferred<{
            diff: string;
            summarizedPaths: string[];
            truncated: boolean;
        }>();
        const getDiffForPaths = vi.fn((paths: string[]) =>
            paths[0] === "first.ts"
                ? firstDiff.promise
                : Promise.resolve({ diff: "second", summarizedPaths: [], truncated: false }),
        );
        const rootContext = context({
            gitOps: {
                getDiffForPaths,
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const subject = coordinator(rootContext);
        const first = host();
        const second = host();
        subject.request({
            repositoryRoot: "/first",
            requestId: "first",
            paths: ["first.ts"],
            amend: false,
            host: first.host,
        });
        await settle();
        subject.request({
            repositoryRoot: "/second",
            requestId: "second",
            paths: ["second.ts"],
            amend: false,
            host: second.host,
        });
        await settle();

        expect(first.events).toEqual([]);
        expect(second.events.at(-1)).toEqual({
            repositoryRoot: "/second",
            requestId: "second",
            kind: "done",
        });
        firstDiff.resolve({ diff: "first", summarizedPaths: [], truncated: false });
        await settle();
        expect(first.events.at(-1)).toEqual({
            repositoryRoot: "/first",
            requestId: "first",
            kind: "done",
        });

        const markerDisposable = { dispose: vi.fn() };
        const markedContext = context({
            gitOps: {
                getDiffForPaths: vi.fn(),
                getRecentCommitSubjects: vi.fn(),
                hasWholeIndexOperationInProgress: vi.fn(async () => true),
            },
            watchWholeIndexOperation: vi.fn(() => markerDisposable),
        });
        const marked = host();
        coordinator(markedContext).request({
            repositoryRoot: "/marked",
            requestId: "marked",
            paths: ["marked.ts"],
            amend: false,
            host: marked.host,
        });
        await settle();

        expect(marked.events).toEqual([
            {
                repositoryRoot: "/marked",
                requestId: "marked",
                kind: "error",
                errorKind: "operationInProgress",
            },
        ]);
        expect(markedContext.gitOps.getDiffForPaths).not.toHaveBeenCalled();
        expect(markerDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it("forwards the exact validated snapshot and drops only the matching host root", async () => {
        const pendingDiff = deferred<{
            diff: string;
            summarizedPaths: string[];
            truncated: boolean;
        }>();
        const getDiffForPaths = vi.fn(() => pendingDiff.promise);
        const subject = coordinator(
            context({
                gitOps: {
                    getDiffForPaths,
                    getRecentCommitSubjects: vi.fn(async () => []),
                    hasWholeIndexOperationInProgress: vi.fn(async () => false),
                },
            }),
        );
        const sharedHost = host();
        const otherHost = host();
        const snapshot = [
            {
                path: "destination.ts",
                sourcePath: "source.ts",
                status: "R" as const,
                staged: false,
                additions: 1,
                deletions: 0,
            },
        ] as const;

        subject.request({
            repositoryRoot: "/first",
            requestId: "first",
            paths: ["destination.ts"],
            amend: false,
            validatedStatusSnapshot: snapshot,
            host: sharedHost.host,
        });
        subject.request({
            repositoryRoot: "/second",
            requestId: "second",
            paths: ["other.ts"],
            amend: false,
            validatedStatusSnapshot: snapshot,
            host: sharedHost.host,
        });
        subject.request({
            repositoryRoot: "/third",
            requestId: "third",
            paths: ["third.ts"],
            amend: false,
            validatedStatusSnapshot: snapshot,
            host: otherHost.host,
        });
        await settle();

        expect(getDiffForPaths).toHaveBeenCalledWith(["destination.ts"], {
            includeHead: false,
            validatedStatusSnapshot: snapshot,
        });
        expect(getDiffForPaths.mock.calls[0]?.[1]?.validatedStatusSnapshot).toBe(snapshot);

        subject.dropHostRoot(sharedHost.host, "/first");

        expect(sharedHost.events).toEqual([
            { repositoryRoot: "/first", requestId: "first", kind: "cancelled" },
        ]);
        expect(otherHost.events).toEqual([]);
        pendingDiff.resolve({ diff: "diff", summarizedPaths: [], truncated: false });
    });

    it("cancels a registered deferred validation before it can acquire a diff or prepare a model", async () => {
        const validation = deferred<{
            paths: string[];
            amend: boolean;
            validatedStatusSnapshot: readonly [];
        }>();
        const rootContext = context();
        const prepare = vi.fn();
        const subject = coordinator(rootContext, prepare);
        const owner = host();

        subject.submit({
            repositoryRoot: "/repo",
            requestId: "deferred-status",
            host: owner.host,
            validate: () => validation.promise,
        });
        await settle();
        subject.cancel({
            repositoryRoot: "/repo",
            requestId: "deferred-status",
            host: owner.host,
        });
        validation.resolve({ paths: ["src/a.ts"], amend: false, validatedStatusSnapshot: [] });
        await settle();

        expect(owner.events).toEqual([
            { repositoryRoot: "/repo", requestId: "deferred-status", kind: "cancelled" },
        ]);
        expect(rootContext.gitOps.getDiffForPaths).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
    });

    it("supersedes pending peer-host validation promptly and serializes the successor behind it", async () => {
        const firstValidation = deferred<{
            paths: string[];
            amend: boolean;
            validatedStatusSnapshot: readonly [];
        }>();
        const secondValidation = deferred<{
            paths: string[];
            amend: boolean;
            validatedStatusSnapshot: readonly [];
        }>();
        const firstValidate = vi.fn(() => firstValidation.promise);
        const secondValidate = vi.fn(() => secondValidation.promise);
        const subject = coordinator();
        const first = host();
        const second = host();

        subject.submit({
            repositoryRoot: "/repo",
            requestId: "old",
            host: first.host,
            validate: firstValidate,
        });
        await settle();
        expect(firstValidate).toHaveBeenCalledOnce();

        subject.submit({
            repositoryRoot: "/repo",
            requestId: "new",
            host: second.host,
            validate: secondValidate,
        });
        await settle();
        expect(first.events).toEqual([
            { repositoryRoot: "/repo", requestId: "old", kind: "cancelled", superseded: true },
        ]);
        expect(secondValidate).not.toHaveBeenCalled();

        firstValidation.resolve({ paths: ["old.ts"], amend: false, validatedStatusSnapshot: [] });
        await settle();
        expect(secondValidate).toHaveBeenCalledOnce();
        secondValidation.resolve({ paths: ["new.ts"], amend: false, validatedStatusSnapshot: [] });
        await settle();

        expect(first.events).toHaveLength(1);
        expect(second.events.at(-1)).toEqual({
            repositoryRoot: "/repo",
            requestId: "new",
            kind: "done",
        });
    });

    it("keeps cancelled validation tails until each in-flight callback settles", async () => {
        const gates = [
            deferred<{ paths: string[]; amend: boolean; validatedStatusSnapshot: readonly [] }>(),
            deferred<{ paths: string[]; amend: boolean; validatedStatusSnapshot: readonly [] }>(),
            deferred<{ paths: string[]; amend: boolean; validatedStatusSnapshot: readonly [] }>(),
        ];
        let concurrent = 0;
        let maximumConcurrent = 0;
        const validations = gates.map((gate) =>
            vi.fn(() =>
                gate.promise.finally(() => {
                    concurrent -= 1;
                }),
            ),
        );
        for (const validate of validations) {
            validate.mockImplementationOnce(() => {
                concurrent += 1;
                maximumConcurrent = Math.max(maximumConcurrent, concurrent);
                return gates[validations.indexOf(validate)].promise.finally(() => {
                    concurrent -= 1;
                });
            });
        }
        const subject = coordinator();
        const owners = [host(), host(), host()];

        for (const [index, owner] of owners.entries()) {
            subject.submit({
                repositoryRoot: "/repo",
                requestId: `request-${index}`,
                host: owner.host,
                validate: validations[index],
            });
            await settle();
        }
        expect(maximumConcurrent).toBe(1);
        gates[0].resolve({ paths: ["one.ts"], amend: false, validatedStatusSnapshot: [] });
        await settle();
        expect(maximumConcurrent).toBe(1);
        gates[1].resolve({ paths: ["two.ts"], amend: false, validatedStatusSnapshot: [] });
        await settle();
        expect(maximumConcurrent).toBe(1);
        gates[2].resolve({ paths: ["three.ts"], amend: false, validatedStatusSnapshot: [] });
        await settle();

        expect(
            owners.map((owner) => owner.events.filter((event) => event.kind === "cancelled")),
        ).toEqual([
            [
                {
                    repositoryRoot: "/repo",
                    requestId: "request-0",
                    kind: "cancelled",
                    superseded: true,
                },
            ],
            [
                {
                    repositoryRoot: "/repo",
                    requestId: "request-1",
                    kind: "cancelled",
                    superseded: true,
                },
            ],
            [],
        ]);
    });

    it("fences pending validation on leases and host lifecycle drops without later promotion", async () => {
        const controls: Array<{
            terminate(
                subject: CommitMessageGenerationCoordinator,
                owner: CommitMessageGenerationHost,
            ): void;
            terminal: { kind: "cancelled"; superseded?: true };
        }> = [
            {
                terminate: (subject) => {
                    subject.acquireCommitLease("/repo");
                },
                terminal: { kind: "cancelled", superseded: true },
            },
            {
                terminate: (subject, owner) => subject.dropHostRoot(owner, "/repo"),
                terminal: { kind: "cancelled" },
            },
            {
                terminate: (subject, owner) => subject.dropHost(owner),
                terminal: { kind: "cancelled" },
            },
            {
                terminate: (subject) => subject.dispose(),
                terminal: { kind: "cancelled" },
            },
        ];

        for (const [index, { terminate, terminal }] of controls.entries()) {
            const validation = deferred<{
                paths: string[];
                amend: boolean;
                validatedStatusSnapshot: readonly [];
            }>();
            const rootContext = context();
            const subject = coordinator(rootContext);
            const owner = host();
            subject.submit({
                repositoryRoot: "/repo",
                requestId: `termination-${index}`,
                host: owner.host,
                validate: () => validation.promise,
            });
            await settle();
            terminate(subject, owner.host);
            validation.resolve({ paths: ["file.ts"], amend: false, validatedStatusSnapshot: [] });
            await settle();

            expect(owner.events).toEqual([
                {
                    repositoryRoot: "/repo",
                    requestId: `termination-${index}`,
                    ...terminal,
                },
            ]);
            expect(rootContext.gitOps.getDiffForPaths).not.toHaveBeenCalled();
        }
    });

    it("promotes only the exact active validation snapshot and maps active validation failures to invalidRequest", async () => {
        const getDiffForPaths = vi.fn(async () => ({
            diff: "diff",
            summarizedPaths: [],
            truncated: false,
        }));
        const rootContext = context({
            gitOps: {
                getDiffForPaths,
                getRecentCommitSubjects: vi.fn(async () => []),
                hasWholeIndexOperationInProgress: vi.fn(async () => false),
            },
        });
        const snapshot = [
            {
                path: "destination.ts",
                sourcePath: "source.ts",
                status: "R" as const,
                staged: false,
                additions: 1,
                deletions: 1,
            },
        ] as const;
        const subject = coordinator(rootContext);
        const valid = host();
        const invalid = host();

        subject.submit({
            repositoryRoot: "/valid",
            requestId: "valid",
            host: valid.host,
            validate: async () => ({
                paths: ["destination.ts"],
                amend: false,
                validatedStatusSnapshot: snapshot,
            }),
        });
        await settle();
        expect(getDiffForPaths).toHaveBeenCalledWith(["destination.ts"], {
            includeHead: false,
            validatedStatusSnapshot: snapshot,
        });
        expect(getDiffForPaths.mock.calls[0]?.[1]?.validatedStatusSnapshot).toBe(snapshot);

        subject.submit({
            repositoryRoot: "/invalid",
            requestId: "invalid",
            host: invalid.host,
            validate: async () => {
                throw new Error("status failed");
            },
        });
        await settle();
        expect(invalid.events).toEqual([
            {
                repositoryRoot: "/invalid",
                requestId: "invalid",
                kind: "error",
                errorKind: "invalidRequest",
            },
        ]);
    });
});
