# Spec: PyCharm-parity Shelf context menu and toolbar

Frozen work order. Corrects a parity defect found after the shelve build shipped:
patch actions were built as toolbar buttons because the original plan specified
patch *behavior* but never specified the *entry point surface*, and verification
compared the Shelf tab against IntelliGit's own Stash tab instead of against
PyCharm.

Reference: user-supplied PyCharm screenshots of the Shelf tool window
(right-click menu on a shelved file, and the Shelf tab toolbar). The user is the
authority on PyCharm behavior for this spec; no live IDE is available in this
environment.

## Goal

The Shelf tab's right-click menu and toolbar match PyCharm's Shelf tool window.
All patch actions move off the toolbar into the context menu. The toolbar
reduces to PyCharm's four icon buttons plus an overflow menu. Shelf files gain
the same right-click menu they have in PyCharm, which they currently lack
entirely.

## Current state (verified, do not re-derive)

- `src/webviews/react/commit-panel/components/ShelfToolbar.tsx` — 141 lines,
  eleven text buttons: Import Patches…, Create Patch…, Unshelve, Unshelve
  Silently, Show Diff, Compare with Local, Rename, Delete, spacer,
  Show/Hide Already Unshelved, Clean Up.
- `ShelfTab.tsx:452-468` — active-shelf context menu: Unshelve, Unshelve
  Silently, Rename, Delete, separator, Show Diff, Compare with Local.
- `ShelfTab.tsx:711-719` — a *separate* ghost-shelf menu: Restore, Show Diff,
  Compare with Local, Delete.
- `ShelfFilePane.tsx` — 136 lines, **no `onContextMenu` handler at all**. Owns
  `isOpen` (line 40) and `collapsedDirectories` (line 42) as internal state.
- `ShelfRow.tsx:7` — `ShelfContextAction` union, seven members.
- `ContextMenu.tsx` (shared) — already supports `icon`, `hint` (right-aligned
  trailing text), `disabled` (greys the row), `separator`, `submenu`. **No
  changes to this component are permitted or needed.**
- `commitMenu.tsx` — the reference idiom for a menu builder module: a
  `getXMenuItems()` function returning `MenuItem[]`, with local `icon*()` SVG
  helpers. `iconPatch()` exists there at line 114 but is not exported.
- `shelfService.exportPatch()` (`src/services/shelfService.ts:287`) returns
  `Promise<Buffer>`.
- `showShelfDiffFromPanel` (`src/views/shelfDiffActions.ts:31`) calls
  `vscode.diff` with four arguments and no `TextDocumentShowOptions`.
- `groupByDir` is app-level state owned by `CommitPanelApp.tsx:25`, persisted
  through `vscode.setState`, already toggled from the Commit tab's
  `Toolbar.tsx:61` menu.
- `react-icons` is already a dependency (imported by `commitMenu.tsx`).

## Part A — The context menu

Exact item order, matching the PyCharm screenshot with the two IntelliGit
entries the user chose to keep (`Unshelve Silently` has no PyCharm counterpart
and stays at position 2):

| # | Label key | Hint | Icon | Disabled when |
| --- | --- | --- | --- | --- |
| 1 | `shelf.action.unshelveMenu` | ⇧⌘U / Ctrl+Shift+U | unshelve | files not current |
| 2 | `shelf.action.unshelveSilently` | — | — | files not current |
| 3 | `shelf.action.restore` | — | — | lifecycle is not `applied` |
| 4 | `common.showDiff` | ⌘D / Ctrl+D | diff | no selection |
| 5 | `shelf.action.showDiffNewTab` | — | diff | no selection |
| 6 | `shelf.action.compareWithLocal` | — | — | no selection |
| 7 | `shelf.action.createPatch` | — | patch | no exportable entries |
| 8 | `shelf.action.copyPatchToClipboard` | — | — | no exportable entries |
| 9 | `shelf.action.importPatches` | — | — | never |
| — | *separator* | | | |
| 10 | `shelf.action.rename` | F2 | — | no selection |
| 11 | `shelf.action.delete` | ⌫ / Del | — | no selection |

Rules:

1. **One menu, not two.** Delete the separate ghost-shelf menu at
   `ShelfTab.tsx:711-719`. Lifecycle drives `disabled` flags on the single item
   list. `Restore` is present-but-greyed for a normal shelf (this is exactly
   what PyCharm shows) and enabled for an applied/ghost shelf. When `Restore` is
   enabled, `Unshelve`/`Unshelve Silently` are disabled, and vice versa.
