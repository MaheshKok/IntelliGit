# PLAN — DRY consolidation of webview tree/toolbar/icon components

Status: FROZEN (claudex-build spec). Branch `codex/dry-shared-components`, worktree
`/Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/dry-components`.
Base: `codex/pycharm-shelve-parity` @ 8de34169.

## Goal

One shared implementation per duplicated UI concept in `src/webviews/react/`:
toolbar icon buttons, spin keyframes, icon glyphs, stash/shelf file-tree adapters,
scoped directory-expansion helpers, tree row rendering, section headers. Behavior
and visuals preserved exactly — this is a refactor, not a redesign.

## Global constraints (apply to every phase)

- Behavior-preserving. No visual changes: same DOM structure where tests assert it,
  same aria attributes, same indent metrics per consumer, same tooltips/labels.
- No new i18n strings; reuse existing `t()` keys. Never hardcode user-facing text.
- No new dependencies.
- Respect gates: `lint:strict` (complexity ≤ 25, zero warnings), `react-doctor -y`
  (no state-sync-in-effect patterns — settle state during render or from events),
  `deps:check:strict` (knip — no orphan exports/files), `format:check` (prettier),
  both typechecks.
- Follow existing test conventions (vitest + Testing Library, see
  `tests/webview/unit/*.test.tsx`). New shared components get direct unit tests.
- Immutability: never mutate props/state objects.
- Files ≤ ~800 lines; extract rather than grow.
- Do NOT touch: `branch-column/` (different domain: branches, not files),
  `merge-editor/`, `merge-conflicts-session/`, `src/views/MergeConflictsTreeProvider.ts`
  (native TreeDataProvider), extension host code (`src/` outside `src/webviews/`),
  `commit-panel/theme.ts` token values.
- GIT: no commit/push/tag/stash/rebase/checkout. Leave all changes uncommitted.

## Out of scope (whole plan)

- `tokens.ts` vs `theme.ts` fallback drift (`#d7dce5` vs `#d6dbe5`) — report only.
- CommitInfoPane's commit-scoped expansion state shape (all-expanded default) —
  distinct semantics, stays.
- BranchSectionHeader / branch-column `buildPrefixTree` — branch domain.
- Any PyCharm-parity feature work.

## Proof command (phase acceptance, run by reviewer)

`bun run typecheck && bun run lint:strict && bun run react-doctor && bun run test && bun run deps:check:strict && bun run format:check`

---

## Phase 1 — Shared ToolbarIconButton, spin keyframes, glyph consolidation

Seam: toolbar chrome only. No tree code.

### Deliverables

1. New `src/webviews/react/shared/components/ToolbarIconButton.tsx`: single
   icon-button wrapper replacing `StashToolbarButton`
   (`commit-panel/components/StashToolbar.tsx:96-135`) and
   `ShelfToolbarIconButton` (`commit-panel/components/ShelfToolbar.tsx:136-167`).
   Props: `label` (tooltip + aria-label), `icon`, `onClick`, `disabled?`,
   `pressed?` (aria-pressed), `spin?`, and it reads `getSettings()`
   (`shared/settings.ts`) itself for hoverDelay/tooltipsEnabled — callers stop
   passing those. Chakra `IconButton`/`Button` with `variant="toolbarGhost"`,
   identical rendered attributes to the two components it replaces.
2. `SPIN_KEYFRAMES` defined once in `shared/components/iconStyles.ts`, exported;
   the three byte-identical copies at `commit-panel/components/Toolbar.tsx:29`,
   `shared/components/RefreshButton.tsx:10`, `commit-info/CommitInfoPane.tsx:45`
   import it. No other change inside CommitInfoPane/RefreshButton in this phase.
3. Show-diff glyph added to `shared/components/Icons.tsx` (e.g.
   `ShowDiffIconGlyph`), replacing the two independent hand-drawn SVGs at
   `Toolbar.tsx:146-151` and `StashToolbar.tsx:52-63` (pick the Toolbar geometry
   as canonical — both render a diff icon; keep 16×16 viewBox convention).
4. `StashToolbar.tsx` and `ShelfToolbar.tsx` use shared glyphs
   (`ExpandAllIconGlyph`, `CollapseAllIconGlyph`, `GroupByDirectoryIconGlyph`
   from `Icons.tsx`) instead of inline SVG paths; local `icon()`/`moreIcon()`
   helpers in ShelfToolbar removed if now unused (keep `moreIcon` glyph by moving
   it into `Icons.tsx` if still needed).
5. `Toolbar.tsx` icon-only buttons (refresh, show-diff, expand-all, collapse-all)
   render via shared `ToolbarIconButton`; the local `ToolbarButton` keeps ONLY
   the labeled/prominent cases and shrinks accordingly (its cc=20 must drop).
   Commit toolbar refresh keeps its exact current icon/spin visuals.
6. New unit test `tests/webview/unit/toolbar-icon-button.test.tsx`: tooltip
   gating by settings (tooltipsEnabled false → no tooltip), aria-pressed,
   disabled, spin class/style presence, click handler fires.
