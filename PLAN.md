# Plan: Unified diff view — one renderer, editable and read-only modes
_Locked via grill — by Claude + maheshkokare_
_Revised after Codex Rounds 1-5 (32/32 findings incorporated; arbitrated close at MAX_ROUNDS with user go-ahead)_

## Goal
IntelliGit renders merge conflicts in a custom PyCharm-style 3-pane webview (`webview-mergeeditor.js`, shared by MergeEditorPanel and ShelfConflictEditorPanel) but delegates every read-only diff — changed files, commit files, stash, shelf, branch/revision compares — to VS Code's native diff editor (`git.openChange` at src/views/panelFileActions.ts:155, `vscode.diff` at src/services/diffService.ts:246). Goal: extract the merge editor's rendering machinery into a shared pane-agnostic core, build a 2-pane read-only diff viewer on it, and route all read-only diff surfaces through that viewer — one visual language (side-by-side panes, center line-number gutters, Bézier connector ribbons, Shiki highlighting) across the whole extension. The native editor is never a user preference — it is reached only for content the viewer must refuse (binary, invalid UTF-8, symlink, submodule, over-budget). Editable mode = the existing merge editor (per-hunk action icons + result textarea) for conflicts, plus -- added 2026-08-22, see Phase 4 -- an editable working-tree pane in the 2-pane viewer on every surface that has a file on disk. Read-only mode = the 2-pane viewer with no per-hunk icons and no editable side, used where both sides are immutable history.

## Approach
Numbered phases; each lands only when its gate is green.

1. **Phase 0 — pane-agnostic diff-core (pure refactor, zero behavior change).**
   1.1 Create `src/webviews/react/diff-core/` and move from `merge-editor/`: the vertical layout engine (`mergeScrollLayout.ts` — generalize `MergePane = "left" | "middle" | "right"` (src/webviews/react/merge-editor/mergeScrollLayout.ts:15) and every `Record<MergePane, …>` to an ordered pane-id array supporting 2 or 3 panes), line-number builder (`lineNumbers.ts`), SVG ribbon geometry (`ribbonPathD` / `ribbonOutlineD`), scroll sync (canonical vertical space + per-pane horizontal sync + shared scrollbar), syntax-highlight context (Shiki + regex fallback), and the common/changed block shells from `segments.tsx` that carry no merge-action logic. The generalization covers everything currently hardcoded to left/middle/right — `SegmentPaneLines`, layout construction, column refs, and connector measurement (mergeScrollLayout.ts:18-107) — by defining line counts and geometry over an ordered pane map; merge-only adapters stay outside diff-core; contract tests cover both 2-pane and 3-pane layouts.
   1.2 Merge editor consumes diff-core with panes `["left","middle","right"]`; shelf conflict editor rides the same bundle unchanged.
   1.3 Extract a shared `diff-core.css` (+ semantic CSS variables) from `merge-editor.css` for every class the moved blocks depend on; both the merge bundle and (later) the viewer bundle import it — `shared/tokens.ts` is TypeScript and cannot feed a second stylesheet by itself.
   1.4 Gate: existing merge unit tests (`tests/unit/merge/*`), webview integration tests, and pixel baselines for merge-editor / shelf-conflict-editor / merge-conflict-session pass **without re-recording**. Definition of done = unchanged pixel baselines plus unchanged protocol messages, DOM structure, and interactions — bundle bytes necessarily change with module relocation and CSS-import splitting; no artifact is required to be byte-identical.

