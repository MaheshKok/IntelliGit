# CI Checks tab: handoff

## Phases accepted
- Phase 1: 3965f37a, verification incomplete. Phase 2: bfea9112, manual, owner OK 2026-11-11 (#415). Phase 4: f005d90f, verification incomplete (#417, d3438a11).
- Phase 19: f005d90f, verification incomplete (#418, 2490ec17). Phase 3: 15a47c9d, manual, owner OK 2026-11-11 (#419, c246d0d4). Phase 5: 6898d332, manual, owner OK 2026-11-12 (#420, 86088cab).
- Phase 6: 69e809bb, verification incomplete (#422, 51b0c3ab). Phase 7: 6fef8c59, manual, owner OK 2026-11-12 (#424, 36bef4be). Phase 8: b5a56002, manual, owner OK 2026-11-13 (#426, 7941c809).
- Phase 9: 37ba9d13, manual, elephant OK 2026-11-14 (#430, 63b8ea88). Phase 10: 8ff6422d, manual, owner "A" 2026-11-14 (#435, bc063074). Phase 11: b9d710d6, verification incomplete (#439, 928c1aae).
- Phase 12: owner accepted by hand 2026-11-18 at c874d0b3 (#444, 29efe7ec). Phase 13: owner accepted by hand 2026-11-21 at 3b31283b (#448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 (#450, f3cf1afa). Phase 15: accepted 20240fdf (#452; the wave accepted dd67fe22, verification incomplete).
- Phase 16: owner accepted by hand 2026-11-26 at 6518aa81 (squash-merged as 93e148bc, #457; relay timing findings filed as #456).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 17: review pending, started at 6518aa81d31a00c930a8555f7d6a573412f6a15c
- BASE_HEAD 6518aa81 is not an ancestor of HEAD (Phase 16 was squash-merged as 93e148bc); the build used 93e148bc as its base.
- Built (0.44.0): Bitbucket Cloud `getDetail` (pipelines, steps as jobs, statuses minus each pipeline's own status), the overflow scan of failed steps past 1 000 (`continueFailedScan`, `allowNext`), step logs through `downloadCiLog`, Stop (`runAction` cancel = `stopPipeline`), and the usual duration (newest earlier successful pipeline on the same branch).
- C3: a 403 on pipelines or steps keeps the flat status list (`floorDetail`, moved from coordinator.ts to normalize.ts) plus `scopeHelp {key, url}` shown by ChecksTab's `ScopeHint`, never saved (`sessionOnly`). Contract version 10.
- Tests: bitbucketCloudDetail.test.ts (20), commitChecksTab integration (scope hint), commitChecksProviders anchor + Bitbucket writer, capabilities (Bitbucket Cloud flags), ciHistoryPartialCoverage (floor path now reached through the 403).
- Mutation checks, all red naming their test: 8 provider mutations (mut.py) + hidden hint + ignored README anchor (mut2.py), scripts under $TMPDIR/phase-run/PLAN.

## Decisions and why (this step)
- Fix round 1: `allowNext` now requires the selected repository's API path (`/2.0/repositories/<ws>/<repo>/`, case-blind) on top of the snapshot rule, for detail, timing and overflow-scan links. The snapshot path (`getChecks`) keeps the broader `/2.0/` rule: existing tests pin it and it is not Phase 17 code.
- Fix round 1: a step read whose pages carry more than one `run_number` throws "Remote data changed", so the detail is unavailable and never saved; the overflow scan drops the stale first-page count as a stop (repeated-link and empty-page guards stay); runs get `startedAt` = `created_on`; cancel returns "changed" unless the fresh read shows the run queued or running (GitLab's cancel test now serves a running pipeline).
- No change to http.ts credential stripping: `downloadCiLog` already drops Authorization on a cross-host redirect; a test pins it for Bitbucket.
- Version 0.44.0 with the plan's CHANGELOG line, as Phase 17's text says, though the tab stays hidden until Phase 18.
- ciHistoryPartialCoverage now injects a 403 so it still tests the floor detail; without it the test would hit the real network.

## Open risks
- Mixed-attempt detection compares steps' `run_number` across the read pages; if Bitbucket legitimately gives one pipeline's steps different `run_number`s, the detail would show unavailable. Not checked against live data.
- `bun run test` on Node 26 (this machine): 8896 passed, 8 failed, all in commit-list-column-resize (Node 26 localStorage; red on base too); that file passes 8/8 on Node 24.3.0.
- GitNexus detect-changes: risk high (activateRepositoryMode in 9 flows; the change there is one extra argument). Index is the main checkout's.
- E2E (Gate E) not run locally; CI runs it.

## Next phase: 18

## Found outside scope
- Review finding, not fixed in fix round 1: commit details' forced `-M` rename detection (dc190ef5, #454, already in the base 93e148bc; the Phase 17 diff touches no file under src/git) drops the deleted row, so with diff.renames=false the old file contents are unreachable from the commit diff. Needs its own fix: resolve the source path against the selected parent in the commit-diff route.
- Bitbucket `getChecks` (snapshot path, before Phase 17) still follows any `/2.0/` next link on the API origin with the bearer token, another repository's included.
- ciBisectHandler still posts progress and a result if the switch turns off mid-run (only the stopped reply is guarded).
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 (red on base 93e148bc too); updateWithLocalChanges.integration fails on Node 24.3.0 (red on base too). Both pass on Node 22 (CI's version).
- GitHub carryScans treats two missing `runAttempt` values as the same run; `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18); knip hint: selectedRemovalCrashWorker.ts in knip.jsonc.
- gitlabProvider.ts:677 sets `id` twice; impeccable flags a pre-existing broken-image pattern at commitChecksTab.integration.test.tsx:1602.
