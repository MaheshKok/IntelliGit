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
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 9: review pending, started at b5a56002
- The branch's real base is ca0271a6 (main after Phase 8's squash merge 7941c809 plus a docs commit); b5a56002 is not its ancestor. HEAD did not move during the build.
- Built (0.43.11): C2 required-checks read for GitHub (rulesets, paginated, union with classic protection; "Branch not protected" 404 = known empty; 401/403/other 404 = partial or unknown; rate limit, 5xx, network = transient, rejects, not cached) and GitLab (`only_allow_merge_if_pipeline_succeeds` -> non-optional jobs required; missing field or 401/403/404 = unknown).
- `RequiredChecksCache` (requiredChecks.ts): L1, key `required:<repoKey>:<branch>`, 1 h, rejected fetch dropped, emptied by coordinator.clear(). `applyRequired` marks checks at serve time in coordinator.getDetail (scan updates too), so marks are never persisted.
- `readDefaultBranch` (defaultBranch.ts, GitOps.readDefaultBranch): `origin/HEAD` via symbolic-ref plus the tip, read fresh each call; missing = null, no "main" fallback. Null shows "default branch unknown — run git remote set-head origin --auto" in the header.
- UI: "blocks merge" (red) on required jobs/checks that failed or have not finished; "optional" (muted) on optional jobs; header "required: unknown" when the provider lacks the capability or the rule is not known. 4 strings in 12 locales.
- CI_DETAIL_CONTRACT_VERSION 4 -> 5 (K32). README section, CHANGELOG 0.43.11.

## Decisions and why
- `cancelled` counts as blocking, with failure, timed_out, action_required, queued, running and pending: a cancelled required check does not satisfy branch protection.
- `defaultBranchUnknown` is a non-persisted detail field so the §8 hint has one source of truth.
- Cache key uses `provider.keyFor(ref)`, the key every other per-repo cache uses.
- A 403 with `retry-after` or `x-ratelimit-remaining: 0` is transient, not a refusal, so a rate limit never caches "unknown" for an hour.

## Open risks
- GitNexus impact/detect_changes not run: the worktree guard refuses the CLI here and the registry holds no worktree. Callers checked by hand: GitOps (new method only), coordinator.getDetail/clear, provider capability maps, CheckTree/ChecksHeader.
- `bun run test`: 10 failed / 8079 passed. 8 are commit-list-column-resize (Node v26.5.0, no `localStorage`, known); tsconfigCoverage and screenshotComparatorMeta fail only in a worktree without node_modules and pass in the linked copy.
- Phase 9 e2e not run locally.

## Next phase: 10

## Found outside scope
- Phase 7 code: githubProvider.ts `summaryMissed` marks a finished execution incomplete when an optional failure-summary lookup fails; decide in a Phase 7 follow-up.
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`).
- tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules.
- l10n audit lists pre-existing hardcoded-string candidates (non-blocking).
- knip hint: `tests/integration/shelf/selectedRemovalCrashWorker.ts` can leave `ignoreUnresolved`.
- diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run package` can pack ignored `output/` leftovers; a copy under $TMPDIR/phase-run hits the socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries and no worktrees.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- impeccable flags a placeholder `<img>` in commitChecksTab.integration.test.tsx (pre-existing test markup).
