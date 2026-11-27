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
- `allowNext` accepts any `https://api.bitbucket.org/2.0/` next link (the snapshot path's rule), rather than a narrower per-collection prefix: one rule for every Bitbucket Cloud page; the hostile-link test covers http, other host, other port, other prefix.
- No change to http.ts credential stripping: `downloadCiLog` already drops Authorization on a cross-host redirect; a test pins it for Bitbucket.
- Version 0.44.0 with the plan's CHANGELOG line, as Phase 17's text says, though the tab stays hidden until Phase 18.
- ciHistoryPartialCoverage now injects a 403 so it still tests the floor detail; without it the test would hit the real network.

## Open risks
- No mid-read re-run detection for Bitbucket (GitLab has `retriedMidRead`); a pipeline re-run during the read can mix steps.
- `bun run test`: diffBudgets' wall-clock budget failed in every full-suite run on this machine (93-95 ms vs 59), passed 3/3 alone and on base under load once; src/diff is untouched.
- GitNexus detect-changes: risk high (activateRepositoryMode in 9 flows; the change there is one extra argument). Index is the main checkout's.
- E2E (Gate E) not run locally; CI runs it.

## Next phase: 18

## Found outside scope
- ciBisectHandler still posts progress and a result if the switch turns off mid-run (only the stopped reply is guarded).
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 (red on base 93e148bc too); updateWithLocalChanges.integration fails on Node 24.3.0 (red on base too). Both pass on Node 22 (CI's version).
- GitHub carryScans treats two missing `runAttempt` values as the same run; `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18); knip hint: selectedRemovalCrashWorker.ts in knip.jsonc.
- gitlabProvider.ts:677 sets `id` twice; impeccable flags a pre-existing broken-image pattern at commitChecksTab.integration.test.tsx:1602.
