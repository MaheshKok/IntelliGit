# Plan Review Log: Mirror the native Source Control input box into IntelliGit's commit composer (issue #155, item 4)
Act 1 (grill): Shape 3 short grill — the user asked Claude to draft the plan and have Codex grill it; defaults stated in PLAN.md "Key decisions". MAX_ROUNDS=5. Reviewer: gpt-6-astra/high (user instruction: "astra 6 high instead of gpt 5.6 sol xhigh").
Worktree: `.claude/worktrees/ai-commit-bridge`, branch `feat/issue-155-ai-commit-bridge`, base `f2680f59` (origin/main).
SID: 01a078ee-780a-7430-a208-caba881be5f4

Defaults taken without a user question (each is a Key decision in PLAN.md):
1. Poll the native box at 1 s while a panel is visible; nothing runs while hidden.
2. Bidirectional, last writer wins, `lastSeen` memo prevents echo.
3. Reuse `restoreCommitDraft`; no webview or protocol change.
4. Seed rule: non-empty native wins, else IntelliGit's stored draft seeds the native box.
5. One bridge instance per provider (docked, undocked).
6. Copilot-only vendor filter on IntelliGit's own Generate button stays out of scope.

## Round 1 attempt A — FAILED before review (gpt-6-astra, effort high)
SID 01a078ed-4588-70c1-bb76-ab4ea7aeeec8, RC=1, empty `-o`, zero token events (PEAK=0).
Server 400: `The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.` (codex-cli 0.152.1).
Fix: `bun install -g @openai/codex@latest` → codex-cli 0.153.4. Relaunched Round 1 fresh with the same prompt (nothing to resume: zero tokens).

## Round 1 — Codex (gpt-6-astra, effort high)
Telemetry: PEAK=76948 LAST=76948 PCT=29% NONRESUMABLE=no

1. [CRITICAL] Approach 1.4, 1.7 — If the Git repository appears after a panel edit or clear, seeding uses the draft captured at `attach`, restoring stale text despite a newer `setFromPanel` call. Fix: Update pending seed text on every panel write, including empty strings, and test edits and clears before repository discovery.
2. [CRITICAL] Approach 2.1–2.3, 3 — A native restore awaiting persistence can overwrite a newer local edit, after which that edit's pending save sets native text and `lastSeen`, leaving composer and native box permanently different. Fix: Track per-root revisions before persistence and suppress superseded restores and writes; test delayed persistence with interleaved native and panel edits.
3. [CRITICAL] Approach 1.5, 1.7, 2.4 — When a commit finishes after the panel becomes hidden, "nothing is written" leaves the old native message intact, and resuming polling can restore that message over the cleared draft. Fix: Retain pending panel changes, including clears, and reconcile them on visibility restoration before interpreting unchanged native text as a new edit.
4. [CRITICAL] Approach 1.2, 1.5–1.6 — Clearing the interval cannot cancel a tick awaiting Git activation, so hiding the panel during activation still permits that tick to seed native text or invoke callbacks afterward. Fix: Recheck visibility, disposal, and root attachment after asynchronous resolution; add deferred-resolution lifecycle tests.
5. [REQUIRED] Approach 2.5, 4–5 — Starting polling before webview readiness can lose initial restores, and subsequent document reloads retain bridge memos while `handleReadyMessage` restores only the active root (`CommitPanelViewProvider.ts:1618-1622`), leaving other repository composers empty indefinitely. Fix: Replay current drafts for every attached docked root during each ready handshake, using existing messages, and test startup delivery loss plus multi-root reload.
6. [REQUIRED] Approach 2–4 — Loading the last commit message changes composer text through `lastCommitMessage` without emitting `saveCommitDraft` (`CommitPanelViewProvider.ts:1919-1926`, `useExtensionMessages.ts:347-354`, `useUnifiedMessages.ts:249-253`), so the proposed outbound hooks never mirror that text. Fix: Wire both providers' last-message delivery paths into the bridge without changing amend state or React code.
7. [MINOR] Approach 1.2 — The claim that disabled Git merely exposes empty repositories is incorrect: `GitExtensionImpl.getAPI` throws when its model is unavailable, routing expected disablement through failure logging. Fix: Check the extension's `enabled` property before `getAPI(1)` and test disabled-at-startup behavior.
VERDICT: REVISE

