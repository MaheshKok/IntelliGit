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
| P1    | Phase 1 (2.1–2.6): computeDiffSegments, DiffViewerApp, bundle, panel, protocol, l10n, tests    | accepted |
| P2a   | Phase 2 (3.1-3.3): openUnifiedDiff funnel, side loader, budget measurement                     | **accepted 0399aea9** |
| P2b-i | Phase 2 (3.5): generation-bound sessions, frozen snapshots, fallback CAS                       | **accepted 23a713e1** |
| P2b-ii| Phase 2 (3.6): root-keyed change event, watcher refcounts, live refresh, loadError       | **accepted 0ede98f1** |
| P2c   | Phase 2 (3.4, 3.7, 3.8): call-site rewires, ride-along integration, full gate battery          | pending |
| P4    | Phase 4: editable working-tree pane via CustomTextEditorProvider                     | pending |
| P5    | Phase 5: find-in-diff via enableFindWidget + DOM-completeness gate                             | pending |
| P3    | Phase 3: straggler sweep, css-modules.d.ts removal, docs                             | pending |

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

### P1 — Round 1 — Codex build (gpt-5.6-luna/xhigh)

SID `01a021d3-e6b0-7610-9b5f-c278987ee016`. Telemetry: `PEAK=245305 LAST=69329 PCT=94% NONRESUMABLE=yes`.

Sizing: the work order shipped with a session budget making deliverables 1–8 mandatory and 9–10 continuation-eligible. It did not need the continuation — all ten landed in one session — but at 94% of the window, the second phase in a row to overshoot its prediction (P0 predicted ~55% and ran 94%). The predictor is not calibrated for this repository; treat "large" as "will fill the window" when sizing P2.

HEAD gate: `git rev-parse HEAD` identical before and after the round and equal to BASE_HEAD. No ref moved; every change left uncommitted. `git status --porcelain tests/visual/` showed source and fixture files only — zero PNG baselines added or modified.

Round gates: typecheck OK 6.2s; **lint-strict FAIL(1) 13.4s** — one error (an unused protocol-type import at `src/views/DiffViewerPanel.ts:9:5`) plus three `react-hooks/exhaustive-deps` warnings in `DiffViewerApp.tsx` (`:147` twice, `:319`). `lint:strict` is `eslint src scripts tests --max-warnings=0`, so all four are hard failures.

Codex self-reported all ten deliverables DONE with one declared deviation: no pre-implementation RED was captured for the new behaviour; a retroactive focused GREEN plus the required mutation RED were run instead. `SUBAGENTS_SPAWNED: 0`.

**Phase verifier (fresh opus, read-only, fable-method) — VERDICT REVISE.**

It re-derived Codex's mutation claim rather than accepting it, running three directions with sha256 bracketing and confirming byte-exact restoration of all three files it touched:

- **M1** — viewer renders the editable/action selectors → RED, exit 1, failing title `DiffViewerApp read-only contract > has no editable or per-hunk action surface`. Codex's claim holds.
- **M3** — the other direction, renaming those selectors in the merge app → RED naming `keeps the anti-vacuity selectors present in the merge app` (expected 4, got 0). The pair bites both ways, so the ABSENT half is not a tautology over selectors that never exist.
- **M2** — the one Codex did not report: dropping `setData(event.data.data)` leaves the viewer in its loading branch rendering zero code lines, and the file still ran **2 passed, exit 0**. The ABSENT half asserted four absences and nothing positive, so it went green against a viewer that rendered nothing.

It also verified merge pixel-safety at the built artifact rather than the source: `dist/webview-mergeeditor.css` carries the new `.diff-core`, `.diff-core.diff-viewer`, `.diff-pane + .diff-pane` and `.diff-segment-*` rules, but no merge DOM element carries any of those classes (`MergeEditorApp.tsx:1123` roots at `"merge-editor"`; those classes appear only in `DiffViewerApp.tsx`). No equal-specificity tie is created, so the Phase-0 cascade burn recorded at `merge-editor.css:1055` cannot recur.

