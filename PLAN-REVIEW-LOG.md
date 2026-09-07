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