2. **Phase 1 — read-only DiffViewer.**
   2.1 Extension-host `computeDiffSegments(leftText, rightText): DiffSegment[]`, reusing `diffLinesFair()` (src/mergeEditor/lineDiff.ts:73) for line alignment and `wordDiff.ts` for intra-line masks. Segment kinds: `common | changed` with per-side line arrays (insert/delete = one empty side), plus per-side EOL and terminal-newline metadata so `a` vs `a\n` renders an explicit newline-difference marker instead of looking identical. Pure module, unit-tested, including the greedy-fallback path for huge inputs and terminal-newline regressions.
   2.2 New `DiffViewerApp` (React) composing diff-core with 2 panes, read-only: no textarea, no per-hunk action icons, no resolution reducer. Toolbar: ignore-whitespace + word-highlight toggles only, reusing the merge editor's toggle components.
   2.3 New bundle entry `webview-diffviewer.js` + css beside `webview-mergeeditor.js` in the build config; host `src/views/DiffViewerPanel.ts` modeled on MergeEditorPanel via `buildWebviewShellHtml`, as **one reusable panel**: subsequent opens reveal the existing panel and post a fresh payload.
   2.4 Protocol `src/webviews/protocol/diffViewerTypes.ts`: Outbound `ready | setIgnoreMode`; Inbound `setDiffData | loadError`. Payload: file path, side labels (`HEAD` / `Working tree`, or short hashes), precomputed segments, language id.
   2.5 New user-facing strings go through the l10n CSV round-trip inside this phase.
   2.6 Gate: webview unit tests assert per-hunk icons and textarea **absent** in DiffViewerApp and **present** in the merge app (anti-vacuity pair); visual fixture + new pixel baseline for the viewer; mutation check — swap a read-only block for the editable variant and the icon-absence assertion goes red by name.

