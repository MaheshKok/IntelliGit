# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual: two review findings fixed by hand after the takeover halt; owner OK 2026-11-11.
- Phase 2 history and review notes: PLAN.review-log.md and git history of this file (05085924).

## Phase 3 build record, started at bfea91127a0669ea2d1311d7dca28550cf8973f3
- Commits on feat/397-ci-checks-phase-3: builder bd0477d7, fix round 1 b67e21cf, docs 33c1ec9f (halt record + owner answer), fix round 2 00e2e744, fix round 3 dc255fb6, takeover 1b24388d. Branch base 05085924 (main moved on), so review 05085924..HEAD.
- Scope built: GitLabProvider getDetail, continueFailedScan, allowNext; capabilities runs, jobs, runHeader true (steps false); gated fetchWithMeta and cooldownEnd for "gitlab"; CiFailedScanCursor gains `listed?` and `runVersion?`; CiDetailFetch gains `sessionOnly?`; CI_DETAIL_CONTRACT_VERSION 3; README, CHANGELOG 0.43.6, Gate L strings "Malformed x-next-page header." and "This pipeline has no update time, so a retry during the scan cannot be ruled out.".
- Fix rounds 1-3: missing x-total, retry between scan pages, found jobs left in otherChecks; GitLab-only `status:<job id>` drop; no carry without `runVersion`; header read after jobs, a differing header gives `complete: false`; a version-less scan ends stopped.
- Takeover (review-3-2): a pipeline whose list entry has no `updated_at` and whose jobs took more than one page returns `sessionOnly: true`; detailService then deletes the key from the persistent cache instead of saving, so a possibly mixed-attempt tree (fail, retry, fail again mid-read) is served for the session and read again after a restart.
- Hand fixes after the takeover halt (owner chose C): e59cf746 keeps job statuses of a pipeline cut at the job bound out of otherChecks by `pipeline_id` (GitLab's Entities::CommitStatus field) and blocks the saved key when a session-only delete fails. Codex ACCEPT on e59cf746. R1 (Fable) then found that any failed save or drop must block the key, and that listed pipeline ids went into request paths unencoded; fixed test-first in 15a47c9d, plus a test pinning that an overflow scan checks the version its jobs were read under. Seven mutations, each red on its own assertion.
- PR #419 review (cubic): a one-page jobs read with no listed `updated_at` is session-only too, because the header is a second response read after the jobs; README, the `runChanged` doc and the GitNexus citation corrected.

## Owner answer after the Phase 3 halt (2026-11-11): GitNexus
- Owner's words: "A: use old map"
- The plan's Every-phase rule (PLAN.md:844) is met for Phase 3 by this stale-index impact run (by the wave session) plus the text search. The owner accepted this. Builders and reviewers must not halt on this rule again. The BLOCKED line above is answered by this section.
- index stale, NOT clean. Indexed commit 64d390b0a7b0c4c74be0464890fc1a9ba9c9a23d (main checkout, branch feat/ci-checks-tab), `staleness.commitsBehind` 10. The index predates every Phase 3 commit, so the GitLab detail code (getDetail, continueFailedScan, readDetail) is not in it; the text search below is the real caller evidence.
- Impact, direction upstream (index stale, NOT clean):
  - GitLabProvider: MEDIUM (shared axes MEDIUM), lower bound; 6 direct: commitChecksProviders.ts (import + createCommitChecksProviders), CommitGraphViewProvider.ts (import + constructor), UndockedViewProvider.ts (import + constructor).
  - CiFailedScanCursor: CRITICAL (shared axes HIGH), lower bound; 17 direct, 36 processes, modules CommitChecks and Webviews.
  - served: CRITICAL (shared axes LOW), exact; 4 direct, 37 processes, module CommitChecks.
  - carryScans: CRITICAL (shared axes LOW), exact; 1 direct, 37 processes, module CommitChecks.
  - continueFailedScan: UNKNOWN; two candidates (CommitChecksProvider.continueFailedScan in types.ts, GitHubProvider.continueFailedScan), 0 callers resolved for either. riskNote: "No callers resolved. Absence of edges is not evidence the symbol is unused ... Confirm with a text search before treating the change as safe." Treated as unresolved; text search below.
  - createCommitChecksProviders: LOW, exact; 1 direct (activateRepositoryMode).
- detect_changes, scope compare, base origin/main (index stale, NOT clean): changed 37 symbols in 31 files, 36 affected processes, risk critical. Not partial or truncated. Every affected process reaches the changed code through `served` (detailService.ts).
- Text search of callers on b67e21cf (src/, tests/):
  - provider getDetail / continueFailedScan: called only from CommitChecksCoordinator.getDetail (coordinator.ts:220, coordinator.ts:231-235). Coordinator getDetail callers: CommitGraphViewProvider.ts:256 (getCommitCiDetail, used by CommitGraphViewProvider.ts:451 and repositoryMode.ts:380 -> CommitInfoViewProvider.ts:229) and UndockedViewProvider.ts:1291. All three sit inside answerCommitCiDetailRequest, which returns at ciDetailHandler.ts:59 while the Checks tab switch is off. Pinned by ciDetailHandler.test.ts:64 "answers no request while the Checks tab switch is off" (getDetail never called, for every provider).
  - new GitLabProvider: commitChecksProviders.ts:41 (production, via repositoryMode.ts:317; test commitChecksProviders.test.ts:110-122), CommitGraphViewProvider.ts:212 and UndockedViewProvider.ts:400 (fallback lists used only when no providers are passed; repositoryMode.ts:353, 370, 913 pass them), capabilities.test.ts:54, gitlabDetail.test.ts:156 and 492.
  - CiFailedScanCursor: types.ts:36-112, detailService.ts:28, 40, 598, githubProvider.ts:302, 391, gitlabProvider.ts:351, 403; tests detailService.test.ts, githubDetail.test.ts, gitlabDetail.test.ts.
  - served: detailService.ts:179, 205, 247, 281, 383, 523 (defined at 629); tests detailService.test.ts and gitlabDetail.test.ts (finding 3).
  - carryScans: detailService.ts:253 (defined at 596); tests gitlabDetail.test.ts (finding 2).
  - continueFailedScan: coordinator.ts:231-235; tests commitChecksProviders.test.ts:48, 93, 122, gitlabDetail.test.ts:456, 532, 633, githubDetail.test.ts:1082.
  - createCommitChecksProviders: repositoryMode.ts:317; test commitChecksProviders.test.ts.
  - No caller whose behaviour Phase 3 changes is left without a test.

## Decisions and why
- Detail reads: pipelines list, then per pipeline its jobs, then the single pipeline (header), then commit statuses. Header after jobs gives a before/after identity pair with the list.
- Mid-read retry seen by status or `updated_at`: `complete: false` (GitHub's `rerun` pattern), re-read on the pending TTL.
- Version-less jobs read: `sessionOnly`, not `complete: false`, because the webview polls every incomplete detail (useCommitCiDetail.ts:136) and such a pipeline would be re-read every 30 s forever; not a new coverage reason, because coverage reasons are shown in the UI. Job ids were rejected as a retry identity: a retry's new jobs can land on any page, so only a full re-read could compare them. A single job page is not enough either: the header is a second response read after it (PR #419 review). The before-version is the list's only, since the header is read after the jobs.
- The scan cursor's `runVersion` is the list's `updated_at`; no `updated_at`: the scan ends "stopped" with the reason. Refresh rescans (carryScans unchanged).
- Job order: grouped by stage, stages ordered by lowest job id. `manual` maps to `neutral`. Scan dedup by `listed` ids; budget from the first page's `x-total` kept `?? null`.
- A GitLab 403 on a scan page stops it; only a 429 with a gate cooldown pauses.
- detailOf/flatDetail duplicated in gitlabProvider.ts to keep githubProvider.ts out of this phase.

## Open risks
- A version-less tree that mixed two attempts stays shown until Refresh or restart in that session (it is never saved).
- Reviewer probe file review-3-3 on 15a47c9d: 11 of 14 pass (the first halt's retry probes included). Red: its job-bound probe, only because its fake statuses carry no `pipeline_id`; "late pre-session-only settled save" (another window's older settled save lands after this window's session-only delete, so a restart serves the older tree); "failed session-only deletion ... after restart" (the block is in memory only). Both are the existing rule that a settled detail stays cached until Refresh; closing them needs a saved tombstone, a persisted-format change, left for the owner.
- Pipelines over 1 000 jobs: job statuses past the bound are matched by `pipeline_id` and kept out of Other checks; an external status or trigger (bridge) job of such a cut pipeline is hidden with them. Trigger (bridge) jobs of other pipelines appear only in statuses.
- `optional: true` is set from `allow_failure` while `optionalJobs` stays false until Phase 9.
- Translations for the two new strings were written by the builder, not an outside source.

## Phase 5: GitNexus
- index stale, NOT clean. Indexed commit 64d390b0a7b0c4c74be0464890fc1a9ba9c9a23d, `staleness.commitsBehind` 10; run by the Phase 5 session on base c246d0d4 under the owner's Phase 3 answer "A: use old map", which the delivery lead applies to Phase 5. The plan's Every-phase rule (PLAN.md:844) is met for Phase 5 by this run plus the text search below. Builders and reviewers must not halt on PLAN.md:844 for Phase 5. Do not re-index.
- Impact, direction upstream (index stale, NOT clean):
  - createHttpGetJsonWithMeta (http.ts:75): HIGH (shared axes LOW), exact; 2 direct, 19 total; modules CommitChecks, Git, Views.
  - FetchJson (http.ts type): HIGH (shared axes LOW), exact; 1 direct, 13 total.
  - CommitChecksRequestGateRegistry.observeResponse (requestGate.ts:84): HIGH (shared axes LOW), lower bound (2 call sites dropped); direct: commitChecksProviders.ts fetchJson (fetchFor) and gatedFetchWithMeta.
  - GitHubProvider.getChecks, GitLabProvider.getChecks: UNKNOWN; 0 resolved, 19 call sites dropped for receiver typing, interface with 4 implementations. Text search of src/: one production caller, coordinator.ts:418 (fetchChecks); coordinator getChecks callers CommitGraphViewProvider.ts:869 and UndockedViewProvider.ts:1877.
  - GitHubRequestGate.observeResponse (requestGate.ts:212): UNKNOWN, 0 resolved.
  - createHttpGetJson (http.ts:63): LOW, 19 total (name also matches a test mock).
  - http.ts (file): MEDIUM, 9 direct.
  - LOW: createCommitChecksProviders (1 direct, activateRepositoryMode), fetchAllCheckRuns, fetchAllStatuses, GitHubProvider.fetchSnapshot (4 or fewer total, via readDetail), CommitChecksCoordinator.fetchSnapshot (9 total), gatedFetchWithMeta (2 total), ProviderRequestGate.observeResponse (6 total).
- Badge path reaches every user: the badge snapshot requests are not behind the Checks tab switch (that switch guards only ciDetailHandler.ts:59). Requests that gain If-None-Match: githubProvider.ts:835 and :845 (check-runs), :870 and :880 (statuses), gitlabProvider.ts:288 (statuses). tests/unit/e2e/ciFixture.test.ts:95-96 asserts no HTTP detail and needs no change.
- Nothing on the badge path knows at call time whether a commit is incomplete (getChecks takes `(ref, hash)`); the incomplete flag has to come from the coordinator (fetchChecks, coordinator.ts:416-418) or the badge cache, from the previous snapshot of that hash. authGeneration (ciGenerations.ts:14, created at repositoryMode.ts:293 before createCommitChecksProviders at :317) can be read live in commitChecksProviders.ts.
- Delivery lead's limit for Phase 5: do NOT edit coordinator.withAccount or src/services/commitChecks/detailService.ts (queued Phase 18 items attach there). A builder that finds it must edit either one HALTS with the reason instead.

## Next phase
- Phase 5.

## Found outside scope
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on 05085924 too.
- GitHub carryScans also treats two missing `runAttempt` values as the same run; a GitHub-scope fix if run_attempt can be absent.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load; localization.test.ts:352 slow with many worktrees.
- `bun run package` can pack ignored leftovers under `output/` (88 entries).
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run hits the fixture socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- tsconfigCoverage and screenshotComparatorMeta resolve tools at <repo>/node_modules, failing in a worktree without its own.
- GitNexus index is behind HEAD (last indexed 64d390b); the worktree guard refuses compound commands naming git paths.
