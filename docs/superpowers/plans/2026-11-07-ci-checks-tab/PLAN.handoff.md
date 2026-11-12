# CI Checks tab: handoff

## Phases accepted
- Phase 1: accepted 3965f37a, verification incomplete.
- Phase 2: accepted bfea9112, manual: finished by hand and merged as #415; owner OK 2026-11-11.
- Phase 4: accepted f005d90f, verification incomplete (merged as #417, d3438a11).
- Phase 19: accepted f005d90f, verification incomplete (merged as #418, 2490ec17).
- Phase 3: accepted 15a47c9d, manual; owner OK 2026-11-11 (merged as #419, c246d0d4).
- Phase 5: accepted 6898d332, manual; owner OK 2026-11-12 (merged as #420, 86088cab).
- Earlier build records (Phase 3 and 5 detail, GitNexus answers): git history of this file (650a6919, 6898d332) and PLAN.review-log.md.

## Phase 6: review pending, started at 86088cab9ee8d07c724da9e13f5aeac980dfbffa
- Actual base: 86088cab (#420). Review `git diff 86088cab..<HEAD>`. Commits: 4f84ac3b build (0.43.8), 51e21ccb fix 1, 5e7f445a fix 2, b8ef4406 takeover, 75271f63 owner answer, c2df109b fix round 3, 819aa68d fix round 4, then the fix round 5 commit (this round, tests only).
- Fix round 5 (review of 819aa68d, fix round 2): three test gaps closed, no source change. "two pending reads of the same URI are both forgotten when it closes" (K19), "settled document reads release their pending marker and empty URI bucket" (white-box read of `pending`), and "15 s inactivity callback rejects before the response head / mid body" (the stub now records `setTimeout` calls). Each is red under the reviewer's mutation (F7, F5, F6, M12; copy mut-6-fix-5).
- Built: http.ts `followRedirects` + `downloadToString` (5 hops, 50 MB, marker, UTF-8 cut, abort, idle 15 s, non-2xx = HttpError); `CiLogMemoryStore` (LRU 3, sha256 key, join map, clear() aborts and drops late results, no fs); firstErrorLine.ts + excerpt; `intelligit-ci-log:` provider (K19); store wiring in repositoryMode.ts. 3 strings in 11 locales, CHANGELOG verbatim, README "CI logs" marked Planned.
- Fix 1: stop at the bound even if the server stalls. Fix 2: 4 surviving mutations closed with tests. Takeover: a stale document read serves the newer same-key entry instead of a stuck error line.
- HALT after the takeover; owner's answer 2026-11-12, verbatim: "A: follow the plan". PLAN.md unchanged.
- Fix round 4 (review after c2df109b, fix round 1 of that review): a read still waiting on a load when its tab closes or the provider is disposed no longer puts the URI back into the refresh list when that load fails (K19). ciLogDocument.ts keeps a per-URI set of pending reads; close and dispose mark them, the catch skips markStale for a marked read. Tests "a tab closed while its load is pending ... (K19)", "a load that fails after dispose leaves the refresh registry empty", plus "a tab closed and reopened while a load is pending is still refreshed" (guards over-fencing). Mutations (copy mut-6-fix-4): 4 of 4 red.
- Fix round 3 (on top of 75271f63, no reset) closed the three open R1 findings, each with a test red first:
  1. K16, ciLogMemoryStore.ts: generation checked again after the `onDidLoad` listeners; a listener's `clear()` rejects the pending load. Test "a load listener that calls clear() never hands the cleared log back to the waiter".
  2. K19, ciLogDocument.ts: `onDidCloseTextDocument` drops a closed `intelligit-ci-log:` URI from the refresh registry, deletes empty key buckets, and is disposed with the provider. Tests "a closed tab never gets onDidChange; a tab still open does", "a tab reopened after its close is refreshed again" (white-box bucket check), dispose test asserts the close subscription is disposed.
  3. O2, http.ts: the `Content-Length === maxBytes` exception is gone; reaching maxBytes always stops, destroys, marks once, `truncated: true`. The old "exactly the bound is whole" test is replaced by "... announced at that length, still gets the marker once (O2)" plus a stall row in the bound it.each.
- Mutations (copy mut-6-fix-3): 6 of 6 red, each naming its assertion (record in PLAN.review-log.md).

## Decisions and why
- Fix round 5 findings were missing tests, not wrong code, so "red before" is shown by the reviewer's mutations; the shipped code passed each new test before and after.
- Pending reads are fenced with a per-read token, not a per-URI closed marker: a tab closed and reopened during one load must still be refreshed by its second read.
- Fix round 3 was done in the builder step: the handoff already said Phase 6 was built, but the owner's halt answer requires three changes that a "no rebuild, rerun gates" pass would have left undone.
- The store's `download` in repositoryMode is a rejecting placeholder until Phase 7 adds provider log endpoints; nothing calls `load` yet.
- Truncation marker stays English inside http.ts (no vscode import; it sits in English log text). Document lines use `l10n.t`.
- `onDidChange` is a hand-written listener set, so vscode mocks without EventEmitter keep working.
- Reaching the 50 MB bound always stops and marks the log, whatever `Content-Length` says (owner, "A: follow the plan").
- Sources stay recorded after eviction and `clear()` (K19: a miss with a known source downloads again); a reload empties them.
- The credential refresh clears the store with the other CI caches.

## Open risks
- Phase 3 (carried over): a version-less tree mixing two attempts stays until Refresh; "late pre-session-only settled save" and "failed session-only deletion after restart" need a saved tombstone (persisted-format change, owner); pipelines over 1 000 jobs hide a cut pipeline's external jobs; `optionalJobs` false until Phase 9; Phase 3 and 6 translations written by the builder.
- Phase 5: the incomplete-commit set is an LRU of 500 per window; a header change makes the next request unconditional once.
- Phase 6: up to 3 logs of 50 MB in extension-host memory (owner path C); settled-only is the Phase 7 handlers' contract; GitNexus risk HIGH through activateRepositoryMode (index stale at 64d390b0); the empty-bucket and dispose-during-load tests read the provider's private registry.

## Next phase: wave 4 (Phases 7, 8, 9), after Phase 6 is accepted.

## Found outside scope
- commit-list-column-resize.test.tsx fails under Node v26.5.0 (no global `localStorage`); red on 86088cab too (8 tests).
- diffBudgets.test.ts "large compute" timing budget failed once inside the full `bun run test` (170 ms vs 59 ms) and passed alone; load-sensitive.
- GitHub carryScans treats two missing `runAttempt` values as the same run.
- Extract detailOf/flatDetail into a shared module when Phase 17 adds a third provider detail.
- `bun run test` in the main checkout times out git-heavy tests under load; `bun run package` can pack ignored `output/` leftovers.
- A copy without `.git` fails git-backed tests; a copy under $TMPDIR/phase-run hits the socket-path limit unless TMPDIR is short. In an isolated worktree session the `git ls-files | tar` copy recipe is refused by the git guard; rsync with an exclude file works.
- noRepositoryMode.ts registers a placeholder `refreshBadges`, so a token change there clears no cache.
- GitNexus registry holds two "IntelliGit" entries, so the CLI needs `--repo <absolute path>`.
- Bitbucket detail reads (Phases 17/18) should pass the ETag store when they add metadata fetches.