3. **Phase 2 — route all read-only surfaces through it.**
   3.1 One funnel in `src/services/diffService.ts`: `openUnifiedDiff(request, nativeDelegate)`. `request` is an immutable descriptor `{repoRoot, path, left: SideSpec, right: SideSpec, languageId, title}` with `SideSpec = {kind:"ref", ref} | {kind:"worktree"} | {kind:"provider", load, label}` — the provider kind is a lazy probe/bounded-load contract returning `loaded {bytes, mode} | missing | over-budget` — never a bare full buffer — for stash/shelf sources that acquire content asynchronously (the current shelf reader returns fully allocated buffers and is adapted); nothing is fetched before branching. `nativeDelegate` is a per-call-site closure preserving today's exact native behavior (`git.openChange`, the `vscode.diff` variants). **There is no user-facing viewer setting** (amended 2026-08-21, see Key decision 2): every IntelliGit surface opens the IntelliGit viewer, and `nativeDelegate` is invoked only for content the viewer cannot render.
   3.2 Shared side loader. Every side is size-probed first (`git cat-file -s` / `fs.stat` / bounded read — `GitExecutor.runBinary` already supports bounded output) and an over-cap side delegates to native immediately, BEFORE any full buffer allocation. Under the cap, sides resolve to raw bytes + file mode BEFORE any UTF-8 decode (the existing `getFileContentAtRef` path decodes eagerly and would make detection impossible) — except the worktree side, which uses an open (possibly dirty) `vscode.TextDocument`'s text when one exists, matching existing stash/shelf behavior (panelFileActions.ts:192-202). Binary, invalid-UTF-8, symlink, and submodule sides (byte path) route to the native delegate — never garbage panes. Only confirmed missing-path outcomes (added/untracked/deleted files) become an empty side; every other error propagates. Test matrix: added / untracked / deleted / binary / invalid-UTF-8 / symlink / submodule / shelf inputs, plus an unsaved-edit (dirty document) case.
   3.3 Budgets — a numbered measurement task, not a deferred intention: build a corpus of representative fixtures (small / typical / large / pathological), set quantitative targets for extension-host stall, memory, postMessage payload size, and webview render time; choose byte/line/cell thresholds from those measurements (the weighted DP can otherwise allocate ~10M cells on the host). Gate BOTH sides: over-budget files delegate to native BEFORE synchronous diff computation, and below-threshold files must meet the perf targets — the existing merge gates (3s parse / 15s render) are too loose to reuse as-is; the merge perf integration test is extended to the viewer with the new targets.
   3.4 Rewire call sites, each with its delegate: `showDiffFromPanel` (src/views/panelFileActions.ts:149 — **HEAD ↔ working tree always**, staged state irrelevant), `openCommitFileDiff` (src/services/diffService.ts:195), `compareEditorFileWithBranch` / `compareEditorFileWithRevision` / `openDiffAgainstGitRef` (diffService.ts:256-403), shelf **single-change (`changeId`) requests only** in `showShelfDiffFromPanel` (src/views/shelfDiffActions.ts:31 — the whole-shelf `vscode.changes` overview stays native), stash single-file diff (panelFileActions.ts:247-289 — the stash overview stays native).
   3.5 Reusable-panel concurrency **(read-only surfaces only -- see Phase 4.3 and 4.4 for editable sessions, whose working-tree side is a live `TextDocument` rather than a snapshot)**: every open/refresh creates a generation-bound session `{descriptor, resolved immutable side snapshots (texts + metadata), stable provider identities for the delegate (e.g. the stash commit OID, never stash@{index}), nativeDelegate, generation}`; completions carrying a stale generation are discarded; the latest payload is replayed on webview `ready`. Host-side `setIgnoreMode` recomputation reuses the frozen snapshots — it never reloads providers. If a refresh resolves to a fallback condition (the file became binary / invalid-UTF-8 / symlink / submodule / over-budget), the session ends one-shot IN THIS ORDER: detach/clear the panel's session binding first — cleanup is a compare-and-swap against the session's generation and never touches a panel a newer session owns — then unsubscribe, invalidate the generation, and invoke the stored delegate once. Delegates receive a dedicated cancellation token — cancelled only by a newer open or panel disposal, NOT by the custom-session invalidation that precedes the delegate call (otherwise fallback would either always self-suppress or run unguarded) — and re-check it immediately before every editor-opening side effect; an async delegate (e.g. the stash loader) could otherwise open a stale native editor after a newer request won. Delegates bind their stable provider identity so a fallback after stash renumbering opens the same stash the panes showed. Tests: slow-A/fast-B open race; slow-fallback/fast-open delegate race asserting B remains open through A's late cleanup; mid-session fallback transition parameterized across all eligibility failures; stash-renumbering-then-fallback; toggle-after-provider-mutation.
   3.6 Live refresh: `RefreshService` exposes no subscribable change event, covers only the active repository, and is disposed on repository switches (RefreshService.ts:19-23,188-225,368-391; repositoryMode.ts:572-594), while `showDiff` can target non-active runtimes (CommitPanelViewProvider.ts:409-418,1836-1838) — so this phase introduces a root-keyed, typed working-tree change event fed by the existing text/filesystem watcher pathways (including non-active/expanded runtimes), with atomic subscription rebinding when the descriptor or the active service changes. The provider-local working-tree event is payload-free and fires only on IntelliGit's own mutations, so it is NOT the trigger. The panel subscribes per its session's repoRoot (and path where available); on fire it re-resolves ONLY sides marked mutable — the worktree side — through the side loader and posts fresh `setDiffData` under a new generation. Provider sides and object-ID refs are frozen at session creation: provider sources like `stash@{index}` re-resolve to different objects as the stash list mutates (`getStashFileContents` resolves the index on every load), so a refresh never re-runs them. Symbolic refs (`HEAD`, branch names) are mutable: they re-resolve on the Git-state events the watcher pathway already covers (RefreshService.ts:244-295), so a commit or branch move updates the `HEAD`-labeled pane instead of silently showing the previous commit — HEAD-move and branch-move tests required. Sessions with any mutable side (worktree or symbolic ref) subscribe; fully frozen diffs are immutable. Watcher lifetime: non-active repository watchers currently live only while their commit-panel rows are expanded and are disposed on collapse (CommitPanelViewProvider.ts:749-765,810-815), so root watchers are reference-counted across row expansion AND diff-panel subscriptions. A watcher-driven refresh that fails takes a generation-checked error transition: report via the existing `loadError` message, deliberately keep the prior panes visible under the error state (never blank, never silently stale), and leave the subscription armed so the next change event retries — provider deletion, permission failures, and Git errors all land here, never as unhandled rejections. The active `loadError` is part of the session state: webview `ready` replays it together with the latest payload, and a successful refresh clears it atomically — no obsolete error over fresh panes, no silently hidden staleness.
   3.7 Undocked + commit-info require no webview changes — their `showDiff` / `openCommitFileDiff` messages land in the same host handlers; proven by integration test, not assumed.
   3.8 Gate: funnel unit tests for each delegate-vs-panel outcome (delegate spy vs panel-open spy), including a pair-level budget case that no per-side cap would catch; side-loader unit tests (full matrix above); generation-race tests (open race AND slow-delegate race); mid-session fallback-transition test parameterized across binary / invalid-UTF-8 / symlink / submodule / over-budget; refresh-error transition tests (loadError posted with prior content retained; error→ready replay; error→success atomic clear); watcher reference-count tests (row collapse and active-root switch with the panel open); HEAD-move and branch-move re-resolution tests; stash-renumbering-then-fallback test; toggle-after-provider-mutation test; unsaved-edit live-refresh test; live-refresh test (watcher-driven refresh → new payload under new generation); integration: file-row click → DiffViewerPanel receives the correct payload; e2e smoke: click changed file → diff viewer visible with both panes populated; full repo gates (lint, typecheck, all suites), not only touched files.

