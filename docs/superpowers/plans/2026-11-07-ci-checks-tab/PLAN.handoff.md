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
- Built (0.43.12): live elapsed time on running runs and jobs (one 1 s interval only while something runs); "usually ~{duration}" / "usually: unknown" from K23's baseline; "overdue" tag past 1.5 x usual. Pure logic in src/shared/ci/timing.ts; baseline lookup `getUsualDuration` on GitHub and GitLab; `UsualDurationCache` in src/services/commitChecks/ciTiming.ts; coordinator `withUsual`; CI_DETAIL_CONTRACT_VERSION 5 -> 6; 3 strings in 12 locales + CSV; README "Running time".
- Fix round 1 (d2780ceb): clear shared across windows through a clear epoch; `withUsual` also serves a failed run that still has a queued or running job.
- Fix round 2 (review pending again): the clear epoch now lives under its own store key (`...usualDurationsEpoch`), written only by clears; the entries key keeps `{epoch, entries}` and counts only while its epoch equals that key, so an older entries write landing late (same window or another) is never read. A clear whose shared write fails sets a pending epoch: this window ignores saved baselines until a write of that epoch succeeds (the next save retries it). 4 new tests (3 red before the fix, quoted in LOG_FILE; the 4th covers the retry); 4 mutations red at their named tests. Gate G chain exit 0 except `bun run test` (known 10 plus operationBenchmark, which passed alone: `git add` hit "unable to create temporary file" under full-suite load). Gate L not rerun (no strings changed). Entries saved under the round 1 key shape are ignored once (one refetch).

## GitNexus impact (spec rule, line 844 of the phase copy)
- The main checkout's index is stale (commit 64d390b, no Phase 10 code), so this worktree was indexed (`analyze --index-only`, external index dir, commit d2780ce plus the working tree) and removed again with `clean` afterwards; the registry is back to its two entries.
- `UsualDurationCache` upstream: HIGH, 41 impacted (depth 1: detailService constructor/clear, coordinator withUsual, repositoryMode activation, provider/type files; reached through CommitGraphViewProvider and UndockedViewProvider). Public surface unchanged (constructor, `get`, `clear`); only private methods and one new store key changed.
- `clear` LOW 5, `get` LOW 4, `save` LOW 3, `readStored` LOW 4, `epochOf` LOW 4, `writeEpoch` (new) LOW 7. `detect_changes --scope all`: 2 files, 18 symbols, 0 affected processes, low.

## Decisions and why
- "No baseline" and a failed lookup are not cached, only a found baseline: K23's cached value has no null, and an earlier run still going may succeed and become the baseline.
- The cache key carries the account (`usual:<repoKey>|<account>:<runId>`), and the lookup confirms the attempt's account after it.
- The usual is applied when the detail is fetched, so it lives in the cached detail: hence the contract bump.
- Job usual matches by logical id only when the id is unique in both runs; a cut baseline job list gives no job matches.
- Overdue is strictly greater than 1.5 x usual; unknown usual never shows overdue.
- GitLab baseline: `created_before` + `order_by=id&sort=desc` server-side; GitHub: `created=<createdAt` on the same workflow id; the selected run itself is skipped.
- Clear epoch in its own key (not a serialized queue): no write of the entries can revert it, whatever order storage applies them in. Passed on queueing the clear behind saves: the round 1 reason (a clear must be visible before any older save lands) still holds.

## Open risks
- The AccountChangedError rethrow in withUsual has no outcome-level test (withAccount's final confirm catches the same switch).
- Phase 10 e2e not run locally. Cross-window tests use a shared fake store, not a real second VS Code window.
- `bun run test`: 11 failures in the last full run: the known 10 (8 commit-list-column-resize on Node v26.5.0, tsconfigCoverage and screenshotComparatorMeta in a worktree without node_modules) plus operationBenchmark (load-sensitive, passes alone).

## Next phase: 11

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails; decide in a Phase 7 follow-up.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`).
- tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules.
- operationBenchmark.test.ts fails in a full `bun run test` run with `git add` "unable to create temporary file: Invalid argument" and passes alone.
- l10n audit lists pre-existing hardcoded-string candidates (non-blocking).
- knip hint: `tests/integration/shelf/selectedRemovalCrashWorker.ts` can leave `ignoreUnresolved`.
- diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries; the main checkout's index is stale (64d390b).
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- impeccable flags a placeholder `<img>` in commitChecksTab.integration.test.tsx (pre-existing test markup).
- The worktree has no node_modules, so `node_modules/.bin/*` fails here; call the main checkout's binaries.
