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
- Built (0.44.0): Bitbucket Cloud `getDetail` (pipelines, steps as jobs, statuses minus each pipeline's own status), the overflow scan of failed steps past 1 000, step logs through `downloadCiLog`, Stop (`runAction` cancel = `stopPipeline`), the usual duration. C3: a 403 keeps the flat list plus `scopeHelp`, never saved. Contract version 10.
- Fix round 1 (3bd515fc): `allowNext` stays under the selected repository's API path; mixed step attempts are refused; the overflow scan ignores a stale first-page count; runs carry `startedAt`; Stop needs a queued or running run in the fresh read.

## Decisions and why (fix round 2)
- Log redirect: `followRedirects` got `credentialScope` (a URL prefix, case-blind); a redirect outside it strips the credentials for good, like an origin change. `DownloadCiLog` takes it as an optional 4th argument; Bitbucket passes `<repo API>/`; the activation wrapper forwards it. http.ts's origin rule is unchanged for GitHub and GitLab.
- Attempts: a step page whose `run_number` differs from the listed pipeline's `run_number` throws "Remote data changed" (unavailable, never saved). Only checked when both numbers are present.
- Stop at admission: `runAction` re-reads the pipeline inside the write's admission callback, before the fence (`requireStoppable`: same uuid, queued or running, same attempt via the new `CiActionRequest.attempt` that `runCiAction` fills from the run). It throws `RequestNotSentError`, so nothing is fenced or sent. The re-read would queue behind its own slot in the request gate, so `CommitChecksRequestGateRegistry.holding` lets reads made inside the admission callback share the held slot (AsyncLocalStorage, opt-in per call, used only in `writeFor`). Passed on: an ungated read (the provider has only gated transports) and a deeper gate rewrite.
- Malformed collection: `valuesOf` throws on a page with no `values` list instead of returning []; it reuses the existing "Remote data changed. Reload and try again." text (no new translation).
- Overflow scan: an empty page no longer stops the scan when its next link is new and allowed; the repeated-link guard stays and now has its own test.

## Open risks
- Mixed-attempt and Stop attempt checks compare `run_number`; not checked against live Bitbucket data (if one pipeline's steps legitimately carry other numbers, the detail shows unavailable).
- A chain of empty pages with always-new links under the repository path is followed one page per scan step with no page cap (the first-page count is not a stop, by round 1). Bitbucket's own API is the only source.
- Missing `run_number` on either side skips the attempt check.
- `bun run test` on Node 26 (this machine): commit-list-column-resize fails (Node 26 localStorage; red on base too); it passes on Node 24.3.0.
- GitNexus detect-changes: risk high earlier (activateRepositoryMode, one extra argument). E2E (Gate E) runs on CI.

## Next phase: 18

## Found outside scope
- Review finding: commit details' forced `-M` rename detection (dc190ef5, #454, already in the base) drops the deleted row, so with diff.renames=false the old file contents are unreachable. Needs its own fix: resolve the source path against the selected parent in the commit-diff route.
- Bitbucket `getChecks` (snapshot path, before Phase 17) still follows any `/2.0/` next link on the API origin with the bearer token, another repository's included.
- ciBisectHandler still posts progress and a result if the switch turns off mid-run (only the stopped reply is guarded).
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails on Node 26 (red on base too); updateWithLocalChanges.integration fails on Node 24.3.0 (red on base too). Both pass on Node 22 (CI's version).
- GitHub carryScans treats two missing `runAttempt` values as the same run; `bun run package` can pack ignored `output/` leftovers; noRepositoryMode.ts registers a placeholder `refreshBadges`.
- CommitPanelViewProvider never posts `commitChecksEnabled` (owner question for Phase 18); knip hint: selectedRemovalCrashWorker.ts in knip.jsonc.
- gitlabProvider.ts:677 sets `id` twice; impeccable flags a pre-existing broken-image pattern at commitChecksTab.integration.test.tsx:1602.
- GitHub and GitLab log downloads still strip credentials on an origin change only (no repository scope); the same-origin case does not arise for them today.
