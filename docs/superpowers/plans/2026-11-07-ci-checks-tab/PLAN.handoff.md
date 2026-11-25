# CI Checks tab: handoff

## Phases accepted
- Phase 1: 3965f37a, verification incomplete. Phase 2: bfea9112, manual, owner OK 2026-11-11 (#415). Phase 4: f005d90f, verification incomplete (#417, d3438a11).
- Phase 19: f005d90f, verification incomplete (#418, 2490ec17). Phase 3: 15a47c9d, manual, owner OK 2026-11-11 (#419, c246d0d4). Phase 5: 6898d332, manual, owner OK 2026-11-12 (#420, 86088cab).
- Phase 6: 69e809bb, verification incomplete (#422, 51b0c3ab). Phase 7: 6fef8c59, manual, owner OK 2026-11-12 (#424, 36bef4be). Phase 8: b5a56002, manual, owner OK 2026-11-13 (#426, 7941c809).
- Phase 9: 37ba9d13, manual, elephant OK 2026-11-14 (#430, 63b8ea88). Phase 10: 8ff6422d, manual, owner "A" 2026-11-14 (#435, bc063074). Phase 11: b9d710d6, verification incomplete (#439, 928c1aae).
- Phase 12: owner accepted by hand 2026-11-18 at c874d0b3 (#444, 29efe7ec). Phase 13: owner accepted by hand 2026-11-21 at 3b31283b (#448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 (#450, f3cf1afa). Phase 15: accepted 20240fdf (#452; the wave accepted dd67fe22, verification incomplete).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 16: review pending, started at 20240fdf09433916025c8db6578fee50a719934b
- Build 181a5862 (0.43.20), fix rounds 4c5c4abb, 98670525, 621c69be, 7ae74a53, takeover b8ab4529, owner-"B" build 95b90b98: "Find where CI broke" over 2+ Git Log rows, shown hidden. Earlier detail: this file's git history.
- Owner "B + compact now": a generation-fence stop posts one `ciBisectProgress` with `stopped: true`; the compact Git Log relays to the Changed Files view's Checks tab. Owner "A: 8.5 MiB": verifyVsixPackage.js limit.
- Owner "B: require all 4" (95b90b98): card/undocked resets dispose `ciBisectRuns`; compact relay carries `relayRepoKey` / page `repoKey`; range goes whole to the bisect.
- Fix round 1 after that build (7 findings, each with a test red before the fix):
  - Compact menu: CommitList snapshots `ciRange` and `ciScope` (`findCiBreakScope` prop = the page's repoKey, now state in NativeCommitGraph) when the menu opens; a click sends those, so an A menu never sends B, and a replaced page cannot shrink the range or hide the entry.
  - Webview slot: card `clearCommitDetail` now carries `ciRepoKey` (host: CommitGraphViewProvider) and useCommitGraphMessages calls `retireCiBisect`; undocked `repositories` switch calls it in handleRepositoriesMessage. Same-repository clears keep the run.
  - ciBisectHandler: the stopped reply is posted only while the switch is on.
  - runCiBisect: a capabilities (remote lookup) rejection marks every commit unread (`failedReads`), so Retry shows; a cancel during it still returns undefined.
  - BisectView: result text is "broke at" or "no break point"; the flaky tag carries the count. `commit.checks.bisect.flakyNote` is removed from 12 catalogs and the CSV (ciBisectCatalogs.test.ts now asserts it is gone).
- Tests: ciBisectHostPane.integration (new), compactGitLogCiBisectMenu, ciBisectView, ciBisectHandler, ciBisect (unit), CommitGraphViewProvider (card clear names its repository).

## Decisions and why (this round)
- Menu scope: a `findCiBreakScope` prop snapshotted at open, not a ref read at click, so the value is the one the menu opened with. `onFindCiBreak(commits, scope?)`; the card and undocked ignore the scope.
- Slot retirement: the host names the repository on `clearCommitDetail` (as the sidebar `clear` does) instead of a new message; undocked reuses `repositories`.
- Discovery failure: a retryable "unread" result, not a thrown error; passed on a new reply type (more protocol).
- Flaky note: dropped from the result text; passed on rewording it, because any count there can contradict the squares.

## Open risks
- E2E tests/e2e/ciBisect.spec.ts not run locally (CI runs test:e2e); no E2E drives the compact relay, the stopped reply or the new clear message.
- A bisect stopped by a repository switch tells no view (by design); the new repository's view never showed it.
- A long range shows a thin horizontal scrollbar under the sparkline.
- Owner questions carried: Phase 15's skipped/cancelled/neutral denominator; whether the commit panel's embedded graph shows checks (Phase 18).

## Next phase: per the phase-run dry run (Phases 17-18 per their Depends on lines)

## Found outside scope
- ciBisectHandler still posts progress and a result if the switch turns off mid-run (only the stopped reply is guarded).
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 without `--localstorage-file`; updateWithLocalChanges.integration.test.ts fails on Node 24.3.0.
- GitHub carryScans treats two missing `runAttempt` values as the same run; `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- A worktree has an empty node_modules until linked to the main checkout's node_modules; GitLab snapshot could follow `x-next-page` pages.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18); knip hint: selectedRemovalCrashWorker.ts in knip.jsonc.
