# Plan Review Log: Unified diff view — one renderer, editable and read-only modes
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5. Reviewer: gpt-5.6-sol/xhigh.
SID: 01a02118-aabf-7553-8604-0423b55c2fba

Grill decisions locked with the user:
1. Work + plan artifacts live in a fresh worktree off main (`.claude/worktrees/unified-diff-view`).
2. Read-only chrome: view toggles kept (ignore-whitespace, word-highlight); all per-hunk action icons removed.
3. Changed-files diff sides: HEAD ↔ working tree, always (no index-aware pairs).
4. Open working-tree diffs refresh on the existing working-tree-changed event.
5. One reusable diff panel; clicking another file swaps content.

## Round 1 — Codex (gpt-5.6-sol, effort xhigh)
Telemetry: PEAK=201651 LAST=201651 PCT=78% NONRESUMABLE=no

1. [CRITICAL] Phase 2 / one reusable panel — Asynchronous loads and unversioned `setDiffData` messages let a slower earlier open or refresh overwrite the singleton panel's newer selection. Fix: Add monotonically increasing generations, discard stale completions, and retain only the latest payload until `ready`.
2. [REQUIRED] Phase 2 steps 3.1-3.3 — The content-only `openUnifiedDiff` input contains no repository-bound reload descriptor, so the panel cannot safely re-fetch HEAD and working-tree sides. Fix: Store an immutable `{repoRoot, path, refs, load}` descriptor and replace it atomically on every open.
3. [REQUIRED] Phase 2 step 3.3 / src/views/RefreshService.ts:188-225 — Actual text and filesystem watchers only schedule provider refreshes, while the existing provider-local working-tree events are payload-free and emitted only by IntelliGit mutation handlers. Fix: Route watcher refreshes through a repository-scoped working-tree event carrying the affected root and bind the panel only to its current descriptor.
4. [REQUIRED] Phase 2 step 3.1 / src/views/panelFileActions.ts:149-156 — A content-only funnel cannot preserve the native fallback's exact `git.openChange` delegation or stash/shelf preview options, and prefetch failures can prevent the fallback from opening. Fix: Select the setting before content acquisition and pass a native command delegate or complete command descriptor.
5. [REQUIRED] Phase 2 step 3.2 — Directly reading `HEAD:path` and the working-tree file has no missing-side contract, so added, untracked, and deleted files fail instead of producing the planned empty side. Fix: Add a shared side loader that converts only confirmed missing-path errors to empty content and propagates every other failure.
6. [REQUIRED] Phase 2 step 3.5 / src/git/operations.ts:1539-1549 — Git blobs are decoded to UTF-8 strings before reaching the proposed funnel, making reliable binary and non-UTF-8 detection impossible. Fix: Introduce byte- and file-mode-aware loading and test binary, invalid-UTF-8, symlink, submodule, and shelf inputs before native fallback.
7. [REQUIRED] Phase 0 step 1.1 / src/webviews/react/merge-editor/mergeScrollLayout.ts:18-107 — Generalizing `MergePane` and `Record` leaves `SegmentPaneLines`, layout construction, refs, and connector measurement hardcoded to left/middle/right. Fix: Define line counts and geometry over an ordered pane map, keep merge-only adapters outside the core, and contract-test both two- and three-pane layouts.
8. [REQUIRED] Phases 0 and 3 / src/webviews/react/merge-editor/merge-editor.css:1-61 — Extracted React blocks still depend on merge-owned classes and CSS variables, while `shared/tokens.ts` is TypeScript and cannot directly supply the second stylesheet. Fix: Extract shared diff-core CSS and semantic CSS variables in Phase 0 and import them from both bundles.
9. [REQUIRED] Goal, Phase 2, and Out of scope / src/views/shelfDiffActions.ts:38-66 — `showShelfDiffFromPanel` also owns a whole-shelf `vscode.changes` path that one single-file panel cannot replace, yet only the analogous stash overview is excluded. Fix: Explicitly retain whole-shelf overview natively and rewire only `changeId` requests, or define the missing multi-file behavior.
10. [REQUIRED] Phase 1 steps 2.1-2.4 / src/mergeEditor/conflictParser.ts:107-114 — The payload has no per-side EOL or trailing-newline representation, so reuse of current line splitting makes `a` and `a\n` visually identical. Fix: Preserve per-side EOL and terminal-newline metadata or emit an explicit terminal-newline difference marker with regression tests.
11. [REQUIRED] Key decision 5 and Risks / src/mergeEditor/lineDiff.ts:207-217 — The claimed huge-file mitigation still permits a synchronous 10-million-cell allocation of roughly 40 MB on the extension host, and `content-visibility` reduces neither computation nor postMessage payload cost. Fix: Establish measured byte, line, and cell budgets and fall back to native before synchronous computation exceeds them.
12. [MINOR] Phase 3 step 4.2 — `css-modules.d.ts` still has live configuration and test references in `knip.jsonc`, `tsconfig.tests.json`, and `tsconfigCoverage.test.ts`, so deleting only the declaration breaks repository checks. Fix: List and remove all four references as one verified cleanup.
VERDICT: REVISE

