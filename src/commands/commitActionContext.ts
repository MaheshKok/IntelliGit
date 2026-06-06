import type { GitExecutor } from "../git/executor";
import type { GitOps } from "../git/operations";
import type { Branch } from "../types";

export interface CommitActionContext {
    validatedHash: string;
    short: string;
    executor: GitExecutor;
    gitOps: GitOps;
    repoRoot: string;
    currentBranches: Branch[];
    refreshAll: () => Promise<void>;
}
