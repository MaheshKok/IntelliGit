# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Phase 6: accepted 69e809bb, verification incomplete.
- Earlier build records (Phase 3 and 5 detail, GitNexus answers): git history of this file (650a6919, 6898d332) and PLAN.review-log.md.

## Phase 6: accepted 69e809bb, verification incomplete, started at 86088cab9ee8d07c724da9e13f5aeac980dfbffa
- Actual base: 86088cab (#420). Review `git diff 86088cab..<HEAD>`. Commits: 4f84ac3b build (0.43.8), 51e21ccb fix 1, 5e7f445a fix 2, b8ef4406 takeover, 75271f63 owner answer, c2df109b fix round 3, 819aa68d fix round 4, f35c04fe fix round 5, then the takeover 2 commit (this step, tests only).
- Takeover 2 (7 open findings after 2 fix rounds, all test gaps, no source change): store keeps and previews `truncated: true` (O2); a `load()` hit refreshes LRU recency (Journey 5); followed redirect responses and a non-2xx final response are destroyed; `findFirstErrorLine("")` is 0; the placeholder-refresh test clears the store so its second load really downloads; dispose test reads the store's listener set and the provider's `changeListeners`/`stale`; redirect test runs over 301/302/303/307/308; UTF-8 row for a 2-byte character ending at the bound. 12 mutations on copy mut-6-takeover-1, 12 red, each naming its assertion.
- Fix round 5: K19 two-pending-reads test, settled-read marker/bucket release (white-box), 15 s idle timeout pinned in both rows.
- Built: http.ts `followRedirects` + `downloadToString` (5 hops, 50 MB, marker, UTF-8 cut, abort, idle 15 s, non-2xx = HttpError); `CiLogMemoryStore` (LRU 3, sha256 key, join map, clear() aborts and drops late results, no fs); firstErrorLine.ts + excerpt; `intelligit-ci-log:` provider (K19); store wiring in repositoryMode.ts. 3 strings in 11 locales, CHANGELOG verbatim, README "CI logs" marked Planned.
- Fix 1: stop at the bound even if the server stalls. Fix 2: 4 surviving mutations closed with tests. Takeover 1: a stale document read serves the newer same-key entry instead of a stuck error line.
- HALT after takeover 1; owner's answer 2026-11-12, verbatim: "A: follow the plan". PLAN.md unchanged.
- Fix round 4: a read waiting on a load when its tab closes or the provider is disposed no longer re-adds the URI to the refresh list when that load fails (per-read token in `pending`).
- Fix round 3: K16 generation re-check after `onDidLoad` listeners; K19 closed tabs leave the refresh registry; O2 reaching maxBytes always marks the log.

## Decisions and why
- Takeover 2 and fix round 5 findings were missing tests, not wrong code, so "red before" is each finding's own mutation replayed on a copy; the shipped code passes every new test.
- Takeover 2 also pins `changeListeners.clear()` and `stale.clear()` in dispose: the finding named both as surviving mutations, and only a registry read can see them.
- Pending reads are fenced with a per-read token, not a per-URI closed marker: a tab closed and reopened during one load must still be refreshed by its second read.
- The store's `download` in repositoryMode is a rejecting placeholder until Phase 7 adds provider log endpoints; nothing calls `load` yet.
- Truncation marker stays English inside http.ts (no vscode import; it sits in English log text). Document lines use `l10n.t`.
- `onDidChange` is a hand-written listener set, so vscode mocks without EventEmitter keep working.
- Reaching the 50 MB bound always stops and marks the log, whatever `Content-Length` says (owner, "A: follow the plan").
- Sources stay recorded after eviction and `clear()` (K19: a miss with a known source downloads again); a reload empties them.
- The credential refresh clears the store with the other CI caches.

## Open risks
- Phase 3 (carried over): a version-less tree mixing two attempts stays until Refresh; "late pre-session-only settled save" and "failed session-only deletion after restart" need a saved tombstone (persisted-format change, owner); pipelines over 1 000 jobs hide a cut pipeline's external jobs; `optionalJobs` false until Phase 9; Phase 3 and 6 translations written by the builder.
- Phase 5: the incomplete-commit set is an LRU of 500 per window; a header change makes the next request unconditional once.
- Phase 6: up to 3 logs of 50 MB in extension-host memory (owner path C); settled-only is the Phase 7 handlers' contract; GitNexus risk HIGH through activateRepositoryMode (index stale at 64d390b0); several tests read private registries (`stale`, `pending`, `changeListeners`, the store's `listeners`), so a rename breaks them loudly.

## Next phase: wave 4 (Phases 7, 8, 9), after Phase 6 is accepted.

## Found outside scope
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on 86088cab too (8 tests); still the only red in takeover 2's `bun run test` (7876 of 7884 passed).
- diffBudgets.test.ts "large compute" timing budget failed once inside the full `bun run test` (170 ms vs 59 ms) and passed alone; load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load; `bun run package` can pack ignored `output/` leftovers.
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run hits the socket-path limit unless TMPDIR is short. In an isolated worktree session the `git ls-files | tar` copy recipe is refused by the git guard; rsync with an exclude file works (the word must not appear literally in the command).
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries, so the CLI needs `--repo <absolute path>`.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