### Claude's response (Round 1 triage — all 12 FIXED, none rejected)
#1 FIXED — DiffViewerPanel gets a monotonically increasing open/refresh generation; completions carrying a stale generation are discarded; latest descriptor's payload also replayed on `ready`. Test: slow-open A + fast-open B → B renders, A's completion dropped.
#2 FIXED — `openUnifiedDiff` now takes an immutable request descriptor ({repoRoot, path, side specs as refs/worktree}) plus loader; the panel stores the current descriptor and refreshes only through it, replaced atomically per open.
#3 FIXED — refresh binds to the repository-scoped refresh pathway that real text/fs watchers drive (RefreshService), filtered by the descriptor's repoRoot/path; the payload-free provider-local event is not the trigger.
#4 FIXED — the setting branches BEFORE any content acquisition; each call site passes a native delegate closure preserving today's exact native behavior (git.openChange / vscode.diff variants).
#5 FIXED — shared side loader: only confirmed missing-path outcomes (added/untracked/deleted) become an empty side; every other error propagates. Explicit tests for all three states.
#6 FIXED — side loader fetches bytes + file mode before any UTF-8 decode; binary/invalid-UTF-8/symlink/submodule detected there → native fallback; test matrix enumerated in the phase gate.
#7 FIXED — Phase 0 contract rewritten: ordered pane map drives SegmentPaneLines-equivalent, layout construction, refs, and connector measurement; merge-only adapters live outside diff-core; 2-pane and 3-pane contract tests required.
#8 FIXED — Phase 0 now extracts a shared `diff-core.css` (+ semantic CSS variables) imported by both bundles; Phase 3 token unification narrowed accordingly.
#9 FIXED — whole-shelf `vscode.changes` overview explicitly retained native (joins stash overview in Out of scope); only single-change (`changeId`) requests rewire to the viewer.
#10 FIXED — DiffSegment model carries per-side EOL + terminal-newline metadata and renders an explicit newline-difference marker; regression tests for `a` vs `a\n`.
#11 FIXED — measured byte/line/cell budgets gate the custom path per file; over budget → native fallback BEFORE synchronous diff computation; merge perf integration test extended to the viewer.
#12 FIXED — Phase 3 cleanup enumerates all four reference sites (declaration + knip.jsonc + tsconfig.tests.json + tsconfigCoverage.test.ts) as one verified removal.

## Round 2 — Codex (gpt-5.6-sol, effort xhigh)
Telemetry: PEAK=212148 LAST=107103 PCT=82% NONRESUMABLE=no

1. [REQUIRED] Phase 2 steps 3.1-3.2 — `SideSpec.content` is an eager decoded string and the request requires `path`, but shelf/stash obtain these through asynchronous reads (`src/views/shelfDiffActions.ts:82-103`, `src/views/panelFileActions.ts:257-264`), making it impossible to build the request while honoring both branch-before-acquisition and bytes-before-decode. Fix: Represent provider content as a lazy raw-byte source or request factory evaluated only after the setting branch, carrying path and mode metadata.
2. [REQUIRED] Phase 2 step 3.6 — `RefreshService` exposes no subscribable change event, covers only the active repository (`src/views/RefreshService.ts:19-23,188-225,368-391`), and is disposed on repository switches (`src/activation/repositoryMode.ts:572-594`), while `showDiff` can target non-active runtimes (`src/views/CommitPanelViewProvider.ts:409-418,1836-1838`). Fix: Define a root-keyed typed change-event contract over the existing watcher pathways, including expanded runtimes, with atomic subscription rebinding on descriptor and active-service changes.
3. [REQUIRED] Phase 2 steps 3.2 and 3.6 — The worktree loader does not require dirty `vscode.TextDocument` text to override filesystem bytes, so text-document events can trigger refreshes that reload unchanged disk content and regress existing stash/shelf behavior (`src/views/panelFileActions.ts:192-202`, `src/views/shelfDiffActions.ts:124-132`). Fix: Specify open-document-first worktree acquisition and add an unsaved-edit live-refresh regression test.
4. [REQUIRED] Phase 2 steps 3.2 and 3.5-3.6 — If a live file becomes binary, symlinked, submodule-backed, or over budget, refresh requires native fallback but the panel retains only the descriptor, leaving no defined delegate or terminal transition and allowing stale content or repeated native opens. Fix: Store the descriptor and delegate as one generation-bound session and define a one-shot fallback that invalidates, unsubscribes, and clears or closes the custom panel.
5. [REQUIRED] Phase 2 steps 3.2-3.3 — Checking the byte budget only after resolving complete sides still permits an arbitrarily large worktree file or Git blob to be buffered in the extension host before fallback, despite `GitExecutor.runBinary` already supporting bounded output (`src/git/executor.ts:125-165`). Fix: Size-probe or bounded-read every side before allocating its full buffer and delegate immediately when the cap is exceeded.
6. [REQUIRED] Phase 0 step 1.4 — "Byte parity" is undefined and unattainable after relocating modules and splitting CSS imports because generated bundle bytes necessarily change even when behavior and pixels do not. Fix: Replace byte parity with explicit protocol, DOM, interaction, and unchanged-pixel-baseline invariants, naming any artifact that truly must remain byte-identical.
7. [REQUIRED] Phase 2 step 3.3 / Risks — The plan defers threshold selection to "real measurements" without a numbered measurement task, representative corpus, or host-stall, memory, payload, and render targets, while existing performance gates permit three-second parsing and fifteen-second rendering (`tests/unit/merge/merge-parser-performance.test.ts:60-70`, `tests/integration/webviews/merge-editor-performance.integration.test.tsx:101-145`). Fix: Establish quantitative acceptance targets and fixtures before selecting defaults, then gate both fallback boundaries and below-threshold performance against them.
8. [REQUIRED] Phase 2 step 3.1 / Phase 1 step 2.5 — The required `intelligit.diffViewer` fallback has no planned `package.json` configuration schema, default/enum validation, localized descriptions, or configuration test, and the only localization step occurs in the preceding phase. Fix: Add the configuration contribution and localization round-trip to Phase 2 with tests for absent, `intelligit`, and `native` values.
VERDICT: REVISE