**Root adjudication of the eight candidate findings.** Accepted and routed: F1 (the unused import is a symptom — both `postMessage` calls sent untyped object literals, so the protocol union was never enforced at the post site and a typo in either type string compiled; routed as "bind the payloads", explicitly not as "delete the import", which would have turned the gate green while leaving the protocol unenforced), F2 (the M2 vacuity gap), F4 (`panel.title` set only at creation, so every diff after the first was labelled with the first file's name — user-visible wrong labelling of the one behaviour spec 2.3 defines), F5/F6.

Rejected, with reasons:

- **F3 (no pixel baseline for the ninth context)** — correctly observed, wrongly attributed. Codex was forbidden from running any Playwright or container command; recording the four viewer baselines is the reviewer's accept-stage step. Confirmed the surface will actually be photographed: `pixelBaselines.spec.ts:9` iterates `HOST_CONTEXT_IDS`, derived from `WEBVIEW_HOST_CONTEXTS`.
- **F7 (`src/diff/wordDiff.ts` header rewritten)** — required, not a deviation. HEAD's header read "for the merge editor … in conflict hunks"; the file is now imported by the extension-host diff engine, so that text would be false. The algorithm body is byte-identical to HEAD.
- **F8 (re-serialized CSV row)** — deterministic `l10n:sync` normalization that would return on the next sync.

Also adjudicated from the root's own spot-read and rejected as findings:

- **`DiffViewerPanel` has no production caller.** Spec-correct: Out of scope names "New palette commands (the panel opens programmatically only)", and call-site wiring is Phase 2 step 3.1. `knip` exits 0 — the dynamic import from the integration test gives the bundle entry its edge, so no config entry is needed.
- **`computeDiffSegments` does not call `wordDiff`**, so spec 2.1's literal "reusing … `wordDiff.ts` for intra-line masks" is unmet host-side. Steelmanned and accepted as built: decision 5 names its own precedent — segments shipped "like `MergeEditorData` today" — and today the merge editor computes word masks render-time in `segments.tsx`. Moving them host-side would fight 2.2's "reusing the merge editor's toggle components" and force a host round-trip per word-highlight toggle. Alignment quality, which is what decision 5 argues for, is `diffLinesFair` and does run host-side. The toggle is genuinely wired (`DiffViewerApp.tsx:81,406,423` → `diff-core/segments.tsx:294`), not decorative.

Root-originated finding, routed with the other four: the greedy-fallback regression hard-coded 3_201 lines and exercised the fallback only because 3201² = 10,246,401 exceeds `MAX_LCS_CELLS = 10_000_000` (`lineDiff.ts:35`, un-exported). Raise that constant and the test keeps passing while covering nothing — and the greedy path is a spec-named regression target.

### P1 — Round 2 — Codex fix round 1 (gpt-5.6-luna/xhigh)

SID `01a02201-d125-75a2-931f-77c66303a2ff`, fresh session (`route fix 1` → `EFFORT=xhigh MODE=fresh`). Telemetry: `PEAK=211381 LAST=211381 PCT=81% NONRESUMABLE=no`. Five findings routed as one order; all five DONE.

HEAD gate: unchanged and equal to BASE_HEAD. Baseline directory untouched.

Round gates re-run by the root — not read from the lane's report: typecheck OK 6.1s, lint-strict OK 12.9s, **GATES: GREEN warn=0**.

Root spot-read of the delta: both host→webview sends now route through a single private post helper typed to the inbound union, so the protocol is enforced at the post site; the two lint warnings were fixed at the cause rather than silenced — `segments` became `useMemo(() => data?.segments ?? [], [data])`, which also restored the two downstream memos that a fresh array identity had been defeating every render, and the teardown effect captures the scroll-sync ref into a local before the cleanup closes over it. The reuse path retitles from the new snapshot using the same localized call as creation, so no new catalog key was needed. The `showLineNumbers` deletion is now complete: zero matches across `src/` and `tests/` for the four dead identifiers, and the emitted class string is byte-identical to what the old always-true branch produced — the only branch any call site ever took. `MAX_LCS_CELLS` is exported and the fallback regression derives `Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 1` = 3163, whose square clears the guard.

**Verifier delta re-check (same lane, resumed) — VERDICT ACCEPT, 5/5.** It ran no manifest gates, correctly. Highlights: the mutated protocol string yields exactly TS2820 at (123,27) in the mutated state and nowhere else, so the union is enforced rather than decoratively imported; no suppression escapes of any kind were introduced across the seven changed files — no lint-disable comments, no TypeScript error-suppression comments, no any-typed casts — so the gate went green by fixing causes; M2 is now RED naming its own test where it was 2/2 green the round before, with M1 and M3 still RED by name.

Worth recording for its own sake: on the pixel-neutrality check the verifier **discarded its own first piece of evidence**, because it could not prove its "before" bundle copy predated the fix round and may have compared a file against itself. It re-established sensitivity instead — perturbing the class string moves the bundle hash, restoring returns the original exactly — so the comparison is known to be capable of detecting a change, which is what makes its stability mean anything. A hash comparison whose sensitivity is unproven is the same failure as a green mutation. Pixel-neutrality then rested on four independent legs: the class string byte-identical by construction, zero matches for the dead class in the built js and css, merge CSS sources untouched, and merge-webviews integration 28/28.

`MAX_LCS_CELLS` coverage was proven discriminating rather than merely green: a throw-probe inside the greedy matcher goes RED only on the fallback test, and raising the constant from 10M to 40M with the probe armed keeps it RED, where a hard-coded 3164 would have gone green.

### P1 — Round 3 — Codex fix round 2 (gpt-5.6-luna/xhigh)

SID `01a02218-6522-72a0-bafb-9a6e83a4f1e6`, fresh session. Telemetry: `PEAK=185112 LAST=185112 PCT=71% NONRESUMABLE=no`. One defect, and the last permitted fix round.

**The defect: the ready-replay contract lost the ignore-whitespace mode.** `ready` is the webview's "I just mounted, tell me what to show", and the host answered it with segments computed from `this.ignoreWhitespace` without carrying that flag, while the webview's toggle was local state never derived from the payload. Any remount against a surviving host instance therefore left the toolbar reading "no ignore" over whitespace-insensitive content.

The verifier raised this and disagreed with my steelman, correctly on the point that mattered: `retainContextWhenHidden` governs hiding, not reloading, so neither of us had covered a webview remount under a live host instance. We agree window reload is safe — no `WebviewPanelSerializer` is registered for this panel (the only one is `UndockedViewProvider` at `src/activation/common.ts:213`), so the host instance dies with the window.

**Why this was fixed in P1 rather than deferred.** Not because the trigger was proven — it was not. The verifier marked its finding ASSUMED, reasoned from the API contract and never executed, and an unexecuted claim is not a demonstrated bug. What is demonstrable with no VS Code involvement is the part actually fixed: a replay contract whose answer omits a field the webview needs to describe itself truthfully. That is assertable at the host layer with the existing mock, and that is what the tests assert. The reload path is the motivation; the replay gap is the defect. Deferral was the real alternative and is what the P0→P1 conditions did successfully, but those were decisions P0 *could not* make — Out-of-scope barred the DOM choice they depended on. This one is fully decidable inside the phase that owns the protocol, since spec 2.4 makes `diffViewerTypes.ts` a P1 deliverable, and handing a known protocol gap to a phase that would merely inherit it is the "acceptable for now" the standing rules forbid.

The field is **required, not optional**: an optional one would let a future producer omit it and silently reintroduce exactly this bug. `DiffViewerData` already carried `left`, `right` and `newlineDifference` beyond spec 2.4's four named items because 2.1's prose required them, so this is not a departure from the frozen protocol.

Design choice made at root rather than left to the writer: the toggle keeps its optimistic local update and the payload becomes the authority that corrects it. Pure derivation from the payload was the smaller diff but puts a host round-trip between the click and the button changing — a visible regression on an interaction that is currently instant.

The fixture was regenerated through the recorder rather than hand-edited, because the fixture gate byte-compares against a fresh recording; the recorded value is `false`, which is what the toolbar already rendered, so the pixel surface is unchanged.

**Verifier re-check — VERDICT ACCEPT.** Both directions mutation-proven with the tree byte-identical afterwards: deleting the field from `buildData()` turns `replays the authoritative ignore mode when the webview reports ready` RED with the nearest-neighbour test still green, so the new assertion is the only thing catching it; deleting the reconciliation turns `reconciles the ignore mode from a host payload after a fresh mount` RED, and the failure text incidentally proves the toolbar selector picks the ignore button by content rather than by positional luck. Required-field enforcement confirmed at the compiler: a single TS2741 in the mutated state only, with the field supplied explicitly after both spreads and neither spread carrying it, so no future spread can silently satisfy it. The regenerated fixture is recorder-produced end to end — the whole-file byte-compare and the orphan direction are both green across 171/171 recorder tests with the update flag unset.

Adversarial result on the fix shape, which is the part I most wanted a second read on: the classic optimistic-update failure — a stale in-flight payload snapping the button backwards — is **unreachable as a persistent state**, because the mode is assigned before any await and `buildData()` is fully synchronous, so the payload stamps the mode at send time. A reuse-path `open()` during an in-flight toggle can produce one transient flicker that converges; not a defect.

**Root-made change, outside both fix rounds.** `tests/unit/visual/pixelBaselineLayout.test.ts:26` was titled "stores exactly the 32-cell matrix at the configured template path". Its assertions were always computed from the config, so the logic was right, but 32 was about to become 36 and a title that contradicts its own assertion misleads in the one place a person reads when it fails. Retitled to "stores exactly the context-by-project matrix…" — the number removed rather than updated, so it cannot decay again at a tenth context. Verifier confirmed one line changed, zero assertions touched, and that the set-size assertion still bites on filename collisions.

**Two latent edges, logged and not fixed.** Neither is reachable today and neither justified a third round: (1) `DiffViewerApp:139`'s validity guard returns without reposting, making it the one optimistic path with no corrector — currently unreachable through the typed union; (2) the reuse path never resets `ignoreWhitespace`, so file B inherits file A's mode. The second is deliberate and matches PyCharm; it was a defect only while the mode was invisible, and the payload now displays it truthfully.

**Phase 1 entry conditions from P0's shadow review — discharge status.**

1. **Typography [MAJOR] — discharged.** `diff-core.css:29-33` establishes the monospace family and a size wired through `--diff-code-font-size` on `.diff-core`, the class the viewer root carries. Type-scale compliance verified at the gate's own mechanism rather than by eyeball: its size pattern requires a literal digit immediately after the property, which a variable chain never matches, and every literal size in `diff-viewer.css` is 11/12/14. The synthetic scrollbar match the condition demanded is present — `.diff-horizontal-scroll-inner` mirrors `merge-editor.css:670-675` field for field.
2. **Five dead aliases [MINOR] — discharged.** All five now have both a CSS reader and a live emitter, checked per variable rather than in aggregate: `--diff-code-font-size` (`:31`), `--diff-pane-boundary` (`:58`, emitter `DiffViewerApp.tsx:397,414`), `--diff-pycharm-conflict` (`:62`, emitter `:64`), `--diff-pycharm-inserted` (`:66`, emitter `:69`), `--diff-pycharm-deleted` (`:70`, emitter `:70`). None is merely declared — the failure this condition exists to catch.
3. **Action gutter [MINOR] — discharged.** `--diff-viewer-action-gutter` added as the `--diff-*` input (`diff-core.css:11`), mapped into `--diff-action-gutter` by `.diff-core.diff-viewer` (`:37-38`), set by the viewer at `DiffViewerApp.tsx:340`. The merge editor's 44px gutter is untouched.
4. **`LineNumbers` secondary [MINOR] — discharged by deletion.** The prop, its three call-site arguments and the two dead CSS rules are gone, and the vacuous zero-length pin at `merge-webviews.integration.test.tsx:1352` was replaced by an assertion that still bites — every number row renders exactly one cell. Round 1's deletion also took `.code-block.no-line-numbers`, which the independent `showLineNumbers` prop activated rather than `secondary`, leaving a live branch emitting a class with no backing rule — the same "typechecks and does nothing" shape this condition exists to kill, moved one prop over. Fix round 1 closed it by deleting the prop and its branch so the class became unemittable.
5. **`scrollSync.ts` untested [MINOR] — discharged.** `tests/webview/unit/scrollSync.test.ts` covers all four exported functions, and the skipped-layout fallback is genuinely exercised, verified at root rather than inferred: the test supplies a code-lines element of zero width so the guard never fires, then asserts the computed width string contains the retained `77`. That value can only come from the fallback assigning the last-known pane width — a value oracle, not a shape check.
6. **`diff-core` not self-contained [MINOR] — discharged.** `wordDiff` moved to the neutral `src/diff/wordDiff.ts`, consumed by both the webview and the new extension-host engine. The coupling the condition named — a pane-agnostic module importing a merge-named one — is gone; `depcruise` reports no violations across 309 modules.

**Binding P2b entry condition (new, from the fix-round-2 adversarial pass).**

The optimistic-toggle safety argument above rests on `buildData()` being **synchronous**: the mode is assigned before any await and the payload stamps it at send time, so two rapid toggles cannot deliver out of order. P2b owns the session and replay machinery and will rebuild this path. If any await is introduced between receiving `setIgnoreMode` and stamping the payload, that property breaks and the transient snap-back becomes persistent. P2b must therefore keep the ignore-mode recompute operating on already-held snapshots and never re-acquire content on a toggle — which spec 3.5 already requires — and if that ever bends, stamp the session generation into the payload and drop stale ones in the webview's reconcile. This is binding: P2b cannot claim the viewer's toggle is correct until it shows which of the two holds.

### P1 — Round 4 — Root takeover (fix rounds exhausted)

`MAX_FIX_ROUNDS=2` was already spent, so under Step 5 of the build skill the phase root finished this one directly rather than opening a third Codex session. No model was swapped; no Codex session was started for this round.

**How it surfaced.** Container run #1 was armed only to record the phase's four new pixel baselines. It did that correctly — 32 to 36 PNGs, exactly the four `diff-viewer` cells, zero existing baselines modified — but it also failed two tests nobody had seen before, because the accept battery had never run against a `diff-viewer` context until the fixture existed:

```
[hc-light-narrow] nonPixelOracles › diff-viewer matches the known-findings baseline
[hc-light-wide]   nonPixelOracles › diff-viewer matches the known-findings baseline
  diff-viewer contrast: 3 NEW finding(s) @1.5   (floor 4.5)
```

Both high-contrast **light** projects; both high-contrast **black** projects were clean, as were all four modern projects. That asymmetry is the whole diagnosis.

**Root cause — pre-existing, not introduced by this phase.** `git diff --stat <base> -- src/webviews/react/diff-core/shikiHighlighter.ts` is empty: the file is untouched by P1. Its `detectTheme` read

```ts
if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) return "dark-plus";
```

VS Code sets **both** `vscode-high-contrast` and `vscode-high-contrast-light` on the body for the high-contrast light theme — the legacy class is kept for backwards compatibility. The repository already records this in two places: the host fixture `tests/visual/fixtures/host/hc-light.json:22-23` lists both classes, and `tests/e2e/hostFixtures/hostFixtureThemes.ts:34-35` documents the duplication verbatim. So the legacy branch matched first and high-contrast *light* was highlighted with the **dark** Shiki palette — light syntax colours painted onto a white editor background. `#9CDCFE` on `#ffffff` computes to 1.491:1 under the oracle's WCAG 2.2 maths, which is the reported 1.5.

Two hypotheses reached 1.5 independently (a dark background under dark tokens via the `#2b3240` fallback in `diff-core.css:4`, and a light palette under a dark one). They were not separated by arithmetic — both matched — but by the fixture: `hc-light.json` carries the legacy class, which makes the palette branch the reachable one and the fallback branch unreachable.

The merge editor shares this code path and was clean only because its fixture's tokens happen to clear 4.5 on white. The defect was latent, not absent; the read-only viewer's sample is what exposed it.

**Blast radius established before the edit, not after.**

- `playwright.visual.config.ts:7` — `HIGH_CONTRAST_SPEC_IGNORE = LOCALE_SWEEP_SPEC | PIXEL_SPEC`, applied to all four `hc-*` projects at lines 81-96. High-contrast projects run **no** pixel spec, so a rendering change confined to high-contrast light cannot move any pixel baseline. The 32 pre-existing baselines are 8 contexts x 4 non-hc projects; the 36 now are 9 x 4.
- `tests/visual/fixtures/knownFindings.json` holds **zero** contrast findings for any `hc-light` or `hc-black` context (the only baselined contrast findings anywhere are two `commit-panel` entries under `dark-modern-*`). So correcting the palette removes findings that were never baselined: no stale entries, no baseline regeneration, no `--update` run.

**Fix.** Settle high-contrast light before the legacy check, in `src/webviews/react/diff-core/shikiHighlighter.ts`:

```ts
if (classes.contains("vscode-high-contrast-light")) {
    return "light-plus";
}
if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) {
    return "dark-plus";
}
```

**Reproduction and mutation proof.** The failing test was written and run *before* the fix, in `tests/unit/merge/shikiHighlighter.test.ts`, and it failed for the stated reason rather than incidentally:

| Direction | Mutation | Result |
| --- | --- | --- |
| too strict | fix absent (original code) | RED — `detectTheme > returns light-plus for high-contrast light despite the legacy high-contrast class`, `expected 'dark-plus' to be 'light-plus'` (1 failed \| 22 passed) |
| too loose | guard widened to the legacy class | RED — `detectTheme > returns dark-plus for the vscode-high-contrast body class`, `expected 'light-plus' to be 'dark-plus'` (1 failed \| 22 passed) |

Both mutations were applied by copy, never by `git checkout --`, and the source was restored byte-exact: sha256 `02873b0e400cad49d1f096aaaa1efd3b2a28f67ebea225a719f4a1a249844791` before and after. 23/23 green on restore.

**Why this was fixed rather than baselined.** Adding the three findings to `knownFindings.json` would have turned the gate green in one line. It would also have recorded, as accepted, text rendering at 1.5:1 in a brand-new user-facing surface — an accessibility defect entering the product through its own tripwire. The one-line palette correction removes the findings at their cause, improves the merge editor in the same theme, and needs no baseline edit at all.

**Out-of-slice disclosure.** This is the only P1 change outside the frozen slice, and it edits a file Phase 0 committed. It is recorded here explicitly so it can be challenged: the alternative was shipping the defect or baselining it, and both were worse than a three-line guard with proofs in both directions.

**Two pinned inventories the phase had grown without registering.** The same accept run that exposed the contrast defect also failed two unit tests, both for the same structural reason and both running for the first time — the round stage is only `typecheck` + `lint-strict`, so the full vitest suite had never seen this tree:

| Test | Pin | Why it fired |
| --- | --- | --- |
| `tests/unit/scripts/webviewConfigs.test.ts:16` | `toHaveLength(7)` | P1 added an eighth webview bundle, `react/diff-viewer/DiffViewerApp` -> `webview-diffviewer` (`scripts/webviewConfigs.js:9`) |
| `tests/unit/e2e/coverageManifest.test.ts:205` | 9-entry `OUTBOUND_UNION_DECLARATIONS` | P1 added a tenth outbound union, `src/webviews/protocol/diffViewerTypes.ts:OutboundMessage` |

Neither is a stale test to be relaxed. Both are deliberate two-way ratchets: `webviewConfigs.test.ts` derives `expectedConfigs` from `WEBVIEW_CONFIGS` itself, so its `toEqual` assertions are self-referential and the pinned **count** is the only thing carrying signal; `coverageManifest.test.ts:40-46` states in prose that pinning the declaration list is what stops a renamed union from silently dropping its whole action set out of the required surface. Each was updated by registering the new surface — the bundle count moved 7 to 8 (title included), and the new union was inserted in path order — never by loosening an assertion.

Registering the tenth union also re-armed the assertions that iterate it. `matches every outbound webview action in both directions` passed immediately afterwards, which is the evidence that the viewer's outbound ids were already present in the E2E manifest rather than newly exempt.

Both pins were then mutation-proven against **production** drift, not against themselves:

| Mutation (production side) | Result |
| --- | --- |
| drop the `diff-viewer` entry from `scripts/webviewConfigs.js` | RED — `derives eight build and watch configs...`, `expected ... to have a length of 8 but got 7` |
| rename `OutboundMessage` to `DiffViewerOutbound` in `src/webviews/protocol/diffViewerTypes.ts` | RED — `reads every outbound union it is pinned to, and no others` |

Restored by copy, byte-exact: `scripts/webviewConfigs.js` sha256 `4288cf02502f5172954dbe2094ee2bf7db35f5ff21da13007efc018c03ad61fd` and `src/webviews/protocol/diffViewerTypes.ts` sha256 `ef207e8b6698a537246e0be05dd0e0d2c151e0dc6f90a8656a6bc52b8894bac1`, identical before and after; 7/7 green on restore.

**Accept battery, final tree.**

```
python3 ~/.claude/skills/claudex-build/verify.py gates --base <BASE_HEAD> --stage accept
```

| Gate | Result | Time |
| --- | --- | --- |
| typecheck | OK | 6.3s |
| lint-strict | OK | 13.6s |
| format-check | OK | 6.4s |
| architecture | OK | 0.9s |
| deps-knip | OK | 1.1s |
| tests | OK | 408.5s |
| visual-container | OK | 883.3s |

`GATES: GREEN warn=0`. The tests gate is **4138 passed / 0 failed across 299 files**; the previous run of the same battery was 4136 passed / 2 failed, and the delta is exactly the two ratchet registrations above. The container battery is **342 passed** — the 336 of Phase 0 plus the six `diff-viewer` cells (four pixel projects and two high-contrast non-pixel projects).

**Pixel baselines.** 32 before, 36 after. The four added are the `diff-viewer` cells for `dark-modern-narrow`, `dark-modern-wide`, `light-modern-narrow`, `light-modern-wide`; `git status --porcelain tests/visual/__screenshots__/` reports four `??` entries and nothing else, so **no existing baseline was modified**. The four were recorded by a deliberate container run, and a second container run then compared them green — sha256 of all 36 files was captured before and after that second run and is byte-identical, which is what rules out a recording side effect masquerading as a pass.

**HEAD gate.** `git rev-parse HEAD` read the BASE_HEAD value unchanged at the end of every round, including both root-takeover rounds. Codex never committed, staged, or moved HEAD.

**Phase 0 entry conditions.** All six binding conditions carried over from P0's shadow review were discharged and re-verified at root before acceptance, each against the artifact rather than against a lane's report: the typography contract, the five `--diff-*` aliases each having both a CSS reader and a live emitter, the `--diff-viewer-action-gutter` input, the residue condition discharged by deletion, the scroll-sync fallback coverage, and the relocation of `wordDiff` to a neutral `src/diff/`.

Root verdict: **P1 ACCEPTED.**

### P1 — Shadow verification (SHADOW=5) and Round 5 — Root takeover #2

Round 4 closed with "Root verdict: **P1 ACCEPTED**", and that verdict was wrong. A shadow verifier run against the accepted tree returned **five findings**, one of them a blocker, and the phase was never committed. This section supersedes Round 4's acceptance: the baseline count and gate table under Round 4's "Accept battery, final tree" describe a tree that no longer exists, and both are restated at the end of this section against the tree actually committed.

`MAX_FIX_ROUNDS=2` remained exhausted, so this round is root-written like Round 4. No Codex session was started; no model or effort was swapped. Every byte below was written by the phase root, which is the disclosure that matters when reading the mutation evidence — nothing here was checked by a second author before the shadow re-check at the end.

**`SHADOW: findings in hash-unchanged files = 5`.**

| # | Finding | Severity | Verifier's status | Disposition |
| --- | --- | --- | --- | --- |
| F1 | The viewer renders with no diff colouring and no visible ribbons: every `--diff-*` paint alias terminates at `var(--diff-editor-bg)` in a bundle that never imports `merge-editor.css`, so five rules paint editor-background on editor-background | BLOCKER | VERIFIED | FIXED — but not as the finding proposed |
| F2 | `computeDiffSegments("a\rb\r", …)` reports `eol:"lf"`: CR-only endings fold into the LF bucket, and `DiffSideMeta["eol"]` cannot express `"cr"` at all | MAJOR | VERIFIED | FIXED (Round 4 carry-over, re-proven below) |
| F3 | `.diff-viewport` has all four insets `auto`, so `position: sticky` never sticks, and its `margin-bottom: -100%` resolves against the containing block's **inline size** — a width, not the viewport height | MAJOR | ASSUMED | FIXED |
| F4 | The ribbon layer is a sibling of the panes and receives no transform, so ribbons stay fixed while the columns translate; separately its `viewBox` height is `Σ max(Lᵢ,Rᵢ)` against a CSS box of `max(ΣLᵢ, ΣRᵢ)`, scaling every ribbon by <1 | MAJOR | ASSUMED | FIXED |
| F5 | `diff-segment-modified` and `diff-segment-empty` are emitted with zero CSS rules — the four-way `changeClass` is two-quarters dead | MINOR | VERIFIED | FIXED for `modified`; **deliberately not fixed** for `empty` — see below |

Both ASSUMED findings were reasoned from a contract rather than executed, and the verifier said so. Both turned out to be real; the reason neither had been executed is the same reason F1 survived every gate, and it is worth stating plainly: **the fixture was two lines shorter than the viewport, so nothing could scroll, so no oracle could reach any of it.** The fixture is now twenty-one canonical rows and the scroll invariants are asserted in jsdom where they can actually be driven.

F5's `empty` half is answered rather than fixed: `diff-segment-empty` keeps zero CSS rules on purpose, because the block it names is zero pixels tall and any rule on it would be paint that never renders. That is the disposition, and it is asserted rather than asserted-about — see the sixth defect below.

**Why every gate stayed green on a surface that rendered nothing.** The verifier's own diagnosis, confirmed at root: the four `diff-viewer` pixel baselines had been recorded *from the defective build*, so they encoded the untinted rendering as correct; and `nonPixelOracles.spec.ts:68` reads its baseline sparsely (`BASELINE.read()[project]?.[contextId] ?? {}`), so a context with no slice asserts only "zero findings" — and unstyled text on the plain editor background has perfect contrast. A baseline recorded from the artifact it is meant to police is not a tripwire. All four PNGs were deleted before any recording run in this round; see **Pixel baselines** below.

**F1 is where this round was spent, and the fix is not the one the finding asked for.**

The obvious repair is the one the finding implies: give each alias a fallback that computes a real colour, so the viewer paints the merge surface's two-tier scheme — a 15% block wash of the change hue with a 30% word-fragment tint on top. That was implemented first. It fails, and not marginally.

Painting the wash makes the `diff-viewer` context reachable by the contrast oracle for the first time, and it reports below-floor text. Binary search on the wash percentage, all eight projects, non-pixel oracle only:

| Wash / fragment | Result |
| --- | --- |
| 15% / 30% | contrast findings in every light project and in `dark-modern` localeSweep (24 + 8) |
| 8% / 16% | still below floor |
| 8% / 0% | still below floor |
| 4% / 0% | 9 findings in `light-modern-wide`, 9 in `hc-light-wide`, all one element, @4.3–4.4 |
| 0% / 0% (control) | 72/72 pass |

Every survivor at 4% is the same element: `span:nth-of-type(5)`, the number token in `const rm0 = 0;`. The arithmetic explains why no percentage works. VS Code's light-plus colours `symbolIcon.numberForeground` **`#098658`**, which measures **4.603:1** on the light editor background (`#ffffff`) against a **4.5** floor — 0.103 of headroom. A background wash moves the luminance underneath every glyph, so a wash visible enough to mark a hunk is a wash that spends more than that. The control run proves the finding is caused by the palette and not by a pre-existing theme defect: at 0% the same tree passes 72/72.

This is not an IntelliGit-specific accident. GitHub's own added-line background `#e6ffec` puts that same token at 4.354. The industry convention fails this gate.

**Baselining was available and was refused.** Adding the findings to `knownFindings.json` is one line and turns the gate green. `knownFindings.json` currently holds **zero** contrast findings for any context except two `commit-panel` entries under `dark-modern-*`; Round 4 refused the same shortcut for a 1.5:1 finding. Recording below-floor code text as accepted, in a brand-new user-facing surface, through the very tripwire that caught it, is the "acceptable for now" the standing rules forbid.

**The merge editor is not a counter-example, and this is worth recording.** `merge-editor` shows `contrast=0` in every project, which reads like proof that a 15% wash is fine. It is not. Merge applies its wash **row-scoped to `.real-code-line::before`** (`merge-editor.css:749-782`), and `collectOracleInputs.ts:357-365` walks `getComputedStyle(element).backgroundColor` up the **element** chain — it never passes a pseudo-element argument. Merge's wash is invisible to the oracle, so its clean slice measures nothing. Porting the wash onto a `::before` would have greened this gate too, by inheriting the blind spot rather than by being legible. Rejected for that reason. Widening the collector to sample pseudo-element backgrounds would turn the merge editor's own baseline red across eight projects and is a harness change no phase-1 slice can carry; it is logged here as the next owner's problem, not fixed.

**What ships instead — the marker moves off the text.**

- **Changed blocks** carry an inset edge bar, `box-shadow: inset 3px 0 0 <hue>`, in each pane's own colour. An inset shadow paints inside the block's own border box, so the bar costs the code no width and the gutter no room, and it lands on no glyph: code rows start 9px in (`.code-line` padding) and the gutter's digits are right-aligned about 20px in. Contrast is untouched because nothing moved behind any text.
- **The empty counterpart** of a one-sided hunk is painted with nothing at all. It was first given a real 15% wash, on the reasoning that it is the one block that can afford one because it holds no code. That reasoning was wrong about the block, not about the wash: each pane is sized from its **own** line count (`lineCount={item.paneLines[side]}`), so the counterpart of a one-sided hunk is zero rows and measures **zero pixels tall** — a background there is a rule that can never render. Measured on the live page, not argued: `.diff-segment-empty` reports `height: 0` in both panes. The rule and its `--diff-empty-block-bg` alias were deleted, and `diff-viewer.integration.test.tsx` now pins the zero height so a later switch to filler rows fails there instead of quietly producing a blank band.
- **Changed word fragments** are underlined rather than tinted, beside the glyphs instead of behind them. Only a two-sided hunk renders these spans at all: `WordDiffLine` returns a plain highlighted line when the compared line is empty (`segments.tsx:158`), so `diff-segment-modified` is the only state that can carry them.
- **The connector ribbon** now fills from `--diff-info`, the semantic hue itself, instead of from `--diff-pycharm-modified`. Drawing a ribbon from a near-background word-fragment wash and then applying `opacity: 0.18` erased it twice over; that double-erasure is half of what F1 reported as "no visible ribbons".

`PLAN.md` is the authority for whether this is a deviation, and it is not. Phase 1 is steps 2.1–2.6, which specify segments, the React app, the bundle entry, the panel, the protocol, l10n and the gates — and **no colour treatment at all**. The Goal line names "side-by-side panes, center line-number gutters, Bézier connector ribbons, Shiki highlighting"; block washes are not in it. `PLAN.md:35-36` — Approach item **4**, which is **Phase 3** — explicitly defers "Sweep remaining diff color tokens where merge editor and viewer diverge" as step 4.1. So the marker design is an implementation choice inside P1, the 4.5 floor is a hard gate, and the divergence this creates is already scheduled. No `HALT: needs-human` was warranted.

The plan's numbering is off by one between its list index and its phase name — item 1 is Phase 0, so item 4 is Phase 3 — and the shadow verifier tripped on exactly that, filing a correction that "4.1 is Phase 4". Re-derived at root from `PLAN.md:35`, which reads `4. **Phase 3 — cleanup and docs.**`: the original citation was right and the correction is **rejected**. The citation above now names the line numbers rather than the step number alone, because a reference that a careful reader misreads is a reference worth disambiguating even when it was correct.

**Layering cleaned up as a consequence, not as a flourish.** The `.diff-segment-*` rules are viewer-only — `changeClass` lives in `DiffViewerApp`, while merge paints through `.variant-insertion .conflict-ours` and friends — so they moved out of the shared `diff-core.css` into `diff-viewer.css`, along with `.diff-pane + .diff-pane`. That makes "the merge editor cannot move" true by construction rather than by argument. `diff-core.css` keeps exactly one paint alias, `--diff-pycharm-modified: var(--pycharm-modified, transparent)`: merge's own declaration wins its first leg and its fragment tint is byte-identical, while the viewer inherits `transparent` and underlines instead. The six aliases that lost their last reader — the conflict pair and the three block washes — were deleted rather than left declared.

**The `wordDiff` relocation is a pure move, and the two comments that named the wrong surface moved with it.** `src/mergeEditor/wordDiff.ts` is deleted and `src/diff/wordDiff.ts` added; `diff -u` against `BASE:src/mergeEditor/wordDiff.ts` reports exactly **two changed lines, both comments** — "for the merge editor" became "for pane-neutral diff surfaces", and "in conflict hunks" became "in diff and merge views". Zero executable lines differ. A file relocated to a neutral home whose header still says it belongs to the surface it left is a comment that will mislead the next reader into putting merge logic back into it, so the rewording is part of the move rather than a flourish on top of it.

**A sixth defect, found by reading the round's own output: the fixture never rendered an insertion.**

The four findings above were the verifier's. This one was not reported by anyone. After the first recording run the new `dark-modern-wide` PNG was opened and its pixels sampled directly, because "the marker design is legible" is a claim about rendering and nothing in the suite asserts rendering. The left pane's bars were there — `#9d9d9d` for the deleted block, `#11a8cd` for the modified one, three pixels wide. The right pane had a single continuous `#11a8cd` bar spanning **seven** rows, where the fixture is supposed to hold four inserted rows followed by three modified ones.

Probing the live page for computed styles gave the reason. The recorded fixture carried five segments, not six: its insertion-only rows sat directly against its two-sided hunk with no common line between them, and `computeDiffSegments` has no reason to split adjacent changed rows, so it emitted **one** `changed` segment whose left side was the modified rows and whose right side was the added rows followed by the modified ones. Both sides non-empty, so both panes classified `diff-segment-modified`. **`diff-segment-inserted` rendered nowhere, in any project, and `--diff-ok` was painted by nothing.** The recorder's own comment asserted the opposite — "the deletion-only hunk precedes the insertion-only one, so the taller pane changes sides" — which is what the fixture was designed to do and not what it did.

Nothing could have caught it. The pixel baselines recorded the missing state as the expected picture. The live-page oracles measured what was on screen, which was internally consistent and merely incomplete. The palette unit tests assert the CSS, and the CSS was correct — the rule existed, matched nothing, and passed. This is the same failure shape as F1 one layer up: a fixture that cannot reach a state makes every gate over that state vacuous.

Fixed by giving the two hunks a two-row common separator, which splits them: the recorded fixture is now seven segments, `changed L3/R0` and `changed L0/R4` on opposite panes with `changed L3/R3` after them. Verified at the rendering layer rather than in the JSON — computed `box-shadow` per block, live page, `dark-modern-wide`:

| Block | Pane | Height | Painted |
| --- | --- | --- | --- |
| `diff-segment-deleted` | left | 60px | `rgb(157,157,157)` = `--diff-muted` |
| `diff-segment-inserted` | right | 80px | `rgb(137,209,133)` = `--diff-ok` |
| `diff-segment-modified` | both | 60px | `rgb(17,168,205)` = `--diff-info` |
| `diff-segment-empty` | one per pane | **0px** | `none`, no background |

`--diff-ok` had never been painted before this fix.

The gate against a recurrence is `tests/unit/visual/diffViewerFixtureCoverage.test.ts`, and it reads the fixture **the harness actually mounts** (via `HOST_CONTEXT_FIXTURES["diff-viewer"]`) rather than a payload built inside the test — a synthetic input would classify correctly while the recorded one stayed broken, which is exactly the state the tree was already in. It asserts two-way set equality against `SEGMENT_MARKERS`, and separately that the deletion marker lands on the left pane and the insertion marker on the right: the set alone cannot see a classifier whose two arms are swapped, and a swapped classifier paints insertions in the deletion hue forever (MT17). The classification itself moved out of the React tree into `src/webviews/react/diff-viewer/segmentMarkers.ts` so a plain unit test can run a recorded payload through the production function instead of re-deriving it — a recorder that hand-copies production hides its drift.

**Round 4's entry-condition 2 is re-discharged in a stronger form.** That condition ("five dead aliases") was discharged in Round 4 by naming each alias and its reader in prose, and three of those five aliases have now been deleted outright. Prose discharge is what let a dead declaration come back twice in this phase. It is now machine-checked: `diffCorePalette.test.ts` collects every `--diff-*` declaration across `diff-core.css`, `diff-viewer.css` and `merge-editor.css`, collects every `var(--diff-*)` reader across the same three, and asserts the difference is empty. A colour nobody paints with is an invitation to paint with it.

**Mutation table.** Eighteen mutations, each naming its own assertion, applied by copy and restored by copy — never `git checkout --`. Baseline `rc=0`, every mutation `RED`, restore `rc=0 failing=[]`.

| # | Mutation | Assertion that went red | Failure text |
| --- | --- | --- | --- |
| MT1 | a code-bearing state gets a block wash back | `paints no background under any changed-segment block` | `expected [ 'diff-segment-inserted' ] to deeply equal []` |
| MT2 | the modified state loses its edge bar | `marks every changed-segment state that renders a row` | `expected [ 'diff-segment-deleted', …(1) ] to deeply equal [ 'diff-segment-deleted', …(2) ]` |
| MT3 | the zero-height counterpart grows an edge bar | `marks every changed-segment state that renders a row` | `expected [ 'diff-segment-deleted', …(3) ] to deeply equal [ 'diff-segment-deleted', …(2) ]` |
| MT4 | changed words lose their underline | `underlines changed word fragments instead of tinting them` | `expected null to be 'underline'` |
| MT5 | changed words are tinted behind the glyphs again | `underlines changed word fragments instead of tinting them` | `expected 'var(--diff-info)' to be null` |
| MT6 | the connector is filled from a near-background wash again | `fills the connector ribbon from a semantic hue, not a wash` | `.diff-ribbon fills with var(--diff-pycharm-modified) … expected false to be true` |
| MT7 | the fragment alias falls back to a colour, not `transparent` | `leaves the word-fragment tint transparent for a surface that never imports the merge palette` | `expected 'var(\n --pycharm-modified,…' to be 'var(--pycharm-modified, transparent)'` |
| MT8 | a `--diff-*` alias nothing reads | `declares no --diff-* alias that nothing reads` | `expected [ '--diff-unused-band' ] to deeply equal []` |
| MT9 | a block wash is re-declared **and wired to a live reader** | `forbids the aliases a read-only two-pane diff must not grow back` (and `paints no background…`) | `--diff-deleted-block-bg is back in diff-core.css … expected 'color-mix(in srgb, var(--diff-muted) …' to be null` |
| MT10 | F3: the sticky viewport cancels a percentage of its own **width** again | `diff viewer sticky viewport > cancels exactly its own height, in pixels rather than as a percentage` | `expected '\n position: sticky;\n top: 0;\…' to match /margin-bottom:\s*calc\([^)]*var\(--di…/` |
| MT11 | F4: the right pane's extents are read at the **left** pane's offset | `DiffViewerApp scroll viewport and ribbons > moves each ribbon side by its own pane's scroll offset` | `expected 70 to be 100` |
| MT12 | F4: the left ribbon side takes the **right** pane's height | `DiffViewerApp scroll viewport and ribbons > draws each ribbon side from that pane's own extent, never the canonical one` | `expected +0 to be 60` |
| MT13 | F2: a lone carriage return folded back into the `lf` bucket | `computeDiffSegments > records a lone carriage return as its own EOL style, not as a line feed` (and the mixed-EOL sibling) | `expected 'lf' to be 'cr'`; `expected 'lf' to be 'mixed'` |
| MT14 | high-contrast light falls through to the legacy dark branch | `detectTheme > returns light-plus for high-contrast light despite the legacy high-contrast class` | `expected 'dark-plus' to be 'light-plus'` |
| MT15 | the zero-height counterpart gets its 15% wash back | `paints no background under any changed-segment block` (and `marks every…`) | `expected [ 'diff-segment-empty' ] to deeply equal []` |
| MT16 | the recorded fixture's insertion-only hunk gains a left row and stops being one | `renders one block of every marker state the classifier can return` | `expected [ 'diff-segment-deleted', …(2) ] to deeply equal [ 'diff-segment-deleted', …(3) ]` |
| MT17 | the classifier's insertion and deletion arms are swapped | `puts the deletion marker on the left pane and the insertion marker on the right` | `expected { …(2) } to deeply equal { …(2) }` |
| MT18 | the empty counterpart is floored at one row, as filler rows would | `gives the counterpart of a one-sided hunk no rows and no intrinsic height` | `expected <span class="code-line-content"></span> to have a length of +0 but got 1` |

Three of these are worth reading twice.

MT9 re-declares a forbidden alias **and wires it to a live reader**. Re-declaring it and leaving it dead would fail the dead-declaration check instead, which would let someone conclude the forbidden-alias ratchet is only about tidiness; wiring it up means only the ratchet can fire.

MT3 and MT15 mutate the same state in the two opposite directions the deleted rule could return in — an edge bar and a wash — because a state styled with *nothing* is the one shape a one-directional mutation cannot distinguish from an oversight.

MT16 and MT17 are the pair that covers the fixture defect from both ends. MT16 breaks the fixture and leaves the classifier alone; MT17 breaks the classifier and leaves the fixture alone. MT17 is the reason the side assertion exists at all: with only the set assertion it survives green, every marker still present, one per pane, and insertions drawn in the deletion hue.

**Accept battery, final tree.**

`python3 ~/.claude/skills/claudex-build/verify.py gates --base <BASE_HEAD> --stage accept` on the tree below, after the recording run and after the baseline hashes were confirmed unchanged:

| Gate | Result | Wall |
| --- | --- | --- |
| typecheck | OK | 6.5s |
| lint-strict | OK | 13.8s |
| format-check | OK | 6.4s |
| architecture | OK | 1.0s |
| deps-knip | OK | 1.2s |
| tests | OK | 424.9s |
| visual-container | OK | 923.6s |

`GATES: GREEN warn=0`. The `tests` gate is the whole suite, not the touched files: **4159 passed / 4159, across 302 test files** in 423.40s. `visual-container` is the eight-project Playwright run in the container, `workers: 1`, `retries: 0`, `maxDiffPixels: 0` — it is the run that re-verified the 36 baselines against the committed tree rather than the recording run that wrote four of them.

Acceptance seal written after the gates, never before: `SEAL: WRITTEN files=68 green=True`. `.claudex-gates.json` is gitignored (`.gitignore:182`) and was not staged, force-added, or otherwise brought into the commit.

**Pixel baselines.**

The four `diff-viewer` PNGs were deleted before every recording run in this round — twice, because the first recording was made before the fixture defect above was found and encoded a picture with no insertion marker in it. Deleting rather than re-recording over them is the point: `PLAN.md:51` says a baseline must never be re-recorded to green a regression, and a baseline recorded from a defective build is a regression already pinned.

Both recordings ran in the container (`bun run test:visual:container`), never bare and never with `--update-snapshots`. Playwright writes a missing snapshot on its own and fails only that test, so a recording run is distinguishable from a verification run by its failure list rather than by a flag.

| Run | Result | Failures |
| --- | --- | --- |
| 1 (pre-fixture-fix, discarded) | 367 passed, 5 failed, 19.7m | 4 × `A snapshot doesn't exist … writing actual`; 1 × `de` `dark-modern-narrow` localeSweep settle timeout |
| 2 (recording) | 368 passed, 4 failed, 15.1m | 4 × `A snapshot doesn't exist … writing actual`, and nothing else |

Run 1's fifth failure was `harnessPage.ts:155 waitForRootSubtreeToSettle` — `fixture render did not settle under "#root" within 3000ms` — in one of 24 `diff-viewer` localeSweep cells, with the other 23 and all 8 `nonPixelOracles` cells green. A settle timeout is the signature of an unbounded animation loop, so `scheduleVerticalFrame` was read before drawing any conclusion: it is idempotent (`if (verticalFrameRef.current) return;`) and cannot self-perpetuate. It did not recur in run 2 or in the accept battery's own container run. **Called as flake, on two clean subsequent runs and one inspected mechanism — not as a diagnosis.**

**The 32 container-recorded baselines that already existed did not move.** SHA-256 of every PNG was snapshotted immediately before run 2 and again after: `TRACKED 32 BYTE-IDENTICAL`, and `git status tests/visual/__screenshots__` lists exactly four paths, all `??`. No existing baseline was rewritten by any run in this round.

**The recorded picture was verified, not assumed.** The reason this round found a sixth defect is that the PNG was decoded and sampled rather than trusted, so the same check is recorded here for the committed baseline. Columns one pixel inside each pane's content box, `dark-modern-wide`:

| Column | Span | Colour | Marker |
| --- | --- | --- | --- |
| x=1 (left pane) | y 149–208 | `#839ea5` (`--diff-muted` under the 0.18 ribbon) | deleted, 3 rows |
| x=1 | y 309–368 | `#10a7cd` (`--diff-info`) | modified, 3 rows |
| x=595 (right pane) | y 209–288 | `#89d185` (`--diff-ok`) | inserted, 4 rows |
| x=595 | y 329–388 | `#11a8cd` (`--diff-info`) | modified, 3 rows |

Every other pixel in both columns is `#1f1f1f`, the editor background, or the ribbon's `#1c373e` tint over it. The bars are three pixels wide and land on no glyph.

**Shadow re-check.**

The same verifier that raised the five findings was re-sent the tree for one re-check, with the takeover disclosed up front: **every byte of Rounds 4 and 5 is root-written, no Codex session ran, no model or effort was swapped, and nothing — including the tests that prove the fix — was seen by a second author before this re-check.** That disclosure is the reason the re-check was asked to re-derive from the artifact rather than to grade the dispositions.

Verdict: **CLEAR TO COMMIT — all six findings CLOSED, nothing OPEN.**

| # | Verdict | How the verifier proved it, independently |
| --- | --- | --- |
| F1 | CLOSED | The three hue aliases now terminate in literals (`diff-core.css:7,15,16`); it wrote its own dependency-free PNG decoder and column-scanned all four baselines, finding three correctly-sided 3px inset bars — left deleted `#839ea5`, left modified `#10a7cd`, right inserted `#73c992` — and de-compositing the green against the 0.18 ribbon returned `rgb(137,209,133)`, matching the root's live-page measurement |
| F2 | CLOSED | Its own mutation, two named reds |
| F3 | CLOSED | Two mutations, two distinct named reds |
| F4 | CLOSED | Two mutations, two named reds |
| F5 | CLOSED | One named red, both directions gated |
| F6 (root-found) | CLOSED | Its own reproduction of the original defect — remove the common separators so the one-sided hunks fuse — turned the new coverage gate red on **both** its assertions |

**The contrast arithmetic was recomputed rather than accepted.** The verifier derived `#098658` on white at **4.603:1**, headroom **0.103**, and ran the wash ladder itself: charts-green at 4/8/15/30% gives 4.38 / 4.19 / 3.82 / 3.15, ansiCyan gives 4.40 / 4.21 / 3.87 / 3.24. Its 4% figures reproduce the measured 4.3–4.4 independently. Its conclusion: there is no legal visible wash, so the edge-bar treatment is a forced move and not a scope liberty. The scope judgement was attacked and upheld.

**Its own mutation pass: 11 mutations across 6 files, every one red by name, every one restored byte-exact and sha256-verified.** Two are worth recording. One reproduced the sixth defect from scratch and confirmed the new gate catches it. The other confirmed the root's MT17 claim precisely — swapping the classifier's arms fails **only** the directional assertion while set-equality stays green — which is the evidence that the directional assertion, not the set, is the load-bearing one.

**Baselines re-verified against the base blobs, not against the root's report:** 36 PNGs on disk, 32 tracked at base, **all 32 byte-identical, 0 modified, exactly 4 untracked**. `PLAN.md:51` satisfied. State gate at the end of its run: `HEAD` still reading the BASE_HEAD value, 68 paths (47 M, 20 ??, 1 D — the `wordDiff` move), `SEAL: INTACT files=68 warns_open=0`, nothing committed, staged, pushed or stashed, `bun run test:visual` never invoked, nothing written into `tests/visual/__screenshots__/`.

**One advisory, accepted and recorded rather than fixed.** The verifier judged the flake call thinner than it was framed, and it is right: "`scheduleVerticalFrame` is idempotent" rules out a runaway animation loop, not a genuinely slow settle, and `de` in the narrowest viewport is precisely where reflow cost peaks. Two clean reruns cannot separate a flake from a threshold set too close to normal. The discriminator is cheap and is logged here for whoever sees it next: **log that cell's actual settle time on a passing run — if it habitually lands near 2.4s against the 3000ms bound, the bound is too tight and the diagnosis is a bad threshold, not a flake.** Not a P1 regression: `waitForRootSubtreeToSettle` is a harness timeout, not an assertion about the viewer, and it fires in a spec the viewer's own gates do not depend on. No code change in this phase.

**Two method warnings from the verifier, recorded because both nearly produced a wrong finding.** `git grep` skips untracked files, and most of this phase is untracked — it reported `--diff-viewport-h` and `diff-segment-empty` as absent everywhere until `--untracked` was added, one step short of a fabricated finding. And mutation restores rewrite mtimes: it built a timeline theory on four files' timestamps before realising the timestamps were its own restores. **File timestamps in this worktree are not evidence.** Content was byte-exact throughout.

One correction the verifier filed was **rejected at root** — its claim that the plan's step 4.1 belongs to Phase 4. `PLAN.md:35` reads `4. **Phase 3 — cleanup and docs.**`; the citation was correct and is now written with line numbers so the list-index/phase-name offset cannot mislead the next reader. Accepting a reviewer's correction without re-deriving it is the same failure as accepting a builder's green.

**Phase 0's six entry conditions, re-discharged against the tree actually committed.** Round 4 discharged them against a tree that no longer exists, so each is restated here against the final bytes. (1) The typography contract holds — `diff-core.css` still drives every code row from `--diff-code-font-size`, and no `.diff-viewer` rule overrides it. (2) The alias condition is now **machine-checked instead of argued**: `diffCorePalette.test.ts` collects every `--diff-*` declaration and every `var(--diff-*)` reader across `diff-core.css`, `diff-viewer.css` and `merge-editor.css` and asserts the difference is empty in both directions — and three of the five aliases Round 4 discharged in prose are simply gone, deleted rather than left declared, so the condition is now discharged by absence for those three and by a live reader for the rest. (3) `--diff-viewer-action-gutter: 0px` is declared (`diff-core.css:20`) and read at `:53`. (4) The residue condition stays discharged by deletion. (5) Scroll-sync fallback coverage is unchanged and green. (6) `wordDiff` sits in the neutral `src/diff/`, proven a pure move above.

**HEAD gate.** `git rev-parse HEAD` read the BASE_HEAD value unchanged at the end of every round, including all three root-written ones, and once more immediately before this commit. Codex never committed, staged, or moved HEAD, and neither did any verifier lane.

Root verdict: **P1 ACCEPTED** — this section supersedes Round 4's identical verdict, which was reached before the shadow run and was wrong.

---

### P2a — mode switch: phase-lane → classic in-root

Two P2a phase-lanes were killed by the harness stream watchdog (`no progress for 600s`), both while blocking on their Codex background task rather than while doing anything wrong. Lane 1's Codex session died with it: SID `01a0235a`, launched 09:05, 13 token events, still in its read phase (its last three actions are `ctx_read` calls on `diffService.ts`, `lineDiff.ts`, `shelfDiffActions.ts`), empty `-o` report, **zero files written**. Lane 2 relaunched and its Codex session — SID `01a02390`, 10:04 → 10:51, 47 minutes, 135 token events, 4.1 MB rollout — wrote the full deliverable set before the lane's death killed it mid-verification: its last recorded action is a format check, its `-o` report is empty, and it never produced the numbered DONE/NOT-DONE report the work order required. A third session overlapping that window, SID `01a02394` at 10:08–10:16, was the ChatGPT desktop app running in the **main** repository (`cwd` is the main checkout, tool set is `share_thread`/`plugin_management`/`open_in_codex`), not a second writer here — single-writer discipline held, and the tree has exactly one author.

P2a therefore runs **classic in-root**: the conductor is the acting phase-root, which the skill's own mode selection allows and which the harness cannot kill the same way. The lesson for the remaining phases is in the lane prompt, not the mode: a lane must not block silently past the watchdog window, so P2b/P2c/P3 lane prompts carry an explicit cadence instruction (bounded waits that return inside the window) rather than a single open-ended blocking wait.

### P2a — Round 1 — Codex build (gpt-5.6-luna/xhigh)

SID: `01a02390-481f-76a1-ae24-5d79dba4acac` (orphaned; no self-report — see the mode-switch note above)

Telemetry: `PEAK=243003 LAST=208211 PCT=94% EVENTS=135`, computed from the session rollout because the lane's `$STREAM` and `-o` files did not survive it. `NONRESUMABLE=yes` under the peak rule — irrelevant to routing, since every round is fresh, but this is the **third phase running to overshoot the 45–50% sizing target**, and splitting spec Phase 2 into P2a/P2b/P2c did not prevent it. The work order, not the phase count, is what is oversized: three independent deliverables (funnel, loader, measurement corpus) in one session.

Round gates on the orphaned tree: `verify.py gates --base 5f04b226 --stage round` → `GATES: GREEN warn=0` (typecheck 7.2s, lint-strict 15.1s). Focused: 28/28 pass across the three new unit files (339 ms).

Landed: 927 new lines across `src/diff/unifiedDiffTypes.ts`, `src/diff/sideLoader.ts`, `src/diff/diffBudgets.ts`, `src/diff/diffViewerOpener.ts`, `scripts/measure-diff-budgets.ts` and three new test files, plus the `openUnifiedDiff` funnel and `resolveDiffViewerSetting` in `src/services/diffService.ts`, the `intelligit.diffViewer` configuration contribution in `package.json`, the `isMissingGitPathError` export in `src/git/operations.ts`, a knip entry, the l10n round-trip across twelve catalogs, and a viewer tier case appended to `tests/integration/webviews/merge-editor-performance.integration.test.tsx`.

**Root review — seven findings, none CRITICAL, all filed as defects in written code rather than as absent deliverables** (every deliverable exists in some form; each finding is a defect in one).

| # | Finding | Evidence |
| --- | --- | --- |
| 1 | Budget thresholds calibrated on unrepresentative fixtures | The corpus generates lines like `large-left-0` — **16.6 bytes/line** (41,389 B / 2,500 lines) against a measured **39.4 bytes/line** over this repo's 200 largest `.ts`/`.tsx` files. So `MAX_DIFF_BYTES = 82,778` binds at ~2,100 real lines, `MAX_DIFF_LINES = 5,000` is unreachable, and the "large tier accepts 2,500 lines" promise is false for real content (~98,500 B). Two of this repository's own files already exceed the cap: `CommitPanelViewProvider.ts` (103,835 B), `UndockedViewProvider.ts` (93,841 B). The corpus also diffs each side against a wholly different text, so every line differs — a worst case no real diff produces. |
| 2 | The heap assertion measures the garbage collector | Five identical runs of the large tier gave `heapDelta` = **0, 683623, 446941, 0, 504192**. `MAX_DIFF_HEAP_DELTA_BYTES = 1,355,568` is 2× one sample of that noise, a `0` sample passes vacuously, and `diffBudgets.test.ts` asserts it in the permanent suite. `--expose-gc` is documented in the script's header but the script never calls `gc()`. Compute time over the same samples spread 37–120 ms, so the 259 ms gate has thinner headroom than "2×" suggests. |
| 3 | Webview render time never measured or gated | `PLAN.md:3.3` names four targets; render time is absent and `diffBudgets.ts`'s doc comment claims "this phase has no permitted viewer browser harness". The premise is false — the file Codex itself extended, `merge-editor-performance.integration.test.tsx`, renders webview apps in jsdom and already gates the merge editor's render. |
| 4 | Worktree-side submodule has no path | `sideLoader.ts` `loadWorktree()` inspects `FileType.SymbolicLink` but never `Directory`, so a submodule entry reaches `workspace.fs.readFile`, throws, and propagates as an error instead of delegating to native — `PLAN.md:3.2` requires submodule → native delegate. The worktree-side symlink path is handled but untested; symlink and submodule are covered only on the Git-mode (ref) branch. |
| 5 | The descriptor's `title` is dead | `UnifiedDiffRequest.title` is specified at `PLAN.md:3.1` and carried by the type, but `openUnifiedDiff` never forwards it and `DiffViewerPanelOptions` has no title field, so every Phase-2c call site would pass a value that does nothing. |
| 6 | Extension URI resolved by hardcoded marketplace id | `diffViewerOpener.ts:8` calls `vscode.extensions.getExtension("MaheshKok.intelligit")` — the only such call in all of `src/`, against 39 sites that thread `context.extensionUri` from activation. The id is correct today (`package.json` publisher `MaheshKok`, name `intelligit`), so this is brittleness and untestability, not a live break. |
| 7 | Three decorative assertions | `expect(mocks.computeDiffSegments).not.toHaveBeenCalled()` cannot fail — `DiffViewerPanel`, its only caller, is mocked in that file (the adjacent `panelOpen` assertion is the real gate); `expect(3_500 * 3_500).toBeGreaterThan(MAX_DIFF_DP_CELLS)` compares two constants; `it.each(["added", "deleted"])` ignores its parameter, so both iterations run identical code. Also, the funnel is never tested with an `ineligible` side — only `over-budget` exercises that branch. |

Findings 1 and 2 are the load-bearing pair: the first makes the thresholds wrong for the inputs they will actually see, the second puts a garbage-collector measurement into the permanent suite as a gate. Both are the same failure shape — a number measured correctly against the wrong thing.

Root verdict: **REJECTED — fix round 1.**

### P2a — Round 2 — Codex fix 1 (gpt-5.6-luna/xhigh)

Route: `helpers.py route fix 1` → `EFFORT=xhigh MODE=fresh` (binding). SID(prev) `01a02390` → SID(fix1) `01a025b1-e401-7632-acbf-9a1d2dc57a44`. Standalone work order carrying the full delegated-writer receipt, all seven defects with file:line and a per-item check, and the GIT / CONSTRAINTS / NON-GOALS clauses verbatim — the fresh session has never seen the build prompt.

Round 2 verification — root, from the bytes rather than the report. All seven defects re-checked against the files themselves; Codex's own DONE list was treated as a claim throughout. Round gates: `verify.py gates --base 5f04b226 --stage round` → `GATES: GREEN warn=0` (typecheck 7.1s, lint-strict 15.0s). Focused tests **30/30** across the three unit files (249 ms), up from 28 in Round 1 — the two added cases are the ineligible funnel branch and the line-cap trip.

| # | Fix | Verified how |
| --- | --- | --- |
| 1 | Budgets recalibrated on real files | `scripts/measure-diff-budgets.ts:54-88` now diffs `wordDiff.ts`, `diffService.ts` and `CommitPanelViewProvider.ts` against a **2% line edit of themselves** (`modifiedCopy`), replacing the corpus that diffed each side against a wholly different text. `measureRealSourceBytesPerLine()` reports **40.1867 B/line** over the 200 largest `.ts`/`.tsx` under `src/`. Caps become `MAX_DIFF_BYTES = 210_094` (2 × the 105,047-byte large side) and `MAX_DIFF_LINES = 5_227` = `floor(210_094 / 40.1867)`. `CommitPanelViewProvider.ts` (103,835 B) — which the old cap rejected — is now the calibrating tier. |
| 2 | Heap no longer measures the collector | `scripts/measure-diff-budgets.ts:130-145`: `gc?.()` is now actually **called** on both sides, and `heapDeltaBytes` is `"unmeasured"` without `--expose-gc`. `tests/unit/diff/diffBudgets.test.ts` read end-to-end: **no `heapUsed` assertion of any kind remains**. |
| 3 | Render time measured and gated | `merge-editor-performance.integration.test.tsx:167-190` renders all three accepted tiers through the real `DiffViewerApp` in jsdom and asserts `MAX_DIFF_RENDER_MS`. The Round-1 premise for omitting it ("no permitted viewer browser harness") was false, and the fix uses exactly the harness in the file it had already edited. |
| 4 | Worktree submodule delegates | `src/diff/sideLoader.ts:197-199` returns `{status:"ineligible", reason:"submodule"}` for a `Directory`, **after** the `SymbolicLink` branch at :194 — the correct order, since a symlink to a directory carries both type bits. |
| 5 | `title` reaches the panel | Threaded `openUnifiedDiff` → `DiffViewerPanelOptions.title` → `DiffViewerSnapshot.title` → new `DiffViewerPanel.panelTitle()` (:171-177), which falls back to the pre-existing localized `Diff: {file}`. All three former inline `l10n.t` title sites now route through it. |
| 6 | Extension URI injected | `src/extension.ts:31` calls `setDiffViewerExtensionUri(context.extensionUri)` as the first statement of `activate`. Independently confirmed: `grep -rn getExtension src` returns only `vscode.git` in `RefreshService.ts:311` — a built-in that must resolve by id — and nothing for `MaheshKok.intelligit`. |
| 7 | Decorative assertions replaced | The constant-vs-constant `3_500 * 3_500 > MAX_DIFF_DP_CELLS` is gone, replaced by three real `exceedsDiffBudget` calls including one tripping the **line** cap alone (`diffBudgets.test.ts:86-91`) — previously unreachable. `it.each` at `unifiedDiffFunnel.test.ts:63-70` now consumes both parameters. The ineligible funnel branch is covered at :166. |

Two Round-1 concerns were re-examined and **not** raised again, both on evidence rather than deference:

- The new gates assert wall-clock time (`MAX_DIFF_COMPUTE_MS = 59`, `MAX_DIFF_RENDER_MS = 5_613`), the same machine-dependent shape as the heap defect just removed. Measured over five consecutive runs: compute test **25/25/25/25/26 ms** against a 59 ms cap, render test **4,725/4,314/4,512/4,499/4,666 ms** total across three tiers — a 9.5% spread against ~100% headroom. House precedent already asserts wall-clock ceilings in the permanent suite (`merge-parser-performance.test.ts:70,105` at 3,000 ms; `operations.test.ts:601,620` at 2,000 ms). Recorded as a slow-CI risk, not a defect.
- `getSideLabel` returns the raw English `"Working tree"` (`diffService.ts:222`) — a Round-1 miss. On inspection it is not a defect: the existing shipped viewer label path does the same (`shelfDiffActions.ts:24-25`, `BASE_LABEL = "Base (HEAD at shelve)"`, `SHELVED_LABEL = "Shelved"`), so localizing only this one would make the header inconsistent with itself. If these are ever localized it is one change across all of them, not this phase.

**Independent verifier (fresh `opus`, max effort) — 10 findings, triaged by root against the artifact. Seven accepted, three rejected.** The lane gathered evidence; the verdict stayed at root, and one rejection required running an experiment rather than reading the code.

| # | Verifier finding | Root verdict |
| --- | --- | --- |
| 1 | Two missing sides open a blank viewer instead of delegating | **ACCEPTED** — `toViewerSide` maps each `missing` to an empty side; `exceedsDiffBudget(empty, empty)` is false, so the pair reaches `openDiffViewer`. |
| 2 | No `try`/`catch` anywhere in `openUnifiedDiff`, so throws escape the funnel | **ACCEPTED — the load-bearing one.** `loadRef`, `readGitMode`, a provider `load`, and `loadWorktree`'s deliberate EACCES rethrow all propagate out, so the user gets *no* diff where the funnel's whole contract is that they get the native one. |
| 3 | The render gate's existence assertion is vacuous after loop iteration 1 | **REJECTED — disproved by experiment.** A throwaway probe dispatched a populated tier, then a second `setDiffData` carrying empty content: `.diff-pane .code-block` went **4 → 0**. React reconciles stale nodes away, so the assertion can still fail on later iterations. Reading the code would have left this ambiguous; only running it settled it. |
| 4 | Payload gate compares UTF-16 `.length` against a UTF-8 byte budget | **ACCEPTED** — budget derived with `Buffer.byteLength(…,"utf8")`, asserted with `.length`; agrees only for ASCII. |
| 5 | Budget test counts lines with `split("\n").length`, production uses `countLines()` | **ACCEPTED** — `sideLoader.ts:223-233` subtracts a trailing newline, so the permanent gate measures a counter no production path produces. The same off-by-one is visible in the doc table (289/626/2313 vs `wc -l` 288/625/2312). |
| 6 | `MAX_DIFF_LINES` is decorative because the DP cap binds first | **REJECTED** — three independent caps where the tightest binds is intended defense in depth, not a defect. |
| 7 | "29.468 ms in the focused Vitest gate" does not reproduce | **ACCEPTED** — root's own five runs measured 25–26 ms *total for all three tiers*, so no tier approaches 29.468 ms and the real headroom is ~4×, not the stated 2×. A doc that states an unreproducible derivation is the same defect class as Round-1 finding 1. |
| 8 | `2 × 2,806.205 rounded` = 5,612, but the constant is 5,613 | **ACCEPTED** (wording: it is a ceiling). |
| 9 | No production callers; fixes 5 and 6 are test-only | **REJECTED in the main** — wiring call sites is Phase 2c by spec. **Accepted in part**: `title` is never asserted against the *real* panel (the funnel test mocks `DiffViewerPanel`; `diffViewerPanel.test.ts:118` asserts only the fallback), so the one line making the field live is unproven. |
| 10 | The open-document branch precedes `stat`, so an open symlink loads as a normal file | **ACCEPTED** — identical input yields a different result depending only on whether an editor is open. |

Root verdict: **REJECTED — fix round 2.** Seven accepted defects, five of which are the same underlying mistake: an exit path that leaves the user with no diff or a blank one, where the funnel's contract requires the native editor. That framing leads the work order rather than the individual items.

### P2a — Round 3 — Codex fix 2 (gpt-5.6-luna/xhigh)

Route: `helpers.py route fix 2` → `EFFORT=xhigh MODE=fresh` (binding). SID(prev) `01a025b1` → SID(fix2) `01a025d9-3349-7ce3-be38-8807328630d7`. This is the last Codex round the ladder allows; a further rejection is a Claude takeover, not a third fix round.

The work order carries a **DO NOT "FIX" THESE** block naming the three rejected findings with the evidence that cleared each — including the 4 → 0 probe result — because a fresh session that re-derives them from scratch would otherwise "helpfully" rewrite correct code. Round 1's WRITER MODE cited a skill path that did not exist on the host (Codex silently substituted `subagent-tdd-workflow`); that citation is replaced with the requirement stated inline.

Telemetry: `PEAK=226981 LAST=226981 PCT=87% NONRESUMABLE=yes`. Nothing in this skill resumes, so that flag does not route anything — but 87% against a 45–50% sizing target is the phase-too-big signal, on a *fix* round carrying only a defect list. P2a was sized as one package and should have been two. **P2b, P2c and P3 get sliced tighter before launch, not after the session bloats.**

Codex returned all seven ACCEPTED findings as DONE. Root re-verified each against the bytes rather than the report:

| # | Fix | Verified how |
| --- | --- | --- |
| 1 | Both-missing delegates | `diffService.ts` computes `bothMissing` from the two `LoadableDiffSide` results and delegates; one missing side still opens the viewer with empty text (`unifiedDiffFunnel.test.ts:144-170` covers both directions). |
| 2 | Resolve errors log and delegate | The whole side-resolution is wrapped; the `catch` calls `logGitOpsWarning("diffService.openUnifiedDiff.resolve", error)` then `nativeDelegate()`. Three tests cover left-rejects, right-rejects, and provider-rejects. |
| 3 | Payload gate uses UTF-8 bytes | `Buffer.byteLength(…, "utf8")` on both the derivation and the assertion side. |
| 4 | Budget test uses production `countLines` | `countLines` exported from `sideLoader.ts:223-233` and imported by the budget test; the doc table corrected to the production convention (288/655/2312). |
| 5 | `title` asserted against the real panel | `diffViewerPanel.test.ts:125-141` asserts the explicit title on both create and reveal; Codex reports its own mutation went red. |
| 6 | Compute ceiling re-derived from measurement | Five real samples logged in the doc block (15.939 / 16.141 / 15.514 / 16.123 / 16.591 ms) with `MAX_DIFF_COMPUTE_MS = ceil(3.5 × 16.591) = 59`. The unreproducible 29.468 ms claim is gone. |
| 7 | Stat precedes the dirty-buffer branch | `loadWorktree` now stats first — symlink at :183, directory → `ineligible: "submodule"` at :186 — and only then prefers an open dirty document, so an open editor can no longer change the classification of the same path. |

#### Root takeover — beyond the fix list

Accepting the seven fixes is not the same as accepting the diff. Two things were changed at root after review:

**Collapsed five sequential guards into one.** The fix left five separate `if (…) { await nativeDelegate(); return; }` blocks in a row, two of which were unreachable (a side that resolved to `undefined` was already caught by the clause above it). Collapsed to a single condition with a comment naming every outcome it covers.

**The collapse then had to be proven, and the proof found a real hole.** Mutating each surviving clause away one at a time (`mutate-funnel.py`, restores byte-exact and verifies by sha256):

| Mutation | Expected red | Result |
| --- | --- | --- |
| drop `bothMissing` | both sides confirmed missing | RED, named |
| drop `overBudget` | *(initially nothing)* | **GREEN — the hole** |
| drop the unresolved-side check | ineligible side | RED, named (3 tests) |

`overBudget` came back **green**: removing the pair-level budget check from the funnel broke no test at all. The two existing "over-budget" tests trip the side loader's own per-side byte cap and are caught by the unresolved-side clause instead, so `exceedsDiffBudget` — the line cap and DP-cell cap this phase spent two rounds calibrating — was enforced by a call **no test proved did anything**. Reading the code cannot see this; a green suite actively hides it. Only the mutation exposed it.

Two isolating tests close it, each sized so exactly one cap can be the reason to delegate: `ceil(sqrt(MAX_DIFF_DP_CELLS)) + 1` lines a side for the cell cap (both sides far under the byte cap), and `MAX_DIFF_LINES + 1` lines against a single-line side for the line cap (cell count far under the DP cap). Both derive their fixtures **from the constants** rather than hardcoding, so a future re-calibration cannot silently stop exercising the branch. Re-run: `drop overBudget` now turns both new tests red by name.

That derivation also resolved the one accept-gate failure. `deps-knip` reported `Unused exports (1) MAX_DIFF_DP_CELLS src/diff/diffBudgets.ts:51:14` — the constant lost its only external consumer when Round 2 correctly deleted the decorative `3_500 * 3_500 > MAX_DIFF_DP_CELLS` assertion. Importing it into the test that actually exercises the cap restores the consumer honestly, rather than silencing knip with a config exemption.

#### Final verifier (fresh `opus`, takeover exception) — 3 findings, all MINOR

Root may not self-certify takeover bytes, so the collapsed guard and the two new tests went to a fresh verifier told not to re-run any gate. It cleared both takeover claims **independently, rather than by inspecting root's reasoning**: it enumerated `loadDiffSide`'s full result space (`loaded | missing | over-budget | ineligible`) against the collapsed condition and found no input where one version delegates and the other opens, and it re-implemented `countLines`/`exceedsDiffBudget` from the bytes as a numeric oracle to confirm each new test trips exactly one cap.

| test | bytes/side (cap 210,094) | lines (cap 5,226) | cells (cap 9,000,000) | predicate true |
| --- | --- | --- | --- | --- |
| DP-cell | 6,002 | 3,001 | 9,006,001 | `dpCells` only |
| line-budget | 10,456 / 6 | 5,228 / 1 | 5,228 | `leftLines` only |

| # | Finding | Root verdict |
| --- | --- | --- |
| F1 | `diffBudgets.ts` corpus row for `diffService.ts` is stale — documented 24,199 B / 655 lines, actual 24,055 / 642 | **ACCEPTED — self-inflicted.** The guard collapse removed 13 lines from a file that is itself a corpus row. Same class root accepted as Round-2 finding 7, now applied to root's own bytes. |
| F2 | `openDiffViewer` sits outside the `try`, so the open phase can throw past the "never strand the user" contract | **REJECTED for P2a, carried to P2c.** The verifier enumerated every reachable throw site and found **none** in production: the extension URI is set as the first statement of `activate`, `assertRepoRelativePath` already ran on the same input inside the try, and the whole compute chain (`diffSegments.ts`, `wordDiff.ts`, `lineDiff.ts`) contains zero `throw` statements — the `MAX_LCS_CELLS` boundary degrades to `greedyMonotonicLineMatch` instead of throwing. With no reachable input, no test can go red without the change, so adding the catch now would be untestable speculative code. It becomes real in P2c, when actual callers make the error surface concrete. |
| F3 | The integration test re-asserts the compute and payload caps under jsdom, where they were calibrated in node | **ACCEPTED.** Confirmed a strict subset of `diffBudgets.test.ts` — same three files, same two assertions, minus `exceedsDiffBudget` — and it renders nothing, so the jsdom placement buys no coverage while adding a flake surface. Deleted; jsdom performance stays gated by the render test, at the layer that actually needs jsdom. |

**F1's fix surfaced a second-order defect the finding did not name.** Re-running the measurement to correct one row moved `realSourceBytesPerLine` from 40.18865773302732 to **40.1942478007168** — because that figure is measured over this repository's own 200 largest source files, and the guard collapse edited one of them. The published formula `floor(210,094 / ratio) = 5,227` therefore no longer produced its own stated output; the correct floor is **5,226**. `MAX_DIFF_LINES` moved accordingly, and the doc now states that the corpus rows and the ratio are pinned to the recorded run rather than to current HEAD, with the rule that re-derivation restates the *whole* table from one run — a table mixing figures from two runs is not reproducible.

This is a self-invalidating calibration: any future commit touching `src/` shifts the ratio again. Pinning it to a stated run is what makes the doc durable; chasing the last digit on every edit would be a treadmill.

Every other threshold is **unchanged, and verified so rather than assumed**: all of them derive from the large tier, which re-measured byte-identical (103,835 / 105,047 bytes, 2,312 / 2,312 lines, 5,345,344 cells, 219,524 payload). The five-run Vitest compute series behind `MAX_DIFF_COMPUTE_MS` is also large-tier, so it survives untouched.

#### P2a — Round 4 — user scope correction (no Codex round)

The user reviewed the phase before it was committed and challenged the `intelligit.diffViewer` setting: _"why are we giving options to user to choose which diff viewer they want to use ... if they click on any files from our extension they should see only our diff viewer"_. The setting was not invented by the build — it is in the frozen plan twice (§3.1 and Key decision 2) and survived the grill plus five Codex review rounds. The user is nonetheless the one who owns it, and on inspection **half of its stated justification was already false**: Key decision 2 defended the setting as "the escape hatch and keeps the native path tested", but `nativeDelegate` is mandatory regardless — §3.2 requires binary, invalid-UTF-8, symlink, submodule, and over-budget sides to fall back — so the native path stays live and tested with or without a user setting. Only the escape-hatch half was real, and it was speculative.

Decision: **drop the setting.** Removed before commit rather than after, since P2c wires six call sites and the deletion only gets more expensive.

| Removed | How |
| --- | --- |
| `package.json` configuration contribution | `git checkout HEAD --` on 14 config/l10n files, after verifying with a filtered diff that every changed line in them was setting-related (the only non-`diffViewer` lines were trailing commas on the preceding key). |
| 3 keys × 12 locale catalogs, 3 CSV review rows | same revert |
| `resolveDiffViewerSetting` + the setting branch in `openUnifiedDiff` | direct edit; the doc comment now states that `nativeDelegate` is for unrenderable content, not preference |
| 6 tests (4 `it.each` resolver cases, the native-branch test, the manifest contribution test) and the `getConfiguration` mock | direct edit; funnel suite 17 → 11 tests |

`src/views/DiffViewerPanel.ts:92` still contains the string `"intelligit.diffViewer"` — that is the webview **viewType id** passed to `createWebviewPanel`, unrelated to the setting, and correctly retained.

Re-verified after removal: focused suites **35/35** across 4 files, `typecheck` / `lint:strict` (0 warnings) / `format:check` / `knip` all clean, and the three-clause guard mutation re-run — every clause still turns a **named** test red, source restored byte-exact (`44008960618f`). `PLAN.md` §3.1, §3.8, the Goal paragraph, and Key decision 2 were amended so P2c cannot re-introduce the setting from a stale spec.

#### Scope change raised — blocks P2b

The same review turned up a second, larger item: the user expects the **2-pane viewer itself to have an editable mode**. The frozen plan puts an editable right pane explicitly out of scope, so "editable" has meant only the existing 3-pane merge editor throughout.

This is not absorbed silently. It is recorded in `PLAN.md` under **Pending scope change — BLOCKS Phase 2b**, because §3.5's session model rests on "resolved immutable side snapshots" that `setIgnoreMode` recomputation reuses without reloading providers. An editable pane breaks that premise outright — dirty state, a write-back protocol direction, save/undo semantics, external-change conflicts, and a different answer for what a generation-bound refresh does to unsaved edits. Building 2b on frozen snapshots and retrofitting editability means rewriting 2b.

P2a is unaffected either way: the funnel, side loader, and budgets are identical whether or not the viewer later becomes editable. So P2a commits, and the build **stops there** pending a `claudex-grill` round on editable mode.

#### P2a — accepted, commit `0399aea9`

Accept-stage battery over the final bytes: **10/10 gates GREEN, `warn=0`, `GATES_RC=0`** (`typecheck` 7.4s, `lint-strict` 14.4s, `format-check` 6.5s, `architecture` 1.0s, `deps-knip` 1.2s, `l10n-validate` 0.1s, `l10n-audit` 0.4s, `package-vsix` 2.5s, `tests` 434.8s, `visual-container` 1015.5s). Commit `0399aea9`, 17 files, +1576/-11, tree clean afterwards.

Two notes on what the commit contains beyond the funnel itself, both read at root from the diff rather than taken from a report:

- `src/git/operations.ts` widens `isMissingGitPathError` from module-private to exported, so the side loader classifies an absent path instead of re-implementing the message matching. One-word diff, no behaviour change.
- `src/views/DiffViewerPanel.ts` gains an optional `title`, and the triplicated `vscode.l10n.t("Diff: {file}", …)` expression collapses into one `panelTitle()` helper used by all three call sites (create, reveal, shell HTML). `tests/unit/views/diffViewerPanel.test.ts` covers both the create and the reveal path, which matters because the reveal path is the one a second open takes.

`knip.jsonc` gained `scripts/measure-diff-budgets.ts` under `entry` — correct, since the measurement script is a hand-run graph root that nothing imports, and an `entry` states that rather than suppressing a finding the way an ignore would. A comment was added at root before commit because the line sat under a comment about negative typecheck fixtures and read as part of that group. `format:check` and strict `knip` re-run green after that edit; the remaining eight gates are untouched by a comment inside a JSONC config and were **not** re-run.

`.githooks` does not exist in this worktree, so the repo's pre-commit hook silently no-ops here (a worktree's `.git` is a pointer). The gate battery above is the actual gate, not the hook.

