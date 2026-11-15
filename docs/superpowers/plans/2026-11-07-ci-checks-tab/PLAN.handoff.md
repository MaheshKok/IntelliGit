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
- Phase 9: accepted 37ba9d13, manual; elephant OK 2026-11-14 (squash-merged as #430, 63b8ea88).
- Phase 10: accepted 8ff6422d, manual, owner answer "A" 2026-11-14 (squash-merged as #435, bc063074).
- Phase 11: accepted b9d710d6, verification incomplete (squash-merged as #439, 928c1aae).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 12: review pending, started at b9d710d60cb6a5b929ad4ef7e32c1293090b550b
- Effective base 90731f87 (Phase 11 squash-merged, then the Phase 12 slice rewritten as groundwork); b9d710d6 is not its ancestor. Not a halt. A diff against b9d710d6 shows Phase 11's CHANGELOG date (2026-11-14 to 2026-11-15) and CheckTree changes that were made in the squash merge and the groundwork rewrite, not by Phase 12.
- Built (journeys 10, 11): attempt histories per (runId, logicalId), `flaky n/m` tag ("(estimated)" without provider attempt history, O3), "Changed since last green" (cache-only first-parent walk, `git diff --name-status -M -z` plus `--numstat`, `openCiRangeDiff` opens `vscode.diff`). Contract version 8 (K32).
- Fix round 1 (36c1f1b9): cache-only reads cannot join the shared in-flight map; listed names may hold a newline; `nameProvesJob`; reply identity; `detail` hook dependency; `getAttemptHistory` on both providers.
- Fix round 2 (6 findings, each test red before the fix except where noted): (1) `GitOps.getFileContentAtRef(path, ref, {listedName: true})` keeps a Git-listed name byte for byte (newline, edge spaces, backslash) and still refuses NUL, absolute and `..`; only `openRevisionRangeFileDiff` passes it; real-Git test tests/unit/services/rangeDiffRealGit.test.ts. (2) `ciHistory(parents, line)` asks the provider's `getAttemptHistory` for a loaded ancestor whose checks are cached but whose detail is not (provider must have the capability; 60 s per-account memo, failures not remembered, cleared by `clear()`). (3) changedSinceGreen checks `nameProvesJob` before skipping a red name match. (4) `CiChangedFile extends CommitFile` (additions, deletions from `git diff --numstat -M -z`, binary = 0); `CiRangeDiffFile` is the open-diff subset. (5) CheckTree.tsx and (6) CHANGELOG.md: checked against base 90731f87, Phase 12's diff holds only the flaky tag and the 0.43.14 entry; no change. Finding 4 had no separate pre-fix red run (its proof is mutation 4a/4b below).
- Fix round 2 proof: 8 mutations on copies, each red at a named test (listedName ignored, NUL check off, attempt read stubbed, memo off, failure kept, red name skip restored, counts dropped, rename source skip dropped).

## Decisions and why
- File list is a plain button list, not CommitChangedFilesPanel: that panel needs a whole CommitDetail and tree state; plan step 5 is "[ASSUMED] where props allow".
- The standalone Changed Files view has no commit list, so its host sends the Git Log graphs' loaded commits; the graph webviews send their own.
- scopeName = the run's name. Flaky tag only when the commit's run, job and flat lists are whole (same rule as Phase 11 tags).
- Ancestor attempt reads go to the provider (spec fetching rule), only for ancestors whose snapshot is cached; alternative (cached details only) leaves flaky counts wrong for ancestors never opened in Checks.
- Handlers answer only while isE2eControlChannelActive is on (as Phase 11).

## Open risks
- Local `bun run test` is never fully green: Node 26.5.0 reds commit-list-column-resize (8, red at 90731f87); under load 16 other files time out at 30 s and pass alone (rerun: 64 files, 965 tests green).
- A badge request on a long loaded line now sends up to one attempt-history read per cached ancestor (memoized 60 s); the provider request gate bounds concurrency. Not measured against a real forge.
- GitNexus impact and detect-changes not run: the worktree has no `.gitnexus`; run both in an indexed checkout before merge.
- Gate E not run locally; the new spec runs on CI.
- Contract 8 empties persisted CI detail caches once on upgrade (refetch).

## Next phase: 13
## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