4. **Phase 3 — cleanup and docs.** _(Runs LAST. Phases 4 and 5 below were added 2026-08-22 and land before this one, so the docs describe the shipped feature set rather than an intermediate one.)_
   4.1 Sweep remaining diff color tokens where merge editor and viewer diverge (the shared `diff-core.css` + semantic CSS variables already landed in Phase 0; this phase only catches stragglers).
   4.2 Remove dead `css-modules.d.ts` infra as one verified cleanup across all four reference sites: the declaration file, `knip.jsonc`, `tsconfig.tests.json`, and `tsconfigCoverage.test.ts` (zero real `*.module.css` imports exist).
   4.3 CODEMAPS/docs update; CHANGELOG entries accumulated per phase.
   4.4 Gate: full gates green; change-scope check before each phase commit.

## Key decisions & tradeoffs
1. **Composition over a `readOnly` flag.** Two thin apps (merge app, diff-viewer app) over one shared diff-core; "mode" = which blocks a surface composes. Avoids threading a boolean through every component and keeps the merge state machine out of the read-only path. Tradeoff: a second bundle — precedent already exists (two host panels share `webview-mergeeditor.js`, switched by `sessionKind`).
2. **Replace native diff entirely — no setting.** _(Amended 2026-08-21 by the user, overriding the original "`native` fallback setting" decision after the setting was built in P2a; the contribution, its twelve locale catalogs, the CSV rows, and the resolver were deleted before P2a was committed.)_ Unified-everywhere is the point, and a user-facing choice dilutes it. The original decision justified the setting as "the escape hatch and keeps the native path tested" — but the second half never held: `nativeDelegate` is required regardless, because binary, invalid-UTF-8, symlink, submodule, and over-budget sides must fall back (§3.2). That path stays live and tested with or without a setting. Tradeoff, now unmitigated: the viewer loses native diff affordances — find-in-editor, go-to-definition, minimap, inline-diff toggle — with no opt-out.
3. **HEAD ↔ working tree, always** for changed-files diffs (PyCharm changelist model, one rule) instead of git.openChange's index-aware pairs. Tradeoff: staged-vs-unstaged nuance is invisible in the diff panel; the commit panel's checkboxes remain the staging surface.
4. **One reusable diff panel**, content swapped per click (PyCharm behavior); the merge editor stays per-file. Tradeoff: cannot view two diffs side-by-side. _(Narrowed 2026-08-22 -- see Phase 4.3: this now governs the read-only surfaces only. Surfaces with a working-tree side open a per-file custom text editor instead, which is also what PyCharm does.)_
5. **Diff computed extension-host** with the existing engine (`diffLinesFair` weighted-LCS + `wordDiff`), segments shipped over postMessage like `MergeEditorData` today. Same alignment quality as merge view; webview stays dumb. Tradeoff: compute + payload cost for huge files — gated by measured byte/line/cell budgets with native fallback before synchronous computation (the greedy fallback and `content-visibility` alone cap neither compute nor payload).
6. **View toggles stay; per-hunk icons go** in read-only mode (ignore-whitespace + word-highlight are read-only-safe and already built).
7. **Live refresh from the existing repo-change event**; no per-file fs watchers.

## Risks / open questions
- Phase 0's `MergePane` generalization touches layout math, ribbon anchoring, and scroll sync at once; pixel baselines are the tripwire and must never be re-recorded to green a regression.
- Ribbon/gutter geometry: 2 panes have one connector region, 3 panes have two — helpers must operate on adjacent-pane pairs; hidden 3-pane assumptions may exist beyond the type itself.
- Budget thresholds (bytes/lines/cells) need real measurements on representative files before defaults are chosen; wrong thresholds either bounce to native too often or jank the extension host.
- The undocked/commit-info ride-along is host-side-verified but must be proven by integration test.
- Rename detection is not represented in the segment model (plain add/delete panes today); acceptable for v1, note in docs.

