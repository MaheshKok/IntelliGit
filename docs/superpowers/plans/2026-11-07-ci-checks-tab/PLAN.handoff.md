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
- Phase 10: accepted 8ff6422d, manual: finished by hand after the takeover halt, owner answer "A" 2026-11-14 (squash-merged as #435, bc063074). Its open risks (cross-window clear-token orderings, PLAN.md:764 out of scope) stand; details in this file's git history.
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 11: review pending, built 350f627c, fix round 1 committed after it (started at 8ff6422d1f29149a80f29c155327481695f34649)
- Fix round 1 (4 findings, each test red before the fix): useCiHistory clears the stored answer when a request starts or the detail goes away and renders it only for the newest request id; all three hosts (CommitInfo, CommitGraph, Undocked) keep a `webviewGeneration` advanced on `ready`, captured when a history request starts and checked before posting; `join` matches a logical id only when exactly one parent item AND exactly one current check carry it, and allows the unique-name fallback when either side has no logical id.
- 8ff6422d is not an ancestor of HEAD; the real base is 2d44491c (main after #435 plus the Phase 11 groundwork docs commit).
- Built (0.43.13): each failed check is tagged "new" / "still" / "unknown", a passed one "fixed", against the first parent; "also red on {branch}" against the default branch tip read from origin/HEAD on every request (K22); "default branch unknown" when origin/HEAD is missing.
- Pure logic `join` / `compare` / `alsoRed` / `historyChecksOf` in src/shared/ci/history.ts; host read `readCiHistory` in src/services/commitChecks/ciHistory.ts (coordinator `ciHistory`); message `requestCiHistory` / `ciHistory` answered by src/views/ciHistoryHandler.ts in all three hosts; tab hook useCiHistory.ts; tags in CheckTree.tsx; 5 strings in 12 locales + CSV; README section; CHANGELOG 0.43.13.
- Tests: ciHistory.test.ts 25, ciHistoryHandler.test.ts 11, commitChecksHistory.integration.test.tsx 6 (42 pass). 15 mutations on copies, all red naming the expected test (control 42 passed).

## Decisions and why
- Pure functions in src/shared/ci/history.ts, not plan §9's src/services/commitChecks/ciHistory.ts: the webview may not import src/services (architecture:check); the host read stays at the plan's path.
- "unknown" only on a red check without a unique match; a green check without one gets no tag (journey 9 defines unknown for failed jobs only).
- Join: logical id first (exactly one parent item and one current check carry it); else the name must match exactly one parent item (one with no logical id, or any when the current check has none) AND exactly one current check. Two different ids on both sides never fall back to the name. Execution ids never compared (K35).
- A snapshot that cannot be read gives `items: null` (no tags), never an empty list, which would tag every red check "unknown".
- Root commit: no parent, no tags. Merge commit: first parent only. No also-red tag on the default branch tip itself.
- The tab re-asks on every detail answer, so a parent run that finishes later or a moved tip shows up; only the newest request's reply for the commit on screen is used.
- GitHub and GitLab snapshot APIs name no workflow or pipeline, so their snapshot items carry no logical id and the parent is joined by unique name (fixture tests pin this).
- The handler answers only while the Checks tab groundwork switch (isE2eControlChannelActive) is on, like the other Phase 11 groundwork; Phase 18 removes the switch check.

## Open risks
- GitNexus CLI refused by the worktree-isolation guard; not routed around. Substitute: text-search caller review plus typecheck; every edit is additive (optional props, a new optional source method, new union members). Risk assumed LOW, not graph-checked; the reviewer should run impact/detect-changes.
- Two same-named jobs in different workflows on GitHub/GitLab always give "unknown" (snapshot has no workflow name). Correct per the join rule, but users with duplicate job names see no new/still.
- Phase 11 e2e not run locally. impeccable detect is regex-only (exit 0 on 6 UI files).
- The history hook still shows the stale answer for one commit before its effect clears it; the requestId check cannot close that frame (the ref moves in the same effect). No test sees it, as effects flush inside act.
- `bun run test` after fix round 1: 10 failed, 8204 passed of 8214; 10 failures, the known set (8 commit-list-column-resize on Node v26.5.0, tsconfigCoverage, screenshotComparatorMeta). build:prod and package then run separately: both exit 0.

## Next phase: 12

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails; decide in a Phase 7 follow-up.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules.
- operationBenchmark.test.ts fails in a full `bun run test` run and passes alone; diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- l10n audit lists pre-existing hardcoded-string candidates; knip hint on selectedRemovalCrashWorker.ts `ignoreUnresolved`.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries; the main checkout's index is stale (64d390b).
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- The worktree has no node_modules, so `node_modules/.bin/*` fails here; call the main checkout's binaries.
