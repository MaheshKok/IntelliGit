# CI Checks tab: handoff

## Phases accepted
- Phase 1: 3965f37a, verification incomplete. Phase 2: bfea9112, manual, owner OK 2026-11-11 (#415). Phase 4: f005d90f, verification incomplete (#417, d3438a11).
- Phase 19: f005d90f, verification incomplete (#418, 2490ec17). Phase 3: 15a47c9d, manual, owner OK 2026-11-11 (#419, c246d0d4). Phase 5: 6898d332, manual, owner OK 2026-11-12 (#420, 86088cab).
- Phase 6: 69e809bb, verification incomplete (#422, 51b0c3ab). Phase 7: 6fef8c59, manual, owner OK 2026-11-12 (#424, 36bef4be). Phase 8: b5a56002, manual, owner OK 2026-11-13 (#426, 7941c809).
- Phase 9: 37ba9d13, manual, elephant OK 2026-11-14 (#430, 63b8ea88). Phase 10: 8ff6422d, manual, owner "A" 2026-11-14 (#435, bc063074). Phase 11: b9d710d6, verification incomplete (#439, 928c1aae).
- Phase 12: owner accepted by hand 2026-11-18 at c874d0b3 (#444, 29efe7ec). Phase 13: owner accepted by hand 2026-11-21 at 3b31283b (#448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 (#450, f3cf1afa). Phase 15: accepted 20240fdf (#452; the wave accepted dd67fe22, verification incomplete).
- Phase 16: owner accepted by hand 2026-11-26 at 6518aa81 (answer "A: accept + issue"; Codex's two relay timing findings filed as #456).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 16: review pending, started at 20240fdf09433916025c8db6578fee50a719934b
- Build 181a5862 (0.43.20), earlier fix rounds and takeover b8ab4529, owner-"B" build 95b90b98, fix rounds 534e4f62 and 1861411c; detail in this file's git history.
- Owner answers carried: "B + compact now" (stopped reply, compact relay), "A: 8.5 MiB" (VSIX limit), "B: require all 4" (card/undocked resets, relay repository, whole range).
- Takeover after fix round 2 (3 findings, each with a test red before the fix):
  - Card menu provenance: the card host's replacing `loadCommits` page now carries `repoKey` (the repository read when its `git log` starts; the sidebar's `relayRepoKey` still wins there). CommitGraphPanel keeps it as `pageRepoKey` (appends keep it) and passes it as `findCiBreakScope`; `findCiBreakHandler` starts only when it equals the detail's `ciRepoKey`, so A rows never go out as B and B rows never as A. Tests: ciBisectCardPageScope.integration (new), CommitGraphViewProvider "a replacing card page names the card's repository", ciBisectMenuScopeLayouts (card case now sends its page).
  - GitLab re-runs: GitLab status items carry `id` (the job id, as the detail path already assumed, gitlabProvider.ts:673-677). In ciBisect a status job takes only the attempt histories holding that execution id under its own name (`statusAttempts`); any other flat status keeps none. Test: ciBisectSnapshotCoverage "counts a GitLab pipeline job's ..." and the two "keeps an unrelated flat status apart" cases.
  - Incomplete snapshots: a partial read now counts in `failedReads` (the view's "Commits with incomplete CI data: N" + Retry), identity-matched entries kept as before; Retry (`refreshUnavailable`) also re-reads a commit cached as partial. Tests: ciBisectSnapshotCoverage "reports incomplete CI ..." and "Retry reads a commit cached as a partial snapshot again".

## Decisions and why (this step)
- Card page provenance from the host page, not from the detail: rows and detail are separate messages, only the page knows where its rows came from. Passed on clearing rows on `clearCommitDetail` (a same-repository clear would blank the list).
- Read the page repository at request start, not at post time, so a log read in A that lands after a switch is still labelled A.
- Status-to-history link by execution id AND name: the id alone could collide with an unrelated status's id; the name alone is the false transfer an earlier round removed.
- Every partial read counts as incomplete, including GitLab's 100-status page bound (Retry cannot fix that one; the text stays accurate).
- No version bump: fix rounds stay on 0.43.20 like the earlier ones.

## Open risks
- E2E tests/e2e/ciBisect.spec.ts not run locally (CI runs test:e2e); no E2E drives the compact relay, the stopped reply or the card page repository.
- Snapshots cached before this change hold GitLab status items without `id`, so their re-runs are not counted until the entry is read again.
- A long range shows a thin horizontal scrollbar under the sparkline. A stopped bisect after a repository switch tells no view (by design).
- Owner questions carried: Phase 15's skipped/cancelled/neutral denominator; whether the commit panel's embedded graph shows checks (Phase 18).

## Next phase: per the phase-run dry run (Phases 17-18 per their Depends on lines)

## Found outside scope
- ciBisectHandler still posts progress and a result if the switch turns off mid-run (only the stopped reply is guarded).
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 without `--localstorage-file`; with one shared file across the whole suite, stored widths leak into commitCiColumn.integration (2 failures seen 2026-11-25). updateWithLocalChanges.integration.test.ts fails on Node 24.3.0.
- GitHub carryScans treats two missing `runAttempt` values as the same run; `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- A worktree has an empty node_modules until linked to the main checkout's node_modules; GitLab snapshot could follow `x-next-page` pages.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18); knip hint: selectedRemovalCrashWorker.ts in knip.jsonc.
- gitlabProvider.ts:677 now sets `id` twice (toStatusItem already does); harmless, could become `.map(toStatusItem)`.