### Claude's response (Round 2 triage — all 8 FIXED, none rejected; ledger numbering continues #13-#20)
#13 (R2-1) FIXED — SideSpec provider kind is now a lazy `load()` factory returning raw bytes + mode, evaluated only after the setting branch (plan 3.1).
#14 (R2-2) FIXED — Phase 2 introduces a root-keyed typed working-tree change event over the existing watcher pathways (including non-active/expanded runtimes), with atomic subscription rebinding on descriptor/service changes; RefreshService's non-subscribable, active-only, disposed-on-switch nature is named in the plan (plan 3.6).
#15 (R2-3) FIXED — worktree side resolves from an open (possibly dirty) TextDocument first, else disk bytes; unsaved-edit live-refresh regression test added (plan 3.2, 3.8).
#16 (R2-4) FIXED — generation-bound session {descriptor, delegate, generation}; refresh hitting a fallback condition ends the session one-shot: unsubscribe, invalidate, invoke delegate once, clear/close panel; mid-session binary-transition test added (plan 3.5).
#17 (R2-5) FIXED — every side is size-probed / bounded-read before full buffer allocation; over-cap delegates immediately, leveraging GitExecutor.runBinary's bounded output (plan 3.2).
#18 (R2-6) FIXED — Phase 0 done redefined: unchanged pixel baselines + unchanged protocol/DOM/interaction invariants; byte-identity explicitly not required of any artifact (plan 1.4).
#19 (R2-7) FIXED — numbered measurement task: representative corpus + quantitative targets (host stall, memory, payload, render) chosen before thresholds; both fallback boundary and below-threshold perf gated; existing 3s/15s merge gates named too loose to reuse (plan 3.3).
#20 (R2-8) FIXED — `package.json` configuration contribution (enum, default, localized description) + Phase 2 l10n round-trip + tests for absent/"intelligit"/"native" (plan 3.1, 3.8).

## Round 3 — Codex (gpt-5.6-sol, effort xhigh)
Telemetry: PEAK=212148 LAST=157682 PCT=82% NONRESUMABLE=no

1. [CRITICAL] Phase 2 step 3.5 — A generation check before invoking an asynchronous `nativeDelegate` cannot prevent a slower delegate such as stash diff loading (`src/views/panelFileActions.ts:257-269`) from opening a stale native editor after a newer request wins. Fix: Pass a cancellation/current-generation guard into delegates and require a final check immediately before every editor-opening side effect, with a slow-fallback/fast-open race test.
2. [REQUIRED] Phase 2 step 3.6 — Re-resolving both sides can silently retarget an open stash diff because the message carries only mutable index/path (`src/webviews/protocol/commitPanelMessages.ts:439-447`) and `getStashFileContents` resolves `stash@{index}` on every load (`src/git/operations.ts:1475-1488`). Fix: Freeze provider snapshots per session or resolve them through a stable stash object ID, then refresh only sides explicitly marked mutable.
3. [REQUIRED] Phase 2 steps 3.6 and 3.8 — Non-active repository watchers currently exist only while their rows are expanded and are disposed on collapse (`src/views/CommitPanelViewProvider.ts:749-765,810-815`), so an open diff loses refresh coverage when its source row collapses. Fix: Reference-count root watchers across row expansion and diff-panel subscriptions, and test collapse plus active-root switching while the panel remains open.
4. [REQUIRED] Phase 2 steps 3.1-3.2 — `SideSpec.provider.load()` exposes only a full bytes-plus-mode result, while the current shelf reader likewise returns fully allocated buffers (`src/views/shelfDiffActions.ts:9-14`), so the promised pre-allocation budget cannot be enforced through the declared contract. Fix: Give providers an explicit probe/bounded-load contract returning loaded, missing, or over-budget outcomes before full allocation.
5. [REQUIRED] Phase 2 steps 3.2 and 3.6 — "Every other error propagates" is undefined for detached watcher-driven refreshes, leaving provider deletion, permission failures, or Git errors able to produce unhandled rejections while stale content remains visible despite the existing `loadError` message. Fix: Define a generation-checked refresh-error transition that catches and reports `loadError`, preserves or clears content deliberately, and keeps subscription retry behavior explicit.
6. [MINOR] Phase 2 steps 3.5 and 3.8 — The mid-session fallback transition and its test cover binary changes but omit invalid UTF-8 even though step 3.2 classifies it as the same fallback condition. Fix: Include invalid UTF-8 in the transition contract and parameterize the fallback-transition test across all eligibility failures.
VERDICT: REVISE

### Claude's response (Round 3 triage — all 6 FIXED, none rejected; ledger continues #21-#26)
#21 (R3-1) FIXED — the generation/cancellation guard is passed INTO delegates; a final check is required immediately before every editor-opening side effect; slow-fallback/fast-open race test added (plan 3.5).
#22 (R3-2) FIXED — refresh re-resolves ONLY worktree-marked sides; ref and provider sides are frozen at session creation (stash@{index} re-resolves mutably, so provider loads never re-run) (plan 3.6).
#23 (R3-3) FIXED — root watchers reference-counted across row expansion AND diff-panel subscriptions; collapse and active-root-switch tests with the panel open (plan 3.6, 3.8).
#24 (R3-4) FIXED — provider contract is probe/bounded-load returning loaded {bytes, mode} | missing | over-budget before full allocation; current shelf reader named as needing adaptation (plan 3.1).
#25 (R3-5) FIXED — generation-checked refresh-error transition: report loadError, deliberately keep prior panes visible under an error state, subscription stays armed for the next event; no unhandled rejections (plan 3.6).
#26 (R3-6) FIXED — fallback-transition contract and test parameterized across all eligibility failures: binary / invalid-UTF-8 / symlink / submodule / over-budget (plan 3.5, 3.8).

## Round 4 — Codex (gpt-5.6-sol, effort xhigh)
Telemetry: PEAK=212148 LAST=187449 PCT=82% NONRESUMABLE=no

1. [CRITICAL] Phase 2 step 3.5 — The fallback sequence invokes an asynchronous delegate before clearing/closing the reusable panel, so session B can open while session A waits and A's later cleanup can still destroy B even when the delegate guard suppresses A's editor side effect. Fix: Detach or clear A before awaiting its delegate, or make cleanup a compare-and-swap against A's generation, and assert B remains open in the race test.
2. [REQUIRED] Phase 2 step 3.6 — Freezing every `ref` side also freezes symbolic `HEAD` and branch refs, so Git-state events already watched at `src/views/RefreshService.ts:244-295` refresh only the worktree while the pane labeled `HEAD` shows the previous commit. Fix: Distinguish immutable object-ID refs from mutable symbolic refs and re-resolve the latter on relevant Git events, with HEAD-move and branch-move tests.
3. [REQUIRED] Phase 2 steps 3.5-3.6 — Freezing provider content does not stabilize the stored native delegate, so after stash renumbering a later fallback still calls the index-based path (`src/views/panelFileActions.ts:253-269`) and can open a different stash than the frozen custom pane. Fix: Persist a stable provider identity or resolved snapshot for fallback delegates and test stash renumbering followed by an eligibility fallback.
4. [REQUIRED] Phase 1 step 2.4 / Phase 2 steps 3.5-3.6 — Host-side `setIgnoreMode` recomputation needs the original frozen texts, but the declared session stores only `{descriptor, nativeDelegate, generation}`, forcing either provider reloads that violate freezing or loss of toggle functionality. Fix: Store resolved immutable side snapshots in the session and recompute from them, with a toggle-after-provider-mutation test.
VERDICT: REVISE

