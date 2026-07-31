import * as vscode from "vscode";
import { GenerationRequestError, prepareCommitMessageGeneration } from "./commitMessageGenerator";
import type {
    PrepareCommitMessageGenerationOptions,
    PreparedCommitMessageGeneration,
} from "./commitMessageGenerator";
import type { DiffForPathsResult } from "../git/operations";
import type { WorkingFile } from "../types";

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
    | "commitInProgress"
    | "invalidRequest";

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
        options: { includeHead?: boolean; validatedStatusSnapshot: readonly WorkingFile[] },
    ): Promise<DiffForPathsResult>;
    getRecentCommitSubjects(): Promise<string[]>;
    hasWholeIndexOperationInProgress(): Promise<boolean>;
}

/** Repository-bound dependencies captured once for every accepted generation request. */
export interface CommitMessageGenerationRootContext {
    workspaceFolder: vscode.WorkspaceFolder;
    gitOps: CommitMessageGenerationGitOps;
    /** Routes asynchronous watcher failures through the owning generation lifecycle. */
    watchWholeIndexOperation(
        onDidChange: () => void,
        onDidError?: (error: unknown) => void,
    ): vscode.Disposable;
}

/** Input owned by the host boundary after it has validated repository and path selection. */
export interface CommitMessageGenerationRequest {
    repositoryRoot: string;
    requestId: string;
    paths: string[];
    amend: boolean;
    /** Exact fresh status snapshot already validated by the host boundary. */
    validatedStatusSnapshot: readonly WorkingFile[];
    host: CommitMessageGenerationHost;
}

/** Read-only lifecycle control supplied to one asynchronous host validation callback. */
interface CommitMessageGenerationValidationControl {
    /** Returns false immediately after cancellation, supersession, a host drop, or a commit lease. */
    isActive(): boolean;
}

/** Exact host-validated input promoted atomically into diff acquisition. */
export interface ValidatedCommitMessageGenerationRequest {
    paths: string[];
    amend: boolean;
    validatedStatusSnapshot: readonly WorkingFile[];
}

/**
 * Registers a correlated attempt before a host starts its asynchronous validation.
 *
 * The validation callback must return no result for a rejected request and check its control after every await.
 */
export interface CommitMessageGenerationSubmission {
    repositoryRoot: string;
    requestId: string;
    host: CommitMessageGenerationHost;
    validate(
        control: CommitMessageGenerationValidationControl,
    ): Promise<ValidatedCommitMessageGenerationRequest | undefined>;
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

    /** Starts a legacy prevalidated request through the same serialized submission lifecycle. */
    request(request: CommitMessageGenerationRequest): void {
        this.submit({
            repositoryRoot: request.repositoryRoot,
            requestId: request.requestId,
            host: request.host,
            validate: () =>
                Promise.resolve({
                    paths: request.paths,
                    amend: request.amend,
                    validatedStatusSnapshot: request.validatedStatusSnapshot,
                }),
        });
    }

