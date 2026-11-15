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
- Phase 9: accepted 37ba9d13, manual: finished by hand; elephant OK 2026-11-14 after the owner's answer "C: track in #432" (squash-merged as #430, 63b8ea88).
- Phase 10: accepted 8ff6422d, manual: finished by hand after the takeover halt, owner answer "A" 2026-11-14 (squash-merged as #435, bc063074). Its open risks stand; details in this file's git history.
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 11: review pending, started at 2d44491ccdfa81fd955af4833ee4bade874a5f34
- Earlier commits: built 350f627c; fix 1 8ace3e72; fix 2 e0ee196e; takeover a4017dc0; halt c87668db; owner answer 17562890; wave re-run ca89903e; fix 1 f4856222; fix 2 e2da990e.
- Takeover (this wave, commit after e2da990e): closes the 6 open review findings on partial coverage. GitLab marks a full first status page (100 rows) `partial`; Bitbucket Cloud marks a present but refused or malformed `next` link truncated; Bitbucket Server marks `isLastPage:false` with no numeric `nextPageStart` truncated; `floorDetail` turns `partial` into `otherChecksCoverage: {reason:"pageBound", shown}`; a partial snapshot is never persisted and its L1 entry expires on the pending TTL; persisted schema version 2 drops every pre-flag (version 1) entry. Regression file tests/unit/services/commitChecks/ciHistoryPartialCoverage.test.ts: 7 tests red before, green after; 7 mutations red at their named tests.
- Built: each failed check is tagged "new" / "still" / "unknown", a passed one "fixed", against the first parent; "also red on {branch}" against the default branch tip read from origin/HEAD on every request (K22); "default branch unknown" when origin/HEAD is missing. Partial parent: failed job "unknown"; partial tip: no also-red.
- Pure logic in src/shared/ci/history.ts; host read `readCiHistory` in src/services/commitChecks/ciHistory.ts; message `requestCiHistory` / `ciHistory` answered by src/views/ciHistoryHandler.ts in all three hosts; tab hook useCiHistory.ts; tags in CheckTree.tsx.
- Second halt: takeover b1f93bab, halt recorded 9bc5b0d8.
- Owner answer after the second halt (2026-11-15, "1: approve, re-run"):
  (i) The snapshot cache going from schema 1 to 2 is approved (PLAN.md Migrations, :743).
  (ii) Open finding 1 must be fixed: raise `CI_DETAIL_CONTRACT_VERSION` from 6 to 7 (`src/shared/ci/contractVersion.ts:5`), as the file's own rule at :2-3 says ("Every phase that adds or changes a persisted detail field bumps it"). Add a test: a truncated detail saved under version 6 is a miss after a restart and cannot show "new". Mutation: put 6 back; the red line must name the assertion. The reviewer's repro: `cd /private/tmp/phase-run/PLAN/review-11-3 && python3 .scratch/repro.py legacy`.
  (iii) The plan's current Done-when is a Patch bump to 0.43.13 with the groundwork CHANGELOG line (`PLAN.md:1028`). Any plan copy that says "Minor bump" is stale; the Nov 11 slices were deleted.
  (iv) Pre-existing, not Phase 11's work: #437 (Bitbucket Cloud follows a next link to another port with the token) and #438 (a broken next page from GitHub or Bitbucket Server is read as the end of the list). The CHANGELOG-sentence test on repro/405-1 is the stale-copy mix-up, not a bug. All 5 tests on repro/405-1 fail on both 3fa214d8 and b1f93bab (checked by the elephant on clean copies).

## Decisions and why
- Header rule: `branchUnknown = history flag ?? detail flag`; history saying missing makes required unknown and drops the scope line; never the other direction.
- Tree rule: blocks-merge tags need `history?.defaultBranch !== null`.
- Bitbucket snapshot items get no logicalId; Phase 18 may set `"status\0" + key` on both sides.
- "unknown" only on a red check without a unique match; root commit no tags; merge commit first parent only.
- Handler answers only while isE2eControlChannelActive is on (declined twice; tab hidden outside E2E; Phase 18 removes the switch check).
- Partial coverage withholds tags rather than guessing.
- Takeover, GitLab: a full first page is partial instead of following pages. Following needs response headers, and getChecks reads through `fetchJson`, which ~30 provider tests pin as a single call; a commit with 100 or more statuses therefore always gets "unknown" history tags on GitLab.
- Takeover, legacy cache: schema bump, not a positive "read in full" marker. A pre-flag entry exists only as a version 1 payload, which is now a miss. The reviewer's check "restart with an old unflagged truncated parent" builds its entry through today's cache (version 2) with `partial` removed, which no current code path can write (every provider flags a cut list, partial is never persisted); it stays red by design. Needs the owner only if the reviewer repeats it.
- `floorDetail` reason: snapshots name no reason, so "pageBound" is used for any partial snapshot.

## Open risks
- GitNexus impact not run (worktree-isolation guard); CheckTree and ChecksHeader each have one caller (ChecksTab.tsx). LOW, not graph-checked.
- Two same-named jobs in different workflows always give "unknown".
- Phase 11 e2e not run locally (Gate E runs on CI).
- Schema bump empties every user's persisted check cache once on upgrade (refetch); an old and a new window sharing globalState overwrite each other's payload until both update.
- `bun run test`: 10 failed, 8233 passed of 8243; the known set (commit-list-column-resize, tsconfigCoverage, screenshotComparatorMeta).

## Next phase: 12

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize fails under Node v26.5.0; tsconfigCoverage and screenshotComparatorMeta fail in a worktree without its own node_modules.
- operationBenchmark.test.ts fails in a full run, passes alone; diffBudgets "large compute" is load-sensitive.
- l10n audit pre-existing hardcoded-string candidates; knip hint on selectedRemovalCrashWorker.ts.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers.
- noRepositoryMode.ts registers a placeholder `refreshBadges`.
- GitNexus registry holds two "IntelliGit" entries; main checkout index stale.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store.
- Worktree node_modules lacks .bin; mutation copies use rsync (excluding node_modules/.git) plus a node_modules link to the main checkout.
- GitLab snapshot could follow `x-next-page` pages if getChecks moved to `fetchWithMeta` (needs the provider tests rewired).
