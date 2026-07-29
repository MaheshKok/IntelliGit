import * as vscode from "vscode";
import { GenerationRequestError, prepareCommitMessageGeneration } from "./commitMessageGenerator";
import type {
    PrepareCommitMessageGenerationOptions,
    PreparedCommitMessageGeneration,
} from "./commitMessageGenerator";
import type { DiffForPathsResult } from "../git/operations";

/** Kinds emitted by the shared generation lifecycle. */
type CommitMessageGenerationEventKind = "start" | "chunk" | "done" | "cancelled" | "error";

/** Stable non-cancellation errors that hosts can render without inspecting internal failures. */
export type CommitMessageGenerationCoordinatorErrorKind =
    | "copilotUnavailable"
    | "notFound"
    | "noPermissions"
    | "blocked"
    | "unknown"
    | "promptTooLarge"
    | "emptyResult"
    | "operationInProgress"
    | "commitInProgress";

/** A correlated structural event emitted to the host that owns a generation attempt. */
export interface CommitMessageGenerationEvent {
    repositoryRoot: string;
    requestId: string;
    kind: CommitMessageGenerationEventKind;
    text?: string;
    errorKind?: CommitMessageGenerationCoordinatorErrorKind;
    superseded?: boolean;
}

/**
 * Stable host-lifetime event sink.
 *
 * @public P5 supplies one object per provider lifetime; object identity scopes cancellation ownership.
 */
export interface CommitMessageGenerationHost {
    emit(event: CommitMessageGenerationEvent): void;
}

/** Narrow Git facade required to acquire generation context and observe whole-index state. */
interface CommitMessageGenerationGitOps {
    getDiffForPaths(
        paths: string[],
        options: { includeHead?: boolean },
    ): Promise<DiffForPathsResult>;
    getRecentCommitSubjects(): Promise<string[]>;
    hasWholeIndexOperationInProgress(): Promise<boolean>;
}

/** Repository-bound dependencies captured once for every accepted generation request. */
export interface CommitMessageGenerationRootContext {
    workspaceFolder: vscode.WorkspaceFolder;
    gitOps: CommitMessageGenerationGitOps;
    watchWholeIndexOperation(onDidChange: () => void): vscode.Disposable;
}

/** Input owned by the host boundary after it has validated repository and path selection. */
export interface CommitMessageGenerationRequest {
    repositoryRoot: string;
    requestId: string;
    paths: string[];
    amend: boolean;
    host: CommitMessageGenerationHost;
}

/** Exact ownership key required for a user-requested cancellation. */
export interface CommitMessageGenerationCancellation {
    repositoryRoot: string;
    requestId: string;
    host: CommitMessageGenerationHost;
}

/** P3 preparation seam, injected by tests while defaulting to the real generator in production. */
export type PrepareCommitMessageGeneration = (
    options: PrepareCommitMessageGenerationOptions,
) => Promise<PreparedCommitMessageGeneration>;

/** Dependencies that bind the host-agnostic coordinator to repository context and P3 preparation. */
export interface CommitMessageGenerationCoordinatorDependencies {
    resolveRoot(repositoryRoot: string): CommitMessageGenerationRootContext;
    prepare?: PrepareCommitMessageGeneration;
}

/**
 * Coordinates root-keyed commit-message lifecycles while keeping host, provider, and webview concerns outside.
 *
 * @public P5 creates one shared instance and injects it into both provider hosts.
 */
export class CommitMessageGenerationCoordinator {
    private readonly activeByRoot = new Map<string, ActiveGenerationAttempt>();
    private readonly acquisitionTails = new Map<string, Promise<void>>();
    private readonly commitLeaseCounts = new Map<string, number>();
    private readonly prepare: PrepareCommitMessageGeneration;
    private disposed = false;

    /** Creates the coordinator with a root resolver and optional deterministic P3 preparation seam. */
    constructor(private readonly dependencies: CommitMessageGenerationCoordinatorDependencies) {
        this.prepare = dependencies.prepare ?? prepareCommitMessageGeneration;
    }

