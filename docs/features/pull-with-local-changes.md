# Pull with local changes

Pull and **Update** on the current branch can temporarily save local work, rebase onto the upstream branch, and restore that work. This uses the existing Pull actions in the file menus, Changes panel, Git graph, and undocked view.

## What happens

1. IntelliGit checks the selected repository and its current branch. The branch needs an upstream and cannot already have an unfinished Git operation or unresolved conflicts.
2. If there are local changes, a native **Pull with local changes?** dialog identifies the repository and branch. Choose **Save Changes and Pull**, or cancel without changing anything. A clean repository needs no confirmation or backup.
3. IntelliGit saves the tracked changes and ordinary untracked files in a named Git stash. It then runs Pull using rebase, with Git's own automatic stash disabled.
4. After a successful pull, IntelliGit applies that exact backup with its index state. Staged changes stay staged and unstaged changes stay unstaged when restoration succeeds, including edits in the same file.
5. The completion message identifies the retained backup. After checking your files and staging, you can remove this redundant copy through stash management. IntelliGit does not delete it automatically.

Each dirty update leaves one additional recovery stash. The stash name starts with `IntelliGit update:` and includes the branch, time, and an operation identifier. Match the name and hash shown in the result; stash numbers can change when another stash is added.

The repository selected when the action starts remains the target while the confirmation is open. Changing the active repository does not redirect the operation. A change to the original branch, HEAD, or upstream invalidates the pending request; start Pull again after checking the new state.

## What the backup covers

The backup includes saved tracked edits, their staged/unstaged state, and ordinary nonignored untracked files reported by Git. It excludes unsaved editor buffers, ignored files, and work hidden from Git by index flags. Save editor changes yourself before pulling if you want them included.

This is not a workspace snapshot. Git can overwrite an ignored file if the incoming branch starts tracking that path. Dirty submodules, changed gitlinks, and untracked nested repositories are refused because this workflow cannot promise to preserve their contents. A clean submodule alone does not prevent an update.

Finish other Git operations before starting Pull. IntelliGit serializes its own mutations across linked worktrees, but it cannot lock out editor writes or unrelated Git processes.

## When the pull needs conflict resolution

Your local changes remain in the named backup. They are not applied into an active rebase.

1. Resolve and complete the rebase, or abort it using the existing Git controls.
2. Check that the repository is on the intended branch and has a clean worktree.
3. Open **Unstash Changes**, select the matching backup by name and hash, choose **Apply**, and choose **Reinstate Index**.
4. Inspect the restored changes before removing the backup.

Continue, Abort, and restarting VS Code do not automatically restore this backup in this version. After an interruption, inspect the Git operation and current files before deliberately recovering it.

## When restoring local changes fails

The result distinguishes a completed pull with incomplete restoration from a failed pull whose restoration also failed. Both diagnostics remain available when both steps fail. A restoration error can happen without any unmerged files, for example when an incoming tracked file uses the same path as a saved untracked file.

Some changes may already have been restored. Inspect the worktree, index, and named backup before doing anything else. Do not blindly apply the entire backup again. The existing Unstash action requires a clean worktree; recover needed files to separate paths and reconcile them with the current files first.

For an untracked-path collision, the incoming file stays in the worktree and the saved untracked version is in the backup's third parent. Git can show that saved version with `git show <backup-oid>^3:<repository-relative-path>`. Save it to a new, separate path before deciding which contents to keep. Keep the backup until all needed work is recovered.

If Pull fails without leaving an active operation and the repository is safe, IntelliGit attempts one indexed restoration and reports the original pull failure. If saving fails or the repository changes unexpectedly, it stops and identifies the retained backup or its unique name when available. It never retries an application automatically or falls back to discarding staging information.

## Boundaries of this version

- **Sync** still refuses local changes. This workflow does not push or create a commit.
- **Update** on a different branch still fetches that branch without touching the current worktree.
- There is no Merge/Rebase or Stash/Shelf selection dialog yet.
- Later additions have separate specifications: [update choices](https://github.com/MaheshKok/IntelliGit/issues/304), [restore after Continue/Abort](https://github.com/MaheshKok/IntelliGit/issues/305), [restart recovery](https://github.com/MaheshKok/IntelliGit/issues/306), [backup cleanup](https://github.com/MaheshKok/IntelliGit/issues/307), [Sync with local changes](https://github.com/MaheshKok/IntelliGit/issues/308), and [updating selected repositories](https://github.com/MaheshKok/IntelliGit/issues/309).
