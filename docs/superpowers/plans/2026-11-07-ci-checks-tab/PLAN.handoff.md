# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Phase 6: accepted 69e809bb, verification incomplete (squash-merged as #422, 51b0c3ab).
- Phase 7: accepted 6fef8c59, manual: finished by hand after the review halt; owner OK 2026-11-12 ("A: fix by hand").
- Earlier build records: git history of this file (650a6919, 6898d332, Phase 6 version at 69e809bb) and PLAN.review-log.md.

## Phase 7 record
- Base df6b6c64 (on 51b0c3ab). Build commit 49b1bb44 (0.43.9); fix round 1 59e1a036; fix round 2 abbb1840; takeover 5ba6709e; by-hand fixes 88251aa3..6fef8c59.
- Built: GitHub and GitLab `getJobLog` + `firstErrorPatterns`; GitHub failure summaries by checkRunId (2 000 chars); `src/views/ciLogHandler.ts` answers `previewCiLog` (excerpt only) and `openCiLog` (read-only editor at the first error line, cancellable progress); every host routes both; `useCiLog` + `CheckJobDetail` UI; strings in 11 locales; CHANGELOG; README; e2e `tests/e2e/ciLogEditor.spec.ts`.
- Fix round 1 (5 findings): generation recheck before `showTextDocument`; log fixtures tracked; GitHub `GET check-runs/{id}` for a failed job its listing missed; `useCiLog` needs the newest preview requestId too (K3); tests for the rate-limit 403 and each host guard.
- Fix round 2 (4 findings): the job's first failed step travels `CiLogJob.failedStep` -> `CiLogSource.failedStep`; GitHub declares `stepStartPrefix = "##[group]"`; the store's error rules get `stepStart = prefix + failedStep`, so the error-word fallback searches after the failed step. An already cancelled progress token aborts before a cache hit opens. A 401/403 with `Retry-After` is a failure, not forbidden. New K3 test: wrong selectionToken with every other field matching.
- Takeover (3 findings): `openCiLog` now replies `failed` when `openTextDocument` or `showTextDocument` rejects (generation checks kept). New guard tests: the failing step's own start line is never the error line (M8), and a late `ciLogResult` for an earlier open leaves the newer open's error (M12).
- By hand: the log handler's lookup, attempt, truncated flag, cache read and Cancel button are pinned; a refusal is `forbidden` only when the refused request carried the token (`HttpError.credentialSent`, set by `followRedirects`), so an expired signed link is a failure; failed jobs found by the overflow scan get their check-run summary, best-effort.

## Decisions and why
- Preview replies need the selection token AND the newest preview requestId (K3 says both); each is now pinned by its own test.
- The step marker is provider data (`stepStartPrefix`), joined to the step name in the wiring, so GitLab (no steps) keeps the whole-log fallback and a later provider only declares its own prefix. Plan rule `##[group]<step name>` is [ASSUMED]; a step whose log line differs from its name falls back to the whole log, as before.
- `failedStep` is recorded with the source but not in the store key: one job attempt has one step list.
- GitHub summaries come from the commit's check-run listing; a failed job missing from it costs one `GET check-runs/{id}`.
- Fixtures kept at `tests/fixtures/commitChecks/logs/` via a `.gitignore` negation.
- A 401/403 with `x-ratelimit-remaining: 0` or a `Retry-After` header is a failure with its message, not "token cannot read".
- Whether a refusal is the token's is read from the request (did it still carry the credential), not from comparing hosts: a redirect chain that leaves the API origin and comes back never gets the token back.
- Overflow-scan summaries are best-effort: a failing or cooled-down summary read must not hide failed jobs or make the scan re-read the page; a cooldown still pauses the scan at its next request.

## Open risks
- Carried: Phase 3 (version-less mixed attempts until Refresh; tombstone needs owner; >1 000-job pipelines; `optionalJobs` until Phase 9); Phase 5 LRU of 500; Phase 6 up to 3 x 50 MB logs in memory, private-registry tests.
- Phase 7: a log download holds a request-gate slot while it runs; an overflow job whose summary read fails shows no summary; e2e spec unverified locally (runs on CI); GitNexus detect-changes cannot see this worktree; changes additive.
- Verification: `bun run test` 9 failed / 7944 passed at 6fef8c59; the 9 are the known 8 Node v26 reds + merge-editor-performance under load (passes alone).

## Next phase: the rest of wave 4 (Phases 8, 9).

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
- The repo-wide `.gitignore` rules `logs` and `*.log` hide any future fixture folder named `logs`; new fixture folders need a negation.
- impeccable hook flags a placeholder `<img>` at commitChecksTab.integration.test.tsx:1261 (pre-existing test markup).