    /** Starts a root-keyed generation attempt and emits only structural lifecycle events to its host. */
    request(request: CommitMessageGenerationRequest): void {
        if (this.disposed) {
            request.host.emit({
                repositoryRoot: request.repositoryRoot,
                requestId: request.requestId,
                kind: "error",
                errorKind: "unknown",
            });
            return;
        }
        if ((this.commitLeaseCounts.get(request.repositoryRoot) ?? 0) > 0) {
            request.host.emit({
                repositoryRoot: request.repositoryRoot,
                requestId: request.requestId,
                kind: "error",
                errorKind: "commitInProgress",
            });
            return;
        }
        const previous = this.activeByRoot.get(request.repositoryRoot);
        if (previous) this.emitTerminal(previous, "cancelled", undefined, true);
        let context: CommitMessageGenerationRootContext;
        try {
            context = this.dependencies.resolveRoot(request.repositoryRoot);
        } catch {
            request.host.emit({
                repositoryRoot: request.repositoryRoot,
                requestId: request.requestId,
                kind: "error",
                errorKind: "unknown",
            });
            return;
        }
        const attempt: ActiveGenerationAttempt = {
            ...request,
            context,
            tokenSource: new vscode.CancellationTokenSource(),
            wholeIndexCheckTail: Promise.resolve(),
            wholeIndexSignalVersion: 0,
            active: true,
        };
        this.activeByRoot.set(request.repositoryRoot, attempt);
        try {
            attempt.watcher = context.watchWholeIndexOperation(() => {
                attempt.wholeIndexSignalVersion += 1;
                void this.recheckWholeIndexOperation(attempt);
            });
        } catch {
            this.emitTerminal(attempt, "error", "unknown");
            return;
        }
        void this.run(attempt);
    }

    /** Cancels one active attempt only when the root, request id, and host object all match. */
    cancel(cancellation: CommitMessageGenerationCancellation): void {
        const attempt = this.activeByRoot.get(cancellation.repositoryRoot);
        if (
            attempt &&
            attempt.requestId === cancellation.requestId &&
            attempt.host === cancellation.host
        ) {
            this.emitTerminal(attempt, "cancelled");
        }
    }

    /** Cancels every active attempt that belongs to the exact host object. */
    dropHost(host: CommitMessageGenerationHost): void {
        for (const attempt of [...this.activeByRoot.values()]) {
            if (attempt.host === host) this.emitTerminal(attempt, "cancelled");
        }
    }