### Claude's response (Round 4 triage — all 4 FIXED, none rejected; ledger continues #27-#30)
#27 (R4-1) FIXED — fallback order: the panel's session binding is detached/cleared FIRST; cleanup is a compare-and-swap against the session's generation and never touches a panel a newer session owns; race test asserts B remains open through A's late cleanup (plan 3.5).
#28 (R4-2) FIXED — object-ID refs frozen; symbolic refs (HEAD, branch names) marked mutable and re-resolved on the Git-state events the watcher pathway already covers; HEAD-move and branch-move tests (plan 3.6).
#29 (R4-3) FIXED — the session's delegate binds a stable provider identity resolved at creation (stash commit OID, not stash@{index}); stash-renumbering-then-fallback test (plan 3.5).
#30 (R4-4) FIXED — the session stores resolved immutable side snapshots (texts + metadata); setIgnoreMode recomputes from them, never reloading providers; toggle-after-provider-mutation test (plan 3.5).

## Round 5 — Codex (gpt-5.6-sol, effort xhigh) — FINAL ROUND
Telemetry: PEAK=212148 LAST=40208 PCT=82% NONRESUMABLE=yes (compaction detected — session retired after this round)

1. [REQUIRED] Phase 2 step 3.5 — The fallback sequence invalidates the session generation before invoking a delegate whose final side-effect guard uses that generation/cancellation state, so fallback is either always suppressed or loses protection against newer opens. Fix: Give the delegate a separate token that survives custom-session invalidation and is cancelled only by a newer open or disposal.
2. [REQUIRED] Phase 2 steps 3.5-3.6 and 3.8 — `loadError` is not stored in the session while `ready` replays only the latest payload, and no successful-refresh transition explicitly clears it, so reload can silently hide staleness or recovery can leave an obsolete error over fresh panes. Fix: Persist and replay the active error, clear it atomically on successful refresh, and test error-to-ready and error-to-success transitions.
VERDICT: REVISE

### Claude's response (Round 5 triage — both FIXED; ledger #31-#32)
#31 (R5-1) FIXED — delegates get a dedicated cancellation token, cancelled only by a newer open or panel disposal, NOT by the custom-session invalidation that precedes the delegate call (plan 3.5).
#32 (R5-2) FIXED — the active loadError is session state: `ready` replays it with the latest payload; a successful refresh clears it atomically; error→ready and error→success transition tests (plan 3.6, 3.8).

## Resolution — arbitrated close at MAX_ROUNDS
MAX_ROUNDS=5 reached with VERDICT: REVISE on two REQUIRED findings. No disagreement remained: Claude accepted and incorporated both (as with all 32 findings across 5 rounds — zero REJECTED, zero ACCEPTED-RISK). The human broke the tie mid-session with an explicit instruction to proceed to implementation: "start the implementation using /claudex-build and use luna xhigh and if you think luna is not working correctly then use sonnet 5 but keep the rest of the workflow intact." Closing the review as arbitrated-approved with findings #31-#32 fixed; handing to claudex-build (BUILD: gpt-5.6-luna @ xhigh; contingency: Sonnet 5 builder if luna malfunctions).

---

## Act 3 — Build

Kickoff 2026-08-20. User pre-authorization (mid-session, verbatim): "when done then start the implementation using /claudex-build and use luna xhigh and if you think luna is not working correctly then use sonnet 5 but keep the rest of the workflow intact."

Builder: gpt-5.6-luna @ xhigh (fix ladder xhigh → xhigh → Claude takeover; `max` only on explicit per-round user instruction). Contingency (user-authorized): if luna malfunctions loudly (no `thread.started`, model-resolution or auth error, persisting after one environment fix), the lane HALTs with evidence and the conductor re-spawns the phase with a Sonnet 5 builder lane — rest of the workflow intact.

Tunables: SPEC_FILE=PLAN.md, LOG_FILE=PLAN-REVIEW-LOG.md, SANDBOX=danger-full-access, MAX_FIX_ROUNDS=2, SEAL_MODE=shadow, GATES_FILE=.claudex-gates.json (created at kickoff; gitignored — orchestration state, untracked by design).

Kickoff HEAD (plan checkpoint): 13397039500027013a88db7c8f4764b34414bf07. Per-phase BASE_HEAD is recaptured at each lane spawn.

SKILL-SHA 9961facee66f SKILL.md / ca2ed5fd0f9e helpers.py / db9282d4db13 verify.py

Gate manifest: round stage = typecheck, lint-strict; accept stage adds format-check, architecture (depcruise), deps-knip, tests (full vitest unit+webview), visual-container (Playwright pixel baselines in Docker — the Phase 0 tripwire; baselines are container-recorded, so local `test:visual` would false-fail). The e2e flows suite is deliberately NOT a manifest gate (known flaky on main); Phase 2's new e2e smoke runs as a focused verifier check instead.

Mode: phase-lane (thin conductor + one fresh opus lane per phase; lanes strictly sequential).

### Phase table

