/**
 * How a recording derives the branch list its provider caches, mirroring the ONE production
 * sequence that populates it (`src/activation/repositoryMode.ts:1343-1350`):
 *
 * ```
 * currentWorktrees = await worktreeService.refresh();
 * currentBranches  = worktreeService.decorateBranches(await gitOps.getBranches());
 * commitGraph.setBranches(currentBranches, currentWorktrees);
 * ```
 *
 * **The defect this exists to close.** Every graph-bearing provider posts `setBranches` from its
 * own `ready` handler, and that post sends `this.branches` -- a field that starts as `[]` and is
 * only ever filled by an explicit `setBranches(...)` call from activation. A recorder that resolved
 * the view and drove `ready` without ever making that call recorded `"branches": []` into the
 * committed fixture: a state no user ever sees in a seeded repository with five refs, and one that
 * makes the whole visual suite render a branch-less graph while reporting green. Nothing in the
 * recording could catch it -- the empty array IS what the provider held, so every end-to-end
 * assertion agreed.
 *
 * **Why `WorktreeService` is constructed rather than skipped.** `decorateBranches` is not a
 * formality: it stamps `isCheckedOutInWorktree` / `worktreePath` / `isCurrentWorktree` onto each
 * branch from the worktree cache, and even a repository with no LINKED worktrees has a primary one
 * whose branch is the checked-out branch -- so the checked-out branch is decorated differently from
 * every other branch. Passing raw `getBranches()` output would record every branch as un-checked-out
 * and lose exactly the distinction the graph renders.
 *
 * **Why callers apply the result BEFORE resolving the view.** The cache must be populated before
 * `ready` runs, because `ready`'s own `sendBranches` is what posts `this.branches`; setting it
 * afterwards would leave the recorded frame empty no matter what this module returns. Applying it
 * first records the populated list exactly once, because every provider's `setBranches` returns
 * after caching when no view/panel exists yet.
 *
 * That last guard is load-bearing and was added for this: `setBranches` fires `sendBranches()`
 * WITHOUT awaiting it, and `sendBranches` awaits icon-theme resolution before posting, so its post
 * used to land a microtask later -- after `resolveWebviewView` had attached the view -- and the
 * fixture recorded two byte-identical `setBranches` frames. The first of that pair could never have
 * reached the webview, whose script had not yet signalled `ready`, so the guard removes a post
 * nothing could receive rather than suppressing a real one.
 */

import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { WorktreeService } from "../../../src/services/worktreeService";
import type { Branch, GitWorktree } from "../../../src/types";
import { toGitEnvironment } from "./recordingGitEnvironment";

/** The decorated branch list and worktree list one recording hands to `setBranches`. */
export interface RecordingBranches {
    readonly branches: Branch[];
    readonly worktrees: GitWorktree[];
}

/**
 * Reads the seeded repository's real branches and worktrees through the same production
 * collaborators activation uses, decorated the same way.
 *
 * Takes an already-built `GitOps` rather than a repository root so a caller shares ONE executor
 * (and therefore one sanitized environment) between the provider under recording and this read --
 * two executors built from the same options would work, but a caller that passed a sanitized
 * environment to one and forgot the other would produce a fixture reading the developer's own
 * `~/.gitconfig` on exactly one of the two paths, which is the failure `recordingGitEnvironment.ts`
 * documents.
 */
export async function loadRecordingBranches(
    gitOps: GitOps,
    repoRoot: string,
    env: NodeJS.ProcessEnv,
): Promise<RecordingBranches> {
    const worktreeService = new WorktreeService(
        new GitExecutor(repoRoot, undefined, toGitEnvironment(env)),
        () => repoRoot,
    );
    const worktrees = await worktreeService.refresh();
    const branches = worktreeService.decorateBranches(await gitOps.getBranches());
    if (branches.length === 0) {
        throw new Error(
            `loadRecordingBranches: ${repoRoot} reported zero branches. Every scenario this ` +
                "recorder runs against is a seeded repository with refs, so an empty list means " +
                "the read failed or the wrong root was passed -- recording it would commit the " +
                "exact branch-less fixture this module exists to prevent.",
        );
    }
    return { branches, worktrees };
}
