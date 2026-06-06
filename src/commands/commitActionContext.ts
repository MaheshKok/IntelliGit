import type { GitExecutor } from "../git/executor";
import type { GitOps } from "../git/operations";
import type { Branch } from "../types";

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
}
