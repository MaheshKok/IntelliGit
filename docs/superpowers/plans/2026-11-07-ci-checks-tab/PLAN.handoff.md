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

## Phase 11: review pending, started at 8ff6422d1f29149a80f29c155327481695f34649
- Built 350f627c (0.43.13); fix round 1 8ace3e72; fix round 2 e0ee196e; takeover commit follows e0ee196e. The real base is 2d44491c (8ff6422d is not an ancestor of HEAD).
- Built: each failed check is tagged "new" / "still" / "unknown", a passed one "fixed", against the first parent; "also red on {branch}" against the default branch tip read from origin/HEAD on every request (K22); "default branch unknown" when origin/HEAD is missing.
- Pure logic `join` / `compare` / `alsoRed` / `historyChecksOf` in src/shared/ci/history.ts; host read `readCiHistory` in src/services/commitChecks/ciHistory.ts; message `requestCiHistory` / `ciHistory` answered by src/views/ciHistoryHandler.ts in all three hosts; tab hook useCiHistory.ts; tags in CheckTree.tsx.
- Takeover (4 findings): (1) the header's "default branch unknown" line now follows the history answer once it arrives (`defaultBranchUnknown ?? detail.defaultBranchUnknown`; the hook returns undefined until a reply is shown), so a known branch retires the detail's older flag; (2) fixture-backed Bitbucket Cloud and Server cases in ciHistory.test.ts pin that their snapshot items carry no logicalId and join by unique name (ambiguous when doubled on either side); (3) useCiHistory stores each answer with the detail object it was asked for and renders it only for that same detail, so a replacement detail's first frame shows no previous tags (closes the old one-frame risk); (4) GitNexus impact/detect-changes still refused by the worktree-isolation guard, not routed around.
- Rounds 1-2 recap: per-request id and detail clearing in the hook; hosts' `webviewGeneration` advanced only by the current view's `ready`; `join` logical id only when unique on both sides, name fallback counts every same-named parent item.

## Decisions and why
- Bitbucket snapshot items get no logicalId: the build-statuses APIs name no workflow or pipeline, and §9's join rule sets logicalId on snapshot items only where the API gives one. Current flat checks (historyChecksOf) carry none either, so the unique-name fallback joins them. Phase 18 sets `"status\0" + key` on its detail's flat checks; it may then also set it on the snapshot items so both sides match by key.
- Pure functions in src/shared/ci/history.ts (webview may not import src/services); host read at the plan's path.
- "unknown" only on a red check without a unique match; root commit no tags; merge commit first parent only; no also-red tag on the tip itself.
- A snapshot that cannot be read gives `items: null` (no tags), never an empty list.
- The handler answers only while isE2eControlChannelActive is on; Phase 18 removes the switch check.

## Open risks
- GitNexus CLI refused by the worktree-isolation guard again (takeover); substitute: text search shows one caller each for useCiHistory and ChecksHeader (ChecksTab.tsx) and one Bitbucket mapper (bitbucketShared.ts toStatusItem, untouched). Risk assumed LOW, not graph-checked.
- Two same-named jobs in different workflows on GitHub/GitLab/Bitbucket always give "unknown" (snapshot has no workflow name).
- Phase 11 e2e not run locally.
- `bun run test` after the takeover: 10 failed, 8212 passed of 8222; the same known set (8 commit-list-column-resize on Node v26.5.0, tsconfigCoverage, screenshotComparatorMeta). build:prod and package then exit 0.
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
- The worktree's node_modules lacks .bin; bun resolves the main checkout's by walking up, so a copy outside the checkout must link the main checkout's node_modules.