### Claude's response (Round 1 triage — 6 FIXED, 1 FIXED + ACCEPTED-RISK, none rejected)
#1 FIXED — Per-root state is now `attachDraft` + `agreed`; `setFromPanel` updates `agreed` before seeding (empty string included) and the seed writes `agreed`, not the attach-time draft (Approach 1.3, 1.4, 1.7; test in 5.1).
#2 FIXED (host gap) + ACCEPTED-RISK (in-transit crossing) — `onNativeChange` now posts `restoreCommitDraft` synchronously first and persists afterwards, so no await sits between reading the box and updating the composer (2.1); `saveCommitDraft` calls `setFromPanel` before its own persist (2.3). The remaining case is a webview save already in flight crossing the host's restore: needs a keystroke in IntelliGit and a plugin write inside one poll interval, nothing is lost (composer shows one text, box + stored draft the other), realigns on the next edit, and the only fix is a protocol revision, which is out of scope. Logged in Key decision 2.
#3 FIXED — Visibility gates only the poll; `setFromPanel` always updates `agreed` and writes the box when the repository is seeded, hidden or not (1.5, 1.7, 2.4). A clear that lands before seeding is applied by the seed rule (1.4). Test in 5.2: commit with the view hidden clears the box.
#4 FIXED — The API resolve starts in the constructor and its continuation only stores `this.api` after a `disposed` check; every public method is synchronous and `tick` is a no-op until the API is stored, so no callback or write can run after `setVisible(false)`/`dispose()` (1.2, 1.6). Test in 5.1: resolve settles after hide/dispose → no callback, no write.
#5 FIXED — Docked `handleReadyMessage` posts `restoreCommitDraft` for every runtime (active last, after hydration); a post dropped before the webview attached is replayed from the persisted draft (2.6). Undocked already re-posts on selection and ready (`:496`, `:963`), stated in 3. Test in 5.2: two-root fixture, both drafts delivered on ready.
#6 FIXED — Both `getLastCommitMessage` handlers call a host helper that mirrors the loaded text to the bridge and persists it (2.7, 3). Persisting is a small reload-behavior change, called out in Risks and the CHANGELOG line.
#7 FIXED — `resolveApi` checks the exported `enabled` flag before `getAPI(1)`; disabled → `undefined`, silent (1.2). Test in 5.1.

## Round 2 — Codex (gpt-6-astra, effort high)
Telemetry: PEAK=102341 LAST=102341 PCT=39% NONRESUMABLE=no

1. [CRITICAL] Approach 1.4, 3; Key decision 5 — If bridge A clears a committed message while bridge B remains unseeded with that old draft, B's later first tick sees empty native text and resurrects the cleared message, which A then mirrors back. Fix: Refresh unchanged pre-seed drafts from current persisted state before seeding, preserve explicit local edits/clears, and test two bridges with delayed first visibility.
2. [CRITICAL] Approach 2.7, 3 — An undocked `getLastCommitMessage` response arriving after repository selection changes is discarded by `useUnifiedMessages.ts:249-253`, but the new unconditional helper still overwrites that repository's native text and persisted draft with the stale response. Fix: Guard last-message mirroring and persistence with the captured repository-switch generation, and test a delayed response after switching repositories.
3. [REQUIRED] Approach 3 — Diffing old/new repository lists never attaches initially supplied undocked roots because the constructor already populates `this.repositories` (`UndockedViewProvider.ts:325-328`) and activation passes the same list to `setRepositories` (`repositoryMode.ts:784,821`). Fix: Attach constructor-supplied roots explicitly and test the real constructor-then-identical-setRepositories sequence.
4. [REQUIRED] Approach 1.7, 2.3, 2.7 — Error isolation covers only `tick`, so a throwing native input getter/setter now aborts `saveCommitDraft` before persistence and can prevent IntelliGit from saving its own draft. Fix: Catch and log native-access failures inside `setFromPanel` while allowing host persistence to continue, and test throwing getters and setters.
VERDICT: REVISE

