// Host side of the Checks tab, shared by every webview host that renders the commit
// details pane. A reply is posted only while the world the request started in still
// exists: same repository on screen, same sign-in, same CI settings.

import * as vscode from "vscode";
import { isE2eControlChannelActive } from "../e2e/activationState";
import type { CiActionFenceStore } from "../services/commitChecks/ciActionFence";
import type { CiActionOutcome } from "../services/commitChecks/ciActions";
import type { CiGenerations, CiOperationContext } from "../services/commitChecks/ciGenerations";
import type { CiLogMemoryStore } from "../services/commitChecks/ciLogMemoryStore";
import type { CiLogTarget } from "../services/commitChecks/coordinator";
import type { CommitChecksFetchOptions } from "../services/commitChecks/service";
import type { CiActionRequest, CiLogJob } from "../services/commitChecks/types";
import { isValidGitHash } from "../services/gitHelpers";
import { PENDING_CHECK_RETRY_DELAYS_MS } from "../shared/ci/pollSchedule";
import type { CommitCiDetail } from "../types";
import type { CommitCiDetailMessage } from "../webviews/protocol/commitCiMessages";

/** What a host offers to answer a Checks tab request. */
export interface CommitCiDetailSource {
    /** Repository the host shows now; read again after every await. */
    repoKey(): string;
    generations?: CiGenerations;
    getDetail(
        hash: string,
        options: CommitChecksFetchOptions,
        ctx: CiOperationContext,
        onScanUpdate?: (detail: CommitCiDetail) => void,
    ): Promise<CommitCiDetail | undefined>;
    /** The window's CI logs; absent = the host answers no log message. */
    logs?: CiLogAccess;
    /** CI write actions and their fences; absent = the host answers no action message. */
    actions?: CiActionAccess;
}

/** A host's way to run CI write actions for the repository it shows. */
export interface CiActionAccess {
    /** The window's action fences; their changes re-post the shown detail. */
    fences: Pick<CiActionFenceStore, "fenceFor" | "onDidChange" | "onDidEnd">;
    run(
        hash: string,
        request: CiActionRequest,
        ctx: CiOperationContext,
        currentRepoKey: () => string,
    ): Promise<CiActionOutcome>;
    /** The Refresh button: ends a "not seen yet" fence, then fetches with `force`. */
    refresh(
        hash: string,
        ctx: CiOperationContext,
        onScanUpdate?: (detail: CommitCiDetail) => void,
    ): Promise<CommitCiDetail | undefined>;
    /** The docs page on tokens that can re-run or cancel; absent when it cannot be named. */
    helpUrl?: string;
}

/** A host's way to the window's log store for the repository it shows. */
interface CiLogAccess {
    store: CiLogMemoryStore;
    /** The store key and download record of a job's log; undefined when no provider has logs. */
    target(hash: string, job: CiLogJob, ctx: CiOperationContext): Promise<CiLogTarget | undefined>;
}

/**
 * Validates a `requestCommitCiDetail` message, fetches the detail and posts the reply,
 * dropping it when the repository, sign-in or CI settings changed meanwhile. While a run's
 * failed-job overflow scan is running or paused, its progress is re-posted under the same
 * request id after each scan page and on the pending ladder until the scan finishes or stops,
 * or the loop is cancelled.
 *
 * @param source - The host's repository, generations and detail fetch.
 * @param msg - Untrusted webview message.
 * @param post - Delivers the reply to the webview that asked.
 * @param loops - The asking webview's loops; this request's loop replaces the running one.
 * @throws When a field of the message is malformed.
 */
