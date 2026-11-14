# CI Checks tab — build log

Plan review history: `PLAN-REVIEW-LOG.md` (Codex rounds 1–3). This file is the claudex-build transcript (LOG_FILE) for `PLAN.md`.

## Act 3 — Build

Step 0, 2026-11-07, owner go-ahead "Yes, full build" (all 19 phases, 7 waves, chained; ask only on a halt).

- BRANCH: feat/ci-checks-tab
- BASE_HEAD=846f85069d08a4d2b8363d5914fe4965daba08e1
- SKILL-SHA 8123c5e27559 /Users/maheshkokare/.claude/skills/claudex-build/SKILL.md
- SKILL-SHA ad22509f59a5 /Users/maheshkokare/.claude/skills/claudex-build/helpers.py
- SKILL-SHA e02ee28df67c /Users/maheshkokare/.claude/skills/claudex-build/verify.py
- BUILDER: phase-builder (opus, high). REVIEW_MODEL: gpt-6-sol, REVIEW_EFFORT: high. MAX_FIX_ROUNDS: 2. SEAL_MODE: shadow.
- PROOF_CMD: PLAN.md "Gate G — standard validation, every phase" plus each phase's "Done when" gates (L, U, E as named).
- GATES_FILE: .claudex-gates.json — lint, typecheck, format, knip (accept), architecture (accept), suite (accept).
- Required checks on main (ruleset) with no local gate: build, guard-no-skip-ci, visual, package-smoke (pinned), dependency-review, Analyze (javascript-typescript), Installed package smoke (windows-latest). Phase acceptance is partial until these pass in CI on the final commit; Gate E (e2e) also runs on CI only.

## Phase 1: built, review pending — 1748aefbd0cb1e06ba21b61781cfd9f6fe7d07c5

- Builder: phase-builder (opus, high), test-first. Started from HEAD 3c3d40cf (BASE_HEAD 846f8506 plus two docs-only plan checkpoint commits 88ae3a9e and 3c3d40cf, which touch only the plan folder).
- Gates on the working tree before commit: `verify.py gates --stage round` GREEN (lint, typecheck, format); `--stage accept` GREEN (lint, typecheck, format, knip, architecture, suite 320.6s). Gate G: react-doctor, build, test (486 files, 7347 tests passed), build:prod exit 0. `bun run package` exit 1 in the main checkout only because ignored leftovers `output/playwright/pr321/*` (2026-10-03) are packed and rejected by package:verify; the same `bun run package` on a clean copy of the tracked tree passed verifyVsixPackage (88 entries). Gate L: l10n:sync (0 added), l10n:import, csv validate, l10n:validate, l10n:audit all exit 0; no new user-facing strings (the "IntelliGit CI" channel name follows the unlocalized "IntelliGit Shelf" precedent).
- Mutations (copy /tmp/phase-run/PLAN/mut-1-build-1, perl alarm 60s): 33 of 33 RED, each red line names its test. Examples: completion state-only -> "failure with a pending item is not complete"; settlement ignores coverage -> "settlementOf is unknown when runsCoverage is pageBound..."; isFullyCovered runs only -> "isFullyCovered is false when any run, jobs, attempt or otherChecks coverage is not full"; snapshot per-key gen dropped -> "a fetch started before invalidate is not cached"; in-flight kept -> "force after invalidate does not join the pre-invalidate fetch"; delete skipped -> "invalidate deletes the persisted entry..."; delete/clear outside enqueue (both stores) -> "delete runs inside the enqueue chain" / "generation change while an old set is queued..."; persist capabilities -> "a wire detail passed in is stripped before it is persisted"; skip contractVersion -> "persisted contractVersion ≠ current is a miss"; d.complete alone -> "unknown settlement is never cached as complete"; detail gen removed -> "clear() drops a late result"; isCurrent repoKey only -> "auth bump makes a captured ctx stale"; trace full URL -> "no Authorization value, no query string, no log text"; gitlab jobs:true -> "every provider declares all false in Phase 1"; floor all-false -> "floor detail carries the provider's capabilities"; checksRefresh state-only -> "incomplete failure keeps the ladder". Architecture mutation (webview imports services/commitChecks/types) -> 1 dependency violation, exit 1. ESLint rule probe (=== "gitlab", case "github") -> 2 no-restricted-syntax errors.
- GitNexus: impact before edits flagged getOrFetch, isPersistentCommitCheckState and CommitChecksProvider CRITICAL (name-conflated counts; text search found 2 real callers of retryDelaysForCommitChecks, CommitList.tsx:521 and :569). detect-changes --scope all: 19 tracked files, 50 symbols, 15 flows, risk HIGH (commit-check badge refresh and activation flows), not partial.
- Deviations: ProviderId moved to src/types.ts (re-exported from services types) so webview types need no services import; allowNext and continueFailedScan take the ProviderRepoRef; CiGenerations.isCurrent takes the current repoKey; HEAD-monitor schedule constant left for Phase 13 (knip would flag it unused now); later-phase contract types carry `@public` so knip stays strict.

### Phase 1 fix round 1 (Opus builder) - commit b0dacc9c
- BLOCKER failed clear: both services refuse persistent reads after a rejected clear(). Red before: serviceCompletion/detailService "a rejected persistent clear fails closed" -> expected { ... } to match object { state: 'success' } / { outcome: 'success' }.
- Fenced fetch result to caller: invalidate-fenced requests re-ask and return the post-invalidate answer (clear() fence keeps the old uncached-return behaviour pinned by service.test.ts). Red before: "a fetch started before invalidate does not hand its result to its caller" -> expected { ... } to match object { state: 'pending' }.
- Superseded L2 entry: a non-settled, non-unavailable answer deletes the stored entry in both stores. Red before: "pending work found later removes the settled entry; unavailable keeps it" (both stores) -> expected { ... } to be undefined; service restart test -> to match object { state: 'pending' }.
- Generations: getDetail checks isCurrent + repository generation after resolve and after fetch (trace discarded-generation); lifecycle bump on intelligit.commitChecks config change and repository close. Red before: integration "bumps the CI lifecycle generation..." -> expected "bumpLifecycle" to be called 1 times, but got 0 times; coordinatorDetail tests red under mutation isCurrent -> true (expected { ... } to be undefined); close bump red under mutation.
- Snapshot trace: kind=snapshot hit-l1/hit-l2/fetched/incomplete/discarded-generation with provider id. Red before: "traces snapshot fetches..." -> expected [] to deeply equal [...].
- K26: headMonitorDelayMs in pollSchedule.ts. Red before: "headMonitorDelayMs is not a function".
- Proof: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build exit 0; bun run test 488 files / 7363 tests pass (one rerun: operationBenchmark git temp-file error, green alone and in the rerun). knip strict exit 0. detect-changes HIGH (stale index, badge refresh + activation flows).

### Phase 1 fix round 2 (Opus builder) - commit 6492ff02
- BLOCKER failed clear + restart: both persistent stores overwrite the payload with an empty one when removing the key fails, then still reject (session fail-closed kept). Red before: serviceCompletion/detailService "a failed clear still keeps the previous entry from a restarted service" -> expected { ... } to match object { state: 'success' } / { outcome: 'success' } (received failure).
- clear()-fenced result to caller: a fetch fenced by clear() re-asks like invalidate(). Red before: "a fetch started before clear does not hand its result to its caller" (both services) -> expected { ... } to match object { state: 'success' } / { outcome: 'success' }. service.test.ts clear test and detail "clear() drops a late result" updated to the spec behaviour; GitLab 429 integration test now asserts the second commit's request goes out (request count grew by the fenced re-ask).
- Token in trace reason: credential text redacted after URL trimming. Red before: ciTrace "a reason never carries credential text" -> expected 'op=op1 ... reason=request failed: Authorization: Bearer secret-token' not to contain 'secret-token'.
- Mutations (copy mut-1-fix-2, perl alarm 90s): 5 of 5 RED naming their tests (both fallbacks removed, both re-asks reverted, scrub removed).
- Proof: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test all exit 0; 488 files / 7368 tests. detect-changes --scope all: risk medium, 5 RefreshCommitCheckBadges flows (stale index 033e8c8).
- Residual: if every globalState write fails, a restart can still read old entries (identity-scoped keys not done).

### Phase 1 Opus takeover - commit def00084
- BLOCKER saved entries not tied to the account: cache keys now end in a token-free account id from `CommitChecksProvider.accountKey` (GitHub account id; token providers a 16-hex SHA-256 prefix of the stored token; signed-out / unresolved-<uuid> otherwise), resolved with the provider match and reset by clear(). Red before: coordinatorAccount "a failed clear on an account switch never serves the old account's results after a restart" -> expected { hash: 'abc1234', …(3) } to match object { state: 'success' }; providerAccountKey (4 providers) -> expected undefined to be type of 'function'. Control "a restart under the same account still serves saved results without a fetch" green before and after.
- REQUIRED trace reason free text: `reason` is now a fixed `CiTraceReason` code; anything else is written as `other`; the pattern scrub is removed. Red before: ciTrace "a reason is written only as a known code..." -> expected "op=op1 kind=detail outcome=failed reason=provider rejected a9c3ef48d6b01e72" to be "op=op1 kind=detail outcome=failed reason=other".
- Mutations (copy mut-1-takeover-1, perl alarm 60s): 8 of 8 RED naming their tests (key ignores account; random key per call; GitHub constant account; GitHub failure shared; token constant; token written raw; token failure shared; reason passthrough).
- Proof: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test all exit 0; 490 files / 7375 tests. detect-changes --scope all: low, 10 files, 0 processes (stale index 033e8c8).
PHASE 1: HALT review still failing after takeover

### Phase 1 owner answer after halt (2026-11-07)
- Owner picked option A, "targeted retry": rerun Phase 1 to fix only Codex's four post-takeover findings (coordinator.ts:292 and :306 blockers, ciTrace.ts:106 and coordinator.ts:113 required). The exact fix is in PLAN.handoff.md under "Phase 1: owner answer after the halt". Root checked all four against the code before asking; Codex's /tmp reproductions were not re-run.

### Phase 1 targeted retry (owner option A, Opus builder) - commit 71536065
Phase 1: built, review pending
- BLOCKERS 1+2 (coordinator.ts:292, :306): account read at every snapshot/detail cache operation and in invalidate(), read again after the fetch (fenced re-ask included); a change throws inside the fetcher so nothing is stored under the old key, and the request is re-asked under the new account (2 tries, last uncached). Red before: coordinatorAccount "a fetch the account switched under is never saved under the old account" and "a forced fetch after a token change with no clear() is never saved under the old account" -> expected { hash: 'abc1234', …(3) } to match object { state: 'failure' }.
- REQUIRED 3 (ciTrace.ts:106): repoKey written as 12-hex SHA-256 prefix, url as origin only. Red before: ciTrace "a token in the repository key or a URL path never reaches the trace" -> expected 'op=op1 kind=log …' not to contain 'REPOTOKEN'; existing ciTrace test updated to expect origin only.
- REQUIRED 4 (coordinator.ts:113): coordinatorAccount "clear() after an account switch resolves again and saves the next answer under the new account". Exact mutation (clear() without clearProviderResolution) -> RED on that test ("expected vi.fn() to be called 2 times, but got 1 times", getRemotes) plus coordinator "does not fetch when provider resolution is cleared during an older request".
- Also added: "an account that reads differently every time still gets an answer, and nothing is saved"; "invalidate() drops the signed-in account's saved answers".
- Mutations (copy mut-1-fix-4, perl alarm 60s): 10 of 10 RED naming their tests (no after-fetch check; account memoized per resolution; exact clear mutation; memo + clear; one try; last try rethrows; invalidate ignores account; last try skips attach; repoKey raw; url keeps path).
- Typecheck caught that the last try returned detail data without capabilities/repoKey; fixed with an `uncached` mapper using detailService `attach` (now exported), pinned by the unreadable-account test.
- view-providers integration: 2 force-retry tests timed out (bounded 20-microtask drain ends before the extra account awaits); drain now yields a full task turn via setImmediate, assertions unchanged; 156/156 pass.
- Proof: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test (490 files / 7381 tests), build:prod all exit 0; verify.py gates --stage round GREEN; package on a clean copy passed verifyVsixPackage (88 entries); knip 0; l10n:validate 0; pre-commit hook chain passed. detect-changes --scope all: low, 6 files, 0 processes (stale index 033e8c8).
PHASE 1: HALT Codex rejects the review model: helpers.py review-model returns gpt-6.1-sol, read from Codex's models_cache.json, but both runs (SIDs 01a1b82a-23e4-7ae2-85c7-50de054a0f24 and 01a1b82f-f2c8-7fe0-887b-05e53d6b8e95) failed with "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." (model_not_found). Can you fix the Codex login or refresh its model list (for example by signing in again, or by running a codex command after deleting ~/.codex/models_cache.json) so that review-model returns a model this account can use? The review will then be rerun with the same prompt.

### Phase 1 wave rerun after the review-model halt (Opus builder) - commit 71536065, no rebuild
Phase 1: built, review pending
- The handoff showed Phase 1 built with review pending, and 71536065 was on HEAD, so nothing was rebuilt and the deterministic gates were run again on HEAD.
- Proof: `python3 ~/.claude/skills/claudex-build/verify.py gates --base 846f85069d08a4d2b8363d5914fe4965daba08e1 --stage accept` printed GATES: GREEN warn=0 (lint:strict, typecheck, format:check, knip, architecture:check, suite 490 files / 7381 tests). `bun run lint`, `bun run react-doctor`, `bun run build` and `bun run build:prod` all exited 0. `bun run package` on a clean copy exited 0 and verifyVsixPackage passed with 88 entries. The tree is unchanged after the gates.

### Phase 1 fix round 1 after the Codex review of 71536065 (Opus builder) - commit 1a689517
- Findings fixed test-first (red before, green after):
  1. failedScan persisted: detailService.test "failedScan stays in memory and is never persisted" red `expected '{"entries":[{"key":"github:repo@abc12…' not to contain 'failedScan'`.
  2. forced refresh failure lost the tree: "a forced refresh that fails keeps the previous detail and reports the error separately" red (received outcome "unavailable", runs []). Added guards: ordinary refetch failure still replaces; earlier unavailable gives the newer error.
  3. settings change did not clear caches: view-providers "clears the snapshot and detail caches when CI settings change" red `expected "clear" to be called 1 times, but got 0 times`. "Apply changed settings live" not done: PLAN says read once at activation (reload to change).
  4. trace URL origin only: ciTrace "no Authorization value, no query string, no log text" red (missing `url=https://pipelines.example.com/o/r/logs/1`). Token-shaped path segments redacted to keep the earlier guarantee.
  5. channel name not localized: view-providers "names the CI trace channel with a localized string" red (received "IntelliGit CI", expected "[t]IntelliGit CI"). Gate L run, all 6 exit 0.
- Mutations on a copy (mut-1-fix-1), 11/11 red naming the matching test.
- Gate G: focused 655 tests, format, lint, lint:strict, architecture, react-doctor, typecheck, build, test (490 files / 7389 tests), build:prod all exit 0; package on a clean copy exit 0 (88 entries). detect-changes --scope all: risk high (activateRepositoryMode hub), see handoff.
- Phase 1 still review pending (Codex review of 1a689517).

### Phase 1 fix round 2 after the Codex review of 1a689517 (Opus builder) - commit 2202955a
- Finding ciTrace.ts:153 (a token in a URL path that matches no known shape is logged; `provider` writes free text): shape-guessing replaced by a fixed allowlist of API route words; every other segment is written `[redacted]`. `provider` is typed `ProviderId` and any other value is written `other` (`KNOWN_PROVIDERS: Record<ProviderId, true>`, so a new id must be listed before it compiles).
- Red before: ciTrace "a token of any shape in a URL path never reaches the trace" -> `secret1234567890123: expected 'op=op1 kind=log outcome=failed url=ht…' not to contain 'secret1234567890123'`; "a provider is written only as a known id, so free text never reaches the trace" -> expected `provider=other`, received the free text. The existing URL tests now expect owner, repo and ids redacted.
- Mutations (copy mut-1-fix-2, perl alarm 60s): 5 of 5 RED naming their tests (keep every segment; provider passthrough; provider always other; drop route word "commits"; revert to a length-based guess).
- Proof: gateG.sh all exit 0 (focused 657 tests, format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test 490 files / 7391 tests, build:prod); package on a clean copy exit 0, verifyVsixPackage 88 entries. Gate L not run: no user-facing string changed. detect-changes --scope all: risk low, 4 files, 0 processes.
- Phase 1 still review pending (Codex review of 2202955a).

### Phase 1 Opus takeover after fix round 2 - commit 9d5792ae
- Finding 1 (ciTrace.ts:218, route word in a variable segment kept): route words now kept only at fixed positions of a provider route template matched at the end of the path; variable and prefix segments always `[redacted]`. Regression test "a token equal to a route word in a variable segment never reaches the trace" was red before the fix: `https://ci.example.com/logs/commits: expected 'op=op1 kind=log outcome=failed url=ht…' to be 'op=op1 kind=log outcome=failed url=ht…'`.
- Finding 2 (serviceCompletion.test.ts:247, in-flight mutation hangs): test now asserts the forced fetch started before the old request settles. Under the mutation "invalidate keeps the in-flight entry" it fails in 3 ms: `AssertionError: forced fetch started without joining: expected "vi.fn()" to be called 1 times, but got 0 times` at serviceCompletion.test.ts:249:72.
- Mutations on copy mut-1-takeover-1: M1 (keep in-flight) red on the named assertion; M2 (keep variable segment value), M3 (variable positions never match), M4 (match anchored at path start) each red on "a token equal to a route word ...".
- Gate G (`bash $TMPDIR/phase-run/PLAN/gateG.sh`): all 10 steps exit 0 (focused 658 tests; test 490 files / 7392 tests). `bun run package` on a clean copy exit 0, verifyVsixPackage passed (88 entries). detect-changes: low, 0 affected flows. Gate L not run: no user-facing string changed.
PHASE 1: HALT review still failing after takeover

### Phase 1 owner answer after second halt (2026-11-08)
- Option A: fix the three post-takeover blockers (service.ts:124, detailService.ts:147, coordinator.ts:336) with one structural rule applied to every fetch path; see PLAN.handoff.md "owner answer after the second halt". Relaunched with `fable: true` (F1/F3 consult before any takeover).