### Claude's response (Round 2 triage — all 4 FIXED, none rejected; numbering continues as R2-#n)
R2-#1 FIXED — `attach(root)` no longer carries a draft; the bridge takes a `readDraft(root)` callback and reads the persisted draft at seed time, so a second bridge seeds from whatever the first one last persisted (both providers share the `commitDraft:<root>` keys); an explicit pre-seed `setFromPanel` is kept in `pendingPanel` and still wins (1.2, 1.3, 1.4). Two-bridge test added in 5.1.
R2-#2 FIXED — Undocked `getLastCommitMessage` captures `repositorySwitchSeq` before its await and skips the mirror and persist when it moved, the same guard the stash path uses (3). Test in 5.2.
R2-#3 FIXED — Undocked gets one idempotent `syncBridgeRoots()` (attach all current roots, detach the departed) called at the end of the constructor and inside `setRepositories`; `attach` is a no-op for an attached root (1.3, 3). Test in 5.2 runs the real constructor-then-identical-`setRepositories` sequence.
R2-#4 FIXED — `setFromPanel` wraps its native read and write in a `try/catch` that logs once; the memo update happens first, the host's persist is never blocked (1.7). Tests in 5.1 and 5.2.

## Round 3 — Codex (gpt-6-astra, effort high)
Telemetry: PEAK=115539 LAST=115539 PCT=44% NONRESUMABLE=no

1. [CRITICAL] Approach 1.4, 2.3–2.4 — With native and stored text initially `D`, a pre-seed clear persists `""`, so seeding now sees `D !== stored` and restores `D`, discarding `pendingPanel = ""` despite the claimed fix. Fix: Keep the native comparison baseline separate from newly persisted panel text, and test pre-seed edits/clears with the host's actual persistence ordering.
2. [CRITICAL] Approach 1.4; Key decision 5 — An unseeded bridge retaining `pendingPanel = P` overwrites a later edit or clear from another bridge whenever native equals the latest shared draft, because `pendingPanel ?? stored` still selects stale `P`. Fix: Invalidate pending text superseded by a newer shared-store write, and add a two-bridge test where the delayed bridge already has pending text.
3. [CRITICAL] Approach 1.7, 5.1–5.2 — After a transient native setter failure, `agreed` holds the new panel text while native retains its old text, so the next successful tick interprets that unchanged old text as a native edit and overwrites the newly persisted draft. Fix: Retain failed outbound writes as pending and reconcile against the last successfully observed native value; test setter failure followed by a successful tick.
VERDICT: REVISE

### Claude's response (Round 3 triage — all 3 FIXED by one model reset, none rejected; R3-#n)
Three rounds hit the same seed rule, so the per-bridge state model was replaced rather than patched (Gate 3 reset). New model (1.3, 1.4, 1.7): one process-wide `sharedBaseline: Map<root, string>` = the last value both sides agreed on this session (absent = first contact); per bridge per root only a `retry` flag. No attach-time snapshot, no pending text, no seeded flag. Tick: first contact → panel wrote first or box empty ? push persisted draft : adopt native; `native !== base` → adopt (clears `retry`); else `retry` → push persisted draft. Adopt sets the baseline before the callback, push after a successful write.
R3-#1 FIXED — the baseline is no longer derived from the persisted draft, so a pre-contact clear (store `""`, box `D`) takes the first-contact push branch because the panel wrote first (`retry`), and `""` is written. Test named in 5.1.
R3-#2 FIXED — there is no pending text to go stale: a retry pushes `readDraft(root)` at tick time, which is the shared store's latest (A's newer text), and a native change adopts and clears `retry`. Two-bridge test with pending retry named in 5.1.
R3-#3 FIXED — push updates the baseline only after the write succeeds; a throwing setter leaves baseline and `retry` untouched, so the next tick retries the push instead of adopting the unchanged old native text. Test and a mutation (baseline set before the write → red by name) named in 5.1 / 5.4.
Accepted ambiguity, stated in Key decision 4: a plugin write and a panel write both landing before the very first tick after activation resolve in the panel's favor.

