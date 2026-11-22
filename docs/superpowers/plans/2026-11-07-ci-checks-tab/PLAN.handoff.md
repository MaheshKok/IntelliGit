# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual (merged as #415); owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Phase 6: accepted 69e809bb, verification incomplete (squash-merged as #422, 51b0c3ab).
- Phase 7: accepted 6fef8c59, manual; owner OK 2026-11-12 (squash-merged as #424, 36bef4be).
- Phase 8: accepted b5a56002, manual; owner OK 2026-11-13 (squash-merged as #426, 7941c809).
- Phase 9: accepted 37ba9d13, manual; elephant OK 2026-11-14 (squash-merged as #430, 63b8ea88).
- Phase 10: accepted 8ff6422d, manual, owner answer "A" 2026-11-14 (squash-merged as #435, bc063074).
- Phase 11: accepted b9d710d6, verification incomplete (squash-merged as #439, 928c1aae).
- Phase 12: owner accepted by hand 2026-11-18 at c874d0b3 (gaps in #443; squash-merged as #444, 29efe7ec).
- Phase 13: owner accepted by hand 2026-11-21 at 3b31283b; gaps in #447; log's last Phase 13 line stays HALT (squash-merged as #448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 ("C: targeted fix"); log's last Phase 14 line stays HALT (squash-merged as #450, f3cf1afa).
- Phase 15: accepted 20240fdf (squash-merged as #452; the wave accepted dd67fe22, verification incomplete).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 16: review pending, started at 20240fdf09433916025c8db6578fee50a719934b
- Build 181a5862 (0.43.20), fix round 1 4c5c4abb, fix round 2 (this commit, see git log): "Find where CI broke" over a range of 2+ Git Log rows, shown hidden.
- BLOCKED: review finding 6 (the result text's "yours" and "also red on main") is not fixed; it needs an owner answer, see below.
- Fix round 2 (5 of 6 findings, each test red before the fix): (1) the job join never merges two known logical ids, so an unlabelled middle commit no longer collapses two workflows' same-named jobs; (2) a live caller joining another caller's attempt-history read keeps it when the owner cancels (the shared read's send guard is "any joined caller is live"); (3) `failedReads` in the §4 result: the view shows an error with Retry, not "No CI jobs found"; (4) the join is indexed (`indexChecks` / `matchIndexed` in shared/ci/history.ts, `matchCheck` delegates) and yields to the event loop every 20k steps while checking for a cancel: 40 commits x 1000 checks ran in about 0.1 s of test time (was 6.67 s); (5) the sparkline is 72 px for any range: squares shrink from 9 px (gap first goes 2 -> 0 px past 8+ commits), the note line has no extra vertical padding.
- Gates: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0. `bun run test`: 8 failed (commit-list-column-resize, Node 26 has no localStorage), 8745 passed, 1 skipped.

## Decisions and why
- Finding 6 NOT done: "yours" has no source in the plan or code. Options for the owner: (A) yours = the breaking commit's author email equals `git config user.email` (needs the author in `LoadedCommit`, the webview message and a git config read; "also red on main" from the default branch tip's checks); (B) yours = the breaking commit is the newest selected row (cheap, but "yours" then means nothing about authorship); (C) drop both qualifiers from the frame (a plan change). Pass on guessing: each gives different payload and host code.
- Request gate send guard (AsyncLocalStorage) is checked inside the gate after the slot wait; the shared attempt read joins guards (round 2).
- Concurrency 4, matching the gate's per-bucket slots.
- Sparkline: fixed 72 px; squares flex from 9 px and shrink, gap 2 px squeezed to 0 only when 1 px squares would not fit (passed on growing the sparkline, which broke frame 4:2).
- Job inventory joins items pairwise across commits (indexed); partial reads join but prove only an identity match in `jobOf`.
- The chain is derived from the loaded parents (first parent) intersected with the selection; a non-straight selection reports "not a straight line".
- `limitedTo`, `commits` and now `failedReads` (count of commits whose checks could not be read) are in the §4 result payload.
- Ships hidden (owner 2026-11-20, "A: hide them"): menu entry behind `isChecksTabEnabled()`, both host handlers behind `isE2eControlChannelActive()`; Phase 18 turns them on.

## Open risks
- E2E tests/e2e/ciBisect.spec.ts not run locally (CI runs test:e2e).
- GitNexus detect-changes was not re-run this round.
- An attempt-history read that fails (null) still counts as "no re-runs" for the flaky tag; only snapshot read failures are in `failedReads`.
- Owner questions carried: finding 6 above; Phase 15's skipped/cancelled/neutral denominator; whether the commit panel's embedded graph shows checks (Phase 18).

## Next phase: per the phase-run dry run (Phases 17-18 per their Depends on lines)

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 unless `--localstorage-file` is given; tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- A worktree here has an empty node_modules until it is linked to the main checkout's node_modules (symlink, git-ignored).
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- The commit panel's embedded graph (CommitPanelViewProvider) never posts `commitChecksEnabled`; whether it should show checks stays an owner question for Phase 18.
- knip reports a configuration hint: tests/integration/shelf/selectedRemovalCrashWorker.ts can leave ignoreUnresolved in knip.jsonc.
