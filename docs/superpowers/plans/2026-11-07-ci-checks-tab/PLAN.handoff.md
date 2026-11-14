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
- Phase 9: accepted 37ba9d13, manual: finished by hand; elephant OK 2026-11-14 after the owner's answer "C: track in #432" (PR #430, not merged yet).
- Earlier build records: git history of this file and PLAN.review-log.md.

## Phase 9: accepted at 37ba9d13, started at b5a56002
- The branch's real base is ca0271a6 (main after Phase 8's squash merge 7941c809 plus a docs commit); b5a56002 is not its ancestor.
- Built (0.43.11): C2 required-checks read for GitHub (rulesets, paginated, union with classic protection) and GitLab (`only_allow_merge_if_pipeline_succeeds`); "blocks merge" / "optional" tags and the header's "required: unknown"; `RequiredChecksCache` (requiredChecks.ts, L1, 1 h); `readDefaultBranch` (origin/HEAD, no "main" fallback); CI_DETAIL_CONTRACT_VERSION 4 -> 5.
- Fix round 1: protection's 403 always maps to partial/unknown; the rules cache is keyed by account; K21's hour pinned by literal ms.
- Fix round 2 (review pending again): `getDetail` now runs the detail read and the required read under ONE `withAccount` attempt (the detail fetch no longer has its own nested loop), so a switch at any point rereads both and no account's rule marks another's detail. `readRequired` takes that attempt's account and confirm: it confirms after the Git read (before any provider request) and again after the fetch, so a rejected fetch is evicted from the cache; only an account change rejects, everything else stays `unknown`. The served detail carries `defaultBranch` (never stored), and the header shows "required checks from {branch}" (`ci-header-required-scope`; new key `commit.checks.tab.requiredScope`, 12 locales plus the CSV row). Round 1's cancelled-tag gap is pinned by an all-states table test.
- Takeover (review pending again): a failed-job overflow scan update now confirms the attempt's account before it is published, so an account switch after the first answer cannot hand the old account's required marks to the new one; the stale update is dropped (the auth event refreshes the surface). Pinned by two tests in phase9Review.test.ts (a control that an unswitched update arrives, and the switched case).

## Decisions and why
- `cancelled` counts as blocking, with failure, timed_out, action_required, queued, running and pending: a cancelled required check does not satisfy branch protection.
- `defaultBranchUnknown` and `defaultBranch` are non-persisted detail fields (no contract version bump).
- Cache key uses `provider.keyFor(ref)` plus the account.
- A 403 with `retry-after` or `x-ratelimit-remaining: 0` on the rules read is transient (rejects, not cached). On the protection read every 403 maps per C2, so a rate-limited protection read caches partial/unknown for an hour.
- Account change during a detail read: `withAccount` retries both reads, then gives an unavailable detail (no old-account answer is published).

## Open risks
- GitNexus impact/detect_changes not run (worktree guard). Callers checked by hand: coordinator.getDetail/clear, provider capability maps, CheckTree/ChecksHeader.
- The overflow scan's job pages themselves still run under whichever account is signed in when they are read; only their publication is now fenced by the account. Caching of scan pages is Phase 6 code and was not changed.
- `bun run test`: 10 failed, the same 10 as before: 8 commit-list-column-resize (Node v26.5.0, no `localStorage`), tsconfigCoverage and screenshotComparatorMeta (worktree without its own node_modules).
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
- `bun run package` can pack ignored `output/` leftovers.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries and no worktrees.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- impeccable flags a placeholder `<img>` in commitChecksTab.integration.test.tsx (pre-existing test markup).
- The worktree has no node_modules, so `node_modules/.bin/*` fails here; call the main checkout's binaries.