## Phase 4 — editable working-tree pane

_(Scope change raised by the user 2026-08-21; decision tree resolved with the user 2026-08-22. Supersedes the earlier "Pending scope change" note, which is now closed.)_

Reference behaviour, in the user's own words: in PyCharm, opening a stash diff on a file shows the current version on one side and the stashed version on the other, and edits made to the current-version side persist to the real file.

### 4.1 Which surfaces get an editable pane

Every surface where one side is the working-tree file, and only that side. The historical side is never editable.

| #   | Surface                                                     | Left                        | Right                       | Working-tree side | Editable today | After this phase |
| --- | ----------------------------------------------------------- | --------------------------- | --------------------------- | ----------------- | -------------- | ---------------- |
| 1   | `showDiffFromPanel` → `git.openChange` (panelFileActions.ts:155) | HEAD / index                | working-tree file (real)    | right             | yes            | yes — no regression |
| 2   | `openDiffAgainstGitRef` (diffService.ts:284)                | ref content (virtual)       | `fileUri` (real)            | right             | yes            | yes — no regression |
| 3   | `openCommitFileDiff` (diffService.ts:349)                   | parent commit (virtual)     | commit (virtual)            | none              | no             | no — impossible  |
| 4   | stash single file (panelFileActions.ts:269)                 | Local File (**snapshot**)   | Stash {n} (virtual)         | left, but copied  | **no**         | **yes — new**    |
| 5a  | shelf `baseToShelved` (shelfDiffActions.ts)                 | Base (virtual)              | Shelved (virtual)           | none              | no             | no — impossible  |
| 5b  | shelf `shelvedToLocal` (shelfDiffActions.ts)                | Shelved (virtual)           | Local (**snapshot**)        | right, but copied | **no**         | **yes — new**    |

Rows 4 and 5b are the user's reference case, and they are a **new capability rather than a preserved one**: `prepareStashLocalDiffSnapshot` (panelFileActions.ts:185) and `readLocalSnapshot` (shelfDiffActions.ts:124) read the file's text and wrap it in `createReadonlyDiffUri`. The local side is a photocopy today, so even the native editor cannot write through it. Making these editable requires the local side to stop being a snapshot and become the real `vscode.Uri` of the file on disk.

Rows 3 and 5a stay read-only permanently, because both of their sides are immutable history and there is nothing to write to. That is a property of the data, not a policy, and it must never surface as a setting.

Note that the editable side is **not** a fixed pane index: it is the left pane in row 4 and the right pane in rows 1, 2, and 5b. Any implementation or test that assumes "the right pane is the editable one" is wrong on the user's own reference case.

### 4.2 Write-through: `CustomTextEditorProvider`, not a hand-rolled dirty state

The user's requirement is that editing behaves exactly like a normal editor: Ctrl+S saves, the dirty dot appears, Ctrl+Z undoes, and an external change to the file raises VS Code's own conflict handling rather than anything we invent.

VS Code has one primitive that supplies all of that: **`CustomTextEditorProvider`**. VS Code owns the `TextDocument`; our webview is only a view onto it. Dirty state, save, undo/redo, hot exit, close-with-unsaved-changes prompting, and external-change events are inherited rather than reimplemented.

Data flow, both directions:

- webview edit → `postMessage` delta → host applies a `WorkspaceEdit` → VS Code marks the document dirty.
- document changed by anything (our edit, another editor, a Git operation, disk) → `onDidChangeTextDocument` → host recomputes segments → `setDiffData` to the webview.

The second direction fires for our own edits too, which makes it the single update path: the webview never treats its optimistic local state as authoritative. That is what keeps two editors open on the same file consistent, and it is the reason not to special-case the echo.

**Rejected alternative — hand-rolled write-through on the existing `WebviewPanel`.** Applying `WorkspaceEdit`s from a plain webview panel does get dirty state and undo onto the *document*, but a `WebviewPanel` has no dirty state of its own: the dot in the tab, Ctrl+S routing, hot exit, and the unsaved-changes prompt on close would each be separately simulated. That is a reimplementation of precisely the behaviour the user asked to inherit, and every gap in it is a data-loss path.