#### Scope change resolved — Phases 4 and 5 added

The user answered the surface question with the full table in hand. Decisions:

1. **Editable panes on every surface that has one** — rows 1, 2, 4, 5b. Rows 3 and 5a stay read-only because both of their sides are immutable history.
2. **External change while dirty behaves like a normal editor** — inherited, not implemented.

The load-bearing discovery that shaped the design, found by reading the call sites rather than the plan: the user's own PyCharm reference case (stash → file → edit the local side) is **read-only on both sides in IntelliGit today**, and would be even with the native editor, because `prepareStashLocalDiffSnapshot` (panelFileActions.ts:185) and `readLocalSnapshot` (shelfDiffActions.ts:124) wrap the file's text in `createReadonlyDiffUri`. The local side is a photocopy. So rows 4 and 5b are a **new capability, not a preserved one**, and the framing of "keep what native gave us" would have missed it entirely.

Second consequence, recorded because it changes a frozen decision: write-through as specified is `CustomTextEditorProvider`, which is bound to one resource with a VS Code-managed lifecycle, and therefore cannot also be Key decision 4's single reusable panel with swapped content. Phase 4.3 narrows decision 4 to the read-only surfaces and gives working-tree surfaces a per-file custom editor — which is also what PyCharm does. **That narrowing needs explicit user confirmation before Phase 4 builds**; it is flagged in the plan rather than assumed.

