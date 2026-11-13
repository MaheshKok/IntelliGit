// Host side of the Checks tab's write actions (re-run failed, re-run job, cancel run), shared
// by every webview host that renders the commit details pane.

import { isE2eControlChannelActive } from "../e2e/activationState";
import type { CiActionFenceStore } from "../services/commitChecks/ciActionFence";
import {
    refreshCiDetail,
    runCiAction,
    type CiActionDeps,
} from "../services/commitChecks/ciActions";
import type { CiOperationContext } from "../services/commitChecks/ciGenerations";
import { isValidGitHash } from "../services/gitHelpers";
import type { CiAction } from "../types";
import type { CiActionResultMessage } from "../webviews/protocol/commitCiMessages";
import type { CiActionAccess, CommitCiDetailSource } from "./ciDetailHandler";

const ACTIONS: ReadonlySet<string> = new Set<CiAction>(["rerunFailed", "rerunJob", "cancel"]);

/** What a host needs to offer CI write actions: the window's fences and the token help page. */
export interface CiActionOptions {
    fences: CiActionFenceStore;
    /** The docs page on tokens that can re-run or cancel; absent when it cannot be named. */
    helpUrl?: string;
}

/**
 * The action access of a host's Checks tab over its own coordinator.
 *
 * @param coordinator - The host's coordinator for the repository it shows.
 * @param options - The window's fences and token help page.
 */
export function ciActionAccess(
    coordinator: CiActionDeps["coordinator"],
    options: CiActionOptions,
): CiActionAccess {
    const deps = { coordinator, fences: options.fences };
    return {
        fences: options.fences,
        run: (hash, request, ctx, currentRepoKey) =>
            runCiAction(deps, hash, request, ctx, currentRepoKey),
        refresh: (hash, ctx, onScanUpdate) => refreshCiDetail(deps, hash, ctx, onScanUpdate),
        ...(options.helpUrl !== undefined && { helpUrl: options.helpUrl }),
    };
}

/**
 * Validates a `runCiAction` message, runs the action once and posts its outcome. The reply is
 * dropped when the repository, sign-in or CI settings changed meanwhile; the action itself is
 * never sent again.
 *
 * @param source - The host's repository, generations and action access.
 * @param msg - Untrusted webview message.
 * @param post - Delivers the reply to the webview that asked.
 * @throws When a field of the message is malformed.
 */
export async function answerCiActionMessage(
    source: CommitCiDetailSource,
    msg: Record<string, unknown>,
    post: (reply: CiActionResultMessage) => void,
): Promise<void> {
    const { requestId, repoKey, hash, action, runId, jobId } = msg;
    if (typeof requestId !== "number" || !Number.isSafeInteger(requestId)) {
        throw new Error("Invalid CI action request id.");
    }
    if (typeof repoKey !== "string") throw new Error("Invalid CI action repository.");
    if (typeof hash !== "string" || !isValidGitHash(hash))
        throw new Error("Invalid CI action hash.");
    if (typeof action !== "string" || !ACTIONS.has(action)) throw new Error("Invalid CI action.");
    if (typeof runId !== "string" || runId === "") throw new Error("Invalid CI action run.");
    if (action === "rerunJob" ? typeof jobId !== "string" || jobId === "" : jobId !== undefined) {
        throw new Error("Invalid CI action job.");
    }
    if (!isE2eControlChannelActive()) return;
    const actions = source.actions;
    if (!actions || repoKey !== source.repoKey()) return;
    const ctx: CiOperationContext = source.generations?.capture(repoKey) ?? {
        repoKey,
        authGeneration: 0,
        lifecycleGeneration: 0,
    };
    const result = await actions.run(
        hash,
        {
            action: action as CiAction,
            runId,
            ...(jobId !== undefined && { jobId: jobId as string }),
        },
        ctx,
        () => source.repoKey(),
    );
    const currentRepoKey = source.repoKey();
    const current = source.generations
        ? source.generations.isCurrent(ctx, currentRepoKey)
        : repoKey === currentRepoKey;
    if (!current) return;
    post({
        type: "ciActionResult",
        requestId,
        repoKey,
        hash,
        ...result,
        ...(result.outcome === "forbidden" &&
            actions.helpUrl !== undefined && { helpUrl: actions.helpUrl }),
    });
}