| Phase | Spec slice                                                                                    | Status  |
| ----- | --------------------------------------------------------------------------------------------- | ------- |
| P0    | Phase 0 (1.1–1.4): diff-core extraction, pane generalization, shared CSS, contract tests       | accepted |
| P1    | Phase 1 (2.1–2.6): computeDiffSegments, DiffViewerApp, bundle, panel, protocol, l10n, tests    | pending |
| P2a   | Phase 2 (3.1–3.3): openUnifiedDiff funnel + setting, side loader, budget measurement           | pending |
| P2b   | Phase 2 (3.5–3.6): generation-bound sessions, fallback CAS, watchers, live refresh             | pending |
| P2c   | Phase 2 (3.4, 3.7, 3.8): call-site rewires, ride-along integration, full gate battery          | pending |
| P3    | Phase 3 (4.1–4.4): straggler sweep, css-modules.d.ts removal, docs                             | pending |

Sizing note: spec Phase 2 split into three lanes (machinery → concurrency/refresh → wiring+gate) to hold each Codex session near the 45–50% peak target. P0 predicted ~55% — above target but kept whole: splitting a move+generalize refactor mid-seam leaves a broken intermediate tree; the continuation path absorbs overflow.

Hash policy: commit hashes are never written to a tracked file. BASE_HEAD and HEAD are restated to the conductor in the lane return; the log records the HEAD gate's outcome, not its operands.

Environment correction (P0 lane, logged per protocol): the skill's WRITER MODE clause cites `~/.agents/skills/codex-subagent-driven-development/SKILL.md`, which does not exist on this machine. The delegated-writer contract actually lives at `~/.agents/skills/subagent-prechallenged-tdd-workflow/SKILL.md` § "Delegated writer mode". Every P0 work order cites the real path AND inlines the same rules, so a missing file cannot silently drop the contract.

### P0 — Round 1 — Codex build (gpt-5.6-luna/xhigh)

SID: 01a02149-e318-71e2-84f2-1cda094c422f
Telemetry: PEAK=244854 LAST=131318 PCT=94% NONRESUMABLE=yes
Round gates: GREEN warn=0 — typecheck 6.1s, lint-strict 12.9s.
HEAD gate: HEAD equals the phase BASE_HEAD captured at lane spawn, unchanged before and after the round. Codex moved no ref and left every change uncommitted. Root-verified.

Sizing overshoot: P0 was predicted at ~55% and ran at 94% (PEAK=244854). The whole-phase decision recorded above held — the tree is coherent and the round needed no continuation — but the prediction was wrong by ~40 points, and a comparable move+generalize phase should be sized well above a line-count estimate.

Codex reported all ten deliverables DONE with one declared deviation: "`MergePane = PaneId` and legacy segment-field compatibility remain as non-hardcoded bridges so existing layout-test assertions and imports remain unchanged." SUBAGENTS_SPAWNED: 0.

Working tree after the round: 11 tracked files changed (+93 / −1227) — four merge-editor modules deleted and `merge-editor/mergeScrollLayout.ts` reduced to a 24-line merge-only adapter — plus a new untracked `src/webviews/react/diff-core/` (8 files, 1180 lines) and `tests/unit/merge/diffCoreLayout.test.ts`.

#### Verifier report — fresh read-only opus lane, Gate 5

VERDICT: ACCEPT, with 5 MINOR and 2 TRIVIA findings.

A. Pane generalization is REAL, not cosmetic. `buildVerticalLayout` drives every array through `paneIds.map`/`forEach`/`Object.fromEntries`; `paneOffsetsForCanonical`, `applyPaneOffsets`, `syncHorizontalScroll`, and `updateSharedScrollbar` all take an ordered pane-id array; ribbon geometry operates on an adjacent pane pair rather than a fixed triple. A caller passing `["ours","result"]` gets correct geometry.

B. The 2-pane contract test is REAL, mutation-proven three ways, each RED naming the 2-pane test by name: (M1) `Math.max(...heights, 0)` → `heights[0] ?? 0`; (M2) `heights[index]` → reversed index; (M3) `RIBBON_CTRL_PROXIMITY_X` 0.3 → 0.5. Restoration proven byte-exact — sha256 identical before and after — via a scratchpad copy plus `trap`, because the file is untracked and `git checkout --` cannot restore it.

C. Zero behavior change is REAL. Rendered DOM and class strings are character-identical against `git show HEAD:`; 26 CSS rules moved with 0 computed-value changes (only `--merge-*` → `--diff-*` aliasing, plus two declarations that merely gained a fallback); the `@import` reaches the single `dist/webview-mergeeditor.css` (31,092 B, 11 diff-core markers) and `dist/*.css` still emits exactly 5 files, with no stray `diff-core.css`. All 32 pixel baselines untouched (`git status --porcelain tests/visual/` empty). `verdict.json` `"warns": []` confirmed by reading the file.

Focused checks the verifier ran (not manifest gates): `bun vitest run tests/unit/merge/ tests/webview/unit/type-scale.test.ts` → exit 0, 11 files / 184 tests, 901 ms. `bun vitest run tests/integration/webviews/merge-webviews.integration.test.tsx tests/integration/webviews/merge-editor-performance.integration.test.tsx tests/webview/unit/merge-editor-session-kind.test.tsx` → exit 0, 3 files / 32 tests, 7.79 s.

Findings: MINOR-1 hardcoded `["left","middle","right"]` inside diff-core's `inferPaneIds`. MINOR-2 `readonly [key: string]: unknown` index signature on `SegmentPaneLines` defeats excess-property checking. MINOR-3 all `--diff-*` variables declared under `.merge-editor` only, and `.code-lines` still reads `--merge-line-min-width` — "blocks the Phase 1 viewer". MINOR-4 `.word-diff-whitespace` in diff-core.css is dead, outranked by merge-editor.css's higher-specificity `.word-diff-change.word-diff-whitespace`. MINOR-5 both ribbon assertions in the new contract test assert the byte-identical substring, leaving the return leg unconstrained. TRIVIA-1 stale comment pointing at merge-editor.css. TRIVIA-2 `LineNumbers`'s `secondary` prop is never rendered.

#### Claude's verdict (root)

I accept the verifier's deliverable reasoning and its ACCEPT on substance, and I disagree with its severity on three items. Root disposition, item by item:

