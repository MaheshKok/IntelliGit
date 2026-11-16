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
- Built 02881057, fix rounds 36c1f1b9 and 5a06ca01, takeover 6e448ca8, halted (review log line 1322). Owner answer 2026-11-16 (E3): rerun with items (a) to (e); this rerun builds them on top of 23cce0fc.
- (a) Cache-only reads (`getCached`) in CommitChecksService and CommitCiDetailService never join a running fetch; while one runs they serve a valid stored copy (L1, then L2) at once, keeping the generation and fence checks. A copy the refresh replaced during the store read is not served (the read misses), and a store read during a refresh does not fill L1, so a normal request still joins the refresh.
- (b) changedSinceGreen drops an ancestor check whose known logical id is not the selected job's before the match, so other workflows' same-named jobs neither match nor stop the walk. Applied in the walk only: Phase 11's tags keep their whole-commit rule (ciHistory.test.ts "a fallback name repeated by another identified parent is ambiguous").
- (c) `CiRangeDiffGrant` (src/views/ciChangedSinceGreenHandler.ts): each host (graph views, Changed Files, undocked panel) records the answer it posts and `openCiRangeDiff` opens only an exact (lastGreen, hash, path, oldPath, status) of the latest answer for the current repository; cleared on the webview's ready (reload) and dispose.
- Review fix round 1 (on top of cd700bab): `record()` keeps the reply's requestId and ignores a reply with a lower id than the recorded one (webview ids are monotonic per page; an equal id replaces); test "keeps the newest request's file list openable when an older reply arrives last" was red (0 of 2 reads) before. New test "refuses a listed file opened under another valid status" guards the status comparison; mutation M11 (drop it) turns that test red.
- (d) Confirmed from the current docs (fetched 2026-11-16): GitHub "List jobs for a workflow run", `filter` = `latest` | `all` ("all returns all jobs for a workflow run, including from old executions"), https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run ; GitLab "List all jobs by pipeline", `include_retried` boolean ("Include retried jobs in the response. Defaults to false"), https://docs.gitlab.com/api/jobs/#list-all-jobs-by-pipeline . No O3 fallback needed; no code change.
- (e) The reviewer's three red cases are tests/unit/services/commitChecks/changedSinceGreenCaches.test.ts.
- Proof: every new test red before its fix (23 red), green after; 18 mutations on a copy, each red at a named test (review log).

## Decisions and why
- (b) in the walk, not in `matchCheck`: changing the shared join would turn Phase 11's "unknown" tag into "new" for an unidentified parent beside another workflow's identified one.
- (c) the grant also compares the file's status: it is part of what the host sent, and costs one comparison.
- File list is a plain button list, not CommitChangedFilesPanel: that panel needs a whole CommitDetail and tree state; plan step 5 is "[ASSUMED] where props allow".
- The standalone Changed Files view has no commit list, so its host sends the Git Log graphs' loaded commits; the graph webviews send their own.
- scopeName = the run's name. Flaky tag only when the commit's run, job and flat lists are whole (same rule as Phase 11 tags).
- Ancestor attempt reads go to the provider (spec fetching rule), only for ancestors whose snapshot is cached.
- Handlers answer only while isE2eControlChannelActive is on (as Phase 11).

## Open risks
- Grant and repository switch: a record for another repository is refused and dropped at the next open; a switch away and back with no open in between keeps the record (it lists only files the host sent for that same repository). Hosts have no shared repository-switch hook; adding one means wiring activation code.
- Local `bun run test`: Node 26.5.0 reds commit-list-column-resize (8 tests, red at 90731f87 too); 530 of 531 files, 8376 of 8384 tests passed.
- A badge request on a long loaded line sends up to one attempt-history read per cached ancestor (memoized 60 s). Not measured against a real forge.
- GitNexus impact and detect-changes not run: the worktree has no `.gitnexus`; Root runs both in an indexed checkout before merge, or the owner waives them (review finding 3, MINOR; not decidable by the builder).
- Gate E not run locally; the spec runs on CI. Contract 8 empties persisted CI detail caches once on upgrade.
- The reviewer's copy also holds two "restart" cases expecting a miss during a forced refresh; they contradict owner item (a) and were not copied.

## Next phase: 13
## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- tests/integration/git/updateWithLocalChanges.integration.test.ts fails on Node 24.3.0; commit-list-column-resize fails on Node 26.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- Mutation copies must link the main checkout's node_modules; a copy has no .git or dist.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta`.
