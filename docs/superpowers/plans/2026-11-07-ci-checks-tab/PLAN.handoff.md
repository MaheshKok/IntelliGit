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
- Phase 10: accepted 8ff6422d, manual: finished by hand after the takeover halt, owner answer "A" 2026-11-14; Codex ACCEPT on d1b0a496 and on 38b89a65; Fable R1's skipped-job bug fixed in 38b89a65; CodeRabbit's two findings on #435 fixed in 8ff6422d (head of record).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 10: accepted 8ff6422d (started at 37ba9d135cd05dd2120ccc8a101813ef1730fb47)
- The branch's real base is ee5c9ceb (main after Phase 9's squash merge 63b8ea88 plus two docs commits); 37ba9d13 is not its ancestor.
- Built (0.43.12): live elapsed time on running runs and jobs (one 1 s interval only while something runs); "usually ~{duration}" / "usually: unknown" from K23's baseline; "overdue" past 1.5 x usual. Pure logic in src/shared/ci/timing.ts; `getUsualDuration` on GitHub and GitLab; `UsualDurationCache` in src/services/commitChecks/ciTiming.ts; coordinator `withUsual`; CI_DETAIL_CONTRACT_VERSION 5 -> 6; 3 strings in 12 locales + CSV; README "Running time".
- Fix round 1 (d2780ceb): clear shared across windows through a clear epoch; `withUsual` also serves a failed run that still has a queued or running job.
- Fix round 2 (a5991139): clear epoch under its own key; a failed clear write blocks saved-baseline reads until a write of it succeeds (the next save retries).
- Hand fix (d1b0a496): account switch-and-back test for the AccountChangedError rethrow; EPOCH_KEY comment corrected. R1 round (38b89a65): only a baseline job that succeeded gives a usual time.
- Takeover: clear tokens are ordered `<count>:<id>` (count one above the newest token the clearing window saw); a clear writes its token under both keys, and readers take the newer of the two, so an older clear's write landing late (same window or another) cannot undo a newer clear, on restart or in a running window's memory.

## GitNexus impact (spec rule, line 844 of the phase copy), run this step
- Worktree indexed to an external dir (working tree incl. the takeover edit), then `clean`ed; registry back to its two entries.
- Upstream: CommitChecksCoordinator HIGH 46 (getDetail LOW 3); CommitCiDetailService HIGH 29 (clear LOW 5); CommitCiDetailServiceOptions MEDIUM 17; GitHubProvider HIGH 15; GitLabProvider HIGH 15; GitLabPipeline MEDIUM 15; GitLabJob MEDIUM 16; CommitChecksProvider HIGH 61; CheckTree HIGH 5; RunGroup LOW 3; UsualDurationCache HIGH 41 (clear LOW 5, readStored LOW 8).
- UNKNOWN, confirmed by text search: activateRepositoryMode (callers extension.ts:58, :63, noRepositoryMode.ts:112; edit adds one constructor option); CI_DETAIL_CONTRACT_VERSION (read only by detailPersistentCache.ts:128, :282; the bump makes old cached details unusable once, by design).
- HIGH warnings: every HIGH symbol's edit is additive (an optional method, a capability flag, a private method, a new prop) or the planned contract bump; no existing signature changed.
- detect-changes --scope compare ee5c9ceb: 32 files, 281 symbols (docs sections and tests included), 13 flows, risk high (activation flows reach activateRepositoryMode).

## Decisions and why
- "No baseline" and a failed lookup are not cached, only a found baseline: an earlier run still going may succeed and become the baseline.
- The cache key carries the account (`usual:<repoKey>|<account>:<runId>`), and the lookup confirms the attempt's account after it.
- The usual is applied when the detail is fetched, so it lives in the cached detail: hence the contract bump.
- Job usual matches by logical id only when the id is unique in both runs; a cut job list, baseline or current, gives no job matches (current side: CodeRabbit round, 8ff6422d).
- Only a baseline job that succeeded gives a usual time (R1 fix round): a skipped job's zero-length span would make the same running job "overdue" at once. Passed on dropping 0 ms spans instead: a real job can finish in under a second.
- Overdue is strictly greater than 1.5 x usual; unknown usual never shows overdue.
- GitLab baseline: `created_before` + `order_by=id&sort=desc`; GitHub: `created=<createdAt` on the same workflow id; the selected run itself is skipped.
- Ordered tokens in two keys (takeover): storage keeps the last write per key, so no single key can resist a late older write; two keys plus "newer wins" means a late write must hit both to revert. Passed on serializing clear writes per window: it cannot order two windows' writes, and a hung write would stall every later clear.

## Open risks
- Takeover review finding 1 (ciTiming.ts, clear tokens): an older clear's late writes can bring back a baseline a newer clear dropped. Steps: window A clears (clear 1) and saves baseline X under clear 1's token; clear 1's epoch write and that save are both still pending; a newer clear (clear 2) lands under both keys; then clear 1's epoch write lands, then A's save lands on the entries key. Both keys now carry clear 1's token, so after a restart X is readable again. Effect: a cleared "usually ~Xm" hint can come back until its 24 h expiry. Entries are keyed by account, so no other account's data is shown.
- Takeover review finding 2 (ciTiming.ts, clear entries write): a clear's late empty-entries write can erase a baseline saved after that clear. Steps: a window clears; its entries-key write is still pending; a baseline is found and saved after the clear and lands; then the clear's entries write lands and empties the entries. Effect: the fresh hint is lost after a restart and fetched again (one extra list request); nothing wrong is shown.
- Why both are not blockers: PLAN.md:764 (owner decision 2026-11-08, ruled again 2026-11-14) says "Finer cross-window orderings ... are out of scope: a review finding there is recorded under the handoff's Open risks and is not a blocker." One window cannot reorder its own saves (VS Code 1.107.0 source, read by E3's research lane: extHostMemento.ts:84-86 sets the value in memory at once, :89-92 shares one pending write per key, :41-46 flushes the newest value, mainThreadStorage.ts:56-58 applies it at once). So the reviewer's single-window cases come only from its fake store holding a write back while later ones land (review copy ciTiming.review.test.ts:13-15). Two windows can reorder (extHostMemento.ts:35-38, storage.ts:148-157), which is the out-of-scope case. The reviewer's red ciTiming.review tests were not adopted.
- Closed (hand fix): the AccountChangedError rethrow in withUsual now has an outcome test, "an account switch and switch back during a lookup still retries the rejected lookup" (ciTiming.test.ts), red under its removal (M11).
- Fable R1 open question, not changed: an account switch A -> B -> A whose lookup under B lands while the final confirm sees A again could keep B's baseline under A until its 24 h expiry; both accounts read the same repository's runs, so no other account's private data is shown.
- Phase 10 e2e not run locally. Cross-window tests use a shared fake store, not a real second VS Code window.
- `bun run test`: 11 failures, the same as round 2 (8 commit-list-column-resize on Node v26.5.0, tsconfigCoverage, screenshotComparatorMeta, operationBenchmark which passes alone).

## Next phase: 11

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails; decide in a Phase 7 follow-up.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules.
- operationBenchmark.test.ts fails in a full `bun run test` run (`git add` "unable to create temporary file: Invalid argument") and passes alone; diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- l10n audit lists pre-existing hardcoded-string candidates; knip hint on selectedRemovalCrashWorker.ts `ignoreUnresolved`.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries; the main checkout's index is stale (64d390b).
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- impeccable flags a placeholder `<img>` in commitChecksTab.integration.test.tsx (pre-existing test markup).
- The worktree has no node_modules, so `node_modules/.bin/*` fails here; call the main checkout's binaries.