- MINOR-1 + MINOR-2 → DEFECT, fix. One root cause, and it is mine: the round-1 work order froze `tests/unit/merge/mergeScrollLayout.test.ts` to "import paths only", so the only way to keep that test compiling was a legacy-shape bridge — a merge-pane triple and an open index signature inside code whose stated purpose (spec 1.1) is that nothing stays "hardcoded to left/middle/right". The spec requires those tests to PASS, not to keep their call shape, so the fix round relaxes my constraint: `paneIds` becomes required, `inferPaneIds` and the legacy field fallback and the index signature are deleted, and the frozen test adopts `paneLines` with explicit ids while every expected geometry value stays identical.
- MINOR-3 → DEFECT, fix. Partial under-delivery of spec 1.3, which requires the shared stylesheet to be imported by "both the merge bundle and (later) the viewer bundle". A viewer root that is not `.merge-editor` receives every rule with every variable unresolved. Pixel-safe fix: widen the variable block's selector to a list so the `.merge-editor` branch computes exactly as today, and alias `--merge-line-min-width` behind `--diff-line-min-width`.
- MINOR-4 → fix by consolidation, not deletion. Deleting the dead diff-core rule alone leaves the duplicate; deleting the merge rule instead would change the fallback from `--vscode-editor-foreground`/`#ccc` to `--diff-editor-fg` and put pixels at risk. The winning rule moves verbatim into diff-core and the weaker duplicate goes.
- MINOR-5 → DEFECT, fix. This weakens the one contract test spec 1.4 exists to establish: two cases with different `aBot` asserting one identical substring cannot discriminate 2-pane from 3-pane, and the return leg is untested. Assertions become full-path `toBe` with a mutation check on the return leg.
- TRIVIA-1 → folded into the same fix round (one comment line).
- TRIVIA-2 → NOT a defect. The unrendered `secondary` path is pre-existing at HEAD and was carried forward faithfully; changing it in a zero-behavior-change phase would be the defect. Adjudicated, no action.

All five are design- or test-contract-touching, so they route to a Codex fix round rather than a root fixup. `helpers.py route fix 1` → `EFFORT=xhigh MODE=fresh`.

### P0 — Fix round 1 — Codex (gpt-5.6-luna/xhigh)