Third, and the reason the editable-side test is parameterized: the editable side is **not a fixed pane index**. It is the left pane in row 4 and the right pane in rows 1, 2, and 5b. A test asserting "the right pane is editable" would pass on three rows and hide the user's own case.

Phase 3 (cleanup and docs) is re-ordered to run last so the docs describe the shipped feature set.

Build order from here is unchanged for the routing work: **P2b → P2c → P4 → P5 → P3**, each sliced tighter than P2a's 87% peak.

#### P2b sliced before launch, and decision 4 confirmed

The user confirmed the two-panel-kinds narrowing. That resolves P2b's entry condition rather than only Phase 4's: §3.5's frozen-snapshot session model survives intact, because editable surfaces leave the reusable panel entirely for a `CustomTextEditorProvider`. Had the single reusable panel won, §3.5 would have had to carry a live `TextDocument` side and P2b would have needed a different design.

P2b splits into **P2b-i (§3.5)** and **P2b-ii (§3.6)** before launch, not after a session bloats. P2a ran 87% peak against a 45-50% target on a *fix* round carrying only a defect list, and the diagnosis recorded there was that the work order held three independent deliverables. §3.5 (session identity, generation ordering, fallback compare-and-swap, delegate cancellation) and §3.6 (root-keyed change event, watcher reference counting, live re-resolution, loadError state) are exactly that shape again: two deliverables that share a data structure but no control flow.

