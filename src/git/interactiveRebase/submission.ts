import type { GitExecutor } from "../executor";
import { evaluateInteractiveRebaseGuards } from "./guards";
import { validateRebaseSubmission } from "./todo";
import type {
    InteractiveRebaseSubmissionResult,
    PendingRebaseDialogRequests,
    RebaseSubmissionEntry,
} from "./types";

/** Creates the pure host-side handler for one-shot interactive-rebase dialog messages. */
export function createInteractiveRebaseSubmissionHandler(deps: {
    executor: GitExecutor;
    pendingRebaseDialogRequests: PendingRebaseDialogRequests;
    getRepoRoot: () => string;
    hasWholeIndexOperationInProgress: () => Promise<boolean>;
}): {
    submit: (
        message: { requestId: string; entries: readonly RebaseSubmissionEntry[] },
        originProvider: object,
    ) => Promise<InteractiveRebaseSubmissionResult>;
    cancel: (message: { requestId: string }, originProvider: object) => boolean;
} {
    return {
        async submit(message, originProvider) {
            const consumed = deps.pendingRebaseDialogRequests.consume(
                message.requestId,
                originProvider,
            );
            if (consumed.status === "rejected") return consumed;

            const { request } = consumed;
            if (deps.getRepoRoot() !== request.repoRoot) return rejected("repo-changed");
            const validation = validateRebaseSubmission(
                message.entries,
                new Set(request.rangeHashes),
            );
            if (validation.status === "invalid") return rejected(validation.reason);

            let branch: string;
            try {
                branch = (await deps.executor.run(["symbolic-ref", "--quiet", "HEAD"])).trim();
            } catch {
                return rejected("branch-unavailable");
            }
            if (branch !== request.expectedBranch) return rejected("branch-moved");

            let head: string;
            try {
                head = (await deps.executor.run(["rev-parse", "HEAD"])).trim();
            } catch {
                return rejected("head-unavailable");
            }
            if (head !== request.expectedHead) return rejected("head-moved");

            const guards = await evaluateInteractiveRebaseGuards({
                executor: deps.executor,
                selectedHash: request.baseHash,
                hasWholeIndexOperationInProgress: deps.hasWholeIndexOperationInProgress,
            });
            if (guards.status === "rejected") return guards;

            return { status: "accepted", request, entries: validation.entries };
        },
        cancel(message, originProvider) {
            return (
                deps.pendingRebaseDialogRequests.consume(message.requestId, originProvider)
                    .status === "consumed"
            );
        },
    };
}

function rejected(
    reason: Extract<InteractiveRebaseSubmissionResult, { status: "rejected" }>["reason"],
): InteractiveRebaseSubmissionResult {
    return { status: "rejected", reason };
}
