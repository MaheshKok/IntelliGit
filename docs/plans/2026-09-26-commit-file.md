# Commit File: sequential context-menu releases

## Goal

Add **Commit File...** to IntelliGit's Explorer, editor-tab, and editor context
menus. The user approved a native message prompt: Enter commits the clicked file
without opening the Commit panel.

## Approach and decisions

- Start from `main` at `772e617e18ffcb93f80bae37c3e5a938e3f1053b` on
  `codex/menu-commit-file`; deliver version `0.35.9` in one feature commit and one
  ready PR.
- An explicit local-file URI determines the file and repository. Use the active
  editor only when no command argument is supplied.
- Show the selected path and the commit consequence in the native input prompt.
  Cancellation and a blank message must not stage files, move HEAD, or refresh
  unrelated UI.
- Commit the selected file's saved changes, including its rename source when
  applicable. Preserve other files' staged and working-tree content.
- Require dirty editor buffers to be saved first; recheck after message entry.
- Accept files, symlink nodes, and exact tracked deletions, including a deleted
  parent folder. Refuse directory pathspecs.
- Reuse the selected-file commit flow. Add an opt-in active-operation refusal at
  the Git commit boundary so this entry point cannot use the panel's intentional
  whole-index merge/rebase completion behavior. Preserve case-only rename handling.
- Retain existing commit-panel behavior for all existing callers. Do not clear
  an unrelated panel message draft. Report refresh failure separately from a
  successful commit.
- Use static localization catalogs, imported through the localization CSV.

## Acceptance

- Manifest test proves registration and placement in both shared file-menu
  definitions, covering all three existing entry surfaces.
- Command tests prove URI precedence, selected repository, cancellation, blank
  input, dirty buffers, operation refusal, and actionable errors.
- Real-Git tests prove only selected paths enter HEAD and unrelated staged blobs
  survive; cover rename and case-only rename, plus operation state appearing
  during staging.
- Real VS Code test invokes the Explorer menu, cancels without mutation, then
  submits a message and checks actual Git history and staged content.
- Run required formatting, lint/strict lint, architecture, React Doctor,
  typechecks, build, full tests, localization, production build, and packaging
  gates on the integrated branch. Obtain independent review before committing.

## Out of scope

No new Commit-panel selection protocol, automatic push, amend, or other menu
action in this PR. The execution-boundary check does not promise atomic exclusion
of external Git processes.

## Release sequence

After each feature PR is merged and its registry release verified, create the next
branch from updated `main`. Remaining visible entries: Add, Merge, Rebase,
Branches, New Branch, New Tag, Reset HEAD, Stash Changes, Unstash Changes, GitHub,
Manage Remotes, and Clone. Reuse existing commands where available. GitHub submenu
scope must be specified before its implementation.