P2b-i runs **classic in-root**, same as P2a. The two P2a phase-lane deaths came from the harness stream watchdog killing a lane that was blocking on its Codex background task; the main session is not killed the same way, and one of those deaths cost a complete 47-minute Codex session whose work order had already been fully executed.

#### P2b-i accepted — session model, generations, fallback CAS (spec 3.5)

Builder: `gpt-5.6-luna` at `xhigh`. Build round SID `01a02868-abdb-7733-b7c4-82abee0a0bf7`
(PEAK 204,383 / 79%), one fix round (PEAK 123,927 / 47%). Two rounds to acceptance.

**All ten deliverables landed, and five real defects were found at root that the builder's
report marked DONE.** The report claimed 10/10 with evidence; my own verification confirmed
the code existed in every case but found five defects in it:

- F1 — `FrozenDiffSideSnapshot` and `UnifiedDiffSession` were exported from a module nothing
  else imports them from. Narrowed to module-private.
- F2 — `freezeDiffSide` kept the raw decoded bytes alongside the text, a dead ~420KB copy per
  open on a typical file. The sides are already decoded by then and 3.6 re-resolution reads
  text, not bytes. Removed, with a comment at diffService.ts:279 naming why the bytes are gone.
- F3 — the parameterized fallback test asserted the transition at OPEN time, not MID-SESSION.
  The spec's ordering requirement only has teeth mid-session, so the test as written could not
  fail on the bug it existed for. Rewritten to open a first session, then force fallback on a
  second, asserting the live binding is cleared for the NEW generation.