export async function answerCommitCiDetailRequest(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
    post: (reply: CommitCiDetailMessage) => void,
    loops: CommitCiDetailLoops,
): Promise<void> {
    const { requestId, repoKey, hash, force } = msg;
    if (typeof requestId !== "number" || !Number.isSafeInteger(requestId)) {
        throw new Error("Invalid CI detail request id.");
    }
    if (typeof repoKey !== "string") throw new Error("Invalid CI detail repository.");
    if (typeof hash !== "string" || !isValidGitHash(hash)) {
        throw new Error("Invalid CI detail hash.");
    }
    if (force !== undefined && typeof force !== "boolean") {
        throw new Error("Invalid CI detail force flag.");
    }
    // The Checks tab switch (see `isChecksTabEnabled` in the webview's checksTabState.ts): while
    // the tab is hidden, no message may start a CI detail fetch or its overflow scan.
    if (!isE2eControlChannelActive()) return;
    if (repoKey !== source.repoKey()) return;
    const stopped = loops.start(requestId);
    const ctx: CiOperationContext = source.generations?.capture(repoKey) ?? {
        repoKey,
        authGeneration: 0,
        lifecycleGeneration: 0,
    };
    const isCurrent = (): boolean => {
        if (stopped.aborted) return false;
        const currentRepoKey = source.repoKey();
        return source.generations
            ? source.generations.isCurrent(ctx, currentRepoKey)
            : repoKey === currentRepoKey;
    };
    // Each overflow-scan page re-posts at once while this request is still the loop's newest,
    // and becomes the shown detail a fence change re-posts.
    let detail: CommitCiDetail | undefined;
    const onScanUpdate = (update: CommitCiDetail): void => {
        if (!isCurrent()) return;
        detail = update;
        post({ type: "commitCiDetail", requestId, repoKey, hash, detail: update });
    };
    detail =
        force === true && source.actions
            ? await source.actions.refresh(hash, ctx, onScanUpdate)
            : await source.getDetail(hash, { force: force === true }, ctx, onScanUpdate);
    if (!isCurrent()) return;
    post({ type: "commitCiDetail", requestId, repoKey, hash, detail: detail ?? null });
    if (source.actions) {
        repostOnFenceChange(source.actions.fences, stopped, repoKey, hash, {
            shown: () => detail,
            post: (update) => {
                if (!isCurrent()) return;
                detail = update;
                post({ type: "commitCiDetail", requestId, repoKey, hash, detail: update });
            },
            refetch: () => source.getDetail(hash, { force: false }, ctx, onScanUpdate),
        });
    }
    // The scan pages reach only the newest requester of a commit's detail, so its progress is
    // also re-read and re-posted under the same request id until the scan ends: another view
    // asking for the same commit takes the page updates over. A newer request or a hidden tab
    // stops the loop, its pending wait included. A failed forced Refresh is never retried on
    // its own: its error stays shown until the next one.
    for (let rung = 0; scanInProgress(detail) && detail?.refreshError === undefined; rung += 1) {
        const delays = PENDING_CHECK_RETRY_DELAYS_MS;
        await sleep(delays[Math.min(rung, delays.length - 1)], stopped);
        if (!isCurrent()) return;
        detail = await source.getDetail(hash, { force: false }, ctx, onScanUpdate);
        if (!isCurrent()) return;
        post({ type: "commitCiDetail", requestId, repoKey, hash, detail: detail ?? null });
    }
}

/**
 * One per webview: the scan re-post loop of its newest Checks tab request. A newer request,
 * a cancel for that request (tab hidden, pane gone) or the view's disposal stops it.
 */
export class CommitCiDetailLoops {
    private current: { requestId: number; controller: AbortController } | undefined;

    /** Stops the running loop and returns the signal that stops this request's loop. */
    start(requestId: number): AbortSignal {
        this.dispose();
        const controller = new AbortController();
        this.current = { requestId, controller };
        return controller.signal;
    }

    /**
     * Stops the loop of `requestId` if it is still the newest; a late cancel is ignored.
     *
     * @param requestId - Untrusted id from a `cancelCommitCiDetail` message.
     * @throws When the id is not a safe integer.
     */
    cancel(requestId: unknown): void {
        if (typeof requestId !== "number" || !Number.isSafeInteger(requestId)) {
            throw new Error("Invalid CI detail request id.");
        }
        if (this.current?.requestId === requestId) this.dispose();
    }

    /** Stops whatever loop is running (the view was disposed). */
    dispose(): void {
        this.current?.controller.abort();
        this.current = undefined;
    }
}

/** Waits `ms`, or less when `signal` aborts first; never leaves a timer or listener behind. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(finish, ms);
        signal.addEventListener("abort", finish, { once: true });
        function finish(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        }
    });
}

/**
 * Re-posts the shown detail under the request's id while it is the newest: a fence switching
 * to "not seen yet" re-posts it with the new label and no request; a fence that ended re-reads
 * it (from the cache the ending fetch filled), since the shown copy predates that fetch.
 */
function repostOnFenceChange(
    fences: CiActionAccess["fences"],
    stopped: AbortSignal,
    repoKey: string,
    hash: string,
    view: {
        shown(): CommitCiDetail | undefined;
        post(detail: CommitCiDetail): void;
        refetch(): Promise<CommitCiDetail | undefined>;
    },
): void {
    if (stopped.aborted) return;
    const changed = fences.onDidChange((change) => {
        const shown = view.shown();
        if (stopped.aborted || !shown || change.repoKey !== repoKey || change.hash !== hash) return;
        const next = { ...shown };
        delete next.actionFence;
        const actionFence = fences.fenceFor(repoKey, hash);
        if (actionFence) next.actionFence = actionFence;
        view.post(next);
    });
    const ended = fences.onDidEnd(async (endedHash) => {
        if (stopped.aborted || endedHash !== hash) return;
        const update = await view.refetch();
        if (update && !stopped.aborted) view.post(update);
    });
    stopped.addEventListener(
        "abort",
        () => {
            changed.dispose();
            ended.dispose();
        },
        { once: true },
    );
}

/** Whether a run is still looking for failed jobs past its page bound. */
function scanInProgress(detail: CommitCiDetail | undefined): boolean {
    return (
        detail?.runs.some(
            ({ failedScan }) => failedScan?.state === "running" || failedScan?.state === "paused",
        ) ?? false
    );
}

/** Opens the Settings editor on the commit-checks settings (the Checks tab's turned-off state). */
export async function openCommitChecksSettings(): Promise<void> {
    await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "intelligit.commitChecks",
    );
}
