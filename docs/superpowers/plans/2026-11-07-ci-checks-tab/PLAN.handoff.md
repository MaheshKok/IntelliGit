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
- Effective base 90731f87 (Phase 11 squash-merged, then the Phase 12 slice rewritten as groundwork); b9d710d6 is not its ancestor. Not a halt.
- Built (journeys 10, 11): attempt histories per (runId, logicalId) (GitHub `filter=all&per_page=100` for runs past attempt 1, GitLab `include_retried=true`), `flaky n/m` tag with "(estimated)" when the provider has no attempt history (O3), "Changed since last green" (cache-only first-parent walk inside the loaded commits, `git diff --name-status -M -z`, `openCiRangeDiff` opens `vscode.diff`). Contract version 8 (K32).
- Files: src/shared/ci/history.ts (flaky, flakyLineOf), src/services/commitChecks/{ciHistory,changedSinceGreen,coordinator,githubProvider,gitlabProvider}.ts, src/git/operations.ts diffNameStatus, src/services/diffService.ts openRevisionRangeFileDiff, src/views/ciChangedSinceGreenHandler.ts, three hosts, useChangedSinceGreen.ts, CheckJobDetail.tsx, CheckTree.tsx, ChecksTab.tsx.
- Tests: changedSinceGreen.test.ts (real git), ciHistory.test.ts, ciChangedSinceGreenHandler.test.ts, commitChecksChangedSinceGreen.integration.test.tsx, CommitInfoViewProvider.test.ts, ciFixture.test.ts; E2E tests/e2e/ciChangedSinceGreen.spec.ts (CI only).
- Mutations: 36 on a copy, all red at a named assertion (log entry "Phase 12: built, review pending").

## Decisions and why
- File list is a plain button list, not CommitChangedFilesPanel: that panel needs a whole CommitDetail and tree state; plan step 5 is "[ASSUMED] where props allow". CiChangedFile carries path, oldPath, status only (no line counts), unlike the plan's "CommitFile[]".
- The standalone Changed Files view has no commit list, so its host sends the Git Log graphs' loaded commits (`loadedCommits()` on both graph providers); the graph webviews send their own.
- scopeName = the run's name. Flaky tag only when the commit's run, job and flat lists are whole (same rule as Phase 11 tags).
- E2E fixture seam gained a per-commit `details` map: one shared detail would make every ancestor red.
- Lint fixes: readDetail's attempt read moved to `readAttemptHistory`; graph host's two new cases to `handleChangedSinceGreenMessage`; ChecksTab helpers `toLoadedLine`, `changedSinceGreenJob` (complexity limits).
- Handlers answer only while isE2eControlChannelActive is on (as Phase 11); switch-off tested for both.

## Open risks
- Local `bun run test` is never fully green: Node 26.5.0 reds commit-list-column-resize (8), Node 24.3.0 reds updateWithLocalChanges symlink EEXIST (1); both red at 90731f87. diffBudgets "large compute" is load-sensitive (green alone). CI uses Node 22, not installed here (homebrew node@22 resolves to 26).
- GitNexus impact and detect-changes not run: the worktree is not indexed.
- Gate E not run locally; the new spec runs on CI.
- Contract 8 empties persisted CI detail caches once on upgrade (refetch).

## Next phase: 13
## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0 (EEXIST on symlinkSync after rmSync); commit-list-column-resize fails on Node 26.
- l10n audit pre-existing hardcoded-string candidates; GitNexus registry holds two "IntelliGit" entries, main checkout index stale.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist, so tests/unit/git reds there at baseline.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
