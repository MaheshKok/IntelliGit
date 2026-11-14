/**
 * The repository's default branch, read from `origin/HEAD` on every call (PLAN.md §8).
 *
 * Never cached: an ordinary `git fetch` moves the tip and `git remote set-head` moves the
 * name without anything else noticing, and both reads are cheap local Git commands.
 */

const ORIGIN_PREFIX = "refs/remotes/origin/";

/** The default branch name and the commit its remote-tracking ref points at. */
export interface DefaultBranch {
    readonly name: string;
    readonly tipHash: string;
}

/**
 * Reads `origin/HEAD` and its tip; `null` when either is missing, which callers show as
 * "unknown". There is deliberately no "main" fallback and no provider API fallback.
 */
export async function readDefaultBranch(
    git: (args: string[]) => Promise<string>,
): Promise<DefaultBranch | null> {
    try {
        const ref = (await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
        if (!ref.startsWith(ORIGIN_PREFIX) || ref.length === ORIGIN_PREFIX.length) return null;
        const tipHash = (
            await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])
        ).trim();
        return tipHash ? { name: ref.slice(ORIGIN_PREFIX.length), tipHash } : null;
    } catch {
        // Git exits non-zero when origin/HEAD or its target does not exist.
        return null;
    }
}