    /** Acquires a root-scoped generation fence and returns an idempotent release callback. */
    acquireCommitLease(repositoryRoot: string): () => void {
        const count = this.commitLeaseCounts.get(repositoryRoot) ?? 0;
        this.commitLeaseCounts.set(repositoryRoot, count + 1);
        const active = this.activeByRoot.get(repositoryRoot);
        if (active) this.emitTerminal(active, "cancelled", undefined, true);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (this.commitLeaseCounts.get(repositoryRoot) ?? 1) - 1;
            if (remaining > 0) this.commitLeaseCounts.set(repositoryRoot, remaining);
            else this.commitLeaseCounts.delete(repositoryRoot);
        };
    }

    /** Cancels all active work and releases coordinator-owned resources. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const attempt of [...this.activeByRoot.values()])
            this.emitTerminal(attempt, "cancelled");
        this.commitLeaseCounts.clear();
    }

    private async run(attempt: ActiveGenerationAttempt): Promise<void> {
        try {
            if (await this.queueWholeIndexCheck(attempt)) {
                this.emitTerminal(attempt, "error", "operationInProgress");
                return;
            }
            if (!this.isActive(attempt)) return;
            this.scheduleAcquisition(attempt);
        } catch {
            if (this.isActive(attempt)) this.emitTerminal(attempt, "error", "unknown");
        }
    }

    private async recheckWholeIndexOperation(attempt: ActiveGenerationAttempt): Promise<void> {
        try {
            const inProgress = await this.queueWholeIndexCheck(attempt);
            if (inProgress && this.isActive(attempt)) this.emitTerminal(attempt, "cancelled");
        } catch {
            if (this.isActive(attempt)) this.emitTerminal(attempt, "error", "unknown");
        }
    }

    private queueWholeIndexCheck(attempt: ActiveGenerationAttempt): Promise<boolean> {
        const check = attempt.wholeIndexCheckTail.then(async () => {
            if (!this.isActive(attempt)) return false;
            return attempt.context.gitOps.hasWholeIndexOperationInProgress();
        });
        attempt.wholeIndexCheckTail = check.then(
            () => undefined,
            () => undefined,
        );
        return check;
    }

    private scheduleAcquisition(attempt: ActiveGenerationAttempt): void {
        const previous = this.acquisitionTails.get(attempt.repositoryRoot) ?? Promise.resolve();
        const acquisition = previous.then(
            () => this.acquire(attempt),
            () => this.acquire(attempt),
        );
        const retainedTail = acquisition.then(
            () => undefined,
            () => undefined,
        );
        this.acquisitionTails.set(attempt.repositoryRoot, retainedTail);
        void retainedTail.then(() => {
            if (this.acquisitionTails.get(attempt.repositoryRoot) === retainedTail) {
                this.acquisitionTails.delete(attempt.repositoryRoot);
            }
        });
        void acquisition.then(
            (context) => {
                if (context && this.isActive(attempt)) void this.prepareAndStream(attempt, context);
            },
            () => {
                if (this.isActive(attempt)) this.emitTerminal(attempt, "error", "unknown");
            },
        );
    }

    private async acquire(
        attempt: ActiveGenerationAttempt,
    ): Promise<{ diffResult: DiffForPathsResult; commitSubjects: string[] } | undefined> {
        if (!this.isActive(attempt)) return undefined;
        const diffResult = await attempt.context.gitOps.getDiffForPaths(attempt.paths, {
            includeHead: attempt.amend,
        });
        if (!this.isActive(attempt)) return undefined;
        const commitSubjects = await attempt.context.gitOps.getRecentCommitSubjects();
        if (!this.isActive(attempt)) return undefined;
        return { diffResult, commitSubjects };
    }

    private async prepareAndStream(
        attempt: ActiveGenerationAttempt,
        context: { diffResult: DiffForPathsResult; commitSubjects: string[] },
    ): Promise<void> {
        try {
            const prepared = await this.prepare({
                workspaceFolder: attempt.context.workspaceFolder,
                diffResult: context.diffResult,
                commitSubjects: context.commitSubjects,
                amend: attempt.amend,
                token: attempt.tokenSource.token,
            });
            if (!this.isActive(attempt)) return;
            attempt.host.emit({
                repositoryRoot: attempt.repositoryRoot,
                requestId: attempt.requestId,
                kind: "start",
            });
            for await (const text of prepared.text) {
                if (!this.isActive(attempt)) return;
                attempt.host.emit({
                    repositoryRoot: attempt.repositoryRoot,
                    requestId: attempt.requestId,
                    kind: "chunk",
                    text,
                });
            }
            await this.finalize(attempt);
        } catch (error) {
            if (!this.isActive(attempt)) return;
            const errorKind = toCoordinatorErrorKind(error);
            if (errorKind === "cancelled") this.emitTerminal(attempt, "cancelled");
            else this.emitTerminal(attempt, "error", errorKind);
        }
    }

    private async finalize(attempt: ActiveGenerationAttempt): Promise<void> {
        while (this.isActive(attempt)) {
            const signalVersion = attempt.wholeIndexSignalVersion;
            await attempt.wholeIndexCheckTail;
            if (!this.isActive(attempt)) return;
            const inProgress = await this.queueWholeIndexCheck(attempt);
            if (!this.isActive(attempt)) return;
            if (inProgress) {
                this.emitTerminal(attempt, "cancelled");
                return;
            }
            if (signalVersion === attempt.wholeIndexSignalVersion) {
                this.emitTerminal(attempt, "done");
                return;
            }
        }
    }

    private isActive(attempt: ActiveGenerationAttempt): boolean {
        return attempt.active && this.activeByRoot.get(attempt.repositoryRoot) === attempt;
    }

    private emitTerminal(
        attempt: ActiveGenerationAttempt,
        kind: "done" | "cancelled" | "error",
        errorKind?: CommitMessageGenerationCoordinatorErrorKind,
        superseded = false,
    ): void {
        if (!this.isActive(attempt)) return;
        attempt.active = false;
        this.activeByRoot.delete(attempt.repositoryRoot);
        if (attempt.watcher) {
            attempt.watcher.dispose();
            attempt.watcher = undefined;
        }
        if (kind !== "done") attempt.tokenSource.cancel();
        attempt.tokenSource.dispose();
        attempt.host.emit({
            repositoryRoot: attempt.repositoryRoot,
            requestId: attempt.requestId,
            kind,
            ...(errorKind ? { errorKind } : {}),
            ...(superseded ? { superseded: true } : {}),
        });
    }
}

type ActiveGenerationAttempt = CommitMessageGenerationRequest & {
    context: CommitMessageGenerationRootContext;
    tokenSource: vscode.CancellationTokenSource;
    watcher?: vscode.Disposable;
    wholeIndexCheckTail: Promise<void>;
    wholeIndexSignalVersion: number;
    active: boolean;
};

/** Translates only P3's documented stable errors; every unrelated failure remains unknown. */
function toCoordinatorErrorKind(
    error: unknown,
): CommitMessageGenerationCoordinatorErrorKind | "cancelled" {
    if (!(error instanceof GenerationRequestError)) return "unknown";
    return error.kind;
}
