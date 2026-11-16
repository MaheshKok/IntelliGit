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
- Takeover (round-2 review, 3 findings): (1) a cache-only read (`getCached`) in both CommitChecksService and CommitCiDetailService joined a running fetch at any of 3 points, so the walk waited for network data. Now one `joinable(key, options)` helper per service throws "not cached" for a cache-only read when a fetch is in flight (before the store read, during it, after it); an in-flight ancestor is skipped as uncached. (2) changedSinceGreen: a name-only match in a partial ancestor list now stops the walk with `unknownReason: "ambiguous"` for red and green alike (was: red skipped, green skipped, walk reached an older green). The old test "a partial ancestor list cannot prove a name match" expected the skip; it became the two-state test. (3) GitNexus: not runnable here (see Open risks).
- Takeover proof: 10 new tests red on the pre-fix source, green after; 9 mutations on a copy (each of 3 join points x 2 services, each helper's throw, the partial stop) each red at a named test; the reviewer's own reviewer.phase12.test.ts passes 11/11 on the fixed copy.
- Halt: PHASE 12: HALT review still failing after takeover (review log line 1322), at HEAD 6e448ca8. Two REQUIRED Codex findings stayed open, plus E3's steer 2.

### Owner answer 2026-11-16 (E3): rerun wave 12 with Fable. Fix all of the following, test-first, each test red before the fix and red again under its named mutation
- (a) Finding 1, `src/services/commitChecks/service.ts:332` and `src/services/commitChecks/detailService.ts:440`: while a refresh is pending, a cache-only read serves a valid stored copy (L1, then L2, per section 14) without joining or waiting for the fetch, and keeps the generation and fence checks, so a copy the refresh has already replaced or invalidated is still not served. Round 2's rule still holds: a cache-only read never waits for or takes a fetch's answer. Red tests: "stored passing ancestor remains visible during refresh after restart" and "stored selected detail remains usable during refresh after restart".
- (b) Finding 2, `src/shared/ci/history.ts:109`: drop ancestor jobs whose known identity conflicts with the selected job's identity before the ambiguity test, so same-named jobs from other workflows cannot stop the walk. Red test: "known identities from unrelated workflows do not block an older exact green".
- (c) Steer 2, the entitlement record: `openCiRangeDiff` (`src/views/ciChangedSinceGreenHandler.ts:90-112`) opens only a (fromRev, toRev, path, oldPath) that the host itself sent in its latest changed-since-green answer to that webview. Keep one latest record per webview, replaced by each new answer, cleared when the webview is retired and when the repository changes. Compare by exact string, so a short hash fails without a separate rule. Tests, each refused with no git call (a `getFileContentAtRef` spy is never called): a path not in the latest answer; a short hash; a pair from an older answer after a newer one; a request after retire; a request after a repository switch. A mutation that skips the check must go red naming its assertion.
- (d) Steer 3: confirm GitHub's jobs `filter=all` parameter and GitLab's `include_retried=true` parameter from the provider's current API docs (cite the URL) or a recorded fixture. If neither confirms one, that provider takes the O3 estimated fallback (PLAN.md:671).
- (e) The reviewer's red tests, a stable copy (3 failed, 7 passed at 6e448ca8): `/private/tmp/claude-501/-Users-maheshkokare-PycharmProjects-IntelliGit/96ae0985-286f-496a-992b-d3fa5b57f64c/scratchpad/p12-halt/tests/unit/services/commitChecks/reviewer.round3.test.ts`. Copy the three red cases into the branch's own tests.
- Keep: E3's steer 1 is already met (`openRevisionRangeFileDiff` reads sides through `getFileContentAtRef`); keep that reader, with the entitlement check in front of it.

## Decisions and why
- File list is a plain button list, not CommitChangedFilesPanel: that panel needs a whole CommitDetail and tree state; plan step 5 is "[ASSUMED] where props allow".
- The standalone Changed Files view has no commit list, so its host sends the Git Log graphs' loaded commits; the graph webviews send their own.
- scopeName = the run's name. Flaky tag only when the commit's run, job and flat lists are whole (same rule as Phase 11 tags).
- Ancestor attempt reads go to the provider (spec fetching rule), only for ancestors whose snapshot is cached; alternative (cached details only) leaves flaky counts wrong for ancestors never opened in Checks.
- Handlers answer only while isE2eControlChannelActive is on (as Phase 11).
- A cache-only read that finds a stored copy while a refresh runs also misses (the refresh may replace that copy, and the existing code never served a stored copy early); the alternative, serving the stored copy, could hand the walk an answer the refresh is overturning.

## Open risks
- Local `bun run test` is never fully green: Node 26.5.0 reds commit-list-column-resize (8, red at 90731f87); under load 16 other files time out at 30 s and pass alone (rerun: 64 files, 965 tests green).
- A badge request on a long loaded line now sends up to one attempt-history read per cached ancestor (memoized 60 s); the provider request gate bounds concurrency. Not measured against a real forge.
- GitNexus impact and detect-changes still not run (review finding 3, MINOR): the worktree has no `.gitnexus`, and the worktree-isolation guard refuses commands aimed at the main checkout. Root must run both in an indexed checkout before merge. Callers of the changed cache reads were checked by text search instead: only coordinator.ts cachedSnapshot and cachedDetail.
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