    /** Registers a root-keyed attempt before asynchronous host validation and streams only lifecycle events. */
    submit(submission: CommitMessageGenerationSubmission): void {
        if (this.disposed) {
            submission.host.emit({
                repositoryRoot: submission.repositoryRoot,
                requestId: submission.requestId,
                kind: "error",
                errorKind: "unknown",
            });
            return;
        }
        if ((this.commitLeaseCounts.get(submission.repositoryRoot) ?? 0) > 0) {
            submission.host.emit({
                repositoryRoot: submission.repositoryRoot,
                requestId: submission.requestId,
                kind: "error",
                errorKind: "commitInProgress",
            });
            return;
        }
        const previous = this.activeByRoot.get(submission.repositoryRoot);
        if (previous) this.emitTerminal(previous, "cancelled", undefined, true);
        let context: CommitMessageGenerationRootContext;
        try {
            context = this.dependencies.resolveRoot(submission.repositoryRoot);
        } catch (error) {
            logCoordinatorFailure(error);
            submission.host.emit({
                repositoryRoot: submission.repositoryRoot,
                requestId: submission.requestId,
                kind: "error",
                errorKind: "unknown",
            });
            return;
        }
        const attempt: ActiveGenerationAttempt = {
            ...submission,
            context,
            tokenSource: new vscode.CancellationTokenSource(),
            wholeIndexCheckTail: Promise.resolve(),
            wholeIndexSignalVersion: 0,
            active: true,
        };
        this.activeByRoot.set(submission.repositoryRoot, attempt);
        try {
            attempt.watcher = context.watchWholeIndexOperation(
                () => {
                    attempt.wholeIndexSignalVersion += 1;
                    void this.recheckWholeIndexOperation(attempt);
                },
                (error) => {
                    if (!this.isActive(attempt)) return;
                    logCoordinatorFailure(error);
                    this.emitTerminal(attempt, "error", "unknown");
                },
            );
        } catch (error) {
            logCoordinatorFailure(error);
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

    /** Cancels one active attempt only when both the host and repository root match exactly. */
    dropHostRoot(host: CommitMessageGenerationHost, repositoryRoot: string): void {
        const attempt = this.activeByRoot.get(repositoryRoot);
        if (attempt?.host === host) this.emitTerminal(attempt, "cancelled");
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
        } catch (error) {
            logCoordinatorFailure(error);
            if (this.isActive(attempt)) this.emitTerminal(attempt, "error", "unknown");
        }
    }

    private async recheckWholeIndexOperation(attempt: ActiveGenerationAttempt): Promise<void> {
        try {
            const inProgress = await this.queueWholeIndexCheck(attempt);
            if (inProgress && this.isActive(attempt)) this.emitTerminal(attempt, "cancelled");
        } catch (error) {
            logCoordinatorFailure(error);
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
            () => this.validateAndAcquire(attempt),
            () => this.validateAndAcquire(attempt),
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
            (error) => {
                logCoordinatorFailure(error);
                if (this.isActive(attempt)) this.emitTerminal(attempt, "error", "unknown");
            },
        );
    }

    private async validateAndAcquire(
        attempt: ActiveGenerationAttempt,
    ): Promise<AcquiredCommitMessageGenerationContext | undefined> {
        if (!this.isActive(attempt)) return undefined;
        let validation: ValidatedCommitMessageGenerationRequest | undefined;
        try {
            validation = await attempt.validate({ isActive: () => this.isActive(attempt) });
        } catch (error) {
            logCoordinatorFailure(error);
            if (this.isActive(attempt)) this.emitTerminal(attempt, "error", "invalidRequest");
            return undefined;
        }
        if (!this.isActive(attempt)) return undefined;
        if (!validation) {
            this.emitTerminal(attempt, "error", "invalidRequest");
            return undefined;
        }
        return this.acquire(attempt, validation);
    }

    private async acquire(
        attempt: ActiveGenerationAttempt,
        validation: ValidatedCommitMessageGenerationRequest,
    ): Promise<AcquiredCommitMessageGenerationContext | undefined> {
        if (!this.isActive(attempt)) return undefined;
        // The post-await active check is the cancellation fence for this request.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const diffResult = await attempt.context.gitOps.getDiffForPaths(validation.paths, {
            includeHead: validation.amend,
            validatedStatusSnapshot: validation.validatedStatusSnapshot,
        });
        if (!this.isActive(attempt)) return undefined;
        // The post-await active check is the cancellation fence for this request.
        // react-doctor-disable-next-line react-doctor/async-defer-await
        const commitSubjects = await attempt.context.gitOps.getRecentCommitSubjects();
        if (!this.isActive(attempt)) return undefined;
        return { diffResult, commitSubjects, amend: validation.amend };
    }

    private async prepareAndStream(
        attempt: ActiveGenerationAttempt,
        context: AcquiredCommitMessageGenerationContext,
    ): Promise<void> {
        try {
            // The post-await active check is the cancellation fence for this request.
            // react-doctor-disable-next-line react-doctor/async-defer-await
            const prepared = await this.prepare({
                workspaceFolder: attempt.context.workspaceFolder,
                diffResult: context.diffResult,
                commitSubjects: context.commitSubjects,
                amend: context.amend,
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
            else {
                if (errorKind === "unknown") logCoordinatorFailure(error);
                this.emitTerminal(attempt, "error", errorKind);
            }
        }
    }

    private async finalize(attempt: ActiveGenerationAttempt): Promise<void> {
        while (this.isActive(attempt)) {
            const signalVersion = attempt.wholeIndexSignalVersion;
            // Finalization intentionally serializes whole-index checks and cancellation fences.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop, react-doctor/async-defer-await
            await attempt.wholeIndexCheckTail;
            if (!this.isActive(attempt)) return;
            // The post-await active check is the cancellation fence for this request.
            // react-doctor-disable-next-line react-doctor/async-defer-await
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

type ActiveGenerationAttempt = CommitMessageGenerationSubmission & {
    context: CommitMessageGenerationRootContext;
    tokenSource: vscode.CancellationTokenSource;
    watcher?: vscode.Disposable;
    wholeIndexCheckTail: Promise<void>;
    wholeIndexSignalVersion: number;
    active: boolean;
};

interface AcquiredCommitMessageGenerationContext {
    diffResult: DiffForPathsResult;
    commitSubjects: string[];
    amend: boolean;
}

/** Logs the original internal failure without widening the correlated host error surface. */
function logCoordinatorFailure(error: unknown): void {
    console.warn("[intelligit] Commit-message generation failed:", error);
}

/** Translates only P3's documented stable errors; every unrelated failure remains unknown. */
function toCoordinatorErrorKind(
    error: unknown,
): CommitMessageGenerationCoordinatorErrorKind | "cancelled" {
    if (!(error instanceof GenerationRequestError)) return "unknown";
    return error.kind;
}