7. Existing tests untouched and green: `ui-smoke.test.tsx` (Toolbar),
   `stash-tab.test.tsx`, `shelf-tab.test.tsx`.

### Key paths (read first)

`commit-panel/components/{Toolbar,StashToolbar,ShelfToolbar}.tsx`,
`shared/components/{Icons,RefreshButton,iconStyles,ContextMenu}.tsx`,
`shared/settings.ts`, `commit-panel/theme.ts` (toolbarGhost variant — read only),
`tests/webview/unit/{stash-tab,shelf-tab,ui-smoke}.test.tsx` (toolbar assertions).

### Non-goals (phase)

Tree components, RefreshButton internals beyond the keyframes import, ContextMenu.

---

## Phase 2 — One changes-tree adapter, expansion helpers, icon shims, dead code

Seam: thin adapters over `FileTreeRows` + tab-level expansion state helpers.

### Deliverables

1. New `src/webviews/react/shared/components/ChangesFileTree.tsx`: one generic
   adapter over `FileTreeRows` replacing both `ShelfFileTree`
   (`commit-panel/components/ShelfFileTree.tsx`, 118L) and `StashFileTree`
   (`commit-panel/components/StashList.tsx:267-318`). Caller supplies the file
   list already mapped to the `TreeRowFile` shape plus wiring callbacks
   (select/activate/contextMenu/dragStart optional), `groupByDir`, `depth`,
   selected-id, `isDirectoryCollapsed`, folder icons. Both call sites
   (`ShelfTab` subtree render, `StashList`) migrate; `ShelfFileTree.tsx` deleted;
   `StashFileTree` removed from `StashList.tsx`. Per-domain mapping fns
   (`displayFile` for shelf entries) stay at call sites.
2. New `src/webviews/react/shared/treeExpansion.ts`: `directoryKey(id, dirPath)`
   and `toggleMember(set, key)` (the character-identical copies at
   `StashTab.tsx:89-98` and `ShelfTab.tsx:188-195` deleted, both tabs import
   shared), plus an expand-all/collapse-all key-set builder ONLY if it falls out
   naturally from the two tabs' builders (`StashTab.tsx:354-362`,
   `ShelfTab.tsx:571-578`) — do not force a shared abstraction if their shapes
   genuinely differ; identical parts only.
3. Layering fix: `shared/components/FileTreeRows.tsx:10-11` must stop importing
   from `commit-panel/`. Move `StatusBadge.tsx` (69L) to
   `shared/components/StatusBadge.tsx`; delete the pass-through
   `commit-panel/components/FileTypeIcon.tsx` (19L) and use shared
   `TreeIcons.TreeFileIcon` (memoized equivalently) directly in `FileTreeRows`;
   update all commit-panel importers of `StatusBadge`/`FileTypeIcon`.
4. Delete the re-export shim `commit-panel/components/TreeIcons.tsx` (1 line);
   its importers (`FolderRow.tsx`, tests, any others) import
   `shared/components/TreeIcons` directly.
5. Delete dead `commit-panel/components/StashRow.tsx` (160L, zero src importers)
   and its direct mount in `tests/webview/unit/ui-smoke.test.tsx:750` (remove
   that test block only).
6. New unit test `tests/webview/unit/changes-file-tree.test.tsx`: renders
   ChangesFileTree in both a stash-shaped and shelf-shaped configuration —
   selection highlight, activate callback, collapsed-directory behavior,
   context-menu callback, drag wiring presence/absence.
7. Existing tests green, updated import paths only where files moved:
   `shelf-file-tree.phase6.test.tsx`, `shelf-tree-icons.test.tsx`,
   `tree-indent-guides.test.tsx`, `tree-single-selection.test.tsx`,
   `stash-tab.test.tsx`, `shelf-tab.test.tsx`, `shelfLocalization.test.ts`
   (references "ShelfFileTree.tsx" by filename at L20 — update the reference to
   the new file, keeping the localization assertion equivalent).

### Key paths (read first)

`commit-panel/components/{ShelfFileTree,StashList,ShelfList,StashTab,ShelfTab,StashRow,FileTypeIcon,StatusBadge,TreeIcons}.tsx`
(StashTab/ShelfTab are large — read the expansion-state and subtree-render
regions), `shared/components/{FileTreeRows,TreeIcons}.tsx`, `shared/fileTree.ts`,
the test files in deliverable 7.

### Non-goals (phase)

Commit tab's `FileTree` stack (phase 4), FileTreeRows internal rendering changes
beyond the two imports (wiring extension is phase 3), toolbar code.

---

## Phase 3 — FileTreeRows wiring extension (additive, no consumer changes)

Seam: `shared/components/FileTreeRows.tsx` capability growth so phase 4 can
migrate the commit tree. Purely additive — existing consumers (shelf, stash,
commit-info, ChangesFileTree) unchanged and pixel-identical.

### Deliverables

