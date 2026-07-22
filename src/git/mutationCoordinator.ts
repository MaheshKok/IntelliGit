/** Serializes extension-owned mutations by caller-supplied normalized repository keys. */
export class RepositoryMutationCoordinator {
    private readonly tails = new Map<string, Promise<void>>();

    /** Runs one mutation after prior mutations for the same normalized key finish. */
    async run<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(repoRoot) ?? Promise.resolve();
        let release: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.tails.set(repoRoot, tail);
        await previous;
        try {
            return await operation();
        } finally {
            release!();
            if (this.tails.get(repoRoot) === tail) this.tails.delete(repoRoot);
        }
    }
}
