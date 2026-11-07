// Generation counters that let a CI operation tell whether the world it started in still
// exists. Every host operation captures a context at its start and checks it after each
// await and right before publishing; a stale result is dropped.

/** What a CI operation captured when it started. */
export interface CiOperationContext {
    readonly repoKey: string;
    readonly authGeneration: number;
    readonly lifecycleGeneration: number;
}

/** Host-wide auth and lifecycle generations for CI work. */
export class CiGenerations {
    private authGeneration = 0;
    private lifecycleGeneration = 0;

    /** Bumped on sign-in, sign-out and token changes. */
    bumpAuth(): void {
        this.authGeneration += 1;
    }

    /** Bumped when CI settings change or a repository closes. */
    bumpLifecycle(): void {
        this.lifecycleGeneration += 1;
    }

    /**
     * Captures the context an operation runs in.
     *
     * @param repoKey - Repository the operation works for.
     */
    capture(repoKey: string): CiOperationContext {
        return {
            repoKey,
            authGeneration: this.authGeneration,
            lifecycleGeneration: this.lifecycleGeneration,
        };
    }

    /**
     * Reports whether a captured context still matches the current world.
     *
     * @param ctx - Context captured when the operation started.
     * @param currentRepoKey - Repository the publishing surface shows now.
     */
    isCurrent(ctx: CiOperationContext, currentRepoKey: string): boolean {
        return (
            ctx.repoKey === currentRepoKey &&
            ctx.authGeneration === this.authGeneration &&
            ctx.lifecycleGeneration === this.lifecycleGeneration
        );
    }
}