- F4 — the provider-mutation test asserted only that the payload differed from the mutated
  value. An inequality is not an identity: it passed while the oracle read nothing. Now
  asserts the original text present AND the mutated text absent.
- F5 — `claimDiffViewerSession` / `clearDiffViewerSession` went through an indirection layer
  with one implementation. Collapsed to direct static calls.

**Two gates the builder reported green without running.** `deps:check:strict` (knip) was red
on the new `scripts/measure-diff-budgets.ts` entry, found at adjudication. `format:check` was
red on all five touched files, found only by the accept battery. Both are cheap and both are
acceptance gates. The P2b-ii work order now names them explicitly in CHECKS — which is a
prompt asymmetry that must be stated in any luna-vs-terra comparison, not read as a model
difference.

**Mutation proof, run at root, not taken from the report.** Removing the compare-and-swap
detach (`clearDiffViewerSession(session.generation)`) in `transitionToNativeFallback` turned
five mid-session assertions red BY NAME across the parameterized fallback cases. Source
restored byte-exact, verified by sha256
`61b966cb2341c1acbb1520ff49d63e5e2cbef2c73a749caae8a9474dc2eb1e52` before and after.

---

##### The tenth gate: `visual-container`, and the pre-existing Shiki defect it caught

Nine gates went green on the first accept battery. `visual-container` went red — **on a
different baseline cell each full run.** Chasing it consumed most of the phase and turned out
to be the most valuable thing in it, because the defect is user-visible and predates P2b-i.

