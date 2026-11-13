// CI write actions (re-run failed, re-run job, cancel run). The action fence is written and
// awaited before the one request is sent; a definite failure deletes it, while `ok` or an
// unknown outcome keeps it and drops the commit from every cache before a forced fetch. The
// fence's stored evidence rule then decides when a fetched result shows the action took effect.

import * as vscode from "vscode";
import type { CommitCiDetail } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { evidenceFor, type CiActionFenceStart, type CiActionFenceStore } from "./ciActionFence";
import type { CiOperationContext } from "./ciGenerations";
import type { CommitChecksCoordinator } from "./coordinator";
import { HttpError } from "./http";
import type { CiActionRequest } from "./types";

/** What one action ended as; `message` is shown inline for `failed`. */
export type CiActionOutcome =
    | { readonly outcome: "ok" | "uncertain" | "forbidden" }
    | { readonly outcome: "failed"; readonly message: string };

/** The window's coordinator for the repository and its action fence store. */
export interface CiActionDeps {
    readonly coordinator: Pick<
        CommitChecksCoordinator,
        "actionTarget" | "getChecks" | "getDetail" | "invalidate"
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
 */
export async function runCiAction(
    deps: CiActionDeps,
    hash: string,
    request: CiActionRequest,
    ctx: CiOperationContext,
): Promise<CiActionOutcome> {
    const changed = failed(vscode.l10n.t("Remote data changed. Reload and try again."));
    let match;
    let current: CommitCiDetail | undefined;
    try {
        match = await deps.coordinator.actionTarget(hash);
        current = await deps.coordinator.getDetail(hash, {}, ctx);
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
        before: {
            ...(run.attempt !== undefined && { attempt: run.attempt }),
            state: run.state,
            ...(evidence === "newerJobSameLogicalId" &&
                job && { jobId: job.id, logicalId: job.logicalId }),
            ...(evidence === "newerJobInPipeline" && { maxJobId: maxJobId(run.jobs) }),
        },
    };
    let fenced = false;
    try {
        await provider.runAction(match.ref, request, async () => {
            await deps.fences.begin(start);
            fenced = true;
        });
    } catch (err) {
        // A failure before the fence (cooldown, signed out, fence write refused) sent nothing.
        if (!fenced) return failed(signInOr(err, match.ref.host));
        if (!(err instanceof HttpError)) {
            await refetch(deps, hash, ctx);
            return { outcome: "uncertain" };
        }
        await failFence(deps, start);
        return err.statusCode === 403
            ? { outcome: "forbidden" }
            : failed(signInOr(err, match.ref.host));
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
    if (fence?.notSeen && (await deps.fences.endByUserRefresh(ctx.repoKey, hash, fence.targetId))) {
        await invalidateQuietly(deps, hash);
    }
    return deps.coordinator.getDetail(hash, { force: true }, ctx, onScanUpdate);
}

function failed(message: string): CiActionOutcome {
    return { outcome: "failed", message };
}

/** A 401 asks to sign in again; any other error shows its own token-free message. */
function signInOr(err: unknown, host: string): string {
    if (err instanceof HttpError && err.statusCode === 401) {
        return vscode.l10n.t("Sign in to {host} to view commit checks.", { host });
    }
    return getErrorMessage(err);
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
