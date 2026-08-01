import type { GitExecutor } from "../git/executor";
import type { GitOps } from "../git/operations";
import type { Branch } from "../types";
import type { PendingRebaseDialogRequests } from "../git/interactiveRebase/types";
import type { CommitGraphInbound } from "../webviews/protocol/commitGraphTypes";

/**
 * Validated repository context shared by commit graph context-menu actions.
 *
 * The dispatcher builds this only after accepting a Git object hash from the webview protocol.
 * Actions use the same executor, Git service, branch snapshot, and refresh callback so UI state is
 * refreshed consistently after operations that mutate branch history, refs, the index, or the
 * working tree.
 */
export interface CommitActionContext {
    /** Full commit hash already checked by the dispatcher before any Git command receives it. */
    validatedHash: string;
    /** Eight-character label used only in prompts and notifications. */
    short: string;
    executor: GitExecutor;
    gitOps: GitOps;
    repoRoot: string;
    /** Branch metadata snapshot from the view; handlers may refresh it if upstream data is stale. */
    currentBranches: Branch[];
    /** Refreshes all IntelliGit views after confirmed mutations or failed mutation attempts. */
    refreshAll: () => Promise<void>;
    /** Provider instance that dispatched this action, used as the dialog request's unforgeable origin. */
    originProvider: object;
    /**
     * Posts an interactive-rebase dialog payload only to the provider that dispatched this action.
     *
     * Returns false when that provider has no live webview left to receive it, which the caller
     * must treat as a failed handoff rather than a silent success.
     */
    postRebaseDialog: (
        message: Extract<CommitGraphInbound, { type: "showRebaseDialog" }>,
    ) => boolean;
    /** Shared request registry that preserves single-use dialog state across all commit-list hosts. */
    pendingRebaseDialogRequests: PendingRebaseDialogRequests;
}