2. **Extract the builder.** `ShelfTab.tsx` is 781 lines against the project's
   800-line ceiling. The item list moves to a new
   `src/webviews/react/commit-panel/components/shelfMenu.tsx` exporting
   `getShelfMenuItems(context): ShelfMenuItem[]`, modeled on `commitMenu.tsx`.
   Inlining the list in `ShelfTab.tsx` breaches the ceiling and is rejected.
3. **Icons.** Reuse the `commitMenu.tsx` SVG idiom. Do not add a dependency; do
   not copy the stash glyph. If `iconPatch()` is shared, export it from a small
   shared module rather than duplicating the path data.
4. `ShelfContextAction` in `ShelfRow.tsx:7` gains `showDiffNewTab`,
   `createPatch`, `copyPatchToClipboard`, `importPatches`.

## Part B — The same menu on shelf files

PyCharm's screenshot is a right-click on a *file inside a shelf*, and it shows
the same menu. `ShelfFilePane` currently has no context menu.

- `ShelfFilePane` gains an `onContextMenu?: (entry, x, y, target) => void` prop,
  following the existing `onFileActivate` / `onDragStart` prop shape.
- Right-click on a file row opens the same menu from `getShelfMenuItems`.
- File-scoped semantics: `Show Diff`, `Show Diff in a New Tab`,
  `Compare with Local`, `Create Patch…`, and `Copy as Patch to Clipboard` act on
  **that file's `changeId` only**. `Unshelve`, `Unshelve Silently`, `Restore`,
  `Rename…`, `Delete…` act on the owning shelf, as in PyCharm.
- Keyboard parity: the `ContextMenu` key (and Shift+F10) opens it, matching
  `ShelfRow.tsx:82`.

## Part C — The toolbar

Reduce `ShelfToolbar.tsx` to PyCharm's four icon buttons plus an overflow menu:

| Control | Behavior | Disabled when |
| --- | --- | --- |
| Unshelve (icon) | same as menu item 1 | files not current |
| Group by (icon) | toggles the existing app-level `groupByDir`; renders a pressed/active state when on | never |
| Expand all (icon) | expands every directory in the shelf file pane and opens its section | no files |
| Collapse all (icon) | collapses every directory and closes the section | no files |
| ⋮ Overflow | opens a `ContextMenu` anchored to the button rect | never |

Overflow menu contents — the list-level actions that have no PyCharm per-shelf
context-menu equivalent:

- `shelf.action.showAlreadyUnshelved` / `shelf.action.hideAlreadyUnshelved`
  (toggle, same label swap as today)
- `shelf.action.cleanUp`

Every other button currently on the toolbar (Import Patches, Create Patch,
Unshelve Silently, Show Diff, Compare with Local, Rename, Delete) is **removed
from the toolbar** — the context menu is now their only surface.

Rules:

1. **Expand/Collapse all requires lifting state.** `collapsedDirectories` and
   `isOpen` currently live inside `ShelfFilePane` (lines 40, 42). Lift both to
   `ShelfTab` and pass value + setter down. Do not reach into the child with a
   ref or imperative handle.
2. **Group by reuses existing state.** Thread the existing `groupByDir` /
   `setGroupByDir` from `CommitPanelApp` through `RepositoryAccordion` to
   `ShelfTab`. Do not introduce a second, shelf-local grouping flag — the Commit
   tab toggle and the Shelf toolbar toggle must stay the same value.
3. **Documented divergence.** PyCharm's Shelf tab is a single tree
   (changelist → files) so its Expand/Collapse all act on changelist nodes.
   IntelliGit uses a two-pane layout (shelf list above, file pane below), so
   Expand/Collapse all act on the file pane's directory tree. Record this in the
   parity matrix (Part G). Do not restructure the tab into a tree — out of
   scope.
4. Icon buttons carry `aria-label` and a tooltip using the same label text;
   keep the existing `getSettings()` tooltip gating from `ShelfToolbar.tsx`.

## Part D — Keyboard shortcuts

The hints in Part A must be real. Implement in-webview key handling on the shelf
list and file pane, scoped so it never fires while a dialog or inline rename
editor has focus:

| Key | Action |
| --- | --- |
| F2 | rename selected shelf |
| Delete / Backspace | delete selected shelf |
| Ctrl/Cmd+D | show diff |
| Ctrl/Cmd+Shift+U | unshelve |

Platform: render `⇧⌘U` / `⌘D` on macOS and `Ctrl+Shift+U` / `Ctrl+D` elsewhere,
detected once from the webview environment. **A hint must never be rendered for
a binding that is not wired.** If a binding cannot be implemented safely, drop
its hint rather than showing a false one.

## Part E — New host capabilities