**Two wrong conclusions I published and had to retract**, recorded because the retraction is
the useful part:

1. _"It's a flake, and I can prove it."_ Two isolated re-runs of the failing cell passed, so I
   said so. The next full battery failed again on a different cell. **An isolated green run of
   the cell that happened to lose the lottery is not evidence about the lottery.**
2. _"The base commit is green, so P2b-i's tree caused it."_ A base-commit matrix passed, which
   contradicted the import-closure analysis (nothing in P2b-i reaches the webview bundle).
   Killed by hashing the built artifacts instead of trusting the run:
   `dist/webview-diffviewer.js` = `c0d341b30bbd645e` and `dist/webview-diffviewer.css` =
   `61a8103225022ee0` on **both** the current tree and `0399aea9`, and the fixture `clean.json`
   byte-identical. Identical inputs cannot produce a tree-attributable difference — the base
   green was one lucky sample.

**Getting to the actual pixels.** No PIL, no pngjs in the container, so a pure-stdlib PNG
decoder (Paeth/Sub/Up/Average filters, plus a shift test to rule out a layout offset) produced
exact differing coordinates, contiguous column runs, and per-region palette histograms.

**The hypothesis that had to die first.** The obvious story was "Shiki hadn't initialized, so
the regex fallback painted the line." It is wrong, and colour alone cannot settle it:
`.tok-number` (#b5cea8) and `.tok-constant` (#4fc1ff) in `diff-core.css` deliberately mirror
Shiki's dark-plus values, so those two discriminate nothing. The keyword does — Shiki's
#569CD6 versus the fallback's `.tok-keyword` #c586c0. **#569CD6 was present in both renders and
#c586c0 in neither**, so both renders came from Shiki. The difference was inside Shiki.

**Root cause.** Shiki's **first** `codeToTokensBase` call against a freshly built grammar can
classify differently from every later call on identical input. Measured over 8 identical
container mounts: `const hd0 = 0;` came back as a single `0;` numeric token — semicolon
swallowed into the literal and painted number-green — on **3 of 8**, and as `0` + `;` on the
other 5. Two things make that more than a cosmetic flicker:

- `tokenCache` in `shikiHighlighter.ts` memoizes per line, so one cold call **poisons that line
  for the rest of the session**; and
- _which_ line receives the cold call varies run to run, which is exactly why a different
  baseline cell failed each time.

This is a **real user-visible rendering bug**, not a test artifact: a user opening a diff sees
a semicolon painted as part of a numeric literal, sticky until the webview reloads.

**Fix.** Tokenize a throwaway line (`const a = 0;`) once per language before any real line, so
the cold call lands where nobody sees it (`shikiHighlighter.ts:108-130`). Empirically verified:
**8/8 identical token dumps** after the fix, line 1 correctly `"0"` + separate `";"`.

**Two shortcuts explicitly refused.** Raising `maxDiffPixels` above 0, and re-recording the
baselines. Either would have turned the battery green in one edit and **deleted the only signal
that caught a real bug** — the baselines were doing their job precisely by being unstable.

**Committed regression test:** `tests/unit/merge/shikiWarmup.test.ts` (3 tests). It drives a
fake highlighter that returns a coarse single token on its first call and correct tokens after —
the measured shape of the defect — rather than the real Shiki, which reproduces it only ~3 times
in 8 and would therefore **pass five runs out of eight with the fix removed**. Mutation table,
all run at root, source restored byte-identical afterwards (`diff` clean):

| Mutation                                           | Result | Red assertions                                                                                                    |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| Delete the `warmLang(lang, theme)` call             | RED    | all 3, incl. `expected 'const hd0 = 0;' not to be 'const hd0 = 0;'`                                                 |
| Drop the once-per-language guard (warm every call)  | RED    | only _"warms each language once, not once per line"_ — `expected [ Array(3) ] to have a length of 1 but got 3`      |
| Global warm-up flag instead of per-language         | RED    | only _"warms a second language separately from the first"_ — `expected 1 to be 2`                                   |

Each mutation kills exactly the assertion that exists for it; no assertion is decoration.

**Proof command and counts.** `VITEST_MAX_THREADS=3 VITEST_MIN_THREADS=1 bun vitest run` over
the five affected files: **5 files / 55 tests passed** (49 before the fix round).

Final accept battery, `verify.py gates --base fad3e7e2 --stage accept`: **GATES: GREEN warn=0**,
all ten — `typecheck` 6.3s, `lint-strict` 13.7s, `format-check` 6.4s, `architecture` 0.9s,
`deps-knip` 1.1s, `l10n-validate` 0.1s, `l10n-audit` 0.4s, `package-vsix` 2.5s, `tests` 426.8s
(full suite), **`visual-container` 925.9s**.

**What that single green does and does not prove.** It is corroboration, not the proof — the
same "one isolated green run" that I twice mistook for evidence earlier in this phase. The
proof is the mechanism plus the 8/8 determinism dump plus the mutation table above. No
confirmation re-run was spent, because `visual-container` is a standing accept gate: P2b-ii's
own battery supplies a second independent sample at zero added serial time.

**Commits.** `35d6a074` (Shiki warm-up + regression test) and `23a713e1` (P2b-i, spec 3.5),
split because the Shiki defect predates P2b-i and stands on its own.

#### P2b-ii accepted — change events, watcher refcounts, live refresh, loadError (spec 3.6)

**Builder:** `gpt-5.6-terra` @ `xhigh` (model swap requested by the user for this phase, to be
compared against luna on P2b-i). Base `d8165339`.

### Build round — SID `01a028f3-19f9-7801-a727-0aa33c48a7f2`

Telemetry `PEAK=244193 LAST=39145 PCT=94% NONRESUMABLE=yes` — the session compacted mid-run
(LAST is well under half of PEAK). Same ceiling luna hit on P2b-i; §3.6 was deliberately kept
whole rather than split, to keep the slice comparable (recorded before launch in
`comparison-confounds.md`, and standing).

Report claimed 10/10 DONE, all gates green, `SUBAGENTS_SPAWNED: 0`, "Deviations: none".
HEAD unchanged at `d8165339` — the git prohibition was respected.
Diffstat: 8 files, +542 / −161, plus new `src/views/repositoryChangeEvents.ts` and
`tests/unit/views/repositoryChangeEvents.test.ts`.

**Gates I re-ran myself** (never delegated, never taken from the builder's report):
`typecheck` exit 0; `lint:strict` exit 0; focused suite 5 files / 53 tests / 0 failed / 494ms.
All three matched terra's reported numbers exactly. That is a genuine contrast with luna on
P2b-i, which reported green on two gates (`format:check`, knip) that were in fact red.

**The extraction itself is faithful.** I read every hunk. `repositoryChangeEvents.ts` preserves
the Linux vs non-Linux refs-watcher split (line 167), the `gitStateFiles` set, and
`ignoredWorkspaceEventDirs`, and it *adds* root-containment filtering the old code lacked. The
refcount rebind is genuinely atomic — `RootWorkingTreeChangeSubscription.rebind()` acquires the
next watcher before releasing the previous one, so a same-root rebind goes 1→2→1 and never
touches zero.

### Findings — five defects, all in deliverables marked DONE under "Deviations: none"

**F1 [HIGH] — Windows live refresh is dead, via a double-escape regex.**
`shouldRefreshForChange` in `src/services/diffService.ts`:
`descriptor.path.replace(/\\\\/g, "/")`. In a regex literal `\\` matches ONE backslash, so
`/\\\\/g` matches TWO CONSECUTIVE backslashes and a win32 path passes through untouched.
`relativeWorkspacePath` always emits forward slashes, so `event.path === requestedPath` can
never hold on Windows; the fallthrough `hasMutableRef && event.source !== "workspace-file"` is
false for a workspace-file event. Net: **on Windows, saving the file being diffed does not
refresh the diff** — the headline behaviour of the phase, dead on a supported platform.
Proven, not inferred: `"src\services\foo.ts".replace(/\\\\/g,"/")` returns the input unchanged;
`.replace(/\\/g,"/")` returns `"src/services/foo.ts"`.
Invisible to the suite because every test passes an already-slash-separated `"src/example.ts"`.

**F2 [MEDIUM] — deliverable 9's atomicity is unmet, and the new test encodes the defect.**
`DiffViewerPanel.postLatestData()` posts `setDiffData`, then `loadError`, as two messages.
`DiffViewerApp.tsx:334` calls `setError(null)` on `setDiffData`. Two separate message events =
two React commits, so a `ready` replay renders fresh panes with **no** error and the error then
pops in — a guaranteed visible flash. The spec said "replays it TOGETHER with the latest
payload."
The new test asserts `toEqual([objectContaining({type:"setDiffData"}), {type:"loadError",…}])`
— written to describe the implementation, so it can never fail on this. Textbook case of
[[tests-catch-errors-not-mirror-implementation]].
Credit where due: the success-clears direction *is* atomic (`open()` clears `loadError` and
posts one message).

**F3 [MEDIUM-HIGH] — the commit panel consumes a debounced stream raw.**
`registerRuntimeWatcher` subscribes with no source filter and calls
`refreshDataWithErrorHandling` → `refreshData` immediately, undebounced. Two compounding
problems: (a) the watcher it replaced deliberately excluded Git metadata — the deleted
`shouldRefreshForWatcherUri` rejected top-level `.git`/`dist`/`build`/`out` — so these rows
never refreshed on index/HEAD/refs before and now refresh on every one; (b) the sibling
consumer of the *same* stream, `RefreshService.scheduleRefreshEvent` — in a file this very
round edits — applies a careful per-source policy (git-state/git-refs → debounced full,
workspace-file → debounced light, git-index → suppressed after a recent full). None of it was
carried across. Each expanded non-active repo row now runs a full status refresh per
`.git/index` write, so a rebase or a large `git add` produces a burst.

**F4 [LOW] — undisclosed removal of a deliberate invariant.**
`Object.freeze(session.sideSnapshots)` deleted from `openUnifiedDiff`. The deletion is correct
and necessary — refresh must reassign `left`/`right` — but it drops an invariant the prior
accepted round established, under "Deviations: none". No test covered it. Keep the change,
require the disclosure and a comment.

**F5 [LOW, downgraded on re-inspection] — `registerRuntimeWatcher` lost its try/catch.**
My first read called this a real robustness regression; it is mostly not. `RootWorkingTreeWatcher`
internally try/catches both `createFileSystemWatcher` and the `fs.watch` calls, so the
"virtual or test roots" case the old comment named is still handled. Only the
`vscode.workspace.onDid*` registrations are now unguarded, and those exist in any real host.
Exposure is test doubles and exotic hosts. Reported as minor; either restore the guard or
justify dropping it.

**Noted, not filed:** `isObjectIdRef` accepts any 7–40 hex string (it reuses the repo's shared
`isValidGitHash`), so a branch literally named `deadbeef` would be misclassified as immutable
and never refresh. Obscure enough not to be worth a round, and terra followed the house helper.

### Fix round 1 — SID `01a02914-4e5e-7273-b94c-663ea130f6e7`

`gpt-5.6-terra` @ `xhigh`, fresh session (nothing in this skill resumes). Work order restates
every constraint and every defect self-containedly, and requires, for F1 and F2, a new or
rewritten test that fails when the fix is reverted — a fix without such a test counts NOT-FIXED.

Telemetry `PEAK=152038 LAST=152038 PCT=58% NONRESUMABLE=no` — a fresh session on a defect list
runs at well under half the peak of the same model building the phase whole (94%). HEAD still
`d8165339`; report claims 5/5 FIXED, `SUBAGENTS_SPAWNED: 0`.

**All five fixes verified at the source, by me:**

- F1 — `/\\/g` at diffService.ts:501. Correct.
- F2 — `loadError?: string` now rides inside `DiffViewerData`; `postLatestData()` posts ONE
  message; `DiffViewerApp` reads `event.data.data.loadError ?? null`. The standalone
  `loadError` InboundMessage variant was **deleted** rather than left dead, and the panel's own
  message-handler catch was rerouted through `postLatestData()` too. Genuinely atomic in both
  directions.
- F3 — filters to `source === "workspace-file"` (Git metadata excluded again, matching the old
  `ignoredWatcherDirs` intent, which `relativeWorkspacePath` already enforces for
  `.git`/`dist`/`build`/`out`), coalesces at 300 ms, clears the timer on dispose, and re-checks
  `runtimeWatchers.has(root)` inside the timer so a collapsed row cannot fire.
- F4 — comment added at the unfrozen container.
- F5 — try/catch restored.

### Root takeover — one item the fix round got wrong, and one it left open

**Terra converted a test in place instead of adding one.** The build round's
`"subscribes mutable worktree sessions and refreshes from an unsaved document"` used
`path: "src/example.ts"`; the fix round rewrote that same test to `"src\\example.ts"`. Test
count held at 53 across a round that added Windows coverage — that is the tell. Net effect: the
POSIX path shape, the one that actually runs on macOS/Linux/CI, lost its only test.
Fixed at root by parameterizing over both separators (`it.each`), not by adding a duplicate.

**Mutation proof, F1** — reverted `/\\/g` → `/\\\\/g`:
`× refreshes a mutable worktree session whose descriptor uses Windows separators`
**RED**, `✓ … POSIX separators` **GREEN**, nine other tests unaffected.
That asymmetry is the point: the POSIX case provably cannot detect this bug, so the two cases
are not redundant and the in-place conversion was a real coverage loss. Source restored
byte-identical.

**Mutation proof, F2 (host)** — dropped `loadError: this.loadError` from the payload:
2 failed / 16 passed — `× replays an active refresh error atomically…` and
`× posts a refresh loadError atomically with the last rendered panes`, each naming its own
assertion. Restored byte-identical.

**A transported value with no reader.** The fix round proved the host *sends* the error and
never that the viewer *reads* it — nothing imported `DiffViewerApp` for this, so reverting
`setError(event.data.data.loadError ?? null)` to `setError(null)` would have silently killed
the user-visible half with every test still green. Added an integration case at
`tests/integration/webviews/diff-viewer.integration.test.tsx` covering both directions (error
renders, next clean payload clears it).
**Mutation proof** — reverted that line: exactly one test red,
`→ a payload-carried loadError must render the error banner: expected null not to be null`.
(First cut of the assertion failed with "the given combination of arguments (undefined and
string) is invalid" — a message about assertion mechanics, not behaviour — so the expectation
was rewritten to name the contract before the proof was accepted.) Restored byte-identical.

**Process note:** the first accept battery was killed and rerun. It had been launched before
these last edits, so it would have been gating a tree that changed under it — in particular
`format:check` could have passed on bytes that no longer existed. A battery over a mutating
tree proves nothing definite.


### Fix round 2 — SID `01a0293e-c08c-7413-983f-ba0795729e34`

`gpt-5.6-terra` @ `xhigh`, fresh session. Two BLOCKERs, **both found by my accept battery and
neither by the builder**, because the builder was never asked to run either gate:

- `architecture` RED — `no-domain-layer-to-ui`:
  `src/services/diffService.ts → src/views/repositoryChangeEvents.ts`. The shared registry is
  infrastructure and had been placed in the view layer, so the services layer could not legally
  consume it.
- `tests` RED — 4 failed / 4223 passed, all four in the two `tests/integration/extension/` files.

**A miss of my own, recorded because it is the same failure I charged luna with.** My
fix-round-1 CHECKS list named `typecheck`, `lint:strict`, `format:check` and `deps:check:strict`
— and **not** `architecture:check`. So a layering violation introduced in the build round
survived an entire fix round without anyone looking at it. That is structurally identical to
luna's P2b-i format-check miss on §3.5: a builder runs the gates its work order names, and a
gate absent from the work order is a gate nobody runs. `architecture:check`, plus an explicit
mandate to run the **full** `bun run test` rather than a focused subset, went into the fix-2
CHECKS list for exactly that reason.

Telemetry `PEAK=241234 LAST=85564 PCT=93% NONRESUMABLE=yes` — compacted again, on a round
carrying nothing but a two-defect list. Fix round 1 on a five-defect list ran at 58%. The
difference is that this round had to read and rewrite two integration suites (the larger is
~5,800 lines) before it could change a line. HEAD still `d8165339`; `SUBAGENTS_SPAWNED: 0`.

**Defect 1 — the move.** `src/views/repositoryChangeEvents.ts` →
`src/services/repositoryChangeEvents.ts`, test alongside it, all three importers repointed
(`RefreshService.ts`, `CommitPanelViewProvider.ts` → `../services/…`; `diffService.ts` →
`./…`). Verified as a **move, not a copy**: `ls src/views/repositoryChangeEvents.ts` →
"No such file or directory". `architecture:check` now reports *no dependency violations found
(315 modules, 1171 dependencies cruised)*.

**Defect 2 — and here my own root-cause analysis was half wrong.** The work order stated as
verified fact: *"Neither integration test's `vscode` mock defines ANY of those five (verified:
grep for all five in both files returns nothing)"*, and ordered the five registrations added to
both files. That was **true for `view-providers.integration.test.ts` and false for
`extension.integration.test.ts`** — the latter already had all five (they appear as unchanged
context in the diff; only the listener *type* changed). The real cause there was different: the
listeners were registered but **invoked with no arguments** (`textDocListeners[0]?.()`), so the
real handler dereferenced `event.document.uri` on `undefined`. Terra did not comply with the
false premise and duplicate the registrations; it found the actual cause, gave the four listener
arrays real typed event shapes, and **disclosed the deviation**, which is how I found my error.

