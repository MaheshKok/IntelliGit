import simpleGit, { SimpleGit } from "simple-git";

/**
 * Owns the repository-scoped Simple Git instance used by extension Git operations.
 *
 * The executor is intentionally thin: callers provide raw Git arguments, and
 * higher layers remain responsible for validation, path safety, and workflow-
 * specific error handling. This class only binds invocations to the active
 * repository root while preserving the shared concurrency limit.
 */
export class GitExecutor {
    private git: SimpleGit;

    /**
     * Creates an executor rooted at the repository path selected during activation.
     */
    constructor(repoRoot: string) {
        this.git = simpleGit(repoRoot, { maxConcurrentProcesses: 6 });
    }

    /**
     * Rebinds subsequent Git commands to a newly selected repository root.
     *
     * Existing callers use this when the active repository changes without
     * rebuilding every service that depends on the executor.
     */
    setRoot(repoRoot: string): void {
        this.git = simpleGit(repoRoot, { maxConcurrentProcesses: 6 });
    }

    /**
     * Runs a raw Git command through Simple Git and returns stdout.
     *
     * Callers own argument validation, path safety, and user-facing error handling;
     * this method intentionally preserves Simple Git's rejection behavior so higher
     * layers can translate failures in workflow-specific ways.
     */
    async run(args: string[]): Promise<string> {
        return this.git.raw(args);
    }
}