1. Extend `FileTreeRows` options/wiring with optional capabilities, all
   defaulting to today's behavior when absent (derive exact prop shapes from
   `FileRow.tsx`/`FolderRow.tsx` so phase 4 is a drop-in):
   a. Checkbox slot: per-file `checked` + `onToggleCheck`, per-folder tri-state
      (`isAllChecked`/`isSomeChecked` + `onToggleFolderCheck`),
      `checkboxVisibility: "visible" | "hidden" | "none"` matching
      `FileRow.tsx:24-47` / `FolderRow.tsx:17-32` semantics, rendered with
      `VscCheckbox` (move `commit-panel/components/VscCheckbox.tsx` to
      `shared/components/VscCheckbox.tsx`, update importers incl. tests).
   b. Drag wiring: `draggable`, `onFileDragStart/End`, drag-selected visual
      state, and the `dataStashFile`/`dataShelfFile`-style data attributes —
      generalize via the existing `dataAttributeProps` mechanism
      (`FileTreeRows.tsx:354-359`) rather than named props if cleaner.
   c. Row state: `isCurrent` highlight parity with `FileRow.tsx`.
   d. Metrics prop: optional indent-metrics object (step/base/guide offsets) with
      today's FileTreeRows constants as default, so the commit tree can pass its
      own (`IndentGuides.tsx` uses INDENT_STEP=18, INDENT_BASE=20, GUIDE_BASE=28,
      SECTION_GUIDE=17; FileTreeRows uses the constants at its L23-36). No
      existing consumer passes metrics in this phase.
2. Export the row subcomponents (`TreeFolderRow`, `TreeFileRow`,
   `TreeIndentGuides`) so they are directly unit-testable.
3. New unit tests extending `tests/webview/unit/` coverage: checkbox tri-state
   rendering + toggle callbacks, drag attribute wiring, metrics prop changes
   indent offsets, and a no-options test proving default rendering is unchanged
   (assert on rendered markup of a small tree).
4. All existing tests green with zero modifications (additive API), except
   VscCheckbox import-path updates where tests import it directly.

### Key paths (read first)

`shared/components/FileTreeRows.tsx` (whole file),
`commit-panel/components/{FileRow,FolderRow,VscCheckbox,IndentGuides}.tsx`
(the contracts being absorbed), `tests/webview/unit/tree-indent-guides.test.tsx`.

### Non-goals (phase)

Changing `FileTree.tsx` or any consumer; deleting anything except moving
VscCheckbox; SectionHeader.

---

## Phase 4 — Migrate commit-panel FileTree onto shared stack; delete Stack A

Seam: `FileTree.tsx` internals + section headers. Highest risk: checkbox
tri-state, drag-to-shelf/stash, keyboard/a11y, expand/collapse signals.

### Deliverables

1. `FileTree.tsx` renders its three sections' entries via `FileTreeRows` (with
   phase-3 checkbox/drag/metrics wiring, commit-tree metrics passed explicitly to
   preserve exact indentation), keeping its section split
   (changes/unversioned/ignored), expansion state, `expandAllSignal`/
   `collapseAllSignal` reconciliation, and drag-to-track behavior byte-for-byte.
2. Delete `FileTreeEntries.tsx` (133L), `FileRow.tsx` (236L), `FolderRow.tsx`
   (128L), `IndentGuides.tsx` (56L). No remaining importers (update
   `ui-smoke.test.tsx` mounts of FolderRow/IndentGuides to target the shared
   exports with equivalent assertions — do not delete the assertions).
3. One shared `SectionHeader`: promote
   `commit-panel/components/SectionHeader.tsx` (128L, checkbox + drag-over) to
   `shared/components/SectionHeader.tsx` with checkbox/drag-over optional;
   `CommitInfoPane.tsx:303-365` private SectionHeader replaced by it (its
   no-checkbox rendering preserved exactly); commit-panel imports update.
4. `useFileTree.ts` stays (it feeds `descendantFiles` for tri-state) — adjust
   types only if the shared wiring needs it.
5. Tests: `ui-smoke.test.tsx` FileTree/FolderRow/IndentGuides/SectionHeader
   blocks updated to the shared components with equivalent-or-stronger
   assertions; `react-context.integration.test.tsx` drag-to-track suite and
   `shelf-drag.test.tsx` green UNMODIFIED (they exercise public FileTree
   behavior); `low-coverage-components.test.tsx` (CommitInfoPane header) green.
6. Post-delete hygiene: `deps:check:strict` (knip) green — no orphaned exports
   left behind.

### Key paths (read first)

`commit-panel/components/{FileTree,FileTreeEntries,FileRow,FolderRow,SectionHeader,IndentGuides}.tsx`,
`commit-panel/hooks/{useFileTree,useCheckedFiles,useFileDrag}.ts`,
`shared/components/FileTreeRows.tsx` (post-phase-3),
`commit-info/CommitInfoPane.tsx:238-432`,
`tests/webview/unit/ui-smoke.test.tsx`, `tests/webview/unit/shelf-drag.test.tsx`,
`tests/integration/webviews/react-context.integration.test.tsx:607-830`.

### Non-goals (phase)

Behavior changes of any kind; expansion-state refactors beyond what phase 2
shipped; CommitInfoPane changes beyond the SectionHeader swap.
