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
- Phase 13: owner accepted by hand 2026-11-21 at 3b31283b; gaps in #447 (squash-merged as #448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 ("C: targeted fix") (squash-merged as #450, f3cf1afa).
- Phase 15: accepted 20240fdf (squash-merged as #452; the wave accepted dd67fe22, verification incomplete).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 16: review pending, started at 20240fdf09433916025c8db6578fee50a719934b
- Build 181a5862 (0.43.20), fix rounds 4c5c4abb, 98670525, 621c69be, 7ae74a53, takeover (the commit after 7ae74a53): "Find where CI broke" over 2+ Git Log rows, shown hidden. Earlier rounds' detail: this file's git history.
- Takeover (5 open findings): 1-4 were missing tests, not code faults; each now has a test that a mutant of the code turns red by name: (1) amber needs flaky AND isolated (two view tests); (2) the walk uses the host's loaded parents, not the webview's; (3) an unread neighbour (failed read, or a partial read matching by name only) breaks an isolated red; (4) a cancelled bisect asks the source for no queued commit (counts getChecks calls). No source file changed.
- Finding 5 (sign-in or CI settings change under a running bisect leaves the view on "k / N commits" with Cancel) is ANSWERED (owner 2026-11-24, see below); confirmed that only the view's own Cancel/Close buttons call closeCiBisect, and the plan has no rule for it. Fixing it needs a protocol field on ciBisectResult (section 4) or a reply after the generation changed (section 4 says a stale result is dropped), so it waits for the owner.
- Gates at the takeover: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0; `bun run test` with a fresh `NODE_OPTIONS=--localstorage-file`: 547 files, 8788 passed, 1 skipped. Use a new flag file per run (a reused one fails commitCiColumn.integration.test.tsx).

Answered: finding 5 and the compact Git Log gap, owner 2026-11-24, "B + compact now". (1) Finding 5 = B: when the generation fence stops a bisect, the host posts one final bisect reply marked stopped (one new field in the bisect's own section 4 messages; rewrite the ciBisectHandler.test.ts silence test; new text in every catalog; no reply while the Checks tab switch is off; no `commitCiDetailInvalidated` listener and no change to the settings handler in repositoryMode.ts); the view leaves "k / N commits", says the check stopped because sign-in or CI settings changed, and offers to run it again. (2) The compact Git Log layout gets the same "Find where CI broke" row action behind `isChecksTabEnabled()`, with its own switch-off test; the witness tests/integration/webviews/compactGitLogCiBisect.integration.test.tsx (repro/PLAN-6, 100b688b) must land on this branch and pass. Plan: PLAN.md Phase 16, the line after the finding 6 answer.

## Decisions and why
- Finding 6: owner 2026-11-22 "C: drop both + issue" (#453): result text is only "broke at <short sha>".
- Request gate send guard (AsyncLocalStorage) is checked inside the gate after the slot wait; the shared attempt read joins guards.
- Concurrency 4, matching the gate's per-bucket slots; the pre-queue cancel check now has a witness (takeover).
- Sparkline: fixed 72 px strip, 9 px squares, 2 px gap; a range over 6 commits scrolls the strip. Owner may still choose which constant yields.
- The chain is derived from the host's loaded parents (first parent) intersected with the selection; a non-straight selection reports "not a straight line".
- `limitedTo`, `commits` and `failedReads` are in the section 4 result payload.
- Ships hidden (owner 2026-11-20, "A: hide them"): menu entry behind `isChecksTabEnabled()`, both host handlers behind `isE2eControlChannelActive()`; Phase 18 turns them on.
- Takeover mutation copies were made with rsync, not `git ls-files | tar`: the worktree guard refuses git inside a pipe.

## Open risks
- E2E tests/e2e/ciBisect.spec.ts not run locally (CI runs test:e2e).
- GitNexus impact and detect-changes not run (no tool exposed to builder sessions).
- A long range shows a thin horizontal scrollbar under the sparkline (strip a few px taller).
- The failed-reads message reads the same for a failed re-run read; Retry may ask an unavailable commit twice on a live outage (bounded by the gate).
- Owner questions carried: Phase 15's skipped/cancelled/neutral denominator; whether the commit panel's embedded graph shows checks (Phase 18).

## Next phase: per the phase-run dry run (Phases 17-18 per their Depends on lines)

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 without `--localstorage-file`; tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- A worktree has an empty node_modules until linked to the main checkout's node_modules.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18).
- knip hint: tests/integration/shelf/selectedRemovalCrashWorker.ts can leave ignoreUnresolved in knip.jsonc.