SID: 01a02178-70f2-7b33-9463-2366538c4fee (fresh session; round 1's SID 01a02149-e318-71e2-84f2-1cda094c422f was not resumed)
Telemetry: PEAK=184730 LAST=184730 PCT=71% NONRESUMABLE=no
Round gates: GREEN warn=0 — typecheck 6.1s, lint-strict 12.8s.
HEAD gate: HEAD still equals the phase BASE_HEAD, before and after. No ref moved; everything uncommitted. Root-verified.

Telemetry note: this round's `--json` event stream carried no `token_count` events, so `helpers.py telemetry` over the stream returned `PEAK=0`. The numbers above are from the session rollout under `~/.codex/sessions/`, which does carry them (42 `token_count` records). The known cosmetic `codex_models_manager … missing field base_instructions` stderr appeared again and is not a malfunction — the run exited RC=0.

Codex reported all five items FIXED, with its own defect-4 mutation (`bBot`→`bTop` in `ribbonPathD`) going RED on both contract tests and SHA-256-proven restoration. SUBAGENTS_SPAWNED: 0.

Root spot-read confirmed, independently of both Codex and the verifier: `inferPaneIds`, the legacy `segment[pane]` fallback, the index signature, and the `MergePane`/`MergeVerticalLayout` aliases are gone repo-wide; `paneIds` is required with no default; the frozen test kept every expected value byte-identical while changing only fixture shape and call spelling; the variable block became `.merge-editor, .diff-core` with `--diff-line-min-width` added; the two ribbon expectations are now different full-path strings.

#### Verifier re-check — same opus lane resumed, scoped to the fix delta

VERDICT: REJECT. Items 1, 2, 3a, 3b, 4 fully fixed and proven; item 3c (MINOR-4) introduced a CRITICAL pixel regression.

Proven fixed: frozen values identical (61 `expect(` lines at HEAD, 61 now; `comm` empty in BOTH directions over the sorted expect-line sets; 32 `it`/`describe` titles diff-identical; zero removed `expect(` lines). API tightening BITES — a throwaway `tsc --noEmit --strict` probe carrying five expect-an-error directives (spelled out here rather than quoted verbatim, so this log does not itself trip the type-silencing scan) compiled at exit 0, which is only possible if every one of them was satisfied, since an unsatisfied directive fails as an unused directive. Those five include the `panelines:` typo that MINOR-2 named. Selector-list and `--diff-line-min-width` equivalence re-derived from the JSX (one `<div style={rootStyle} className={["merge-editor", …]}>`, same element) and the built CSS. Contract test mutation-proven three ways with sha256-exact restoration: M-A return-leg `bBot`→`bTop` RED 2/2; M-B return-leg `aBot`→`aTop` RED 2/2 — the leg the old `toContain` could not see, so MINOR-5 is genuinely closed; M-C `ribbonOutlineD` stroke inset `±0.5`→0 RED 1/2, naming only the two-pane test, which is clean attribution to the newly added outline assertion. Scope clean: no file added or deleted, no config or dependency edit, no silencing directive, all 32 baselines untouched, TRIVIA-2 unchanged. Focused suites apples-to-apples with round 1: 11 files / 184 tests, 830 ms; 3 files / 32 tests, 7.65 s.

The regression: moving `.word-diff-change.word-diff-whitespace` into `diff-core.css` inverted its cascade position against three EQUAL-specificity (0,2,0) sibling rules — `.change-conflict .word-diff-change`, `.variant-modification .word-diff-change`, `.variant-deletion .word-diff-change`. At HEAD all four are (0,2,0) and the whitespace rule won all three ties purely by coming last in `merge-editor.css`. The `@import` at line 1 inlines `diff-core.css` ~850 lines earlier, so after the fix the whitespace rule came FIRST and lost every tie: a whitespace-only word-diff run inside a change-conflict, variant-modification, or variant-deletion block would paint the full PyCharm variant color instead of the 10% neutral tint. Reachable in production — the renderer always emits both class names on the same span.

#### Root fixup — cascade restoration (not a fix round)

I verified the regression myself before acting, reading both sides rather than trusting the report: at HEAD, `merge-editor.css` orders `.word-diff-change` (1181), `.change-conflict …` (1185), `.variant-modification …` (1193), `.variant-deletion …` (1196), `.conflict-result.edited …` (1199), `.word-diff-change.word-diff-whitespace` (1207) — the whitespace rule last. In the fix round's built `dist/webview-mergeeditor.css` it sat at line 134 with the variant rules at 984/992/995. Confirmed inverted.

Root cause is my own round-1 disposition. I wrote that the diff-core duplicate was "outranked by specificity", which is true only against the (0,1,0) base rule; I did not enumerate the three EQUAL-specificity descendant rules whose loss was positional. "Move the winning rule verbatim" cannot preserve a win that was never about specificity. The general lesson, worth carrying into Phase 1: extracting a rule into an `@import`ed stylesheet relocates it in the cascade even when its bytes are identical, so equal-specificity ties must be enumerated before any rule moves.

Fix applied at root, not as a Codex round: restore HEAD's exact arrangement — `.word-diff-change.word-diff-whitespace` returns to `merge-editor.css` immediately after the variant rules, and the `diff-core.css` duplicate is deleted. Exactly one declaration site survives, so MINOR-4's real complaint (two divergent copies with different fallbacks) is still resolved; it is resolved merge-side rather than core-side, which is also the spec-correct home — the rule's meaning is defined entirely by the merge variant rules it ties with, and per the Phase 0 contract merge-only adapters stay outside diff-core. Both files carry a comment naming the positional tie so a later phase does not repeat the move. I rejected raising the rule's specificity inside diff-core: that would change behavior against the (0,3,0) and (0,5,0) rules that legitimately beat it at HEAD.

Done at root rather than by spending fix round 2: this is a six-line revert to bytes that already exist at HEAD, with no design or test-contract judgment in it, and it keeps a fix round in reserve for anything the accept battery surfaces.

Proof after the fixup: rebuilt `dist/webview-mergeeditor.css` now orders the five rules 130 / 981 / 989 / 992 / 995 / 1001 — the same relative order as HEAD's 1181 / 1185 / 1193 / 1196 / 1199 / 1207, with the whitespace rule last again. The `var(--vscode-editor-foreground, #ccc) 10%` fallback occurs exactly once in the bundle; exactly one declaration site remains in `src/`; `dist/*.css` still emits the same five files; all 32 pixel baselines untouched. `format:check` exit 0, `build` exit 0, round gates GREEN warn=0 (typecheck 6.2s, lint-strict 13.3s), focused merge + type-scale 11 files / 184 tests passed in 855 ms. HEAD still equals BASE_HEAD.

Also noted and left unchanged: the design-system hook reports 22 palette/radius findings in `merge-editor.css` and 6 in `diff-core.css`. Every one is a pre-existing literal (VS Code theme-variable fallbacks such as `#6e7681`, `#c586c0`, `#ce9178`, `#b5cea8`, `#4fc1ff`, `#f48771`, `#0e639c`, and 2px/10px radii) carried verbatim from HEAD by the extraction, not a new design decision. Changing them would break the zero-behavior-change contract this phase is gated on, and suppressing them requires explicit human confirmation that this lane does not have. Recorded for the Phase 3 token sweep, which is where the spec puts them.

Root verdict after the fixup: ACCEPT. The verifier's REJECT was correct and is now discharged at its own layer — the cascade order, which is what it actually objected to, is byte-for-byte back to HEAD's.

### P0 — Acceptance

Accept battery: `verify.py gates --base <phase BASE_HEAD> --stage accept` → **GREEN warn=0**, all seven gates exit 0.

| gate             | result | time   |
| ---------------- | ------ | ------ |
| typecheck        | OK     | 6.2s   |
| lint-strict      | OK     | 13.4s  |
| format-check     | OK     | 6.3s   |
| architecture     | OK     | 1.0s   |
| deps-knip        | OK     | 1.1s   |
| tests            | OK     | 413.2s |
| visual-container | OK     | 795.6s |

`tests` = the full vitest suite, **295 files / 4116 tests passed**. `visual-container` = the containerized Playwright pixel suite, **336 passed in 13.2m**, run against the Docker daemon at 29.1.3. All **32** pixel baselines are byte-unmodified — `git status --porcelain tests/visual/` is empty, and nothing was re-recorded. That is the Phase 0 tripwire and it held: the extraction changed no rendered pixel.

Seal: `SEAL: WRITTEN files=21 green=True`, then `SEAL: INTACT files=21 warns_open=0`.

The battery was run twice. The first run was GREEN but carried `warn=1` — the `types-silenced` rule matched this log file, because the paragraph describing the verifier's type probe quoted a type-suppression directive verbatim as prose. A warning that fires on a description of a check, rather than on a check being suppressed, teaches the eye to skip warnings, so the sentence was reworded to name the directive without quoting it and the whole battery re-run to warn=0. The first run also mis-ordered seal against gates — sealing before the accept stage binds a verdict digest the accept run then overwrites, which correctly reported `SEAL: MALFORMED`. Seal is written after the gates.

#### SHADOW: findings in hash-unchanged files = 11

SEAL_MODE=shadow, so a fresh final verifier ran even though the seal was INTACT — a second opus lane with no knowledge of the build, the review, or the fix round, auditing the accepted tree at Gates 4–5 only. It returned **11 findings, highest MAJOR**, all in files the seal records as hash-unchanged since review. Its headline: **no violation of the zero-behavior-change contract.** It built a cascade order-swap detector, validated it by reintroducing the already-fixed whitespace regression in scratch copies and confirming it flagged exactly the three expected swaps, then ran it on the real tree and found **zero** swaps across 232 old vs 234 new flattened rules, with `.diff-core` the only added selector and zero removed. It also confirmed no structural three-pane assumption survives anywhere in the diff-core TypeScript, and that `bandSpansForMiddleGap` — the genuine three-pane helper — correctly stayed in the merge adapter.

Root disposition: **none of the 11 blocks P0**, and I am not deferring them silently — every one is recorded here, and the load-bearing ones become Phase 1 entry conditions below. P0's done-criteria are met and independently proven: the pane generalization is real (mutation-proven three ways in round 1, and the shadow lane's own M2 — clipping the engine to the first two panes — turns the three-pane contract test RED, so that test does constrain pane-count generality); merge and shelf-conflict behavior is unchanged (full suite plus unmodified pixel baselines); both a two-pane and a three-pane contract test exist and bite.