**2b — the silent discard is gone.** `registerRuntimeWatcher`'s bare `catch {}` is now
`catch (error) { console.error("[IntelliGit] Commit-panel runtime watcher registration failed:", error) }`
(`CommitPanelViewProvider.ts:781`). A missing-API TypeError had been indistinguishable from
"this root cannot be watched" — which is precisely what hid all four failures behind a green
focused run. `console.error` is the repo convention here (44 uses across `src/`, `[IntelliGit]`-
prefixed variants in `repositoryMode.ts`), not an invention of this round.

### Verification of fix round 2 — mine, not the builder's report

**No assertion was weakened.** I read both integration diffs in full. Every `toBeDefined()`,
call-count and dispose assertion named in the work order is retained verbatim. The 102 changed
lines in `view-providers.integration.test.ts` are almost entirely re-indentation into a
`try/finally` (added so the module-global watcher registry cannot leak refcounted watchers into
the next test); the only semantic change is swapping a 10-iteration microtask poll for
`vi.advanceTimersByTimeAsync(300)`, which fix round 1's own 300 ms debounce made necessary. The
*second* failing test in that file is not touched at all — it is fixed purely by the mock, which
is the shape a correct root-cause fix should have.

**A stale-listener risk I checked and cleared.** The round added `vi.resetModules()` to two
tests, which re-activates the extension and pushes *additional* listeners onto the shared
arrays, so `textDocListeners[0]` could have been a stale listener from an earlier activation.
It is not: `beforeEach` at line 1032 does `textDocListeners.length = 0`. Import ordering is also
correct — `resetModules()` → `import("fs")` → `import("../../../src/extension")`, so the mock
and the module under test come from the same fresh registry.

**No scope creep**, established from file mtimes rather than from the report:

| Time | Files touched | Defect |
| ---- | ------------- | ------ |
| 12:39:11 (one batch) | registry + its test, 3 importers, `unifiedDiffSession.test.ts` mock path | 1 — the move |
| 12:59 / 13:01 | the two integration test files | 2 — the four failures |

Everything else in the diff predates the round. The round did rewrite my protected
`unifiedDiffSession.test.ts`, but only the `vi.mock` import path the move forced — both
`it.each` separator cases survive intact, as does the payload-carried `loadError` integration
case and the `/\\/g` single-escape at `diffService.ts:501`.

### Acceptance

`verify.py gates --base d8165339 --stage accept` — **GATES: GREEN warn=0**, all ten, run by me
over a frozen tree after every edit was final: `typecheck` 6.3s, `lint-strict` 13.7s
(`--max-warnings=0`), `format-check` 6.5s, `architecture` 0.9s, `deps-knip` 1.2s,
`l10n-validate` 0.1s, `l10n-audit` 0.4s, `package-vsix` 2.5s, **`tests` 423.0s — 308 files /
4227 tests passed / 0 failed**, `visual-container` 918.6s with all 36 baselines byte-identical.

Both gates that were red at the previous battery are green, and the test count moved 4223 → 4227
in the right direction: the four failures became four passes without the total shrinking, so
nothing was deleted or skipped to reach green.

**Builder self-report accuracy.** Terra's reported counts — 308 files, 4227 tests, 0 failed,
`architecture` 0 violations at 315 modules / 1171 dependencies — matched my independent
re-execution exactly, for the second round running. Set against luna on P2b-i, which reported
two gates green that were in fact red, this is the one column in the model comparison showing
real separation, and it is not explained by the prompt: both builders' work orders named the
gates they were to run and report.

**Rounds to acceptance: 3** (build + 2 fixes), plus two root-authored test corrections. luna
needed 2 on P2b-i, plus one root correction.

**Commit.** `0ede98f1` (P2b-ii, spec 3.6).
