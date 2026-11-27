# CI Checks tab: handoff

## Phases accepted
- Phase 1: 3965f37a, verification incomplete. Phase 2: bfea9112, manual, owner OK 2026-11-11 (#415). Phase 4: f005d90f, verification incomplete (#417, d3438a11).
- Phase 19: f005d90f, verification incomplete (#418, 2490ec17). Phase 3: 15a47c9d, manual, owner OK 2026-11-11 (#419, c246d0d4). Phase 5: 6898d332, manual, owner OK 2026-11-12 (#420, 86088cab).
- Phase 6: 69e809bb, verification incomplete (#422, 51b0c3ab). Phase 7: 6fef8c59, manual, owner OK 2026-11-12 (#424, 36bef4be). Phase 8: b5a56002, manual, owner OK 2026-11-13 (#426, 7941c809).
- Phase 9: 37ba9d13, manual, elephant OK 2026-11-14 (#430, 63b8ea88). Phase 10: 8ff6422d, manual, owner "A" 2026-11-14 (#435, bc063074). Phase 11: b9d710d6, verification incomplete (#439, 928c1aae).
- Phase 12: owner accepted by hand 2026-11-18 at c874d0b3 (#444, 29efe7ec). Phase 13: owner accepted by hand 2026-11-21 at 3b31283b (#448, 49893e1f).
- Phase 14: owner accepted by hand 2026-11-22 at ca1834d5 (#450, f3cf1afa). Phase 15: accepted 20240fdf (#452; the wave accepted dd67fe22, verification incomplete).
- Phase 16: owner accepted by hand 2026-11-26 at 6518aa81 (squash-merged as 93e148bc, #457; relay timing findings filed as #456).
- Phase 17: owner accepted by hand 2026-11-27 at 7e1c1df9 (wave halted "review still failing after takeover"; targeted fix 841db208, 1ce80244, 7e1c1df9).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 17: owner accepted by hand, started at 6518aa81d31a00c930a8555f7d6a573412f6a15c
- BASE_HEAD 6518aa81 is not an ancestor of HEAD (Phase 16 was squash-merged as 93e148bc); the build used 93e148bc as its base.
- Built (0.44.0, b22292a6): Cloud `getDetail` (pipelines, steps as jobs, statuses minus each pipeline's own), overflow scan, step logs, Stop, usual duration, C3 hint. Contract version 10.
- Fix round 1 (3bd515fc) and round 2 (a27a873f): repository-scoped `allowNext` for detail, log redirect scope, mixed-attempt refusal, Stop re-read at admission, malformed and empty pages.
- Takeover (1429f584): the 11 review findings after round 2, each with a regression test.
- Targeted fix after the halt (841db208 tests, 1ce80244 fix, 7e1c1df9 tests): Stop needs the confirmed attempt; the repository is checked again after the final admission read; a failed final read is a Stop not sent (a 401 keeps sign-in); a revoked slot waits for its in-flight shared read; the C3 fallback names a refused link as `rejectedNext`.

## Decisions and why (takeover)
- Status pager (snapshot and the C3 fallback) uses `allowNext`; a refused link marks the snapshot partial. Old snapshot pagination tests moved their links under `/2.0/repositories/acme/app/` (they encoded the broad `/2.0/` rule).
- Displayed attempt: the cancel button sends `attempt`; the host validates it (safe integer) and `runCiAction` refuses when the first fresh read shows another attempt; the provider re-checks it at admission and again after the fence.
- Stop admission order (provider callback): re-read, cooldown check, fence, re-read. Write wrapper: sign-in check before the callback, sign-in and cooldown check again before the POST. Cooldown refusals after admission are `RequestNotSentError`, not gate 429s, so they never re-arm the cooldown.
- Request gate: `holding` needs an active slot the caller was admitted to (else rejects). Shared reads run one at a time inside that slot and are admitted and counted like any request (cooldown, rolling budget, send guard). The slot's lease is revoked on release, so detached work queues normally. Passed on: a counter-based slot reuse (cannot tell a live owner from detached work).
- Detail: steps without `run_number` trigger one fresh pipeline read; another uuid or attempt is "Remote data changed" (unavailable, never saved). Overflow refuses any row naming another attempt.
- `runAction` rejects every action except cancel with the existing "cannot re-run or cancel" text.
- `DownloadCiLog` gained a 5th argument `credentialHeaders`; Cloud passes `["authorization"]`; the activation wrapper forwards it.

## Open risks
- `run_number` checks are unverified against live Bitbucket data; a pipeline whose steps legitimately omit `run_number` costs one extra read per pipeline per detail fetch.
- A chain of empty pages with always-new links under the repository path has no page cap beyond the rolling budget (the reviewer's probe shows it pauses at 300 requests).
- GitNexus impact and detect-changes were not run in the takeover: no runner in this worktree and no GitNexus tool offered.
- `bun run test` on Node 26: commit-list-column-resize fails (Node 26 localStorage; red on base too).

## Next phase: 18

## Found outside scope
- Review finding: commit details' forced `-M` rename detection (dc190ef5, #454, already in the base) drops the deleted row, so with diff.renames=false the old file contents are unreachable. Needs its own fix in the commit-diff route.
- ciBisectHandler still posts progress and a result if the switch turns off mid-run (only the stopped reply is guarded).
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 (red on base too); updateWithLocalChanges.integration fails on Node 24.3.0 (red on base too). Both pass on Node 22 (CI's version).
- GitHub carryScans treats two missing `runAttempt` values as the same run; `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18); knip hint: selectedRemovalCrashWorker.ts in knip.jsonc.
- gitlabProvider.ts:677 sets `id` twice; impeccable flags a pre-existing broken-image pattern at commitChecksTab.integration.test.tsx:1602.
- GitHub and GitLab log downloads still strip credentials on an origin change only (no repository scope) and pass no provider header list.
