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
- Phase 8: review pending, started at 6fef8c59 (the given BASE_HEAD). 6fef8c59 is not an ancestor of HEAD accf570d (Phase 7 was squash-merged as 36bef4be), so the build sits on accf570d; review the diff `git diff accf570d..<phase 8 commit>`.
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 8 state
- Built (0.43.10): `http.ts` POST; `writeFor(providerId)` through the request gate; GitHub/GitLab `runAction`, `actionEvidence`, capabilities `rerunFailed`/`rerunJob`/`cancel`, `writeScopeHelp`; `coordinator.actionTarget` and an `invalidate` that clears both caches; `ciActions.ts` (`runCiAction`, `refreshCiDetail`); host `runCiAction` in all three webview hosts (`ciActionHandler.ts`); fence re-post on change and re-read on end (`ciDetailHandler.ts`); Refresh routed through `refreshCiDetail`; `useCommitCiDetail` polls while `actionFence` lasts and exposes `reload`; `useCiAction`; header buttons, inline cancel confirm, waiting / not-seen labels, Re-run job in the job detail, outcome alert with the help link; 14 webview strings + 1 host string in 11 locales; README `#write-actions` and the multi-window wording at the old lines 164-166; CHANGELOG; e2e `tests/e2e/ciActions.spec.ts` in `test:e2e`; coverage manifest entry `runCiAction`.
- Tests: `ciActions.test.ts` (18), `ciActionHandler.test.ts` (9), `commitChecksActions.integration.test.tsx` (the 7 named + re-run job, unsure send, cancel labels), gate test in `commitChecksProviders.test.ts`, capabilities and http tests.
- Mutation pass on a copy: 20 of 21 mutants red, each naming its test. The survivor (Refresh condition `fence?.notSeen` -> `fence`) is equivalent: Phase 19's `endByUserRefresh` refuses before not-seen; the stronger mutant (any Refresh removes the fence) goes red on "Refresh before not-seen keeps the fence".

## Fix round 1 (review findings, started at 6fef8c59)
- Sign-out during the fence write: `runCiAction` rechecks the captured context (`coordinator.isCurrentContext`) after the fence write and before the send; stale = nothing sent, fence removed, "Remote data changed" shown.
- `useCiAction` releases the busy action on `commitCiDetailInvalidated` and on a repository or commit change; a reply is checked for request id, repository and commit before any state changes; the header is keyed by repository and commit so the cancel confirm resets.
- Dropped the redundant `fence?.notSeen` guard in `refreshCiDetail`; `endByUserRefresh` stays the one authority. `beforeOf` was split out of `runCiAction` for the lint complexity cap.
- Retrospective GitNexus impact (CLI from the main checkout, index 10 commits behind, so approximate): ChecksHeader HIGH (5 impacted), CommitChecksCoordinator HIGH (35 impacted, 12 direct; this round only adds one method), useCommitCiDetail HIGH (5), ChecksTab LOW (7). detect-changes was not run (no index of this worktree).
- Mutations on a copy, all red naming a test: stale request id, wrong-scope reply, invalidation release, effect-cleanup release, header key, context recheck, fence removal on stale.

## Decisions and why
- The help URL is derived at run time from the extension manifest's `repository` (`/blob/HEAD/docs/commit-checks/README.md#write-actions`); when it cannot be derived the link is left out, never a guessed URL.
- The GitLab scope string drops the plan's backticks around `api`: the webview shows a code span as literal backticks and the localization test forbids it. The words are unchanged.
- A forbidden outcome shows the provider's `writeScopeHelp` text; uncertain shows "may have been sent; refreshing"; failed shows its message. `ok` and `uncertain` re-ask through the host caches (`reload`, not a forced fetch), because the host already invalidated and refetched.
- The header targets the selected job's run, else the first run. Buttons hide while `actionFence` exists; every action button is disabled while one action is in flight (a ref blocks two clicks in one frame).
- A fence end re-reads the detail instead of re-posting the stale copy, so an old failure is never shown without its label.
- A fence removal that cannot be stored is swallowed: the fence stays, reads not-seen after 10 minutes, and Refresh ends it.

## Open risks
- Carried: Phase 3, 5, 6, 7 risks as recorded in this file's history.
- Phase 8: e2e spec not run locally (runs on CI); GitNexus impact / detect-changes not run (no `.gitnexus/run.cjs` in the worktree, no GitNexus MCP tools); during the build `src/views/ciActionHandler.ts` was found emptied on disk once by an unknown step and was restored from the build transcript (typecheck, lint and tests green after).
- Verification: `bun run test` 8 failed / 7990 passed at the Phase 8 commit tree; the 8 are commit-list-column-resize.test.tsx, also red at accf570d under Node v26.5.0.

## Next phase: 9

## Found outside scope
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on base accf570d (8 tests).
- tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules; pass with it.
- l10n audit lists 13 pre-existing hardcoded-string candidates (non-blocking).
- knip hint: `tests/integration/shelf/selectedRemovalCrashWorker.ts` can leave `ignoreUnresolved`.
- diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load; `bun run package` can pack ignored `output/` leftovers.
- A copy under $TMPDIR/phase-run hits the socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries and no worktrees; the CLI cannot check a worktree.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- The repo-wide `.gitignore` rules `logs` and `*.log` hide any future fixture folder named `logs`.
- impeccable hook flags a placeholder `<img>` at commitChecksTab.integration.test.tsx:1261 (pre-existing test markup).
- `git archive` run from a subfolder of a worktree packs only that subfolder; base copies need `git -C <root>`.