The MAJOR is a gap in the phase's forward-looking half, not in what it delivers: `diff-core.css` never establishes the monospace code typography that its own `ch`-based layout math depends on. `font-family: var(--vscode-editor-font-family, monospace)` and the code font size live only on `.merge-content` (`merge-editor.css:371-382`), a merge-only container that did not move, and `--diff-code-font-size` (`diff-core.css:11`) is declared with **zero readers** — the three rules that apply the code size read `--merge-code-font-size` directly. A future `.diff-core` root therefore inherits the proportional UI font, `1ch` stops equalling one glyph, and the shared-scroll-extent invariant that `.code-lines` documents would break. Zero impact on the merge editor, which still has `.merge-content`.

I am not fixing it inside P0, and the reason is not scope convenience. Every pixel-free, decision-free part of this class of gap was already fixed this phase — that was MINOR-3, where widening a selector and adding an alias required no design choice. This one does: it requires deciding which element in a non-merge tree carries the code font, which is the viewer's container class, which is a Phase 1 DOM decision that spec Out-of-scope explicitly bars from Phase 0 ("no DiffViewerApp"). Guessing it now, blind, and then re-running a 13-minute pixel battery to prove the guess harmless is the worse trade. Recording it as a blocking entry condition is the correct one.

**Phase 1 entry conditions (binding — P1 cannot claim its bundle renders correctly until each is discharged):**

1. **[from MAJOR]** `diff-core.css` must establish code typography for a non-merge root — `font-family` and a font size wired through `--diff-code-font-size` — or diff-core must explicitly document that the consumer supplies them, with the viewer doing so. Note `tests/webview/unit/type-scale.test.ts` allows only 11/12/13/14px under `src/webviews/`, and `--diff-code-font-size` already defaults to 13px, so the scale-compliant path exists. The synthetic shared scrollbar needs the same font match that `merge-editor.css:672-675` gives it.
2. **[MINOR]** Five `--diff-*` aliases have zero readers today: `--diff-code-font-size`, `--diff-pane-boundary`, `--diff-pycharm-conflict`, `--diff-pycharm-inserted`, `--diff-pycharm-deleted`. Only `--diff-pycharm-modified` is read. Knip does not analyze CSS, so no gate will ever catch this. Either wire them in P1 or delete them; do not leave a semantic layer that silently ignores what a consumer sets.
3. **[MINOR]** `--diff-action-gutter` defaults to 44px — the width of the merge accept/reject strip — and its only override input is the merge-named `--merge-action-gutter`. A read-only viewer has no action buttons and needs a `--diff-*` input, or the gutter reserved at `diff-core.css:50-54,82-84` becomes 44px of dead space.
4. **[MINOR]** `LineNumbers` (`diff-core/segments.tsx:215`) accepts a `secondary` prop that three call sites pass and nothing renders, making `.line-numbers.has-secondary`, `.line-number-secondary`, and `.code-block.no-line-numbers` dead in the shared contract file. This is pre-existing at HEAD and was deliberately carried unchanged (adjudicated as TRIVIA-2 in round 1), but P1 is exactly the consumer that wants a two-column old/new gutter, and `tests/integration/webviews/merge-webviews.integration.test.tsx:1352` currently pins the dead state at zero. Implement it or delete it in P1; do not leave a prop that typechecks and does nothing.
5. **[MINOR]** `diff-core/scrollSync.ts` has zero tests — no test file references any of its four exports. Not a coverage regression (the logic was untested inline in `MergeEditorApp` before the move), but a module presented as reusable with no contract test. Its `minClientWidth === Infinity` skipped-layout fallback (`:103-107`) is the branch nobody triggers by accident.
6. **[MINOR]** `diff-core/segments.tsx:11` imports `../../../mergeEditor/wordDiff`, the one import that leaves the webview tree, landing in a merge-named directory. dependency-cruiser passes it and `wordDiff` is generic in substance, but `diff-core/` is not self-contained.

Recorded and not acted on: the contract test's `viewportH` argument is inert — the shadow lane's M1 (clamp → `POSITIVE_INFINITY`) leaves `diffCoreLayout.test.ts` GREEN while the sibling `mergeScrollLayout.test.ts` goes RED at its `never returns a negative offset when the viewport exceeds content` assertion. The suite is not blind to the clamp; the diff-core-named file just is not self-sufficient. The three-pane case is also thinner than it reads (one segment, and `conflict: true`/`id: 9` are never asserted on). Both are test-strength notes, not coverage holes, and neither justifies re-running a 22-minute accept battery. `diff-core/mergeScrollLayout.ts` also keeps a merge-derived filename while a second, different `mergeScrollLayout.ts` holds the merge adapter — rename in a later phase, not while pixel baselines are the tripwire. `CommonPaneBlock`'s `pane` prop is inert in render and in its memo comparator. `.segment-common .code-line` changed from `var(--vscode-editor-foreground)` to `var(--diff-editor-fg)`; the shadow lane traced both resolutions and they are identical whether or not the theme variable is set.

Post-gate change: only `PLAN-REVIEW-LOG.md` changed after the green accept run, to record this section. No source, test, asset, or configuration byte moved — the seal was rewritten over the final tree and re-checked INTACT before the commit.

Root verdict: **P0 ACCEPTED.**