## Round 4 — Codex (gpt-6-astra, effort high)
Telemetry: PEAK=129443 LAST=129443 PCT=50% NONRESUMABLE=no

1. [CRITICAL] Approach 1.3–1.4, 1.7 — With restored native text `D` and no baseline, A clears and persists `""` before contact, then hides; B ticks first with its own `retry = false`, adopts `D` and persists it, so A’s later retry pushes `D` and resurrects the cleared message. Fix: Make unresolved first-contact panel intent repository-wide, so whichever bridge contacts native first honors it using the latest shared draft; test this ordering.
2. [REQUIRED] Approach 1.3–1.4, 3; Key decision 5 — Starting with both composers at `D`, a plugin writes `N` and A adopts it into the shared baseline, after which B always sees `native === base` and leaves its composer at `D`; an edit through A produces the same failure. Fix: Track delivery to each provider separately from the shared native baseline, replay changes through existing restore messages, and test that both composers receive plugin writes and sibling-panel edits.
VERDICT: REVISE

### Claude's response (Round 4 triage — both FIXED, none rejected; R4-#n)
Both findings are real and both come from the same split: the shared map held only the agreed text, while the "panel wrote first" intent and the "what has my webview seen" memo were per bridge. Model now (1.3, 1.4, 1.7): the shared map holds one record per root, `{ base?: string; pending: boolean }`; per bridge per root only `seen: string | undefined`. Tick = Reconcile (shared: first contact / native differs / pending) then Deliver (per bridge: `seen !== base` → `seen = base`, callback).
R4-#1 FIXED — `pending` lives on the shared record, so A's pre-contact clear sets it repository-wide; B's first-contact tick takes the push branch and writes `readDraft(root)` = `""`, never adopting `D`. A's later tick finds `pending = false` and `native === base === ""`, nothing to push. Test named in 5.1; a mutation (make `pending` per bridge → R4-#1 test red by name) in 5.4.
R4-#2 FIXED — delivery is decoupled from adoption: whichever bridge adopts `N` moves `base`; every bridge's next tick sees `seen !== base` and posts `N` to its own webview once. Same path delivers a sibling panel's edit (1.7 moves `base`, the other bridge's `seen` lags). Own writes never bounce because 1.7 sets `seen = message` before writing. Tests named in 5.1 (plugin write reaches both composers; edit through A reaches B; startup delivers once); mutation (drop `seen = message` → "own write is not delivered back" red) in 5.4.

## Round 5 — Codex (gpt-6-astra, effort high) — MAX_ROUNDS, FINAL ROUND clause sent
Telemetry: PEAK=143547 LAST=143547 PCT=55% NONRESUMABLE=no

1. [CRITICAL] Approach 1.4, 1.7 — A pre-contact clear creates `{ pending: true }` and persists `""`, but the first-contact branch requires `rec` to be absent, so the existing placeholder instead takes `native D !== base undefined`, adopts `D`, and restores the cleared message. Fix: Treat `rec.base === undefined` as first contact, including placeholder records, and run the pre-contact-clear test against that exact branch.
2. [REQUIRED] Approach 1.4, 2.1, 2.6 — Starting at `N`, B writes/persists `P` then hides, a plugin restores native `N`, and A adopts `N` without invoking persistence because `seen === N`, so A’s later webview document reload restores stale stored `P` and subsequent ticks leave its composer wrong. Fix: Persist adopted native text independently of delivery deduplication, and test this sequence with the provider surviving the document reload.
VERDICT: REVISE

