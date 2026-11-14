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
- Phase 8: accepted b5a56002, manual; owner OK 2026-11-13 (squash-merged as #426, 7941c809).
- Phase 9: accepted 37ba9d13, manual: finished by hand; elephant OK 2026-11-14 after the owner's answer "C: track in #432" (squash-merged as #430, 63b8ea88).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 10: review pending, started at 37ba9d13
- The branch's real base is ee5c9ceb (main after Phase 9's squash merge 63b8ea88 plus two docs commits); 37ba9d13 is not its ancestor.
- Built (0.43.12): live elapsed time on running runs and jobs (one 1 s interval only while something runs); "usually ~{duration}" / "usually: unknown" from K23's baseline; "overdue" tag past 1.5 x usual. Pure logic in src/shared/ci/timing.ts; baseline lookup `getUsualDuration` on GitHub and GitLab (capability `usualDuration`); `UsualDurationCache` in src/services/commitChecks/ciTiming.ts (L1 + globalState, 24 h, newest 200, serialized writes, cleared with the detail cache); coordinator `withUsual` inside the detail fetch; CI_DETAIL_CONTRACT_VERSION 5 -> 6; 3 strings in 12 locales + CSV; README "Running time".
- Fix round 1 (review pending again): the clear is now shared across windows (the store holds `{epoch, entries}`; a clear writes a new random epoch at once; L1 entries, in-flight fetches and queued saves carry the epoch they started under and are dropped when it differs), and `withUsual` also fetches a baseline for a failed run that still has a queued or running job. 3 regression tests, all red before the fix (see LOG_FILE); 4 mutations red at their named tests; Gate G chain exit 0 except the known 10 `bun run test` failures (8137 passed). Gate L not rerun (no strings changed). The saved-baselines key changed shape, so entries saved by the first Phase 10 build are ignored once.
- Proof: Gate L 6/6 exit 0; Gate G format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0; `bun run test` 8134 passed / 10 failed (the known 10); 19 of 19 mutations red at their named tests (see LOG_FILE).

## Decisions and why
- "No baseline" and a failed lookup are not cached, only a found baseline: K23's cached value has no null, and an earlier run still going may succeed and become the baseline. Cost: one list request per running run per detail read while none exists.
- The cache key carries the account (`usual:<repoKey>|<account>:<runId>`), and the lookup confirms the attempt's account after it, so one account's baseline never serves another.
- The usual is applied when the detail is fetched, so it lives in the cached detail: hence the contract bump (old entries miss once).
- Job usual matches by logical id only when the id is unique in both runs; a cut baseline job list gives no job matches.
- Overdue is strictly greater than 1.5 x usual; unknown usual never shows overdue.
- GitLab baseline: `created_before` + `order_by=id&sort=desc` server-side; GitHub: `created=<createdAt` on the same workflow id; the selected run itself is skipped.

## Open risks
- GitNexus impact/detect_changes not run (worktree guard). Callers checked by hand: coordinator.getDetail, detailService.clear, provider capability maps, CheckTree.
- The AccountChangedError rethrow in withUsual has no outcome-level test (withAccount's final confirm catches the same switch; it only fails faster).
- Phase 10 e2e not run locally.
- `bun run test`: the same 10 failures as before: 8 commit-list-column-resize (Node v26.5.0, no `localStorage`), tsconfigCoverage and screenshotComparatorMeta (worktree without its own node_modules). It ran before a doc-only options-interface refactor of ciTiming.ts; lint, typecheck, builds, package and the 78 phase tests were rerun after it.

## Next phase: 11

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails; decide in a Phase 7 follow-up.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`).
- tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules.
- l10n audit lists pre-existing hardcoded-string candidates (non-blocking).
- knip hint: `tests/integration/shelf/selectedRemovalCrashWorker.ts` can leave `ignoreUnresolved`.
- diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries and no worktrees.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- impeccable flags a placeholder `<img>` in commitChecksTab.integration.test.tsx (pre-existing test markup).
- The worktree has no node_modules, so `node_modules/.bin/*` fails here; call the main checkout's binaries.