### 4.3 Consequence: two panel kinds, and Key decision 4 narrows

A `CustomTextEditorProvider` is bound to one resource and its lifecycle belongs to VS Code, so it cannot also be the "one reusable panel whose content is swapped per click" of Key decision 4. Resolution:

- Surfaces with a working-tree side (1, 2, 4, 5b) open a **custom text editor bound to that file** — one editor per file, VS Code-managed, like any other editor tab.
- Surfaces with no working-tree side (3, 5a) keep the **single reusable `DiffViewerPanel`** exactly as built in Phase 1.

This narrows Key decision 4 rather than contradicting it, and it moves the plan closer to the PyCharm model that decision cited: PyCharm also gives a real editor tab for a working-tree diff and a viewer for a commit-to-commit diff.

**Confirmed by the user 2026-08-22.** This was the one documented decision the editable requirement forced to change shape, and it gated Phase 2b rather than only Phase 4: had the single reusable panel won instead, §3.5's session model would have had to carry a live `TextDocument` side. It does not. §3.5 therefore serves the read-only surfaces only, and Phase 2b builds against the frozen-snapshot premise unchanged.

### 4.4 Refresh semantics with an editable pane

§3.5's "resolved immutable side snapshots" holds unchanged for the read-only panel (rows 3, 5a): both sides are frozen history, so there is nothing to invalidate.

For an editable session the working-tree side is not a snapshot at all — it is the live `TextDocument`, and VS Code already owns its conflict story. The user's decision is to **inherit it**: unsaved edits survive a refresh, the document stays dirty, and a conflicting change on disk raises VS Code's own save prompt. We add no reload-and-discard rule and no dirty-blocks-refresh rule. The historical side re-resolves under the existing generation model; the editable side simply *is* the document.

### 4.5 Gate

- Write-through proof: type into the pane, assert `document.isDirty`, assert `document.getText()` carries the edit, and assert the file on disk is still unchanged until save.
- Editable-side proof parameterized over rows 1, 2, 4, 5b, asserting the editable pane is the one bound to the working-tree file — **left for row 4, right for rows 1, 2, 5b**. A test hardcoding "right pane is editable" passes on three rows and hides the user's own case, so this parameterization is the gate, not a convenience.
- Anti-vacuity pair: rows 3 and 5a assert no editable surface exists at all.
- Rows 4 and 5b regression: assert the local side resolves to the real file URI and **not** a `createReadonlyDiffUri` snapshot. This is the specific defect being fixed, so it is the assertion that must go red if the snapshot path returns.
- External-change test: change the document from a second editor and assert the pane re-renders without losing unsaved edits.

## Phase 5 — find-in-diff

Ctrl+F inside the viewer, recovering the affordance given up by leaving the native editor (the stated tradeoff in Key decision 2).

**Use VS Code's own find widget: `enableFindWidget: true`.** Both `createWebviewPanel` and `registerCustomEditorProvider`'s `webviewOptions` accept it, so one option covers both panel kinds from Phase 4. It searches the webview's rendered text and supplies next/previous, match highlighting, and the regex and whole-word toggles — with no search box of ours to build, style, localize, or keep accessible, and with behaviour identical to every other find surface in the editor.

**The one binding constraint it imposes:** find only sees text that is in the DOM. `content-visibility: auto` (Key decision 5) is compatible, because it skips rendering while keeping content in the DOM and searchable. True virtualization that removes off-screen rows is **not**, and would silently degrade find to "matches in the visible window" with no error and no failing test.

Gate: render a file large enough to exercise the budget ceiling and assert every line's text is present in the DOM. That assertion is what makes the constraint enforceable instead of a comment — a later performance change introducing windowing goes red here and has to choose deliberately between windowing and find.

Deferred: cross-pane match counts, and any find-and-replace affordance.

## Out of scope
- Multi-file stash AND whole-shelf overviews (`vscode.changes`) — stay native.
- Next/previous-hunk navigation arrows; unified single-column diff layout.
- VS Code SCM view, editor gutter decorations, any surface IntelliGit does not own.
- New palette commands (the panel opens programmatically only).
- 3-way anything in the read-only viewer.