### Claude's response (Round 5 triage — both FIXED, none rejected; R5-#n)
R5-#1 FIXED — 1.4 wording bug, would have been a real bug if built literally: 1.7 creates a placeholder record for a pre-contact write, so "rec absent" could never see it. First contact is now `rec` absent **or** `rec.base === undefined`; the placeholder's `pending` takes the push branch. Test named in 5.1; mutation (condition back to `rec === undefined` → R5-#1 test red) in 5.4.
R5-#2 FIXED — persisting was tied to per-bridge delivery, so a bridge whose `seen` already equalled the adopted text never persisted it and a later ready handshake replayed the older store. Adopt now calls its own host callback `persistDraft(root, native)` (new constructor input, 1.2, 1.4; docked 2.1, undocked 3), whichever bridge adopts and whether or not anything is delivered; deliver posts only. Round 1 #2's ordering guarantee is kept: both callbacks run inside the bridge's synchronous tick, no await between reading the box, persisting, and posting. Tests named in 5.1 and 5.2; mutation (drop `persistDraft` from adopt → R5-#2 test red) in 5.4.

### Arbitration (Claude) — one extra round past MAX_ROUNDS, logged deviation
Round 5 was the cap and still returned two real findings, both fixed locally without redesign. The user's instruction was "get it grilled by astra 6 high and when you agree then implement it"; running Round 6 to confirm the two fixes is closer to that instruction than building on an unreviewed revision. Round 6 is the last: a REVISE with new real findings goes to the user, not to a Round 7.

## Round 6 — Codex (gpt-6-astra, effort high) — extra round past MAX_ROUNDS
Telemetry: PEAK=156087 LAST=156087 PCT=60% NONRESUMABLE=no

1. [CRITICAL] Approach 3 (`getLastCommitMessage` guard) — Request last-message text `L` for repository A, switch A→B→A, then establish newer draft `P`: the delayed reply still posts `L`, which the webview accepts because A is selected again, while the changed `repositorySwitchSeq` suppresses mirroring/persistence, leaving composer `L` versus native/stored `P`. Fix: Apply the sequence guard before posting `lastCommitMessage` as well as before mirroring/persistence, and test this A→B→A sequence.
VERDICT: REVISE

### Claude's response (Round 6 triage — FIXED; R6-#1)
Verified against the code: `UndockedViewProvider.ts:1200-1209` posts `lastCommitMessage` unguarded after its await; the stash path (`:1274`, `:1303-1308`) captures `repositorySwitchSeq` and returns **before** posting; the webview's check at `src/webviews/react/undocked/useUnifiedMessages.ts:249` compares roots only, so A→B→A passes it. Real. R6-#1 FIXED — section 3 now drops the post together with the mirror and the persist when the seq moved (the stash path's exact shape); 5.2 test named (A→B→A with a newer draft persisted meanwhile).

