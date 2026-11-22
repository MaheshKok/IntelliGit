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
- Build 181a5862 (0.43.20) on HEAD bb7e3af4 (docs-only on 20240fdf): "Find where CI broke" over a range of 2+ Git Log rows, shown hidden. Details, mutation table and proof in PLAN.review-log.md "Phase 16: built, review pending".
- 10 mutations on copy mut-16-build-1, each red naming its test. verify.py gates --stage round GREEN. Chain exit 0 except `bun run test` (10 known environmental reds after the localization plural fix; see Open risks).
- Fix round 1 (5 review findings, each with a test red before the fix): the bisect stops queueing and sending once the repository, sign-in or settings changed (`isCurrent` into `runCiBisect`); a partial snapshot proves only an identity match; one job inventory by the §9 join across commits; a GitHub check resolves to the one attempt-history job bearing its name; the sparkline is 72 px wide (wider only past six squares). Tests: tests/unit/views/ciBisectHandler.test.ts, ciBisect.test.ts, ciBisectView.integration.test.tsx.

## Decisions and why
- Request gate send guard (AsyncLocalStorage) is checked inside the gate after the slot wait, so a cancelled bisect never sends a queued request; a refused send throws a module-local error and frees the slot.
- Concurrency 4, matching the gate's per-bucket slots.
- Sparkline: width = max(72, lead + squares) so frame 4:2's 72 px holds at its six squares and a longer range widens instead of overflowing into the result text (passed on a fixed 72 px that clips or spills).
- Job inventory joins items pairwise across commits with `matchCheck` on each commit's own items; partial reads join (one row per job) but prove only an identity match in `jobOf`.
- The chain is derived from the loaded parents (first parent), intersected with the selection; a selection that is not a straight line reports "not a straight line" instead of guessing.
- The bisect run object reuses CommitCiDetailLoops (one cancel token per host, cancelled on dispose).
- `limitedTo` and `commits` (oldest to newest, the order of `states`) were added to the §4 result payload so the view can show the cap note and label squares.
- Result text "broke at <hash> · this commit" / "· N commits ago" (plural). The frame's "yours" and "also red on main" are not carried by the §4 contract.
- Cancel both cancels and closes the view; CheckAnnotations still renders below the bisect view.
- The compact NativeCommitGraph gets no "Find where CI broke" (it has no Checks tab).
- Ships hidden (owner 2026-11-20, "A: hide them"): menu entry behind `isChecksTabEnabled()`, both host handlers behind `isE2eControlChannelActive()`, each with a switch-off test; Phase 18 turns them on.

## Open risks
- E2E tests/e2e/ciBisect.spec.ts not run locally (CI runs test:e2e).
- GitNexus detect-changes --scope all: risk CRITICAL (34 files, 73 symbols, 23 flows), driven by requestGate and coordinator being central plus line-shift-only symbols; impact for the new symbols LOW, UNKNOWN for ambiguous names (fetchChecks, run, CommitList, CommitInfoPane).
- A cancelled attempt-history read can hand a caller that joined it null once.
- Gate U ran regex-only.
- `bun run test` known reds, unchanged after fix round 1 (10 failed, 8730 passed, 1 skipped): 8 commit-list-column-resize (Node 26 localStorage), tsconfigCoverage and screenshotComparatorMeta. Every other chain step exits 0.
- Fix round 1 changed behaviour: the bisect on a very long range does N^2 pairwise joins of the commits' items (cap of the loaded commits); not measured.
- Owner questions carried: Phase 15's skipped/cancelled/neutral denominator; whether the commit panel's embedded graph shows checks (Phase 18).

## Next phase: per the phase-run dry run (Phases 17-18 per their Depends on lines)

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26 unless `--localstorage-file` is given.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
- The main checkout's GitNexus index is stale; its runner works with `--repo <worktree>` from a script under the TMPDIR phase-run folder.
- Bash commands naming "IntelliGit" next to a script, ".gitnexus", or git inside a compound command are refused by the worktree guard; put them in scripts under the TMPDIR phase-run folder.
- knip reports a configuration hint: tests/integration/shelf/selectedRemovalCrashWorker.ts can leave ignoreUnresolved in knip.jsonc.
- The commit panel's embedded graph (CommitPanelViewProvider) never posts `commitChecksEnabled`; whether it should show checks stays an owner question for Phase 18.
