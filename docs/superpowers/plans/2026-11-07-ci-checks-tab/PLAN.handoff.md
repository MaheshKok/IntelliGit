# CI Checks tab: handoff

## Phases accepted
- Phase 1: 3965f37a, verification incomplete. Phase 2: bfea9112, manual, owner OK 2026-11-11 (#415). Phase 4: f005d90f, verification incomplete (#417, d3438a11).
- Phase 19: f005d90f, verification incomplete (#418, 2490ec17). Phase 3: 15a47c9d, manual, owner OK 2026-11-11 (#419, c246d0d4). Phase 5: 6898d332, manual, owner OK 2026-11-12 (#420, 86088cab).
- Phase 6: 69e809bb, verification incomplete (#422, 51b0c3ab). Phase 7: 6fef8c59, manual, owner OK 2026-11-12 (#424, 36bef4be). Phase 8: b5a56002, manual, owner OK 2026-11-13 (#426, 7941c809).
- Phase 9: 37ba9d13, manual, elephant OK 2026-11-14 (#430, 63b8ea88). Phase 10: 8ff6422d, manual, owner "A" 2026-11-14 (#435, bc063074). Phase 11: b9d710d6, verification incomplete (#439, 928c1aae).
- Phase 12: owner accepted by hand 2026-11-18 at c874d0b3 (gaps in #443; squash-merged as #444, 29efe7ec).
- Phase 13: owner accepted by hand 2026-11-21 at 3b31283b; gaps in #447 (squash-merged as #448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 ("C: targeted fix") (squash-merged as #450, f3cf1afa).
- Phase 15: accepted 20240fdf (squash-merged as #452; the wave accepted dd67fe22, verification incomplete).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 16: review pending, started at 20240fdf09433916025c8db6578fee50a719934b
- Build 181a5862 (0.43.20), fix rounds 4c5c4abb, 98670525, 621c69be, 7ae74a53, takeover b8ab4529: "Find where CI broke" over 2+ Git Log rows, shown hidden. Earlier rounds' detail: this file's git history.
- Owner answer 2026-11-24 "B + compact now" (PLAN.md Phase 16) built in the commit after 6dab987a, review pending:
  - (1) Stopped reply: when the generation fence stops a bisect (sign-in or CI settings changed), ciBisectHandler.ts posts one last `ciBisectProgress` with `stopped: true` (new optional field, section 4). The view (BisectView.tsx, ciBisect.ts) leaves "k / N commits", shows `commit.checks.bisect.stopped` and offers Run again (retryCiBisect) and Close (no cancel sent). New keys in all 12 catalogs plus the CSV. No reply while the switch is off (existing early return), none for a cancelled bisect, none on a repository change. No `commitCiDetailInvalidated` listener; the settings handler in repositoryMode.ts is untouched.
  - (2) Compact Git Log: NativeCommitGraph passes onFindCiBreak (the menu entry stays behind `isChecksTabEnabled()` in commitMenu.tsx) and posts `findCiBreakInChecks`. The sidebar host relays it only while `isE2eControlChannelActive()`; repositoryMode.ts wires it to `commitInfo.startCiBisect`. CommitInfoViewProvider holds it until ready, posts `startCiBisectInChecks`, and runs the shared answerStartCiBisect/answerCancelCiBisect with its own CommitCiDetailLoops (stopped on reload and dispose). CommitInfoApp starts the bisect in its Checks tab. The witness compactGitLogCiBisect.integration.test.tsx (100b688b) lands and passes.
- Owner answer 2026-11-24 "A: 8.5 MiB" built in the commit after 0d3faee7, review pending: scripts/verifyVsixPackage.js MAX_UNCOMPRESSED_BYTES 8.25 -> 8.5 MiB, comment states the measured 0.43.20 payload (8,651,928 bytes). No CHANGELOG line (not user-facing, per the plan).
  - `bun run package` before the edit exit 1, after exit 0 (8651928 unpacked); verifyVsixPackage tests 20 passed.
- Fix round 1 (5 review findings, each with a test red before the fix): provider dispose() now disposes ciBisectRuns; progress and stopped replies carry `repoKey` and the view matches it; a flat commit status no longer takes a same-named job's re-run history (JobRow.status); Retry reads each commit once (coordinator option `refreshUnavailable` peeks the cache, forces only a cached error); sparkline amber uses the nearest pass/failure/unread neighbour, skipping skipped/cancelled/running. New tests: ciBisectCommitInfoIndependent, ciBisectPhase16Independent, ciBisectRepositoryIndependent.
- Fix round 2 (3 findings + a comment byte count, red before the fix): the join and the per-commit lookup index flat statuses and workflow jobs apart (KindIndex in service ciBisect.ts); the result carries `isolated[]` per commit (`isolatedReds` in shared/ci/history.ts, the one rule `flaky` also uses) and the sparkline draws amber from it; useCiBisect cancels and retires the bisect when its pane moves to another repository; verifyVsixPackage.js comment says 8,652,459 bytes.

## Decisions and why (this build)
- Budget raise: no new unit test pins 8.5 MiB (it would only mirror the constant); the outside check is `bun run package`, red before and green after.
- Stopped reply = a progress message with `stopped: true`, not a new message type: one field, and done/total stay valid for the view.
- A repository change posts no stopped reply: its text ("sign-in or CI settings changed") would be false, and that repository's view is gone.
- Compact layout relays to the Changed Files view's Checks tab (like Open in Checks), because the compact webview has no Checks tab of its own; the bisect's cap there is the sidebar graph's loaded page.
- Fix round 1, Retry: one `getChecks` call per commit with `refreshUnavailable` (not a second `force` call), because the bisect cannot tell a cached error from a fresh one; passed on counting `sendGuard` calls (a gate-less provider never calls it).
- Fix round 2: `isolated` is a required field of `CiBisectJob` (host decides, view only draws), so unread vs confirmed absence is the host's call. Repository retire lives in the hook (a pane whose repoKey changes), not in CommitInfoApp, so a Checks tab that is unmounted during a switch is not covered.

## Decisions and why (earlier rounds)
- Finding 6: owner 2026-11-22 "C: drop both + issue" (#453): result text is only "broke at <short sha>".
- Request gate send guard (AsyncLocalStorage) is checked inside the gate after the slot wait; the shared attempt read joins guards.
- Concurrency 4, matching the gate's per-bucket slots; the pre-queue cancel check now has a witness (takeover).
- Sparkline: fixed 72 px strip, 9 px squares, 2 px gap; a range over 6 commits scrolls the strip. Owner may still choose which constant yields.
- The chain is derived from the host's loaded parents (first parent) intersected with the selection; a non-straight selection reports "not a straight line".
- `limitedTo`, `commits` and `failedReads` are in the section 4 result payload.
- Ships hidden (owner 2026-11-20, "A: hide them"): menu entry behind `isChecksTabEnabled()`, both host handlers behind `isE2eControlChannelActive()`; Phase 18 turns them on.

## Open risks
- E2E tests/e2e/ciBisect.spec.ts not run locally (CI runs test:e2e); no E2E drives the compact relay or the stopped reply yet.
- A bisect stopped by a repository switch tells no view (by design above); the new repository's view never showed it.
- A long range shows a thin horizontal scrollbar under the sparkline (strip a few px taller).
- The failed-reads message reads the same for a failed re-run read as for a failed checks read.
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