Two new actions, both small. Follow the existing `shelfExportPatch` /
`shelfImportPatch` path through `commitPanelMessages.ts` →
`commitPanelActions.ts` → both view providers.

1. **Copy as Patch to Clipboard.** New message
   `shelfCopyPatchToClipboard { shelfId, changeIds?, expectedGeneration }`.
   Host calls the existing `shelfService.exportPatch()` (already returns a
   `Buffer`) and writes `buffer.toString("utf8")` via
   `vscode.env.clipboard.writeText`. No new service method. No file dialog.
   Report success/failure through the existing completion channel.
2. **Show Diff in a New Tab.** Extend `ShelfDiffMode` handling in
   `showShelfDiffFromPanel` with a `newTab: boolean` argument that passes
   `{ preview: false }` as `vscode.diff`'s fifth `TextDocumentShowOptions`
   argument, pinning a real editor tab instead of a preview tab. The existing
   `Show Diff` path keeps its current behavior byte-for-byte.

Both must be wired in **both** `CommitPanelViewProvider.ts` and
`UndockedViewProvider.ts`. The undocked provider is a frequent miss.

## Part F — Tests

- `tests/webview/unit/shelf-tab.test.tsx:400-438` currently asserts
  `Create Patch…` and `Import Patches…` as **toolbar buttons**. These tests
  encode the defect. Rewrite them against the context menu.
- New coverage required:
  - Exact context-menu item list, order, and separator position for an active
    shelf and for a ghost shelf (assert `Restore` greyed vs enabled).
  - The menu opens from a **file row** and its diff/patch actions carry that
    file's `changeId`, while rename/delete carry the shelf id.
  - Toolbar renders exactly four icon buttons plus overflow; the removed actions
    are absent from the toolbar.
  - Expand all / Collapse all change the rendered directory rows.
  - Group by toggle and the Commit tab toggle stay in sync (same state).
  - `shelfCopyPatchToClipboard` posts with the right payload and the host writes
    the patch text to the clipboard.
  - Show Diff in a New Tab passes `{ preview: false }`; plain Show Diff does not.
  - Each rendered shortcut hint has a working key handler.
- Keep the whole suite green. Do not weaken existing shelf assertions to pass.

## Part G — i18n and docs

New keys, added to **all 12 locales** (`en`, `de`, `es`, `fr`, `ja`, `ko`, `pl`,
`pt-br`, `pt-pt`, `ru`, `zh-cn`, `zh-tw`) in `src/webviews/i18n/`:

- `shelf.action.showDiffNewTab` — "Show Diff in a New Tab"
- `shelf.action.copyPatchToClipboard` — "Copy as Patch to Clipboard"
- `shelf.action.groupBy` — "Group by Directory"
- `shelf.action.expandAll` — "Expand All"
- `shelf.action.collapseAll` — "Collapse All"
- `shelf.action.moreOptions` — "More Options"

Run `bun run l10n:sync` so
`docs/localization/localization_translation_review.csv` stays valid, and confirm
`bun run l10n:validate` passes. Translations must be real, not English
placeholders.

Update `docs/shelve/pycharm-parity-matrix.md`: add a **UI surface** section with
one row per action recording which surface it lives on (context menu, toolbar,
overflow, command palette). The absence of placement rows is the root cause of
this defect; the matrix must cover placement from now on, not only semantics.

## Constraints

- Do not modify `PLAN.md`, `PLAN-REVIEW-LOG.md`, `REVIEW_PROMPT`, `.claude/**`,
  `.gitnexus/**`, `.github/**`, or `.githooks/**`.
- Do not modify `ContextMenu.tsx` — it already supports everything needed.
- Do not touch the Stash tab or its components. Shared components
  (`FileRow`, `FolderRow`, `SectionHeader`, `Toolbar`) may only gain **optional**
  props.
- No new runtime dependencies.
- Every file stays under 800 lines. TypeScript strict. Immutable state updates
  (new objects, never mutate).
- No `git stash`, no commits, no pushes.

## Non-goals

- Restructuring the Shelf tab into a single PyCharm-style changelist tree.
- A "Recently Deleted" node (visible in the PyCharm screenshot; separate work).
- Changing the Commit tab's or Stash tab's own toolbars or menus.
- Adding `Create Patch…` to the Commit tab's local-changes file menu (a real
  parity gap, tracked separately).
- Changing shelve/unshelve semantics, storage, or the recovery system.

## Proof

Run and include full output:

```
bun run typecheck && bun run lint && bun run l10n:validate && bun test
```

A green run with the Part F tests present is the definition of done. Report any
deviation from this spec with its reason rather than redesigning silently.
