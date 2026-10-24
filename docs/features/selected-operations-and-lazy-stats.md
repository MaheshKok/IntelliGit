# Selected Shelf Operations, Targeted Restore and Lazy Statistics

This page covers the Phase 4 changelist operations: saving lists or selected
files to a shelf, optionally removing or rolling back what was saved, restoring
shelves and patches into a chosen changelist, running history actions without a
commit, and loading line statistics only for visible rows. Changelist basics are
in [Changelists and Selected Changes](changelists-and-partial-commits.md).

## Save to Shelf

- **List actions** offer **Save to Shelf**, **Save and Remove…** and
  **Rollback…**. A list save includes every change the list owns, checked or not.
- **Selected whole files** offer the same three actions from the Changes panel.
  Whole-file entries capture both staged and working-tree content.
- The shelf records the source lists and their drafts, so a later restore can
  offer to copy a draft into the destination.
- **Save** never resets or removes anything. Cancelling the shelf name prompt
  creates no shelf.

## Save and Remove, Rollback

- **Save and Remove…** first saves the shelf, then shows a preview of exactly
  what would be removed: the captured diff for each file, taken when the plan was
  made. Later edits are not shown and are not removed.
- **Rollback…** asks for confirmation before anything is saved, then keeps a
  "Before rollback" shelf so the rollback can be undone by unshelving it.
- Removal runs only on the changes that were saved. If some files changed after
  the save, they are left alone, and the result lists exactly which paths were
  removed and which were not. The shelf is always kept. Do not repeat a removal
  after a partial result; review the remaining changes instead.

## Restore into a Changelist

- **Unshelve** (command palette or Shelf panel) asks for a destination: an
  existing list or a new list, named after the shelf by default. If the shelf
  came from lists with drafts, you can keep the destination draft or copy one
  source draft.
- The repository, shelf version and destination are fixed before the prompt. If
  the shelf or the lists change while the prompt is open, nothing is applied and
  you are asked to try again. Switching repositories during the prompt cannot
  redirect the restore.
- Conflicts open the shelf conflict editor. Saving a reviewed result continues
  the same restore; if the file changed after the editor opened, the editor
  reports that it is out of date instead of overwriting.
- **Apply Patch to Changelist…** imports a patch file as a shelf, shows the files
  it contains, then restores it into the chosen list. Cancelling keeps the
  imported shelf and applies nothing. **Import Patches…** stays import-only.

## History Actions without a Commit

- The commit graph menu adds **Cherry-Pick to Changelist (Uncommitted)…** and
  **Revert to Changelist (Uncommitted)…**. Both run Git with `--no-commit` and
  assign the result to the chosen list. The existing **Cherry-Pick** and
  **Revert Commit** actions are unchanged and still commit.
- **Undo Commit…** now asks which list should receive the undone changes and can
  copy the commit message into that list's draft. Cancelling the list picker
  changes nothing.
- If Git stops with conflicts, resolve them, then run **Complete Uncommitted
  History Action** or **Discard Uncommitted History Action**. Discard restores
  only the files the action touched; unrelated edits stay.

## Lazy Line Statistics

The Changes panel shows the file list from `git status` first. Added/removed
line counts load afterwards, only for rows that are visible, in small batches.
Every visible row ends either with its counts or as unavailable; a failed batch
marks only its own rows unavailable. Switching repositories or refreshing drops
results from the previous state.

## Supported Scope and Refusals

- Selected text limits match
  [Changelists and Selected Changes](changelists-and-partial-commits.md#supported-scope).
- Cherry-pick and revert to a changelist refuse, before running Git:
  - submodules;
  - files with unstaged edits in the affected paths;
  - unusual index entries (intent-to-add, skip-worktree, assume-unchanged);
  - added, deleted, renamed, symlinked or re-moded files that already belong to a
    list or differ from `HEAD`.
- **Undo Commit…** refuses when an affected file already belongs to a list or
  has local changes. Commit or move those changes first.
- An operation already running in another window or panel makes the new one
  report "busy" without changing anything.
- If Git succeeds but the changelist update cannot finish, the result says it
  needs review. Recovery only finishes the metadata; it never re-runs Git.

## Not in Phase 4

- Phase 3B (scoped chunk moves, drag and drop, ownership decorations) and
  Phase 5 work.
- Amend with changelists, and selected-line operations on structural changes
  (renames, mode changes, binary files).
- A pending-operation banner in the webview; use the two command palette
  commands above.
