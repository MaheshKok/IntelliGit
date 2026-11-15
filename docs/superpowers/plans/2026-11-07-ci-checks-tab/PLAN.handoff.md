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
- Second halt: takeover b1f93bab, halt recorded 9bc5b0d8. Owner answer after it (2026-11-15, "1: approve, re-run"):
  (i) The snapshot cache going from schema 1 to 2 is approved (PLAN.md Migrations, :743).
  (ii) DONE in the third wave run (commit after 65ca07cc): `CI_DETAIL_CONTRACT_VERSION` 6 -> 7. Test "a truncated detail saved under contract version 6 is a miss after a restart and cannot show new" (commitChecksHistory.integration.test.tsx) seeds a version 6 entry claiming full coverage, restarts the detail service, and renders the tags: red before the bump ("a version 6 entry must be a miss after a restart: expected vi.fn() to be called 1 times, but got 0 times"); mutation "put 6 back" red at both named assertions (the second: "must not certify new: expected [ 'new', 'also red on trunk' ] to deeply equal [ 'unknown' ]") plus detailService "the detail contract version is 7".
  (iii) Checked: package.json 0.43.13 and the CHANGELOG groundwork line are in place; the phase slice says Patch bump.
  (iv) Pre-existing, not Phase 11's work: #437 (Bitbucket Cloud follows a next link to another port with the token) and #438 (a broken next page from GitHub or Bitbucket Server is read as the end of the list). The CHANGELOG-sentence test on repro/405-1 is the stale-copy mix-up, not a bug. All 5 tests on repro/405-1 fail on both 3fa214d8 and b1f93bab.
- Fix round 1 of the third review (commit after c26a7abd): `fetchSnapshot` now reads the check-suite count (`refAtSuiteLimit`) and marks the snapshot `partial` at 1 000 suites, or when that count cannot be read on the badge path (the detail path still fails with it). `readDetail` reuses the result instead of asking twice. Cost: one `check-suites?per_page=1` request per GitHub badge fetch (3 instead of 2); view-providers integration budgets 28 -> 42 and 96 -> 144, httpEtag route and counts updated. Test "at 1000 check suites the badge snapshot a parent comparison reads is partial: true" was red ("expected undefined to be true") before the fix.

## Decisions and why
- Header rule: `branchUnknown = history flag ?? detail flag`; history saying missing makes required unknown and drops the scope line; never the other direction.
- Tree rule: blocks-merge tags need `history?.defaultBranch !== null`. Partial coverage withholds tags rather than guessing.
- Bitbucket snapshot items get no logicalId; Phase 18 may set `"status\0" + key` on both sides.
- "unknown" only on a red check without a unique match; root commit no tags; merge commit first parent only.
- Handler answers only while isE2eControlChannelActive is on (declined twice; tab hidden outside E2E; Phase 18 removes the switch check).
- Takeover, GitLab: a full first page is partial instead of following pages. Following needs response headers, and getChecks reads through `fetchJson`, which ~30 provider tests pin as a single call; a commit with 100 or more statuses therefore always gets "unknown" history tags on GitLab.
- Takeover, legacy cache: schema bump, not a positive "read in full" marker. A pre-flag entry exists only as a version 1 payload, which is now a miss. The reviewer's check "restart with an old unflagged truncated parent" builds its entry through today's cache (version 2) with `partial` removed, which no current code path can write (every provider flags a cut list, partial is never persisted); it stays red by design. Needs the owner only if the reviewer repeats it.
- `floorDetail` reason: snapshots name no reason, so "pageBound" is used for any partial snapshot.
- Contract version 7 belongs to Phase 11 (owner order); K32's list (2, 3, 7, 9, 10, 12, ...) does not name 11, so Phase 12 bumps to 8. Plan text not amended.

## Open risks
- GitNexus impact not run (worktree-isolation guard); CheckTree and ChecksHeader each have one caller (ChecksTab.tsx). LOW, not graph-checked.
- Two same-named jobs in different workflows always give "unknown". Phase 11 e2e not run locally (Gate E runs on CI).
- Snapshot schema bump 2 and detail contract 7 empty every user's persisted check and detail caches once on upgrade (refetch); an old and a new window sharing globalState overwrite each other's payload until both update.
- `bun run test`: 10 failed, 8234 passed of 8244; the known set (commit-list-column-resize, tsconfigCoverage, screenshotComparatorMeta).

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
