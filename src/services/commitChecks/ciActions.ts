// CI write actions (re-run failed, re-run job, cancel run). The action fence is written and
// awaited before the one request is sent; a definite failure deletes it, while `ok` or an
// unknown outcome keeps it and drops the commit from every cache before a forced fetch. The
// fence's stored evidence rule then decides when a fetched result shows the action took effect.

import * as vscode from "vscode";
import type { CiActionEvidence, CiJob, CiRun, CommitCiDetail } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { evidenceFor, type CiActionFenceStart, type CiActionFenceStore } from "./ciActionFence";
import type { CiOperationContext } from "./ciGenerations";
import type { CommitChecksCoordinator } from "./coordinator";
import { HttpError, RequestNotSentError } from "./http";
import type { CiActionRequest } from "./types";

/**
 * What one action ended as; `message` is shown inline for `failed` and `signedOut` (a 401: the
 * pane then reads the signed-out detail and offers the sign-in button).
 */
export type CiActionOutcome =
    | { readonly outcome: "ok" | "uncertain" | "forbidden" }
    | { readonly outcome: "failed" | "signedOut"; readonly message: string };

/** The window's coordinator for the repository and its action fence store. */
export interface CiActionDeps {
    readonly coordinator: Pick<
        CommitChecksCoordinator,
        "actionTarget" | "actionGuard" | "getChecks" | "getDetail" | "invalidate"
    >;
    readonly fences: Pick<CiActionFenceStore, "begin" | "fail" | "fenceFor" | "endByUserRefresh">;
}

/**
 * Runs one write action for a commit. Sends at most one request and never retries it.
 *
 * @param deps - The repository's coordinator and the window's fence store.
 * @param hash - The commit whose run or job the action targets.
 * @param request - The action and its run (and job, for `rerunJob`) as the detail names them.
 * @param ctx - The operation's context; its repository keys the fence.
 * @param currentRepoKey - The repository the surface shows now, read again right before the
 *   request is sent.
 */
export async function runCiAction(
    deps: CiActionDeps,
    hash: string,
    request: CiActionRequest,
    ctx: CiOperationContext,
    currentRepoKey: () => string = () => ctx.repoKey,
): Promise<CiActionOutcome> {
    const changed = failed(vscode.l10n.t("Remote data changed. Reload and try again."));
    const stillCurrent = deps.coordinator.actionGuard(ctx, currentRepoKey);
    let match;
    let current: CommitCiDetail | undefined;
    try {
        match = await deps.coordinator.actionTarget(hash);
        current = await freshBaseline(deps, hash, ctx);
    } catch (err) {
        return failed(getErrorMessage(err));
    }
    const provider = match?.provider;
    const evidence = provider && evidenceFor(provider, request.action);
    if (!match || !provider?.runAction || !provider.capabilities[request.action] || !evidence) {
        return failed(vscode.l10n.t("This provider cannot re-run or cancel CI runs."));
    }
    const run = current?.runs.find((candidate) => candidate.id === request.runId);
    const job =
        request.action === "rerunJob"
            ? run?.jobs.find((candidate) => candidate.id === request.jobId)
            : undefined;
    if (!run || (request.action === "rerunJob" && !job)) return changed;

    const start: CiActionFenceStart = {
        repoKey: ctx.repoKey,
        hash,
        provider: provider.id,
        action: request.action,
        targetId: job?.id ?? run.id,
        runId: run.id,
        evidence,
        before: beforeOf(run, job, evidence),
    };
    let fenced = false;
    let stale = false;
    try {
        await provider.runAction(match.ref, request, async () => {
            await deps.fences.begin(start);
            fenced = true;
            // Runs once the request gate admitted the write: the sign-in or repository may have
            // changed while it queued or while the fence was written, so send nothing then.
            if (!stillCurrent()) {
                stale = true;
                throw new Error("Remote data changed.");
            }
        });
    } catch (err) {
        if (stale) {
            await failFence(deps, start);
            return changed;
        }
        // A failure before the fence (cooldown, signed out, fence write refused) sent nothing.
        if (!fenced) return refused(deps, hash, ctx, err, match.ref.host);
        if (err instanceof RequestNotSentError) {
            await failFence(deps, start);
            return err.superseded ? changed : failed(getErrorMessage(err));
        }
        if (!definiteHttpFailure(err)) {
            await refetch(deps, hash, ctx);
            return { outcome: "uncertain" };
        }
        await failFence(deps, start);
        return err.statusCode === 403
            ? { outcome: "forbidden" }
            : refused(deps, hash, ctx, err, match.ref.host);
    }
    await refetch(deps, hash, ctx);
    return { outcome: "ok" };
}

