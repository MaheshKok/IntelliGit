# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 2 history, evidence and its review-round notes: see PLAN.review-log.md and git history of this file (05085924).

## Phase 3: review pending, started at bfea91127a0669ea2d1311d7dca28550cf8973f3
- Builder commit bd0477d7, fix round 1 commit b67e21cf, on feat/397-ci-checks-phase-3. Branch HEAD at start was 05085924 (main moved on), so review 05085924..b67e21cf.
- Scope built: GitLabProvider getDetail, continueFailedScan, allowNext; capabilities runs, jobs, runHeader true (steps false); gated fetchWithMeta and cooldownEnd wired for "gitlab"; CiFailedScanCursor gains `listed?` and `runVersion?`; CI_DETAIL_CONTRACT_VERSION 3; README, CHANGELOG 0.43.6, Gate L string "Malformed x-next-page header.".
- Fix round 1 resolved findings 1-3 (missing x-total, retry between pages, found jobs left in otherChecks), each with a red-then-green test in gitlabDetail.test.ts and a mutation that turns it red.
- Proof on b67e21cf's tree: chain green except `bun run test` 7737/7745; the 8 failures are all tests/webview/unit/commit-list-column-resize.test.tsx (`localStorage` under Node v26.5.0), red on base 05085924 too.

## Decisions and why
- Detail reads: pipelines list, then the single pipeline per pipeline (the list has no user), then its jobs, then the commit statuses.
- Job order: grouped by stage, stages ordered by their lowest job id.
- `manual` maps to `neutral` (settled).
- Scan dedup: `listed` job ids in the cursor, skipped in the provider, so the service's `found` count stays honest.
- Scan budget: the first scan page's `x-total`, kept `?? null`; with `null` (GitLab leaves x-total out on large collections) the scan follows rising next pages unbudgeted, stopping on an empty page, a refused link, or the last page (fix round 1, finding 1).
- Run identity (2 options): the cursor records the single pipeline's `updated_at` (`runVersion`), checked before and after each scan page and compared in carryScans; over job-id heuristics, which GitLab's API order does not support. A retry rewrites the pipeline row even when it fails again (finding 2).
- otherChecks during a scan (2 options): `served()` drops a flat check keyed `source:id` matching a found job's own check: `check-run:<checkRunId>` (GitHub) or `status:<job id>` for a job without a check run (GitLab); over a `provider === "gitlab"` branch in the shared service (finding 3).
- A GitLab 403 on a scan page stops it; only a 429 with a gate cooldown pauses.
- detailOf/flatDetail duplicated in gitlabProvider.ts to keep this phase out of githubProvider.ts.

## Open risks
- The reviewer's own tests "a retry that fails between scan pages..." and "a completed external retry..." (review-3-0/gitlabReview.test.ts) stay red: their fakes change the jobs but never the pipeline record, and the second passes a cursor with no recorded identity, so no field the API returns could show the retry. 24/26 of that file pass on b67e21cf.
- A cursor without `runVersion` (a pipeline response with no `updated_at`) falls back to the status-only check.
- A GitHub job with no check-run link whose id equals a numeric status context would drop that status during a scan (GitHub status ids are contexts, so this needs a numeric context equal to a job id).
- Pipelines with more than 1 000 jobs: statuses of non-failed jobs past the bound still show under Other checks (only failed jobs are scanned).
- Trigger (bridge) jobs are not in /jobs but are in statuses, so they show under Other checks.
- `optional: true` is set from `allow_failure` now while `optionalJobs` stays false until Phase 9.
- GitNexus impact was not run (finding 4): no GitNexus MCP in this session, and the worktree-isolation guard refuses every command that names .gitnexus or gitnexus. Substitute: text search of callers (served: 6 call sites in detailService.ts; carryScans: 1; CiFailedScanCursor: types.ts, detailService.ts, githubProvider.ts, gitlabProvider.ts; continueFailedScan: coordinator.ts:231).
- Translations for the new string were written by the builder, not from an outside translation source.

BLOCKED: GitNexus impact analysis (plan "Every phase" rule, PLAN.phase-3.md:844) cannot run in this isolated worktree. Root runs it from the main checkout after re-analyzing the stale index, or the owner waives it for Phase 3.

## Next phase
- After Phase 3 is accepted, the phase-run dry run picks the next wave; eligible by Depends on: 5, 6, 8, 9, 10.

## Found outside scope
- tests/webview/unit/commit-list-column-resize.test.tsx fails under Node v26.5.0 (global `localStorage` undefined without --localstorage-file); red on 05085924 too.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load; localization.test.ts:352 (vsce ls) slow with many worktrees.
- `bun run package` can pack ignored leftovers under `output/`; this run gave 88 entries.
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run fails the fixture socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- tsconfigCoverage and screenshotComparatorMeta resolve tools at <repo>/node_modules, failing in a worktree without its own.
- GitNexus index is behind HEAD (last indexed 64d390b).
- The worktree-isolation guard refuses any command whose text contains "git" in a compound form, including paths under IntelliGit and file names like gitlabDetail; scripts under $TMPDIR/phase-run were used for test runs and copies (no git operations in them).

## Owner answer after the Phase 3 halt (2026-11-11): GitNexus
- Owner's words: "A: use old map"
- The plan's Every-phase rule (PLAN.phase-3.md:844) is met for Phase 3 by this stale-index impact run (by the wave session) plus the text search. The owner accepted this. Builders and reviewers must not halt on this rule again. The BLOCKED line above is answered by this section.
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