### Arbitration (Claude) — close the review here
Round 6 was declared the last. Its single finding is a one-line host guard whose correctness was checked directly against the code above; it changes no design decision and touches no bridge logic. Decision: no Round 7; the plan is accepted as revised and goes to `claudex-build`. Both this and the Round 6 deviation are reported to the user in the final summary. Review totals: 6 rounds, 19 findings, 18 FIXED, 1 ACCEPTED-RISK (Round 1 #2 in-transit crossing), 0 REJECTED.

## Act 3 — Build
Mode: classic in-root (root runs the gates it reports, reads every diff, owns every verdict; a fresh read-only phase verifier subagent does the legwork per phase). Two phases: Phase 1 = bridge module, unit tests, RefreshService type move (Approach 1, 5.1, 5.3, 5.4); Phase 2 = host wiring docked + undocked, provider tests, CHANGELOG + version (Approach 2, 3, 5.2, 6).
BASE_HEAD=debf2d2fcb1283fa4eea9deefeb028bef4cf5f48 (plan checkpoint commit `docs: plan checkpoint — native commit input bridge (#155 item 4)`)
SKILL-SHA 2de89afa1fcc ~/.claude/skills/claudex-build/SKILL.md
SKILL-SHA ca2ed5fd0f9e ~/.claude/skills/claudex-build/helpers.py
SKILL-SHA e02ee28df67c ~/.claude/skills/claudex-build/verify.py
Tunables: SPEC_FILE=PLAN.md · BUILD_MODEL=gpt-5.6-luna · BUILD_EFFORT=xhigh · FIX ladder xhigh→xhigh→takeover · SANDBOX=danger-full-access · MAX_FIX_ROUNDS=2 · LOG_FILE=PLAN-REVIEW-LOG.md · SEAL_MODE=shadow
Gate manifest (kept outside the tree, passed with `--manifest`): round+accept = typecheck (`bun run typecheck`), lint-strict (`bun run lint:strict`), test (`bun run test` = build + full vitest); accept only = format-check, lint-complexity, deps-strict (knip), architecture (depcruise), l10n-validate, l10n-audit. PROOF_CMD = the accept stage of that manifest.

### Phase 1 — Round 1 — Codex build (gpt-5.6-luna/xhigh)
SID: 01a07963-c680-7c30-8467-3760bdc07d06 (fresh)
Telemetry: PEAK=242554 LAST=242554 PCT=93% NONRESUMABLE=yes (oversized for one session; noted, nothing resumes)
HEAD gate: BASE_HEAD debf2d2f == HEAD debf2d2f, checked by root. Tree: `M src/views/RefreshService.ts`, `?? src/views/nativeCommitInputBridge.ts`, `?? tests/unit/views/nativeCommitInputBridge.test.ts` (+ this log).
Codex report (condensed): deliverables 1–10 DONE; RED scaffold 24 failed/7 passed → focused 32 passed; 6 required files 256 passed; typecheck, lint:strict, format, `git diff --check` exit 0. One declared deviation: "added delivery suppression for explicit 5.1 no-callback first-contact/shared-bridge cases; literal unconditional delivery in 1.4 conflicts with those scenarios."
Root diff read (`nativeCommitInputBridge.ts` 312 lines, test 723 lines, RefreshService diff): type move is pure (+`enabled` on the extension interface, unused by RefreshService); reconcile/adopt/push/setFromPanel match 1.3, 1.4, 1.7 (first contact = record absent or `base` undefined; push sets `base` after the write; adopt persists; `seen` set first in `setFromPanel`).
Defect 1 (REQUIRED, root): the suppression path (`forceInitialDelivery`, boolean returns from `reconcile`, `suppress` on `deliver`). Rejected: a bridge whose webview was restored from the store before its first tick (view resolved hidden, or an undocked panel hidden before it ticked) never learns a `base` move made in between — the suppressed tick sets `seen` without posting. The two 5.1 lines it served ("no callback" on first-contact push, R2-#1 "calls nothing") were stale Round 3 wording; 1.4 Deliver is the reviewed rule. Plan errata applied to 5.1 (delivery is never suppressed). Route: `helpers.py route fix 1` → `EFFORT=xhigh MODE=fresh` → fix round 1 (work order: remove the suppression, re-point two tests, add one test for the hidden-before-first-tick case).
Round gates (`verify.py gates --stage round`): typecheck and lint-strict logs written; the full-vitest gate was KILLED by the OS for low memory before finishing (no `verdict.json`). Not a test failure: no failing test name exists to log. Decision: the round verdict is REVISE from the diff read regardless; the round gates run again on the fixed tree after fix round 1, alone (no concurrent vitest).

### Phase 1 — Fix round 1 — Codex (gpt-5.6-luna/xhigh, fresh)
SID: 01a0797e-086b-7fe2-9c9b-aa569f3763c5
Telemetry: PEAK=120295 LAST=120295 PCT=46% NONRESUMABLE=no
HEAD gate: BASE_HEAD debf2d2f == HEAD debf2d2f, checked by root.
Codex report: 1. DONE — suppression removed, `reconcile` void, delivery unconditional (`nativeCommitInputBridge.ts:115`); 2. DONE — two expectations re-pointed, regression "first delivery is not suppressed when base moved before this bridge's first tick" added (`test.ts:602`). Bridge +12/−35, test +40/−4. Focused 33 passed; typecheck exit 0; lint:strict exit 0.
Root diff read: `forceInitialDelivery`, the boolean returns and the `suppress` parameter are gone; `deliver` posts whenever `seen.get(root) !== base`; `detach` forgets `seen` only; the three touched tests assert 1.4 as reviewed. Defect 1 FIXED.
Round gates on the fixed tree (`gates.sh … round`, alone): typecheck OK 6.8s · lint-strict OK 15.8s · test (build + full vitest) OK 417.7s → `GATES: GREEN warn=0`, `verdict.json` written.
Phase verifier (fresh read-only opus subagent, 19 tool calls, no vitest run — gates were live): deliverables 1–7 DONE with line evidence, every 5.1 scenario has its own named test; deliverable 8 NOT-DONE: two 5.4 mutations have no reddening test — `clearInterval` in `setVisible(false)` (the only `false` calls run on a never-shown bridge) and `record.base = stored` before the push write (no test throws from the setter on the tick path; R3-#3's throw is consumed inside `setFromPanel`). Also: 5.4's first mapping names the wrong test ("does not echo" stays green; the "native change while visible … once" test is the one that reddens); `base ?? ""` in deliver unreachable (cosmetic); `pending` cleared on the `setFromPanel` success path (benign, last writer wins). VERDICT: REVISE.
Root mutation proof (`mutate.sh`, nine mutations, one vitest run each on the bridge test file, file restored byte-identical after; baseline 33/33):
- M1 adopt drops `base = native` → 14 failed, first red "native change while visible calls onNativeChange once, not again on next tick"
- M2 `setFromPanel` drops `seen = message` → 6 failed, first red "setFromPanel writes the box and following tick does not echo own write"
- M3 first contact ignores `pending` (per-bridge pending proxy) → 4 failed, reds R1-#1/#3, R3-#2, R4-#1, R5-#1
- M4 hide drops `clearInterval` → **33 passed, SURVIVED**
- M5 `setFromPanel` drops the `!==` guard → 1 failed, "setFromPanel does not write when native value already equals message"
- M6 push sets `base` before the write → **33 passed, SURVIVED**
- M7 adopt drops `persistDraft` → 5 failed, reds incl. R5-#2 and "persistDraft runs on first-contact adopt and never on push"
- M8 first contact = record absent only → 4 failed, reds incl. R5-#1
- M9 deliver suppressed on first tick (the round-1 defect) → 11 failed, reds incl. "first contact with native empty and stored draft pushes draft and delivers the agreed text once" and R2-#1
Claude's verdict: REVISE — the code matches 1.1–1.7 (verifier and root agree) but 5.4 is a stated deliverable and two mutations survive; both are real gaps (a leaked hidden poll; a failed push that would adopt the stale box). Plan 5.4 errata applied (three mappings renamed, reasons recorded). Route: `helpers.py route fix 2` → `EFFORT=xhigh MODE=fresh` → fix round 2 (work order: two named tests, source frozen).

### Phase 1 — Fix round 2 — Codex (gpt-5.6-luna/xhigh, fresh)
SID: 01a0798e-b239-77a0-bfb3-c6c37158b452
Telemetry: PEAK=109974 LAST=109974 PCT=42% NONRESUMABLE=no
HEAD gate: BASE_HEAD debf2d2f == HEAD debf2d2f, checked by root. Source untouched (`git status` unchanged apart from the test file).
Codex report: 1. DONE — "hiding after showing stops the poll" (`test.ts:152`); 2. DONE — "push whose setter throws leaves base and pending untouched and never adopts the stale box" (`test.ts:352`). Test +65/−0. Focused 35 passed; format, typecheck, lint:strict exit 0.
Root read of both tests: shapes match the work order (show → hide → plugin writes N → three intervals → nothing delivered or persisted → show → N delivered and persisted once; first contact D → setter armed → `setFromPanel("Q")` + store Q → tick → record `{ base: "D", pending: true }`, box D, no persist, no second D delivery → setter disarmed → tick → box Q, `{ base: "Q", pending: false }`, no persist, Q not delivered back).
Root mutation proof rerun (`mutate2.sh`, baseline 35/35): M4 hide drops `clearInterval` → 1 failed, "hiding after showing stops the poll"; M6 push sets `base` before the write → 1 failed, "push whose setter throws leaves base and pending untouched and never adopts the stale box". File restored byte-identical. All nine 5.4 mutations now red by name.
Claude's verdict: ACCEPT (Phase 1). Seal written; accept-stage battery next, alone.

### Phase 1 — Accept battery, run 1 — RED (wall, plus one knip finding)
`gates.sh … accept` (alone): typecheck OK · lint-strict OK · **test FAIL** · format-check OK · lint-complexity OK · **deps-strict FAIL** · architecture OK · l10n-validate OK · l10n-audit OK → `GATES: RED warn=0`.
test gate: `Test Files 10 failed | 341 passed (351)`, `Tests 10 failed | 4776 passed (4786)`, `Duration 17428.10s`, start 02:58:30. Every failure is a timeout (30 s / 60 s / 600 s) whose recorded test duration is ~17,100,000 ms, i.e. the Mac slept mid-run and the clock ran through the sleep; the tenth is the merge-editor render-ratio test (5.94× against a 2.9× ceiling, large tier 12,220 ms) measured across the same sleep. Failing files: oracleSelfTests, merge-editor-performance, shelf-conflicts, shelf-recovery-contention, resourceCleanup, restoreFidelity, runFixtureTeardown, snapshot, workspaceIsolation, flowLegKnownBad.lock-residue — none imports the bridge or RefreshService. Disposition: WALL (see memory "disjoint failures with one error accuse the wall"); rerun under `caffeinate -i`, alone.
deps-strict (knip): `Unused exports (1) sharedRecords src/views/nativeCommitInputBridge.ts:37:14`. Real: the default map is injected through the constructor option, nothing imports the symbol. Fix by root (one keyword, no Codex round): `export` dropped from `sharedRecords`; 1.2/1.3 "injectable" is satisfied by the `shared` option. Seal rewritten after the change.

### Phase 1 — Final verifier (fresh read-only opus subagent, 21 tool calls; shadow seal mode)
Ran alone (no concurrent vitest): bridge test 35/35, `refreshService.test.ts` 9/9, knip exit 0 and typecheck exit 0 on the post-knip-fix bytes. Defect hunt cleared lifecycle (late resolve, attach/setVisible/setFromPanel after dispose, double show), shared-record keying across root spellings (one record, per-bridge display spelling), the `normalizedPath` move (byte-identical, `process.platform` read per call), poll timer (cleared on hide and dispose), once-only logging, every public method synchronous. No wrong-text or leak defect. VERDICT: REVISE on two grounds: (1) `verdict.json`/`seal.json` predated the knip fix — expected, the rerun below regenerates both; (2) test-quality: "throwing input-box getter never throws to caller" was vacuous (its getter threw only on a second read that adopt never makes). Root fix: the getter now always throws; the test asserts two ticks do not throw, one error log, no callbacks, and a base-less placeholder record → 35/35, prettier clean. Also noted, left as is: `process.platform` restore without `try/finally` in the win32 test; `afterEach` disposes only the last bridge of two-bridge tests (no orphan ever polls). Host contracts for Phase 2 recorded from the report: `onNativeChange` and `persistDraft` must not throw synchronously (`seen`/`base` advance before the call; the ready handshake replay is the safety net).
Accept battery run 2: `gates-awake.sh … accept` = `caffeinate -i` + `gates.sh`, alone.

### Phase 1 — Accept battery, run 2 — GREEN
typecheck OK 7.6s · lint-strict OK 20.2s · test OK 290.3s (build + full vitest; 290 s awake against 17,428 s through the sleep — wall diagnosis confirmed) · format-check OK 10.5s · lint-complexity OK 14.9s · deps-strict OK 1.5s · architecture OK 1.2s · l10n-validate OK 0.1s · l10n-audit OK 0.5s → `GATES: GREEN warn=0`. GitNexus `detect_changes({scope:"all"})`: 3 files, 11 symbols (RefreshService, VsCodeGitExtension, doc sections), 0 affected processes, risk low. Only this log entry changed after the battery; seal rewritten over it, `seal check` runs inside the commit script. Phase 1 committed by Claude with hooks.
