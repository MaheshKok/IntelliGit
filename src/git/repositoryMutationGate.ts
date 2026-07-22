import { realpath } from "node:fs/promises";
import path from "node:path";
import { RepositoryMutationCoordinator } from "./mutationCoordinator";
import { RepositoryLock, RepositoryLockBusyError } from "./repositoryLock";

/** Tuning for how long a mutation briefly waits on a busy cross-process lock. */
export interface RepositoryMutationGateOptions {
    acquireTimeoutMs?: number;
    acquireRetryDelayMs?: number;
    /** Test seam for delayed canonicalization before the canonical mutation queue. */
    resolveRepositoryRoot?: (repoRoot: string) => Promise<string>;
}

/** Activation-owned composition of per-worktree queueing and common-dir locking. */
export class RepositoryMutationGate {
    private readonly acquireTimeoutMs: number;
    private readonly acquireRetryDelayMs: number;
    private readonly resolveRepositoryRoot: (repoRoot: string) => Promise<string>;
    private readonly requestedPathCoordinator = new RepositoryMutationCoordinator();

    /** Creates the shared gate from one coordinator and one cross-process lock. */
    constructor(
        private readonly coordinator: RepositoryMutationCoordinator,
        private readonly lock: RepositoryLock,
        options: RepositoryMutationGateOptions = {},
    ) {
        this.acquireTimeoutMs = options.acquireTimeoutMs ?? 5_000;
        this.acquireRetryDelayMs = options.acquireRetryDelayMs ?? 150;
        this.resolveRepositoryRoot = options.resolveRepositoryRoot ?? realpath;
    }

    /** Runs a short Git mutation while holding both serialization layers. */
    async run<T>(repoRoot: string, commonDir: string, operation: () => Promise<T>): Promise<T> {
        // Register by the caller's lexical path before asynchronous canonicalization so two
        // same-path calls cannot overtake each other while realpath is pending.
        return this.requestedPathCoordinator.run(path.resolve(repoRoot), async () => {
            const key = await this.resolveRepositoryRoot(repoRoot);
            return this.coordinator.run(key, async () => {
                const release = await this.acquireWithBriefWait(commonDir);
                try {
                    return await operation();
                } finally {
                    await release();
                }
            });
        });
    }

    /**
     * Retries a busy lock for a bounded window so overlapping short mutations from
     * another window queue instead of failing; persistent owners still surface busy.
     */
    private async acquireWithBriefWait(commonDir: string): Promise<() => Promise<void>> {
        const deadline = Date.now() + this.acquireTimeoutMs;
        for (;;) {
            try {
                return await this.lock.acquire(commonDir);
            } catch (error) {
                if (!(error instanceof RepositoryLockBusyError) || Date.now() >= deadline) throw error;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, this.acquireRetryDelayMs));
        }
    }

    /** Resolves Git's relative common-dir response against the active worktree root. */
    resolveCommonDir(repoRoot: string, commonDir: string): string {
        return path.resolve(repoRoot, commonDir.trim());
    }
}
