# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Phase 6: accepted 69e809bb, verification incomplete (squash-merged as #422, 51b0c3ab).
- Earlier build records: git history of this file (650a6919, 6898d332, Phase 6 version at 69e809bb) and PLAN.review-log.md.

## Phase 7 review pending, started at 69e809bb07c6eaf3195a84330cd0d7756896c4cb
- 69e809bb was squash-merged as 51b0c3ab; the real base is df6b6c64 (docs commit after it). Review `git diff df6b6c64..HEAD`. Build commit 49b1bb44 (0.43.9); fix round 1 is the commit after it.
- Built: GitHub and GitLab `getJobLog` + `firstErrorPatterns`; GitHub failure summaries by checkRunId (2 000 chars); `src/views/ciLogHandler.ts` answers `previewCiLog` (excerpt only) and `openCiLog` (read-only editor at the first error line, cancellable progress); every host routes both; `useCiLog` + `CheckJobDetail` UI; strings in 11 locales; CHANGELOG; README; e2e `tests/e2e/ciLogEditor.spec.ts`.
- Fix round 1 (5 findings): host rechecks the generation after `openTextDocument` before `showTextDocument`; log fixtures are now tracked (`.gitignore` negation for `tests/fixtures/commitChecks/logs/`); GitHub reads `GET check-runs/{checkRunId}` for a failed job its commit listing missed; `useCiLog` requires the newest preview `requestId` as well as the selection token (K3); regression tests for the rate-limit 403 and each host `isCurrent()` guard.

## Decisions and why
- Preview replies need the selection token AND the newest preview requestId (K3 says both); the token alone let a mismatched requestId through.
- GitHub summaries come from the commit's check-run listing; only a failed job whose check run that listing lacks (suite limit) costs one extra `GET check-runs/{id}`, serial like the detail's other reads; its errors propagate like the suite lookup's.
- Fixtures kept at the plan's path (`tests/fixtures/commitChecks/logs/`) via a `.gitignore` negation rather than renamed.
- A 401/403 with `x-ratelimit-remaining: 0` is a failure with its message, not "token cannot read" (now pinned by a test).
- JobLog keyed per repo/hash/run/job/attempt; open replies only for the newest open requestId.

## Open risks
- Carried: Phase 3 (version-less mixed attempts until Refresh; tombstone needs owner; >1 000-job pipelines; `optionalJobs` until Phase 9); Phase 5 LRU of 500; Phase 6 up to 3 x 50 MB logs in memory, private-registry tests.
- Phase 7: a log download holds a request-gate slot while it runs; overflow-scan jobs get no GitHub failure summary; e2e spec unverified locally (runs on CI); GitNexus detect-changes cannot see this worktree (not in the registry) and was critical on a stale index at build time; changes additive.
- Verification: `bun run test` 10 failed / 7923 passed; the 10 are the known 8 Node v26 reds + 2 that need node_modules inside the checkout.

## Next phase: Phase 7 review (fresh Codex round on fix round 1), then the rest of wave 4 (Phases 8, 9).

## Found outside scope
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on base (8 tests).
- tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts fail in a worktree without its own node_modules; pass with it.
- l10n audit lists 13 pre-existing hardcoded-string candidates (non-blocking).
- knip hint: `tests/integration/shelf/selectedRemovalCrashWorker.ts` can leave `ignoreUnresolved`.
- diffBudgets.test.ts "large compute" timing budget is load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load; `bun run package` can pack ignored `output/` leftovers.
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run hits the socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries and no worktrees, so the CLI needs `--repo <absolute path>` and cannot check a worktree.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
- view-providers.integration GitHub provider mock lacks `firstErrorPatterns`.
- The repo-wide `.gitignore` rules `logs` and `*.log` hide any future fixture folder named `logs`; new fixture folders need a negation.
