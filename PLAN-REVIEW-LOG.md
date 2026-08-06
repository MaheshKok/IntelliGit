# Plan Review Log: Marketplace review/rating prompt

Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5. Reviewer: gpt-5.6-sol (per-round effort schedule per claudex-review).
SID (Round 1): 019fbc4c-ec0e-70e2-a8a0-210bc355f322

Grill decisions (Mahesh): native notification UX; conservative trigger (30 ops / 14 days / 5 active days); 3 lifetime asks with 30-day snooze; visible setting `intelligit.reviewPrompt.enabled`; unknown forks route to Open VSX. Kickoff snapshot: worktree `.claude/worktrees/review-prompt` clean at 36e43d03 (origin/main); main checkout carries unrelated untracked PLAN.md/PLAN-REVIEW-LOG.md from the rebase feature.

## Round 1 — Codex (gpt-5.6-sol, effort ultra)

Telemetry: PEAK=221538 LAST=221538 PCT=85% NONRESUMABLE=yes → Round 2 reseeds a fresh session from PLAN.md + this ledger.

1. [CRITICAL] PLAN.md Approach steps 2–4 — Async read-modify-write updates to shared `globalState` are not serialized, so overlapping calls can lose counters or both pass gating and display duplicate prompts. Fix: Queue calls behind a module-level mutex/promise and set the session-attempt flag before the first await.
2. [REQUIRED] PLAN.md Goal, Approach step 5, and Risks / open questions — The proposed Open VSX destination is dead because the registry currently reports `MaheshKok.intelligit` as "Extension Not Found" (https://open-vsx.org/extension/MaheshKok/intelligit/changes). Fix: Publish the Open VSX listing and verify its `/reviews` route before shipping this feature.
3. [REQUIRED] PLAN.md Approach step 6 / src/views/commitPanelActions.ts — The line-2009 area is only publish-offer UI, while the line-1564 push dispatch misses commit-and-push, selected push, sync, graph, undocked, native-command, branch-menu, and push-up-to-here success paths. Fix: Wire a semantic push-success callback through every host-level success exit while keeping `GitExecutor` untouched.
4. [REQUIRED] PLAN.md Approach step 6 / src/services/publishService.ts — `runPublishBranchFlow` pushes at lines 90 and 216 but represents success, failure, and cancellation as `void`, leaving no truthful completion signal for counting. Fix: Return an explicit outcome or invoke an injected callback only after the actual push resolves successfully.
5. [REQUIRED] PLAN.md Approach steps 1 and 6 / src/views/CommitPanelViewProvider.ts / src/views/UndockedViewProvider.ts / src/activation/repositoryMode.ts — The line-794 `postCommitted` callback is sidebar-local, lacks `ExtensionContext.globalState`, and has a separate undocked counterpart at line 859, so `recordGitSuccess(context)` cannot cover commits as planned. Fix: Construct the recorder and register sync keys during activation, then inject a narrow success callback into both providers.
6. [REQUIRED] PLAN.md Approach steps 2 and 4 — `askCount` increments only after Later or dismissal, so an extension-host restart while the notification remains open permits more than three lifetime displays. Fix: Persistently reserve the ask before showing the notification, then apply snooze or terminal status from the response.
7. [REQUIRED] PLAN.md Approach steps 2 and 3 — Only `installedAt` has initialization behavior, so fresh-state values such as `status`, `askCount`, `snoozedUntil`, and counters are `undefined` and make the literal gates fail permanently. Fix: Define a normalized state loader with `pending` and zero defaults plus empty-state tests.
8. [REQUIRED] PLAN.md Approach steps 1, 4, and 6 — Awaiting `recordGitSuccess` from existing success callbacks can stall refresh until the user chooses or dismisses the notification, and prompt-state errors can reject an already-successful Git operation because `showInformationMessage` resolves on response. Fix: Enqueue durable state work without rejecting the Git boundary and detach the notification-response handling.
9. [REQUIRED] PLAN.md Approach step 5 and Risks / open questions — `startsWith("Visual Studio Code")` also classifies any unknown fork retaining that prefix as official, contradicting the locked Open VSX fallback. Fix: Use an explicit, tested allowlist of official stable and Insiders identifiers with Open VSX as the default.
10. [REQUIRED] PLAN.md Approach steps 7, 8, and 10 — The repository uses `contributes.configuration.properties`, `%configuration.*.markdownDescription%`, 11 locale variants plus the English base, and a mandatory localization CSV that the plan miscounts or omits. Fix: Use the existing manifest key pattern, update both base catalogs and the translation CSV, run sync/import for all 11 locales, then run `l10n:validate` and `l10n:audit`.
11. [REQUIRED] PLAN.md Approach step 9 / vitest.config.ts — A Map-backed Memento alone is insufficient because Vitest provides no global `vscode` mock and the module-level session flag persists between tests. Fix: Add a hoisted inline `vscode` mock and reset modules dynamically, or inject a resettable session guard.
12. [REQUIRED] PLAN.md Approach step 9 — Pure service tests do not verify the complicated call-site contract, allowing combined, retried, published, failed, or undocked operations to be miscounted while every proposed test passes. Fix: Add host-layer tests proving commit-only `+1`, successful commit-and-push `+2`, commit-plus-failed-push `+1`, successful sync/retry/publish `+1`, and canceled or failed push `+0`.

VERDICT: REVISE

### Claude's response (Round 1 triage → PLAN.md v2)

- #1 FIXED — promise-queue serialization for all state work; session flag set synchronously pre-await; see also #6 reservation.
- #2 REJECTED — Listing verified live 2026-08-01 by Claude via `https://open-vsx.org/api/MaheshKok/intelligit`: valid metadata, version 0.22.0, reviewCount 3, averageRating 5.0, reviewsUrl present. The read-only Codex sandbox has no network access; a failed fetch is not a missing listing. Settled — do not re-raise absent new checkable evidence.
- #3 FIXED (different fix than suggested) — Counting moved to ONE post-success callback on `GitExecutor` (plain callback, no vscode import, fired fire-and-forget after exit-0 mutating commands), filtered to `commit|push` in the service. Covers all dispatch paths incl. undocked/publish/future ones. Codex's "wire every host-level success exit, keep executor untouched" was rejected as the weaker fix: ≥8 call sites today, every future path a silent miss; the executor addition is an observation point after resolution, not a change to gate/concurrency structures — the v1 reason to avoid the executor no longer outweighs the sprawl cost its avoidance creates.
- #4 FIXED — moot under executor-callback counting; `publishService` stays untouched (its pushes flow through the executor).
- #5 FIXED — service constructed during activation with `ExtensionContext`; `setKeysForSync` registered there; providers never touched; undocked commits covered by the executor chokepoint.
- #6 FIXED — ask persisted (askCount+1, snoozedUntil=now+30d) BEFORE the toast is shown; response only upgrades status; restart with open toast can never yield a 4th display.
- #7 FIXED — normalizing state loader with hard defaults; empty/fresh-state (all-undefined memento) is an explicit test case.
- #8 FIXED — callback is fire-and-forget + try/catch at the executor; state work queued; notification response handled detached; git results can never stall on or be rejected by prompt logic.
- #9 FIXED — exact-match allowlist {'Visual Studio Code', 'Visual Studio Code - Insiders'}; everything else → Open VSX; fork-with-prefix test case added.
- #10 FIXED — plan now names the real mechanism: `%configuration.*.markdownDescription%` pattern, base `package.nls.json` + 11 locale files, `l10n/` bundles, CSV workflow (`l10n:sync`/`translate`/`import`), gates `l10n:validate` + `l10n:audit` (all verified present in package.json scripts).
- #11 FIXED — per-file hoisted `vi.mock("vscode", …)` per existing repo pattern (reference: tests/unit/core/notifications.test.ts — verified); session flag resettable for tests.
- #12 FIXED — counting-contract suite added: commit +1, push +1, commit-and-push +2, failed push +0, canceled +0, merge/checkout/stash +0, executor-hook behavior (exit-0 only, listener exceptions swallowed).

Disposition: 11 FIXED, 1 REJECTED (#2, with live evidence). PLAN.md rewritten as v2.

## Round 2 — Codex (gpt-5.6-sol, effort xhigh, FRESH session)

SID: 019fbc62-8f4f-79a3-9091-cfdf050d05ea (reseed — R1 session non-resumable at 85% peak). Telemetry: PEAK=151817 LAST=151817 PCT=58% NONRESUMABLE=no.

13. [CRITICAL] PLAN.md Approach 5–6 / Risks — The accepted cross-window analysis assumes both reservations persist, but Memento provides separate `get`/`update` operations without atomic increment, so two windows can both write `N+1`, undercount two displays, and later permit a fourth toast. Fix: serialize reservation across processes with a real lock or relax the locked lifetime cap.
14. [REQUIRED] PLAN.md Approach 1–2 / Risks; src/git/executor.ts; src/activation/repositoryMode.ts — The one-executor/one-wiring assumption is false: `deriveFor()` drops the proposed callback and repository mode creates a separate undocked executor, so derived and undocked commit/push successes escape counting. Fix: propagate the callback through construction and `deriveFor()`, wire every activation-owned executor factory, and test derived/undocked paths.
15. [REQUIRED] PLAN.md Approach 6 / Tests — The detached async response handler has no terminal rejection handler or required status-persistence-before-`openExternal` order, permitting unhandled rejections or loss of the never-ask-again decision during restart. Fix: await the status update before opening the URL, terminate the detached chain with `.catch(log)`, and test order plus rejection containment.
16. [REQUIRED] PLAN.md Approach 10 / Validation 11; package.json — The plan claims coverage floors are enforced but runs only `test`, while this repository activates thresholds only through `test:coverage`. Fix: replace the final full-suite `test` gate with `test:coverage`.
17. [REQUIRED] PLAN.md Approach 9 — The localization workflow is not executable as written because `bun run l10n:translate` requires `-- --only-missing` and performs no translation until approved CSV cells are populated manually. Fix: specify sync → populate all 11 locale columns → translate-check with `-- --only-missing` → import → validate/audit.
18. [REQUIRED] PLAN.md Tests / Validation — Every notification and routing assertion uses a mocked `vscode`, leaving the native toast, dismissal/buttons, and external destination unverified in an Extension Development Host. Fix: add a seeded dev-host/Computer Use acceptance run covering the visible prompt and each response/routing family.
19. [MINOR] PLAN.md Approach 3, 7 / Tests — The plan does not state that gating uses post-increment state, so an implementation may prompt on operation 31 while tests seeded at 30 still pass. Fix: specify increment → persist → gate and test the `29→30` and active-day `4→5` boundaries.

VERDICT: REVISE

### Claude's response (Round 2 triage → PLAN.md v3)

- #13 ACCEPTED-RISK (sharpened, not ignored) — No cross-process lock or atomic increment exists in the VS Code API; a `globalStorageUri` lockfile is complexity far beyond the harm. Blast radius documented precisely in v3: terminal `rated`/`declined` decisions are absolute single-key writes and can never be lost to counter races (Memento updates are per-key); only the ask CAP can soften, and only under sub-second simultaneous reservations in two windows (persisted `snoozedUntil` closes the window at the next read). Worst case: one duplicate toast, ask-count 3±1. Not relaxing the cap; documenting the tolerance.
- #14 FIXED (stronger than suggested) — Hook made module-scoped (`GitExecutor.onCommandSuccess`, static) instead of per-instance: derived (`deriveFor()`) and undocked executors consult it structurally, zero propagation code, future factories can't drop it. Test pins derived + undocked coverage.
- #15 FIXED — Rate handler awaits `status='rated'` persist before `openExternal`; detached chain terminates in `.catch(log)`; order + rejection-containment tests added.
- #16 FIXED — validation gate switched to `test:coverage` (thresholds verified to activate only there); floors quoted in plan.
- #17 FIXED — exact CSV workflow now specified: `l10n:sync` → populate 11 locale columns → `l10n:translate -- --only-missing` → `l10n:import` → `l10n:validate` + `l10n:audit`.
- #18 FIXED — dev-host acceptance step added (seeded one-below-threshold via temporary local patch, real commit, verify toast/buttons/routing/restart-persistence); fork routing pinned by unit tests since appName is not runtime-spoofable.
- #19 FIXED — increment → persist → gate ordering stated; `29→30` and `4→5` boundary tests explicit.

Disposition: 6 FIXED, 1 ACCEPTED-RISK. PLAN.md rewritten as v3. Cumulative: 17 FIXED, 1 REJECTED, 1 ACCEPTED-RISK.

## Round 3 — Codex (gpt-5.6-sol, effort xhigh, resumed session 019fbc62)

Telemetry (session rollout): PEAK=187646 PCT=72% NONRESUMABLE=no. CLI note: `codex exec resume` rejects `-C` (like `-s`) — global `codex -C <dir> exec resume …` placement works; logged for future rounds.

20. [CRITICAL] PLAN.md Risks — The "worst case ever: one duplicate" bound is false because the race can recur after each 30-day snooze and session reset at stored counts 0, 1, and 2, yielding six displays with two windows and more with additional windows. Fix: explicitly accept the true `3 × concurrently eligible windows` bound or add coordination if that violates the locked cap.
21. [REQUIRED] PLAN.md Approach 1–3 / src/services/publishService.ts — First-time authenticated publishing calls `runGitPushWithAskpass()` through `execFile`, bypassing `GitExecutor.onCommandSuccess`, so the promised publish-flow `+1` is missing. Fix: notify the shared success observer after the askpass push succeeds and add a first-time-publish counting test.
22. [REQUIRED] PLAN.md Approach 1–3 / src/commands/branchCommands.ts / src/services/gitHelpers.ts — The hook exposes only `"push"`, while three current paths execute `push --delete`, so remote-branch deletions increment `successOps` and can trigger the review prompt. Fix: pass sufficient argv semantics to exclude delete pushes and pin them as `+0`.
23. [REQUIRED] PLAN.md Approach 11 — One seeded prompt cannot exercise the mutually exclusive Rate, Later, dismissal, and decline outcomes, and Later/dismiss cannot be shown re-armed without advancing the snooze and resetting the session. Fix: define independently reseeded acceptance scenarios with explicit restart/time advancement and persisted-state checks.
24. [REQUIRED] PLAN.md Approach 11–12 — The behavior-changing temporary seed patch has no explicit removal verification before coverage and build, so test-only threshold state could survive into the shipped artifact. Fix: require reverting the seed patch and inspecting the final tracked diff before validation/build.
25. [MINOR] PLAN.md Approach 6, 9–11 — The actual notification message is never specified or asserted, leaving the English source and its 11 translations to implementation-time invention. Fix: lock the exact toast copy and verify it in unit and dev-host acceptance.
26. [MINOR] PLAN.md Approach 9 / Validation 12 — `l10n:audit` is advisory by default and currently exits successfully with nine findings, so merely "passing" it cannot prove this feature added none. Fix: record the current baseline and require no new `reviewPrompt` findings or candidate-count increase.

VERDICT: REVISE

### Claude's response (Round 3 triage → PLAN.md v4)

- #20 FIXED (upgraded from v3's ACCEPTED-RISK — Codex's recurrence math is right, my "one duplicate" bound was wrong) — Same-machine O_EXCL lockfile (`globalStorageUri/review-ask.lock`, 'wx', 10-min stale TTL, fail-closed skip on contention) + post-acquire fresh re-gate; `globalState.update` acks through the main process so post-release visibility is IPC-fast. Same-machine duplicates eliminated; residual cross-MACHINE sync-lag races fall under the grill-accepted per-machine semantics. Full Memento→file state migration rejected: it would sacrifice `setKeysForSync` (user-locked cross-machine no-re-ask) to fix a smaller problem.
- #21 FIXED — askpass publish path fires the shared hook manually (`('push', argv)` after success); first-publish counting test added.
- #22 FIXED — hook signature now `(subcommand, argv)`; service excludes `--delete`/`-d`/`:refspec`/`--dry-run` pushes as +0; all three repo delete-call-site shapes pinned by tests.
- #23 FIXED — four independently reseeded acceptance scenarios (Rate / Later / Dismiss / Don't-ask) with restarts and snooze-past time advancement.
- #24 FIXED — acceptance ends with seed-patch revert + `git status --porcelain` clean check on tracked files BEFORE any validation gate runs.
- #25 FIXED — EN copy locked in plan (message + 3 buttons), asserted in unit tests and acceptance.
- #26 FIXED — `l10n:audit` gate defined as a delta vs recorded baseline (9 advisory findings today): no new reviewPrompt-related findings, no candidate-count increase.

Disposition: 7 FIXED (incl. #20 upgraded from accepted-risk to engineered fix). PLAN.md rewritten as v4. Cumulative: 24 FIXED, 1 REJECTED, 1 superseded-by-fix (#13→#20 lock).

## Round 4 — Codex (gpt-5.6-sol, effort xhigh, resumed session 019fbc62)

Telemetry: PEAK=200661 LAST=86780 PCT=77% → compaction detected (LAST < PEAK/2) → NONRESUMABLE=yes. Round 5 (FINAL) reseeds a fresh session; new CRITICALs this round → final round runs at ultra per schedule.

27. [CRITICAL] Approach 5(c,f) — A stale owner can resume after another window unlinks and replaces its lock, then the original owner's unconditional `finally` unlink deletes the replacement lock and permits concurrent reservations. Fix: Reclaim only locks whose owner is provably dead and release only an ownership-matching lease; test A-stale/B-acquires/A-resumes.
28. [CRITICAL] Approach 5(d) / Key decisions — The post-lock `globalState` re-read is not guaranteed fresh across extension hosts because `Memento.get()` reads a host-local cache and `$setValue()` does not await another host's `$acceptValue`, so a waiter can re-gate stale state after acquiring the lock (vscode extHostMemento.ts / mainThreadStorage.ts). Fix: Gate and reserve through a lock-protected same-machine state record, including terminal decisions, while retaining Memento as the Settings Sync mirror; add delayed cross-host propagation coverage.
29. [REQUIRED] Approach 1 / src/services/publishService.ts — The askpass manual fire lacks the executor path's stated try/catch, so a listener throw inside the publish `try` can misreport a successful push as failed and trigger remote cleanup. Fix: Route both fire sites through one exception-swallowing dispatcher and test that an askpass-listener throw preserves publish success.
30. [REQUIRED] Approach 2 / Risks — Awaiting `mkdir` during repository-mode activation without specified containment contradicts the fail-closed promise because a storage error can abort activation instead of merely disabling the prompt. Fix: Catch initialization failure, log it, leave the hook disabled, and continue normal extension activation.
31. [REQUIRED] Approach 3 and 10 — Git's documented `-n` alias for `--dry-run` is absent from the exclusion and tests, so `git push -n` incorrectly counts as a successful operation. Fix: Exclude exact `-n` and add its +0 contract test.
32. [MINOR] Approach 5(c,f) — `fs.promises.open()` returns a `FileHandle`, but the plan only unlinks the path and never specifies closing the handle, relying on unreliable automatic closure. Fix: Explicitly close the handle after exclusive creation and cover close/release failures.

VERDICT: REVISE

### Claude's response (Round 4 triage → PLAN.md v5)

- #27 FIXED — Lock gains an ownership lease (`pid:nonce` content): release unlinks ONLY on lease match; reclaim ONLY on provable owner death (`process.kill(pid,0)` → ESRCH; EPERM = alive) or 30-min stale with unchanged content; A-stale/B-acquires/A-resumes pinned as a test.
- #28 FIXED (adopting Codex's design) — Ask-decision record (askCount, snoozedUntil, status, lastAskAt) moves to `globalStorageUri/review-prompt-state.json`, read fresh from disk inside the lock (no extension-host cache) and written atomically (temp+rename). Memento demoted to Settings-Sync mirror only (terminal-wins/max merge on load; file absent → seed from mirror). Usage counters stay Memento-only — their race direction is annoyance-safe. This preserves the user-locked cross-machine no-re-ask (setKeysForSync) while ending the pretense that Memento is a consistency layer.
- #29 FIXED — Both fire sites route through one exported exception-swallowing dispatcher `notifyGitSuccessSafely`; test proves an askpass-listener throw cannot misreport a succeeded publish.
- #30 FIXED — Service init containment-wrapped: any storage/mkdir/sync-registration failure logs, leaves the hook unset (feature disabled), activation continues.
- #31 FIXED — exact `-n` added to push exclusions with a +0 contract test.
- #32 FIXED — FileHandle explicitly closed after exclusive create; close/release failure paths logged-not-thrown, tested.

Disposition: 6 FIXED. PLAN.md rewritten as v5. Cumulative: 30 FIXED, 1 REJECTED, 1 superseded (#13→#20→#27/#28 lineage).

## Round 5 — FINAL — Codex (gpt-5.6-sol, effort ultra, fresh session 019fbc87, reseeded from PLAN.md v5 + full ledger)

Telemetry: PEAK=142218 LAST=142218 PCT=55% → session resumable if the user authorizes an extension round.

33. [CRITICAL] PLAN.md Approach 5(c,f) / lock tests — The 30-minute age-based reclaim can steal from a live paused owner, and lease-matched release does not fence that owner's already-entered critical section from resuming, reserving, and showing alongside its successor. Fix: Require stale AND provably dead ownership, reuse the existing heartbeat-based `RepositoryLock` pattern, and test that resumed A performs no reservation or toast.
34. [CRITICAL] PLAN.md Approach 5(c,f) / lock tests — The `read/validate → unlink → open('wx')` takeover is not atomic, so two contenders can validate the same dead lease and one can unlink the other's replacement, allowing both into the critical section. Fix: Use the repository's nonce-validated rename takeover or an equivalent single-winner protocol and test simultaneous dead-owner contenders.
35. [CRITICAL] PLAN.md Approaches 4–6 / reservation tests — Rate and Decline persistence occurs after releasing the ask lock, so a worker holding a stale `pending` snapshot can overwrite the terminal file update with a later pending reservation and restore re-ask eligibility. Fix: Serialize every terminal mutation through the same lock with a fresh terminal-monotonic merge and retry contention until the decision is durable.
36. [CRITICAL] PLAN.md Approach 5(b,d) / state-record tests — The full pre-gate can return on host-cached decision fields before seeding or reconciling the file, while a failed post-merge re-gate returns without persisting the winning terminal/max merge, allowing another stale same-machine host to create or retain pending state and prompt. Fix: Perform decision-record reconciliation and atomic write-through under the lock before any status/cap/snooze gate can return, with divergent-host tests for absent, corrupt, and existing files.
37. [REQUIRED] PLAN.md Approaches 4–6 / tests — A rejected Settings-Sync mirror update after the authoritative file write aborts before the toast or `openExternal`, invisibly consuming a reserved ask or permanently recording `rated` while the Rate button opens nothing. Fix: Treat mirror writes as best-effort after successful file persistence, log failures, continue the user action, and test both rejection paths.

VERDICT: REVISE

### Claude's response (Round 5 triage → PLAN.md v6)

Verification before triage: Codex's reuse claim checked against the repo — `RepositoryLock` exists at src/git/repositoryLock.ts (heartbeat-renewed owner record `{nonce, pid, heartbeatAt}`, default 5s heartbeat, `RepositoryLockBusyError` on live contention, dead-owner takeover, nonce-validated release, `isProcessLive(pid)`), already used by src/activation/repositoryMode.ts:120. Claim is accurate.

- #33 FIXED — v5's bespoke lease lock deleted. v6 reuses `RepositoryLock` pointed at `globalStorageUri/reviewPrompt/`: heartbeat renewal means a suspended owner goes provably stale instead of age-guessed; takeover requires stale AND dead. Resumed-owner fencing added at the state layer: an ownership re-check (lock-owner nonce match) runs immediately before every rename commit — mismatch → abort silently, no reservation, no toast. Pinned as the resumed-suspended-owner fence test.
- #34 FIXED — same reuse: `RepositoryLock`'s nonce-validated single-winner takeover replaces read/unlink/open('wx'). Simultaneous dead-owner contenders → at most one toast (reviewPrompt-level test; takeover atomicity itself is the class's own tested contract).
- #35 FIXED — Rate/Decline terminal mutations now route through the same queue + lock + reconcile path with terminal-monotonic merge and pre-rename ownership re-check. On `RepositoryLockBusyError`: retry ×5 with jitter; still busy → terminal written to the Settings-Sync mirror immediately (terminal-wins reconciliation lands it in the file on any future pass) + logged. Test: a pending reservation from a stale snapshot can never overwrite `rated`/`declined`.
- #36 FIXED — gate restructured into two tiers. Pre-gate (outside lock) = setting + usage counters + session flag ONLY; decision fields (`status`/`askCount`/`snoozedUntil`) never gate outside the lock. Under the lock, reconciliation (fresh file read + mirror merge, terminal-monotonic/max) and atomic write-through of the reconciled record happen BEFORE any decision gate can return — including when gating subsequently fails. Divergent-host tests for absent/corrupt/existing files.
- #37 FIXED — mirror writes are best-effort after durable file persistence (`.catch(log)`, never awaited on the user-action path): mirror rejection after reserve → toast still shows; after `rated` → `openExternal` still fires. Both rejection paths tested.

Disposition: 5 FIXED. PLAN.md rewritten as v6. Cumulative: 35 FIXED, 1 REJECTED (#2, live-registry evidence), 1 superseded (#13→#20→#27/#28→#33/#34 lineage).

## MAX_ROUNDS reached — deadlock protocol

MAX_ROUNDS=5 consumed; verdict at the cap = REVISE. Per protocol this does NOT converge on paper — but there are **zero contested positions**: every Round-5 finding was accepted and incorporated into v6, nothing is disputed, and the one REJECTED item (#2) died on live evidence back in Round 1. The v6 revision itself has not been seen by Codex. Decision handed to the human: accept v6 as-is, authorize one paid confirmation round on v6 (Round-5 session resumable at 55%), or stop.

**Human arbitration (Mahesh):** authorize one confirmation round → Round 6 below.

## Round 6 — user-authorized confirmation round (past cap) — Codex (gpt-5.6-sol, effort xhigh, resumed session 019fbc87)

Delta scope: only the v6 changes, plus an explicit instruction to verify the `RepositoryLock` reuse claims against the real class. Telemetry: PEAK=184829 LAST=184829 PCT=71% → still resumable.

38. [CRITICAL] PLAN.md Approaches 4, 5(h), and 6 — After the busy-lock fallback writes a terminal status to one Memento cache, the lock holder can resume and mirror its stale `pending` record, overwriting the only terminal copy before reconciliation. Fix: Never write `pending` to the status mirror and retain/retry the terminal until committed to the file; test this holder-resumes-after-fallback interleaving.
39. [REQUIRED] PLAN.md Approach 5(f) / src/git/repositoryLock.ts — `RepositoryLock.acquire()` returns only a release callback while the owner nonce, lock path, and owner reader are private, so the required caller-side ownership re-check cannot be implemented through the actual API. Fix: Add a backward-compatible acquisition handle exposing an authenticated `isOwner()` check and use it before every state rename.
40. [REQUIRED] PLAN.md Approach 5(g,h) / src/git/repositoryLock.ts — The release callback is idempotent but can reject when `rm()` fails, so awaiting it uncontained in `finally` prevents the subsequent mirror and toast after an ask was already reserved. Fix: Catch and log release rejection in the review-prompt path, continue step 5(h), and add a release-failure regression test.
41. [REQUIRED] PLAN.md Approach 5(c) / src/git/repositoryLock.ts `isProcessLive` — The implementation treats every `process.kill(pid, 0)` error except `EPERM` as dead, not only `ESRCH`, so it does not provide the plan's claimed provably-dead takeover semantics. Fix: Return dead only for `ESRCH`, treat unknown errors as live/busy, and test the fail-closed case.

VERDICT: REVISE

### Claude's response (Round 6 triage → PLAN.md v7)

All four verified against the real source (src/git/repositoryLock.ts read in full): `acquire()` does return a bare `() => Promise<void>` with `owner`/`lockPath` captured privately; the release closure awaits `rm()` uncontained; `isProcessLive` returns `true` **only** for `EPERM` and `false` for every other errno. Codex is right on all three code claims, and #38's interleaving is real. No disputes.

- #38 FIXED — the mirrored `status` key is now **terminal-only** (`rated`/`declined` only; absence = pending) and every mirror update is a **merge-write** (read mirror → terminal-monotonic → write), so a resumed holder mirroring its reserved `pending` record cannot clobber a terminal that reached the mirror first. Holder-resumes-after-fallback interleaving pinned as a test.
- #39 FIXED — additive API: `RepositoryLock.acquireHandle(commonDir) → { release, isOwner }` holds today's logic; `acquire()` becomes `(await this.acquireHandle(dir)).release`, so `src/activation/repositoryMode.ts:120` is untouched. `isOwner()` re-reads the lock file and compares the private nonce; missing/corrupt/unreadable → `false` (fail closed). Called immediately before every state rename.
- #40 FIXED — release in `finally` wrapped in its own try/catch-log; step 5(h) (mirror + toast) always proceeds after a reserved ask. Release-failure regression test added.
- #41 FIXED — shared-code bug repaid: `isProcessLive` reports dead only on `ESRCH`, live on `EPERM` and on any unrecognized errno (fail closed). Per-branch unit tests; also hardens the existing repository-mutation lock in the safe direction.
- Plan also now pins the real lock construction (`lockDirectory` + `lockFileName` options; `commonDir` unused for this domain) and its actual 5 s heartbeat / 30 s stale window, replacing v6's vaguer "pointed at globalStorageUri".

Disposition: 4 FIXED. PLAN.md rewritten as v7. Cumulative: 39 FIXED, 1 REJECTED (#2, live-registry evidence), 1 superseded (#13→#20→#27/#28→#33/#34 lineage). Six rounds run, every finding accepted or evidence-rejected, zero contested positions.

**Human arbitration (Mahesh):** yield had not decayed (R5: 5, R6: 4) → authorize Round 7 → below.

## Round 7 — second user-authorized confirmation round — Codex (gpt-5.6-sol, effort xhigh, resumed session 019fbc87)

Delta scope: v7 changes only, plus explicit orders to verify the `acquireHandle`/`acquire` refactor's backward compatibility, `isOwner()` soundness across the rename-takeover window, and the `isProcessLive` change against existing takeover behavior.

42. [CRITICAL] PLAN.md Approach 6 — After five busy retries, a rejected terminal mirror merge leaves neither the file nor mirror containing the Rate/Decline decision, so the user can be prompted again. Fix: Retain the terminal intent until a durable local store accepts it, and add a combined busy×5-plus-mirror-rejection test.
43. [CRITICAL] PLAN.md Approaches 5(h) and 6 — Terminal-only mirroring prevents overwrite but does not stop a holder that already passed the decision gate from resuming, committing its reservation, and showing a toast after another host recorded a terminal decision. Fix: Establish a lock-independent terminal fence checked immediately before reservation commit and toast display, and assert zero toast in this interleaving.
44. [REQUIRED] PLAN.md Approaches 5(d,f) / Key decisions — The plan promises `isOwner()` before every state rename but specifies it only for reservation and terminal mutations, leaving reconciliation write-through unfenced after ownership loss. Fix: Require `handle.isOwner()` immediately before the reconciliation rename and test ownership loss during write-through.

VERDICT: REVISE

### Claude's response (Round 7 triage → PLAN.md v8)

#43 is worse than Codex framed it: it needs no suspension and no takeover. Window B's Rate hits `BusyError` because window A *legitimately* holds the lock, falls back to the mirror; A resumes, `isOwner()` is still true, and it commits its reservation and toasts a user who has already rated. #42 and #43 therefore share one root cause — the fallback's "durable store" was the Memento mirror, which is neither durable nor cross-host fresh. Fixing that root cause resolves both, and Codex's per-finding fixes are subsumed by it rather than applied literally.

- #42 + #43 FIXED by one structural change — **terminal decisions leave the lock entirely**. New write-once terminal latch `globalStorageUri/reviewPrompt/terminal.json`, written with flag `'wx'` **without the lock**, never deleted or overwritten; `EEXIST` = already durable (first-durable wins, same rule as before). Rate/Decline now: set in-process intent synchronously → write the latch → mirror best-effort → `openExternal`. No lock retries, no mirror-only fallback, no window where the decision exists nowhere; if the latch write itself fails, the in-process intent silences that window and every later queued cycle retries the latch first. The latch is a **lock-free fence checked at three points** — pre-gate, immediately before the reservation rename, immediately before the toast — which is exactly the lock-independent fence #43 asked for. `status` is removed from `state.json` entirely; the ledger now holds only `askCount`/`snoozedUntil`/`lastAskAt`, so the lock protects only the read-modify-write it is good at.
- #44 FIXED — `handle.isOwner()` now also precedes the reconciliation write-through rename; ownership-loss-during-write-through is a pinned test.
- Residual recorded honestly in Risks: the pre-toast check and `showInformationMessage` cannot be atomic across processes, so a terminal landing in the microseconds between them still yields one toast. Sub-second, non-repeating (the latch is permanent).

Disposition: 3 FIXED. PLAN.md rewritten as v8. Cumulative: 42 FIXED, 1 REJECTED (#2), 1 superseded. Seven rounds, 44 findings, zero contested positions.

**Human arbitration (Mahesh):** Round 8 authorized as the FINAL round, declared terminal — APPROVED or MINOR-only → straight to build; a new CRITICAL stops the auto-build.

## Round 8 — FINAL — Codex (gpt-5.6-sol, effort ultra, fresh session 019fbf81, full-document sweep, reseeded from PLAN.md v8 + the 44-finding ledger)

45. [CRITICAL] PLAN.md Approach 6 / Terminal-durability tests — If latch creation rejects before leaving `terminal.json` and the extension host restarts before another queued success, the in-memory intent disappears, so a first- or second-ask user can be prompted again after snooze. Fix: Require a restart-readable fallback before response completion, reconcile it during initialization, and test a newly constructed service after latch rejection.
46. [CRITICAL] PLAN.md Approach 4/6 / src/git/repositoryLock.ts — `'wx'` makes file creation exclusive but does not atomically publish completed JSON, so another writer can receive `EEXIST` while the first write is incomplete or failed and mirror a different status, violating first-durable semantics and allowing latch/mirror divergence. Fix: Atomically publish a complete winner and validate/read it after `EEXIST` before mirroring; test a paused or failed first writer plus rated-versus-declined contenders.

VERDICT: REVISE

### Claude's response (Round 8 triage → PLAN.md v9)

Both real. #46's sharpest edge is one Codex only half-states: `'wx'` publishes existence, not content, so a writer that dies between create and write leaves an empty latch — and v8 had two readers disagreeing about it (`stat` at the pre-gate would call it terminal, a JSON parse during reconciliation would not), which is a re-ask hole.

- #45 FIXED — on latch-write failure the response handler writes the terminal to the **Settings-Sync mirror** before `openExternal` (`globalState` is restart-readable and already the seeding source), and **service init reconciles mirror→latch**, so a window that dies before its retry still recovers on the next start. Loss now needs latch + mirror + retry to all fail. Test: freshly constructed service after latch rejection never asks.
- #46 FIXED without new machinery — **existence is authoritative, content is advisory**: every reader treats an existing latch as terminal whether or not it parses, and never repairs it; on `EEXIST` the loser reads the *winner's* content and mirrors that, never its own, so rated-vs-declined contenders cannot diverge latch from mirror. Tests for the paused/failed first writer and for contending statuses.

Disposition: 2 FIXED. PLAN.md rewritten as v9. Cumulative: 44 FIXED, 1 REJECTED (#2), 1 superseded. Eight rounds, 46 findings, zero contested positions — and no round has yet come back clean.

## Review closed by arbitration → PLAN.md v10

Claude's recommendation to the owner, after Round 8: rounds 4–8 produced 17 findings, 11 of them CRITICAL, and **every one lived in the cross-window locking machinery** — nothing else in the plan has produced a finding since Round 3. That machinery bought exactly one property (two windows cannot each consume an ask in the same second). It never carried the never-ask-again guarantee; the write-once latch does that alone. Cost/benefit favoured deleting the defect class.

**Human arbitration (Mahesh):** simplify, then build.

v10 = v9 minus the ask lock, the lock-protected ledger file, `isOwner()` fencing and the `RepositoryLock.acquireHandle()` extension. Retained: the terminal latch (existence authoritative, content advisory, `EEXIST` mirrors the winner), reserve-before-show, the dispatcher-guarded hook, mirror→latch reconciliation at init, and the whole counting/routing/l10n/test/acceptance apparatus. The `isProcessLive` fail-open fix (#41) is **kept as a standalone drive-by** — it is a real bug in shared code and does not depend on our design. Accepted price, recorded in Risks: one duplicate toast, and a cap that can soften by one ask per snooze cycle, for users with several windows crossing the threshold simultaneously.

Final ledger: 46 findings — 44 FIXED, 1 REJECTED (#2, live-registry evidence), 1 superseded. Findings #33–#40, #44 and the lock halves of #35/#42/#43 are **obsoleted by the v10 simplification** (the code they constrain no longer exists); their non-lock halves survive in the latch design.

## Act 3 — Build

Builder: Claude (direct), TDD-first, all repo validation gates per Approach 12.

### Built

- `src/services/reviewPrompt.ts` — `ReviewPromptService` (write-once latch + Memento counters + Settings-Sync mirror), `countsAsSuccess`, `getReviewUrl`, `registerReviewPrompt`.
- `src/git/executor.ts` — module-scoped `setGitSuccessListener` / `notifyGitSuccessSafely`, fired from `run()` after success and filtered to `commit`/`push`; `run()` split so the mutation-gate branch lives in `runGated`.
- `src/services/publishService.ts` — the askpass push reports its own success, since it bypasses the executor.
- `src/extension.ts` — registered in `activate()` before the mode dispatch, so the no-repository → repository transition is covered.
- `src/git/repositoryLock.ts` — drive-by fix: `isProcessLive` reports dead only on `ESRCH`; `EPERM` and unrecognized errnos are live.
- Setting `intelligit.reviewPrompt.enabled` (scope `application`) + 4 strings across `package.nls.*` and `l10n/bundle.l10n.*` for all 11 locales, CSV re-synced; README + CHANGELOG.

### Deviations from v10

- **No in-process latch-retry ladder.** Once a decision is made the window is silenced, and the Settings-Sync mirror already carries it across restarts (init seeds the latch from the mirror). The retry only mattered when latch *and* mirror both failed, which the plan already books as an accepted residual.
- **Counting is classified per subcommand.** `-n` is `--dry-run` for `push` but `--no-verify` for `commit`, so a global exclusion list would have silently dropped every `commit -n`. Found while implementing; pinned by test.
- **Storage path resolves inside `init()`, not the constructor.** Caught by the extension integration suite: a context without `globalStorageUri` threw synchronously, and `void registerReviewPrompt(...)` turned that into an unhandled rejection during activation. Containment now covers construction and registration, with a regression test.

### Gates

`format:check` ✓ · `lint:strict` ✓ · `lint:complexity` ✓ · `architecture:check` ✓ · `l10n:sync|validate|translate --only-missing|audit` ✓ (audit adds no findings) · `typecheck` ✓ · `build` ✓ · `vitest run` 2145/2145 in 137 files, 0 unhandled errors ✓ · `test:coverage` ✓ (93.28 lines / 84.99 branches / 90.6 functions against floors 88.5 / 80.5 / 83; `reviewPrompt.ts` 98.19 / 91.37 / 100).

`deps:check:strict` still reports the 7 unused devDependencies and 8 unlisted binaries that predate this branch (identical set at `36e43d03`); tracked separately.

The new lock tests were verified non-vacuous by temporarily restoring the fail-open `isProcessLive` — the unrecognized-errno case fails against it.

### Not run

The four dev-host acceptance scenarios need a human `F5` in the Extension Development Host; they cannot be driven from this environment. Steps are in Approach 11.
