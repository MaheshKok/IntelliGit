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
- Earlier commits: built 350f627c (0.43.13); fix 1 8ace3e72; fix 2 e0ee196e; takeover a4017dc0; halt c87668db; owner answer 17562890.
- Wave re-run (owner answer "2: re-run the wave", 2026-11-15): the rebuild commit on top of 17562890 fixes the open Codex finding: once a history answer says the default branch is missing, the header shows "required: unknown", drops the "required checks from <branch>" scope line, and the tree drops every blocks-merge tag (§8). Regression "a history answer with no default branch makes required status unknown over a known detail"; 3 mutations red (log).
- Fix round 1 (this wave): history reply stored only when requestId, repoKey and hash all match the newest request (useCiHistory.ts); CheckTree tags nothing but "unknown" on a failed check while runsCoverage, any run's jobsCoverage or otherChecksCoverage is not "full". Codex finding 1 (answer history outside E2E) DECLINED, see Decisions.
- Built: each failed check is tagged "new" / "still" / "unknown", a passed one "fixed", against the first parent; "also red on {branch}" against the default branch tip read from origin/HEAD on every request (K22); "default branch unknown" when origin/HEAD is missing.
- Pure logic `join` / `compare` / `alsoRed` / `historyChecksOf` in src/shared/ci/history.ts; host read `readCiHistory` in src/services/commitChecks/ciHistory.ts; message `requestCiHistory` / `ciHistory` answered by src/views/ciHistoryHandler.ts in all three hosts; tab hook useCiHistory.ts; tags in CheckTree.tsx.
- Takeover recap: header unknown line follows the history answer once it arrives; Bitbucket snapshot items carry no logicalId (fixtures); each history answer renders only for the detail it was asked for.

## Decisions and why
- Header rule: `branchUnknown = history flag ?? detail flag`; true -> required unknown and no scope line. One direction only (history saying missing); a history answer saying the branch is known does not turn a detail's unknown required status into known, since required status comes from the detail's own read.
- Tree rule: blocks-merge tags need `history?.defaultBranch !== null`; before history answers the detail's own required marks stand.
- Bitbucket snapshot items get no logicalId (APIs name no workflow or pipeline); Phase 18 may set `"status\0" + key` on both sides.
- Pure functions in src/shared/ci/history.ts (webview may not import src/services).
- "unknown" only on a red check without a unique match; root commit no tags; merge commit first parent only; no also-red tag on the tip itself; unreadable snapshot gives `items: null`.
- The handler answers only while isE2eControlChannelActive is on; Phase 18 removes the switch check. Declined again in fix round 1: the tab is hidden outside E2E (checksTabState.ts:47-49), so the webview never asks, and the guard stops a forged message from starting a provider fetch while the tab is hidden, as ciDetailHandler.ts:99 does; no "source enabled" state exists to gate on. Needs the owner only if the reviewer repeats it.
- Partial coverage: tags are withheld (red check -> "unknown", no also-red) rather than guessed, because a hidden workflow, job or flat check may share the name.

## Open risks
- GitNexus impact/detect-changes not run (worktree-isolation guard refused the CLI before); substitute: CheckTree and ChecksHeader each have one caller (ChecksTab.tsx). Risk assumed LOW, not graph-checked.
- Two same-named jobs in different workflows always give "unknown" (snapshot has no workflow name).
- Phase 11 e2e not run locally.
- `bun run test`: 10 failed, 8213 passed of 8223; the known set (8 commit-list-column-resize on Node v26.5.0, tsconfigCoverage, screenshotComparatorMeta).
- Undocked's `ready` bumps the generation in its message wrapper; a direct `handleMessage({type:"ready"})` would skip it (none does today).

## Next phase: 12

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); tsconfigCoverage and screenshotComparatorMeta fail in a worktree without its own node_modules.
- operationBenchmark.test.ts fails in a full run and passes alone; diffBudgets.test.ts "large compute" is load-sensitive.
- l10n audit lists pre-existing hardcoded-string candidates; knip hint on selectedRemovalCrashWorker.ts `ignoreUnresolved`.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries; the main checkout's index is stale (64d390b).
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- The worktree's node_modules lacks .bin; a copy outside the checkout must link the main checkout's node_modules. A plain `git ls-files | tar` copy is refused by the worktree-isolation guard; rsync excluding node_modules/.git works.
