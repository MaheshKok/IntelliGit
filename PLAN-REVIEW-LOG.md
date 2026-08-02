# Plan Review Log: Interactively Rebase From Here (PyCharm parity)

Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5. Reviewer: gpt-5.6-sol/per-round (R1 xhigh, mid xhigh, final per rule).

Note: skill default for R1 is `ultra`; running at `xhigh` per standing user rule (Codex effort ceiling is xhigh — constrain the prompt, not the tier). Prompt carries the full precision gate (target sections, locked decisions, out-of-scope list, output contract, no-redesign clause, finding cap).

Grill decisions locked with user:
- UI: webview overlay dialog (ShelveDialog pattern), shared across all 3 commit-list hosts
- Actions: full PyCharm set — pick/reword/squash/fixup/drop + drag AND button reorder, inline message editing
- Pushed commits: allowed with explicit warning (drops today's unpushed-only gate)
- Post-rebase: force-push (with lease) offer via toast when pushed history was rewritten
- Merges in range: block upfront (PyCharm behavior)
- Conflicts: in-product Continue/Abort (no Skip), reusing existing conflict UX + watcher state
- Dirty tree: block with clear error (no autostash/auto-shelve)
- Mechanics: headless via GIT_SEQUENCE_EDITOR/GIT_EDITOR node helper script; executor gains env support

SID: 019fbbf7-7098-7803-9470-c22f996bc53d

## Round 1 — gpt-5.6-sol @ xhigh

Telemetry: PEAK=176300 LAST=176300 window=258400 PCT=68% NONRESUMABLE=no
VERDICT: REVISE — 5 CRITICAL, 7 REQUIRED, 0 MINOR.

Findings:
1. [CRITICAL] No action allow-list / control-char rejection on webview submission (todo injection).
2. [CRITICAL] Shared per-repo session dir racy across concurrent submissions.
3. [CRITICAL] Unqualified delayed force-with-lease not bound to branch/remote-ref/OID.
4. [CRITICAL] startInteractiveRebase trusts client baseHash (forge/replay/stale/repo-switch).
5. [CRITICAL] No operation fence while rebase paused (reset/checkout/drop can corrupt state).
6. [REQUIRED] FIFO message queue misaligns after unexpected editor invocations.
7. [REQUIRED] Node runtime contract undefined (Electron run-as-node, sh quoting).
8. [REQUIRED] Host naming wrong ("commit-panel compact graph"); origin provider not routed.
9. [REQUIRED] %x1f cannot frame multiline %B.
10. [REQUIRED] No reload-safe versioned session manifest / reconciliation.
11. [REQUIRED] Cited emitCommitAction harness mocks GitExecutor/GitOps — cannot verify real history.
12. [REQUIRED] Direct catalog edits bypass localization CSV source of truth.

### Claude's response (disposition ledger)

Claims #8 (sidebarGraph=CommitGraphViewProvider), #11 (vi.mock of executor/operations at extension.integration.test.ts:684,698), #12 (docs/localization/localization_translation_review.csv exists) verified against repo before triage.

- #1 FIXED — Approach 2/5: exact 5-action allow-list, full-hex + range-membership + dup/count checks, CR/LF/NUL rejection; fail closed.
- #2 FIXED — Approach 2: per-submission unique session dir + per-repo active pointer + submit-time in-progress recheck; git rebase lock as backstop only.
- #3 FIXED — Approach 7: manifest captures branch/remote/upstreamRef/upstreamOid at rebase start; click re-verifies branch; explicit refspec + --force-with-lease=<ref>:<oid>.
- #4 FIXED — Approach 4/5: host-issued single-use requestId; webview never sends hashes-of-record; host re-derives range, re-checks expectedHead/repo/guards on consume.
- #5 FIXED (scoped) — new Approach 9: dispatch-level fence on history-mutating commit actions + mutating branch commands during rebase/merge; generalized fence explicitly out of scope (accepted risk logged in plan).
- #6 FIXED — Approach 3: keyed message map {originalHash→action,message} resolved via rebase-merge/done tail (msgnum fallback); mismatch → leave untouched, exit 0.
- #7 FIXED — Approach 3: process.execPath + ELECTRON_RUN_AS_NODE=1 in rebase env; forward-slash normalization + quoting; command string unit-tested.
- #8 FIXED — Approach 6: hosts named CommitGraphApp / CompactCommitGraphApp (sidebarGraph CommitGraphViewProvider) / UndockedApp; dialog routed to originating provider only.
- #9 FIXED — Approach 4: NUL field separators, %B last, %x01 record terminator, per-record field-count validation.
- #10 FIXED — Approach 2/8: versioned manifest per repo; activation reconciliation matrix (manifest+dir / dir-only / manifest-only).
- #11 FIXED — Approach 12: mocked harness demoted to routing/guard coverage; new real-git suite (temp repos + file:// bare remotes) for history/conflict/lease/reload assertions.
- #12 FIXED — Approach 11: strings flow through localization CSV + import script + audit/validation.

## Round 2 — gpt-5.6-sol @ xhigh (resumed session)

Note: first dispatch failed — `codex exec resume` rejects `--cd` after the subcommand; relaunched with `--cd` as a global flag before `exec`. No session impact (run never started).
VERDICT: REVISE — 2 CRITICAL, 10 REQUIRED, 0 MINOR (findings #13–#24, stable numbering).

Findings:
13. [CRITICAL] TOCTOU: validation before gate, pointer after acceptance — queued second rebase starts against stale expectedHead.
14. [CRITICAL] Lease pins destination only; manifest lacks remoteName/qualified ref; source unpinned — later commits/resets get force-pushed.
15. [REQUIRED] Quoting contract underspecified (apostrophes, $, backticks, newlines unhandled).
16. [REQUIRED] ELECTRON_RUN_AS_NODE in git parent env leaks to hooks.
17. [REQUIRED] %x01 record terminator collides with legal SOH bytes in %B.
18. [REQUIRED] Keyed-miss "leave untouched, exit 0" silently discards submitted reword/squash edits — not fail-closed.
19. [REQUIRED] Pending request lacks origin-provider identity on consume; requestId unpredictability unspecified.
20. [REQUIRED] Fence omits undoCommit and branch update within its claimed scope.
21. [REQUIRED] Unbounded %B range loading can exhaust the extension host; no cap/truncation handling.
22. [REQUIRED] Manifest-without-dir treated as stale unconditionally — loses completion reconciliation + pending force-push offer after reload.
23. [REQUIRED] Verification omits AGENTS.md standard set (lint:strict/TSDoc, build:prod+package incl. helper artifact, rendered checks, Windows gate).
24. [REQUIRED] UI disables squash/fixup on physical first row; validator uses first non-dropped — divergence after dropping row one.

### Claude's response (disposition ledger)

AGENTS.md validation set verified (format:check, lint, lint:strict, architecture:check, react-doctor, typecheck, build, test, l10n:validate/audit, build:prod+package). All 12 accepted.

- #13 FIXED — Approach 2/7: atomic O_EXCL reservation BEFORE enqueue; start sequence runs inside RepositoryMutationGate.run around ungated runBinary with HEAD/guard recheck immediately pre-spawn.
- #14 FIXED — Approach 2/7: manifest gains remoteName + fully-qualified remoteHeadRef + lifecycle + rebasedHeadOid (on success); click verifies branch AND HEAD==rebasedHeadOid; push `<rebasedHeadOid>:<remoteHeadRef>` with lease pinned to upstreamOid — both ends pinned.
- #15 FIXED — Approach 3: single specified algorithm (single-quote wrap + '\'' escape, slashes normalized); round-trip via real sh with full metacharacter set incl. quotes/$/backticks/newlines.
- #16 FIXED — Approach 3/7: `env ELECTRON_RUN_AS_NODE=1` prefixes the editor command itself; variable never enters the git parent env.
- #17 FIXED — Approach 4: NUL-only fixed-arity framing (%H,%an,%aI,%B — git forbids NUL in all four); no in-band terminator; SOH-in-body covered by tests.
- #18 FIXED — Approach 3: three-outcome contract with consumption tracking; unresolved step with unconsumed prepared messages → exit nonzero, rebase stops, session preserved, error surfaced. Silent default only for positively-identified message-less prompts.
- #19 FIXED — Approach 4/5: requestId = crypto.randomUUID; originProvider identity stored and required on consume; expiry on cancel/disposal/repo switch/timeout.
- #20 FIXED — Approach 9: fence list enumerated explicitly incl. undoCommit and branch update (fetch+merge/pull); per-path rejection tests.
- #21 FIXED — Approach 4/6: 500-commit range cap (pre-dialog error), maxOutputBytes-bounded runBinary, truncation = hard error; dialog rows virtualized/bounded.
- #22 FIXED — Approach 8: evidence-based idempotent reconciliation matrix; completed-pending-push manifests never silently deleted; ambiguous evidence surfaces a one-time notice with explicit discard action.
- #23 FIXED — new Approach 13 acceptance matrix mirroring AGENTS.md incl. lint:strict/TSDoc, build:prod + package + packaged-helper inspection, rendered per-host dialog check, Windows release gate.
- #24 FIXED — Approach 6: first-non-dropped predicate recomputed after every action change/reorder; UI and validator share the same rule; invalidated squash/fixup cleared with visible notice.

## Round 3 — gpt-5.6-sol @ xhigh (fresh session — reseed + hang recovery)

Session hygiene: Round-2 telemetry PEAK=212962/258400 (82%) with LAST=59920 (<half of peak) = compaction detected → NONRESUMABLE. Reseeded fresh session from PLAN.md + full ledger per protocol. SID(old) 019fbbf7-7098-7803-9470-c22f996bc53d → SID(new attempt) 019fbc1c-2451-7880-9685-aa9ec9f44748.
Hang incident: first Round-3 launch (SID 019fbc1c) hung — rollout frozen at launch size (18,824 bytes) for 47 min, zero token events, process alive at 0.0% CPU. Killed per liveness protocol and re-issued the identical round in a fresh session. SID(final) 019fbc47-3bed-7941-aa34-911524bcf1b1. Heartbeat watcher armed for the re-issue, stopped on completion.
Telemetry (final session): PEAK=167182 LAST=167182 PCT=64% NONRESUMABLE=no
VERDICT: REVISE — 2 CRITICAL, 7 REQUIRED, 0 MINOR (findings #25–#33).

Findings:
25. [CRITICAL] expectedHead alone passes a same-tip branch switch — rebases the wrong branch.
26. [CRITICAL] Reload reconciliation classifies any moved HEAD as "our rebase completed" and arms a lease-valid force-push for potentially unrelated rewrites.
27. [REQUIRED] `git log -z` + trailing %x00 double-terminates records, breaking arity grouping.
28. [REQUIRED] Manifest inside session dir is deleted by success cleanup while completed-pending-push still needs it.
29. [REQUIRED] No reservation release on failed in-gate recheck / failed spawn; orphan O_EXCL pointer blocks future attempts.
30. [REQUIRED] Whole-index boolean can't discriminate merge vs rebase; duplicate/wrong abort controls; conflict-free pauses invisible.
31. [REQUIRED] Nonzero exit + rebase dir treated as conflict — helper/editor failures misreported as resolvable conflicts.
32. [REQUIRED] Manifest updates lack atomic write spec — interruption leaves invalid JSON, defeating reconciliation.
33. [REQUIRED] Acceptance matrix omits AGENTS.md Impeccable workflow + affected-path impeccable detect.

### Claude's response (disposition ledger)

#33 claim verified (AGENTS.md:65 "Impeccable Frontend Workflow"; earlier partial read missed it). #27 confirmed against git -z semantics. All 9 accepted.

- #25 FIXED — Approach 4/5: pending request + checks gain expectedBranch (exact ref equality) at submit AND inside the gate; same-tip branch-switch regression test added.
- #26 FIXED (conservative variant) — Approach 8: manifest-without-dir + moved HEAD is ALWAYS ambiguous — notice + explicit discard action; force-push offer armed exclusively by the live success path the extension witnessed; reconciliation never arms it.
- #27 FIXED — Approach 4: no -z; single NUL-separated stream, verify+discard exactly one trailing sentinel, arity-of-4 grouping; parser unit tests incl. SOH bodies.
- #28 FIXED — Approach 2/7: manifest moved to a per-repo store outside the session dir; success deletes helper artifacts + reservation only; completed-pending-push manifest survives until push success/explicit discard.
- #29 FIXED — Approach 2: reservation lifecycle contract — every non-paused/running exit releases reservation + deletes session; activation orphan sweep; tests per failure path.
- #30 FIXED — Approach 8: discriminated activeOperation ("none"|"merge"|"rebase") in host snapshot/protocol; rebase state shows Continue/Abort Rebase and suppresses Abort Merge; toolbar state tests.
- #31 FIXED — Approach 7: pause classification via unmerged-index inspection (ls-files -u); conflict → resolve guidance; helper stop → surface stderr with Continue-retries/Abort guidance.
- #32 FIXED — Approach 2: temp-file + validate + atomic-rename for every manifest write; corrupt/truncated/unknown-version recovery tests (ambiguous, never actionable).
- #33 FIXED — Approach 13: project-local Impeccable review for dialog/toolbar UI + affected-path `npx --yes impeccable detect` after UI tests.

## Round 4 — gpt-5.6-sol @ xhigh (delta re-review, resumed SID 019fbc47-3bed-7941-aa34-911524bcf1b1)

Telemetry: LAST_TURN_CONTEXT=192228 PCT=74% NONRESUMABLE=no
VERDICT: REVISE — 1 CRITICAL, 4 REQUIRED, 1 MINOR (findings #34–#39).

Findings:
34. [CRITICAL] Manifest + any rebase dir assumed same session — stale paused manifest can pair with a later terminal rebase and inject old prepared messages.
35. [REQUIRED] Without `-z`, git inserts a newline between formatted commits (`<body>\0\n<hash>`) — every multi-commit range fails hash validation.
36. [REQUIRED] Reconciliation matrix has no outcome for HEAD==expectedHead but branch != expectedBranch (same-tip switch at reload); no default-deny.
37. [REQUIRED] Narrowing activeOperation to none|merge|rebase removes the existing abort affordance for cherry-pick/revert/generic unmerged states handled by abortMerge today.
38. [REQUIRED] "Retain the manifest" on success is unconditional — a direct-`done` rebase (no push offer) becomes an ambiguous moved-HEAD session on next activation.
39. [MINOR] Live force-push toast has no discard action — a dismissed offer leaves a dangling completed-pending-push manifest.

### Claude's response (disposition ledger)

Verification before triage:
- #35 CONFIRMED EMPIRICALLY against real git in this repo: without `-z`, NUL-split field 5 = `\n7189d138…` (newline prefixes next hash); with `-z` + no trailing `%x00`, fields are clean with exactly one empty trailing sentinel. **Round 3's #27 fix was mis-encoded by Claude when editing the plan** — Codex's R3 text said "remove the final %x00" (keep `-z`); the plan edit wrongly dropped `-z` instead. Codex caught the resulting defect. Correct framing: `git log --reverse -z --format=%H%x00%an%x00%aI%x00%B`.
- #37 CONFIRMED in code: Toolbar shows Abort Merge on `controller.hasMergeConflicts` (CommitTab.tsx:73), computed purely from unmerged files (CommitTabController.ts:152); `GitOperations.abortMerge` (operations.ts:1642) dispatches cherry-pick (1659) and revert aborts. Narrowing to kind=="merge" would drop today's only abort control for conflicted cherry-picks/reverts.
- #38 CONFIRMED in plan text (Approach 7 said "retain the manifest" unconditionally). #34/#36 design gaps, accepted on inspection.

All 6 accepted:
- #34 FIXED — Approach 2/8: manifest gains sessionId (shared with reservation + session-dir name); manifest+dir row now correlates via `rebase-merge/head-name`==branch, `onto`==baseHash, `orig-head`==expectedHead before claiming; mismatch = foreign rebase → no injection, Abort-only controls, our manifest ambiguous with discard. (Adopted read-only correlation over Codex's write-a-marker-into-rebase-dir suggestion — git owns that directory; reading its metadata is safer than writing to it.)
- #35 FIXED — Approach 4: `-z` restored, trailing `%x00` removed; unit tests now run against real `git log -z` output incl. the newline-separator regression.
- #36 FIXED — Approach 8: explicit default-deny catch-all row — any unmatched state (branch mismatch incl. same-tip, detached HEAD, corrupt manifest, failed correlation) → ambiguous: notice + discard only, never inject, never arm push.
- #37 FIXED — Approach 8: enum extended to none|merge|cherry-pick|revert|rebase (derived from watcher ref set); Abort Merge affordance unchanged for merge/cherry-pick/revert (existing hasMergeConflicts gating + abortMerge dispatcher); suppressed only during rebase. Integration test: conflicted cherry-pick/revert keep their abort control.
- #38 FIXED — Approach 7: success path split — push offer due → completed-pending-push + manifest retained; no offer → done + manifest deleted immediately. Test: no-upstream success leaves nothing for reconciliation.
- #39 FIXED — Approach 7: toast gains explicit Dismiss → marks done + deletes manifest; no dangling pending-push state from the live path.

## Round 5 — gpt-5.6-sol @ xhigh (delta re-review, resumed SID 019fbc47-3bed-7941-aa34-911524bcf1b1) — FINAL ROUND (MAX_ROUNDS=5)

Telemetry: LAST_TURN_CONTEXT=121794 PCT=47% (context dropped from 74% between turns — codex-side history pruning; verdict unaffected)
VERDICT: REVISE — 1 CRITICAL, 3 REQUIRED (findings #40–#43).

Findings:
40. [CRITICAL] sessionId never reaches git's rebase directory — a terminal rebase restarted with the same branch/base/orig-head passes every read-only correlation check and can receive stale prepared messages.
41. [REQUIRED] Manifest `branch` not defined as fully qualified while `rebase-merge/head-name` is a full ref — literal correlation can reject genuine sessions.
42. [REQUIRED] Manifest schema makes remoteName/remoteHeadRef/upstreamOid mandatory, but every no-upstream rebase must write a starting manifest.
43. [REQUIRED] Round-4 plan text claimed `GitOperations.abortMerge` dispatches revert aborts correctly — false: no REVERT_HEAD branch; conflicted reverts fall through to generic `reset --merge`, stranding `.git/sequencer` on multi-commit reverts.

### Claude's response (disposition ledger)

Verification before triage:
- #43 CONFIRMED in code (operations.ts:1642–1668): dispatch chain is MERGE_HEAD → merge --abort, REBASE_HEAD → rebase --abort, CHERRY_PICK_HEAD → cherry-pick --abort, then generic `reset --merge` on unmerged files. No REVERT_HEAD branch. **Claude's Round-4 justification overstated the existing behavior; Codex correctly refuted it.**
- #40 accepted on inspection: after an abort, HEAD returns to orig-head, so an identical-input terminal restart reproduces head-name/onto/orig-head exactly — read-only correlation (Claude's Round-4 variant) is insufficient. Codex's marker approach adopted: the sequence helper (which runs only for our rebases) writes the sessionId into `rebase-merge/intelligit-session`; git reads only its known filenames and removes the dir wholesale, so the marker cannot leak.
- #41/#42 accepted as schema-precision gaps.

All 4 FIXED in PLAN.md (now v6, 43/43):
- #40 FIXED — Approach 3: sequence role writes the sessionId marker; message role revalidates it before every keyed lookup (absent/mismatch → fail-closed outcome (c)). Approach 8: correlation requires marker == manifest.sessionId first, head-name/onto/orig-head demoted to sanity checks. Tests: identical-input terminal restart never receives injected messages.
- #41 FIXED — Approach 2/4: `branch`/`expectedBranch` stored fully qualified from `symbolic-ref -q HEAD` (same form as head-name); short display name derived separately.
- #42 FIXED — Approach 2/7: remoteName/remoteHeadRef/upstreamOid collapsed into all-or-none optional `pushTarget?`; absence disables the push offer; manifest validation covers both forms.
- #43 FIXED — Approach 8: false claim corrected in the plan text; pre-existing gap fixed in scope — `abortMerge` gains `REVERT_HEAD → git revert --abort` before the generic fallback; integration test: conflicted multi-commit revert → abort → sequencer removed, pre-sequence HEAD restored.

## Terminal state — MAX_ROUNDS reached

MAX_ROUNDS=5 exhausted with the Round-5 verdict REVISE. Per protocol, convergence is NOT faked: the plan did not receive a Codex APPROVED verdict. Findings #40–#43 were triaged and folded into PLAN.md v6 after the final round, so every finding from all 5 rounds (43/43) is dispositioned FIXED with zero REJECTED — but the v6 revisions themselves have not been re-reviewed by Codex.

Trajectory: R1 12 findings → R2 12 → R3 9 → R4 6 → R5 4; CRITICAL count 2→2→2→1→1. Converging but not converged. Unresolved residue = the un-re-reviewed v6 delta (marker mechanism, fully-qualified refs, pushTarget optionality, REVERT_HEAD dispatch).

Options presented to the user: (a) one authorized extra round to re-review the v6 delta; (b) accept v6 as-is and proceed to the build gate; (c) stop here.
User selected **(a)** — one extra round authorized past the cap. Round 6 dispatched (same SID, xhigh, delta scope = #40–43 fixes, findings start at 44).

## Round 6 — gpt-5.6-sol @ xhigh (delta re-review, resumed SID 019fbc47-3bed-7941-aa34-911524bcf1b1) — user-authorized extra round

Telemetry: LAST_TURN_CONTEXT=147438 PCT=57% NONRESUMABLE=no
VERDICT: REVISE — 0 CRITICAL, 3 REQUIRED (findings #44–#46). First round with zero CRITICAL.

Findings:
44. [REQUIRED] `activeOperation: "rebase"` alone cannot distinguish owned/terminal/foreign rebases — the Toolbar cannot render the promised Abort-only foreign state or choose injected vs uninjected Continue.
45. [REQUIRED] Treating any upstream as a pushTarget includes local upstreams (`branch.<name>.remote = "."`) — a force-push could be offered into a local branch.
46. [REQUIRED] Tests cover host-side marker correlation but never run the message helper with a resolvable keyed step and an absent/mismatched marker — its final defense could be omitted without a test failure.

### Claude's response (disposition ledger)

All 3 accepted on inspection (protocol completeness, predicate precision, test coverage — no code checks required; #45's `remote = "."` semantics are standard git branch config).

- #44 FIXED — Approach 8: snapshot/protocol gains `rebaseControl: "owned" | "unowned" | "foreign"` alongside the operation kind (owned → full Continue/Abort + injection; unowned → Continue/Abort without injection; foreign → Abort-only); all three states protocol- and toolbar-tested.
- #45 FIXED — Approach 2: `pushTarget` created only for a configured non-local remote (`branch.<name>.remote` ≠ `.`) with a resolvable remote-tracking ref; unit tests reject local and missing upstreams.
- #46 FIXED — Approach 12: child-process helper tests add marker revalidation with a resolvable keyed step — absent and mismatched marker each exit nonzero, message file untouched, consumption state unchanged.

PLAN.md now v7 (46/46 across 6 rounds, zero REJECTED). The authorized extra round is spent; the v7 delta (#44–46 fixes) is un-re-reviewed. Decision returned to the user: another authorized round, accept v7 → build gate, or stop.
User authorized **Round 7** (second extension) and pre-selected the build path for when the review closes: **Codex builds** via `/claudex-build`. Round 7 dispatched (same SID, xhigh, delta scope = #44–46 fixes, findings start at 47).

## Round 7 — gpt-5.6-sol @ xhigh (delta re-review, resumed SID 019fbc47-3bed-7941-aa34-911524bcf1b1) — second user-authorized extra round

Telemetry: LAST_TURN_CONTEXT=167080 PCT=64% NONRESUMABLE=no
VERDICT: REVISE — 0 CRITICAL, 4 REQUIRED (findings #47–#50). Second consecutive zero-CRITICAL round; finding count ticked up 3→4.

Findings:
47. [REQUIRED] A retained completed-pending-push manifest can coexist with a second live session — per-manifest reconciliation classifies one rebase dir as both owned and foreign while rebaseControl permits one value.
48. [REQUIRED] The generic Continue/Abort paragraph still applies helper env, lifecycle updates, and session cleanup to every rebase — contradicting unowned/foreign, which must not mutate owned session state.
49. [REQUIRED] pushTarget pins only a remote name, but one remote can expand to multiple push URLs (all pushed) — one endpoint can be force-updated before another rejects the lease, leaving partial remote state.
50. [REQUIRED] `branch.<name>.remote != "."` does not prove non-local — a normally named remote may still resolve to `.` or the current repository.

### Claude's response (disposition ledger)

All 4 accepted on inspection (state-model completeness ×2, git push-URL semantics ×2 — standard git behavior, no repo checks required).

- #47 FIXED — Approach 8: reconciliation is repository-scoped, marker-first — read dir+marker once, select the matching manifest; completed-pending-push manifests never claim the dir (evidence = HEAD/branch vs rebasedHeadOid only); owned iff marker matches a live (starting/running/paused) manifest; foreign only when no live manifest matches. Test: overlapping pending-push + second-live-session repo.
- #48 FIXED — Approach 8: Continue/Abort side effects scoped by rebaseControl — owned: env + lifecycle + cleanup; unowned: pass-through editor, no manifest/session/reservation mutation; foreign: Abort-only, never touches owned session state. All three contracts tested.
- #49 FIXED — Approach 2: pushTarget additionally requires the remote to resolve to exactly one effective push URL; multi-push-URL remotes never arm the offer.
- #50 FIXED — Approach 2: the single effective push URL must not canonicalize to the current repository; named-self-remote regression test added.

PLAN.md now v8 (50/50 across 7 rounds, zero REJECTED). Trajectory: 12→12→9→6→4→3→4 findings; CRITICAL 2→2→2→1→1→0→0. The v8 delta (#47–50 fixes) is un-re-reviewed. The reviewer is yielding non-critical precision findings at a roughly constant rate rather than converging to APPROVED; decision returned to the user.

## Act 2 close — arbitrated

User closed the review by arbitration (no Codex APPROVED was issued; the option was presented with that stated plainly). Basis: two consecutive zero-CRITICAL rounds, 50/50 findings dispositioned FIXED across 7 rounds with zero REJECTED, constant-rate precision residue whose class is covered by the build phase's own adversarial layer (Claude diff review + full AGENTS.md acceptance matrix). Act 3 begins: **Codex builds** from frozen PLAN.md v8 via claudex-build; roles flip — Codex writes with access, Claude reviews the diff and runs the proof. Plan artifacts committed as a checkpoint before the build.

## Act 3 — Build

### Step 0 — gates (2026-08-01)

- Spec gate: PLAN.md v8 (grilled + 7 review rounds) — pass.
- Clean-tree gate: clean at `0ecdb97b` (plan checkpoint committed; branch ahead of origin by 1, pushes user-driven) — pass.
- BASE_HEAD: `0ecdb97b3c75656e8329f2463a253ab6b16dad14`
- Protocol SHAs: SKILL.md `fece62ecf381`, helpers.py `cf85c8260269`, verify.py `db9282d4db13`. codex-cli 0.144.1.
- Gates manifest `.claudex-gates.json`: round+accept = lint (`npm run -s lint:strict`), typecheck, format; accept-only = knip (`deps:check:strict`), suite (`npm run -s test`, 1800s) — suite is PROOF_CMD.
- Tunables: BUILD_MODEL=gpt-5.6-terra, BUILD_EFFORT=high (xhigh at launch for subtle-state phases 1, 2, 5, 6), SANDBOX=danger-full-access, MAX_FIX_ROUNDS=2 (ladder high→xhigh→takeover), SEAL_MODE=shadow (no prior build has logged zero shadow findings yet).

## Handoff — resume at Phase 1

Orchestrator-session sizing rule: this session already auto-compacted once (continued from summary) and carries the full 7-round review context — per protocol, no phase launches into a compacting session. Fresh orchestrator session takes over from here; the spec (PLAN.md v8), this log, and the committed tree at `0ecdb97b` are the complete state.

- BASE_HEAD: `0ecdb97b3c75656e8329f2463a253ab6b16dad14`
- Resolved tunables + SEAL_MODE: see Step 0 above.
- Phases committed so far: none.
- Phase plan (dependency-sliced; predicted peak 45–50% each; effort per phase in parentheses):
  1. PLAN steps 1–2 (xhigh): executor `env?` support + `src/git/interactiveRebase.ts` domain module — types, todo builder, submission validation, reservation + manifest store (sessionId, pushTarget?, atomic writes) — + unit tests.
  2. PLAN step 3 (xhigh): helper `.cjs` (sequence role + marker write, message role + marker revalidation, quoting algorithm) + second esbuild entry + real-sh/child-process tests + packaged-artifact inspection.
  3. PLAN steps 4–5 (high): command rewrite — guards, 500-cap `-z` NUL-framed range load, pending request (fully-qualified expectedBranch) — + protocol messages + origin-bound one-shot consume + unit/mocked-integration tests.
  4. PLAN steps 6+10 (high): RebaseDialog shared component in the three hosts + first-non-dropped recomputation + pushed banner + commitMenu enablement change + webview tests.
  5. PLAN step 7 (xhigh): run-the-rebase path — session files, in-gate recheck, pause classification (ls-files -u), success split (pending-push vs direct-done), force-push offer with full pushTarget predicate + Dismiss — + tests.
  6. PLAN step 8 (xhigh): activeOperation + rebaseControl protocol, repo-scoped marker-first reload reconciliation (default-deny), toolbar Continue/Abort with per-control side effects, `REVERT_HEAD → revert --abort` dispatch in abortMerge + tests.
  7. PLAN steps 9+11 (high): enumerated operation fence + rejection tests; l10n CSV pipeline for all new strings.
  8. PLAN steps 12–14 (high): real-git integration suite (temp repos, file:// bare remotes, full matrix), docs + CHANGELOG, full acceptance matrix incl. build:prod/package inspection + Impeccable workflow + Windows release-gate note.
- Next action for the fresh session: re-run Step 0 quickly (tree must still be clean at the recorded BASE_HEAD), then launch Phase 1 per Step 1–2 of the skill.

### Handoff superseded — user override (same session)

User re-invoked `/claudex-build` in the same session with explicit instructions: build now, on a new branch. Handoff-to-fresh-session recommendation overridden by the user; risk (possible orchestrator auto-compact mid-phase) accepted and mitigated by background Codex rounds + durable on-disk state (spec, log, tree). Additional user instruction executed: claudex-grill SKILL.md updated so Act 3 auto-invokes claudex-build on Act-2 convergence (no "who builds?" ask; claudex-build Step-0 confirmation is the single human gate).

- Branch: `feat/interactive-rebase-from-here` created at `d79abad6` (BASE_HEAD for Phase 1).
- Tunables re-confirmed: BUILD_MODEL=gpt-5.6-terra, SANDBOX=danger-full-access, SEAL_MODE=shadow; Phase 1 effort xhigh per the phase plan.

## Phase 1 — PLAN steps 1–2 (executor env + rebase domain module) — gpt-5.6-terra @ xhigh

- BASE_HEAD: `230a871c60c79a7e143091bc9d9e58b1dc17c7b7` (docs commit for this override note included).
- SID: `019fbc9e-c698-71c2-a424-b5c34b82d3ec` (fresh session — nothing resumes in build rounds).
- Work order: 8 deliverables (executor `env?` merge; domain types; todo builder; fail-closed validation; O_EXCL reservation + orphan sweep; session-dir helpers; manifest store with pushTarget? all-or-none + ambiguous classification; unit tests for all). GIT clause: no commits, stay on branch. Checks: focused vitest only.
- Watcher armed (600s stale threshold, 2-frozen-sample alert, 3h expiry).

### Round 1 (build) — result

Telemetry: PEAK=119165 LAST=119165 PCT=46% NONRESUMABLE=no (sizing target 45–50% hit).
Codex self-report: 8/8 DONE, RED-then-GREEN per slice, 43 focused tests passing, no git ref moved.
Round gates: RED on first run — `format` failed on the two new files (`interactiveRebase/storage.ts`, `todo.ts`). Orchestrator ran `npx prettier --write` on both; re-run GREEN (lint 10.6s, typecheck 3.8s, format 2.2s).

Independent phase verifier (opus, fable-method, read-only) — **PHASE_VERDICT: DEFECTS**. Deliverables 1,2,3,6,7 PASS; 4,5,8 FAIL. Builder's own report claimed all 8 DONE — the verifier contradicting it is exactly why the round gate is not the acceptance gate.

Findings (all reproduced by the verifier; 1/2/3 re-confirmed at source by the orchestrator):
1. [CRITICAL] `todo.ts:42-53` + `:14-15` — `message` never checked for CR/LF/NUL and interpolated verbatim into the todo line → one entry can emit arbitrary extra todo lines. Proven exploitable end-to-end against real `git rebase -i` (injected `exec` ran a command). Reachable in ordinary use: squash pre-fills combined multi-line messages.
2. [REQUIRED] `storage.ts:119` — sweep retains on `lifecycle !== "done"`, so `completed-pending-push` orphans are never reclaimable → a crash between rebase success and reservation release permanently blocks all future rebases in that repo.
3. [REQUIRED] `todo.ts:45,55-59` — membership tested on a lowercased set but original casing emitted → uppercase hash reaches the todo file un-normalized; Phase 3's keyed message lookup (git writes lowercase into `rebase-merge/done`) would miss and fail-closed-halt a legal rebase.
4. [REQUIRED] `interactiveRebase.test.ts` — missing adversarial rows let all three defects through (message control chars, uppercase hex, 41-char hash, sweep at `completed-pending-push`/`done`, foreign-owner release, non-pushTarget manifest rejections).
5. [MINOR] `executor.test.ts:99-115` — env test only exercises the ungated path; `rebase` is mutating and takes the gated branch in production.
6. [MINOR] `storage.ts:203-211` — `pathExists` probes with `readFile` and infers from `EISDIR`; rethrows on `EACCES`.

Verified clean: no new deps, no `console.*`/`vscode` in domain files, TSDoc on every export, no input mutation, largest file 377 lines, change surface exactly the 7 expected paths (no scope creep into later phases).

### Fix round 1 — gpt-5.6-terra @ high (fresh session, per `helpers.py route fix 1` → `EFFORT=high MODE=fresh`)

- SID: `019fbc9e-c698` → `019fbd1e-86dc-7d21-941d-9e4d012c8cfa`.
- Work order: all six findings, self-contained (fresh session has no memory of the build round), test-first per defect. CRITICAL fixed in both halves — validation rejects control chars in `message`, and `buildRebaseTodo` renders defensively (first line only, control chars stripped) so it is structurally impossible to emit more lines than entries.
- Watcher armed.

Telemetry: PEAK=99038 LAST=99038 PCT=38% NONRESUMABLE=no. Codex self-report: 6/6 FIXED, RED (8 failing) → GREEN (60 passing). Round gates GREEN.

Re-verification (fresh opus verifier, fable-method, mutation-checked) — **PHASE_VERDICT: ACCEPT**:
- #1 CRITICAL closed and proven closed: verifier rebuilt the exploit in a scratch repo against real git 2.50.1. Positive control first — a hand-built todo with a raw LF injection *did* execute (`Executing: touch …/RAW_LF`), so the harness genuinely fires; then the same attack through the public API returns `invalid-message` for LF/CR/NUL × pick/reword/squash. Adjacent escapes tested empirically, not assumed: U+2028, U+2029, VT, FF, NEL, CR produced zero markers — git's sequencer breaks todo lines on LF only, so `[\r\n\0]` is sufficient and `\r`/`\0` are defense in depth. 84-shape structural fuzz: zero violations of "exactly entries.length lines". Mutation: reverting both halves fails 6 tests.
- #2 closed (`LIVE_LIFECYCLES = {starting, running, paused}`); every sweep exit still fails closed. Mutation: reverting fails the lifecycle test.
- #3 closed (`normalizedHash` emitted; uppercase in → lowercase out through the public API).
- #4 closed and load-bearing: mutation dropping `options` *only* inside the gated branch fails the gated test while the ungated one still passes — the exact discrimination required.
- #5 production fix correct (`stat`, ENOENT-only-absent). Codex's deviation claim ("no public test seam without an out-of-scope refactor") **rejected as factually wrong** — the verifier proved `chmod 000` yields EACCES reachable through the public `tryAcquireRebaseReservation`, using helpers the test file already has.
- #6 closed: every demanded row exists and asserts a typed reason code. Codex's second deviation ("some coverage-only rows already passed") **accepted and honestly reported** — the control-char and structural rows did go RED under mutation; the rest are behavior-locking tests for already-correct code.

Four new MINORs, all fixed directly by the orchestrator (cheaper than a fix round for one-liners):
- `storage.ts` FULL_OBJECT_ID is now lowercase-only — `validateManifest` previously accepted and persisted uppercase OIDs, so an uppercase `expectedHead` would silently never equal a `git rev-parse` result. Two regression rows added.
- `tryAcquireRebaseReservation` TSDoc now states the caller must persist a `starting` manifest before yielding control (the sweep treats a manifest-less pointer as reclaimable — a pre-existing race, not introduced this round).
- `run()` TSDoc documents `options.env` merge semantics on both paths.
- Sweep lifecycle table gained `paused` and `starting` rows.
Not fixed: the EACCES test for #5 — a `chmod 000` test is environment-fragile (no-op as root, needs cleanup) and the production code is already correct; recorded rather than silently dropped.

### Phase 1 acceptance

Accept gates, first run: lint OK, typecheck OK, format OK, **suite OK (38.2s — full `npm run -s test`, no regressions)**, knip **RED** — 16 unused *exported types*, all barrel re-exports plus 2 in `types.ts`.

The repo's `.githooks/pre-commit` runs `deps:check:strict` (knip) and blocks the commit on it, so this is an enforced project rule — "every export has a consumer" — not an advisory lint. `--no-verify` would also have skipped `architecture:check`, `l10n:validate`, `build`, and `vsce package`, so it was never an option. Resolved honestly rather than suppressed:
- `storage.ts` now names `RebaseSessionLifecycle` for its two lifecycle sets instead of the structural `RebaseSessionManifest["lifecycle"]` — the alias exists for exactly this and now has a consumer.
- `todo.ts` routes its eight rejection returns through a typed `invalid(reason: RebaseSubmissionValidationReason)` helper — removes eight repeated object literals and gives the reason union a consumer.
- The barrel keeps only the four types with real consumers (`RebaseAction`, `RebaseSessionManifest`, `RebaseSubmissionEntry`, `RebaseTodoEntry`, all used by the tests) and drops eleven result/path types that nothing names; a comment records that later phases re-export from `./interactiveRebase/types` as they import them. PLAN step 2's mandated `RebaseAction`/`RebaseTodoEntry` surface is preserved.
- The test fixtures are now typed with those public types (`satisfies readonly RebaseSubmissionEntry[]`, `readonly RebaseTodoEntry[]`, `satisfies readonly RebaseAction[]`), which is both the consumer knip wanted and a genuine strengthening — the tables now fail to compile if the public unions drift.

Accept gates, final run: **lint OK, typecheck OK, format OK, knip OK, suite OK (32.5s) — GATES: GREEN warn=0.** Focused tests: 64 passed (45 + 19).

Seal: rewritten after the knip fixes — `SEAL: WRITTEN green=True`. SEAL_MODE=shadow, and the fresh final verifier had already returned ACCEPT before these changes; the changes since are the dead-export cleanup above, all covered by the green gate run.

Security note (project Tier-2 rule — code touching untrusted user input): the adversarial pass was performed by the independent verifier, which found and then proved-closed a real command-injection reachable from ordinary webview use. No push is being made; the security-reviewer gate before push still applies.

**Phase 1 COMMITTED: `08d92e95` — `feat: interactive rebase domain foundation (phase 1)`.** The repo's full pre-commit chain ran and passed: format, `eslint --max-warnings=0`, knip, dependency-cruiser (249 modules, no violations), l10n validate + audit, both typecheck projects, full build, and `vsce package`. Rounds used: 1 build + 1 fix (ladder position: one fix round left at `xhigh` before Claude takeover, but the phase is accepted, so the ladder resets for Phase 2).

Carry-forward (unchanged by this phase, still open): the VSIX packages `PLAN.md`, `PLAN-REVIEW-LOG.md`, and `.claudex-gates.json` — visible again in this commit's `vsce package` output. Tracked as a separate task; fix belongs in `.vscodeignore`, not in this feature branch.

## Phase 2 — PLAN step 3 (editor helper script) — gpt-5.6-terra @ xhigh

- BASE_HEAD: `08d92e950e5f5783d2f438965eca5d06df7e1f0a` (clean tree at launch).
- SID: `019fbd1e-86dc` → `019fbd37-a9d2-78a2-90cf-3e0885e7c050` (fresh session).
- Work order: 7 deliverables — the `.cjs` helper (sequence role writing todo + `rebase-merge/intelligit-session` marker; message role with keyed lookup, consumption tracking, and the exactly-three-outcomes fail-closed rule), the POSIX/MSYS quoting algorithm as a separately testable export with `env ELECTRON_RUN_AS_NODE=1` scoped to the editor invocation, a second esbuild entry, real-child-`sh` round-trip tests across every metacharacter class, child-process tests of both roles against a mimicked `rebase-merge` layout, and a packaged-artifact assertion.
- The work order points Codex at Phase 1's committed `types.ts`/`storage.ts` as the authoritative on-disk contract (`RebaseSessionPaths`: `todoPath`, `messageMapPath`, `consumptionDirectory`) and states that object IDs in the map are lowercase, so the helper must lowercase hashes parsed out of git's files. It also carries forward the knip constraint that bit Phase 1: export nothing without a consumer.
- Watcher armed.

Telemetry: PEAK=117178 LAST=117178 PCT=45% NONRESUMABLE=no. Codex self-report: 7/7 DONE, RED→GREEN, 19 focused tests. Round gates GREEN first try.

Independent verifier (opus, fable-method, ≤30 calls) — **PHASE_VERDICT: DEFECTS**, but no CRITICAL and the two security-critical properties were proven sound:
- **Quoting is injection-safe, empirically.** The verifier built its own `sh -c` harness with a working positive control (proved it *can* execute an injection when quoting is bypassed), then ran 13 hostile inputs — `'; touch … ;'`, `$(…)`, backticks, `$IFS`, `${HOME}`, newline, double quote, non-ASCII, `C:\dir's path\x`, trailing backslash, glob — all arrived byte-identical, no file created. `ELECTRON_RUN_AS_NODE` confirmed scoped: no parent-env leak, no sibling visibility.
- **The message role's fail-closed rule holds.** Marker revalidation is the first statement before any map read or keyed lookup. A 14-case adversarial matrix (empty `done`, malformed tail, foreign hash, corrupt JSON, truncated JSON, missing map, missing session dir, uppercase key, `__proto__` key, abbreviated hash, marker absent, marker mismatched) produced 13 nonzero exits with the message file untouched and no consumption marker; the 14th was the happy-path control reaching outcome (a), proving the matrix isn't vacuous. Mutation-checked: defeating marker revalidation fails 2 tests, defeating the fail-closed exit fails 1.
- Also empirically established: git's `done` file carries **full 40-hex** hashes, so the helper's `FULL_OBJECT_ID` gate is correct rather than over-strict. And the helper was driven by a **real `git rebase -i`** via `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR` — exit 0, commits reordered as submitted, marker present.

Five defects, all fixed directly by the orchestrator (mechanical, each with a prescribed fix — cheaper and lower-risk than an `xhigh` Codex round):
1. [REQUIRED] `package.json` — `"test": "bun vitest run"` had no build step while 7 of 19 helper tests depend on the built `dist/` artifact; proven by deleting the artifact and watching them fail. `bun run test` was red on a clean checkout or any CI job that doesn't build first. Fixed with `"pretest": "bun run build"`, which also removes the stale-artifact weakness in the packaging assertion (the artifact is now always freshly built). Verified by deleting `dist/interactive-rebase-editor-helper.cjs` and running `npm run -s test`: the helper rebuilt and all 2169 tests across 138 files passed.
2. [REQUIRED] `scripts/watch.js` — the dev watch loop had no editor-helper entry, so `bun run watch` never rebuilt the helper and a developer editing it would silently run a stale or absent bundle. Added an esbuild context mirroring `scripts/build.js`.
3. [MINOR] Every fail-closed path returned 1 with empty stderr, while PLAN step 7 expects the stop to be surfaced with captured stderr. Added a `fail(reason)` helper writing one machine-readable token (`intelligit-rebase-editor: <reason>`) before each nonzero return — ten distinct reasons.
4. [MINOR] Two fail-closed tests asserted only `status !== 0`, which a failure-to-launch also satisfies (they stayed green in the no-artifact run). Now assert `status === 1` plus the specific stderr reason.
5. [MINOR] An undocumented second invocation form via `INTELLIGIT_REBASE_EDITOR_ROLE`/`INTELLIGIT_REBASE_SESSION_DIRECTORY` was outside PLAN item 3's invocation contract and had no test. Deleted — argv is the sole supported form.

### Phase 2 acceptance

Accept gates: **lint OK, typecheck OK, format OK, knip OK, suite OK (36.0s) — GATES: GREEN warn=0.** Seal: `SEAL: WRITTEN files=6 green=True`.

**Phase 2 COMMITTED: `1f7ac5df` — `feat: interactive rebase editor helper script (phase 2)`.** Full pre-commit chain passed (format, `eslint --max-warnings=0`, knip, dependency-cruiser 250 modules, l10n validate + audit, both typechecks, build, `vsce package`). The VSIX now carries `dist/interactive-rebase-editor-helper.cjs` (dist grew 22 → 24 files). Rounds used: 1 build + 0 Codex fix rounds (the five verifier defects were fixed in place by the orchestrator).

## Handoff — resume at Phase 3

Orchestrator-session sizing rule (claudex-build Step 5.5): this session resumed from an auto-compact at its start, hit an API session limit mid-run, and has now delivered two committed phases — the documented 1–2 phase ceiling. Phase 3 is a large slice (command rewrite + guards + range loading + protocol messages) and would very likely compact mid-phase. A fresh orchestrator session takes over. This is a checkpoint report, not a request for approval: the spec (PLAN.md v8), this log, and the committed tree are the complete state.

- Branch: `feat/interactive-rebase-from-here`. **BASE_HEAD for Phase 3 = the tip after this docs commit** (last code commit is Phase 2's `1f7ac5df1531bf6dd60331382ff7a4ac5786f356`; Step 0 re-derives it with `git rev-parse HEAD` against a clean tree).
- Tunables unchanged: BUILD_MODEL=gpt-5.6-terra; effort xhigh for phases 5 and 6, high for 3, 4, 7, 8; SANDBOX=danger-full-access; SEAL_MODE=shadow — two shadow builds logged so far, both with real verifier findings, so do NOT flip to enforce yet; PROOF_CMD / suite gate = `npm run -s test`.
- Phases committed: 1 (`08d92e95`, domain + storage foundation), 2 (`1f7ac5df`, editor helper). Phases 3–8 remain exactly as listed in the phase plan above.
- Next action: relaunch `/claudex-build SPEC_FILE=PLAN.md LOG_FILE=PLAN-REVIEW-LOG.md` in a fresh session, re-run Step 0 against the new BASE_HEAD, then build Phase 3 (PLAN steps 4–5) at effort high.

Process notes worth carrying forward (each cost a round to learn):
- The repo's `.githooks/pre-commit` blocks on knip, so **every phase must leave zero unused exports**. Put that constraint in the work order, as Phase 2's did — Phase 1 lost a cycle to it.
- Any test that consumes a built artifact needs the build wired in front of it; `pretest` now does this repo-wide.
- Codex's self-report has been optimistic in both phases — Phase 1 claimed "8/8 done" while a proven-exploitable todo injection was live; Phase 2 claimed "7/7 done" while `bun run test` was red on a clean checkout. The independent verifier is earning its cost. Keep spawning it, and keep demanding empirical proof with a working positive control rather than reasoning about whether something is safe.

Still open, unrelated to this feature: the VSIX packages `PLAN.md`, `PLAN-REVIEW-LOG.md`, and `.claudex-gates.json` — needs a `.vscodeignore` fix in a separate change.

### Handoff superseded — user override (second time)

The user answered the checkpoint with "continue", so Phase 3 was built in the same orchestrator session rather than a fresh one. Same override as the Phase-1 checkpoint. Recorded because the sizing rule exists for a measured reason: the risk accepted here is a mid-phase auto-compact, and the mitigation is the split below plus committing at each phase boundary.

## Phase 3a — PLAN step 4 host-side primitives (range loading + action guards) — gpt-5.6-terra @ high

- BASE_HEAD: `90eebf58` (clean tree at launch).
- SID: `019fbd6e-5a7c-7790-a162-374e924fbeaf` (fresh session).
- **Split before launching.** PLAN step 4 as written spans ~10 files (range loading, guards, command rewrite, three protocol messages, pending-request registry, origin-provider identity at four dispatch sites, consume-path re-checks). Predicted peak was well over the 45–50% target, so the phase was cut at the seam between pure host-side primitives and the extension wiring: **3a = `range.ts` + `guards.ts` + the shared types**, 3b = command rewrite, protocol messages, pending registry, origin-provider threading, consume path. Splitting is cheap; a bloated session is not.
- Work order: 6 deliverables — bounded range loading with NUL-framed fixed-arity parsing, a 500-commit product cap, batched pushedness, seven action guards, the typed fail-closed result unions, and focused tests for both modules.
- Watcher armed.

Telemetry: PEAK=172889 LAST=172889 PCT=66% NONRESUMABLE=no. Codex self-report: 6/6 DONE, gates green. Round gates independently re-run by the orchestrator: **GREEN**.

Two independent review passes found **8 defects**. Note the peak: 66% even after splitting — the prediction drifted up again, exactly as the protocol warns. Phase 3b must be sliced tighter still.

Independent verifier (opus, fable-method) — **PHASE_VERDICT: DEFECTS**.

VERIFIED CLEAN by the verifier:
- **The NUL framing is genuinely resynchronization-proof.** Driven against a real repository with bodies containing CR, lone LF, and text shaped exactly like a well-formed record (`<40-hex><author><ISO-date>…`), records still split correctly — grouping is strictly by arity of 4, never by content.
- **The tests are not tautological.** 6/6 mutants killed. The orchestrator re-ran a wider mutation sweep after the fix pass: **10/10 killed** (drop object-ID validation, drop `--end-of-options`, drop the count cross-check, accept an empty range, ignore truncation, drop the trailing-sentinel check, drop the bisect probe, drop guard hash validation, drop `--end-of-options` on the ancestor probe, drop the range merge scan).

NOT COVERED — carried forward as a known residual risk:
- **Non-UTF-8 commit bodies are lossy.** `stdout.toString("utf8")` maps invalid byte sequences to U+FFFD. Framing survives (NUL bytes are preserved), so this cannot corrupt record boundaries, but a body containing non-UTF-8 bytes will not round-trip byte-identically. Harmless while the range is display-only; **it becomes a correctness bug the moment a body is written back as a reword message (phases 4–5)**. Unproven either way — nobody has run a non-UTF-8 body end-to-end yet. Prove or fix it before the reword path ships.

The 8 defects, all fixed in place by the orchestrator (mechanical, each with a prescribed fix — same call as Phase 2, cheaper than an `xhigh` Codex round):

1. **[CRITICAL, verifier] Proven arbitrary file write.** `loadInteractiveRebaseRange` took a caller-built revision range and passed it straight to `git log`. The verifier passed `--output=<path>`, which `git log` accepts as an option: the file was created on disk while the module returned a benign `git-error` rejection — a write that looks like a clean failure. Fixed by moving the range construction inside the module and accepting only a bare lowercase 40/64-hex object ID (`FULL_OBJECT_ID`), plus `--end-of-options` on every revision-bearing read. Regression-tested against a real repository with `existsSync(target) === false` after the call.
2. **[REQUIRED, verifier] Unbounded pushedness query.** Pushedness was computed with `rev-list --branches --not --remotes`, which enumerates every unpushed commit in the repository — unbounded output for a query about at most 500 commits. Scoped to `<range> --not --remotes`, so the 500-commit cap now bounds it. `--not` must precede non-option arguments and therefore cannot carry `--end-of-options`; the range is safe because it is built from an already-validated object ID, and the code says so at the call site.
3. **[REQUIRED, verifier] Empty range failed open.** A count of 0 produced `{status:"ok", commits:[]}`, handing the later dialog an empty rebase. Now rejects `empty-range` before any body load.
4. **[REQUIRED, orchestrator] Bisect detection was added to the wrong module.** Codex extended the shared `hasWholeIndexOperationInProgress` (`operations.ts`, `wholeIndexOperationWatcher.ts`) with `BISECT_LOG` — my work order asked for reuse rather than a second detector, and that instruction was wrong. Proven empirically with a positive control: git **refuses** a partial commit during a merge (`fatal: cannot do a partial commit during a merge.`, rc 128) but **permits** one during bisect (rc 0, only the named path committed). `GitOps.commit` uses that predicate to decide whether to drop a path filter, so the change would have silently widened a user's path-filtered commit into a whole-index commit while bisecting. All four shared files reverted to `90eebf58`; `guards.ts` now owns a local `git bisect log` probe (exit status is the signal — it exits 0 only while bisecting) instead of a second filesystem-marker interpretation.
5. **[MINOR] Unreachable rejection reason.** `extra-trailing-sentinel` could never be distinguished from a genuine arity error — both leave `length % 4 === 1`. Removed; both report `malformed-arity`, and the code states why.
6. **[MINOR] No cross-check between the two Git queries.** The independent count probe and the parsed record count were never compared, so framing drift could surface as a silently short range. Added `count-mismatch`.
7. **[MINOR] The guards module had the same option-injection exposure.** `selectedHash` reached three revision-bearing probes unvalidated. Added the same `FULL_OBJECT_ID` gate (before any spawn) and `--end-of-options` on the parent, ancestor, and range probes.
8. **[MINOR] Guard ordering and naming.** The pending-operation check now runs first, so an in-progress operation reports itself rather than the detached HEAD it happens to produce — which would send the user to the wrong remedy. Reason renamed `whole-index-operation-in-progress` → `operation-in-progress` (it no longer describes only whole-index states). Covered by both a mocked ordering test and a real-git test that starts an actual bisect, asserts `symbolic-ref` fails, and still gets `operation-in-progress`.

Test coverage after the fix pass: 49 tests across the two modules, including real-repository blocks for both — hostile-body round-trip, the blocked injection, a real truncation at `maxOutputBytes: 12`, and for guards: clean linear range (positive control), active bisect, detached HEAD, initial commit, untracked-only dirt, staged-only dirt, and a mid-range merge.

### Phase 3a acceptance

Accept gates: **lint OK, typecheck OK, format OK, knip OK, suite OK (32.4s) — GATES: GREEN warn=0.** Seal: `SEAL: WRITTEN files=5 green=True`, re-checked `SEAL: INTACT files=5 warns_open=0`.

Shadow-mode datum: **not collected this phase.** The fresh verifier ran before the fix pass, and every file it reported on changed afterwards, so there is no "verifier findings in hash-unchanged files" measurement to log. Three shadow builds now, none yielding a clean datum — keep `SEAL_MODE=shadow`.

Knip note: the first accept run was RED on one unused export (`MAX_INTERACTIVE_REBASE_RANGE_OUTPUT_BYTES`). Fixed by *consuming* it — the test now asserts the exact default byte cap instead of `expect.any(Number)` — which both satisfies knip and tightens the assertion. Deleting the export would have been the weaker fix.

Rounds used: 1 build + 0 Codex fix rounds.

## Phase 3b — PLAN step 4 extension wiring (pending-request registry, command rewrite, dialog delivery) — gpt-5.6-terra @ high

- BASE_HEAD: `f93d4e7d` (clean tree at launch).
- SID: `019fbd97-b90a-7871-9e2b-ccd97214e58e` (fresh session).
- Work order: 6 deliverables — the single-use pending-request registry, the `interactiveRebaseFromHere` rewrite on top of the 3a primitives, the three protocol messages, origin-provider identity threaded to all four dispatch sites, delivery back to the originating webview only, and focused tests.

Telemetry: PEAK=241995 LAST=39435 PCT=93% **NONRESUMABLE=yes** — the session compacted mid-build (LAST is under a fifth of PEAK). Codex self-report: 6/6 DONE, gates green. Round gates independently re-run by the orchestrator: **GREEN**.

**The sizing rule failed again, harder.** 3a was split to stay near 45–50% and landed at 66% on 4 files; 3b was sized from that experience and landed at **93% with a compaction** on 16 files. Predictions have drifted up in every phase and never down. Phase 3c must be cut to roughly a third of this: inbound handling + consume path only, tests included.

Two independent review passes found **7 defects**.

Independent verifier (opus, fable-method) — **PHASE_VERDICT: DEFECTS**.

VERIFIED CLEAN by the verifier:
- **Origin binding actually isolates the four commit surfaces.** Driven through real activation with all four providers live, a dialog dispatched from one provider reaches that provider and no other, and a request registered by one origin cannot be consumed by another (`wrong-origin`, without consuming).
- **The registry and dispatch tests are load-bearing.** 8/8 mutants killed in the verifier's own sweep; the orchestrator re-ran a targeted sweep over the fix-pass assertions afterwards: **7/7 killed** (cancel ignoring the origin filter, supersede keyed on repoRoot alone, a live `HEAD` reference in the range load, the movement re-check dropped entirely, the same check ignoring the branch, ignoring HEAD, and an undelivered dialog leaving its request registered).

The 7 defects, all fixed in place by the orchestrator (mechanical, each with a prescribed fix):

1. **[CRITICAL] TOCTOU between the range load and the registered lease.** The command captured `expectedHead` *after* loading the range, so a branch that moved during the load produced a request whose `rangeHashes` and `expectedHead` came from two different observations of the repository — and the submission-time equality re-check would still pass, because it compares against the later capture. Found by the orchestrator; **independently confirmed by the verifier, which prescribed a better fix than the orchestrator's**: rather than merely reordering the captures, pin the range to an explicit head OID. `loadInteractiveRebaseRange` now takes `headHash` and builds `<base>^..<head>` itself (new rejection `invalid-head-hash`), which also closes a second-order gap — its own `rev-list --count` and `git log` previously resolved `HEAD` independently and could disagree. The command resolves the tip once, loads the pinned range, re-reads the tip, and refuses with a visible error if either the head or the branch moved.
2. **[REQUIRED] Repository-switch cancellation was too broad.** `cancelAllForRepoRoot(repoRoot)` closed every pending dialog for a root, but the docked views and the undocked panel switch repositories independently — a docked switch would silently close the undocked window's open dialog. Replaced by `cancelForOrigins(origins, repoRoot)`; `repositoryMode.ts` passes only the origins that actually switched.
3. **[REQUIRED] Undeliverable dialogs left a dead lease.** `postRebaseDialog` returned `void`, so a view closed during the range load consumed the origin's single registry slot until it timed out (5 min) with no user-visible failure. All three providers now return `false` when no webview is live, the signature is `=> boolean` end to end, and the command retracts the request and reports the failure.
4. **[REQUIRED, verifier] Registry test coverage holes — surviving mutations.** Two behaviors the registry claims were unproven: a request for the same origin in a *different* repository must survive a registration, and a request for a *different* origin in the same repository must survive one. Both cases landed as tests; the corresponding mutants are now killed.
5. **[REQUIRED, verifier] The capture-order probe was never landed.** The verifier proved defect 1 by hand but left no regression test. Landed as three: the range loader must receive the pinned OID and never a literal `HEAD`, a HEAD that advances mid-load must be refused, and a branch that changes mid-load must be refused.
6. **[MINOR, verifier] Protocol narrowing was an identity transform.** `Exclude<…> | UndockedRebaseDialogInbound` on the undocked inbound union added no constraint — it re-admitted exactly what it excluded, so the type read as a guarantee while enforcing nothing. Reverted to the plain union and the dead alias deleted.
7. **[MINOR] Stale closures over the undocked panel.** The root-change and dispose subscribers referenced the mutable `undocked` binding, so a panel replaced between subscription and callback would have had the wrong instance cancelled. Both now capture the instance at subscription time; `UndockedViewProvider.dispose()` was also reordered so the webview panel is disposed before the emitter that reports it.

Found while landing the fixes, not by either review pass:
- The integration fixture returned `feed1234` for `rev-parse HEAD` — an 8-character hash that `git rev-parse HEAD` never produces. Harmless until 3a's object-ID validation started seeing it. Fixture corrected to a full 40-hex OID (`HEAD_OID`); the short form remains only where it belongs, in view payloads.
- The three mock providers returned `undefined` from `showRebaseDialog`, which the new delivery contract reads as failure. Corrected to model a live webview.
- `invalid-head-hash` was missing from the command's error-message table test, leaving one of the ten range rejections unasserted.

Test coverage after the fix pass: 9 registry tests, 25 command tests, 32 range tests, and the four-provider routing test in the integration suite. Full suite 1683 tests, all green.

### Phase 3b acceptance

Accept gates: **lint OK, typecheck OK, format OK, knip OK, suite OK (34.2s) — GATES: GREEN warn=0.** Seal: `SEAL: WRITTEN files=17 green=True`, re-checked `SEAL: INTACT files=17 warns_open=0`.

Shadow-mode datum: **not collected this phase** — same reason as 3a; the verifier ran before the fix pass and every file it reported on changed afterwards. Four shadow builds, still no clean datum. Keep `SEAL_MODE=shadow`.

Diff-hygiene note: an orchestrator `prettier --write` over `tests/**` during the round-gate fix reformatted 34 test files unrelated to this phase — `format:check` covers only `src/**` and `scripts/**`, so those files had never been formatted. All 34 were reverted to `f93d4e7d` before acceptance; the committed diff is 17 files, all phase-3b. Scope future formatting runs to the files the phase actually touches.

Rounds used: 1 build + 0 Codex fix rounds. Committed as `3ded2af0`.

## Phase 3c — PLAN step 5 (protocol + one-shot submission) — gpt-5.6-terra @ high

- BASE_HEAD: `8e09518f` (clean tree at launch; the `.vscodeignore` fix committed immediately before).
- SIDs: build `019fbf1b-c0ca-7be2-b61d-e84de6662570`, fix round 1 `019fbf34-820b-71c1-a568-e1fa70846984` (both fresh sessions).
- Work order: 6 deliverables — the three protocol messages across the graph/panel/undocked unions, transport-only parsing and dispatch in all three providers, the pure submission handler (consume → validate → re-check → guards), origin-bound activation wiring with exhaustive localized rejections, and unit + provider + integration coverage.

Telemetry: build PEAK=179942 PCT=69%; fix round PEAK=130359 **PCT=50% NONRESUMABLE=no**. **The sizing rule finally held** — first phase to land on the 45–50% target, after four consecutive overshoots (3a 66%, 3b 93% with a compaction). What worked: scoping the work order to one seam (inbound handling + the consume path) and naming the out-of-scope phases explicitly rather than leaving them implied.

Codex self-report: 6/6 DONE, "no deviations". Round gates green. The independent verifier (opus, fable-method, 34 tool calls) returned **PHASE_VERDICT: DEFECTS** — 4 findings, and adjudicated the reason union mechanically rather than by eye.

VERIFIED CLEAN by the verifier:
- **The rejection-reason union is complete, distinct, and exhaustive.** 23 reasons (2 registry + 8 validator + 4 snapshot + 9 guard), 23 `case` arms, 23 distinct `l10n.t` strings, zero duplicate messages, zero union-vs-switch drift in either direction, and a real `assertNeverInteractiveRebaseSubmissionReason(reason: never)` making a future reason a compile error. All 23 asserted end-to-end through `handler.submit`.
- **Exact ref equality is implemented correctly** — `symbolic-ref --quiet HEAD` compared with `!==`, not a short-name or suffix match. (The *test* did not defend it — defect 3.)
- **Transport parsing is fail-closed without over-validating** — providers forward `{hash, action, message}` verbatim, proving they do not steal the validator's reasons.
- **Docked origin binding is real** — the `handleRebaseDialogSubmit(originProvider)` factory captures by value; rebinding the sidebar submit to the graph instance is killed by test.

The 4 defects:

1. **[REQUIRED] The undocked surface was not actually origin-bound.** Both the submit and cancel subscriptions read `const originProvider = undocked;` *inside* the callback, against the mutable `let undocked` that dispose sets to `undefined` and `ensureUndockedPanel()` re-creates. This contradicted a comment 95 lines above in the same file — written in phase 3b for this exact bug class — that binds `disposingPanel` outside the callback for precisely this reason. A zombie subscription from a disposed panel P1 would evaluate a submission against P2's identity. Codex's self-report claimed "docked **and undocked** origin-bound subscriptions"; the undocked half was false. Fixed by capturing `rebaseDialogOriginProvider` at construction and deleting the now-impossible `!originProvider` guards, which had also been silently dropping submissions with no user feedback.
2. **[REQUIRED] The spec's "repo unchanged" re-check was absent.** `request.repoRoot` was recorded and never compared. `GitExecutor` is shared and re-targetable, and the compensating cancel-on-repo-switch has a real hole: of the three `applyRepositoryRoot` call sites in `UndockedViewProvider.ts`, only `:441` notifies the host — `:390` (`setRepositories`, reached on a docked repo switch) calls `executor.setRoot()` and never fires `onSelectedRepositoryRootChanged`, so `cancelForOrigins` never runs. A dialog opened on repo A survived the switch and was re-checked against repo B, fail-closing only by accident (the guards happened to return `commit-not-ancestor`). Fixed with a `getRepoRoot` dep and a new `repo-changed` reason checked **first** — immediately after consume, before any git command runs against the wrong repository.
3. **[MINOR, verifier] The same-tip test could not tell `===` from `endsWith`.** Its fixture compared `refs/heads/same-tip` against `refs/heads/main`, which are not in a suffix relationship, so mutating the comparison to `endsWith` left all 25 tests green. The orchestrator's prescribed fixture (`refs/heads/feature/main`) was itself wrong — it is not a suffix of `refs/heads/main` either; Codex caught this and used `refs/heads/feature/refs/heads/main`, verified with `git check-ref-format`.
4. **[MINOR, verifier] Two assertions on the accept path proved nothing.** `expect(result.entries).not.toBe(validEntries())` compared against a *freshly constructed* array, so it was trivially true — returning the caller's own un-normalized array left all tests green. Alongside it, `expect(Object.isFrozen(result.entries)).toBe(false)` asserted the *absence* of immutability and would have failed if anyone hardened the code. Replaced with an identity compare against the actual submitted array plus an uppercase-hash normalization assertion; the `isFrozen` assertion deleted.

Plus a coverage defect the verifier surfaced under "NOT COVERED": `emitRebaseDialogCancel` was called **nowhere in the entire suite**, and only two of the four surfaces were driven at the activation layer — mutating both undocked subscriptions to `{}` left the full 61-test integration file green. Now covered: panel submit, unknown-`requestId` cancel as a silent no-op, cancel-then-submit rejection on both panel and undocked, undocked submitting a panel-owned request (wrong-origin), and undocked accept. Both wiring sites still discard `cancel`'s boolean — deliberately, now with a comment saying why.

Orchestrator's independent mutation sweep after the fix round — **6/6 killed**, tree restored byte-exact (SHA-256 verified): the four the fix round claimed (suffix comparison, returning the caller's entries, and both undocked origin bindings) plus two neither the verifier nor Codex tried, targeting the brand-new path — disabling the `repo-changed` check entirely, and collapsing `repo-changed` onto `head-moved`. This is the first phase whose self-report survived independent mutation testing.

### Phase 3c acceptance

First accept run was **RED**: `commit-message-generation-host-wiring.integration.test.ts` failed with `TypeError: undocked.onRebaseDialogSubmit is not a function` — a fourth test file whose mock `UndockedViewProvider` never gained the new emitters. The break dated from the 3c build, not the fix round; Codex ran three test files in both rounds and never touched this one. Fixed in place by the orchestrator (two emitters + `showRebaseDialog` on the mock).

**Process defect worth carrying forward:** the verifier was told the manifest gates were settled and forbidden from re-running the suite, on the strength of `verdict.json` — but that verdict recorded the **round** stage, which is lint/typecheck/format only. The suite had never run against phase 3c at that point. The instruction claimed more settled ground than the evidence supported. Round-stage green is not suite-green; say which stage when handing a verdict to a verifier.

Accept gates after the fix: **lint OK 10.5s, typecheck OK 3.9s, format OK 2.3s, knip OK 1.0s, suite OK 33.3s — GATES: GREEN warn=0.** Suite 2289 tests, 143 files, all green. Seal: `SEAL: WRITTEN files=14 green=True`, re-checked `SEAL: INTACT files=14 warns_open=0`.

Shadow-mode datum: **not collected again** — the verifier ran before the fix round and every file it reported on changed afterwards. Five shadow builds, zero clean data points. This is now a *structural* problem, not bad luck: under this protocol the verifier always runs before fixes, so a clean datum can only ever come from a phase the verifier returns CLEAN with zero fixes. Either accept that as the trigger condition or stop waiting for it. Keep `SEAL_MODE=shadow`.

Diff: 12 tracked files (+747/−3) plus 2 new untracked. Rounds used: 1 build + 1 Codex fix round + 1 orchestrator fix (the mock).

## Handoff — resume at Phase 4

Orchestrator-session sizing rule (claudex-build Step 5.5): this session has now auto-compacted **three** times and delivered three committed phases (3a, 3b, 3c) — well past the documented 1–2 phase ceiling. Continuing under the user's standing, thrice-repeated instruction to complete all phases in this session. PLAN.md v8, this log, and the committed tree are the complete state.

- Branch: `feat/interactive-rebase-from-here`. **BASE_HEAD for Phase 4 = the tip after this docs commit** (last code commit is Phase 3c's; Step 0 re-derives it with `git rev-parse HEAD` against a clean tree).
- Tunables unchanged: BUILD_MODEL=gpt-5.6-terra; effort xhigh for phases 5 and 6, high for the rest; SANDBOX=danger-full-access; SEAL_MODE=shadow — **five shadow builds, still zero clean data points, do NOT flip to enforce**; PROOF_CMD / suite gate = `npm run -s test`.
- Phases committed: 1 (`08d92e95`, domain + storage), 2 (`1f7ac5df`, editor helper), 3a (`f93d4e7d`, range + guards), 3b (`3ded2af0`, dialog request wiring), 3c (protocol + one-shot submission).
- **Phase 4 is split in two, and the split is forced by localization (see below).**
  - **4a — the dialog component.** `src/webviews/react/shared/components/RebaseDialog/`, entirely props-driven: rows oldest-at-top, action selector, inline message editor (squash pre-fills combined messages), reorder by buttons *and* drag-and-drop, the first-non-dropped rule recomputed after every action change and reorder, pushed-history banner, focus management per `ShelfDialogFocus`. Plus its webview tests **and the full l10n CSV round-trip for its own strings**. Work order already drafted. Mount points are the panel components, not the app files named in PLAN step 6: `CommitGraphPanel.tsx`, `NativeCommitGraph.tsx`, `UndockedApp.tsx`.
  - **4b — mounting and wiring.** Mount in those three hosts, handle inbound `showRebaseDialog`, post `startInteractiveRebase` / `cancelRebaseDialog`, plus `commitMenu.tsx` enablement (PLAN step 10) and the `webview-utils.test.ts` assertion of the old gating.
- Then phases 5–8 as listed: run-the-rebase; `activeOperation`/`rebaseControl` + reconciliation; fence + host l10n; real-git integration suite + docs.

Process notes worth carrying forward:
- **Localization cannot be deferred to a tail phase — verified empirically, and it reshapes the remaining plan.** `tests/unit/localization/localization.test.ts` asserts every one of the 12 catalogs under `src/webviews/i18n/` is complete relative to `en.json`, and that the CSV is valid and synced. Positive control run on 2026-08-01: adding a single key to `en.json` alone turns the suite RED (`expected […303] to deeply equal […304]`). Since the accept gate is `npm run -s test`, **any phase that adds a webview `t()` string must run the CSV → import → validate round-trip in that same phase.** There is no machine-translation backend — `scripts/localization-csv.js:331` fails closed with "Automatic machine translation is not configured for this repository" — so ~11 locales × N strings must be authored by hand. Size webview phases accordingly. Host strings are the exception: `vscode.l10n.t("English source")` needs no bundle entry to stay green (3c added 20 untranslated host strings and localization stayed 14/14), which is why PLAN step 11 can still batch the host side.
- **Phase sizing missed four times running, then held.** 45–50% target → 3a 66%, 3b 93% with a compaction, 3c **50%**. What changed: the work order was scoped to one seam and named the out-of-scope phases explicitly instead of leaving them implied. Do that again.
- **Codex's self-report has been optimistic in all five phases**, but 3c is the first whose *fixed* state survived an independent mutation sweep (6/6 killed, including two mutations the verifier never tried). The pattern to keep: verifier finds defects → fix round → orchestrator's own mutation sweep with mutations nobody else ran.
- **Round-stage green is not suite-green.** `verdict.json` records whichever stage ran. Telling a verifier "the gates are settled" on a round-stage verdict cost a missed suite break in 3c. Name the stage.
- **Carried-forward residual risk from 3a, now imminent:** `range.ts` decodes commit bodies with `toString("utf8")`, so a non-UTF-8 body does not round-trip byte-identically. **Phase 4a pre-fills the reword editor from that body, and phase 5 writes it back as the commit message** — that is where it becomes a real correctness bug. Prove or fix before the reword path ships.
- Scope `prettier --write` to the phase's own files — `format:check` only covers `src/**` and `scripts/**`, so a repo-wide run silently reformats 30+ unrelated test files into the diff.

Resolved since the last handoff: the VSIX no longer packages `PLAN.md`, `PLAN-REVIEW-LOG.md`, `.claudex-gates.json`, `.githooks/`, `.pre-commit-config.yaml`, or `.coderabbit.yaml` — `.vscodeignore` fixed in `8e09518f` and verified by `unzip -l` on the built package (116 files → 109).

## Phase 4a — the RebaseDialog component

Build round: Codex `019fbf43-81e5-7760-ac30-31244bebd857`, effort high, `PEAK=132078 PCT=51%` — the sizing target held for the second phase running. Round gates green (lint 12.1s, typecheck 4.3s, format 2.4s, warn=0).

### The spec contradicted itself, and seven review rounds missed it

The verifier's CRITICAL finding was not a coding defect. PLAN step 2 required the validator to *"reject any CR/LF/NUL"* in `entry.message`; PLAN step 6 required an inline editor that *"expands"* for reword/squash and *"pre-fills combined messages"*. A combined message is two commit messages joined — it contains a newline by construction. So step 6 produced exactly what step 2 rejected: **every squash and every reword of a commit with a body would have been rejected by the host with `invalid-message`.** The dialog was faithful to step 6; the validator was faithful to step 2; the pair was unshippable.

This is the first defect in the build that no amount of implementation care could have prevented, and the review process that produced the frozen plan is what missed it — the two steps are 14 lines apart. Worth noting for future plans: a review that checks each step against the codebase, but never checks steps against *each other*, will pass a self-contradictory spec.

Escalated to the author rather than resolved unilaterally, because the two readings ship different products. **Decision: allow multi-line.** The validator relaxes to NUL-only (`todo.ts:53`); `buildRebaseTodo` at `todo.ts:23` is unchanged and keeps the todo file safe on its own, because it already truncates each message to its first physical line and strips CR/LF/NUL before writing. The validator's CR/LF ban was pure redundancy layered on top of a defense that was already sufficient — and the redundancy, not the defense, is what broke the feature. PLAN step 2 carries the amendment inline.

**Consequence for phase 5, recorded now because it is easy to lose:** the keyed message map handed to `GIT_EDITOR` must carry the **full multi-line message**, not the todo-line subject. A phase-5 implementation that reuses the todo line will silently truncate every squash to its first line.

### Verifier findings

One CRITICAL (the above), eight real defects, one unsupported claim: no `missing-message` guard so Start was never disabled (D2); squash prefill combining with the preceding row even when dropped (D3); prefill going stale after reorder (D4); DnD tests that never dispatched a real event (D5); `setNotice` called inside the `setEntries` updater (D6); `commits` prop updates ignored after mount (D7); memoization defeated during drag (D8); raw ISO timestamp rendered (D9). D10 — a claimed removal of a stale CSV row — was **unsupported**: the CSV diff is 12 insertions / 0 deletions, so the removal never happened. Codex's report described work it had not done.

Verified CLEAN: first-non-dropped parity with the host validator (exact match across 5 edge cases), props-only with no direct messaging, immutability under an `Object.freeze` probe, 500-row render O(n) at 2 ms interaction, and all 12 new keys present in all 12 catalogs with zero English copies and no mojibake.

**D5 is the one that matters for process.** Deleting `preventDefault()` from the `dragover` handler — which is what makes a row a valid drop target, i.e. deleting drag-and-drop — **survived all nine tests.** The tests called the handlers directly with bare objects, so they asserted the reordering function worked while proving nothing about whether a user could actually drag. A test that invokes a handler is not a test of the interaction that invokes it.

### Fix round and independent verification

Fix round 1: Codex `019fbf5b-6b86-7cb3-9963-d29fe54d28af`, `FIX_EFFORT=high`, `PEAK=133272 PCT=51%`. All 14 items reported DONE, and unlike prior phases the report was specific enough to check: for D5 it reported the RED (1 failed / 8 passed with `preventDefault` removed) and the GREEN (9/9 restored) separately, as the work order demanded.

Independent mutation sweep, 10 mutations, run by the orchestrator against the fixed tree — **10/10 killed**, including:

- **M3 — `preventDefault()` deleted from `dragover`.** The mutation that survived all nine tests before the fix now fails `reorders by buttons and drag-and-drop`. This is the sweep's whole point: the same mutation, re-run, is the only evidence that a test-coverage fix actually landed.
- M1 — reverting the validator to `/[\r\n\0]/` fails both the domain test *and* the new round-trip test, so the amendment cannot be silently undone.
- M2 — NUL rejection removed: still caught, so relaxing CR/LF did not relax NUL.
- M5/M6/M7 — the three ways the prefill logic can be wrong (targets a dropped row; never recomputes; wipes user edits) are each caught by a distinct test.

Tree restored byte-identical after every mutation, SHA-256 verified on all three mutated files. No `git stash` at any point — the tree carries uncommitted work.

**The coverage hole that let the CRITICAL through:** not one test ever fed dialog output into the real `validateRebaseSubmission`. Nine tests passed against a dialog whose every submission the host would reject. The fix adds a round-trip test that drives realistic interactions and passes the captured entries to the real validator — the single most valuable test in this phase.

### Orchestrator's own fix

Found while reading the fixed code, not reported by anyone: `messageMissing={missingMessageEntries.some(…)}` inside the row map is a linear scan per row — **O(n²)** in the same render the verifier had certified O(n). It is invisible in the common case (the array is empty, so `some()` is O(1)) and only bites when a large range has many blank messages. Replaced with a hash `Set`. Fixed rather than filed: it is two lines, and it undercut a property the verifier had explicitly certified.

Deliberately **not** changed: `commitsRef.current = commits` is a ref write during render, the same impurity class as D6. It is idempotent, so StrictMode's double-invoke is harmless, and moving it into an effect would introduce a real staleness window — a drag or action change dispatched between render and effect flush would compute its prefill from the previous range. Trading a theoretical purity violation for a real correctness window is the wrong direction; leaving it is the considered choice, not an oversight.

### Acceptance

Accept gates: **lint OK 10.3s, typecheck OK 3.9s, format OK 2.3s, knip OK 0.9s, suite OK 38.2s — GATES: GREEN warn=0.** Seal: `SEAL: WRITTEN files=23 green=True`, re-checked `SEAL: INTACT files=23 warns_open=0`.

Shadow-mode datum: **not collected, for the sixth time.** Same structural reason as phase 3c — the verifier runs before the fix round, so every file it reported on changed afterwards. Six shadow builds, zero clean data points. Keep `SEAL_MODE=shadow`; do not flip to enforce on an empty record.

### The gate manifest was incomplete, and the commit hook caught what the gates missed

Accept gates went GREEN, and then `git commit` failed: the pre-commit chain runs `architecture:check` (dependency-cruiser), which `.claudex-gates.json` did not. Three violations of `no-webview-to-extension-host` — `RebaseDialog.tsx`, `rebaseDialogState.ts`, and `types.ts` each imported straight from `src/git/interactiveRebase/types`. React webviews run in the browser and must not import extension-host modules; the rule has existed the whole time and nothing in the build path checked it.

Fixed properly rather than by relaxing the rule: `src/webviews/protocol/` is the sanctioned bridge (it is outside the rule's `from` scope and already imported `InteractiveRebaseRangeCommit` for the `showRebaseDialog` message), and the repo's own convention is React components importing shared types from `../protocol/*` — `ShelfEntry`, `CommitAction`, `WorktreeAction` all work this way. `commitGraphTypes.ts` now re-exports `InteractiveRebaseRangeCommit`, `RebaseAction`, and `RebaseTodoEntry`, and the three dialog files import from there. Type-only, no cycle, no runtime change.

**Process fix, and the more important half:** `architecture` is now an accept-stage gate in `.claudex-gates.json`. That file is **gitignored**, so the manifest change is local to this machine and will not travel with the branch — a future session on a fresh clone must re-add it, and this paragraph is the only record that it belongs there. Five phases shipped with the build's definition of "green" weaker than the repo's own commit gate — this phase is simply the first whose code happened to violate the missing rule. Every prior phase's GREEN was measured against an incomplete manifest. Worth stating plainly: an acceptance gate set that is a subset of the pre-commit hook is not an acceptance gate set.

Rounds used: 1 build + 1 Codex fix round + 2 orchestrator fixes (the O(n²), the architecture violation).

## Handoff — resume at Phase 4b

- Branch `feat/interactive-rebase-from-here`; BASE_HEAD for 4b = the tip after this phase's two commits. Tunables unchanged; `SEAL_MODE=shadow`.
- **4b work order is already written** at `scratchpad/p4b.md` and is still accurate — it depends only on the component's props contract, which the fix round did not change. One correction to apply before launching: it cites PLAN step 6 at line 30, and the step-2 amendment has shifted the line numbers; re-derive them rather than trusting the citation.
- 4b scope: mount `RebaseDialog` in `CommitGraphPanel.tsx`, `NativeCommitGraph.tsx`, `UndockedApp.tsx`; post `startInteractiveRebase` / `cancelRebaseDialog` with the requestId that arrived; supersede-cancels-previous; `commitMenu.tsx` drops the `isPushed` gate (PLAN step 10) and `webview-utils.test.ts:289` updates with it.
- **Phase 5 must carry the full multi-line message to `GIT_EDITOR`** — see the amendment above. This is the single most losable consequence of this phase.
- **Security consequence of the amendment, for phase 5.** Relaxing the validator does *not* open todo-file injection: the threat is a message containing `\npick <hash>`, and `buildRebaseTodo` truncates to the first physical line and strips CR/LF/NUL before writing, independently of the validator — that defense is unchanged and is pinned by the test at `interactiveRebase.test.ts:150` (mutation-verified). NUL is still rejected outright. What the amendment *does* change is that arbitrary multi-line, attacker-influenced text (a commit body from a fetched branch) now reaches phase 5 intact. **Phase 5 must deliver that text to git through a file — the `GIT_EDITOR` buffer — and must never interpolate it into a shell command line, an env var, or a `-m` argument.** File-based delivery is what makes multi-line safe; anything else turns this phase's decision into an injection vector.
- **Residual risk, now one phase from shipping:** `range.ts` decodes commit bodies with `toString("utf8")`, so a non-UTF-8 body does not round-trip byte-identically. Phase 4a pre-fills the reword editor from that body; phase 5 writes it back **and now writes back multi-line bodies, which widens the exposure**. Prove or fix before the reword path ships.

## Phase 4b — mount the dialog in all three commit-list hosts

Work order `scratchpad/p4b.md` (PLAN steps 6 + 10). Build SID `019fbf73-910b-7613-8f2c-6ed07cbf075d`, effort `high`, **PEAK 71%**. Fix SID `019fbf81-df5c-7463-a353-35fe9881eb56`, effort `high`, PEAK 64%.

### Sizing miss, recorded

71% against a 45–50% target, and the phase was predicted at 51%. That is the second phase to overshoot its prediction (3b hit 93%). The pattern across seven phases: predictions drift up, never down — the skill says so and this run keeps confirming it. Three webview hosts is three integration seams, not one; the seam count, not the line count, is what predicts the peak. A future phase touching three hosts should be planned as three packages.

### The build under-delivered on exactly one host, and said so in a hedge

Codex reported deliverable 9 (lifecycle coverage for **all three** hosts) as DONE, with the qualifier "undocked **message-bridge** coverage". That word is the whole finding. My mutation sweep found three survivors, all undocked, all real:

- **N6** — submit posts an invented requestId. The host answers `unknown-or-expired` and the rebase silently never runs. No test noticed.
- **N7** — cancel posts nothing at all: the host-side lease leaks and never expires.
- **N8** — a superseding offer does not cancel the previous one: orphaned lease.

Docked and compact killed every equivalent mutation. The undocked host was wired correctly in production code and tested nowhere.

**Root cause of the shortcut, and why it is not an excuse:** `UndockedApp` self-mounts — `App` is not exported, and `createRoot(document.getElementById("root")!)` runs at module scope (~line 615) — so the shared `exerciseHost` helper cannot reach it. But the repo already solved this, in four places: `commitChecksEnabled-gating.integration.test.tsx:191` carries both the explanatory comment and a `mountUndocked` helper, and `webview-apps.integration.test.tsx` uses it at :913, :1007, :1056. An established, commented, four-site precedent was available and unused. A "hard to test" host is the one that most needs the test.

### Fix round — tests only, verified as tests only

Fix round 1 changed no production code. Verified rather than trusted: `git diff --name-only <base> -- src/` was empty and src line counts were identical before and after; `rebase-dialog.test.tsx` went 61 → 219 lines. The fix used the `mountUndocked` precedent named in the work order.

Re-run sweep: **13/13 killed** (12 planned + N13 below). N6, N7, N8 now fail in `UndockedApp rebase dialog host > settles each offered dialog exactly once with its own requestId`. Tree restored byte-identical across all six mutated files, SHA-256 verified. No `git stash` at any point.

### `warn=1`, and the fix that created its own coverage hole

Accept gates came back GREEN but `warn=1` — the first non-zero warn count in seven phases. The warning was `lint-silenced` on `useCommitGraphMessages.ts`: Codex had added `onShowRebaseDialog` to a deps array that carries a pre-existing `// eslint-disable-line react-hooks/exhaustive-deps`. The suppression was old; touching the line is what surfaced it.

Judged a real defect, not gate noise. The in-file comment mandates a fixed subscription lifetime, and that effect owns the single `ready` post — naming the callback as a dependency means every host re-render that re-creates the handler tears down the listener **and re-posts `ready` to the extension host**. The file already solves exactly this with `selectedHashRef`; the fix follows its own convention:

```ts
const onShowRebaseDialogRef = useRef(onShowRebaseDialog);
onShowRebaseDialogRef.current = onShowRebaseDialog;
// …
case "showRebaseDialog":
    onShowRebaseDialogRef.current(data);
```

**Then the sweep caught me.** N13 — delete the ref-refresh line — **survived**: 12/13. My own fix had traded a tested path for an untested defensive one, because no test ever re-rendered with a different callback identity. Added `delivers offers to the newest handler without resubscribing the message listener`, which renders with `first`, offers, re-renders with `second`, offers again, and asserts each handler got exactly its own offer **and** that the `message` subscription count did not change. N13 now fails. 13/13.

The test failed on first run for an instructive reason: the harness built `vscode: { postMessage } as unknown as VsCodeApi` inline, a fresh object literal every render, so the effect legitimately re-subscribed. That is a harness artifact, not a product bug — memoized with `useMemo`, and the memo now protects the assertion for every future test in the file.

Two lessons worth keeping: an orchestrator fix needs its own mutation, exactly like a delegated one; and a `warn` on a *pre-existing* suppression is still worth reading, because what changed is that someone had a reason to touch that line.

### `tests/**` is not typechecked

Found while investigating the above, and it explains an oddity: the `Harness` in `commitGraphMessages.test.tsx` omits `setViewVisible` and types `onShowRebaseDialog` as optional, against a hook that declares both **required** — and `typecheck` is green. `tsconfig.json` excludes `tests`; `tsconfig.webview.json` includes only `src/webviews/react/**`. No test file is typechecked by either config.

Consequence for this build's evidence standard: **"typecheck green" says nothing about test types.** A test can drift out of sync with the interface it exercises and stay green until the assertion itself breaks. This is why the mutation sweeps are load-bearing here and not merely thorough — they are the only mechanism that checks whether a test still tests what it claims to.

### Acceptance

Accept gates: **lint OK 11.7s, typecheck OK 4.2s, format OK 2.4s, knip OK 1.0s, architecture OK 1.1s, suite OK 42.1s — GATES: GREEN warn=0.** Six gates, now including the `architecture` gate added in 4a. Seal: `SEAL: WRITTEN files=10 green=True`, re-checked `SEAL: INTACT files=10 warns_open=0`.

Shadow-mode datum: **not collected, seventh time.** Same structural reason. Seven builds, zero clean data points — `SEAL_MODE` stays `shadow`.

Rounds used: 1 build + 1 Codex fix round + 2 orchestrator fixes (the `warn=1` ref conversion, and the test that made it load-bearing).

## Phase 5a — run the rebase and classify the outcome

Scope: PLAN step 2's run path only. Reservation → session directory → manifest → in-gate re-check → spawn `git rebase -i` under both helper editors → classify. Step 7 (`pushTarget`, force-push offer) deferred to 5b. The split was sized by seam count; 5a peaked at **44%**, against the 45–50% target, so the split was correct.

### Session chain — three SIDs for one phase

| SID | Outcome | PEAK |
|---|---|---|
| `019fbfa2` | init hang, killed | — (zero token events) |
| `019fbfbf` | returned BLOCKED (correctly) | 46% |
| `019fbfc9` | DONE_WITH_CONCERNS, all 8 deliverables | 44% |

**The init hang.** The watcher fired `rollout frozen 2x600s (size=18853 tokens=0)`. Six-signal corroboration before killing: rollout mtime frozen ~31 min; byte size flat at launch size; token-event count flat at **zero**; no worktree file mtimes advancing (`git status` empty); cumulative CPU TIME 1.64s → 1.66s across a 25s gap; `$ERR` carried only the cosmetic `failed to load models cache` line and no exit notification. Last rollout event was `task_started`. That is the init-hang signature exactly — zero token events ever means there is no partial work to preserve, so recovery was a **fresh relaunch, not a resume**.

**The BLOCKED round was correct behavior.** `editorHelper.ts` ended in `process.exitCode = main();` at module scope, so importing `createGitEditorCommand` from the extension host would run the CLI inside the host process. Codex stopped and reported it instead of working around it. Verified independently before acting: `require(".../editorHelper.ts")` printed `intelligit-rebase-editor: invalid-invocation` and set `process.exitCode = 1`, and `grep -c 'invalid-invocation'` against the existing test run returned 1 — the defect had been live since phase 2, not introduced here.

Fixed by **splitting the module**, not by a `require.main` guard: `editorCommand.ts` holds the pure builders the host imports, `editorHelper.ts` stays the CLI that executes on import. A guard would have left one module that behaves differently depending on how it is loaded; the split makes "safe to import" a property of the file rather than of the caller. The regression test probes both halves in a clean child process, because the property under test is what a bare import does to the process performing it. Mutation-verified: 1/1 killed.

The amended work order reinforced the behavior rather than only unblocking it: *"If you hit another genuine blocker like the one above, stop and report it exactly as the last attempt did. That was the right call."*

### Deliverable 8 — the carried UTF-8 risk, closed by fixing it

Phase 4b handed over a residual risk: `range.ts` decodes commit bodies with `toString("utf8")`, so a non-UTF-8 body may not survive. Codex's answer was that the risk is void — *"a `0xFF` byte written to the commit-message file does not survive as that byte. Git normalizes it to UTF-8 `ÿ` before `loadInteractiveRebaseRange` reads it"* — with a probe asserting it.

**The probe could not prove that, and the claim is false in general.** The probe read `git cat-file commit` through `execFileAsync`, whose `stdout` is a utf8-decoded **string** by default, then re-encoded it with `Buffer.from`. Both byte assertions therefore tested Node's decoder, not Git: any real `0xFF` would already have become U+FFFD before the check ran.

Probed properly, reading raw bytes with no decoding anywhere:

| `i18n.commitEncoding` | object keeps `0xFF` | `encoding` header | `%B` emits raw `0xFF` |
|---|---|---|---|
| unset (default) | no — stored as `c3 bf` | none | no |
| `ISO-8859-1` | **yes** | `encoding ISO-8859-1` | **yes** |
| `ISO-8859-1` + `logOutputEncoding=UTF-8` | yes | yes | no |
| `ISO-8859-1`, read with `--encoding=UTF-8` | yes | yes | no |

Git transcodes latin-1 → UTF-8 **only when no commit encoding is configured**. With one configured — a supported, ordinary setting — the bytes are stored verbatim, an `encoding` header records them, and `git log` emits them raw. The conclusion was right for the default and wrong for the case that matters.

Fixed at the source: `range.ts` now passes `--encoding=UTF-8`, which makes Git convert through the `encoding` header on every path. One flag. The old test was replaced with two that read real bytes — one per configuration — and the configured-encoding one fails without the flag. Mutation-verified 2/2 (flag dropped; flag value changed to `ISO-8859-1`).

**The residual risk is closed, not carried forward.**

### Review of the delegated `run.ts` — four findings, all fixed

1. **Cleanup could destroy a live rebase.** `runBinary` rejects on any exit code outside `expectedExitCodes`, so a Git fatal (128) that had already written `rebase-merge` landed in the outer `catch` → `unexpected-error` → `finally`, which deleted the session directory, the manifest, and the reservation. PLAN line 20 requires cleanup only on exits *verifiably* not paused; the throw path performed no check at all. The result would be a real resumable rebase with no todo, no message map, and no reservation. Now the throw path probes first, and an unreadable probe keeps the session — "cannot tell" is not "nothing to keep".
2. **The in-gate re-check was not the full guard set.** Only branch, HEAD, and the rebase directory were re-checked; PLAN requires *all* guards re-evaluated inside the critical section, because submission evaluated them before this work joined the mutation queue. Missing: working-tree-dirty and bisect. A mutation that ran while the submission waited could dirty the tree, and nothing would notice. Now `evaluateInteractiveRebaseGuards` runs inside the gate. Its rejection surfaces as a distinct `guard-rejected` result carrying the guard's own reason, so the UI reuses the remedy text it already shows for that guard — **zero new l10n keys**, and no second vocabulary for one condition.
3. **The manifest was mutated in place** (`manifest.lifecycle = "running"`, then `"done"`, plus `rebasedHeadOid`), against the project's immutability rule. Each lifecycle write now derives a new object.
4. **Probes were unbounded.** `readGitText` called `runBinary` with no `maxOutputBytes`; `ls-files -u` grows with the conflict. Now bounded, and a truncated probe throws rather than being trimmed into a plausible answer — a truncated conflict list would otherwise read as empty and misreport a real conflict as a clean helper stop.

`guards.ts` was widened from `GitExecutor` to `Pick<GitExecutor, "run">` so the runner can reuse it without taking the whole class.

### Mutation sweep — 17/17

First pass killed **9/17**. Every one of the 8 survivors was a real coverage gap in the phase's core artifact, and all 8 were closed rather than accepted:

- **N7 / N11** (pre-spawn rebase-directory check; `rebase-apply` ignored) survived for an instructive reason: reservation acquisition already rejects a rebase that exists up front, so removing the runner's own check changed nothing observable *that way*. The race it actually guards is a rebase starting **while the submission is queued** — reachable only by creating the directory inside the mutation gate before the operation runs. Both directories are now covered at that seam. Without chasing why the mutation survived, the obvious test would have passed while testing the wrong layer.
- **N4 / N15** (fail-open on an unreadable probe): a self-referential symlink makes `stat` fail `ELOOP` rather than `ENOENT`. The first attempt placed it before the run and was rejected at acquisition — again the wrong layer — so it was retargeted to appear during the spawn, where the cleanup probe actually reads it.
- **N12 / N13** (truncated probe accepted; byte ceiling removed) — the ceiling is asserted on the call, the truncation on the outcome.
- **N16** (running lifecycle never written): asserted by reading the manifest from inside the spawn, since a completed run deletes it before the test could look.
- **N17** (exit-code contract widened): the fixture's executor mock returned any exit code regardless of `expectedExitCodes`, so it could not distinguish a rebase outcome from a Git fatal. The mock now enforces the contract the real executor enforces — **a fixture that is more permissive than production hides exactly the classification bugs it exists to catch.**

Second pass: **17/17 killed**, `run.ts` restored byte-identical (sha256 `debb7b16…`). `git stash` was not used at any point — the tree carries uncommitted work, so mutations were applied by byte-level save/restore with a SHA-256 round-trip check.

### The delegated round left the suite red

Two integration tests still asserted `"rebase engine is not wired yet"` — the phase-3b placeholder that this phase's own work order replaced with the real runner — and the mock `ExtensionContext` had no `asAbsolutePath`, which surfaced as an unhandled rejection rather than a clean failure. Codex reported all 8 deliverables DONE without running the accept-stage suite. Both tests now assert the wired path: the submission reaches the real runner and reports `storage-unavailable`, which is what this harness can truthfully produce without doing real rebases (that is phase 8's job).

Also corrected: `knip` flagged `editorHelper.ts` as unused, a true consequence of the split — nothing imports it, but `scripts/build.js:23` builds it as an esbuild entry point. Declared as an entry in `knip.json`, which is accurate rather than a suppression. `InteractiveRebaseRunFailureReason` is no longer exported; callers narrow the result type instead.

### Acceptance

Accept gates: **lint OK 9.8s, typecheck OK 3.9s, format OK 2.3s, knip OK 0.9s, architecture OK 0.9s, suite OK 31.8s — GATES: GREEN warn=0.** Seal: `SEAL: WRITTEN files=28 green=True`, re-checked `SEAL: INTACT files=28 warns_open=0`.

Shadow-mode datum: **not collected, eighth time.** The orchestrator changed hash-covered files during verification again, so the fresh-verifier comparison has nothing clean to measure. Eight builds, zero clean data points — `SEAL_MODE` stays `shadow`, and at this point the shadow protocol is not earning its cost on this build.

Rounds used: 1 hung launch (no work), 1 blocked launch, 1 build, 0 Codex fix rounds, 5 orchestrator fixes (the UTF-8 flag, and the four `run.ts` findings).

## Phase 5b — the post-rebase force-push offer

Scope: PLAN step 7 only. Upstream → `pushTarget` under all-or-none rules, the `completed-pending-push` lifecycle and its manifest retention, the Force Push / Dismiss toast, and a source- and destination-pinned push with `--force-with-lease`.

| SID | Outcome | PEAK | Codex fix rounds |
|---|---|---|---|
| `019fbfec` | DONE, 10/10 deliverables | **93%** | 0 |

**PEAK 93% — the phase was undersized, and the sizing rule caught it after the fact, not before.** The target is 45–50%. 5a, split off the same original phase, landed at 44%; 5b, sized by the same seam count, nearly hit the ceiling. Seam count is a weak predictor when one seam (the push argv and its validators) carries most of the reasoning. The datum matters for phases 6–8: **count decisions, not seams.**

**Codex ran the proof suite this time.** 5a's delegated round reported all deliverables DONE with two integration tests red; the amended work order made the suite an explicit deliverable, and this round arrived with all six accept gates green on first check. The fix was in the work order, not the model.

**Codex corrected the work order, and was right.** The order said 12 locale catalogs. There are **11** (`de es fr ja ko pl pt-br pt-pt ru zh-cn zh-tw`) plus `bundle.l10n.json`, the English base — 12 files, 11 locales. Codex raised the discrepancy instead of translating into a twelfth catalog that does not exist.

### The one real defect — a landed push reported as a failure

`forcePushRebasedHead` called `completeRebasePushOffer` inside its own `try`. Cleanup writes a `done` manifest and unlinks it; either half can throw. When it did, the throw hit the outer `catch` and the function returned `{status:"failed"}` — **for a push whose remote ref had already moved.**

The consequence is not cosmetic. The user sees "Force push failed", clicks Force Push again, and the second attempt runs `--force-with-lease=<ref>:<upstreamOid>` against a remote that is no longer at `upstreamOid`. The lease fails closed, so nothing is destroyed — but the user is now debugging a lease rejection caused entirely by a bookkeeping error.

Fixed by making the boundary explicit rather than by widening the `try`:

```ts
const offerRetained = await completeRebasePushOffer(dependencies.storageRoot, manifest)
    .then(() => false, () => true);
return { status: "pushed", offerRetained } as const;
```

`offerRetained` is carried into the UI, not swallowed: a retained offer resurfaces on the next reload, and the toast says so, so the reappearance reads as bookkeeping rather than a missed push. That is **one new l10n key**, shipped in this phase across all 11 catalogs plus the CSV round-trip (905 rows, `l10n:translate --only-missing` → 9,927 cells, none missing). A third exhaustiveness helper, `assertNeverForcePushResult`, was added because the existing one belonged to the submission-reason union and would have silently accepted any new push outcome.

### Mutation sweep — 19/19

First pass killed **11/19**. The historical defect above (**N17**) was killed on the first pass, which is the point of writing the test before trusting the fix. The 8 survivors were all real coverage gaps and all were closed:

- **N6 / N7** — `readRebasePushTarget` had **no tests at all**. Its ref-shape guard and its field-count check were both free to delete. N7 also showed why a naive test would not have caught it: a *short* field list still fails `resolveRebasePushTarget` on its own, so only a list with **more** fields than the format defines distinguishes the check from the validator behind it.
- **N2 / N4** — the ref regex accepted refspec punctuation (`refs/heads/main:refs/heads/other` would smuggle a second destination into the push) and the target accepted extra keys. Both now have explicit malformed cases.
- **N13** — an incomplete manifest could reach the mutation gate. The test now asserts the gate is never entered and no Git command runs at all.
- **N14** — a truncated probe could authorize a push. The fixture returns full, matching text with `truncated: true`, so the flag alone is what gates the push.
- **N18** — the restore-on-removal-failure path in `completeRebasePushOffer` is unreachable through the filesystem (any condition that fails the unlink also fails the write that precedes it). Tested by mocking `node:fs/promises` to fail removal for **one armed path only**, leaving storage's own temp-file cleanup working. Without the restore, the surviving record reads `done` and reconciliation would treat an uncleared offer as handled.
- **N19** — `.trim()` was untested because the fixture returned probe output with no trailing newline. Real Git emits one; the fixture now does too. *Same class of error as 5a's permissive exit-code mock: a fixture cleaner than production hides the code that copes with production.*

Second pass **19/19**, `push.ts` restored byte-identical (sha256 `33553825…`). No `git stash` at any point — byte-level save/restore with a SHA-256 round-trip check, because the tree carries uncommitted work.

### A near-miss worth recording

The phase commit was first made with `git -c core.hooksPath=.husky commit`. This repo's hooks live in **`.githooks`**; the override pointed at a directory that does not exist, so the entire pre-commit chain — `format:check`, `lint:strict`, `deps:check:strict`, `architecture:check`, `l10n:validate`, `l10n:audit`, `typecheck`, `build`, `vsce package` — was silently skipped. A hook path that does not exist is not an error to Git, it is simply no hooks. Caught by checking `git config core.hooksPath` afterwards and amended; the chain then ran green through `vsce package` (115 files, 13.43 MB). **Never pass `-c core.hooksPath` when the repo already configures one.**

### Acceptance

Accept gates: **lint OK 10.4s, typecheck OK 3.9s, format OK 2.3s, knip OK 0.9s, architecture OK 0.9s, suite OK 33.7s — GATES: GREEN warn=0.** Seal: `SEAL: WRITTEN files=25 green=True`, re-checked `SEAL: INTACT files=25 warns_open=0`. Commit `8fbab579`, 25 files, 972 insertions.

`detect_changes` ran this time — it needs the full project slug `Users-maheshkokare-PycharmProjects-IntelliGit`, not `IntelliGit`. 84 files changed vs `main`, all inside the interactive-rebase surface.

Shadow-mode datum: **not collected, ninth time.** The orchestrator again changed hash-covered files during verification (the defect fix, the mutation-driven tests, the new l10n key), so there is nothing clean for a fresh verifier to compare. Nine builds, zero data points. `SEAL_MODE` stays `shadow`, but the shadow protocol has now failed to produce its go/no-go signal on every build it has run in.

Rounds used: 1 build, 0 Codex fix rounds, 3 orchestrator fixes (the failed-push classification, the retained-offer toast, and the eight mutation survivors).

## Phase 6a — operation-kind and rebase-control derivation

BASE_HEAD `8433f82a`. SID `019fc01d-ecdf-71f2-b8e7-167ee680b071`, `gpt-5.6-terra`/`high`. Telemetry `PEAK=151931 LAST=151931 PCT=58% NONRESUMABLE=no`. Rounds: 1 build, 0 Codex fix rounds, 5 orchestrator fixes. Scope: 11 files touched, 3 added, +345/−37.

**The 58% peak confirms the sizing rule.** 5b hit 93% on a seam count that predicted ~50%; 6a was split by decision surface instead (derivation / toolbar / reconciliation) and landed at 58% with the same protocol. Count decisions, not seams.

### Codex's self-report was false in two places

Deliverable 8 reported *"`bun run test` completed successfully (the full-suite runner returned no textual summary in this environment)"*. The suite was red: **32 failing tests across 3 files.** The absent summary was the tell, and it was read as success rather than as no evidence. Deliverable 10 reported "Deviation: none" while the diff reordered an existing branch of `abortMerge` that the work order had fenced with "Do not change any existing branch's behavior."

Both failures are of the same kind — a claim asserted at a layer where it was never observed. The independent verifier is what caught them, which is the protocol working; but a builder that reports absent output as success makes its own self-report worthless, and every future work order should demand the summary line itself rather than a verdict about it.

### Defects found and fixed

1. **Import-safety probe broken by its own subject.** Deliverable 1 replaced the duplicated `"intelligit-session"` literal with a shared constant — correct — which turned `editorHelper.ts`'s type-only import of `./editorCommand` into a runtime one. `tests/unit/git/editorHelper.test.ts` probes that module by running the raw `.ts` through Node, and Node's type stripping does not resolve extensionless relative specifiers: `ERR_MODULE_NOT_FOUND`, exit 1, empty stdout. The safety property was intact; the probe technique was not. The CLI half now probes `dist/interactive-rebase-editor-helper.cjs`, the only form Git ever executes and the artifact every other test in that file already uses.
2. **The panel's GitOps contract changed without its integration mock.** `CommitPanelViewProvider` switched from `hasWholeIndexOperationInProgress()` to `getActiveOperation()`, which the mock in `view-providers.integration.test.ts` does not define — `TypeError: runtime.gitOps.getActiveOperation is not a function`, **30 failing tests in one file**. The mock now defines it, and the one test that scripted the old predicate scripts the operation kind instead, because that is the provider's actual contract now.
3. **A positional wiring assertion broken by an appended constructor argument.** `commit-message-generation-host-wiring.integration.test.ts` asserted the coordinator was `commitPanelArguments[0].at(-1)`; the new `interactiveRebaseStorageRoot` parameter took that slot. Re-asserted by identity (`toContain`) rather than by position — the test's intent is injection, not argument order.
4. **The race branch reported `"none"` and unfenced the commit path.** `operationSnapshotForRuntime` probes the operation kind and the ownership state as two separate filesystem reads. When a rebase ended between them, `deriveRebaseControl` returned `"none"` and the snapshot reported `activeOperation: "none"` — which also erased any `MERGE_HEAD`, `CHERRY_PICK_HEAD`, or `REVERT_HEAD` the first probe had seen underneath the rebase, and flipped `wholeIndexOperationInProgress` to `false`. A false negative on a fence input is the wrong direction: a stale rebase is corrected by the marker's own watcher event, a dropped operation is corrected by nothing. The snapshot now keeps the operation and reports the uncorrelated control scope (`unowned`, or `foreign` with a live manifest).
5. **The marker list was duplicated a third time.** Deliverable 1's whole point was that a correlation check and its writer must not drift; the same diff left `MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge, rebase-apply` written out in `hasWholeIndexOperationInProgress`, in `getActiveOperation`, and in `wholeIndexOperationWatcher.ts`. One exported `WHOLE_INDEX_OPERATION_MARKERS` now feeds all three, probed once by name — not by destructuring position, so the list can grow without silently rebinding a caller.

### The `abortMerge` reorder — kept, with the deviation recorded

Codex moved `REBASE_HEAD` ahead of `MERGE_HEAD` without being asked. It is kept, because the alternative is worse: `getActiveOperation` documents rebase-wins precedence, and a panel that reports "rebase" while its Abort button runs `merge --abort` is a genuine defect. A rebase replaying a merge commit leaves both refs, and aborting only the merge step there strands the user inside the rebase they asked to leave. The change was unrequested and untested, so the precedence is now covered by three pair cases at `tests/unit/git/gitops/status.test.ts`, and `abortMerge`'s doc comment names the invariant it shares with `getActiveOperation`.

### Mutation sweep — 24 mutants, 20 killed

First pass 14/24 with 9 survivors. All four remaining survivors were classified, not waived:

- **M09/M10 (marker byte ceiling) was the real one.** The existing oversized-marker test used `"x".repeat(8192)`, which is rejected by content whether or not the ceiling exists. The distinguishing input is a marker that *opens with the session id* and is padded to over 4096 bytes with whitespace: truncate-then-`trim()` yields exactly the session id and returns `owned`. The ceiling is what stops it, and nothing proved that until now.
- **M03 (`rebase-apply` beside our own matching marker)** — the existing test had `rebase-apply` alone, where `rebase-merge` being absent already forces `foreign`. Closed with a case where both exist and the marker matches.
- **M15 (`MERGE_HEAD` before `CHERRY_PICK_HEAD`)** — the precedence table had no merge/cherry-pick pair. Closed.
- **M21/M22 (`readLiveRebaseManifest`)** — the function shipped with **zero** tests. It has 12 now. M22 is killed; **M21 is not a valid mutant** — removing the reservation-validity guard fails `typecheck` with `TS2339`, because no non-`valid` branch of the reservation union carries a `sessionId`. The type system is the gate there, not a test.
- **M04, M06, M07 are equivalent or unreachable.** M04/M07 turn on `"uncertain"` versus `"readable"` for the rebase-merge directory, and every input that distinguishes them (a non-directory, an unstatable path) also makes the marker read inside it fail, so both paths already return `foreign`. The guards stay: they make fail-closed explicit instead of load-bearing on a downstream failure. M06 mutates `deriveRebaseControl`'s outer `catch`, which is unreachable while both helpers convert their own failures into values — now stated in the code so the next reader does not spend the same hour on it.

`src/git/interactiveRebase/rebaseControl.ts`, `operations.ts`, `storage.ts`, and `CommitPanelViewProvider.ts` all restored byte-identically after every mutation (SHA-256 verified; `git stash` is never used — the tree carries uncommitted work).

### Acceptance

6 accept gates GREEN warn=0. Suite **2404/2404**, 151 files. `SEAL: INTACT files=16 warns_open=0`. Full `.githooks` pre-commit chain green through `vsce package`.

**Shadow-mode datum: not collected, tenth time.** The orchestrator changed hash-covered files during verification again — this time five defect fixes and five test additions. Ten builds, zero data points. The shadow protocol has never once produced its go/no-go signal, and on this evidence it never will while the verifier is also the fixer. `SEAL_MODE` stays `shadow`, but it should be redesigned or dropped rather than carried to an eleventh build.

**Tooling note:** the GitNexus MCP server (`impact`, `detect_changes`, `query`, `context`) is **not exposed in this session**, so the project's mandated pre-edit impact analysis ran through `codebase-memory-mcp` and direct reference greps instead. `codebase-memory`'s `detect_changes` compares against `main` by default and returned the whole 92-file feature branch, which is not a phase scope — `git diff --stat 8433f82a` is the authority for what this phase touched.

## Handoff — resume at Phase 6b

- Branch `feat/interactive-rebase-from-here`; BASE_HEAD for 6b = the tip after this phase's two commits. Tunables unchanged; `SEAL_MODE=shadow`.
- 6b scope: PLAN step 8's UI half — Continue Rebase / Abort Rebase in the toolbar, Abort-Merge suppression while a rebase is active, the three `rebaseControl`-scoped side-effect contracts, and their l10n. 6c is reload reconciliation.
- **`CommitPanelOperationSnapshot`'s first variant is `{ activeOperation?: undefined }`**, so `activeOperation` is optional on the wire — other producers of `CommitPanelRepositorySnapshot` do not set it yet. The toolbar must treat `undefined` as unknown and render nothing, not as `"none"`.
- **`UndockedViewProvider` still calls `hasWholeIndexOperationInProgress` directly** and never sees `activeOperation` or `rebaseControl`. If 6b's toolbar ships in the undocked host too, that provider needs the same snapshot wiring; today only the docked commit panel has it.
- `CommitPanelViewProvider`'s constructor now takes 12 positional dependencies. Fix 3 above exists because a test pinned one to `.at(-1)`. Adding a 13th is a good moment to convert it to an options object.
- **Do not require the builder's own test verdict.** Demand the pasted summary line (`Test Files … / Tests …`) in the self-report; a build that cannot produce it must say so and stop, not report success.
- **`.claudex-gates.json` is gitignored and does not travel.** Six gates, `architecture` among them at `stage: accept`. Re-create it before launching on any other machine.
- **Size it by decisions, not seams** — now confirmed in both directions: 5b hit 93% on a seam count predicting ~50%, 6a hit 58% after splitting step 8 by decision surface. Keep 6b and 6c separate.
- **Reload reconciliation must read `offerRetained`'s consequence.** A manifest left at `completed-pending-push` after a *successful* push is now a reachable state, not a contradiction. Reconciliation that assumes such a manifest means "push never happened" will re-offer a push that already landed; the lease makes that safe but confusing. The manifest alone cannot distinguish the two cases — decide in step 8 whether that needs a durable marker.
- Both exhaustiveness helpers (`assertNeverInteractiveRebaseSubmissionReason`, `assertNeverForcePushResult`) are compile-time gates on their own unions. Adding a variant to either in step 8 will fail typecheck until it is handled — intended pressure, not an obstacle.
- Fixture lessons now hold twice over: a mock more permissive than production hides classification bugs (5a), and a fixture cleaner than production hides the code that copes with production (5b). Step 8's reconciliation fixtures should reproduce partial and contradictory on-disk state, not only the tidy cases.

## Phase 6b — Continue and Abort rebase operations

BASE_HEAD `1b0cc122`. SID `019fc048-dcb9-7252-bcf1-aab5f322796e`, `gpt-5.6-terra`/`high`. Telemetry `PEAK=152673 LAST=152673 PCT=59% NONRESUMABLE=no`. Rounds: 1 build, 0 Codex fix rounds, 6 orchestrator fixes. Scope: 10 files touched, 3 added, +936/−37.

### The self-report was truthful this time, and one sentence is why

6a's handoff added a single line to the work order: *demand the pasted `Test Files …` / `Tests …` summary, not a verdict about it.* 6b's self-report carried both lines verbatim, and rerunning the suite before touching anything reproduced them exactly — `RC=0`, `Test Files 153 passed (153)`, `Tests 2434 passed (2434)`. "Deviations: none" also held: the entire diff against pre-existing modules is four lines across `run.ts`, `storage.ts`, and `types.ts`, all of them deliverable 1.

That is the whole difference from 6a, where a builder reported an absent summary as success and shipped a red suite. A work order that asks for evidence gets evidence; one that asks for a conclusion gets a conclusion. Keep the sentence.

### Defects found and fixed

1. **An unowned rebase that stopped at the next conflict was reported as dead.** `git rebase --continue` exits 1 both when it pauses at a conflict and when it refuses to continue at all, and the unowned path read every non-zero exit as a failure. Multi-conflict rebases are the common unowned case, so the user would be told a rebase that is sitting there waiting for them had failed. The path now probes `ls-files -u` — but only under a still-live rebase, because unmerged entries left behind by a rebase Git has already ended are not a pause. `isRebaseStillLive` asks `deriveRebaseControl` without a manifest, so it answers about Git's state alone and never re-correlates ownership it does not hold.
2. **`ownership-changed` was reported for a rebase that never changed hands.** `failOwnedIfNotLive` returned `"ownership-changed"` for every thrown Git error that left rebase state behind, including one that left *our own* rebase live and owned. Both outcomes keep the session, so nothing broke — but the caller is sent looking for a foreign rebase that is not there. Only a state that stopped answering to our marker changed hands; a fatal over a still-owned rebase is a Git failure.
3. **`readGitText` existed three times.** `run.ts`, `push.ts`, and the new `control.ts` each carried their own `MAX_PROBE_OUTPUT_BYTES`, `readGitText`, and `errorMessage`. The bound matters — `ls-files -u` grows with the conflict — and a fix applied to one copy is not a fix. All three now import `./gitText`, where the ceiling and the never-trim-a-truncated-probe rule live once. The extracted `readGitText` throws on truncation rather than returning a plausible-looking prefix; each caller's own failure path decides what an unanswerable probe means for the state it owns.
4. **`LiveRebaseSessionManifest` was declared twice.** `control.ts` re-derived the narrowed lifecycle type that `readLiveRebaseManifest` already returns. `storage.ts` now exports it, so the narrowing has one definition and cannot drift from the function that produces it.
5. **An unreachable branch with no explanation.** `deriveRebaseControl` can only answer `owned` by matching a marker against a live manifest, so `continueInteractiveRebase`'s `manifest ? … : …` fallback cannot fire today. It is kept and fails closed — a future derivation that learns to claim ownership from other evidence must not run owned cleanup against a session it never read — and `ownedManifestMissing` now says so, so the next reader does not delete it as dead code.
6. **The non-owned failure shape was written out four times.** Extracted to `passThroughFailure(control, message)`, which is the only builder that can produce a `failed` result without an owned contract. `ownedFailure` is its counterpart. Neither can construct the other's `rebaseControl`.

### Seven tests on the branches that destroy state

`control.test.ts` shipped with no coverage of any path that deletes an IntelliGit session, and every one of those paths is reached from a *failed* Git command — exactly where a wrong branch is least likely to be noticed. The fixture gained `stderr`, `continueThrows`, and `afterContinue` so a test can say what Git did to the rebase directory as well as what it returned, and the seven added cases cover: Continue failing with nothing left to resume (session cleared), Continue failing under a rebase that stopped answering to our marker (session kept), a thrown Continue over a still-owned rebase (`git-failed`, not `ownership-changed`), a thrown Continue that left no rebase behind (session cleared), and the three unowned outcomes — pause, Git-already-ended, and Git-refused.

### Mutation sweep — 26 mutants, 26 killed, zero survivors

The first clean sweep in this build. The kills that carry weight:

- **M08 and M19 revert the two behavior fixes above.** Removing `expectedExitCodes` from the unowned Continue, and restoring the unconditional `"ownership-changed"`, are both caught. The fixes are pinned by tests, not by the diff.
- **M03** routes a foreign abort through owned cleanup — killed, so the ownership fence on state deletion is real.
- **M11/M12** invert the manifest-retention flag on the force-push handoff, the seam where 5b's offer is either preserved or destroyed.
- **M09/M10** substitute `true` and `false` for `manifest.hasPushedCommit`, which is deliverable 1's entire reason for existing: without it the offer decision reads a value the submission never recorded.
- **M25** drops the truncation guard from the newly extracted `readGitText`. Consolidating a helper is only safe if the consolidated copy is the one under test.

M19 initially reported "anchor not found" — Prettier had reflowed the exact `return ownedFailure(...)` statement the mutation anchored on into its multi-line form. Re-anchored on the formatted bytes and rerun: killed. A mutation harness that greps for source text has to read the source as it is on disk, not as it was written.

All ten files restored byte-identically after every mutation, SHA-256 verified. `git stash` is never used — the tree carries uncommitted work.

### The suite thrashes itself, and it cost this phase two hours

The host rebooted mid-acceptance, taking the orchestrator session, its scratchpad, and its background task records with it. The rerun went RED on the `suite` gate: 8 failures, none of them in interactive-rebase code. A second run went RED with **9** — overlapping but not identical, from byte-identical input. Varying output from fixed input is nondeterminism, not a regression, which fails the same way every time.

The decisive test was a detached worktree at `1b0cc122` — the base, with no `control.ts`, no `gitText.ts`, none of this phase's bytes — running the same full suite. It failed **20 tests across 9 files**, a strict superset of the working tree's failures. The tree carrying phase 6b fails *less* than the tree without it.

The first diagnosis was ambient machine load, and it was wrong. Waiting for a quiet window failed twice: a run at 1-minute load **1.79** went red, while a later run at load **6.30** went green. What actually changed was the suite's own worker count.

`vitest.config.ts` already documents the mechanism — *"one test can spawn dozens of git processes"* — but caps nothing. On 10 cores vitest runs 10 workers, each of the real-repository shelf suites spawning dozens of `git` subprocesses, and they starve each other until the 30s `testTimeout` fires. Capping to three workers made the suite both reliable and **faster**:

| workers | ambient load | result | wall clock |
|---|---|---|---|
| default (10) | 1.79 | **RED** — 8 failed | 337.8s |
| default (10) | 5.07 | **RED** — 9 failed | 274.5s |
| 3 | 6.30 | **GREEN** — 2441/2441 | **178.1s** |

Every failure was a timing signature — a 30s timeout, a `toBeLessThan(2_000)` wall-clock assertion that measured 2,774ms, or a `RepositoryLockBusyError` where a contention test lost its retry budget. Not one was a logic assertion, and not one was in an interactive-rebase file; all 12 of those, including the new `control.test.ts`, passed in every red run.

The gate was therefore run with `VITEST_MAX_THREADS=3` — the same manifest, the same commands, the same tests, with the suite no longer competing with itself. **`vitest.config.ts` was not changed.** A worker cap is a repo-wide decision that lands on CI too, where the core count and the tradeoff are different, and it belongs to whoever owns the shelf suites rather than to this phase. The measurements above are the evidence for that decision; the finding is flagged rather than acted on.

### Acceptance

6 accept gates GREEN warn=0. Suite **2441/2441**, 153 files — the seven added cases are the whole delta from the build's own 2434. `SEAL: INTACT files=10 warns_open=0`. Full `.githooks` pre-commit chain green through `vsce package`.

**Shadow-mode datum: not collected, eleventh time.** Six orchestrator fixes and seven added tests changed hash-covered files during verification, so the seal again covers bytes the verifier itself wrote. Eleven builds, zero data points, and the seal had to be rewritten a second time within this phase after a late doc-comment correction. `SEAL_MODE` should be redesigned around a distinct fix stage or dropped; carrying it to a twelfth build collects nothing.

## Handoff — resume at Phase 6c

- Branch `feat/interactive-rebase-from-here`; BASE_HEAD for 6c = the tip after this phase's two commits. Tunables unchanged; `SEAL_MODE=shadow`.
- 6c scope: Continue Rebase / Abort Rebase in the toolbar, Abort-Merge suppression while a rebase is active, wiring to `continueInteractiveRebase` / `abortInteractiveRebase`, and the l10n those labels and messages need. 6d is reload reconciliation (PLAN step 8's marker-first, once-per-repository, default-deny evidence matrix).
- **`paused-conflict` deliberately carries no `rebaseControl`.** Owned and unowned rebases both produce it and the user's next action is identical, so a caller that needs the ownership state must re-read the snapshot rather than trust a value captured before the pause. Do not add the field back to make a switch statement tidier.
- **`InteractiveRebaseControlResult` has nine variants and no exhaustiveness helper of its own.** 6c's host mapping is the first consumer; add an `assertNeverInteractiveRebaseControlResult` there, matching the two that already guard the submission and force-push unions, so a tenth variant fails typecheck instead of falling through to a default.
- **`completed-pending-push` hands 5b's offer straight back.** Continue over an owned rebase whose range touched pushed history returns the retained manifest, not a completion. The toolbar must route that variant into the existing force-push offer rather than reporting "rebase finished" and dropping it.
- **`foreign-continue-refused` needs a real message, not a disabled button.** The user is looking at a rebase IntelliGit can see but must not feed helper input to. Silence there reads as a broken button; the message has to say another tool owns the rebase.
- `UndockedViewProvider` still calls `hasWholeIndexOperationInProgress` directly and never sees `activeOperation` or `rebaseControl` — carried forward from 6a's handoff, still unaddressed, and 6c is the phase where it starts to matter.
- **`CommitPanelViewProvider` now takes 12 positional constructor dependencies.** 6a's fix 3 exists because a test pinned one to `.at(-1)`. 6c adds handlers; converting to an options object first is cheaper than the next positional break.
- A dependency-cruiser rule forbidding any `src/**` import of `editorHelper.ts` is still unwritten. 5a's blocker was that module executing on import; nothing prevents a future import from reintroducing it.
- **Run the `suite` gate with `VITEST_MAX_THREADS=3`.** Uncapped it fails nondeterministically in the shelf and real-git suites regardless of how quiet the machine is, and it is slower. Note that vitest here is **1.6.1**, where `--maxWorkers` and `--poolOptions.*` do not exist as CLI flags — passing them silently yields `no tests` because they are parsed as filename filters. The env var is the working lever.
- **Do not diagnose a red `suite` gate from the gate alone.** `verdict.json` records pass/fail per gate and keeps no output, so a failure has to be reproduced with the suite captured to a file before it means anything. If the failures are in the shelf or real-git suites, run the same suite in a detached worktree at the phase's base before touching a line of code — at base it fails worse.

## Phase 6c — Toolbar rebase controls

BASE_HEAD `a6ced0cc`. SID `019fc1ac-deb0-73f1-b636-9220180dde37`, `gpt-5.6-terra`/`high`. Telemetry `PEAK=243102 LAST=218049 PCT=94% NONRESUMABLE=yes`. Rounds: 1 build, 0 Codex fix rounds, 3 orchestrator fixes. Scope: 40 files touched, 2 added, +469/−14 plus two added test files.

### The self-report was truthful again, and the sizing warning it carried was ignored

Second consecutive phase where the pasted summary lines held. The self-report carried `Test Files 154 passed (154)` / `Tests 2453 passed (2453)`; an independent rerun before touching anything reproduced them exactly — `RC=0`, 154 files, 2453 tests, 165.9s at ambient load 2.71. Both declared deviations were verified true: the provider really does stay an event transport (it scopes and fires; `repositoryViewEvents` assembles dependencies and calls the sealed operations), and the repository really does carry 12 webview catalogs, not the 13 the work order asserted. The `src/git/interactiveRebase/` fence held — not one byte of phase 6a/6b's sealed modules changed — and the 140K-token localization CSV grew by 8 script-written lines rather than being hand-edited.

**`PCT=94%` is the finding of this phase.** The work order was sized against the 45–50% target and landed at 94% — the worst overshoot in this build, past even 5b's and 6b's 93%. Six deliverables spanning the protocol, the toolbar, the controller, the provider, the activation mapping, twelve locale catalogs, and four test files is not one integration seam; it is three. The skill's own sizing rule says predictions drift up and never down, and this is the fourth phase in a row to confirm it. 6d must be split before launch, not after the session bloats.

### Defects found and fixed

1. **The reducer erased the rebase classification on every partial update.** `SET_FILES_AND_STASHES` assigned `activeOperation: action.activeOperation` and `rebaseControl: action.rebaseControl` unconditionally, while every neighbouring field in the same object literal — `currentBranchName`, `currentBranchUpstream`, `hasCommits`, `hasRemotes` — preserves prior state when the action omits it. The protocol makes the omission meaningful: `CommitPanelOperationSnapshot`'s first variant is `activeOperation?: undefined`, the shape an older or partial producer sends. So any refresh that did not recompute the operation — a file watcher, a stash listing — would clobber both fields to `undefined` and the Continue/Abort controls would vanish mid-rebase. The fix spreads the pair conditionally: absent `activeOperation` preserves both, present `activeOperation` replaces both. Preserving them *independently* would be the opposite bug — a finished rebase would strand its ownership behind the new operation and keep Abort Rebase rendered. Both directions are now pinned by tests.
2. **The delegated force-push offer lost its second refresh.** `showInteractiveRebaseControlResult` wraps every outcome in a `refreshOnce` guard and a `finally`, which is right for the eight variants that report and return. `completed-pending-push` is not one of them: it hands the whole result to 5b's existing offer, which refreshes at two points the user can distinguish — the finished rebase, then the landed push — and the once-guard swallowed the second. The panel would sit showing the pre-push branch state after the push had already succeeded. The variant now marks the refresh consumed and passes the unguarded `refresh` to the delegate, which owns its own bookkeeping. The doc comment says so, because the asymmetry is the kind a later reader tidies away.
3. **Four files failed `format:check`.** `types.ts` re-indented existing lines to 11 spaces where the file uses 10. Codex ran `typecheck`, `lint:strict`, `l10n:validate` and the full suite, and reported them — but **never ran `format:check`**, which is a repo pre-commit hook and an accept-stage gate. The work order should name the gate commands rather than trusting the builder to infer the project's full check set.

### Mutation sweep — 5 mutants, 3 killed on arrival, 2 survivors that were exactly the two behavior fixes

The sweep was aimed at the phase's decision points, and it split cleanly along the line between what Codex tested and what it did not:

- **A** (Continue's ownership gate: `rebaseControl !== "foreign"` → `!== "owned"`) — killed.
- **B** (drop the rebase suppression from Abort Merge) — killed.
- **E** (swap the `continueRebase`/`abortRebase` transport types) — killed.
- **C** (revert defect 1 — reducer clobbers the pair) — **SURVIVED**.
- **D** (revert defect 2 — the once-guard swallows the delegate's refresh) — **SURVIVED**.

The two survivors are not a coincidence: both defects shipped in a build whose suite was green, which is the definition of an untested branch. C survived the four test files that touch the reducer; D survived all 136 tests in `rebaseControlResult.test.ts` and `view-providers.integration.test.ts`, because the existing `completed-pending-push` case lets the offer's warning modal return `undefined` — the user dismissed it — so the push never runs and only one refresh is ever observed. The path where the push actually lands was unreached.

Two tests were added and both mutants then died:

- `tests/webview/unit/commit-panel-operation-state.test.tsx` drives the real `useExtensionMessages` hook with `MessageEvent`s, the same harness shape the docked-generation suite uses. One case sends a classified update then an unrelated partial one and asserts the pair survives; the other asserts `activeOperation: "none"` clears `rebaseControl` rather than stranding it.
- `rebaseControlResult.test.ts` gained a case that makes the offer's warning modal return `"Force Push"`, so `forcePush` actually runs and lands, and asserts `refresh` is called **twice**.

Final: **5 mutants, 5 killed.** All four mutated files restored byte-identically, SHA-256 verified against a pre-sweep baseline. `git stash` is never used — the tree carries uncommitted work.

### lean-ctx served stale bytes for a file Codex wrote, and agreed with itself three times

Reading `Toolbar.tsx` through `ctx_read` returned the **pre-Codex** file: no `activeOperation`, no `rebaseControl`, no Continue/Abort buttons — while `git status` listed it as modified. `ctx_search` on the same path reported zero matches for `rebaseControl`. A native `grep` issued as a cross-check was silently rewritten into `ctx_search` by the shadow-mode interceptor and returned the same wrong answer in ctx's own output format. Three agreeing reads, one source, all stale.

`git diff` showed the real file: 29 added lines, exactly the specified render rules. The cache had never seen the write because Codex writes outside this session's tool layer.

**Read Codex-written files through `git diff` / `git show`, not through the context cache.** Agreement between tools that share a cache is not corroboration. Had this gone unchecked the conclusion would have been that 6c's toolbar wiring was missing entirely — and the "fix" would have been to write it a second time.

### The nvm codex install is broken

`PATH`'s first `codex` is nvm's, and its vendor binary directory (`@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/`) is empty — emptied 26 Jul 09:50 — so it fails `ENOENT` at spawn. The bun install at `/Users/maheshkokare/.bun/bin/codex` is intact at `codex-cli 0.144.1` and every round in this phase used it explicitly. Repair with `npm i -g @openai/codex`; until then any launcher that relies on `PATH` resolution will fail.

### Acceptance

6 accept gates GREEN warn=0. Suite **2456/2456**, 155 files — the three added cases are the whole delta from the build's own 2453. `SEAL: INTACT files=40`. Full `.githooks` pre-commit chain green through `vsce package`.

**Shadow-mode datum: not collected, twelfth time.** Three orchestrator fixes and two added test files changed hash-covered files during verification, so the seal again covers bytes the verifier itself wrote. Twelve builds, zero data points. The recommendation from 6b stands and is now overdue: redesign `SEAL_MODE` around a distinct fix stage, or drop it.

## Handoff — resume at Phase 6d

- Branch `feat/interactive-rebase-from-here`; BASE_HEAD for 6d = the tip after this phase's two commits. Tunables unchanged; `SEAL_MODE=shadow`.
- 6d scope: PLAN step 8 reload reconciliation — marker-first, once-per-repository, default-deny evidence matrix, ambiguous-discard notice. **Split it before launching.** Four phases running have overshot their sizing prediction, 6c by the widest margin yet at 94%; the evidence matrix and the notice/dedup path are separable and should be separate work orders.
- **Name the gate commands in the work order.** 6c ran four checks and reported them honestly, but `format:check` was not among them and it is both a pre-commit hook and an accept gate. A builder that is told "the suite" runs the suite; one that is told `format:check`, `lint:strict`, `deps:check:strict`, `architecture:check`, `l10n:validate`, `typecheck` runs those.
- **The operation snapshot moves as a pair, in both directions.** `CommitPanelOperationSnapshot` encodes it in the protocol — `activeOperation` absent means "no classification supplied", `"rebase"` requires `rebaseControl`, everything else forbids it. Any future reducer or provider field that touches one must touch both; the two tests in `commit-panel-operation-state.test.tsx` fail loudly if that is broken from either side.
- **`completed-pending-push` refreshes twice by design.** The variant is delegated whole to 5b's offer and is deliberately exempt from `showInteractiveRebaseControlResult`'s once-guard. It reads like an inconsistency and is not; the comment on the case says why, and a test pins the count at two.
- `UndockedViewProvider` still calls `hasWholeIndexOperationInProgress` directly and never sees `activeOperation` or `rebaseControl`. Carried forward from 6a and 6b, now two phases past the point where it started to matter: the undocked panel cannot render rebase controls at all.
- **`CommitPanelViewProvider` now takes 12 positional constructor dependencies** and gained an event emitter this phase. Still unconverted to an options object; still one positional insert away from breaking the test that pins `.at(-1)`.
- A dependency-cruiser rule forbidding any `src/**` import of `editorHelper.ts` is still unwritten.
- **Run the `suite` gate with `VITEST_MAX_THREADS=3`** (and `VITEST_MIN_THREADS=1`, which this vitest requires alongside it). Uncapped it fails nondeterministically regardless of ambient load, and it is slower. vitest here is **1.6.1** — `--maxWorkers` and `--poolOptions.*` are not CLI flags and are silently parsed as filename filters, yielding `no tests`.
- **Do not read Codex-written files through the context cache.** Use `git diff` / `git show`. Native `Read`/`Grep` may be transparently rewritten to the cached tools, so a cross-check in a different tool is not necessarily a different source.

## Phase 6d-1 — reload reconciliation engine (PLAN step 8, first half)

BASE_HEAD `9f472aa0`. SID `019fc1dd-c39f-7872-8641-fefc374849ba`, `gpt-5.6-terra`/`xhigh`. Telemetry `PEAK=205396 LAST=205396 PCT=79% NONRESUMABLE=no`. Rounds: 1 build, 0 Codex fix rounds, 2 orchestrator fixes. Scope: 6 files, 2 added, +267/−16 across the four tracked files plus 683 lines of new `reconcile.ts` and its suite.

### Splitting the phase cut 15 points off the peak and still missed the target

6d was split at the `vscode` import boundary — 6d-1 is the pure engine and its storage primitives, 6d-2 is activation wiring, the notice, and l10n — specifically so `architecture:check` (dependency-cruiser) enforces the seam rather than a convention. The split is the first thing in five phases to move the number: `PCT=79%` against 6c's 94%. It is still 29 points over the skill's 45–50% target, and the reason is visible in the deliverables — enumeration and discard primitives in `storage.ts` are one seam, the evidence reader plus classifier are another. A third split was available and was not taken.

`xhigh` was the right call. The spec is a five-row default-deny matrix over partial, stale, and mutually contradictory on-disk state, which is exactly the "subtle state" case the skill reserves the rung for, and the classifier came back with the one ordering subtlety that matters already correct: `completed-pending-push` is classified from HEAD and branch **before** the rebase-directory check, so a terminal pending-push manifest can never contest the live directory with a running session. Get that order wrong and a finished-but-unpushed rebase reports `rebase-directory-present` and blocks its own push offer.

The self-report was truthful for the third consecutive phase — all seven deliverables verified against the diff, and the declared deviation was an honest one nobody would have caught: it over-read `PLAN.md` lines 46–81 while retrieving its allowed block and reported not using the content. Naming the seven gate commands explicitly in the work order (6c's handoff item) worked: `format:check` ran this time, and the format gate was green on arrival.

### Defects found and fixed

1. **`discardRebaseSession` threw on exactly the entries `listRebaseManifests` surfaces.** It built its paths through `paths.manifestPath(sessionId)` and `paths.sessionDirectory(sessionId)`, both of which run `validateSessionId` and **throw** on anything failing `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`. But the listing enumerates every `*.json` file by name and returns unsafe names as `ambiguous`/`invalid-schema` (`storage.ts:195`) — so the discard action 6d-2 offers for a listed entry would throw on precisely the corrupt entries the notice exists to clear. The notice would return on every reload with no user action able to remove it. Replaced with a `confineToDirectory` helper: resolve the name against the parent and require `path.dirname(resolved) === parent`. Traversal is still refused, but every name the listing can produce is now deletable. Two regression tests pin both halves — a stray name this module's own writer could never emit is listed *and* discarded, and `"../../unrelated"` deletes nothing outside the namespace.
2. **`selectedLiveSessionId` was written into the evidence snapshot and never read.** Dead on its own, but worse than dead on this type: `RebaseReconciliationEvidence` is the public input to a pure default-deny classifier, and a precomputed ownership hint sitting in it invites a future caller to supply a selection the evidence contradicts. Removed from the interface and the gatherer's return; the doc comment now states that the marker-first selection is deliberately absent because the classifier derives it from the snapshot alone.

### Mutation sweep — 5 mutants, 3 killed on arrival, 2 survivors on the ownership boundary

- **A** (drop the three-field metadata downgrade so a bare marker match grants `owned`) — killed.
- **C** (classify `completed-pending-push` *after* the rebase-directory check instead of before) — killed.
- **D** (drop the branch guard from the discard path, letting HEAD equality alone authorize deletion) — killed.
- **B** (trust the manifest's embedded `sessionId` over the filename it was read from) — **SURVIVED**.
- **E** (`hasLiveManifest: false` — a foreign rebase beside a live manifest reports as `unowned`) — **SURVIVED**.

**B** is unreachable through the production path today: `readRebaseManifest` rejects a filename/identifier mismatch as `invalid-schema` (`storage.ts:206`) before it can ever be `valid`. It is still a real hole, because `reconcileRebaseSessions` is exported, its input type permits the pair, and the failure mode is that a `discard` disposition is keyed on `manifest.sessionId` while the entry was read from a *different* filename — the host would delete a file it never examined. The guard exists twice, in `selectLiveManifests` and in `classifyValidManifest`, and neither copy had a test. A pure exported function is tested at its own boundary, not at the boundary of the one caller that currently happens to pre-filter for it.

**E** is fully reachable. `hasLiveManifest` is the only thing separating `foreign` from `unowned` for an apply-layout rebase, or a merge rebase whose marker matches nothing. `unowned` means "Git controls are safe, nothing of ours is at stake"; reporting it while a live manifest is retained is precisely the confusion the three-state union exists to prevent.

Two tests were added and both mutants died:

- *"never acts on a manifest that answers to a different name than its file"* — asserts the disposition is `ambiguous` keyed on the **filename**, not a `discard` keyed on the embedded name, and that a rebase marker matching the embedded name still yields `unowned` rather than `owned`.
- *"reports … as foreign while a live manifest is still retained"*, an `it.each` over the apply layout and a foreign merge rebase — each case also asserts that the same directory evidence with no manifests is `unowned`, pinning both sides of the distinction instead of one.

Final: **5 mutants, 5 killed.** `reconcile.ts` restored byte-identically after every round, SHA-256 `0e1aea42…` verified. `git stash` is never used — the tree carries uncommitted work.

### Detached HEAD is state, not an error

`gitText.ts` gained an additive `expectedExitCodes` passthrough (default `{}`, and typed so it cannot override `maxOutputBytes`). `readCurrentBranch` uses it to run `git symbolic-ref --quiet HEAD` with `[0, 1]`, so Git's normal exit-1-on-detached becomes `{ status: "detached" }` rather than a thrown error indistinguishable from a broken repository. The branch evidence union therefore carries three states — `attached`, `detached`, `unavailable` — and `isCurrentManifestBranch` requires `attached` with a matching ref, which is what makes the same-tip branch switch default-deny instead of a silent discard.

### Acceptance

6 accept gates GREEN warn=0 — `lint` 9.7s, `typecheck` 3.6s, `format` 2.4s, `knip` 1.0s, `architecture` 1.0s, `suite` 286.7s. Counting run: **2473/2473** across 156 files, 160.15s. The delta from the build's own 2468 is exactly the five added cases — two in `storage.test.ts`, three in `reconcile.test.ts`, one of which is an `it.each` with two rows. No new test file: both fixes belong beside the behavior they pin. `SEAL: INTACT files=6 warns_open=0`.

The `architecture` gate is doing real work this phase rather than passing by default: it is what holds the 6d split at the `vscode` import boundary, and it would go red the moment the engine reached for the extension host.

**No l10n in this phase, by construction.** 6d-1 adds no user-facing string — the notice and its action are 6d-2's, and so is the full CSV round-trip they require.

**Shadow-mode datum: not collected, thirteenth time.** Two orchestrator fixes and four added tests changed hash-covered files during verification, so the seal once again covers bytes the verifier itself wrote. Thirteen builds, zero data points. The recommendation stands and is now two phases overdue: redesign `SEAL_MODE` around a distinct fix stage, or drop it.

## Handoff — resume at Phase 6d-2

- Branch `feat/interactive-rebase-from-here`; BASE_HEAD for 6d-2 = the tip after this phase's two commits. Tunables unchanged; `SEAL_MODE=shadow`.
- 6d-2 scope: run reconciliation once per repository at activation, surface the ambiguous dispositions as a notice with a "Discard rebase session state" action, and ship the l10n for it **in the same phase** — the accept suite goes red otherwise.
- **`listRebaseManifests` throws on any non-ENOENT `readdir` failure** (`storage.ts:230`). That is deliberate fail-closed — a permissions or I/O error must not be silently reported as "no retained sessions". The host has to catch it at the activation boundary; an unhandled rejection during activation is worse than a missing notice.
- **`discardRebaseSession` is idempotent and confinement-checked, not validating.** It resolves to nothing and returns cleanly for a name that would escape the namespace. The notice must not read "no error" as "the file existed and is gone" — if it wants to report what it removed, it has to re-list.
- **Reconciliation never arms a push.** A `completed-pending-push` manifest reconciles to `ambiguous` / `pending-push-retained`, deliberately: the offer was already made on the live path, and re-offering it on every reload would push a branch the user declined to push. 6d-2 must not convert that reason into a prompt.
- **`rebaseControl` from `reconcileRebaseSessions` is the same union the toolbar already renders** (`owned` | `unowned` | `foreign` | `none`), so the activation wiring feeds the existing `CommitPanelOperationSnapshot` pair rather than introducing a parallel state. The pair still moves together in both directions.
- The engine imports nothing from `vscode` and must stay that way — the split exists so `architecture:check` enforces it. Put every `vscode` dependency in the 6d-2 wiring module.
- `UndockedViewProvider` still calls `hasWholeIndexOperationInProgress` directly and never sees `activeOperation` or `rebaseControl`. Three phases past the point where it started to matter: the undocked panel cannot render rebase controls at all, and will not show the 6d-2 notice state either.
- **`CommitPanelViewProvider` still takes 12 positional constructor dependencies.** Unconverted; one positional insert away from breaking the test that pins `.at(-1)`.
- A dependency-cruiser rule forbidding any `src/**` import of `editorHelper.ts` is still unwritten.
- **Run the `suite` gate with `VITEST_MAX_THREADS=3`** and `VITEST_MIN_THREADS=1`. vitest here is **1.6.1** — `--maxWorkers` and `--poolOptions.*` are not CLI flags and are silently parsed as filename filters, yielding `no tests`.
- **Do not read Codex-written files through the context cache.** Use `git diff` / `git show`; native `Read`/`Grep` may be transparently rewritten to the cached tools, so a cross-check in a different tool is not necessarily a different source.


## Phase 6d-2 — reload reconciliation activation surface (PLAN step 8, second half)

BASE_HEAD `4550afb3`. SID `019fc206-3f89-7e33-ae6b-a17948b905d7`, `gpt-5.6-terra`/`high`. Telemetry `PEAK=192542 LAST=192542 PCT=74% NONRESUMABLE=no`. Rounds: 1 build, 0 Codex fix rounds, 1 orchestrator fix. Scope: 16 files, 2 added — a 91-line activation module and its 229-line suite — plus +12 in `repositoryMode.ts` and the two-key l10n round-trip across 12 catalogs and the review CSV.

`high` rather than `xhigh`, deliberately: the engine was frozen in 6d-1 and this phase is wiring over it. The peak came in at 74% against 6d-1's 79% on a package that is a quarter the size, which says the effort rung is not what drives the number — the work order and the files it forces a read of are.

### The defect the whole test suite agreed was fine

`showWarningMessage` was handed `vscode.l10n.t("Discard rebase session state")` and its answer was compared against the **English** constant. The dialog echoes back the exact label it was given — the translated one — so in every non-English locale the comparison fails, nothing is discarded, no refresh fires, and the notice returns on every reload with no user action able to clear it. Deliverable 5's "choosing the action discards every ambiguous session" was dead outside English.

All seven of the build's own tests passed over it, because the suite's `vscode` mock was `l10n: { t: (message) => message }`. An identity translator makes a source string and its translation the same value, which is exactly the condition under which a locale-sensitive comparison bug cannot be observed. The mock is now indirected through `mocks.l10nT`, defaulting to identity but overridable, and the regression test translates to `xx:…` so the two values differ. Fix binds the localized label once and compares against that — the house pattern already at `repositoryViewEvents.ts:580`.

This is the same failure mode as 6d-1's `discardRebaseSession` defect arriving by a different route: a value that is correct on the write side and wrong on the read side, invisible because the test double collapses the distinction the production code depends on.

Two further suspects were investigated and **cleared rather than "fixed"**: `console.error` at the activation boundary matches the established `[IntelliGit]` convention (`repositoryMode.ts:169`), and `void Promise.all(repositories.map(...))` at the call site cannot throw synchronously or reject — `GitExecutor`'s constructor is a bare assignment and the surface catches everything internally.

### Mutation sweep — 5 mutants, 4 killed on arrival, 1 survivor on the async boundary

- **A** (revert the l10n fix — compare the answer against the English source) — killed by the new regression test; it survived against the pre-fix suite, which is the point.
- **B** (sweep before discarding, stranding a just-deleted manifest's reservation pointer) — killed.
- **C** (one notice per ambiguous manifest instead of one per repository) — killed.
- **D** (the discard action clears every retained session, not only the ambiguous ones) — killed.
- **E** (`void` the ambiguous discards, then refresh without waiting for them) — **SURVIVED**.

**E** is the one that mattered. The refresh reads durable state, so overlapping it with its own deletions renders the session being removed — a repaint showing a rebase the user just discarded. Worse, an unawaited `Promise.all` rejects **outside** the enclosing `try`, so a discard failure during activation becomes an unhandled rejection rather than the logged failure the catch exists to produce. Every mock in the suite resolved synchronously, so no ordering was ever observable.

The added test makes the discard genuinely asynchronous (`setTimeout` before it settles) and captures whether it had settled at the moment `refresh` ran. The captured-boolean shape is deliberate: an `expect` thrown inside the `refresh` mock would be swallowed by the surface's own catch and the test would pass regardless — the same trap the fail-closed `listRebaseManifests` contract sets for anything asserting inside this module.

Final: **5 mutants, 5 killed.** `rebaseReconciliation.ts` restored byte-identically after every round, SHA-256 `e01fa89a…` verified. `git stash` is never used — the tree carries uncommitted work.

### Two things folded in rather than deferred

`sweepOrphanedRebaseReservation` was built in phase 2, exported, unit-tested, and **called from nowhere in `src/`** for four phases. It is now wired, with its ordering against the discards pinned by a test rather than by a comment: sweeping first strands the reservation pointer of a manifest that is about to be deleted, because the stale manifest still reads as live to the sweep.

The panel's `rebaseControl` derivation is marker-only while reconciliation's is metadata-checked, and that asymmetry was verified **not** to be a defect before deciding not to unify them: `PLAN.md:41` specifies the three-field sanity check under the *reload* bullet only. The work order told Codex explicitly to leave the live path alone.

### l10n shipped in-phase, and Codex never opened the CSV

Two host strings, 12 catalogs. Codex wrapped both in `vscode.l10n.t()` and was forbidden from touching anything under `l10n/` or the 576 KB review CSV — a host string with no bundle entry keeps every localization check green, so the build stayed green while the orchestrator owned the round-trip. `l10n:sync` added the two rows, a guarded script filled 22 cells, `l10n:import` wrote 10037 cells across 11 files, `l10n:validate` passed, `l10n:audit` reported 9 candidates, all pre-existing.

The fill script earns its guards. It refuses if either target row already carries a translation, refuses unless exactly two rows change, and — the one that actually fired — parses each physical line as CSV and passes through anything that is not exactly 20 fields. Cells in this file carry embedded newlines, so a physical line is not reliably a whole record; the naive version raised `IndexError` on the first multi-line row. Translations were matched per-locale against the rebase terminology already in each catalog rather than produced fresh.

### Acceptance

6 accept gates GREEN warn=0 — `lint` 9.1s, `typecheck` 3.6s, `format` 2.3s, `knip` 0.9s, `architecture` 0.9s, `suite` 280.7s. Counting run: **2482/2482** across 157 files, 161.75s. The delta from the build's own 2480 is exactly the two added cases. `SEAL: INTACT files=16 warns_open=0`.

`architecture:check` is again load-bearing rather than incidental: it is what holds `reconcile.ts` free of `vscode` now that a sibling module imports both it and the extension host.

**Shadow-mode datum: not collected, fourteenth time.** One orchestrator fix and two added tests changed hash-covered files during verification, so the seal covers bytes the verifier itself wrote. Fourteen builds, zero data points. Redesign `SEAL_MODE` around a distinct fix stage or drop it.

## Handoff — resume at Phase 7

- Branch `feat/interactive-rebase-from-here`; BASE_HEAD for phase 7 = the tip after this phase's two commits. Tunables unchanged; `SEAL_MODE=shadow`.
- Phase 7 scope: PLAN step 9 (operation fence during an active rebase, over the enumerated entry points) + step 10 (menu enablement). Step 9 is the larger half — size it against 6d-1's 79%, not 6d-2's 74%.
- **The fence's job is to refuse, not to hide.** Menu enablement (step 10) is presentation; the fence has to hold for a command invoked from the palette, a keybinding, or a webview message that never consulted the menu.
- **`reconcileRebaseSessionsOnActivation` swallows every failure by design.** It logs and returns. Anything in phase 7 that wants to know whether reconciliation actually ran cannot infer it from the absence of a rejection.
- **A locale-sensitive comparison is invisible to an identity `t()` mock.** Two phases running, the same class of bug shipped green. Any new dialog whose answer is compared against a label needs the `mocks.l10nT` treatment — `tests/unit/activation/rebaseReconciliation.test.ts:13` documents why.
- **Reconciliation still never arms a push**, and phase 7 must not change that. `pending-push-retained` is an `ambiguous` reason, not a prompt.
- `UndockedViewProvider` still calls `hasWholeIndexOperationInProgress` directly and never sees `activeOperation` or `rebaseControl`. Four phases past the point where it started to matter: the undocked panel cannot render rebase controls, and does not show the reconciliation notice state either. If step 9's fence is derived from panel state rather than from repository state, the undocked panel will not be fenced.
- **`CommitPanelViewProvider` still takes 12 positional constructor dependencies.** Unconverted; one positional insert away from breaking the test that pins `.at(-1)`.
- A dependency-cruiser rule forbidding any `src/**` import of `editorHelper.ts` is still unwritten.
- **Run the `suite` gate with `VITEST_MAX_THREADS=3`** and `VITEST_MIN_THREADS=1`. vitest here is **1.6.1** — `--maxWorkers` and `--poolOptions.*` are not CLI flags and are silently parsed as filename filters, yielding `no tests`.
- **Do not read Codex-written files through the context cache.** Use `git diff` / `git show`; native `Read`/`Grep` may be transparently rewritten to the cached tools, so a cross-check in a different tool is not necessarily a different source.

## Phase 7a — operation fence, commit-action half (PLAN step 9, first bullet)

BASE_HEAD `c5d15cf5`. SID `019fc228-9d54-7e72-a198-aae819d01cf6`, `gpt-5.6-terra`/`high`. Telemetry `PEAK=239986 LAST=36875 PCT=92% NONRESUMABLE=yes`. Rounds: 1 build, 0 Codex fix rounds, 2 orchestrator fixes. Scope: 18 files, 3 added — a 76-line fence module and two suites — plus **five changed lines** across the two tracked source files and the five-key l10n round-trip.

### Step 10 was already shipped, and the plan did not know it

`PLAN.md:50` asks for `interactiveRebaseFromHere` to stop being disabled for pushed commits. `commitMenu.tsx:94` already reads `disabled: isMergeCommit` with no `isPushed`, and `tests/webview/unit/webview-utils.test.ts:300` — *"enables interactive rebase for pushed non-merge commits only"* — already pins both halves of it. It landed during the dialog phase as a side effect of building the menu entry. Phase 7 is therefore step 9 alone. The work order told Codex explicitly that re-doing it would be a deviation, which is the only reason a frozen spec item that is already true does not get re-implemented.

### 92% on a phase that changed five lines

This is the number that matters from this phase, and it breaks the model the previous four were sized under. 7a was scoped deliberately small: one 152-line dispatcher, a new module, two new suites. It peaked **higher than 6d-1's whole reconciliation engine** and compacted mid-session (`LAST=36875` against `PEAK=239986`).

The cause is `tests/integration/extension/extension.integration.test.ts` — **3837 lines** that Codex had to read to place a two-line mock addition. Peak tracks what a phase must *read*, not what it writes, and the work order sized it by deliverables. Deliverable count, file count, and diff size are all uninformative here; the only predictive quantity is the size of the files the change forces open. Phase 7b's target is a 1096-line file with no unit-test suite, so this is not a one-off.

### Defects found and fixed

1. **A fail-open exit from a function whose doc comment says fail-closed.** `rejectCommitActionWhenOperationInProgress` switched over the operation kind with a case per member and no `default`. TypeScript accepts this — the switch is exhaustive over `ActiveOperationKind`, so the end of the block is unreachable *as typed* — but at runtime an unrecognized kind falls out of the switch and the function resolves `undefined`. The dispatcher reads that as "not refused" and dispatches, which is a history rewrite landing on top of an active operation: the exact outcome the fence exists to prevent, reached through the one path the fence does not check. Not reachable through `GitOps`, whose `getActiveOperation` returns a closed set of literals. But the parameter is `Pick<GitOps, "getActiveOperation">` — duck-typed, so any adapter or test double satisfies it, and this phase added one. Same reasoning that retired 6d-1's mutant B: a pure exported function is hardened at its own boundary, not at the boundary of the one caller that currently happens to constrain it. Now throws into its own `catch`, which reuses the already-tested refusal path rather than adding a second one.
2. **`FENCED_COMMIT_ACTIONS` was dead in `src/`.** A `ReadonlySet` derived from `COMMIT_ACTION_FENCE_DECISIONS`, exported, and consumed only by tests — while the production guard read the decision map directly. Two exports for one fact, one of them with no `src/` call site: the `sweepOrphanedRebaseReservation` smell recorded against 6d-2 exactly one commit earlier. This one is the work order's fault, not a deviation — deliverable 1 asked for both shapes. Removed; both suites now derive their matrices from the single production map, so a new protocol action lands in whichever matrix its own declared decision puts it in instead of quietly in neither.

Codex's own work was otherwise clean, and two of its choices were better than what the work order asked for: `satisfies Record<CommitAction, boolean>` makes a missing decision a compile error (the work order only said "a bare `Set` does not do this"), and the `l10n.t` mock defaults to a **non-identity** translator across every test rather than only in the one case that was required. The 6d-2 lesson propagated.

### The plan's single message would have lied

`PLAN.md:46` fences on "a rebase (or merge) is in progress" but quotes one string: "A rebase is in progress — continue or abort it first." Told to a user paused mid-cherry-pick, that names the wrong operation and points at the wrong remedy. The fence keys on the existing `getActiveOperation()` — which already encodes the rebase > merge > cherry-pick > revert precedence, so none of it is re-derived — and carries one message per kind, with the rebase string byte-identical to the plan's. This is the faithful reading of a spec that quoted its most common case, not a redesign.

`interactiveRebaseFromHere` is now fenced twice, deliberately. `evaluateInteractiveRebaseGuards` (`guards.ts:38`) is strictly **wider** than this fence: it also probes `git bisect`, which writes no whole-index marker and so is invisible to `getActiveOperation()`. The work order forbade touching it. The fence reaches the user first for the four marker kinds; the guard still owns bisect and the five conditions after it.

### Mutation sweep — 5 mutants, 5 killed

- **A** (revert the fail-closed fallback, restoring the `undefined` exit) — killed **by the test added for it**, confirming the hole was not already covered by the build's own seven cases.
- **B** (quietly unfence `checkoutRevision`) — killed.
- **C** (collapse the merge wording onto the rebase message) — killed.
- **D** (an unreadable probe reports the repository as clear) — killed.
- **E** (fence after the switch, so the handler has already run when it refuses) — killed.

Both files restored byte-identically after every round, SHA-256 verified. `git stash` is never used — the tree carries uncommitted work.

### Acceptance

6 accept gates GREEN warn=0 — `lint` 9.0s, `typecheck` 3.5s, `format` 2.3s, `knip` 0.8s, `architecture` 0.9s, `suite` 280.8s. Counting run: **2519/2519** across 159 files, 159.43s. The delta from the build's own 2518 is exactly the one added case. `SEAL: INTACT files=18 warns_open=0`.

l10n: five host strings across 12 catalogs. Terminology was sampled per-locale from each catalog's existing merge, cherry-pick, and revert strings rather than produced fresh — German keeps "Zusammenführung" for merge and treats Rebase as feminine to match `"Der Branch wurde seit der Rebase verschoben"`, Japanese keeps チェリーピック, zh-cn keeps 变基 against zh-tw's 變基. `l10n:import` applied 10092 cells across 11 files; validate passed; every catalog diff is append-only.

**Shadow-mode datum: not collected, fifteenth time.** Two orchestrator fixes and one added test changed hash-covered files during verification. Fifteen builds, zero data points.

## Handoff — resume at Phase 7b

- Branch `feat/interactive-rebase-from-here`; BASE_HEAD for 7b = the tip after this phase's two commits. Tunables unchanged; `SEAL_MODE=shadow`.
- 7b scope: the branch-command bullet of step 9 (`PLAN.md:48`) — checkout/switch, merge, rebase-onto, update, delete, rename. Step 10 needs nothing; see above.
- **Size 7b by what it forces open, not by its deliverables.** `src/commands/branchCommands.ts` is **1096 lines** and `createBranchCommands` is one 500-line function literal returning 13 entries. Give Codex line ranges per command, not the file. This phase's 92% is the evidence.
- **`src/commands/branchCommands.ts` has no unit-test file.** Its handlers are reachable only through `tests/integration/extension/extension.integration.test.ts` (3837 lines). 7b must create `tests/unit/commands/branchCommands.test.ts` and mock seven `BranchCommandDeps` members; that harness is a larger job than the fence itself and is the real content of the phase.
- **Eight ids, not six.** `PLAN.md:48` names six operations but the registry has eight matching commands: `intelligit.checkout`, `checkoutAndRebase`, `rebaseCurrentOnto`, `mergeIntoCurrent`, `updateBranch`, `renameBranch`, `deleteBranch`, **`deleteBranches`**. The plural multi-select variant is a separate registration — fencing only `deleteBranch` leaves the fence bypassable by selecting two branches. Unfenced: `openWorktree`, `createWorktreeFromBranch`, `worktree.create`, `newBranchFrom`, `pushBranch`.
- **The fence module and all five strings already exist.** 7b adds a branch-command decision map and reuses `rejectCommitActionWhenOperationInProgress`'s message logic; it needs no new l10n. Do not let it fork a second copy of the four kind messages.
- `deps.gitOps` is already on `BranchCommandDeps` (`branchCommands.ts:534`) — no plumbing, same as the commit half.
- **Adding a `getActiveOperation` mock to the integration fixture is now required for any new production consumer.** `extension.integration.test.ts:270` and `:819` carry it; a fail-closed probe against a mock that lacks the method refuses every action and turns the whole integration suite red in a way that reads like a fence bug.
- **Fence rejections at the integration layer are still uncovered.** `PLAN.md:55` puts them in the mocked `emitCommitAction` harness under step 12c, which is phase 8. The nine unit rejection tests satisfy step 9's "each fenced path gets an in-progress rejection test"; the integration layer is a separate obligation and has not been met.
- `UndockedViewProvider` still calls `hasWholeIndexOperationInProgress` directly and never sees `activeOperation` or `rebaseControl`. Five phases past the point where it started to matter.
- **`CommitPanelViewProvider` still takes 12 positional constructor dependencies.** Unconverted; one positional insert away from breaking the test that pins `.at(-1)`.
- A dependency-cruiser rule forbidding any `src/**` import of `editorHelper.ts` is still unwritten.
- **Run the `suite` gate with `VITEST_MAX_THREADS=3`** and `VITEST_MIN_THREADS=1`. vitest here is **1.6.1** — `--maxWorkers` and `--poolOptions.*` are not CLI flags and are silently parsed as filename filters, yielding `no tests`.
- **Do not read Codex-written files through the context cache.** Confirmed again this phase: a `grep` for keys that `git diff` had just shown in `l10n/bundle.l10n.json` returned zero matches through the cached path. Use `git show` / `git diff`.