/**
 * The user's Refresh on the Checks tab: a target that reads "not seen yet" ends its fence
 * first, so the fetched result is shown and cached by the normal rules; before that the
 * fence stays.
 *
 * @param deps - The repository's coordinator and the window's fence store.
 * @param hash - The commit shown.
 * @param ctx - The operation's context.
 * @param onScanUpdate - Receives the detail again after each failed-job overflow scan page.
 */
export async function refreshCiDetail(
    deps: Pick<CiActionDeps, "coordinator" | "fences">,
    hash: string,
    ctx: CiOperationContext,
    onScanUpdate?: (detail: CommitCiDetail) => void,
): Promise<CommitCiDetail | undefined> {
    const fence = deps.fences.fenceFor(ctx.repoKey, hash);
    if (fence && (await deps.fences.endByUserRefresh(ctx.repoKey, hash, fence.targetId))) {
        await invalidateQuietly(deps, hash);
    }
    return deps.coordinator.getDetail(hash, { force: true }, ctx, onScanUpdate);
}

/** What the target looked like when the action started, as far as its evidence rule needs. */
function beforeOf(
    run: CiRun,
    job: CiJob | undefined,
    evidence: CiActionEvidence,
): CiActionFenceStart["before"] {
    return {
        ...(run.attempt !== undefined && { attempt: run.attempt }),
        state: run.state,
        ...(evidence === "newerJobSameLogicalId" &&
            job && { jobId: job.id, logicalId: job.logicalId }),
        ...(evidence === "newerJobInPipeline" && { maxJobId: maxJobId(run.jobs) }),
    };
}

/**
 * The click-time detail the fence's baseline comes from, read fresh so it never predates an
 * external re-run. A failed fresh read (served from the cache, or with nothing cached the
 * provider's unavailable detail) throws instead, carrying the provider's error.
 */
async function freshBaseline(
    deps: CiActionDeps,
    hash: string,
    ctx: CiOperationContext,
): Promise<CommitCiDetail | undefined> {
    const detail = await deps.coordinator.getDetail(hash, { force: true }, ctx);
    if (detail?.refreshError !== undefined || detail?.outcome === "unavailable") {
        throw new Error(
            detail.refreshError ||
                detail.error ||
                vscode.l10n.t("Remote data changed. Reload and try again."),
        );
    }
    return detail;
}

/**
 * Whether a sent request's error is a definite refusal: an HTTP status below 500. Anything
 * without a status, or a server-side (5xx) status, leaves the effect unknown, since the provider
 * may have started the action before failing.
 */
function definiteHttpFailure(err: unknown): err is HttpError {
    return err instanceof HttpError && err.statusCode < 500;
}

function failed(message: string): CiActionOutcome {
    return { outcome: "failed", message };
}

/**
 * A definite failure that is not a missing permission. A 401 means the credential is gone: the
 * commit is dropped from every cache and read again, so the detail the pane asks for next is the
 * existing signed-out one; any other error shows its own token-free message.
 */
async function refused(
    deps: CiActionDeps,
    hash: string,
    ctx: CiOperationContext,
    err: unknown,
    host: string,
): Promise<CiActionOutcome> {
    if (!(err instanceof HttpError) || err.statusCode !== 401) return failed(getErrorMessage(err));
    await refetch(deps, hash, ctx);
    return {
        outcome: "signedOut",
        message: vscode.l10n.t("Sign in to {host} to view commit checks.", { host }),
    };
}

async function failFence(deps: CiActionDeps, start: CiActionFenceStart): Promise<void> {
    try {
        await deps.fences.fail(start.repoKey, start.hash, start.targetId);
    } catch {
        // The removal could not be stored: the fence stays, reads "not seen yet" after
        // 10 minutes, and the user's Refresh then ends it.
    }
}

/** Drops the commit from every cache, then fetches the snapshot and the detail again. */
async function refetch(deps: CiActionDeps, hash: string, ctx: CiOperationContext): Promise<void> {
    await invalidateQuietly(deps, hash);
    await Promise.allSettled([
        deps.coordinator.getChecks(hash, { force: true }),
        deps.coordinator.getDetail(hash, { force: true }, ctx),
    ]);
}

async function invalidateQuietly(
    deps: Pick<CiActionDeps, "coordinator">,
    hash: string,
): Promise<void> {
    try {
        await deps.coordinator.invalidate(hash);
    } catch {
        // A stored entry that could not be deleted is never served while a fence lasts
        // (fenced commits skip persisted reads), and the forced fetch that follows writes over it.
    }
}

/** The highest numeric job id in the pipeline; a retried job is created with a higher one. */
function maxJobId(jobs: readonly { readonly id: string }[]): string | undefined {
    let max: string | undefined;
    for (const { id } of jobs) {
        if (/^\d+$/.test(id) && (max === undefined || BigInt(id) > BigInt(max))) max = id;
    }
    return max;
}
