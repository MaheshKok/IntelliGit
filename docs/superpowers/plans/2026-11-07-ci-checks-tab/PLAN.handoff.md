# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Phase 6: accepted 69e809bb, verification incomplete (squash-merged as #422, 51b0c3ab).
- Phase 7: accepted 6fef8c59, manual; owner OK 2026-11-12 (squash-merged as #424, 36bef4be).
- Phase 8: review pending, started at 6fef8c59 (the given BASE_HEAD). 6fef8c59 is not an ancestor of HEAD (Phase 7 was squash-merged as 36bef4be), so the build sits on accf570d; review `git diff accf570d..<phase 8 commit>`, not against 6fef8c59 (that diff also shows Phase 7's hand-finished merge).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 8 state
- Built (0.43.10, e356954d): POST helper, `writeFor` through the request gate, GitHub/GitLab `runAction`, `ciActions.ts`, fence re-post and re-read, header buttons, cancel confirm, labels, 14 webview strings in 11 locales, README, CHANGELOG, e2e spec, coverage manifest entry.
- Fix round 1 (dc2b08a2): sign-in recheck after the fence write, busy action released on invalidation or repo/commit change, header keyed per commit, redundant `notSeen` guard dropped.
- Fix round 2 (this commit), review findings 1-5 and 7:
  - `writeFor` captures the context before queueing and throws `RequestNotSentError` (superseded) inside the admitted gate callback when the sign-in or settings changed; the fence is removed (`ciActions.ts`).
  - `coordinator.actionGuard(ctx, liveRepoKey)` replaces `isCurrentContext`: it holds the provider generation captured at the start and reads the live repository at the check. `runCiAction` takes the live repository as a 5th argument; the host passes `() => source.repoKey()`.
  - `redactError` (normalize.ts) removes the provider's token from a write failure at each provider's write boundary; class, status and headers stay.
  - `send()` turns a synchronous throw while building the request (Node's invalid-header rejection) into `RequestNotSentError`; `runCiAction` treats it as a definite failure and deletes the fence.
  - A 401 (before or after the fence) returns outcome `signedOut` with the sign-in message, after dropping the commit from every cache and fetching again; the pane asks for the detail again, which is the existing signed-out detail with its Sign in button. Nothing is retried.
- Mutations on a copy, all red naming a test: gate recheck removed, live repository ignored, provider generation ignored, redaction off, sync catch removed, 401 outcome back to failed, no reload after 401, not-sent branch removed, superseded message dropped.

## Decisions and why
- Finding 6 (GitHub `summaryMissed` makes a finished execution incomplete) is not in Phase 8's diff: it came in with Phase 7 (36bef4be, in base accf570d) and Phase 8 touches neither it nor `githubJobLog.test.ts`. The reviewer saw it by diffing against 6fef8c59. Left unchanged; see "Found outside scope".
- Redaction mutates the thrown error's message in place instead of rebuilding it, so `RequestGateCooldownError` and its `until` survive.
- The live repository is a function argument, not a coordinator field: the coordinator is per window and never knew which repository the pane shows.
- The 401 outcome re-reads through the host instead of marking the pane signed out locally, so one source of truth (the detail's `signInHost`) drives the Sign in button.

## Open risks
- Finding 7 (exact-worktree GitNexus detect_changes) is still unrun: `.gitnexus/run.cjs` is missing in the worktree and `detect-changes --repo <worktree>` answers "Repository not found" (only the two main checkouts are registered). Indexing the worktree would add a third entry to the shared registry; not done. Changed symbols by hand: runCiAction, refused (new), CommitChecksCoordinator.actionGuard (replaces isCurrentContext, one caller), writeFor, send, createHttpRequestJson users, GitHubProvider.runAction, GitLabProvider.runAction, useCiAction, ciActionAccess, answerCiActionMessage.
- Phase 8 e2e spec not run locally (runs on CI).
- `bun run test`: 8 failed / 8008 passed; the 8 are commit-list-column-resize.test.tsx, also red at base accf570d under Node v26.5.0.

## Next phase: 9

## Found outside scope
- Phase 7 code: githubProvider.ts:513 marks a finished execution incomplete when an optional failure-summary lookup fails (`summaryMissed`), and githubJobLog.test.ts pins it. A reviewer says this contradicts the completion contract (plan lines 288/316); decide in a Phase 7 follow-up.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on base accf570d (8 tests).
- tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules; pass with it.
- l10n audit lists 13 pre-existing hardcoded-string candidates (non-blocking).
- knip hint: `tests/integration/shelf/selectedRemovalCrashWorker.ts` can leave `ignoreUnresolved`.
- diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers; a copy under $TMPDIR/phase-run hits the socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries and no worktrees; the CLI cannot check a worktree.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- The repo-wide `.gitignore` rules `logs` and `*.log` hide any future fixture folder named `logs`.
- impeccable hook flags a placeholder `<img>` at commitChecksTab.integration.test.tsx:1261 (pre-existing test markup).
- `git archive` run from a subfolder of a worktree packs only that subfolder; base copies need `git -C <root>`.
