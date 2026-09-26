# Native Merge context menu

## Goal

Add Merge... to IntelliGit Explorer, editor-tab, and editor menus. Deliver version
0.35.11 as one commit and one ready PR from main 5387593a after merged PR #289.

## Approach

Resolve the clicked local file's repository with the existing native resolver.
Only absent context may fall back to the active editor. Offer local and remote
branches excluding the current branch, then retain the existing Merge confirmation.
Merge affects the repository; the clicked file selects its repository, not a pathspec.

Extract only the existing merge flow into a shared command helper. Preserve the
branch-tree command and use a small GitOps merge facade so derived operations keep
the existing mutation gate. Native callbacks capture the selected repository;
refresh active views only if their current root still matches.

## Key decisions

- Picker or confirmation cancellation makes no mutation. Invalid explicit or
  nonlocal context never falls back to another repository. Empty branch inventory
  gives an explicit message.
- Check the existing operation fence before selection and again after prompts.
  Capture branch name and HEAD identity before selection; reject dialog-time target
  changes. Preserve detached and unborn Git behavior rather than adding a ban.
  This is not an atomic guarantee against external Git or intervening queued work.
- Separate successful merge plus refresh failure from Git failure. Conflicts open
  with the captured source/target labels and repository-scoped callbacks.
- Fix two blocking conflict UI identities: recreate the conflict-session singleton
  when its repository changes, and key merge editors by repository plus relative
  file path. Capture fixed roots and derived Git services. Preserve other open
  merge editors and their unsubmitted content.
- Use new command intelligit.fileMerge, native menu label Merge..., standard
  no-repository placeholder, static localization, and existing VS Code components.

## Checks

Contract RED/GREEN for URI ownership, invalid input, cancellation, local/remote
branches, scoped fences, dialog-time changes including same-branch HEAD changes,
detached HEAD, success/failure/conflicts, and refresh failure. Regression tests for
conflict-session repository switching and independent same-path merge editors.
Real Git proves merge history, mutation-gate preservation, and other-repository
isolation. Native Explorer E2E proves picker cancellation and successful merge.
Run full repository gates once integrated, independent acceptance, production
packaging, and graph analysis before committing.

## Out of scope

No Rebase or other menu action, auto-stash, new merge strategy UI, broad branch
refactor, executor transaction redesign, release/tag/publish, or automatic PR merge.
