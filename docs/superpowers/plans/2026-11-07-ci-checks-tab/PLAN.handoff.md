# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Earlier build records (Phase 3 and 5 detail, GitNexus answers): git history of this file (650a6919, 6898d332) and PLAN.review-log.md.

## Phase 6: review pending, started at 6898d332f2ac955da00ef7e985265b249d01e0f1
- Actual base: 86088cab (#420, the squash of Phase 5 on main). 6898d332 is the pre-squash Phase 5 head; review `git diff 86088cab..<Phase 6 commit>`.
- Built test-first, one commit, patch 0.43.8:
  - http.ts: `followRedirects` (HTTPS only, credential headers stripped on any origin change and never restored) and `downloadToString` (5 hops, 50 MB bound, one English marker line, UTF-8 cut, abort, idle timeout 15 s, non-2xx = HttpError).
  - ciLogMemoryStore.ts: `CiLogMemoryStore` (LRU 3, sha256 key, join map, settled-only by contract, `clear()` aborts and drops late results, no fs), `ciLogKey`, `preview` returns the excerpt only.
  - firstErrorLine.ts: provider pattern, then error word after the step start, then last line; `buildCiLogExcerpt` (5 lines before, 40 lines, 8 KB, `sanitizeExcerpt`).
  - ciLogDocument.ts: `intelligit-ci-log:` provider, key `^[0-9a-f]{64}$` only, miss with source downloads again, miss without one returns the "no longer loaded" line, `onDidChange` for every placeholder or error-line URI when a later load of the key succeeds.
  - repositoryMode.ts: one store per window, provider registered, both disposed with the window; `clear()` on a commitChecks setting change and on the credential refresh (`refreshCommitCheckBadges`).
  - 3 strings localised in 11 locales; CHANGELOG entry verbatim; README "CI logs" section marked Planned.
- Mutations (copy mut-6-build-2): 47 of 47 red, each naming its test; record in PLAN.review-log.md.

## Decisions and why
- The store's `download` in repositoryMode is a rejecting placeholder: no provider log endpoint exists until Phase 7, and nothing calls `load` yet. Phase 7 replaces it with the provider transports.
- Truncation marker stays English inside http.ts (no vscode import there; the line sits inside English log text). Document lines use `l10n.t`.
- `onDidChange` is a hand-written listener set, not `vscode.EventEmitter`, so existing vscode test mocks without EventEmitter keep working.
- The `Content-Length` header is never consulted: the body is cut by counted bytes only, so a large announced length is never refused (K17).
- Sources stay recorded after eviction and after `clear()` (K19: a miss with a known source downloads again); a reload empties them.
- The credential refresh clears the store with the other CI caches, so a log read under an old token is not served after a token change.

## Open risks
- Phase 3 (carried over, still open):
  - A version-less tree that mixed two attempts stays shown until Refresh or restart in that session.
  - "late pre-session-only settled save" and "failed session-only deletion after restart": closing them needs a saved tombstone, a persisted-format change, left for the owner.
  - Pipelines over 1 000 jobs: an external status or bridge job of a cut pipeline is hidden with the cut jobs.
  - `optional: true` is set from `allow_failure` while `optionalJobs` stays false until Phase 9.
  - Translations (Phase 3 and Phase 6 strings) were written by the builder, not an outside source.
- Phase 5: the incomplete-commit set is an LRU of 500 per window; any header change makes the next request unconditional once.
- Phase 6:
  - Up to 3 logs of 50 MB each sit in the extension host's memory (owner path C), about 150 MB plus string overhead.
  - GitNexus detect-changes: risk HIGH (activateRepositoryMode, 9 flows), index stale at 64d390b0; the change there is the store wiring the integration test pins.
  - Settled-only is the callers' contract (Phase 7 handlers); the store does not check job status.

## Next phase
- Wave 4: Phases 7, 8, 9.

## Found outside scope
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on HEAD 86088cab too (8 tests).
- GitHub carryScans also treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load.
- `bun run package` can pack ignored leftovers under `output/`.
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run hits the fixture socket-path limit unless TMPDIR is short.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache (nor the CI log store, which that mode does not create).
- GitNexus index is behind HEAD; the registry holds two "IntelliGit" entries, so the CLI needs `--repo <absolute path>`.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