### Phase 1 build after the owner's one-rule answer (Opus builder) - commit 4d565dcb
Phase 1: built, review pending
- Rule applied: after the last wait before a fetched value is cached or returned, the fence is checked again; a failed check re-asks (services) or retries, then answers unavailable (coordinator).
- Red before the fix (6 tests): serviceCompletion and detailService "invalidate|clear during the persistent write: the caller gets the newer result/detail and no layer keeps the older one" -> `expected { hash: 'abc1234', ... } to match object { state: 'failure' }` / `{ outcome: 'failure' }`; coordinatorAccount "an account that changes on every try gets an unavailable answer, and nothing is saved under any account" -> got state success; "an answer whose save finishes after an account switch is asked again under the new account" -> got the old account's failure.
- Changed test: the old "an account that reads differently every time still gets an answer" now expects unavailable (owner's rule replaces it) and also checks nothing stayed in memory under the first id.
- Mutations (copy mut-1-build-5, perl alarm 60 s): M1 service no re-check after persist -> red on both service fence tests (`to match object { state: 'failure' }`); M2 detail same -> red on both detail fence tests; M3 coordinator no account re-check after run -> red on "an answer whose save finishes after an account switch ..."; M4 last try hands back the mismatched fetch -> red on "an account that changes on every try ..." (`expected "vi.fn()" to not be called at all` = store.update).
- Sweep, every wait on the three fetch paths and where it is re-checked:
  - service.ts: 99 getPersisted -> 101; fetchSnapshot (then) -> 115; 126 persist -> 127 (new); 96/109 joined in-flight and 131 re-ask -> the joined or nested call applies the same checks.
  - detailService.ts: 113 getPersisted -> 115; fetchDetail (then) -> 127; 149 persist -> 150 (new); 110/123 joined and 154 re-ask -> same checks; 94 `await getData` -> attach only, nothing cached.
  - coordinator.ts withAccount: 325 readAccount -> nothing returned yet (captures the account); 327 fetch -> 328; 332 run -> 333 (new); attempts run out -> 338 unavailable (snapshot: `unavailableSnapshot`; detail: `floorDetail(unavailableSnapshot)` + attach, the provider-failure shapes). getDetail 176 -> 180, 196 nested fetchSnapshot -> 328 of the outer try, 198 withAccount -> 210. fetchFresh 266 -> providerGeneration check inside resolveEnabledMatch (282). invalidate 242-246 -> nothing cached or returned.
  - No L1 drop or extra persistent delete was added: invalidate/clear already drop the L1 entry set before the write, and the store queues the write before any later delete or clear, so it cannot land after one (the new tests assert both layers).
- Proof: gateG.sh focused 663 tests, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test (490 files / 7397 tests), build:prod all exit 0; format:check exit 1 on two files (line wrap) -> prettier --write, format:check 0; then `verify.py gates --base 846f8506 --stage accept` GATES: GREEN warn=0 (format, knip, architecture, suite); `bun run package` on a clean copy exit 0, verifyVsixPackage 88 entries. detect-changes --scope all: low, 0 processes (stale index 7153606). Pre-commit hook passed. Gate L not run: no user-facing string added.

### Phase 1 fix round 1 after 4d565dcb (Opus builder)
Phase 1: fix round 1, review pending
- F1 persistentCache.ts:145 (cross-window write after clear): both stores keep a clear generation under `<storageKey>.generation` (random UUID, written by `clear()` before the payload removal); payloads are stamped and another stamp is a miss. Red before: "a write from another window that lands after clear() never brings the old entry back" (snapshot and detail store) -> `expected { hash: 'abc1234', …(3) } to be undefined` / `…(7) } to be undefined`.
- F2 coordinator.ts:332 (two discarded saves kept): services take an optional `confirm`, run after the save; a rejection removes exactly that write (L1 by entry identity, L2 by new `delete(key, fetchedAt)`). The coordinator passes its account check as `confirm`. Red before: coordinatorAccount "an account that changes during each save gets an unavailable answer, and neither save is kept" -> `expected [ …(4) ] to deeply equal []`; serviceCompletion / detailService "... rejects after the save is removed, and a newer ... under the key is kept" -> `promise resolved "{ hash: 'abc1234', …(3) }" instead of rejecting`; store "delete with a fetch time removes only the entry written at that time" -> `expected undefined to match object { state: 'success' }`.
- F3 coordinator.ts:353 (snapshot after repository switch): `fetchFresh` re-checks the provider generation after `fetchSnapshot` and returns the none snapshot, traced `discarded-generation`. Red before: coordinator "a snapshot that arrives after a repository switch is not handed back" -> `expected { hash: 'abc1234', …(3) } to match object { state: 'none' }`.
- F4 coordinator.ts:37 (English error): `vscode.l10n.t("The signed-in account changed during the request.")`, catalog + CSV row with 11 translations. Red before: "an account that changes on every try ..." (mock l10n prefixes `[l10n] `) -> `expected { hash: 'abc1234', …(5) } to match object { state: 'unavailable', …(1) }`.
- Mutations (copy mut-1-fix-1, perl alarm 60 s), each red on its named test: M1/M2 store read ignores the generation; M3/M5 service keeps a rejected save (also red on the coordinatorAccount test); M4/M6 undo deletes unconditionally; M7 store delete ignores fetchedAt; M8 coordinator passes no confirm; M9 no generation check in fetchFresh; M10 message not localized.
- Gate L (`bash $TMPDIR/phase-run/PLAN/gateL.sh`): all 6 steps exit 0 (audit: 0 strings missing). Gate G (`gateG.sh`): all steps exit 0 except format:check (2 test files) -> prettier --write -> format:check 0; focused 671 tests, full suite 490 files / 7405 tests. `bun run package` on a clean copy exit 0, verifyVsixPackage 88 entries. `verify.py gates --base 846f8506 --stage accept`: GATES: GREEN warn=0. detect-changes --scope all: risk medium, 3 flows (RefreshCommitCheckBadges -> clear/write, the intended change); index 4 commits behind.
- Committed as ff53205d (pre-commit hook passed).

### Phase 1 fix round 2 after ff53205d (Opus builder) - commit 145a52fe
Phase 1: fix round 2, findings 1-3 fixed, finding 4 halted for the owner
- F1 persistentCache.ts:118 / detailPersistentCache (fetch started before another window's clear): services capture `persistentCache.generation()` when the fetch starts and pass it to `set(..., {generation, id})`; the store refuses the write inside its queue when the shared generation changed. Red before: serviceCompletion / detailService "a fetch that started before another window's clear() is not saved when it ends" -> `the pre-clear answer was read back after a restart: expected "vi.fn()" to be called 1 times, but got 0 times`; store "a write whose fetch started before another window's clear() is refused" -> `expected { hash: 'abc1234', …(3) } to be undefined` (detail `…(7)`).
- F2 persistentCache.ts:141 / detailPersistentCache.ts:118 (same-millisecond delete): `delete(key, writeId)` removes the entry only while the payload's `unconfirmed[key]` is that random write id. Red before: the existing "... rejects after the save is removed, and a newer answer/detail under the key is kept" with both saves in the same millisecond -> `expected undefined to match object { state: 'success' }` / `{ outcome: 'success' }`; store "delete with a write id removes only that write, never a newer one from the same millisecond" -> `expected { hash: 'abc1234', …(3) } to be undefined`.
- F3 service.ts:239 / detailService.ts:254 (rejected save readable after a failed delete): with `confirm`, the save is written unconfirmed and only `confirmWrite(key, id)` after a pass makes it readable; a failed removal leaves it unconfirmed. Red before: "an answer/a detail its caller rejects stays unreadable after a restart when removing it fails" -> `the rejected answer was read back after a restart: expected "vi.fn()" to be called 1 times, but got 0 times`; store "an unconfirmed write stays unreadable, also after a restart, until its id confirms it" -> `unconfirmed write read back: expected { hash: 'abc1234', …(3) } to be undefined`.
- F4 persistentCache.ts:54 (unlisted globalState keys): not changed. Moving the generation into the payload key would let a late-landing write from another window undo a clear (the previous round's finding). HALT: plan amendment is the owner's call (question in the handoff BLOCKED line).
- Mutations (copy mut-1-fix-2, perl alarm 60 s), each red on its named test: M1/M2 service reads the generation at save time -> "a fetch that started before another window's clear() ..."; M3/M4 store ignores write.generation -> store "refused" + service test; M5/M6 store get ignores `unconfirmed` -> "unconfirmed write stays unreadable" + "rejects stays unreadable"; M7/M8 delete ignores the write id -> "same millisecond" store test + service "newer ... is kept"; M9/M10 no confirmWrite -> coordinatorAccount "a restart under the same account still serves saved results without a fetch" (+2); M11/M12 no write id -> "rejects stays unreadable" + coordinatorAccount "... neither save is kept".
- Gate G (`gateG.sh`): all 10 steps exit 0 (focused 28 files / 679 tests; full suite 490 files / 7413 tests). `bun run package` on a clean copy exit 0, verifyVsixPackage 88 entries. Gate L not run: no user-facing string added. detect-changes --scope all: risk medium, 3 badge-refresh write flows (intended); impact on CommitChecksPersistentCache HIGH (27 upstream), index 5 commits behind.
PHASE 1: HALT Finding 4 (persistentCache.ts:54) needs your call. Option A (recommended): amend the Migrations "New keys" list in PLAN.md (line 743) to add globalState["intelligit.commitChecks.cache.v1.generation"] and globalState["intelligit.commitChecks.detailCache.v1.generation"]. Each key holds a random clear generation for its store. Data saved before this change has no generation and still matches, and older versions ignore the keys. The amendment would also list the stored payload's two optional fields, `generation` and `unconfirmed`. Option B: no new keys. The generation moves into the existing payload key, which means a save from another window that lands after a clear can bring the cleared entries back. Which do you want?

### Phase 1 owner answer after third halt (2026-11-08)
- Option A: PLAN.md amended (Migrations: the two `.generation` keys and the optional payload fields `generation` and `unconfirmed`; Rollback names the keys; Failure-mode sweep gains "Multi-window scope of the persistent caches", which puts finer cross-window orderings out of scope as Open risks, not blockers). Finding 4 needs no code change. Relaunched with `fable: true`; next is the review of 145a52fe.

### Phase 1 relaunch after the owner's third answer (Opus builder) - HEAD 02311728
Phase 1: built, review pending
- No rebuild: the handoff already had Phase 1 built and review pending with 145a52fe and the plan amendment 02311728 on HEAD. Deterministic gates rerun on HEAD only.
- Gate G (`gateG.sh`): all 10 steps exit 0 (focused 28 files / 679 tests; full suite 490 files / 7413 tests). `verify.py gates --base 846f85069d08a4d2b8363d5914fe4965daba08e1 --stage accept`: GATES: GREEN warn=0 (format, knip, architecture, suite). `bun run package` on a clean copy exit 0, verifyVsixPackage 88 entries. Gate L not run: no string changed since ff53205d's Gate L pass.

### Phase 1 fix round 1 after the relaunch (review of 02311728, Opus builder) - commit c5414643
Phase 1: fix round 1, review pending
- F1 persistentCache.ts:143 / detailPersistentCache.ts:114 (clear between a save's generation check and its write): `read()` now captures the clear generation before the payload and returns it; every write (set, get's LRU bump, confirmWrite, delete) stamps that read generation, and `set` refuses when the fetch-start generation differs from it. Red before (HEAD store code, new test "a clear from another window between a save's or a read's own steps leaves nothing readable", clear fired after the nth store read, save n=1..8, get n=1..3): snapshot -> `save, clear after read 2: expected { hash: 'abc1234', …(3) } to be undefined`; detail -> `save, clear after read 2: expected { hash: 'abc1234', …(7) } to be undefined`.
- F2 contractVersion.ts:5 (no pin): new detailService test "the detail contract version starts at 1, and persisted details carry and accept 1" (constant toBe(1), on-disk contractVersion [1], a hand-written version-1 entry is served without a fetch). Code was already 1, so red shown by mutation: constant = 2 -> `expected 2 to be 1 // Object.is equality`.
- Mutations (copy mut-1-fix-3, perl alarm 60 s): M1/M2 store write stamps the write-time generation -> red `save, clear after read 2` (each store); M3 constant 2 -> red as above; M4/M6 get's LRU write stamps the write-time generation -> red `get, clear after read 2: older entry: expected {…} to be undefined`; M5 entry written with version 2 -> red on the new test (+7 others). M4 first survived when the clear fired only on generation reads; the test was widened to fire on any store read.
- Gate G (`gateG.sh`): all 10 steps exit 0 except format:check (detailService.test.ts) -> prettier --write -> format:check 0; focused 28 files / 682 tests; full suite 490 files / 7416 tests. `bun run package` on a clean copy exit 0, verifyVsixPackage 88 entries. `verify.py gates --base 846f8506 --stage accept`: GATES: GREEN warn=0. detect-changes --scope all: medium, 3 flows (index 7153606, stale). Gate L not run: no user-facing string.

### Phase 1 fix round 2 after the review of c5414643 (Opus builder) - commit 1b9e67ae
- Findings (spec line 161, bad shape -> miss, overwritten): persistentCache.ts:244 threw on a null snapshot entry; detailPersistentCache.ts:217 threw on `runs: [null]`; both also threw on the next save, so the cache never recovered.
- Fix: both stores drop bad-shaped entries in `read()` before the completion and coverage rules. Snapshot: new `isEntryShape` (key, times, snapshot object with hash, state, items list of objects). Detail: `isEntryShape` now also requires runs, jobs, steps, otherChecks, attemptHistory and attempts to be lists of objects. Shared `isObjectList`.
- Red before (persistentCache.completion.test.ts, new tests "an entry with a bad shape ..."): snapshot `null entry: read: expected 'threw: TypeError: Cannot read propert…' to be 'ok'`; detail `null run: read: expected 'threw: TypeError: Cannot read propert…' to be 'ok'`. Each test also checks the valid neighbour stays readable and that a replacement save lands and reads back.
- Mutations (copy mut-1-fix-7, perl alarm 60s): 9 of 9 red, each on its named variant (null entry, null check item, null snapshot, null run, null job, null step, null other check, null attempt history, null attempt).
- Proof: `bash $TMPDIR/phase-run/PLAN/gateG.sh` all 10 steps exit 0 after a prettier reflow of two touched files (focused 28 files / 684 tests; test 490 files / 7418 tests). `verify.py gates --base 846f8506 --stage accept`: GATES: GREEN warn=0. `bun run package` on a clean copy exit 0, verifyVsixPackage 88 entries. detect-changes --scope all: low, 0 processes (stale index). Gate L not run: no user-facing string changed.
- Phase 1 still review pending (review of 846f8506..1b9e67ae).

### Phase 1 Opus takeover (after fix rounds c5414643, 1b9e67ae) - commit 5dcfab1b
- Findings: persistentCache.ts:333 (invalid snapshot state string served) and detailPersistentCache.ts:295 (numeric job state served); spec line 161, bad shape -> miss, overwritten.
- Red before the fix: `invalid state: read: expected { hash: 'abc1234', …(3) } to be 'ok'` and `numeric job state: read: expected { hash: 'abc1234', …(7) } to be 'ok'`.
- Fix: new src/shared/ci/persistedShape.ts, a full runtime shape check with allowed sets typed from the unions and field maps typed from the interfaces; both stores call it before the completion and coverage rules. isObjectList removed.
- Added tests: 12 more bad-shape cases (state, item state, missing summary, numeric url, job/run/step/other-check/attempt states, provider, missing outcome, string attempt) plus two tests that a snapshot and a detail with every optional field set are still served.
- Mutations (copies mut-1-takeover-1..9): all 9 red. Looser guard -> named bad-shape case red (M1-M5); stricter optional/null -> "every optional field set is served" red (M6, M7); a union member or interface field missing from the check -> TS2345 (M8, M9).
- Proof: gateG.sh 10/10 exit 0 (focused 686 tests, full 490 files / 7420 tests); `bun run package` on a clean copy exit 0, 88 entries; detect-changes low (stale index).
PHASE 1: HALT review still failing after takeover

### Phase 1 owner answer after fourth halt (2026-11-08)
- Option A "fix it now": the finding at service.ts:94 / detailService.ts:110 (another window's clear leaves this window's in-memory entries and in-flight fetches unfenced) is in scope. PLAN.md "Multi-window scope" amended to cover each window's in-memory cache and in-flight fetches once that window can see the new clear generation. Relaunched with `fable: true`; next is a fix of that finding, then review.

### Phase 1 fix of the fourth-halt finding (Opus builder) - commit 7b3dd586
Phase 1: built, review pending
- Finding service.ts:94 / detailService.ts:110 (another window's clear left L1 entries and in-flight fetches unfenced). Fix: the store clear generation joins each service's fence tuple; L1 entries carry it and are not served once it changes (the detail force-refresh fallback too); a fetch or saved read spanning a clear retries after its last wait and first removes its own in-flight entry so it cannot self-join.
- Red before (9 new two-service tests on shared storage): snapshot `the pre-clear in-memory answer was served`, `the caller got the pre-clear answer`, `the answer confirmed across the clear was served`, `the saved answer read across the clear was served`; detail equivalents plus `the refresh fell back to the pre-clear detail` (each `expected 'failure' to be 'pending'/'unavailable'`). Two older "another window's clear() is not saved" tests now give the retry a non-persistable answer.
- Mutations (copy mut-1-fix-20, perl alarm): 9 of 9 red on named tests. M1/M5 no L1 check -> in-memory test; M2/M6 fence ignores the store generation -> in-flight, confirm, saved-read tests; M3/M7 no check after confirm -> confirm test (+2 existing fence tests); M4/M8 no own in-flight delete -> in-flight test `Test timed out in 10000ms` (per-test 10 s timeout); M9 fallback ignores the generation -> forced-refresh test.
- Proof: gateG.sh 10/10 exit 0 (focused 28 files / 695 tests; full 490 files / 7429 tests). `verify.py gates --base 846f8506 --stage accept`: GATES: GREEN warn=0. `bun run package` on a clean copy exit 0, verifyVsixPackage 88 entries. detect-changes --scope all: 3 badge-refresh flows (stale index 7153606). HEAD before commit d50a7a65 (Phase 1's own commits on top of 846f8506). Gate L not run: no user-facing string.

### Phase 1 fix round 1 after the 7b3dd586 review (Opus builder) - commit 3965f37a
- Finding: a failed persistent CI cache save was swallowed with no trace (service.ts:256, detailService.ts:274).
- Fix: both services trace `outcome: "failed", reason: "storage"` when the store's set or confirmWrite fails; the entry stays in L1 only.
- Red before the fix (4 new tests): "the failed persistent save was not traced once: expected [] to deeply equal [...]" and "the failed confirm of the persistent save was not traced".
- Mutations: 4 of 4 (drop each storageFailed() call) red on the named test.
- Proof: gateG.sh steps 1-10 exit 0 after prettier --write on the two test files (focused 699 tests; bun run test 490 files / 7433 tests); bun run package on a clean copy exit 0, verifyVsixPackage passed (88 entries).
- Phase 1: built, review pending (846f8506..3965f37a).
PHASE 1: ACCEPTED 3965f37a, VERIFICATION INCOMPLETE
PHASE 1 UNVERIFIED: bun run package in the repository checkout exited 1: verifyVsixPackage rejected 6 untracked files the checkout already had (output/playwright/pr321/*.log, not in the diff). On a clean HEAD copy the same command exited 0 with 88 entries, so the chained proof command passes only on a clean tree. Running it also left an ignored intelligit-0.43.2.vsix in the repository root.; Real VS Code globalState ordering across windows or devices (Codex): the tests use a shared Memento test double.; Later-phase journeys (Checks tab, webview request ordering A -> B -> A, action fence, HEAD monitor, live provider APIs) are outside Phase 1 (Codex).; Guards, flags and constants beyond the 12 Codex mutated, including the architecture-rule mutation (Codex).; The 200-entry GitHub-fixture cache-size check needs a Phase 2 fixture that does not exist yet (Codex).; Codex's copy has no .git, so it did not check git status itself. I checked it in the repository: clean apart from the two allowed plan files.
Codex returned VERDICT: ACCEPT with no BLOCKER or REQUIRED findings, so no finding was dropped. REVIEW_MODEL=gpt-6-sol (helpers.py review-model, exit 0). Codex SID 01a1bba0-b7ba-77a3-b914-73bb72ab06ac, codex_rc=0. The review ran on a copy of HEAD 3965f37a at $TMPDIR/phase-run/PLAN/review-1-1, effort high. Report: $TMPDIR/phase-run/PLAN/codex1.out.

Commands I ran:
- verify.py gates --base 846f8506 --stage round: exit 0, GATES: GREEN warn=0 (lint, typecheck and format OK).
- Proof chain, each step run on its own in the repo (logs in $TMPDIR/phase-run/PLAN/proof1-logs): bun vitest run on the 19 phase test files exit 0 (19 files, 345 tests); format:check 0; lint 0; lint:strict 0; architecture:check 0; react-doctor 0; typecheck 0; build 0; bun run test 0 (490 files, 7433 tests); build:prod 0.
- bun run package in the repo exited 1. vsce packaged 94 files, then verifyVsixPackage failed on 6 files outside the allowlist: output/playwright/pr321/*.log, untracked leftovers in the checkout dated 2026-10-03. They are not part of the phase diff.
- bun run package on a clean git-archive copy of HEAD ($TMPDIR/phase-run/PLAN/pkg-1-1): exit 0, verifyVsixPackage passed (88 entries).
- git status --porcelain: only PLAN.review-log.md (M) and PLAN.handoff.md (??).

Codex evidence:
- Focused tests: commitChecks 22 files / 518 tests; shared/ci 4/19; checksRefresh 1/4; view-providers integration 1/158; host-wiring 1/1. All exit 0.
- Scenarios, each with test file:line evidence: repeat/force refresh, late old fetch, reload/restart with old-version or account-scoped data, failure before or after save/confirm, another window clearing during fetch/save/confirm/read, sign-out during detail work. Codex also wrote a temporary old->new->old key test across clear and restart: 2/2 pass, then deleted it.
- Mutations: all 12 red, each under the perl process-group cap of 60 s:
  - pending guard: 'failure with a pending item is not complete', expected true to be false.
  - settlement coverage guard: settlementOf pageBound, expected settled to be unknown.
  - snapshot generation fence: 'a fetch started before invalidate is not cached'.
  - detail generation fence: 'clear() drops a late result'.
  - snapshot persisted delete on invalidate: red.
  - detail persisted delete on invalidate: red.
  - detail contractVersion guard: 'persisted contractVersion != current is a miss'.
  - incomplete-failure retry ladder: 'incomplete failure keeps the ladder', got [].
  - snapshot save-failure trace: 'traces a failed persistent save as a storage failure and keeps serving the answer from L1', got [].
  - snapshot confirm-failure trace: 'traces a failed confirm of the persistent save as a storage failure'.
  - detail save-failure trace: red, got [].
  - detail confirm-failure trace: red.
  These last four reproduce all four mutations the builder claimed red.
- Dispositions:
  - Missing storage traces: fixed at service.ts:256,298 and detailService.ts:274,309.
  - Repeated cross-window clears, invalid provider values, NaN->null, the extra confirm write, unreadable unconfirmed entries: allowed under PLAN.phase-1.md:161,314-343.
  - Downgrade behaviour, stale GitNexus index, package/knip/no-repo/l10n items: outside Phase 1 scope under PLAN.phase-1.md:849-876.
- Gate-gaming scan: no added .only, .skip or suppressions.
WAVE 1 2+4+19: OPEN base 3965f37aa571e64478b840b9de033accf816499d
WORKTREE 1 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-3 phase-run/PLAN/w1/2
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-4 phase-run/PLAN/w1/4
WORKTREE 1 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-5 phase-run/PLAN/w1/19

### Phase 19: built, review pending (builder phase-builder opus high, base 3965f37aa571e64478b840b9de033accf816499d, branch phase-run/PLAN/w1/19)
- Built test-first: new src/services/commitChecks/ciActionFence.ts (CiActionFenceStore over workspaceState key intelligit.ci.actionFences.v1, pure showsActionEffect, 10-minute not-seen timer re-armed from stored at); fence checked inside both persistent stores' enqueue callbacks; snapshot and detail services serve a fenced hash from L1 only with the pending TTL, skip its persisted entry, and the detail service resolves fences on each current-generation fetch and attaches actionFence at read time; CiAction/CiActionEvidence types; provider actionEvidence hook; wiring in repositoryMode.ts; 0.43.3 + CHANGELOG + docs/commit-checks/README.md.
- Gates: verify.py gates --stage accept GREEN (focused, format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test 491 files / 7456 tests passed, build:prod, package).
- First full run RED: 79 extension.integration tests (CiActionFenceStore constructor read context.workspaceState, which those activation contexts omit) -> store now built only when workspaceState exists, like every other workspaceState use in repositoryMode.ts. Two more reds (tsconfigCoverage, screenshotComparatorMeta) came from the worktree's empty node_modules (tests call repo-local typescript/playwright CLIs); packages were linked into the worktree's gitignored node_modules and both passed.
- Mutations (copy mut-build-1, focused files, each RED, first red test named): M1 detail store drop fence check -> "a fenced key is never persisted, even complete"; M2 snapshot store same; M3/M4 fence checked at enqueue time -> "a set queued before the fence but run after it is refused"; M5 fences in memory only -> "fence survives a new instance over the same workspaceState"; M6 drop fences older than 7 days -> "reopen after 8 days ... fence kept, result not persisted"; M7 end on any result -> "a fenced key is never persisted, even complete"; M8 GitLab retry watches old job attempt -> "GitLab job retry: a newer job id with the same logical id ... ends the fence"; M9 any newer id -> "a newer job with another logical id does not end the fence"; M10 string id compare -> "GitLab pipeline retry: a job id above before.maxJobId ends the fence"; M11 cancel only on cancelled -> "cancel fence ends when the target run is cancelled or complete"; M12 timer emits nothing / M15 fence deleted at 10 min -> "notSeen switches at 10 min by timer with no fetch"; M13 timer from activation -> "timer re-armed after restart from the stored time"; M14 -> "endByUserRefresh ends a not-seen fence and does nothing before"; M16 no actionFence -> "served actionFence follows the fence store"; M17/M21 TTL ignores fence -> "a fenced hash uses the pending TTL in L1"; M18 -> "a persisted entry for a fenced hash is not read back"; M19 begin unawaited -> "a failed fence write rejects begin and leaves no fence"; M20 -> "a fetched detail that shows the action ends the fence".
- Not run: GitNexus impact/detect_changes (worktree guard refuses commands naming the .gitnexus path); substitute: text search of constructor call sites (repositoryMode.ts, coordinator.ts), all changes additive optional options.
- Open: activation wiring (repositoryMode passes the store) has no test; fences live per window (workspaceState) while caches are shared (globalState), so another window without the fence may persist the fenced hash's result.
- Phase 19 commit 2cffb0f3a6f0f8175d7072375798f1aa6fcc774d on phase-run/PLAN/w1/19. The pre-commit hook's knip (deps:check:strict, not in the gate manifest) refused the first attempt over two unused exports (showsActionEffect, CiActionFenceBefore); both made module-private, then knip, typecheck and the commitChecks unit tests (23 files / 541 tests) passed and the hook's full battery (prettier, eslint, knip, depcruise, l10n, typecheck, build, package) passed on commit.

### Phase 2: built, review pending (2026-11-08)
- Commit a668b12d57d988c87ef1464445934f2ec61410fa on phase-run/PLAN/w1/2, started at 3965f37aa571e64478b840b9de033accf816499d.
- Proof: focused 5 files / 71 tests green; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package green; pre-commit hook battery green.
- bun run test: 6 of 493 files red in the loaded parallel-wave run (7461/7467 tests). host-wiring mock lacked gatedFetchWithMeta (fixed, green). diffBudgets, merge-editor-performance, shelf list-aware-restore (timing/timeouts) green when rerun alone. tsconfigCoverage and screenshotComparatorMeta need <worktree>/node_modules (worktree has none); both green in a copy with node_modules at its root. The suite was not rerun whole after the mock fix.
- Mutations: 21 real mutations on a copy, all red with named assertions (M1 first draft was equivalent and was replaced by M1/M1b).
- GitNexus detect-changes not run: the worktree is not an indexed repo (only the main checkout is).
WORKTREE 1 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-6 -
WORKTREE 1 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-7 -
WORKTREE 1 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-8 phase-run/PLAN/w1/2
WORKTREE 1 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-9 phase-run/PLAN/w1/19
- 2026-11-08 16:41 Phase 2 fix round 1 (Opus builder): 3 findings fixed test-first at 747360931e8a1b91a566199cbdaada0ff0b942db on phase-run/PLAN/w1/2. (1) scan page after requester went stale is dropped before keep/post; (2) refused next link keeps the page's failed jobs and stops; (3) found job's check run removed from otherChecks. Each regression test red before the fix; 3 mutations red naming their tests. Gates: focused 5 files 114 tests pass, format/lint/lint:strict/architecture/react-doctor/typecheck/build/build:prod/package pass; bun run test 2/493 files red (tsconfigCoverage, screenshotComparatorMeta: worktree lacks node_modules; both pass in a copy with it). Review pending.
WORKTREE 1 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-10 -

## Phase 19 — fix round 1 (Opus builder) — commit d468cb3e9976fa0d6ca3459c32c80bfe17295282
- Findings fixed: (1) service.ts:239 old snapshot held in L1 becomes fresh forever after the fence ends; (2) service.ts:120 cross-window persisted old entry read back after the fence ends.
- Fix: CiActionFenceStore.onDidEnd (sync; resolve and endByUserRefresh, not fail); both services evict the hash from L1, discard fetches/stored reads straddling the end via a per-hash fence-end count, and call new persistent deleteHash(hash) inside the store queue.
- Red before fix (ciActionFence.test.ts "when a fence ends"): "a snapshot held while fenced is fetched again once the fence ends" -> expected state 'pending', received 'failure' (:598); "an old result another window saved while this one was fenced is not read back" -> expected 'pending', received 'failure' (:656).
- Mutations (copy mut-fix-2), all RED with named test: M1 no onDidEnd subscription (4 tests); M2 snapshot in-flight end check (snapshot in-flight test); M3/M4 snapshot/detail deleteHash dropped (cross-window test); M5 detail self-exemption dropped (evidence detail test, force); M6 fail() emits (detailService "served actionFence follows the fence store"); M7/M8 stored-read end check (queued-read test); M9 detail in-flight end check; M10/M11 snapshot/detail L1 eviction.
- Gates: commitChecks 23 files/547 tests; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package, deps:check:strict exit 0; bun run test 491 files: 2 env failures (empty worktree node_modules) green after linking packages; pre-commit hook passed.
- Open: nothing re-requests the row badge on fence end (Phase 8); another window's own L1 can still show the old result.
WORKTREE 1 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-11 -
WORKTREE 1 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-12 phase-run/PLAN/w1/2

### Phase 4: built, review pending (builder phase-builder opus high, base 3965f37aa571e64478b840b9de033accf816499d, branch phase-run/PLAN/w1/4)
- Commit: 6c932c85c7f3c34527d86e08e004d0dd2f12b7c2 (68 files, +3225/-50). The pre-commit battery was green: gitleaks, prettier, eslint, knip, depcruise, l10n validate/audit, typecheck, build, package.
- Proof (verify.py gates, accept stage, one gate running the whole PROOF_CMD chain): run 3 GREEN in 820.2 s. Phase tests: 6 files, 49 passed. Full `bun run test`: 494 files, 7461 tests passed.
- Runs 1 and 2 were RED only on wall-clock timing tests while sibling wave worktrees ran at the same time: run 1 on merge-editor-performance (3.40x vs 2.9x) and diffBudgets (78.7 ms vs 59); run 2 on diffBudgets alone (84.9 ms vs 59). Both pass when run alone (7 passed). Phase 4 touches no diff or merge-editor code.
- After gates run 3, knip in the pre-commit hook flagged two unused exports (UNKNOWN_TIME in ciFormat.ts, CommitCiOutbound in commitCiMessages.ts). I removed the `export` keyword from both, with no runtime change. Rechecked: knip, typecheck, lint and format:check exit 0, and the 6 phase test files (49 tests) pass. The full gate chain was not rerun after this edit; the pre-commit battery (which includes build and package) passed on the committed tree.
- Mutations (on a copy, mut-p4-1): 15 of 15 RED, each failing a named test. M1 otherChecks-only -> "shows the tree for the selected commit"; M2 no auto-expand -> "expands failed job to failing step"; M3 no hash check -> "drops a detail reply for a commit that is no longer selected"; M4 older requestId accepted -> "A→B→A drops the first A reply"; M5 no requestId check -> "same-hash out-of-order refresh keeps the newest"; M6 no repoKey check -> "same SHA in another repository is not reused"; M7 request while the Files tab is active -> "no detail request while the Files tab is active"; M8 floor shows the group header -> "floor provider renders flat list without dead controls"; M9 no signInHost branch -> "renders signed-out, unavailable and cooldown states"; M10 ignore jobsCoverage -> "partial coverage shows the open-in-browser note"; M11 first 1000 jobs only -> "failed jobs past the first 1 000 are listed"; M12 ignore failedScan -> "overflow scan paused shows the paused note"; M13 no tab persistence -> "tab choice persists"; M14 no tab switch -> "Open in Checks selects row and switches tab"; M15 no isCurrent -> "host drops a reply after a generation bump".
- Gate L green (l10n validate, 0 strings missing); 36 CSV rows authored by hand because l10n:translate is not configured. Gate U: impeccable detect found 0 anti-patterns.
- Deviations: (1) E2E seam = globalState fixture "intelligit.e2e.ciFixture", read only while the E2E control channel is active, and allowlisted; the coordinator gained a `fixture` option. (2) M8 replaces the plan's "log button" mutation, because no log button exists until Phase 7. (3) CommitCiOutbound was added to the coverage-manifest union pins. (4) The undocked host uses selectedRepositoryRoot as its repoKey. (5) Host string "Commit checks error: {message}" was added to l10n/bundle.l10n.json. (6) Version bumped 0.43.2 -> 0.44.0 with a CHANGELOG entry; siblings bump to 0.43.3, so the merge must resolve the version.
- Not run: tests/e2e/ciChecksTab.spec.ts (E2E runs on CI; it has not run locally). GitNexus detect-changes ran against the main-checkout index (risk critical, 52 files); the worktree is not indexed.
- Phase 4: built, review pending
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-13 -
WORKTREE 1 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-14 phase-run/PLAN/w1/19

### Phase 2 fix round 2 (builder) - f0e710c77e4156f8972d376cd53167509e0eb651
- Finding githubProvider.ts:325: getDetail now requires both snapshot collections (requireBoth); a failed check-run page gives an unavailable detail; getChecks unchanged. Test "a failed check-run page makes the detail unavailable while the status list loads", red before fix: expected { …(8) } to match object { outcome: unavailable, …(3) }.
- Finding githubProvider.ts:286: scan cursor carries runName; scanned jobs map with it. Test "a scanned job without workflow_name takes its run's name, as on the normal path", red before fix: received " job 1050".
- Mutations on a copy (requireBoth=false; scope "") each red on its own test. Proof: focused 5 files, format, lint, lint:strict, architecture, react-doctor, typecheck, build, build:prod, package all exit 0; bun run test 3/493 files red (2 need worktree node_modules; diffBudgets timing under load, passes alone).
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-15 phase-run/PLAN/w1/4
WORKTREE 1 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-16 -

### Phase 19 fix round 2 (2026-11-08) - commit 933df99c
- Finding: fence identity lacked repoKey (ciActionFence.ts:379). Fixed: fenceId = repoKey+hash+targetId; fail and endByUserRefresh take (repoKey, hash, targetId).
- Red before fix: "the same commit and target in a second repository keeps the first repository's fence" -> `expected undefined to match object { targetId: '77' }` (test line 485); "fail and endByUserRefresh end only the named repository's fence" -> `expected { targetId: '77', …(2) } to be undefined` (line 504).
- Mutations on a copy: M1 drop repoKey from fenceId -> both new tests red; M2 fail picks the first repository's fence -> "fail and endByUserRefresh end only..." red; M3 endByUserRefresh picks the last repository's fence -> same test red. Control M0 30/30 green.
- Gates: commitChecks unit 23 files/549 tests pass; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test (491 files/7464 tests), build:prod, package, deps:check:strict exit 0; pre-commit hook passed.
- Plan amendment requested: fail/endByUserRefresh signatures gain repoKey first.
WORKTREE 1 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-17 -
PHASE 2: HALT Fable says the plan must change for Phase 2: Verdict: finding 1 is a real code defect the builder filed as a decision; finding 2 is a spec/plan deadlock, not a code defect. Rounds failed because (a) the builder closed finding 1 as 'removed flat checks do not recompute outcome' (handoff:25), so fixes went to requireBoth and runName instead, and (b) the prefix change was logged only in the handoff (handoff:28); the reviewer checks the frozen plan, so no code change can clear it. Reasons: served() (diff:586-616) never recomputes complete, breaking PLAN:288/316; PLAN:356 itself flags the prefix as ASSUMED and defers to the phase fixture; strict '/repos/' would break all GitHub paging. Cheapest check: `curl -sI -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/microsoft/vscode/actions/runs?per_page=1"` and read the Link header; a '/repos/microsoft/vscode/' link falsifies finding 2. Confidence: high on 1, medium-high on 2 (raised by that curl).
PHASE 19: HALT Fable says the plan must change for Phase 19: Verdict: the rounds failed because the plan's literal signature `resolve(hash, detail)` (PLAN.phase-19.md:854) and the diff's own cross-repo test (ciActionFence.test.ts:1714) told the builder that repository-blind resolution is intended, so round 2 repaired fenceId identity, not resolve's scope, and the handoff defends hash-only as "deliberate". That is a builder-versus-reviewer deadlock the plan cannot settle; the plan must be amended (line 854 and §3 step 4 "for the target in that repository"), and it must either scope two-window fence storage in or out. Finding 3 is a plain missing mirror test, missed because round-2 mutations ran only on the new tests. Cheapest check proving me wrong: show that GitHub/GitLab run ids cannot collide across instances sharing one provider id. Confidence: medium-high; the VS Code memento cross-host sync claim is from memory, not this diff.

## Phase 4 fix round 1 (2026-11-08)
- Commit 52f92f69 on phase-run/PLAN/w1/4 resolves 5 findings test-first: scan re-posts under the same requestId until done/stopped (ciDetailHandler.test.ts x2), flat-check durationMs (floor test), loading spinner row, run line placeholders, E2E frame 2:2 layout at 740/790 px.
- Red before fix: "expected [ 9 ] to deeply equal [ 9, 9, 9, 9 ]"; "expected [ undefined, undefined ] to deeply equal [ 2m 05s, — ]"; "loading row: expected null not to be null"; "expected undefined to be push by — · main · #42". M12 replay on a copy: 760->900 red "tree column at 790 px", 760->700 red "detail under the tree at 740 px".
- Proof: phase tests 7 files 127 passed; format, lint, lint:strict, architecture, react-doctor, typecheck, build OK; full suite 494 files 7465 passed; build:prod and package OK. ciChecksTab.spec.ts ran locally: 4 passed.
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-22 -
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-23 phase-run/PLAN/w1/4
- Phase 4 fix round 2 (a5): 09d593bd on phase-run/PLAN/w1/4. Fixed ciDetailHandler re-post loop cancellation (newer request replaces, cancelCommitCiDetail on tab hide/unmount, disposal stops; stale cancel ignored) and step start time in CheckTree. Reds before fix: 're-posts after replacement: expected Set{ 1, 2, 3 } to deeply equal Set{ 3 }', 're-post timer left after hide: expected 1 to be +0', 'expected [] to deeply equal [ { …(2) } ]' (no cancel posted), 'step start time: expected 'FailedRun tests30s' to contain '11/7/26, 12:00 PM''. 7 mutations on a copy all red. Battery exit 0; full suite 494 files / 7472 tests.
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-24 -
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-26 phase-run/PLAN/w1/4
- Phase 4 takeover (a7): run rows now show start time (CheckTree.tsx RunGroup); tree test asserts run state/duration/start and job start. Red: "run start time: expected 'PassedCI3m 00s' to contain '11/7/26, 12:00 PM'". Mutation (job start removed) red on "job start time". Battery exit 0 (494 files, 7472 tests, vsix built). Commit 589d223f on phase-run/PLAN/w1/4.
WORKTREE 1 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_36ed56a7-e7e-27 -
PHASE 4: HALT review still failing after takeover
WAVE 1 2+4+19: CLOSED accepted -; halted 2+4+19

## Owner answers after the wave 2,4,19 halts (2026-11-08)
- PHASE 2 owner answer: option A, allow both GitHub prefix forms (PLAN.md §3 continuation guard amended, FACT); fix served() so dropping flat checks recomputes `complete`, test-first.
- PHASE 19 owner answer: option A, fence methods take repoKey first (PLAN.md §3 step 4, Phase 19, Phase 8 amended); per-window fence scope out (Failure-mode sweep); add the missing mirror test test-first.
PHASE 4 owner answer (2026-11-08): targeted retry, no plan change; fix 'Open in Checks' dropped when the Changed Files webview is not ready (CommitInfoViewProvider.ts:176) test-first. Retry wave 2,4,19 runs with fable: true (owner OK past the Fable budget).
WAVE 2 2+4+19: OPEN base 3965f37aa571e64478b840b9de033accf816499d
WORKTREE 2 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-3 phase-run/PLAN/w2/2
WORKTREE 2 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-5 phase-run/PLAN/w2/19
WORKTREE 2 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-4 phase-run/PLAN/w2/4

### Phase 2: built, review pending (wave 2 retry, builder phase-builder opus high, base 3965f37aa571e64478b840b9de033accf816499d, branch phase-run/PLAN/w2/2) - commit 5eb2812c8c5167a48c95b37410ff6894b6a7ec9f
- Carried the wave-1 Phase 2 work (a668b12d, 74736093, f0e710c7) forward as one commit (fast-forward, then soft reset to the base so the phase is a single commit on 3965f37a).
- Owner answer, guard: githubProvider.allowNext already accepts /repos/{o}/{r}/ and /repositories/{id}/ (id read from the runs response); githubDetail "hostile next link" cases cover the id form and a foreign id. Matches amended PLAN.md §3.
- Owner answer, defect fixed test-first: detailService.ts served() now recomputes `complete` with the shared rule `hasUnfinishedWork(runs, otherChecks)` (src/shared/ci/completion.ts; githubProvider detailOf uses the same rule). Outcome is not recomputed: a scan exists only for a failed run, so failure-wins cannot change.
- Test detailService.test.ts "dropping a found job's pending flat check recomputes complete; another pending check keeps it incomplete". Red before fix: "nothing is pending once the found job's check run leaves: expected { hash: 'abc1234', ...(9) } to match object { complete: true, outcome: 'failure' }".
- Mutations on a copy (mut-build-1): M0 control green; M1 served keeps provider complete -> red "nothing is pending once the found job's check run leaves ..."; M2 flat pending ignored by hasUnfinishedWork -> red "a pending status still keeps the detail incomplete: ... { complete: false, ... }".
- Proof: verify.py gates --stage accept with PROOF_CMD = Gate G chain + l10n:validate. Phase tests 5 files / 76 passed; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build exit 0; bun run test 493 files: 6 tests in 3 files red under parallel wave load (diffBudgets "typical compute: expected 190.63 to be less than 59"; operationBenchmark "git add --all: unable to create temporary file: Invalid argument"; list-aware-restore 4 tests "Test timed out in 120000ms"); those 3 files rerun alone: 3 files / 67 passed. build:prod, package (intelligit-0.43.3.vsix, 88 entries), l10n:validate exit 0 run after. Pre-commit hook passed.
- Not run: GitNexus impact/detect_changes (worktree not indexed, index stale at 7153606); substitute: served() and detailOf are module-private, hasUnfinishedWork is new. E2E none for this phase (no UI).
- Phase 2: built, review pending
WORKTREE 2 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-6 -

### Phase 19: built, review pending (wave 2 retry, base 3965f37aa571e64478b840b9de033accf816499d, branch phase-run/PLAN/w2/19)
- Commit 807535857536fcbdbb645f102fa802f111231695: wave 1's fence work (2cffb0f3, d468cb3e, 933df99c) folded into one commit, plus the owner answer: `resolve(repoKey, hash, detail)` ends only that repository's fences; detailService passes serve.repoKey.
- Red before fix: "a detail for one repository never ends the same commit's fence in another repository" -> `expected false to be true`. Mirror test added: "a persisted detail for a fenced hash is not read back" (finding 3).
- Mutations on a copy (control 68/68 green): drop repoKey filter -> two-repository test red; drop detail persisted-read isFenced guard -> mirror test red; detailService passes "" -> two-repository test and "a fetched detail that shows the action ends the fence..." red.
- Gates: focused, format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package, deps:check:strict OK; bun run test RED twice only on load timing tests (list-aware-restore 120 s timeouts, diffBudgets, merge-editor-performance), all three pass alone (58 tests); run 2 7463/7466. Pre-commit battery passed.
- Finding 2 (two windows on one workspace) left as an open risk per the plan's per-window fence scope.
WORKTREE 2 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-7 -
WORKTREE 2 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-8 phase-run/PLAN/w2/2
WORKTREE 2 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-9 phase-run/PLAN/w2/19
- Phase 2 fix round 1 (w2 a3): finding detailService.ts:283 (L1 freshness read pre-scan data) fixed test-first in beb1fef1 on phase-run/PLAN/w2/2; isFresh judges served(entry). Red before: "the scan-completed detail is not refetched: expected vi.fn() to be called 1 times, but got 2 times". Gate G green (full test 7471/7473; 2 reds were missing worktree node_modules, pass after linking); build:prod, package, l10n:validate exit 0.
WORKTREE 2 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-10 -

### Phase 4: built, review pending (wave 2 retry, builder phase-builder opus high, base 3965f37aa571e64478b840b9de033accf816499d, branch phase-run/PLAN/w2/4)
- Branch fast-forwarded to 589d223f (the wave 1 build, fix rounds and takeover on phase-run/PLAN/w1/4; 3965f37a is its ancestor), then one targeted fix per the owner answer: commit fdca8bb1ef3c562c650604b5eff56fc1d3893f18. HEAD before commit 589d223f, checked by the builder; review range 3965f37a..fdca8bb1.
- Finding fixed: CommitInfoViewProvider.openChecksTab dropped "Open in Checks" when the Changed Files webview was not ready (collapsed, never resolved, or still loading). Now the hash is held in pendingChecksHash and posted once from the `ready` handler; a reload does not repeat it.
- Tests (tests/unit/views/CommitInfoViewProvider.test.ts, "CommitInfoViewProvider Open in Checks"): "review: Open in Checks survives a view that is not ready yet" red before fix: `open request after ready: expected [] to deeply equal [ { type: 'openChecksTab', …(2) } ]`; "Open in Checks before the view was ever resolved reaches it once it is ready" red before fix: `open request after first resolve: expected [] to deeply equal [...]`; "Open in Checks on a ready view posts at once" (control, green before and after).
- Mutations on a copy (mut-build-1), control 8/8 green: M1 no flush on ready -> both first tests red (`open request after ready`, `open request after first resolve`); M2 pending never cleared -> "survives..." and "on a ready view" red (`open request repeated on reload: expected [ …(2) ] to have a length of 1 but got 2`); M3 old drop-while-not-ready -> all 3 red.
- Takeover fix (run row start time) untouched; commitChecksTab "shows the tree for the selected commit" passes in the focused run.
- Proof: verify.py gates --stage accept, PROOF_CMD = Gate G chain (focused 7 files / 67 tests; format:check; lint; lint:strict; architecture:check; react-doctor; typecheck; build; test; build:prod; package). Run 4 GREEN in 476.8 s: full suite 494 files / 7475 tests passed; intelligit-0.44.0.vsix 88 files. Pre-commit battery passed.
- Runs 1-3 RED only on load-bound tests while sibling worktrees ran (load average 100-146 on 10 CPUs): list-aware-restore.integration.test.ts "an outside index stat refresh {between two entries | after the last entry applies | before ownership publication} ..." (120 s timeout; 52.8 s / 37.7 s / 24.2 s when the file ran alone, 51/51 green), merge-editor-performance "keeps accepted diff-viewer tiers within the measured render target" (30 s timeout), diffBudgets "large compute: expected 168.9 to be less than 59". The 3 files passed alone (58/58). Phase 4 touches no shelf, diff or merge-editor code.
- Gate L not run: no user-facing string added. Gate U detector not run: no UI file changed. GitNexus impact/detect_changes not run (index stale at 7153606, worktree not indexed); substitute: text search, the only caller of openChecksTab is src/activation/repositoryMode.ts:384.
- Phase 4: built, review pending
WORKTREE 2 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-11 -
- 2026-11-08 Phase 19 fix round 1 (builder): a8576513 on phase-run/PLAN/w2/19. F1 staleStored L2 guard in both services; F2 unsettled fences skip resolve; F3 begin refuses a second action on a fenced target. 5 new tests, each red before; 6 mutations red on named tests; Gate G all exit 0 (test 7471/7471). Review pending.
WORKTREE 2 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-12 -
WORKTREE 2 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-13 phase-run/PLAN/w2/2
WORKTREE 2 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-14 phase-run/PLAN/w2/4
WORKTREE 2 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-15 phase-run/PLAN/w2/19
- Phase 2 fix round 2 (10e4d637, phase-run/PLAN/w2/2): added jobsTwoPages.json and generated failedRun2000Jobs.ts fixtures, used by the paging/scan tests; refused-link scan test asserts posts == [stopped]. Guard removed -> red "expected [ running, stopped ] to deeply equal [ stopped ]". Gate G all exit 0 (full test 7473/7473). Review pending.
WORKTREE 2 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-16 -
- 2026-11-08 Phase 4 fix round 1 (w2 a3): Codex REQUIRED CommitInfoViewProvider.ts:111 (late ready from a replaced view hands the held Open in Checks to the new view) fixed test-first in a69080ad on phase-run/PLAN/w2/4: ready handler and onDidDispose return when this.view !== webviewView. Red before: "not before replacement ready: expected [ { type: 'openChecksTab', …(2) } ] to..." and "open request after old view disposed: expected [] to deeply equal [...]". 2 mutations on a copy, each red on its own test. Gate G: focused 8 files/143 green; format, lint, lint:strict, arch, react-doctor, typecheck, build 0; test 7476/7477 (operationBenchmark git temp-file error under load, 12/12 alone); build:prod, package 0. Review pending.
WORKTREE 2 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_a95d2e3a-2a3-17 -
PHASE 19: HALT fix agent died (API error or usage limit); rerun /phase-run with the same args to continue
PHASE 4: HALT review agent died (API error or usage limit); rerun /phase-run with the same args to continue
PHASE 2: HALT review agent died (API error or usage limit); rerun /phase-run with the same args to continue
WAVE 2 2+4+19: CLOSED accepted -; halted 2+4+19
WAVE 3 2+4+19: OPEN base 3965f37aa571e64478b840b9de033accf816499d
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-4 phase-run/PLAN/w3/4
WORKTREE 3 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-5 phase-run/PLAN/w3/19
WORKTREE 3 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-3 phase-run/PLAN/w3/2

### Phase 2: built, review pending (wave 3 rerun, base 3965f37aa571e64478b840b9de033accf816499d, branch phase-run/PLAN/w3/2) - commit 10e4d637
- Fast-forwarded phase-run/PLAN/w3/2 from 3965f37a to 10e4d637 (wave 2 build 5eb2812c, fix round 1 beb1fef1, fix round 2 10e4d637); no new code. Wave 2 halted only because its review agent died; the review of 3965f37a..10e4d637 is still owed.
- Gate G + L on 10e4d637: focused 5 files / 77 passed; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package, l10n:validate exit 0; bun run test 7469/7473 with 4 load timeouts in merge-editor-performance, list-aware-restore (2), changelistVirtualRows; those 3 files rerun alone 56/56 passed.
- Phase 2: built, review pending
- 2026-11-09 Phase 4 wave 3 (builder, rerun after the wave 2 review agent died): no rebuild. phase-run/PLAN/w3/4 fast-forwarded 3965f37a -> a69080ad3bae098861571c0bbeab25db5f5d3dde (phase-run/PLAN/w2/4 head); HEAD before the move was 3965f37a. Gate G on a69080ad: focused 7 files/69 green; format, lint, lint:strict, arch, react-doctor, typecheck, build exit 0; test 7472/7477 (5 load-bound reds: merge-editor-performance, list-aware-restore x3, diffBudgets; 58/58 alone at load average 95-123); build:prod and package exit 0 (0.44.0 vsix, 88 entries). Review range 3965f37a..a69080ad.
- Phase 4: built, review pending
WORKTREE 3 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-6 -
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-7 -

### Phase 19: built, review pending (wave 3 retry, base 3965f37aa571e64478b840b9de033accf816499d, branch phase-run/PLAN/w3/19) - commit a99afd66a6580a49bc74b5e34b2c88044fe7d81d
- Branch fast-forwarded to a8576513 (wave 2: 80753585 build, a8576513 fix round 1); review range 3965f37a..a99afd66. HEAD before commit a8576513 (descends from 3965f37a).
- a99afd66 fixes the wave-2 round-2 Codex REJECT (w2/p19/a4/codex-r1.out), work recovered from the died fix agent's uncommitted tree (wf_a95d2e3a-2a3-15) and re-proved here: BLOCKER service.ts:247/detailService.ts:268 (failed deleteHash at a fence end + restart served the old stored result) -> ended fences stay stored (`retained`) until every onDidEnd removal resolves; fenceEnded returns the removal and rethrows. REQUIRED ciActionFence.ts:185 (write stored then rejected left a fence after restart) -> begin re-persists without the fence on rejection.
- Red before fix: "a fence write that stores and then rejects leaves no fence after a restart" (`expected true to be false`); "an old stored result stays unreadable after a restart when its removal at the fence end failed once" (`expected { hash: 'abc1234', …(3) } to match object { state: 'pending' }`).
- Mutations on a copy (mut-build-1, control 75/75): persist without retained, store end regardless, no undo write, snapshot swallows, detail swallows, never retain -> 6/6 red on the named test.
- Gate G: focused 75/75; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build exit 0; bun run test 7471/7473 (list-aware-restore 120 s timeout, merge-editor-performance render budget, under parallel wave load; both files alone 54/54); build:prod, package (intelligit-0.43.3.vsix, 88 entries) exit 0. Commit hook passed. GitNexus not run (worktree not indexed); substitute: onDidEnd callers are only service.ts and detailService.ts; detailService calls resolve with `void`, so no await cycle.
- Phase 19: built, review pending
WORKTREE 3 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-8 -
WORKTREE 3 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-9 phase-run/PLAN/w3/2
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-10 phase-run/PLAN/w3/4
WORKTREE 3 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-11 phase-run/PLAN/w3/19
- Phase 2 wave 3 fix round 1 (f858246e): scan page 429/quota 403 now pauses via new read-only RequestGate cooldownEnd accessor; permission 403 stops. Red before: "expected 'stopped' to be 'paused'". Focused 80/80; Gate G exit 0 except bun run test 7473/7476 (3 env/load reds, proven unrelated). Review pending on 3965f37a..f858246e.
WORKTREE 3 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-12 -
PHASE 2: HALT The Phase 2 review could not run in this worktree. The wrapper's rules forbid moving HEAD, so I could not switch to phase-run/PLAN/w3/2 (my worktree's HEAD stays on main, 846f8506). The isolation guard also refused my other routes: a checkout in a scratch clone, and the heredoc that writes the Codex/Gate G runner script ('too complex to verify that it stays inside the worktree'). Should the next review run with HEAD switching allowed in its own worktree (git switch --detach phase-run/PLAN/w3/2) and a runner script it is allowed to write, or should Root run the Codex round outside worktree isolation?
- 2026-11-09 Phase 19 wave 3 fix round 1 (a3): 79f88949 on phase-run/PLAN/w3/19 fixes both REQUIRED findings test-first (cancel fence kept on `unknown`; fail() keeps the fence and rejects when its removal write fails). Both new tests red before, 5 mutations red on named tests. Gate G green except 2 load-bound full-run reds (list-aware-restore, diffBudgets) passing alone 55/55. Review range 3965f37a..79f88949.
- Phase 4 wave 3 fix round 1: ca727524 on phase-run/PLAN/w3/4 (from a69080ad). Fixed 4 findings test-first: sign-in/out invalidates open Checks tabs (commitCiDetailInvalidated, 3 hosts), e2e fixture requires every capability flag, new step-capability and no-repoll-when-complete tests; 9 mutations red on named assertions. Gate G: focused 9 files/304 green, static gates + build exit 0, full test 7481/7483 (list-aware-restore + merge-editor-performance load reds, alone 54/54), build:prod + package exit 0. Review pending.
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-15 -
WORKTREE 3 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-14 -
WORKTREE 3 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-16 phase-run/PLAN/w3/19
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-18 phase-run/PLAN/w3/4
- Phase 19 wave 3 fix round 2 (e51478c2): fence writes re-read and merge the stored list inside the queued write, keeping records this window never held; 3 two-window regression tests red before (expected undefined to match object { targetId: 77 }; expected false to be true x2), 5 mutations red; Gate G all exit 0 (test 7478/7478). Review range 3965f37a..e51478c2.
WORKTREE 3 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-19 -
PHASE 19: HALT Fable says the plan must change for Phase 19: Both findings share one cause: K30 stores all fences in one list under one key, and workspaceState offers neither compare-and-swap nor a change event, so a whole-list read-merge-write from two extension hosts is last-writer-wins by construction. Round 1 (merge) lost the owner's record on a stale read; round 2 (`known` set) fixed that by letting a window co-own loaded records, which resurrects fences their owner deleted. No third merge variant can fix both. The spec is wrong in two places: :764 says fences are 'per window' in a per-workspace store, and K30 fixes the single-list format the builder correctly refused to change. Amend K30 to one key per fence record (or a file per fence under storageUri, as K13 already does); then each key has one writer and both findings disappear. Confidence high; a delayed-propagation Memento test against the per-key layout would disprove it.
- 2026-11-09T01:46Z Phase 4 wave 3 fix round 2: commit 3d1389ea on phase-run/PLAN/w3/4 (tests only). F1 stopped-loop fetch test (3 cases) red under post-sleep guard removal; F2 proved host re-keying in CommitInfo, undocked host and undocked webview, each red under its mutation. Gate G green: focused 227/227, full 7488/7488, build:prod and package 0. Review range ca727524..3d1389ea.
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-22 -
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-24 phase-run/PLAN/w3/4
- Phase 4 takeover (wave 3): f6d4a0c1 on phase-run/PLAN/w3/4. Both switch paths now re-key/clear the panes before the fallible preference write, each with a rejecting-write test (red before fix). GitNexus refreshed: impact LOW on both switch functions; detect_changes all = high, compare vs 3965f37a = critical, neither partial nor truncated. Gate G green except diffBudgets wall-clock (71.6 vs 59 ms) under full-suite load, green alone. Review range 3d1389ea..f6d4a0c1.
WORKTREE 3 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_b2757765-9db-25 -
PHASE 4: HALT review still failing after takeover
WAVE 3 2+4+19: CLOSED accepted -; halted 2+4+19
- 2026-11-09 PHASE 19 owner answer: A, one key per fence. PLAN.md K30, §3 action fence, §6 failure row, :764 scope and Phase 19 build step 1 plus a delayed-propagation two-store test amended; builder resumes from phase-run/PLAN/w3/19 e51478c2.
WAVE 4 2+4+19: OPEN base 3965f37aa571e64478b840b9de033accf816499d
WORKTREE 4 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-5 phase-run/PLAN/w4/19
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-3 phase-run/PLAN/w4/2
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-4 phase-run/PLAN/w4/4
- 2026-11-09 Phase 4 wave 4 (builder, per Root's resume note): no rebuild, no code change. phase-run/PLAN/w4/4 fast-forwarded 3965f37a -> f6d4a0c1 (phase-run/PLAN/w3/4 head, linear on the base). Gate G on f6d4a0c1: focused 10 files / 329 tests green; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build exit 0; bun run test 7486/7490 (4 reds under load average ~300 from parallel wave builders: merge-editor-performance render budget, list-aware-restore x3 at the 120 s timeout; rerun alone: list-aware-restore 53/53 green, merge-editor-performance timed out at 30 s at load 308; the phase touches no merge-editor or shelf code); build:prod, package exit 0. GitNexus: not rerun (no edits; the wave-3 takeover's detect-changes ran on this same tree f6d4a0c1). Review range 3965f37a..f6d4a0c1.
- Phase 4: built, review pending
- 2026-11-09 Phase 2 wave 4 (builder, resume per Root's note): no rebuild. phase-run/PLAN/w4/2 fast-forwarded 3965f37a -> f858246e5b3c2b1d460f6e119b5ae1dd6a7a47f3 (phase-run/PLAN/w3/2 head: 5eb2812c, beb1fef1, 10e4d637, f858246e); HEAD before the move was 3965f37a; no new commit, nothing changed. Gate G on f858246e: focused 5 files/80 tests green (githubDetail, paginate, httpMeta, detailService, capabilities); format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build exit 0; bun run test 7471/7476 (5 timeouts at load average 308-367: diff-viewer ceiling-sized diff 30 s, merge-editor-performance render target 30 s, list-aware-restore x3 120 s); rerun of those 3 files alone 149/150 (merge-editor-performance timed out again under the same load), then that file alone 3/3 in 23.6 s; the phase diff touches no webview, diff, merge-editor or shelf code. build:prod and package exit 0 (intelligit-0.43.3.vsix, 88 entries, verifyVsixPackage passed). GitNexus impact/detect_changes not run (worktree not indexed, index stale at 7153606). Review range 3965f37a..f858246e.
- Phase 2: built, review pending
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-6 -
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-7 -

### Phase 19: built, review pending (wave 4, owner answer A "one key per fence", 2026-11-09)
- Branch phase-run/PLAN/w4/19: fast-forwarded to phase-run/PLAN/w3/19 (e51478c2) per the owner answer, then 212eb44b (per-key fence storage). HEAD gate: base 3965f37a is an ancestor; HEAD moved only by that owner-directed fast-forward plus 212eb44b. Review range: 3965f37a..212eb44b (this step alone: e51478c2..212eb44b).
- Change: ciActionFence.ts stores each fence at `intelligit.ci.actionFence.v1:<encodeURIComponent(repoKey)>/<hash>/<encodeURIComponent(targetId)>` (value = the record, undefined once ended), loads by listing the prefix with `workspaceState.keys()`, and drops a record whose key is not its own. persist(target) writes only that fence's key with this window's value for it (live fence unless being removed, else a retained ended fence, else undefined). The list key, the read-merge-write and the `known` set are gone. Public signatures unchanged.
- Tests: new delayed-propagation fake Memento (per-window views, writes reach other windows only on propagate()). New: "two windows over one workspaceState with delayed propagation: neither a begin nor an end in one window drops or revives the other window's fence" (end by fail and by evidence), "a begin from a window that still sees an ended fence does not bring it back" (both ends), "each fence is stored under its own key and ending it removes only that key"; the malformed-record test now covers a record under another fence's key and a non-fence key. Storage assertions moved to the prefix. Fakes in detailService.test.ts and three activation integration tests gained keys().
- RED before the change: 9 tests failed (no per-key storage: e.g. "expected [ 'intelligit.ci.actionFences.v1' ] to deeply equal [ …(2) ]").
- Mutations on a copy (mut-build-1, control 49/49): M1 one list under one key -> 13 red, incl. delayed-propagation test at ciActionFence.test.ts:921 `expect(reopened.isFenced(OTHER_HASH)).toBe(true)` "expected false to be true" (dropped) and the stale-begin test at :944 `expect(reopened.isFenced(HASH)).toBe(false)` "expected true to be false" (revived). M2 accept a record under another key -> "drops malformed stored fences and keeps valid ones" red. M3 persist ignores retained -> "an old stored result stays unreadable after a restart when its removal at the fence end failed once" red. M4 persist ignores removing -> 7 red incl. "the fence is in memory before its write finishes and fail removes it".
- Gate G: focused (ciActionFence, detailService, tests/integration/extension) exit 0; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build exit 0; bun run test 7481/7483, 2 red = merge-editor-performance "keeps accepted diff-viewer tiers within the measured render target" and diffBudgets "large compute: expected 148.15 to be less than 59" (wall clock under load; both files 7/7 alone); build:prod exit 0; package exit 0 (intelligit-0.43.3.vsix, 88 files, verifyVsixPackage passed). Pre-commit battery passed on commit.
- GitNexus (worktree indexed with the main checkout's runner): impact CiActionFenceStore upstream MEDIUM (6 direct, 1 process: activateRepositoryMode), run after the edit, not before; detect-changes --scope all: 6 files, 38 symbols, 0 processes, risk low, no partial/truncated.
WORKTREE 4 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-8 -
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-9 phase-run/PLAN/w4/4
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-10 phase-run/PLAN/w4/2
WORKTREE 4 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-11 phase-run/PLAN/w4/19
- 2026-11-09T11:53:12Z Phase 4 fix round 1 (wave 4): ChecksTab selection scoped to repoKey+hash; regression test "a job picked on one commit does not carry over to another commit or repository" red before (expected 'unrelated-b...' to contain 'failed-b'), green after; 2 mutations red, control green. Gate G: focused 10 files green, format/lint/lint:strict/architecture/react-doctor/typecheck/build/build:prod/package exit 0; bun run test 6 load timeouts (list-aware-restore x4, merge-editor-performance, diff-viewer) at load ~400, outside the phase; rerun alone: 2 green, list-aware-restore 3 timeouts. Commit c3b9e8b9 on phase-run/PLAN/w4/4.
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-12 -
- Phase 2 wave-4 fix round 1: linkHeaderNext comma-in-URL finding fixed test-first (red: coverage full after page 1); commit 565a7f74 on phase-run/PLAN/w4/2; focused 6 files/107 tests pass; format/lint/lint:strict/arch/react-doctor/typecheck/build/build:prod/package exit 0; bun run test 7471/7478 with load-bound timeouts only (load ~380). Review pending.
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-13 -

## Phase 19 fix round 1 (w4, a3) - f864023d
- Finding 1 (ciActionFence.ts:512): stored before.state now checked against STATES (CiState set); new test red before fix at ciActionFence.test.ts:764 "expected true to be false", green after; mutation dropping "queued" red at :765.
- Finding 2 (README.md:106): paragraph removed; README equals 3965f37a; re-add moved to Phase 8 under Plan amendments.
- Gate G: phase files 348/348; all scripts exit 0 except bun run test 7478/7484 (load-bound budgets; two node_modules-path tests that pass with node_modules linked). Pre-commit passed. Review pending.
WORKTREE 4 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-14 -
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-15 phase-run/PLAN/w4/4
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-16 phase-run/PLAN/w4/2
WORKTREE 4 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-17 phase-run/PLAN/w4/19
- 2026-11-09T13:10Z Phase 4 fix round 2 (a5): openChecksTab added to the Git Log and undocked inbound unions and handled in both (select commit + Checks tab, other repoKey dropped). Test commitChecksOpenTabMessage.integration.test.tsx red before ('the details pane switched to Checks: expected Files to be Checks'), green after; 4 mutations red on the named assertions. Gate G green except bun run test 7493/7495 (load-bound timing: merge-editor-performance passed alone, list-aware-restore still times out alone). Commit f8c6b6d3 on phase-run/PLAN/w4/4.
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-18 -

### Phase 2 - wave 4 fix round 2 (Opus builder) - commit fc3a4151
- Finding 1 (scan reuses cursor after cooldown without rechecking attempt): continueFailedScan GETs actions/runs/{id} before every page and returns {runChanged: true} on an id/attempt mismatch; runScan drops the progress and refetches the key (force) with the newest requester's fetch and confirm. Red before: "expected [ 'job 1050', 'job 1900' ] to deeply equal [ 'job 1900' ]" (test "automatic cooldown resume rechecks a run changed from another device").
- Finding 2 (rel= inside quoted params): quote-aware sticky Link parser, first rel only, unparseable header throws. Red before: "expected { items: [ 1, 2 ], coverage: 'full' } to deeply equal { items: [ 1, ..." and "expected undefined to be 'https://a.test/x?page=2'".
- Finding 3 (GitNexus): worktree indexed and impact/detect-changes run AFTER the edits (not the pre-edit check): all changed symbols LOW, continueFailedScan UNKNOWN (only caller coordinator.ts:198 by text search); detect-changes vs 3965f37a risk high from activateRepositoryMode flows (provider constructor wiring), accepted.
- Mutations on a copy: 7/7 red. Gate G: focused 110/110; format, lint, lint:strict, architecture, react-doctor, typecheck, build, build:prod, package exit 0; bun run test 7474/7481 (7 load-bound timeouts/contention outside commitChecks; isolated rerun 63/64, 1 merge-editor-performance timeout).
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-19 -
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-21 phase-run/PLAN/w4/2

### Phase 19 fix round 2 (builder, 2026-11-09)
- Commit 410c6a1f on phase-run/PLAN/w4/19. Finding 1 (late fail disarms newer fence timer): timers and not-seen flag keyed by record; regression test red before at ciActionFence.test.ts:754 ("the newer fence must keep its not-seen notification timer: expected vi.fn() to be called 1 times, but got 0 times"), green after; mutation (clear by target id) red at the same line.
- Finding 2 (Gate G.11): worktree indexed at HEAD f864023 before editing; impact arm/disarm/notSeen/end LOW, class MEDIUM, fail/begin UNKNOWN (no src caller by text search); detect-changes --scope all: 2 files, 11 symbols, 0 processes, low, not partial/truncated.
- Gate G: phase files 349/349; all lint/type/build/package steps exit 0; bun run test 7476/7485 under load ~344, all 9 failing tests (7 files, outside commitChecks) pass re-run alone or with node_modules linked. Review pending.
WORKTREE 4 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-22 -
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-24 phase-run/PLAN/w4/4
WORKTREE 4 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-26 phase-run/PLAN/w4/19
- 2026-11-09T14:28:47Z Phase 4 TAKEOVER (wave 4): 6bf9520d. F1 CommitInfoApp repoKey guard (red: "another repository's open request leaves Files selected: expected 'Checks' to be 'Files'"), F2 newer-requestId test (mutation < red: "an unsolicited newer reply is dropped"), F3 GitNexus indexed: detect-changes 73 files/565 symbols/critical, impact HIGH useCommitCiDetail+ensureUndockedPanel, callers all covered. Gate G green except bun run test 7494/7497 (timing, load ~330; list-aware-restore still times out alone).
WORKTREE 4 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-27 -

### Phase 2 wave 4 takeover (a7) - 2026-11-09
- Ran the missing review #2 myself: Codex gpt-6.1-sol high on fc3a4151 -> VERDICT: REJECT, 2 REQUIRED (empty Link value/relation read as last page; GitNexus run after edits), 12/12 mutations red.
- Fixed REQUIRED 1 test-first in 847b5524 (paginate.ts linkEntries: empty unquoted value or empty rel throws). Red before: "rel=: expected [Function] to throw an error". 2/2 mutations red on a copy.
- REQUIRED 2: pre-edit GitNexus impact run this step at fc3a4151 before the edit (linkEntries LOW); earlier rounds' ordering cannot be redone; accepted.
- Gate G: focused 115/115; format, lint, lint:strict, arch, react-doctor, typecheck, build, build:prod, package exit 0; bun run test 7480/7486 (6 load-bound failures in non-CI files; merge-editor render budget also red on fc3a4151).
WORKTREE 4 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_3c42a081-3c7-28 -
- 2026-11-09 14:43 Phase 19 takeover (w4/p19/a7): finding 1 fixed in 2f2d6adc (begin rejects when Refresh ended its pending fence; test red at ciActionFence.test.ts:714 before, 52/52 after; mutation red). Gate G steps 1-8, 10, 11 exit 0; step 9 bun run test exit 1 (7482/7486, 4 timing tests outside commit-checks, load ~300). HALT: owner to choose a quiet-machine rerun or an exception.
PHASE 19: HALT Gate G step 9 (`bun run test`) cannot exit 0 on this machine while the other builders in the wave keep the load average near 300. 4 timing tests outside the commit-checks code fail: list-aware-restore (2 tests), merge-editor-performance and diffBudgets. Should the full suite be re-run on a quiet machine after the wave, before Phase 19 is accepted, or do you grant an explicit exception for these 4 timing tests?
PHASE 4: HALT review still failing after takeover
PHASE 2: HALT review still failing after takeover
WAVE 4 2+4+19: CLOSED accepted -; halted 2+4+19
- 2026-11-09 owner answers after wave 4: A for all three. Phase 2: fix the untranslated "Malformed Link header." (12 bundles + CSV, Gate L); owner exception for the earlier rounds' GitNexus ordering. Phase 4: fix both REQUIRED (queued Open in Checks carries repoKey, checked in CommitInfoApp.tsx; no automatic retry after a failed forced Refresh). Phase 19: full suite re-run by Root on a quiet machine before wave 5.
- 2026-11-09 Root quiet-machine Gate G step 9 for Phase 19 at 2f2d6adc: `bun run test` exit 0, 491/491 files, 7486/7486 tests (after `bun run build`; load about 140). Valid for 2f2d6adc only.
WAVE 5 2+4+19: OPEN base 3965f37aa571e64478b840b9de033accf816499d
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-4 phase-run/PLAN/w5/4
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-3 phase-run/PLAN/w5/2
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-5 phase-run/PLAN/w5/19
- 2026-11-09 19:40 Phase 19: built, review pending (wave 5, a1). No rebuild and no code change per the owner answer: phase-run/PLAN/w5/19 fast-forwarded from 3965f37a to 2f2d6adc (w4/19 takeover head). Gates on HEAD 2f2d6adc: focused commitChecks 23 files 571/571; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package (intelligit-0.43.3.vsix, 88 entries, verifyVsixPackage passed) all exit 0. bun run test not re-run (owner: Root quiet-machine run at 2f2d6adc, exit 0, 7486/7486, still valid because HEAD is that same commit). Review range 3965f37a..2f2d6adc.
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-6 -

## Phase 2: built, review pending (wave 5, 2026-11-09)
- Commit 65b081b2 on phase-run/PLAN/w5/2 (w4/2 847b5524 + this fix). Fix for Codex review #3 REQUIRED 1: "Malformed Link header." now goes through vscode.l10n.t; catalog entries in 12 bundles + CSV.
- Red before fix (detail and scan tests in the user language); 2 mutations on a copy red on the named tests; GitNexus impact before the edit LOW (linkEntries 4, linkHeaderNext 3, paginate 1).
- Gate L exit 0; Gate G all exit 0 except bun run test 7484/7489 at load ~288 (merge-editor-performance, list-aware-restore x3, diffBudgets: timing only; 58/58 alone).
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-7 -
- 2026-11-09 Phase 4 wave 5 (builder, owner answer A): phase-run/PLAN/w5/4 fast-forwarded 3965f37a -> 6bf9520d (phase-run/PLAN/w4/4 head), then one commit fixing Codex review #3's two REQUIRED findings test-first.
  - R1 (CommitInfoViewProvider.ts:199 + CommitInfoApp.tsx:102): the held Open in Checks request now carries the repoKey captured when it was asked; the standalone app holds a request received while nothing is shown and applies it only if the next detail's ciRepoKey matches. Red before: "the held request names the repository it was made in: expected [ { type: 'openChecksTab', ... } ] to deeply equal" (CommitInfoViewProvider.test.ts) and "another repository's request received while loading leaves Files selected: expected 'Checks' to be 'Files'" (commitChecksOpenTabMessage).
  - R2 (useCommitCiDetail.ts:130): a detail carrying refreshError schedules no automatic request. Red before: "requests after a failed forced Refresh: expected 3 to be 2" (commitChecksTab "review: a failed forced Refresh of pending detail is not retried automatically").
  - Mutations on a copy (mut-build-1), control 40/40: M1 host posts the current key -> red on the provider test; M2 accept when nothing shown -> red "another repository's request received while loading..."; M3 held applies for any repo -> same red; M4 held never applies -> red "a request received while loading shows Checks: expected 'Files' to be 'Checks'"; M5 drop the refreshError guard -> red "expected 3 to be 2".
  - GitNexus (worktree indexed before the edit): impact upstream CommitInfoViewProvider.openChecksTab LOW (1), postPendingChecksTab LOW (2), CommitInfoApp App LOW (1), useCommitCiDetail HIGH (5 direct: ChecksTab, CommitInfoPane, CommitGraphPanel, CommitInfoApp App, UndockedLayout; all rendered by the focused tests). detect-changes --scope all: 6 files, 10 symbols, 0 processes, risk low, no partial/truncated flag.
  - Gate G: focused 11 files exit 0; format:check exit 0 (after prettier on the new test); lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0; bun run test 7497/7499, 2 red = list-aware-restore "an outside index stat refresh between two entries / after the last entry applies" (120 s timeout at load ~230-270); that file alone 51/51 green.
- Phase 4: built, review pending
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-8 -
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-9 phase-run/PLAN/w5/19
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-10 phase-run/PLAN/w5/4
- Phase 19 fix round 1 (w5 a3): Codex REQUIRED begin-vs-fail race fixed in a7537841 (begin rejects when fail is removing its fence). Regression test red before: "expected [ +0 ] to deeply equal []"; green after. Gates exit 0; bun run test 7486/7487 with one load timeout in merge-editor-performance, which passed alone 3/3. Review pending.
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-11 -
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-12 phase-run/PLAN/w5/2
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-13 phase-run/PLAN/w5/19
- Phase 4 fix round 1 (w5, a3): Codex REQUIRED F1 (A->B->A shows stale A) and F2 (host scan loop re-reads after failed forced Refresh) fixed test-first in bda55216 on phase-run/PLAN/w5/4. Red before: "returning to A awaits its own reply: expected detail to be loading"; "provider reads after the failed Refresh: expected vi.fn() to be called 1 times, but got 2 times". Mutations 4/4 red (control 45/45). Battery all exit 0, bun run test 7502/7502. Review pending.
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-14 -

## Phase 2 wave 5 fix round 1 (attempt a3) - 8ff0c0e6
Findings: (1) runChanged restart joined the originating in-flight fetch; fixed in getData (fetch leaves inflight before starting scans); red before fix: "the restart fetches the run again: expected vi.fn() to be called 2 times, but got 1 times". (2) gate wiring untested; provider list moved to src/activation/commitChecksProviders.ts, new test mocks https.get and asserts no request while the gate cools down; M12 replay red: "no request may leave while the gate cools down ... called 1 times".
Proof: phase files incl. new test exit 0; format/lint/lint:strict/arch/react-doctor/typecheck/build/build:prod/package exit 0; bun run test 7490/7491 (diffBudgets timing at load ~168, passes alone 4/4). VERIFICATION INCOMPLETE: Gate G step 9.
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-15 -
- Phase 19 fix round 2 (2dd4129a): README "Re-run and cancel" section added; test "documents the action fence with the not-seen interval the store uses" red before ("README needs a ... section: expected undefined to be defined"), green after. commitChecks 573/573; format, lint, lint:strict, architecture, react-doctor, typecheck, build, build:prod, package exit 0; bun run test 7482/7488 under load (timing and git-temp-file failures), the 4 failing files pass on re-run.
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-16 -
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-17 phase-run/PLAN/w5/2
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-18 phase-run/PLAN/w5/4
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-20 phase-run/PLAN/w5/19

## Phase 2 wave 5 fix round 2 (attempt a5) - 34757824
Finding (Codex REQUIRED): a re-run between the run check and a jobs answer mixed attempts (bounded pagination and last scan page). Fix: getDetail re-reads the run after its jobs pages and re-reads the new attempt on a change; continueFailedScan checks the run after each page too and returns runChanged. Red before: "the run's attempt matches its jobs: expected 1 to be 2"; "the scan finished on the new attempt: expected 1 to be 2".
Proof: phase files 138/138; format/lint/lint:strict/arch/react-doctor/typecheck/build/build:prod/package exit 0; bun run test 7493/7493 exit 0. GitNexus detect-changes not run (no worktree index). Review pending.
Phase 4 fix round 2 (w5, fe04923b): Codex REQUIRED runHeader guard untested -> added tab test "run line stays hidden when the provider does not declare runHeader" (populated run, runHeader false). Mutation removing the guard at ChecksHeader.tsx:26 -> red "run header requires its capability: expected <span …(2)></span> to be null". Battery green: focused 11 files 342/342, format/lint/lint:strict/architecture/react-doctor/typecheck/build, test 495 files 7503/7503, build:prod, package.
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-21 -
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-22 -
- Phase 19 takeover (a7): af08b55a adds literal-key test "keeps the stored key format intelligit.ci.actionFence.v1: across releases" for the Codex REQUIRED finding (prefix untested). Red under prefix v2 mutant: "a fence stored by an earlier release must load: expected false to be true" (1/55 failed); green 55/55 unmutated. Gates: commitChecks 574/574, bun run test 7489/7489, format/lint/lint:strict/architecture/react-doctor/typecheck/build/build:prod/package exit 0. No source change.
WORKTREE 5 19: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-23 -
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-26 phase-run/PLAN/w5/4
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-27 phase-run/PLAN/w5/2
- Phase 2 takeover (wave 5): Codex REQUIRED stale old-attempt check-runs fixed at 0b1781fc on phase-run/PLAN/w5/2. getDetail reads run list, then snapshot, then jobs + run re-read; an attempt change restarts the whole read (max 3; last read complete:false). Red before: "old attempt check-runs are not third-party checks: expected [ '2000001', '2000002', '2000003' ] to deeply equal []". Phase files 142/142, full suite 7497/7497, all gates exit 0. Review pending.
WORKTREE 5 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-28 -

### Phase 4 takeover (wave 5, a7) - 778cf459
- Finding 1: 2 mutations survived the old tests (drop polls increment; drop none clause). Added 3 fake-timer tests (rung timing + fresh requestId, no-checks not re-polled, leaving Checks clears timer); all red under their mutations, green on real code.
- Finding 2: already pinned by forged current-requestId replies in two existing tests; drop repoKey check and drop hash check both red. No test added.
- Proof: focused 345/345; format, lint, lint:strict, architecture, react-doctor, typecheck, build OK; bun run test 7506/7506 (first run had 1 diffBudgets timing flake, passed alone and on rerun); build:prod, package OK; GitNexus detect-changes: 1 file, no symbols.
WORKTREE 5 4: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_e630a6e7-d51-29 -
PHASE 2: HALT review still failing after takeover
PHASE 4: MERGED w5 778cf459 72f8a6a8c40f5c39684106850380abf8afd2db85
PHASE 19: MERGED w5 af08b55ab48a52b2edd0cc3d1c746acac7d02d3f 196e5bd8fedbeb2382c366966aeeda33f94cc578
WAVE 5 2+4+19: MERGED f005d90f
PHASE 4 UNVERIFIED: Mutation H2 (`isCurrent` ignores `stopped.aborted`, src/views/ciDetailHandler.ts:62) was cut off at the 60 s cap on tests/unit/views/ciDetailHandler.test.ts, so it is neither red nor green.; verify.py gates --stage round did not run: this repo has no .claudex-gates.json, and $PROOF_CMD defines no gate for the round stage (exit 2 both times), so verify.py's own gate-gaming scan did not run. Codex ran a manual gate-gaming scan instead.; The first full proof run exited 1 on the timing test tests/unit/diff/diffBudgets.test.ts (64.2 ms against a 59 ms limit) while other runs were loading the machine. Only the failed tail was rerun (diffBudgets 4/4; bun run test 7506/7506, then build:prod and package, exit 0). The earlier gates (345 phase tests, format, lint, lint:strict, architecture, react-doctor, typecheck, build) had already passed in the first run.; Mutations not run (over the 12 cap): dropping the `unavailable` check (Codex ran it: red), dropping setAnswer(null) on invalidation, dropping the MAX_COMMIT_CHECK_RETRIES_PER_HASH bound, and dropping the isValidGitHash check in the host handler.; The E2E spec tests/e2e/ciChecksTab.spec.ts runs only on CI and was not run (Codex's list).; Real VS Code reload, restart, focus, and dock or undock moves; tests check only the message and state boundaries (Codex's list).; How the screens actually look: Figma parity, light and dark themes, narrow and wide layouts (Codex's list).; Live provider, network and cross-device changes (Codex's list).
Phase 4 reviewer's evidence:
VERDICT: ACCEPT (Codex gpt-6.1-sol, effort high, SID 01a1c26e-c88d-72b0-8843-22499ca57e75, exit 0; its -o file starts with `VERDICT: ACCEPT` and lists no findings). REVIEW_MODEL came from `python3 ~/.claude/skills/claudex-build/helpers.py review-model`, which printed gpt-6.1-sol and exited 0. HEAD is 778cf459, detached at phase-run/PLAN/w5/4.

Proof, run in my worktree:
- First run of the full proof command: exit 1. The 11 phase test files passed 345/345. format:check, lint, lint:strict, architecture:check, react-doctor, typecheck and build all passed. The full `bun run test` then had 1 failure out of 7506, in tests/unit/diff/diffBudgets.test.ts > measured diff viewer budgets > "keeps small, typical, and large measured tiers within the host targets": "large compute: expected 64.249 to be less than 59". Codex and my mutation batch were running at the same time. Phase 4 does not touch that file, and it is the same timing test the builder saw fail.
- Rerun:
  - `bun vitest run tests/unit/diff/diffBudgets.test.ts`: exit 0, 4/4 passed.
  - `bun run test && bun run build:prod && bun run package`: exit 0. Tests 7506/7506 passed across 495 files, and intelligit-0.44.0.vsix passed verifyVsixPackage (88 entries).
- `python3 ~/.claude/skills/claudex-build/verify.py gates --base 3965f37a --stage round`: exit 2, "no manifest at .claudex-gates.json and no $PROOF_CMD set". With PROOF_CMD set: exit 2, "manifest $PROOF_CMD has no gates for stage 'round'". This gate did not run (see unverified).
- `LEAN_CTX_DISABLED=1 git status --porcelain` printed nothing, after I removed my temporary node_modules link and the packaged vsix.

My mutation batch, on a copy of HEAD under a8/mut with a time cap per run. Unmutated baselines: commitChecksTab 29/29 in 6.0 s; ciDetailHandler 20/20 in 0.9 s.
- U1, drop `polls.current += 1`: RED. "each incomplete reply waits for the next rung…": expected length 2, got 3.
- U2, drop the `none` early return: RED. "a commit with no checks is not re-polled": expected length 1, got 2.
- U3, no `clearTimeout` on cleanup: RED. "review: a failed forced Refresh of pending detail is not retried automatically": expected 3 to be 2.
- U4, drop the repoKey check in the reply guard: RED. "same SHA in another repository is not reused": `not to contain 'repo-one'`.
- U5, drop the hash check: RED. "drops a detail reply for a commit that is no longer selected": `not to contain 'from-a'`.
- U6, drop the requestId check: RED. "A→B→A drops the first A reply": `not to contain 'stale-a'`.
- U7, refreshError no longer stops polling: RED. Same failed-Refresh test: expected 3 to be 2.
- U8, no cancelCommitCiDetail on tab leave: RED. "hiding the Checks tab or the pane cancels the host's re-posts…": expected [] to deeply equal [{…}].
- H1, drop the host's repo-on-screen check: RED. "ignores a request for a repository the host no longer shows": vi.fn() called 1 time.
- H2, isCurrent ignores abort: CUT OFF at 60 s (see unverified).
- H3, the scan loop retries a failed forced refresh: RED. "a failed forced Refresh of a running overflow scan is not re-read automatically": expected 1 call, got 2.
- H4, cancel stops any loop, not only its own: RED. "hiding the tab stops its loop at once; showing it again starts a new one": expected at least one call.

Every mutation the fix step claimed red came out red on my rerun: the counter step (U1), the `none` check (U2), the repository check (U4) and the commit check (U5) with the exact assertions it quoted; the timer clear (U3) failed in the failed-Refresh test. Codex also reran all five and confirmed the named assertions, and ran 12 mutations of its own, none green.

Scenarios Codex checked, each with its test: switching A→B, A→B→A and A→B→A after A rendered; out-of-order Refresh replies; the same SHA in another repository; Files then Checks; the floor provider; signed out, unreachable, cooldown, none and disabled; bounded paging; failures past 1,000 jobs; scan paused/running/stopped; tab choice persists; the pending ladder; leaving and re-entering the tab; sign in and out; the popover on an unselected row; docked and undocked Open in Checks; Open in Checks before the view is ready, after a reload and after disposal; a failed repository preference write; Refresh, hide and dispose during the overflow scan. It also wrote 4 scenario tests of its own, which passed 53/53 together with the two focused files.

Handoff dispositions (Codex):
- Polling-coverage finding: fixed, tests at commitChecksTab.integration.test.tsx:805, 830, 842.
- Repository/hash finding: fixed by the existing tests at :314 and :420.
- Selection reset and failed-Refresh recovery: fixed at useCommitCiDetail.ts:61-64, 138-143 and ciDetailHandler.ts:75.
- E2E not run locally: allowed, spec line 92 "E2E specs run on CI."
- diffBudgets timing: outside this phase's files.
- keep-warm and knip hints: out of scope.

Gate-gaming: Codex found no .only, .skip, lint or type suppressions, or weakened tests. The one react-doctor suppression is at CheckTree.tsx:67.

Dropped findings: none.
PHASE 19 UNVERIFIED: verify.py gates --stage round exited 2 twice: first with no .claudex-gates.json and no PROOF_CMD, then with PROOF_CMD set it reported no gates for stage 'round'. The full proof battery ran directly instead, and it is green.; The --stage accept gate of verify.py was not run. Its PROOF_CMD battery is the same one that ran green above.; Not run: GitNexus detect-changes (the worktree guard refuses its CLI), the R1 Fable review (outside this wrapper), and the e2e specs (they run on CI).; Not checked against real systems: VS Code activation with a real workspaceState, real provider requests, and the send path awaiting begin. Phase 8 owns the send path; this is on Codex's list too.; Mutations not run: the isFresh fenced pending-TTL check in service.ts:285 and detailService.ts:306, the persisted-read !isFenced and staleStored guards, the begin duplicate-target rejection, the resolve unsettled guard, the constructor's storageKey match check, and isFenceRecord validation. Codex inspected and scenario-tested them, but none was mutated.
Phase 19 reviewer's evidence:
VERDICT: ACCEPT. Codex (gpt-6.1-sol, high, SID 01a1c24f-ae02-77b1-bfae-54823de5f904) accepted with no findings. Its output is at /var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/w5/p19/a8/codex-out.md. No Codex finding was dropped.

Proof battery, run on HEAD af08b55a in the worktree by /var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/w5/p19/a8/gates.py, stopping at the first failure. Every step exited 0:
- `bun vitest run tests/unit/services/commitChecks tests/integration/extension/extension.integration.test.ts tests/integration/extension/view-providers.integration.test.ts`: 814/814 passed.
- format:check, lint, lint:strict, architecture:check, react-doctor, typecheck and build: all exit 0.
- `bun run test`: 491 files, 7489/7489 passed.
- build:prod: exit 0.
- package: intelligit-0.43.3.vsix, 88 files; verifyVsixPackage passed.
- `LEAN_CTX_DISABLED=1 git status --porcelain` printed nothing after I removed the node_modules symlink I had added.

verify.py:
- `verify.py gates --base 3965f37a --stage round` exited 2 with "no manifest at .claudex-gates.json and no $PROOF_CMD set".
- With PROOF_CMD set it exited 2 with "manifest $PROOF_CMD has no gates for stage 'round'".
- So the round stage has no gates in this repo. The battery above stands in for it.

My own mutations, on a scratch copy (/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/w5/p19/a8/mutate.py). Baseline: `bun vitest run tests/unit/services/commitChecks` passed 574/574 in 2.2 s, so the time cap was 60 s. All 12 mutations went red:
- M1, drop isFenced in the persistentCache set callback: red in "a fenced key is never persisted, even complete" (expected {hash 'abc1234'...} to be undefined).
- M2, the same in detailPersistentCache: red in that test.
- M3, check the fence before enqueue instead of inside it: red in "a set queued before the fence but run after it is refused".
- M4, key prefix v1: to v2: (the fix step's claimed mutation): red in "keeps the stored key format intelligit.ci.actionFence.v1: across releases" ("a fence stored by an earlier release must load: expected false to be true"). Only that 1 test failed, which matches the fix step's claim.
- M5, NOT_SEEN 10 min to 11 min: red in "timer re-armed after restart from the stored time".
- M6, runAttempt ends on any result: red, 6 tests.
- M7, GitLab job retry accepts any newer id: red in "GitLab job retry: a newer job with another logical id does not end the fence".
- M8, cancel ends only on state cancelled: red in "cancel fence ends when the target run is cancelled or complete".
- M9, resolve ignores repoKey: red in "a detail for one repository never ends the same commit's fence in another repository".
- M10, endByUserRefresh ends on any call: red in "endByUserRefresh ends a not-seen fence and does nothing before".
- M11, timer armed from activation time: red in "timer re-armed after restart".
- M12, served detail omits actionFence: red in "reopen after 8 days..." (expected undefined to deeply equal {targetId '77'...}).

Codex separately ran 12 mutations; all red, including a 7-day age deletion, lexical pipeline-id comparison and detail check-before-enqueue. Its added scenario tests passed 597/597, covering:
- restart, including after 8 days;
- a storage write failing before or after a write;
- Refresh or fail while begin is still writing;
- a fetch in flight when a fence begins or ends;
- two windows with delayed propagation;
- the same SHA in two repositories;
- a complete failure cached before the action;
- the not-seen timer during a request-gate cooldown.

Dispositions of the handoff's risks:
- Cross-window visibility, and a same-instant begin in two windows sharing one key: allowed, per the plan's out-of-scope note at PLAN.md:764, which Codex confirmed.
- No row-badge re-request on onDidEnd: allowed, because the spec makes the row badge not fence-driven ("The row badge keeps its own snapshot ladder and is not fence-driven").
- No test covers the repositoryMode.ts wiring: allowed. The spec names no such test, and the full suite covers activation.
- The README describes the Phase 8 label: allowed, because Phase 8 owns the UI.
- GitNexus detect-changes not run: carried to unverified.
Wave 5 post-merge review evidence:
VERDICT: ACCEPT (Codex, review #0, REVIEW_MODEL=gpt-6.1-sol at high effort, SID 01a1c297-8363-7500-ab17-1031cefabff1, codex rc=0, output 11570 bytes, VERDICT on the first line). Codex reported no BLOCKER or REQUIRED findings, and I dropped none.

Commands I ran on HEAD f005d90f, in the main checkout:
- `helpers.py review-model` exited 0 and returned gpt-6.1-sol.
- The proof chain stopped at `bun run test` with PROOF rc=1. These steps passed before it:
  - phase tests (`bun vitest run` on the 13 changed test files): exit 0, 436/436 passed across 13 files
  - format:check, lint, lint:strict, architecture:check, react-doctor, typecheck and build: all ok
  - `bun run test`: 1 failed, 7561 passed (7562) across 496 files
- The one failure was tests/unit/changes/changeWorkflowHost.test.ts, "root-bound selected-cha... > creates a list whose prompts stayed open while the range scan wrote". The assertion at :2696 expected [] but received ["Changelist action failed: Changelist metadata disappeared and requires review."].
  - That file is not in the wave diff: `rtk grep changeWorkflowHost|src/changes files.txt` found 0 matches.
  - It ran while Codex was also running. Rerunning it alone (`bun vitest run tests/unit/changes/changeWorkflowHost.test.ts`) passed 3 times out of 3: rc=0 each time, 146/146.
- I then ran the last two steps separately:
  - `bun run build:prod`: rc=0
  - `bun run package`: rc=1. The package was built (94 files), but verifyVsixPackage rejected 6 leftover files under output/playwright/pr321/. Git ignores them under .gitignore:3 `*.log`.
- A clean export of HEAD (git archive into a2/pkg-0, with node_modules linked) ran `build:prod` rc=0 and `package` rc=0, with "verifyVsixPackage ... passed (88 entries)".
- `verify.py gates --base 3965f37a --stage round` exited 0: lint, typecheck and format OK; GATES: GREEN warn=0.
- `git status --porcelain` lists only PLAN.review-log.md, PLAN.handoff.md and PLAN.handoff.phase-{19,2,4}.md, all allowed. The vsix the package step wrote is ignored (.gitignore:151 `*.vsix`).

Codex's evidence (full ledger in review-0/.review-scratch/REVIEW.md):
- Focused tests: 436/436 passed. Phase 1 regression tests: 87/87.
- Merge conflict check: version 0.44.0, one CHANGELOG entry per phase, all 33 existing E2E specs kept and the new one added (34). Locale keys match across all 12 webview and 12 host dictionaries.
- Mutations: 12 of 12 went red. Every run used the perl wrapper with a 60 s cap, and every restore was checked with `diff` (exit 0):
  - M01 prefix v1->v2: red, "keeps the stored key format across releases"
  - M02 ten->eleven minutes: red, "timer re-armed after restart from the stored time"
  - M03 attempt > to >=: red, "a fenced key is never persisted, even complete"
  - M04 logical-job equality removed: red, "a newer job with another logical id does not end the fence"
  - M05 repository ownership removed: red, "a detail for one repository never ends another repository"
  - M06 resolve while begin is unsettled: red, "a detail fetched while the fence is still being written does not end it"
  - M07 restart timer from activation: red, the same timer test as M02
  - M08 fenced snapshot persistence allowed: red, "a fenced key is never persisted"
  - M09 fenced detail persistence allowed: red, the same test as M08
  - M10 stale request ID accepted: red, "A->B->A drops the first A reply"
  - M11 reply repository ignored: red, "same SHA in another repository is not reused"
  - M12 reply hash ignored: red, "drops a detail reply no longer selected"
- Scenarios Codex marked fine: A->B->A; reversed and forged replies; leaving and re-entering the tab; hide followed by a pre-hide reply; the pending ladder and its stop; Refresh failing and then recovering; the reloaded tab preference; failures before and after the preference write; Open in Checks from the popover, graph and undocked views; fence write failure before and after storage; a slow begin racing Refresh and fail; restart after 8 days; activation with a persisted workspaceState key; two-window fences; timer restart. Each names a test Codex ran.
- Handoff dispositions:
  - f005d90f fixes a real gap in the test fake, not a masked defect: Memento.keys() exists in @types/vscode index.d.ts:8561.
  - Cross-window visibility and simultaneous begins are allowed by PLAN.md:764.
  - No UI or write calls in Phase 19 is allowed by "No UI and no write calls"; Phase 8 owns them.
  - The graph and undocked sender is deferred to Phase 13.
WAVE 5 2+4+19: CLOSED accepted 4+19; halted 2
PHASE 4: ACCEPTED f005d90f, VERIFICATION INCOMPLETE
PHASE 19: ACCEPTED f005d90f, VERIFICATION INCOMPLETE
- 2026-11-10 owner answer after wave 5: Phase 2 option A, retry from w5/2 0b1781fc fixing only re-review #3's two REQUIRED findings with the named cause fix (all three reads cross-checked; served() keeps provider incomplete).
WAVE 6 2+15: OPEN base 3965f37aa571e64478b840b9de033accf816499d
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-3 phase-run/PLAN/w6/2
WORKTREE 6 15: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-4 phase-run/PLAN/w6/15
- 2026-11-10 Phase 15 (wave 6): HALT before build. Base 3965f37a lacks Phase 4 (accepted f005d90f; 36 webview files incl. ChecksTab and CommitList/CommitRow/CommitListRows edits). Phase 15 depends on 4 (click opens Checks tab). Needs relaunch on f005d90f. No commit on phase-run/PLAN/w6/15.
PHASE 15: HALT Phase 15 depends on Phase 4, but wave 6 started it from 3965f37a, which comes before Phase 4 (accepted at f005d90f). Option A: restart Phase 15 from f005d90f, the checkout's current HEAD, so the CI column can open the Checks tab and is built on Phase 4's versions of CommitList, CommitRow and CommitListRows. I recommend A. Option B: build on 3965f37a without the click-to-Checks-tab deliverable. B drops one of the plan's promises and will probably conflict with Phase 4 when merged. Which do you want?

### Phase 2: built, review pending (wave 6, owner fix round after Codex re-review #3), commit cf86c5b7f8c4647ab5e2ff4aab8c557a54c66d9e
- Resumed from phase-run/PLAN/w5/2 at 0b1781fc on phase-run/PLAN/w6/2; no rebuild. Scope: the two REQUIRED findings of Codex re-review #3 only.
- Finding 1 (githubProvider.ts readDetail): a read counts only when the run's attempt is unchanged, every job's run_attempt equals the run's attempt, and every job's checkRunId is among the raw snapshot check-run ids (taken before the CI/CD filter). A mismatch restarts the whole read, snapshot included, within DETAIL_MAX_READS = 3; the last mismatched read returns complete:false and is never persisted. fetchSnapshot now also returns the raw check-run id set. No reliance on the check-runs filter=latest default.
- Finding 2 (detailService.ts served): complete = provider complete AND no unfinished scan work.
- RED before the fix: "attempt 2 with attempt 1's jobs is not complete: expected true to be false"; "attempt 1's check run is not a third-party check: expected [ { id: '2000001', …(5) } ] to deeply equal []"; "a mismatched last read is never complete: expected true to be false"; "the scan never overrides the provider's incomplete: expected {...} to match object { complete: false, outcome: 'failure' }"; "served with its scan attached: expected true to be false".
- GREEN: githubDetail + detailService 87/87. Mutations on copy mut-build-1 (control 87 passed), all red: drop job attempt check (red on attempt-2 test); drop membership (red on lagging-snapshot tests); strict membership/attempt without the undefined skip (red on "a job that names no attempt or check run does not hold the read open"); empty check-run id set (5 red); served ignores provider complete (both detailService tests red).
- Gates (verify.py, base 3965f37a, stage accept): format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test (494 files, 7501/7501), build:prod, package all OK; GATES: GREEN warn=0. Pre-commit hook passed.
- GitNexus: impact before edit: served CRITICAL (callers inside detailService and the coordinator's getDetail flow), readDetail LOW, fetchSnapshot UNKNOWN (text search: getChecks, readDetail). detect-changes --scope all: 4 files, 35 symbols, risk critical, not partial, not truncated.
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-6 -
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-7 phase-run/PLAN/w6/2

### Phase 2 fix round 1 (wave 6, after the review of cf86c5b7), commit 48f0f73fe026d9246bdeacc392b6f9756d4ba05c
- Finding 1 (continueFailedScan): a scan page whose jobs carry an attempt other than the cursor's is discarded; the scan stops with "Remote data changed. Reload and try again." (existing translated string), found items and cursor kept; Refresh re-reads the page. Chosen over runChanged, which loops without bound if GitHub keeps answering the old attempt.
- Finding 2 (readDetail): a job missing from the ref snapshot on a commit with >= 1000 check suites (GitHub's documented ref limit) is looked up in its own suite; found there, execution stays complete and otherChecksCoverage = pageBound (one read per fetch, settlement unknown, never persisted). Otherwise the restart rule stands.
- RED before fix: "every job finished: execution is complete: expected false to be true"; "expected 'done' to be 'stopped'".
- Mutations on mut-fix-1, all red with named assertions: no page attempt check; suite membership ignored; coverage gap dropped; suite lookup below the limit (2 lag tests); suite never consulted.
- Fixtures: three re-run scan tests now give attempt-2 jobs run_attempt 2.
- Gates: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test (494 files, 7504/7504), build:prod, package: exit 0. Pre-commit passed.
- GitNexus: readDetail LOW, refAtSuiteLimit LOW, continueFailedScan UNKNOWN (text: coordinator.ts:198). detect-changes: 2 files, 26 symbols, risk medium.
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-8 -
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-9 phase-run/PLAN/w6/2
- Phase 2 fix round 2 (wave 6, 91e3e853): suite count read on every detail read; at >=1000 suites otherChecksCoverage is pageBound and the detail is never saved, even with every job present (finding 1, red before fix: "older suites' third-party checks may be hidden: expected 'full' to deeply equal { reason: 'pageBound', shown: +0 }"). Tests at exactly 1000, 1001 and 999 suites (finding 2; the >= to > mutation is now red). 4 mutations red. Gates exit 0, 7508/7508 tests. GitNexus detect-changes risk low.
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-10 -
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-13 phase-run/PLAN/w6/2
- Phase 2 takeover (wave 6, Opus): 3 open findings fixed test-first on 91e3e853 -> 5fa266ea. F1 stale-requester test now proves the L1-hit scan resume (mutation red: "an L1 hit restarts the scan its stale requester left"). F2 scan cursor attempt now from the single-run read, so disagreeing endpoints stop the scan instead of refetching without bound (red before fix: "expected 5 to be less than or equal to 2"). F3 production cooldownEnd wiring tested with a 429 scan page (mutation red: "a rate-limited page pauses the scan, never stops it"). Gates exit 0, 7510/7510 tests. Plan amendment recorded in the handoff.
WORKTREE 6 2: /Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/wf_6520a50b-6ef-14 -
PHASE 2: HALT review still failing after takeover
WAVE 6 2+15: CLOSED accepted -; halted 2+15
2026-11-10 owner answer after wave 6: Phase 2 option A, one last round with a stop rule (PLAN.md Phase 2 owner amendment). Phase 2 restarts from f005d90f by merging phase-run/PLAN/w6/2 (5fa266ea); width 1, Phase 15 held for the owner.

## Phase 2: built, review pending (owner last round, wave 7) - commits 64d390b0, 3d1b6d85
- Started at f005d90f47f5a45cb30e5a31cc19f8e1b96e51d6; review range f005d90f..3d1b6d85 (2cdbaaf8 is the owner's docs-only amendment).
- 64d390b0 merges phase-run/PLAN/w6/2 (5fa266ea) with --no-ff; conflicts kept both sides (l10n, review CSV, one 0.44.0 bump, detailService fences plus scans).
- 3d1b6d85 owner amendment item 1: a read that disagrees on the attempt shows only the run's own attempt's jobs, starts no overflow scan (failedScan stopped, "Remote data changed. Reload and try again."), stays complete: false; cursors carry the run's attempt; flat checks exclude every read job's check run. Item 2: completion.test.ts pending flat-check guard test.
- Red before fix: "no attempt-2 job is shown under attempt 1: expected [ 'job 1050' ]"; flat check assertion red with [ 'unit tests 999' ]. Mutations 5 of 5 red on named assertions (one also hangs the whole file through the restart loop it creates).
- Gate G on a clean git archive copy of 3d1b6d85 (TMPDIR sibling): exit 0, 500 files / 7641 tests. In the main checkout `bun run test` gives 7640/7641, localization.test.ts:352 timing out (vsce ls walks ~100 leftover worktrees under .claude/worktrees).
- GitNexus: impact readDetail LOW (1 caller); detect-changes high from review-log markdown sections, code symbol readDetail only.

## Phase 2 fix round 1 after Codex review of 3d1b6d85 (Opus builder) - commit daf653e3
- Findings: (1) detailService.ts:637/589 an attempt-mismatched scan page left the detail complete and Refresh resumed the saved cursor; (2) detailService.ts:464 restartWithNewRun refetched without bound when the run changed before every page.
- Fix: a page or run check naming another attempt returns `{ runChanged: true, error }`; the service stops that scan with "Remote data changed. Reload and try again.", marks it remoteChanged (served complete: false; carryScans never resumes it, so the next read starts at page 11). restartWithNewRun removed; no automatic refetch.
- Red before: "no read restarts without bound: expected "vi.fn()" to be called 1 times, but got 6 times"; "an attempt-mismatched scan stays incomplete: expected true to be false"; "Refresh starts the stopped scan from scratch: expected [ 12, ..., 20 ] to deeply equal [ Array(10) ]".
- Mutations mut-2-fix-2..4 each red on a named assertion. Three tests that encoded the automatic restart rewritten to stop + Refresh.
- Gate G on a working-tree copy (git init, TMPDIR=/tmp/p2f1.1Fy4): exit 0; 500 files / 7642 tests; vsix 88 entries verified.

## Phase 2 fix round 2 after the Codex review of daf653e3 (Opus builder) - commit 16b8c295
- Finding (Codex REQUIRED, detailService.ts:545): a repeated allowed overflow next URL made the scan request the same page without end. Fixed in the provider's continuation guard: the in-memory scan cursor carries `read`; continueFailedScan refuses a next link back to the current or any earlier scan page with "The provider's next-page link was refused.", keeping the jobs found; Refresh resumes at that page with one request.
- Red before fix: `loop 11->11 reads each page once: expected [ Array(15) ] to deeply equal [ 11 ]`. Mutations mut-2-fix-5 / -6 red on `loop 11->11 ...` / `loop 13->12 reads each page once`.
- Gate G on a copy: format:check..build green; test 7642/7643 (operationBenchmark git temp-file error, environment; rerun 12/12 green); build:prod, package green (88 entries). detect-changes: low, 0 processes.
- Decision: guard in the provider, refused-link contract (complete unchanged), not a detailService visited set (no l10n there). Follow-up: total page cap from total_count.

### Phase 2 Opus takeover - commit e1176e56
- Finding: Codex REQUIRED githubProvider.ts:419, a respelt next link (fragment alias) re-read an already-read page without bound.
- Fix: pages compared by the URL Node requests (fragment dropped); the cursor carries jobsRead and a next link is refused once jobsRead reaches the page's total_count, when the page held no jobs, or when total_count is missing. Covers query-param aliases too (Fable's diagnosis).
- Red before fix: `fragment alias reads a bounded set of pages: expected [ 11, 11, 11, 11, 11, 11, 11, …(43) ] to deeply equal [ 11 ]`.
- Mutations (mut-2-takeover-1): raw compare, no total bound, no empty-page rule, no jobsRead carry: each red on a named case.
- Gate G on a working-tree copy: exit 0, 500/500 files, 7644/7644 tests, 88-entry vsix verified; pre-commit hook passed.
PHASE 2: HALT review still failing after takeover
2026-11-10 owner answer after wave 7: Phase 2 option A, one narrow round for the githubProvider.ts:434 growing-total finding (PLAN.md Phase 2 owner amendment item 4); width 1, Phase 15 held.

## Phase 2: built, review pending (owner amendment item 4, narrow round, Opus builder) - commit 392fdf68
- Change: the overflow scan's job budget (`jobsTotal`) is fixed in the scan cursor when the scan starts: the first `total_count` in the first 1 000, else the first scan page's; no later page, continuation, cooldown resume or Refresh raises it; a missing budget still refuses the next link. Files: githubProvider.ts, types.ts, githubDetail.test.ts.
- Test first: "a total_count that grows on every response never raises the scan's job budget" red before fix (53+ overflow requests vs 10), green after; two cases (first read total; first scan page total).
- Mutations (copy mut-2-build-5): 4/4 red on named assertions (fresh total wins; getDetail drops budget; next cursor drops budget; last-instead-of-first total).
- Gates: chain green except 9 load timeouts in 8 unrelated files under `bun run test`, all green on rerun alone (228/228); build:prod + package 88 entries verified; pre-commit hook passed.
- Review range: 336ff8fd..392fdf68. Not run here: Codex review, fix routing, seal, final verifier (the workflow runs them).

## Phase 2 fix round 1 after the Codex review of 392fdf68 (Opus builder) - commit ee59d01f
- Finding (githubProvider.ts:443): a first scan page that stops on its refused next link dropped the job budget it read, so Refresh read a larger later total (10 requests, 1 expected).
- Fix: the stopping return carries `next` = the same cursor with `jobsTotal` saved; detailService's applyPage keeps it as the stopped scan's cursor, which Refresh carries.
- Regression test "the first scan total is retained even when that page refuses its next link" red before: `Refresh must retain the first scan's 1100-job budget: expected [ Array(10) ] to deeply equal [ 11 ]`; green after. Three mutations red on named assertions.
- Chain: focused 117/117; format, lint, lint:strict, architecture, react-doctor, typecheck, build passed; bun run test 7645/7646 (operationBenchmark git-add temp-file flake, green alone); build:prod and package passed (88 entries). Review pending.

### Phase 2 fix round 2 of owner amendment item 4 (Opus builder) - commit 018dbbb5
- Finding (Codex REQUIRED, githubProvider.ts:432): the first scan job budget was lost when the scan stopped on a malformed Link, a failed post-page run check, or paused on a post-page cooldown.
- Fix: continueFailedScan reads the budget right after the page answers and returns the same page's cursor with `jobsTotal` in every stop or pause that keeps the scan; types.ts lets the `{error}` and `{pausedUntil}` results carry `next`; detailService saves `next` on a pause and on an error-only page.
- Red before fix (githubDetail, 3 cases from Codex's probes): `<case>: the resumed scan must retain the first 1100-job budget: expected [ Array(10) ] to deeply equal [ 11 ]` for malformed Link, post-page run read fails, post-page cooldown. Green after.
- Mutations (copy mut-2-fix-2), all red on that named assertion: catch error drops next; cooldown drops next; paused branch ignores next; budget read after the post-page check.
- Proof chain exit 0 in one run: focused 120/120, format..build passed, `bun run test` 7649/7649, build:prod + package passed (88 entries). Review pending.

### Phase 2 Opus takeover of amendment item 4 (missing first total) - commit d41b4585
- Finding (Codex REQUIRED, githubProvider.ts:403): a missing first scan total could become a larger budget on Refresh (ten page-11 reads instead of one).
- Fix: `CiFailedScanCursor.jobsTotal` may be `null` = first scan page read, no total; continueFailedScan reads a total only while `undefined` and stores `?? null`, so kept() carries the marker through Refresh, resumes and stops.
- Red before fix: `a missing first total still refuses the next link after Refresh: expected [ Array(10) ] to deeply equal [ 11 ]` (githubDetail "a missing first scan total cannot become a larger budget on Refresh", from Codex's probe).
- Mutations (mut-2-takeover-1): re-read of null -> red on that line; no marker -> red `a missing first total refuses the next link`; `=== null` -> `=== undefined` equivalent (null coerces to 0).
- Proof: `bun vitest run githubDetail paginate httpMeta detailService && bun run format:check && ... && bun run package` exit 0; focused 121/121, full 7650/7650, package 88 entries.
PHASE 2: HALT review still failing after takeover
- Owner answer after wave 8 (2026-11-10, Root note): option A with a cap. Plan amendment item 5: a stale scan page hands its frozen budget (number or `null` marker) to a cursor that has none; its jobs stay unpublished. Last round on the budget rule; any further budget-path finding goes under Follow-ups unless it makes requests without bound.

## Phase 2 lifted onto Phase 1's PR branch (feat/396-ci-checks-phase-2, base feat/395-ci-checks-phase-1)
- Lift: Phase 2's net diff (2cdbaaf8..3d70e160) applied on Phase 1's PR tip 41d17bbc as 064c7d4b; Phase 19 action-fence code dropped; Phase 1's later L2-read block kept (join a running fetch; a newer L1 entry served only when fresh and servable, now through `served()` with `startScans`). Ported #414 fixes: cubic 4528524761, 4528716134.

### Phase 2 amendment item 5 (Root, test first) and its narrow Codex round
- Change: `detailService.ts` runScan, the dropped-page branch: when the cursor has no `jobsTotal`, it takes the dropped page's `next.jobsTotal` (number or `null`); the page's jobs are not published and the cursor's url/read/jobsRead stay.
- Red before fix (githubDetail, real GitHubProvider + CommitChecksCoordinator + CiGenerations): `same scan retains its first missing budget after a lifecycle interruption: expected [ Array(10) ] to deeply equal [ 11 ]`. Green after.
- Codex round (review model gpt-6.1-sol, effort high, thread 01a1c6ba-561d-7932-bfd2-073740be3001): VERDICT: ACCEPT. Focused suites 113/113. Mutations: remove assignment, flip `=== undefined`, ignore `null` marker each red on the line above; "move the cursor to page.next wholesale" stayed green.
- [MINOR] githubDetail.test.ts:1545, the suites miss a dropped page advancing the cursor wholesale. Disposition: fixed. The test is now two cases; the new one ("a scan page dropped by a lifecycle bump never moves the scan to its next link") gives the first scan page a total so its `next` is a real onward link. Wholesale mutant red: `the cursor never moves to the dropped page's next link: expected '...page=11&nonce=1' to be '...page=11'`. Remove-assignment mutant still red on the budget line. Focused 111/111 (githubDetail + detailService).
- Codex's probes also confirmed the lift: L2-race `newer.data` and missing `startScans` mutants red; applyPage, carryScans and served unchanged by the lift.
BLOCKER 2026-11-11: the dry run's next wave is Phase 2, but Phase 2 was finished by hand and merged as #415 (bfea9112); owner chose option A: record it accepted (checklist B).
PHASE 2: ACCEPTED bfea9112

## Phase 3 — GitLab pipelines and jobs detail (builder round, 2026-11-11)
Phase 3: built, review pending
- Commit bd0477d7 on feat/397-ci-checks-phase-3. Started at bfea91127a0669ea2d1311d7dca28550cf8973f3 as handed over; the branch HEAD was 05085924 (main had moved on by #417, #418, a6c74239 and the docs commit 05085924), so the review range is 05085924..bd0477d7.
- Built test first: gitlabDetail.test.ts (21 cases) plus capabilities, detailService (contract version 3) and commitChecksProviders (GitLab gate) updates; all red for missing behaviour before the code (24 failed), green after.
- Mutations on copy mut-3-build-1, 14 of 14 red, each on its named test: drop stage grouping; header from the list; stop after page 1 (re-run alone: "pages jobs by x-next-page" expected length 150 got 100); per_page dropped on pipelines; no skip of listed ids; scan skipped; rethrow; steps true; any next link allowed; 403 pauses; no run check; no budget; statuses keep jobs; no x-next-page validation. Restored copy green.
- Gate L for "Malformed x-next-page header." passed (sync, CSV rows filled, import, validate, audit 0 missing).
- Proof chain on bd0477d7: focused 167/167; format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build passed; `bun run test` 7733/7741, the 8 failures all in tests/webview/unit/commit-list-column-resize.test.tsx (`localStorage.clear` on undefined under Node v26.5.0), the same failure on the base tree 05085924 run alone; build:prod and package passed (88 entries). Tree clean.
- Not run: GitNexus impact / detect-changes (no MCP; the worktree guard refuses commands naming .gitnexus); Codex review, seal and final verifier (run by the workflow).

### Phase 3 fix round 1 (b67e21cf)
- F1 missing x-total: scan with jobsTotal null now follows rising next pages. Test gitlabDetail.test.ts "a scan whose pages name no x-total still reads every failed page"; red before: "no total header is no next-link refusal: expected { state: 'stopped', found: 100 } to deeply equal { state: 'done', found: 101 }". Mutation (restore `jobsTotal === null ||`) -> red on that assertion.
- F2 retry between pages: cursor `runVersion` = pipeline updated_at, compared in runChanged (before and after each page) and in carryScans. Tests "a pipeline retried and failed again between scan pages never mixes old and new jobs" (red before: "the status stayed failed across the retry: expected 'done' to be 'stopped'") and "a refresh after the pipeline was retried rescans instead of keeping the old attempt's jobs" (red before: "the old attempt's failed jobs are not carried: expected [ 1001, ... ] to deeply equal []"). Mutations (drop the updated_at compare; drop the carryScans compare) -> each red on its assertion.
- F3 otherChecks duplicates: served() drops flat checks keyed source:id matching a found job (check-run:<checkRunId>, or status:<job id> without a check run). Test "a status whose job the scan finds past the bound leaves other checks"; red before: "this status belongs to the job the scan found: expected [ '1050', '9001' ] to deeply equal [ '9001' ]". Mutation (no status key) -> red.
- Reviewer file review-3-0 gitlabReview.test.ts on the fixed tree: 24/26 pass; still red: "a completed external retry..." and "a retry that fails between scan pages..." because their fakes never change the pipeline record (and the first passes a cursor with no recorded identity).
- F4 GitNexus: not run; no MCP, and the worktree guard refuses commands naming .gitnexus. Substitute text search of callers recorded in the handoff. HALT for Root or owner.
- Proof: phase tests (gitlabDetail, detailService, capabilities, commitChecksProviders) 82/82; format, lint, lint:strict, architecture, react-doctor, typecheck, build exit 0; bun run test 7737/7745 (8 = commit-list-column-resize.test.tsx, red on base); build:prod, package exit 0 (88 entries).
PHASE 3: HALT The plan's 'Every phase' rule (PLAN.phase-3.md:844) requires GitNexus impact analysis on the symbols this phase changed. It cannot run in this isolated worktree: this session has no GitNexus tools, and the worktree guard refuses every command that names .gitnexus or gitnexus. The symbols are GitLabProvider, CiFailedScanCursor, served, carryScans and the commitChecksProviders wiring. As a stand-in, a text search found these callers: served has 6 call sites in detailService.ts, carryScans has 1, continueFailedScan is called from coordinator.ts:231, and CiFailedScanCursor is used in types.ts, detailService.ts, githubProvider.ts and gitlabProvider.ts. Should Root run `node .gitnexus/run.cjs analyze --index-only` and then `node .gitnexus/run.cjs impact <symbol> --direction upstream --repo .` from the main checkout (the index is behind HEAD at 64d390b), or does the owner waive this rule for Phase 3?

### Phase 3 builder rerun after the owner's GitNexus answer (2026-11-11)
Phase 3: built, review pending
- Not rebuilt: the handoff already recorded Phase 3 built and review pending with bd0477d7 and b67e21cf on HEAD 33c1ec9f; the GitNexus halt is answered ("A: use old map").
- Deterministic chain rerun on HEAD 33c1ec9f: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0; `bun run test` 7737/7745, the 8 failures all tests/webview/unit/commit-list-column-resize.test.tsx (`localStorage` under Node v26.5.0), red on base 05085924 too; `git diff --stat 05085924 HEAD -- tests/webview src/webview` is empty.

## Phase 3: fix round 2 (review-3-0 findings), 2026-11-11
- Commit 00e2e744. Finding 1: `served()` matches a found job to `status:<job id>` only for GitLab. Finding 2: carryScans refuses a GitLab cursor with no `runVersion`; continueFailedScan compares `updated_at` unconditionally.
- Red before the fix: "GitHub status contexts and job ids are separate identities: expected [] to deeply equal [ { id: '1050', ... } ]"; "unknown version must not reuse old-attempt jobs: expected [ { id: '1001', …(8) }, …(49) ] to deeply equal []"; "expected { failed: [ { id: '1', …(8) }, …(2) ] } to deeply equal { runChanged: true, …(1) }". All green after.
- Mutations (copies mut-3-fix-1..4): each of 4 single mutations turned exactly its named test red.
- Chain: every step exit 0 except `bun run test`, 7740/7748, the 8 failures all in tests/webview/unit/commit-list-column-resize.test.tsx (`localStorage` under Node v26.5.0), red on base 05085924 too.
- Phase 3: built, review pending.

### Phase 3 fix round 3 (review-3-1 findings), commit dc255fb6
- F1 retry during ordinary job pagination: getDetail reads jobs first, then the pipeline header, and compares header status and updated_at with the list entry (a field the list omits is not compared); a difference returns complete: false. Test "a pipeline retried (green | failed again | green, no update time) while its jobs are paged is never a settled tree"; red before: "a tree mixing two attempts is read again, never settled: expected true to be false". Cursor runVersion = list updated_at.
- F2 missing retry identity: a scan whose cursor has no runVersion ends {failed, error: "This pipeline has no update time, so a retry during the scan cannot be ruled out."} (stopped, found jobs kept). Test "a scan with no update time to compare ends stopped, never done"; red before: "expected { state: 'done', found: 250 } to deeply equal { state: 'stopped', found: 250, …(1) }". Gate L: sync, 11 CSV cells, import, validate, audit 0 missing.
- F3: test split into "retried before a scan page..." and "retried during a scan page discards the page it read" (asserts scanPages [1] and the retry happened). Reviewer M4 replayed on a copy: RED "the page itself was requested: expected [] to deeply equal [ 1 ]".
- Added test "a pipeline list entry without status or update time is not taken for a retry" after the reviewer's self-hosted probe went red on the first F1 fix (red: "expected false to be true").
- Mutations on mut-3-fix-2, each red on its own assertion: drop complete:false (3 cases), drop status clause (no-update-time case), drop version clause (failed-again case), compare a missing list status (list-entry test), done without version (F2 test), M4, drop second runChanged (during test). Reviewer probes (6) replayed on the fixed tree: 6 passed.
- Proof: format:check (after prettier --write), lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0; test 7746/7754, the 8 failures all commit-list-column-resize.test.tsx (localStorage under Node v26.5.0, red on base 05085924). Pre-commit hook passed.

### Phase 3 takeover (review-3-2), commit 1b24388d
- Finding: a version-less pipeline that fails, is retried and fails again while its jobs are paged was saved as settled with mixed attempts.
- Fix: GitLab getDetail returns `sessionOnly: true` when the jobs took more than one page and the list entry has no `updated_at`; detailService deletes the saved key instead of saving. In-session the tree stays complete (no 30 s polling); a restart reads it again.
- Red before the fix: "a tree that may mix two attempts is read again after a restart: expected "vi.fn()" to be called 1 times, but got 0 times". Controls: one-page version-less read and multi-page versioned read are still saved; a session-only read drops an earlier save.
- Mutations on mut-3-takeover-1: baseline 37/37 green; M1-M5 each red on its own assertion.
- Reviewer probe file: 7/8 pass unchanged; codexProbe.test.ts:311 asserts the restored tree keeps 100 old-attempt jobs (true only while the bug exists); with it asserting the fresh 150 new jobs, 8/8 pass.
- Proof: each step of the chain exit 0 except `bun run test` (7750/7758; the 8 failures are commit-list-column-resize.test.tsx, no localStorage under Node v26.5.0, recorded red on base 05085924).
PHASE 3: HALT review still failing after takeover

### Phase 3 hand fixes after the takeover halt (owner chose C), commits e59cf746 and 15a47c9d
- Finding 1 (detailService persist): a failed session-only delete now blocks the saved key. Red before: "a failed session-only deletion must block the stale saved copy after eviction: expected "vi.fn()" to be called 1 times, but got 0 times".
- Finding 2 (gitlabProvider readDetail): job statuses of a pipeline cut at the job bound are matched by `pipeline_id` (Entities::CommitStatus) and kept out of otherChecks. Red before: "statuses of the pipeline's own jobs past the bound must not become other checks: expected [ Array(5) ] to deeply equal []". Opposite direction: statuses of another pipeline, of none, or posted to a fully listed pipeline stay other checks.
- Codex (gpt-6.1-sol high, fresh session, scratch copy) on e59cf746: VERDICT: ACCEPT, no required findings.
- R1 (Fable) on 2490ec17..e59cf746: (1) a failed drop on an ordinary forced refresh served the old settled copy after the TTL; fixed, every failed persistent write blocks the key; (2) a mutation preferring the header version for the scan cursor survived; test added; (3) listed pipeline ids went into request paths unencoded; fixed with encodeURIComponent. All in 15a47c9d.
- Mutations, each red on its own assertion: no block; block only for session-only; job status to otherChecks; external swallowed on a cut pipeline; hide statuses of any listed pipeline; header version first; unencoded jobs URL.
BLOCKER 2026-11-11: Phase 3 review still failing after takeover (log :812); owner chose C ("Yeah I pick C too"): two findings fixed by hand, Codex ACCEPT on e59cf746 (checklist B).
PHASE 3: ACCEPTED 15a47c9d

## Phase 5: built, review pending
- Builder: Opus (phase-builder lane, no Agent tool), test-first. Planned base 15a47c9d68fbe1646bfe02e50752f00d5d7a2709 (pre-squash Phase 3 branch, not an ancestor); actual base 650a69197efe60b4c2dae7a2b1868e7162ccd58f, so review 650a6919..HEAD.
- Scope: new src/services/commitChecks/etagStore.ts; http.ts conditional path on createHttpGetJsonWithMeta; requestGate.ts gatedFetchWithMeta forwards the store; githubProvider.ts and gitlabProvider.ts pass it for commits whose last snapshot or detail read was incomplete; commitChecksProviders.ts gains `generations`; repositoryMode.ts passes ciGenerations; 0.43.7, CHANGELOG, README. coordinator.ts and detailService.ts untouched (delivery lead's limit).
- RED first: 12 of the new httpEtag.test.ts tests failed before the http and provider code existed.
- Mutations on copies mut-5-build-<n> (httpEtag.test.ts, alarm 60 s, baseline 1 s, 18/18 green), all red:
  1 304 returns {} -> "304 returns stored body" (+6 more); 2 throw on body-less 304 -> "304 without stored body re-requests", "re-requests a body-less 304 only once"; 3 observer skips 304 -> "304 headers reach the gate"; 4 forCommit always returns the store -> "complete requests do not use the store" (+3); 5 key = URL only -> "a new auth generation does not reuse the body" (+2); 6 pagination not stored -> "multi-page 200 then header-minimal 304 → coverage unchanged"; 7 LRU cap 501 and 8 get() not refreshing LRU -> "keeps the 500 most recently used entries"; 9 shared parsed body -> "a 304 hands out a fresh copy" and "multi-page check runs polled with 304s are never counted twice"; 10 key taken at response time -> "a body read under an old auth generation is never offered under the new one"; 11-14 noteCommit always complete (GitHub snapshot, GitHub detail, GitLab snapshot, GitLab detail) -> the matching provider test; 15 gate drops the store -> 6 tests; 16 noteCommit never complete -> "complete requests do not use the store", "a commit that finishes stops using the store".
- Full-suite finding fixed: view-providers.integration.test.ts mocked only createHttpGetJson, so conditional polls of "none" snapshots (incomplete by isCompleteSnapshot) went to the real https path and its 28-request count saw 24; the mock now routes createHttpGetJsonWithMeta through the same spy (167/167 green).
- Pre-existing reds kept out of scope (handoff): commit-list-column-resize.test.tsx (Node v26 localStorage), tsconfigCoverage.test.ts and screenshotComparatorMeta.test.ts (worktree node_modules).
- Proof chain (each step run on its own): format:check 0 (after prettier --write on 4 files), lint 0, lint:strict 0, architecture:check 0, react-doctor 0, typecheck 0, build 0, test 1 (Test Files 3 failed | 501 passed (504), Tests 10 failed | 7773 passed (7783); all 10 in the three pre-existing files: commit-list-column-resize (localStorage under Node v26.5.0), tsconfigCoverage (worktree node_modules has no typescript CLI; `bun run typecheck:tests` on the same tsconfig is green), screenshotComparatorMeta (worktree node_modules has no @playwright/test)), build:prod 0, package 0. After the format fix: lint, lint:strict, typecheck 0; httpEtag + commitChecksProviders + view-providers 188/188.
- GitNexus detect_changes not run (index stale, owner's "A: use old map"); impact run recorded in 650a6919.

## Phase 5: fix round 1 (2026-11-11)
- Cleared all 5 Codex findings test-first in httpEtag.test.ts; each new test was red before the fix and green after:
  - F1 queued old-token request: red "the old token's etag is not sent: expected 'W/"old"' to be undefined". Fix: entry records `requestHash` (SHA-256 of request headers); a mismatch is a miss.
  - F2 GitLab token changed by another window: red "expected [ { …(2) } ] to deeply equal []". Same fix.
  - F3 body-less-304 re-request bypassed the gate: cooldown test and budget test red "promise resolved … instead of rejecting". Fix: `gatedFetchWithMeta` = `recoverBodylessNotModified` over a gated `createConditionalRequest`; the re-request is admitted and counted on its own.
  - F4 Bitbucket Cloud/Server not conditional: red "expected [] to deeply equal [ Array(1) ]" (both). Fix: both providers take `fetchWithMeta` + `etags`, conditional for incomplete commits.
  - F5 re-request kept a caller's If-None-Match: red "the re-request must be unconditional: expected [ 'if-none-match' ] to deeply equal []". Fix: strip it case-insensitively.
- Mutations on a copy (mut-5-fix-1): 5 of 5 red, each naming its finding's test.
- Codex scratch test "bodyless-304 retries count against the fallback request budget" cannot pass with honest counting (expects 300 two-request reads under a 300 budget); replaced by 150 reads OK, read 151 refused with 429.
- Proof chain: every step exits 0 except `bun run test` (7782 of 7790 pass; the 8 failures are all commit-list-column-resize.test.tsx under Node v26.5.0, pre-existing).
- GitNexus detect-changes not run: no .gitnexus/run.cjs in this worktree and the index is stale (owner "A: use old map").

## Phase 5: fix round 2 (2026-11-11)
- One finding (gitlabProvider.ts:407, `if (!listedVersion) sessionOnly = true` and the inverted gitlabDetail test): rejected, no code change.
  - Origin: PR #419's last commit "fix: a GitLab pipeline with no update time is never saved, even on one job page" (from the PR #419 review), squash-merged to main as c246d0d4 (`git branch -a --contains c246d0d4` -> origin/main).
  - `git diff 650a6919 HEAD` is empty for gitlabDetail.test.ts and paginate.ts and does not touch the rule; `git diff 15a47c9d 650a6919` is exactly that rule plus the test, so the 15a47c9d base charges Phase 3's squash to Phase 5.
  - Codex's scratch test run on a copy of 650a6919 (base5-fix-2): red "Phase 5 must preserve completed single-page cache eligibility (K10, additive review gate): expected true not to be true", the same line as at HEAD, so it predates Phase 5.
  - Reverting would undo an owner-accepted correctness fix (a mixed-attempt tree saved for a restart) and would be a non-additive Phase 3 change inside Phase 5 (K10).
- Review Phase 5 as 650a6919..HEAD.
- Proof chain (each step separately): all exit 0 except `bun run test` (7782 of 7790; the 8 failures are all commit-list-column-resize.test.tsx under Node v26.5.0, pre-existing, same as round 1).

## Phase 5 takeover (claudex-build Step 4), 2026-11-12
- Findings: 3 test gaps (per-commit store scoping; parse before store; 304 pagination headers). All three are over correct code; tests only, no source change.
- Added to tests/unit/services/commitChecks/httpEtag.test.ts: "remembers each running commit on its own"; "a finished <provider> commit read between polls of a running one in the same repository leaves both scoped to their own commit" x4 (github, gitlab, bitbucket-cloud, bitbucket-server); "a 200 whose body does not parse is never stored for a later 304"; "a 304 for a stored last page never takes a next link from its own headers"; "a header-minimal 304 keeps GitLab's stored x-next-page". gitlabDetail.test.ts had no 304 case.
- Mutations, each on its own copy, file run with the verbose reporter (unmutated: 33/33 pass):
  - M1 bitbucketCloud commitKey without @hash -> 1 red: bitbucket-cloud two-commit test, "the running commit's next poll is still conditional: expected [] to deeply equal [ Array(1) ]".
  - M2 forCommit returns this when any commit is marked -> 5 red: "another commit is not marked running: expected EtagStore{ ...(3) } to be undefined" and all 4 two-commit tests, "the finished commit's requests do not use the store".
  - M3 store before parse -> 1 red: "the garbled body's etag is not sent: expected 'W/\"bad\"' to be undefined".
  - M4 withPagination spread swapped -> GREEN (33/33 for the reviewer; 35/35 again on the hand-fix tree): an equivalent mutation, because the delete loop removes the overlapping keys before the spread (corrected after the post-takeover review; the takeover first logged it as red).
  - M5 delete loop removed -> 1 red: "the stored page had no next link: expected '<https://api.github.com/repos/o/r...' to be undefined".
  - M6 x-next-page dropped from PAGINATION_HEADERS -> 2 red: "the 304 keeps the stored next page: expected undefined to be '2'" and "the stored page had no next page".
- Gate chain: format:check (green after prettier --write), lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0; test 7790/7798, 8 failures all in commit-list-column-resize.test.tsx (Node v26, recorded before this phase).
- GitNexus detect-changes not run: no .gitnexus/run.cjs in this worktree and the index is behind HEAD; the diff is one test file.
PHASE 5: HALT review still failing after takeover

## Phase 5 hand fix after the takeover halt (2026-11-12)
- Owner answer, verbatim: "A: add 2 tests". Tests and docs only; no change under src/.
- Added to httpEtag.test.ts: "a GitLab commit that finishes stops using the store" (pins gitlabProvider.ts:322) and "a settled GitLab detail stops using the store" (pins :342). Each polls the running commit until its reads are conditional, serves it settled (a control asserts state success / complete true), reads again and asserts no If-None-Match.
- Unmutated: httpEtag.test.ts 35/35 pass. Mutations, verbose reporter, in place and restored:
  - :322 noteCommit(commitKey, false) -> 1 red: "a GitLab commit that finishes stops using the store", AssertionError: the finished GitLab commit's requests do not use the store: expected [ { …(2) } ] to deeply equal [].
  - :342 noteCommit(commitKey, false) -> 1 red: "a settled GitLab detail stops using the store", AssertionError: the finished GitLab detail requests do not use the store: expected [ { …(2) }, { …(2) }, { …(2) }, …(1) ] to deeply equal [].
  - M4 receipt corrected above (rerun: 35/35 green).
- Codex (gpt-6.1-sol high, fresh session 01a1cd3c-40ea-7c32-ac79-84505a6f4de8, scratch copy) on 78b7041c..6898d332: VERDICT: ACCEPT, no findings. Its own runs: unmutated 35/35; :322 and :342 each 1 red on the new test's assertion, after the settle control passed; spread swap 35/35 (equivalent); commitChecks + commitChecksProviders 774/774; 0 src/ paths in the diff.
BLOCKER 2026-11-12: Phase 5 review still failing after takeover (log :867); owner chose A ("A: add 2 tests"): two GitLab settle tests added by hand, Codex ACCEPT on 6898d332 (checklist B).
PHASE 5: ACCEPTED 6898d332

## Phase 6: built, review pending

- Builder: Opus phase lane (claudex-build, test-first), no Codex round in this step. BASE_HEAD 6898d332 (pre-squash Phase 5); actual base 86088cab (#420), HEAD checked unchanged before the commit. Review `git diff 86088cab..<Phase 6 commit>`.
- Built: `followRedirects` and `downloadToString` in http.ts (K17, K20, O2); `CiLogMemoryStore` and `ciLogKey` (K16); `findFirstErrorLine` and `buildCiLogExcerpt`; `intelligit-ci-log:` document provider (K19); store wiring in repositoryMode.ts (one per window, cleared on a commitChecks setting change and on the credential refresh, disposed with the window). Patch 0.43.8, CHANGELOG entry verbatim, 3 strings in 11 locales, README "CI logs" section (Planned).
- Tests: redirects.test.ts, firstErrorLine.test.ts, ciLogMemoryStore.test.ts (store and downloadToString), ciLogDocument.test.ts, a wiring test in view-providers.integration.test.ts (red before the wiring). Mock updates: extension.integration.test.ts finds the diff provider by scheme; commit-message-generation-host-wiring.integration.test.ts mocks `registerTextDocumentContentProvider`.
- Gate L: l10n:sync, translate, import, csv validate, l10n:validate, audit: all exit 0.
- Gate G (each step separately, final tree): focused 0, format:check 0, lint 0, lint:strict 0, architecture:check 0, react-doctor 0, typecheck 0, knip 0, build 0, build:prod 0, package 0 (intelligit-0.43.8.vsix verified, 88 entries). `bun run test`: 7842 of 7850 pass; the 8 failures are commit-list-column-resize.test.tsx (no global `localStorage` under Node v26.5.0), red on an untouched HEAD 86088cab tree too. verify.py gates --stage round: GREEN. Accept stage not run separately: it is the same chain and would report the same 8 pre-existing failures.
- An earlier full run caught a timing flake in my own test (fixed 5 ms delay before the abort); it now waits for body bytes with `vi.waitFor`.
- Mutations on copy mut-6-build-2, perl alarm max(60, 3 x 33 s), 47 mutations, 47 red (3 first survived, closed by new tests, rerun red):
  - R1 forward credentials: "strips Authorization on origin change" + 3 more. R2 hostname-only origin: "port change counts as an origin change". R3 restore on return: "chained redirect back to the first origin stays stripped". R4 allow http: "refuses an http: target". R5 no hop limit: "stops after 5 hops". R6 case-sensitive strip: "strips Authorization on origin change". R7 provider headers ignored: "strips the provider's own credential headers in any letter case". R8 download hop limit 50: survived, then red on new "follows at most 5 redirects" (called 51 times, expected 6).
  - S1 cap 4: "holds at most three logs". S2 evict most recent / S3 no MRU refresh: "LRU evicts the least-recent of 4". S4 no join map: "two concurrent opens make one request". S5 swallow error: "stream error stores nothing and rejects every waiter". S6 no abort / S7 no generation check / S12 clear keeps entries: "clear() empties the store and aborts in-flight downloads". S8 import fs: "store module imports no fs". S9 no notification: "a load that replaces placeholder text fires onDidChange for that URI". S10 waiter ignores signal: "cancelling one waiter keeps the shared download for the others" (timeout). S11 preview returns text: "30 MB log is stored and only the excerpt is returned".
  - T1 refuse big Content-Length: "known-length 300 MB response truncates at 50 MB with one marker". T2 marker twice / T3 no marker / T8 flag false: the known- and unknown-length truncation tests. T4 swallow stream error: "rejects a stream error and never returns partial text". T5 premature close: "rejects a response that closes before it ends". T6 no UTF-8 cut: "cuts back to a UTF-8 boundary before the marker". T7 body ignores abort: "an abort mid-body ..." (timeout). T9 exact bound truncates: survived, then red on new "a body of exactly the bound is whole, with no marker". T10 head ignores abort: survived (the old test delivered the head), then red on the reworked "an abort before the response head rejects and destroys the request" (stub never answers; timeout). T11 non-2xx accepted: "a non-2xx status rejects as HttpError with its status".
  - D1 regex dropped / D2 unanchored: "rejects ../ and non-hex keys". D3 empty on miss: "miss with a source downloads again". D4 download without source: "miss without a source returns the no-longer-loaded line and sends nothing". D5 no onDidChange / D6 error line not stale: "a load after an error line fires onDidChange for that URI".
  - F1-F5: "pattern, then step fallback, then last line" (+ whole-log and multiline tests). F6 excerpt no byte trim: "stays within 8 KB for huge lines and keeps the error line in view".
  - W1 no clear on settings / W2 no clear on credentials / W3 no registration / W4 no dispose: "registers the CI log document and clears the log store with the CI caches", each on its own assertion.
- GitNexus (index stale at 64d390b0, old map per owner): impact activateRepositoryMode UNKNOWN (caller extension.ts, unresolved), refreshCommitCheckBadges LOW. detect-changes --scope all: 21 files, 9 symbols, risk HIGH through activateRepositoryMode (9 flows); the change there is the store wiring the integration test pins.
- Deviations: none from the Phase 6 contract rows. The store's download in repositoryMode is a rejecting placeholder until Phase 7 adds provider log endpoints; nothing calls `load` yet.

### Phase 6 fix round 1 (2026-11-12)
- Finding (Codex, http.ts:434): a body reaching exactly maxBytes with an announced larger (or no) Content-Length that then stalls was lost to the 15 s idle timeout instead of stored truncated.
- Fix: `readBounded` stops at the bound (finish(true) + response.destroy()) unless `Content-Length` equals maxBytes; the equal case still waits for `end` and keeps no marker.
- Tests: `ciLogMemoryStore.test.ts` > "reaching the bound with an announced larger length / no announced length stops at once even if the server then stalls" (red before fix: "reaching maxBytes must destroy the response: expected false to be true"); the exact-bound whole test now announces Content-Length 10.
- Mutations (copy mut-6-fix-1): `<` -> `<=` red (both stall tests); wholeAtBound=true red (both stall tests); wholeAtBound=false red ("a body of exactly the bound, announced at that length, is whole").
- Battery: all steps exit 0 except `bun run test` 7844/7852, the 8 known commit-list-column-resize.test.tsx (Node v26 localStorage) failures, red on base too.

### Phase 6 fix round 2 (2026-11-12)
- Findings (Codex): 4 surviving mutations, each answered with a test only; no source change.
- Tests in `ciLogMemoryStore.test.ts`: "stale download settling after clear() does not drop the new in-flight download (stale rejects with an abort error / stale resolves anyway)"; ciLogKey "differs when any one part differs, and the separator tells shifted parts apart"; "UTF-8 boundary: ..." (8 cases, replacing the single é test); "a waiter whose signal is already aborted rejects while the others still get the log".
- Mutations (copy mut-6-fix-2), each red naming its test: M1 delete reject-handler generation check -> "the third request must join the second download: expected "vi.fn()" to be called 2 times, but got 3 times" (stale rejects); M2 swap lines 173/174 -> same line (stale resolves); M3 drop providerKey -> "providerKey: expected ... not to be ..."; M4 drop runId -> "runId: ..."; M5 drop separators -> "providerKey|runId shift: ..."; M6 `0xf0 ? 4`->3 and M8 look-back -4->-2 -> "expected 'abcdefg�\n' to be 'abcdefg\n'" (4-byte cut after 3); M7 `0xe0 ? 3`->2 -> "expected 'abcdefgh�\n' to be 'abcdefgh\n'" (3-byte cut after 2); M9 delete pre-aborted check -> "promise resolved ... instead of rejecting".
- Battery: all steps exit 0 except `bun run test` 7855/7863, the 8 known commit-list-column-resize.test.tsx (Node v26 localStorage) failures, red on base too.

### Phase 6 takeover (after fix round 2), 2026-11-12
- Finding (Codex, ciLogDocument.ts:60): a document read whose download a clear() aborted could settle after a newer same-key load had fired its refresh; the tab then kept the error line, against K19.
- Fix: the read's catch serves the store's current entry for the key; it marks the tab stale only when there is none (the check and the mark are synchronous, so no later load can slip between them).
- Test: ciLogDocument.test.ts "a stale document read cannot leave an error tab stuck after a newer same-key load succeeds (stale download rejects|resolves)". Red before the fix, both orderings: "the error tab must recover on the later successful load (tab shows \"[IntelliGit: could not load this CI log: The log download was aborted]\"): expected false to be true". Green after; the reviewer's ciLogReviewer.test.ts also passes on the fix (copy mut-6-takeover-1, 18 of 18).
- Battery: every step exit 0 except bun run test, 7857 of 7865; the 8 failures are commit-list-column-resize.test.tsx (no global localStorage under Node v26), red on base 86088cab too.
PHASE 6: HALT review still failing after takeover

### Phase 6 fix round 3 after the owner's halt answer "A: follow the plan" (Opus builder), 2026-11-12
Phase 6: built, review pending
- The handoff showed Phase 6 built, but the owner's answer required three fixes, so this builder step made them on top of 75271f63 (no reset) instead of only rerunning gates.
- K16 (ciLogMemoryStore.ts): generation rechecked after the onDidLoad listeners. Red before: "a load listener that calls clear() never hands the cleared log back to the waiter" -> "promise resolved ... instead of rejecting".
- K19 (ciLogDocument.ts): onDidCloseTextDocument drops a closed intelligit-ci-log URI from the refresh registry, deletes empty buckets, disposed with the provider. Red before: "only the open tab is refreshed: expected ... 1 times, but got 2 times"; "dispose must stop listening for closed documents".
- O2 (http.ts): Content-Length === maxBytes exception removed. Red before: "reaching maxBytes must destroy the response" (exact-bound stall row) and "reaching maxBytes always marks the log truncated". The old exact-bound "whole, no marker" test is replaced.
- Mocks: onDidCloseTextDocument added to the vscode mocks of view-providers and commit-message-generation-host-wiring integration tests.
- Mutations (copy mut-6-fix-3, rsync copy, perl alarm 60 s), 6 of 6 red: M1 drop post-listener check -> "promise resolved ... instead of rejecting"; M2 forget no-op -> "only the open tab is refreshed" + "an empty key bucket must be deleted"; M3 close subscription not disposed -> "dispose must stop listening for closed documents"; M4 no scheme check -> "only the open tab is refreshed: ... got 0 times"; M5 whole-at-bound restored -> "reaching maxBytes must destroy the response" + "reaching maxBytes always marks the log truncated"; M6 keep empty buckets -> "an empty key bucket must be deleted".
- Battery (each step separately): l10n:sync, translate, import, csv validate, l10n:validate, audit, focused (35 files, 1093 tests), format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package all exit 0; bun run test 7861 of 7869, the 8 failures are commit-list-column-resize.test.tsx (Node v26 localStorage), recorded red on 86088cab in earlier rounds. verify.py gates --base 86088cab --stage round: GATES GREEN warn=0.

### Phase 6 fix round 4 (review of c2df109b, fix round 1; Opus builder), 2026-11-12
Phase 6: fix applied, review pending
- Finding (K19, ciLogDocument.ts:70): a pending read that failed after its tab closed or after dispose re-added the URI to the refresh list. Fix: a per-URI set of pending read tokens; onDidCloseTextDocument and dispose mark them closed; the catch skips markStale for a closed read. The sync markStale at :58 has no await before it, so it needs no fence.
- Red before: "a tab closed while loading must never be refreshed: expected "vi.fn()" to not be called at all, but actually been called 1 times"; "a disposed provider must keep no tabs: expected 1 to be +0". Guard test "a tab closed and reopened while a load is pending is still refreshed after it fails" green before and after. The reviewer's scratch reviewer-phase6.test.ts (7 tests) passes against the fix.
- Mutations (copy mut-6-fix-4, perl alarm 60 s), 4 of 4 red: M1 drop the closed check -> both new assertions; M2 forget does not mark -> "a tab closed while loading must never be refreshed"; M3 dispose does not mark -> "a disposed provider must keep no tabs"; M4 shared per-URI token (over-fence) -> "the reopened tab must recover".
- Battery (each step separately): l10n:sync, translate, import, csv validate, l10n:validate, audit, focused (35 files, 1096 tests), format:check (after prettier on the new test), lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package all exit 0; bun run test 7864 of 7872, the 8 failures are commit-list-column-resize.test.tsx (Node v26 localStorage), recorded red on 86088cab in earlier rounds.

### Phase 6 fix round 5 (review of 819aa68d, fix round 2; Opus builder), 2026-11-12
Phase 6: fix applied, review pending
- All three findings were untested behaviour; the code was right, so the commit adds tests only (ciLogDocument.test.ts, ciLogMemoryStore.test.ts; the https stub now records setTimeout calls).
- Red under the reviewer's mutations (copy mut-6-fix-5, perl alarm 60 s), 4 of 4: F7 overwrite read set -> "neither closed pending read may resurrect the tab: expected "vi.fn()" to not be called at all"; F5 keep marker -> "settled read markers must be released: expected 2 to be +0"; F6 keep bucket -> "empty URI buckets must be released: expected 2 to be +0"; M12 15001 -> "log requests keep the existing 15 s idle timeout: expected 15001 to be 15000" (both rows). Unmutated: 60/60.
- Battery (each step separately): l10n:sync, translate, import, csv validate, l10n:validate, audit, focused, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package exit 0; format:check exit 1 on the new test, then 0 after prettier --write; bun run test 7867 of 7876: 8 commit-list-column-resize.test.tsx (Node v26 localStorage, red on base) plus diffBudgets "large compute" timing (170 ms vs 59 ms under load), which passed alone (4/4).

## Phase 6 takeover 2 (7 open findings after 2 fix rounds), 2026-11-12
- All 7 findings were test gaps; no source file changed. Tests added or tightened in ciLogMemoryStore.test.ts ("a load hit counts as a use", "a truncated download is stored and previewed as truncated", 403 test asserts `state.destroyed`, UTF-8 row "a 2-byte character ending exactly at the bound (kept)"), redirects.test.ts (same-origin redirect over 301/302/303/307/308; destroy asserted per followed hop and not on the final response), firstErrorLine.test.ts ("an empty log opens at line 0"), ciLogDocument.test.ts (placeholder test clears the store before its second load; dispose test reads store `listeners`, provider `changeListeners` and `stale`).
- Mutations on copy mut-6-takeover-1 (60 s limit each), 12 of 12 red, each naming its assertion: F1a :178 "the stored entry keeps truncated: expected false to be true"; F1b :139 "the preview keeps truncated: expected false to be true"; F2 :122 "b is the least recently used: expected { text: 'b log #2', …(2) } to be undefined"; F3a :316 "a followed redirect response must be destroyed" and "every followed hop's response must be destroyed"; F3b :357 "an unread error response must release its socket: expected false to be true"; F4 :36 "empty log: expected -1 to be +0"; F5 :119 "a refreshed tab must leave the refresh list: expected "vi.fn()" to be called 1 times, but got 2 times"; F6a :90 "dispose must unsubscribe from the store: expected 1 to be +0"; F6b :92 "dispose must drop onDidChange listeners"; F6c :93 "dispose must drop the placeholder tab"; F7a :264 "status 308 must be followed: expected 308 to be 200"; F7b :468 "expected 'abcdefgh\n' to be 'abcdefghé\n'".
- Proof chain (to-chain.sh, each step separate): exit 0 for every l10n step, focused vitest (4 files, 83 tests), format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, build:prod, package. `bun run test`: 7876 of 7884 passed; the 8 failures are the known commit-list-column-resize.test.tsx localStorage ones (Node v26.5.0).
- No contract row or PENDING-OWNER item changed.
PHASE 6: ACCEPTED 69e809bb, VERIFICATION INCOMPLETE
PHASE 6 UNVERIFIED: bun run test is red in this environment: 8 failures in tests/webview/unit/commit-list-column-resize.test.tsx, from Node v26.5.0 having no global localStorage. I reproduced the same 8 failures on base commit 86088cab, and this diff touches neither the test nor its code. The full suite therefore cannot be shown green here.; Live VS Code behaviour (reload, tab retention after eviction, cursor placement, progress cancellation) needs the Phase 7 editor flow.; Real socket and TLS behaviour and the real 15 s idle timer: the tests use fakes and call the timeout callback.; Provider endpoints, expired-link renewal and cross-device provider changes: provider wiring is excluded from Phase 6.; Translation quality of the builder-authored l10n strings: only key and placeholder coverage was checked.; Codex capped its extra mutations at 12 and did not mutate every remaining guard variant. My own X1-X10 cover part of the rest.
REVIEW_MODEL=gpt-6.1-sol (python3 ~/.claude/skills/claudex-build/helpers.py review-model, rc=0). Codex session id 01a1cf91-3805-7651-ac7d-8fb0ddcd2cf8, effort high, run on a copy of HEAD 69e809bb at /var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/review-6-3; codex rc=0, VERDICT: ACCEPT on the first line, no findings, so there was nothing for me to drop or keep.

My commands:
- `git status --porcelain` before the chain: empty. After the chain: empty (handoff and review-log are committed in HEAD, so the tree lists nothing).
- `python3 ~/.claude/skills/claudex-build/verify.py gates --base 86088cab9ee8d07c724da9e13f5aeac980dfbffa --stage round`: exit 0, GATES: GREEN warn=0 (format, lint, typecheck, architecture, react-doctor all OK).
- Proof chain, my copy of the builder's script, one step per log under /var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/chain-6-3. Steps 1-14 exit 0: l10n:sync, l10n:translate --only-missing, l10n:import, localization-csv.js validate, l10n:validate, l10n:audit, `bun vitest run` of the four phase files (4 files, 83/83 passed), format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build. Step 15 `bun run test` exit 1: 507 files passed, 1 failed; 7876 tests passed, 8 failed. All 8 are tests/webview/unit/commit-list-column-resize.test.tsx with "TypeError: Cannot read properties of undefined (reading 'clear')" at the test file's line 92 (`localStorage.clear()`). Node is v26.5.0 and prints "localStorage is not available because --localstorage-file was not provided". Steps 16-17 exit 0: build:prod, package.
- Check that those 8 are pre-existing: I extracted the base commit 86088cab to /var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/base-6-3 and ran `bun vitest run tests/webview/unit/commit-list-column-resize.test.tsx` there. Node v26.5.0, exit 1, "Tests 8 failed (8)". The diff does not touch that test or the code it uses. I treat these as an environment failure, not a phase defect.

Mutation batch (my script /var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/mutate-6-3.py, run through keep-warm on a scratch copy, each file restored after each mutation). Baseline of the four phase files: rc=0, 83/83, 1.5 s. Cap is perl alarm, 60 s. All 22 mutations went RED; none stayed green and none was cut off.
R1-R12 are the fix step's mutations, replayed:
- R1 store:178 `truncated: false`: RED, ciLogMemoryStore.test.ts > "a truncated download is stored and previewed as truncated": "the stored entry keeps truncated: expected false to be true".
- R2 store:139 preview `truncated: false`: RED, same test: "the preview keeps truncated: expected false to be true".
- R3 store:122 `this.entries.get(key)`: RED, "a load hit counts as a use": "b is the least recently used: expected { text: 'b log #2', ... } to be undefined".
- R4 http:316 drop `opened.response.destroy()`: RED, redirects.test.ts > "strips Authorization on origin change": "a followed redirect response must be destroyed: expected "vi.fn()" to be called at least once".
- R5 http:357 drop `response.destroy()`: RED, "a non-2xx status rejects as HttpError with its status": "an unread error response must release its socket: expected false to be true".
- R6 firstErrorLine:36 drop `lines.length > 1 &&`: RED, "an empty log opens at line 0": "empty log: expected -1 to be +0".
- R7 doc:119 drop `this.stale.delete(key)`: RED, "a load that replaces placeholder text fires onDidChange for that URI": "a refreshed tab must leave the refresh list: expected "vi.fn()" to be called 1 times, but got 2 times".
- R8 doc:90 drop `storeSubscription.dispose()`: RED, "dispose stops listening to the store": "dispose must unsubscribe from the store: expected 1 to be +0".
- R9 doc:92 drop `changeListeners.clear()`: RED, same test: "dispose must drop onDidChange listeners: expected 1 to be +0".
- R10 doc:93 drop `stale.clear()`: RED, same test: "dispose must drop the placeholder tab: expected 1 to be +0".
- R11 http:264 drop 308: RED, "keeps credentials on a same-origin redirect (308)": "status 308 must be followed: expected 308 to be 200".
- R12 http:468 `byte >= 0xc0 ? 3`: RED, "UTF-8 boundary: a 2-byte character ending exactly at the bound (kept)": "expected 'abcdefgh\n' to be 'abcdefghé\n'".
X1-X10 are my extra mutations of guards and constants:
- X1 MAX_CI_LOGS_IN_MEMORY 4: RED, ciLogDocument "miss with a source downloads again".
- X2 drop the success-handler generation guard: RED, ciLogDocument "a stale document read cannot leave an error tab stuck ... (stale download resolves)": "expected 'stale' to be 'fresh'".
- X3 drop the post-listener generation guard: RED, "a load listener that calls clear() never hands the cleared log back to the waiter".
- X4 drop the error-handler generation guard: RED, "stale download settling after clear() does not drop the new in-flight download".
- X5 clear() no longer aborts: RED, "clear() empties the store and aborts in-flight downloads".
- X6 maxHops 6: RED, "follows at most 5 redirects".
- X7 idle timeout 150000: RED, "15 s inactivity callback rejects before the response head".
- X8 `bytes.length <= room`: RED, "reaching the bound with an announced larger length stops at once even if the server then stalls".
- X9 CI_LOG_MAX_BYTES 51 MB: RED, "bounds a CI log at 50 MB".
- X10 cut index+length `>=`: RED, "known-length 300 MB response truncates at 50 MB with one marker".

Codex's own evidence (from its reply; I did not re-run these). It computed git blob hashes and they matched all 30 changed files. It ran the four unit files (83/83), its own phase6Reviewer.test.ts (3/3), and those plus the three touched integration files (340/340). It replayed the same 12 mutations, all red with the same assertions. It ran 12 additional mutations of its own: credential forwarding, hostname-vs-origin, extra hop, HTTPS guard, capacity 4, join map, success-generation guard, abort omission, key regex, 51 MB, exact-room chunk, final-fallback line 0. All were red. It checked 20 interruption scenarios (concurrent same-key loads, eviction while a read is pending, clear before and after completion, a listener calling clear(), tab closed or reopened mid-download, provider disposed mid-download, five redirect statuses, an exact-bound stall, 9 UTF-8 rows, abort and idle timeout, two windows). Its deliverable audit found every deliverable DONE.

Dispositions of the builder's and handoff's risks (from Codex):
- The seven test gaps and 12 claimed mutations: fixed, reproduced by me and by Codex.
- Pending-read cleanup and closed/reopened tabs: fixed at ciLogDocument.ts:65, 81, 94, 99.
- Stale document read after a newer same-key success: fixed at ciLogDocument.ts:73.
- Generation recheck after load listeners: fixed at ciLogMemoryStore.ts:188.
- Credential refresh clears logs: fixed at repositoryMode.ts:1398.
- Allowed per spec: rejecting transport until provider wiring (spec :851), settled-only enforced by Phase 7 (spec :441), English truncation marker (spec :443), sources kept for the window's life (spec :440), stop and mark at 50 MB (spec :444), memory cost of three large logs (spec :458, :906).
- O2 contract row ("50 MB per log; the log text ends with a truncation line and the detail shows Open in browser", RESOLVED) is pinned by "bounds a CI log at 50 MB", X9 and the `truncated` tests R1/R2.
- No PENDING-OWNER item bears on this phase.

Codex ran `vitest` with `--no-cache` and wrote its own evidence files only inside its scratch copy. It hit one PreToolUse hook block on a long-output command, with no effect on the result. No repository file was edited by me.

Phase 7: built, review pending
- Build commit 49b1bb44 (0.43.9). Given BASE_HEAD 69e809bb was squash-merged as 51b0c3ab (#422); actual base df6b6c64 (docs commit after it). Review `git diff df6b6c64..49b1bb44`.
- Gates: L OK (sync, translate --only-missing, import, csv validate, validate, audit); U OK (impeccable detect on 4 UI files); G static OK (`verify.py gates --base df6b6c64 --stage round` GREEN); build, build:prod, package OK; pre-commit hook (gitleaks, prettier, eslint, knip, depcruise, l10n, typecheck, build, package) OK. E: tests/e2e/ciLogEditor.spec.ts listed in `test:e2e`, runs on CI, not run locally.
- `bun run test` (worktree): 10 failed / 7915 passed of 7925. 8 = commit-list-column-resize under Node v26.5.0 (red on base, known). 2 = tsconfigCoverage and screenshotComparatorMeta, which need node_modules inside the checkout; both pass in a copy with node_modules (`copyrun.sh env ...` -> 2 passed). `verify.py --stage accept` RED on that test gate only.
- Mutations on copies mut-7-build-1..11, 11 run, 11 red, each naming its assertion: selectionToken guard; dangerouslySetInnerHTML; preview takes the open path; running check; summary keyed by job.id; empty ##[error] pattern; UNSAFE_CHARS replace (excerpt.test.ts); fixture log ignores channel; credential strip on redirect; expired-link retry; ANSI strip in summary.
- GitNexus detect-changes (index stale at 64d390b): 60 files, 100 symbols, 39 flows, risk critical (activateRepositoryMode, CommitChecksCoordinator, ensureUndockedPanel); all changes additive.

## Phase 7 fix round 1 (2026-11-12)
- Findings 5/5 cleared, each with a regression test red before the fix:
  - F1 sign-out during openTextDocument: `ciLogPreview.test.ts` "sign-out while openTextDocument waits prevents showing the old log" red "a stale operation must not publish an editor: expected "vi.fn()" to not be called"; fix: `isCurrent()` recheck before `showTextDocument`.
  - F2 ignored fixtures: `firstErrorLine.test.ts` "first error line from GitHub and GitLab fixtures" red ENOENT in a `git archive HEAD` export of 49b1bb44; fix: `.gitignore` negation, fixtures tracked.
  - F3 GitHub summary for a job absent from the listing: `githubJobLog.test.ts` "a failed job absent from the summary listing gets its selected check-run summary" red "expected undefined to be 'selected failure\ndirect summary'"; fix: `unlistedSummaries` reads `GET check-runs/{id}`.
  - F4 K3 requestId: `commitChecksTab.integration.test.tsx` "the current selection token does not waive requestId equality (K3)" red "K3 requires requestId === newest: expected <pre …(3)></pre> to be null"; fix: `newestPreview` ref.
  - F5 untested guards: 6 tests added; mutations M1 quota-403-as-forbidden, M2-M6 each host guard, M7 all guards: 7/7 red, each naming its own test (copy mut-7-fix-1).
- Proof: targeted 930/930 pass; `bun run test` 10 failed / 7923 passed (the known 8 Node v26 + 2 node_modules-less worktree reds); tsc ext/webview/tests clean; eslint clean on changed files.
- GitNexus detect-changes: not runnable on this worktree (not in the registry).
WORKTREE 0 7: /private/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/repro-PLAN-1 repro/PLAN-1

## Phase 7 fix round 2 (2026-11-12)
- Findings 4/4 cleared, each with a regression test red before the fix (F4: red under the mutation, since the guard already existed):
  - F1 generic fallback ignored the failed step: `view-providers.integration.test.ts` "the generic fallback starts after the failed GitHub step, not at an earlier recovered error" red "the excerpt holds the failed step's error: expected '##[group]Run actions/checkout@v4\nste…' to contain 'Assertion failed'"; plus `ciLogPreview.test.ts` "the job's first failed step reaches the log target" red "expected "vi.fn()" to be called with arguments: [ …(3) ]" and `ciFixture.test.ts` "records the job's failed step with the source, outside the key" red "expected undefined to be 'Run npm test'". Fix: `failedStep` on CiLogJob/CiLogSource, GitHub `stepStartPrefix = "##[group]"`, wiring sets `stepStart`.
  - F2 already cancelled token: `ciLogPreview.test.ts` "an already cancelled progress token does not open a cached log" red "cancellation must win even on a cache hit: expected "vi.fn()" to not be called at all, but actually been called 1 times". Fix: abort when `token.isCancellationRequested`.
  - F3 secondary rate limit: `ciLogPreview.test.ts` "a secondary rate-limit 403 with Retry-After is failed, not forbidden" red "a retry-after cooldown is not a token permission error: expected [ 'forbidden', 'forbidden' ] to deeply equal [ 'failed', 'failed' ]". Fix: `Retry-After` marks a rate limit.
  - F4 selectionToken guard unproven: `commitChecksTab.integration.test.tsx` "the newest requestId does not waive selectionToken equality (K3)"; red under M7 "K3 requires selectionToken === newest: expected <pre …(3)></pre> to be null".
- Mutations on copy mut-7-fix-2, 7 run, 7 red, each naming its own test: M1 no stepStart, M2 handler drops step, M3 provider source drops step, M4 seeded source drops step, M5 no pre-cancel check, M6 no Retry-After, M7 no selectionToken guard.
- Proof: touched suites 1120/1120 pass; `bun run test` 10 failed / 7929 passed (the known 8 Node v26 + 2 node_modules-less worktree reds); `bun run typecheck` clean; eslint clean on changed files.
- GitNexus detect-changes: not runnable on this worktree (not in the registry).
WORKTREE 0 7: /private/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/repro-PLAN-2 repro/PLAN-2

### Phase 7 takeover (after fix round 2), 2026-11-12
- F1 src/views/ciLogHandler.ts: editor open/show rejections now reply `failed` via failureOf. Test ciLogPreview.test.ts "an editor that fails to open or show replies failed after the log was stored"; red before fix: "AssertionError: the webview gets the editor failure: expected [] to deeply equal [ ObjectContaining{…} ]".
- F2 firstErrorLine.ts:46 guard: new test "never picks the failing step's own start line when its name holds an error word"; red under M8 (`Math.max(stepStart, 0)`): "the step's output, not its name: expected 1 to be 3".
- F3 useCiLog.ts:91 guard: new test "a late reply to an earlier open leaves the newer open's error"; red under M12 (requestId check dropped): "only the newest open request's reply renders: expected 'unit-testsStateFailed…' to contain 'Could not load the log: newer failure'".
- Mutations on mut-7-takeover-1: A1 (no catch), A2 (showTextDocument outside try), M8, M12 all red, each naming its test.
- Proof: `bun run test` 10 failed / 7932 passed (the 10 known: 8 column-resize under Node v26, tsconfigCoverage, screenshotComparatorMeta); `bun run typecheck` clean.
- The editor steps moved into a `showLog` helper (eslint complexity cap 25); re-proved on that shape: B1 (catch drops its reply) and B2 (showTextDocument not awaited) both red on "the webview gets the editor failure".
WORKTREE 0 7: /private/var/folders/_k/7dgz_h9s6j35knpn0rnkk1ym0000gn/T/phase-run/PLAN/repro-PLAN-3 repro/PLAN-3
PHASE 7: HALT review still failing after takeover

### Phase 7 finished by hand (owner answer "A: fix by hand"), 2026-11-12
- Findings 1, 2, 3, 5 pinned by tests in ciLogPreview.test.ts, each red under its mutation: lookup `find(() => true)`, `?? run.attempt` dropped, `truncated: false`, `force: true`, `cancellable: false`.
- Finding 4 (Shape 2): red tests 3f0c7f96, fix 233b965e, then reworked in ceace184 after the R1 and Codex rounds: `followRedirects` reports whether the answering request still carried the credential (`credentialSent`), `HttpError` carries it, and `failureOf` blames the token only when it was sent. Mutations MC1-MC4 red, each naming its test.
- Overflow gap: repro/PLAN-1, -2 red at 233b965e; red test 3d71c353, fix 56fdcf09; summaries made best-effort in ceace184 (a failing or cooled-down summary read leaves the page's failed jobs without text). Mutations MO1, MS1-MS3 red.
- Codex (gpt-6.1-sol high) on 5ba6709e..0aee24d6: REVISE, 3 REQUIRED. 1 fixed (ceace184, same as R1 #2); 2 fixed (6fef8c59, MX1/MX2 red); 3 declined: summaries are best-effort by design, pinned by the "still lists the job as failed" tests.
- Fable R1: 4 points; redirect round trip and unreadable-summary hiding fixed in ceace184; origin-compare mutant gone with the comparison; 404-widening mutant moot (the 404 catch was removed).
- tsconfigCoverage and screenshotComparatorMeta: 2/2 pass with packages installed.
- Proof at 6fef8c59: typecheck 0, lint 0, build 0; `bun run test` 9 failed / 7944 passed (8 column-resize under Node v26; merge-editor-performance ratio 3.07x under load, 3/3 alone).
PHASE 7: ACCEPTED 6fef8c59
Phase 8: built, review pending

## Phase 8 fix round 1 (builder)
- Findings 1-5 each got a regression test that was red before the fix: `sign-out while the fence is written sends nothing and clears the fence` ("stale authorization must not send a write: expected [ { method: 'POST', ...(1) } ] to deeply equal []"); `sign-in invalidation releases the busy action the host discards` ("auth invalidation must release the discarded action: expected true to be false"); `a repository change releases the busy action and drops its late reply` ("the other repository's buttons are usable: expected true to be false"); `the cancel confirmation is reset when the repository changes`; `a reply with the right request id but another scope is ignored` ("wrong scope reply must be ignored: expected false to be true"); `an old action reply is ignored while a newer action is pending` (red on its precondition before the fix, then guarding the request id: mutation of the id comparison goes red naming "the newer action is still pending").
- Finding 6: removed the outer `fence?.notSeen` guard; the store's `endByUserRefresh` decides. A deletion with no behaviour change, so no red test is possible; "Refresh before not-seen keeps the fence" covers the store's guard.
- Finding 7: GitNexus impact run retrospectively from the main checkout's index (10 commits behind): ChecksHeader HIGH, CommitChecksCoordinator HIGH (35 impacted), useCommitCiDetail HIGH, ChecksTab LOW.
- `bun run test`: only the 8 known commit-list-column-resize failures (red at base accf570d too).

## Phase 8 fix round 2 (builder, started at 6fef8c59)
- Findings 1-5 fixed test-first: gate recheck (`RequestNotSentError`, superseded), live repository + provider generation (`coordinator.actionGuard`), token redaction at each provider's write boundary (`redactError`), synchronous request-build failure is a definite non-send, a 401 returns `signedOut` and the pane reads the signed-out detail.
- Red lines before the fix: "the production HTTP boundary must not run after sign-out: expected vi.fn() to not be called at all, but actually been called 1 times"; "switching repository before the POST must send nothing: expected [ { method: 'POST' ... } ] to deeply equal []"; "gho_token must be redacted in the reply: expected '{"outcome":"failed","message":"HTTP 4...' not to contain 'gho_token'"; "a request that was never created is a definite failure: expected { outcome: 'uncertain' } to deeply equal { outcome: 'failed' ... }"; "the sign-in state is read again from the host: expected 1 to be 2".
- Finding 6 is Phase 7 code already in base accf570d (36bef4be); not in Phase 8's diff, left unchanged, recorded under Found outside scope. Finding 7: detect-changes cannot run on the worktree (not registered in GitNexus); recorded in the handoff.
- Proof: `bun run test` 8 failed / 8008 passed (the 8 known commit-list-column-resize, red at base too); typecheck, lint:strict, format:check, architecture:check exit 0. Nine mutants on a copy each red naming a test.

### Phase 8 takeover (2026-11-13) - commit 91e9cef6
- Findings 1 and 3: the fence write (`beforeSend`) moved inside the admitted request-gate callback (`WriteJson` 5th argument; `writeFor` awaits it, rechecks sign-in, sends). Red before: "github: no POST after the context changed in the queue: expected vi.fn() to not be called at all, but actually been called 1 times"; "github: a bucket in cooldown must not write a fence: expected vi.fn() to not be called at all, but actually been called 1 times".
- Finding 2: `send()` maps ENOTFOUND, EAI_AGAIN, ECONNREFUSED to `RequestNotSentError`. Red before: "ENOTFOUND before connection must delete the action fence: expected Error: getaddrinfo ENOTFOUND no-such-host { code: '…' } to match object { name: 'RequestNotSentError', …(1) }".
- Mutations on a copy (5): fence before write in GitHub / GitLab / writeFor, empty DNS set, default helper ignoring beforeSend: all red on a named test.
- Gates: typecheck, lint:strict, format:check, architecture:check exit 0; `bun run test` 8012 passed, 8 failed (commit-list-column-resize, known base failure).
PHASE 8: HALT review still failing after takeover

### Phase 8 finished by hand (owner answer "A: fix by hand"), 2026-11-13 - commit b5a56002
- Fix 1: `send()` settles once and clears the idle timeout on every way out; a response `error`, or `close` before `end`, rejects with a plain Error; a request `close` with no response (a 101 upgrade) rejects too. Base 91e9cef6 left a POST cut after its headers pending (real Node v26.5.0 probe: "STILL PENDING after 5s").
- Fix 2: "never sent" is read from the request's socket (`connecting` at the `socket` event, then `connect`); a socket handed over that never connected is `RequestNotSentError`; a reused socket or any error after connect is uncertain, refusal codes included.
- Mutations, each red naming its assertion: M1 no response close listener ("a cut-off badge read must settle instead of loading forever"); M2 no response error listener ("a cut-off response's error is handled, never thrown into the extension host"); M3 unconnected socket not counted ("ENETUNREACH before the socket connected sent nothing"); M4 `!connected` ("socket hang up" expected plain Error); M4b reused socket read as connecting ("a reused keep-alive socket may have carried the POST"); M5 no connect listener ("a connected socket (a failed TLS handshake included) may have carried the POST"); M6 refusal code ahead of the socket state ("a reused socket was already connected, so the POST may have gone out (ECONNREFUSED)"); M7 no request close listener ("a POST answered with 101 must reject instead of keeping the UI busy"); M7b close listener without the answered guard ("a request close that beats the response's end must not reject a whole answer").
- Codex (gpt-6.1-sol high) on the hand-fix diff: REVISE, 1 finding (101 reply leaves both promises pending), fixed with M7 and httpWire.test.ts.
- Fable R1: 4 points. Refusal code on a connected socket fixed (M6); `settled` guard survivor covered by M7b; TLS failure after TCP connect kept uncertain (the safe side the owner's brief names); any 5xx deleting the fence is the plan's K30 rule (PLAN.md:333), raised to the owner, not changed.
- Gates: Gate L 6/6 exit 0; Gate G format, lint, lint:strict, architecture, react-doctor, typecheck, build, build:prod, package exit 0; `bun run test` 8018 passed / 10 failed (8 known commit-list-column-resize; http.test.ts hit by a mutation running at the same time; operationBenchmark git temp-file error), the last two then green on rerun (970/970 across commitChecks, operationBenchmark, ciActionHandler).
PHASE 8: ACCEPTED b5a56002

## Phase 9: built, review pending (Opus builder), 2026-11-14
- HEAD gate: HEAD is ca0271a6, not BASE_HEAD b5a56002. b5a56002 is not an ancestor: Phase 8 was squash-merged as #426 (7941c809), then docs commit ca0271a6. HEAD did not move during the build; the phase commit sits on ca0271a6.
- Built (0.43.11): GitHub C2 required checks (rulesets paginated + classic protection union; "Branch not protected" 404 = known empty; 401/403/other 404 = partial or unknown; rate-limit 403, 5xx, network = transient reject, not cached); GitLab `only_allow_merge_if_pipeline_succeeds`; K21 L1 cache `required:<repoKey>:<branch>` 1 h, rejected fetch dropped, cleared with the coordinator; K22 `origin/HEAD` read fresh, null without fallback, header hint per §8; marks applied at serve time in coordinator.getDetail (scan updates too), never persisted; "blocks merge", "optional", "required: unknown" UI; K32 contract version 5; 4 strings x 12 locales; README; CHANGELOG.
- Tests first: defaultBranch.test.ts (5, real temp repo), requiredChecks.test.ts (23), gitlabDetail "allow_failure marks optional", capabilities map, detailService version 5 (version-4 entry is a miss), commitChecksTab integration (4). Red before code for missing functions, version 4 vs 5, missing header/tag elements.
- Deviations: applyRequired was written before its own tests (green on first run, then mutation-proven via m3/m6 paths); "allow_failure marks optional" was already true from Phase 3 (green from the start, proven by m9).
- Mutations (copy mut-9-build-1), each red naming its assertion: m1 GH protection refusal keeps known -> "403 on protection yields unknown"/"...partial"/"a 404 without the not-protected body is unknown"; m2 isNotProtected false -> "404 not protected is known-empty"; m3 protection names dropped -> "union of rules and protection"; m4 no TTL hit -> "cached for 1 h"; m5 rejected entry kept -> "a transient failure shows unknown and is not cached"; m6 rate limit as refusal -> "a transient failure rejects instead of answering unknown"; m7 fallback to main -> "missing origin/HEAD -> null"; m8 cached tip -> "a remote tip that moves between two comparisons is read fresh"; m9 GitLab optional removed -> "allow_failure marks optional"; m10 header required hidden -> "required: unknown shows while the rule is partial or unknown..." and Bitbucket case; m11 running not blocking -> "tags required jobs that failed or have not finished as blocks merge..."; m12 red -> muted -> same test. (A first m10 form `false && ...` kept the `||` branch and survived: bad mutation, replaced.)
- Gates: Gate L 6/6 exit 0. Proof chain: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build exit 0; `bun run test` 8079 passed / 10 failed: 8 commit-list-column-resize (Node v26.5.0, no localStorage, known since accf570d), tsconfigCoverage + screenshotComparatorMeta (worktree has empty node_modules; both pass in the linked copy). `tsc -p tsconfig.tests.json --noEmit` exit 0. Gate G build:prod + package exit 0 (88 entries).
- GitNexus impact/detect_changes not run: the worktree guard refuses the CLI; callers checked by hand.
- Not run here: Codex review, fix routing, seal, final verifier (the workflow runs them).

## Phase 9 fix round 1 (builder)
- F1 githubProvider getRequiredChecks: every protection 403 (rate-limited included) maps to partial/unknown. Test phase9ReviewProvider.test.ts "C2 every protection 403 ...", red before: "promise rejected HttpError: HTTP 403: API rate limit excee... instead of resolving". The old rate-limit-on-protection test in requiredChecks.test.ts moved to the rules read (still rejects).
- F2 coordinator.readRequired: cache scope `<repoKey>|<account>` under withAccount (rereads account after the reads). Test phase9Review.test.ts "rules are isolated when ...", red before: "reader must not inherit admin's known rule: expected 'known' to be 'unknown'" and "old admin result must be discarded or reread: expected 'known' not to be 'known'".
- F3 requiredChecks.test.ts "cached for 1 h" uses literal 3,599,999 ms. Mutations on a copy: TTL 30 min -> red "expected vi.fn() to be called 1 times, but got 2 times"; TTL 2 h -> red "called 2 times, but got 1 times"; both name "cached for 1 h". Exported REQUIRED_CHECKS_TTL_MS un-exported (no other user).
- Gates: format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build pass; test 8083 passed, 10 failed (the same 10: 8 commit-list-column-resize, tsconfigCoverage, screenshotComparatorMeta).
