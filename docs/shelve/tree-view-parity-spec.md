# Spec: PyCharm-parity expandable tree for the Shelf and Stash tabs

Frozen spec. Phase 8 of the shelve-parity work, following
`docs/shelve/shelf-menu-parity-spec.md` (Phase 7).

## Why

The Shelf and Stash tabs are master-detail: a fixed-height list of entries on
top, a drag-resizable splitter, and a lower pane showing the files of the one
selected entry. The Commit tab is not — it is a header row followed by its
files.

PyCharm's Shelf tool window is a single tree. Each shelf is a header row
carrying its name, file count and creation date; the row expands in place to
reveal that shelf's file tree. Several shelves can be expanded at once.

The user asked for that shape in both the Shelf and the Stash tab, and for the
shelf date to be formatted the way PyCharm formats it.

## Goal

Shelf and Stash each render one scrollable tree. Every entry is a header row
that expands and collapses in place to show its own files. The splitter and
the lower detail pane are gone from both tabs. Shelf rows show
`<name>   <N files>, <M/D/YY, h:mm AM>`.

## Part A — Shelf data (files ship with the list)

`shelfService.listShelves()` at `src/services/shelfService.ts:432-449` already
reads every shelf's current manifest (`readCurrentShelfManifest(id)` at line
444) to build each summary, and `ShelfPersistenceContract` carries
`{ metadata, files }`. The files are read and then discarded. Ship them.

1. `ShelfSummary` (`src/services/shelfServiceOperations.ts:15`) gains
   `readonly files: readonly ShelfFileEntry[]`.
2. `shelfService.ts:445` returns `{ id, generation, metadata: manifest.metadata,
   files: manifest.files }`.
3. `ShelfEntry` (`src/webviews/protocol/commitPanelMessages.ts:15`) gains
   `files: ShelfFileEntry[]`.
4. `CommitPanelRepositorySnapshot.shelfFiles` is **removed**. Every consumer
   reads `shelves.find(s => s.id === …)?.files` instead.
5. Both view providers drop their per-selection shelf-file state:
   `CommitPanelViewProvider.shelfSnapshotForRuntime` (line 538) stops calling
   `getShelfFiles`; `runtime.shelfFiles` and `UndockedViewProvider.shelfFiles`
   (line 204) are deleted along with every read and reset of them.
   `selectShelf` keeps recording `selectedShelfId` and nothing else.
6. `ShelfService.getShelfFiles` stays — `src/views/shelfDiffActions.ts` and the
   host actions still use it. Only the snapshot path stops calling it.

**No extra I/O is introduced by this part.** If profiling ever shows the
snapshot payload is too large, that is a later, measured change.

## Part B — Stash data (lazy, cached by hash)

Stash file lists cost three `git stash show` subprocesses per entry
(`src/git/operations.ts:897-926`). Eager-loading every stash on every panel
refresh is a real regression and is **out of scope**.

Stash keeps loading one entry at a time, over the existing `stashSelect`
message — **no protocol change**. The webview accumulates the results:

1. `StashTab` holds `filesByHash: Record<string, WorkingFile[]>`.
2. Whenever a snapshot arrives with `selectedStashIndex === i` and a settled
   `stashFiles`, the entry is cached under `stashes[i].hash`.
3. Expanding a stash row posts `stashSelect` for that index (expansion implies
   selection, as in PyCharm) unless its hash is already cached.
4. **The key is `stash.hash`, never `stash.index`** — indices shift when a
   stash is pushed or dropped, and an index-keyed cache would show one stash's
   files under another's row.
5. A row whose files are still loading renders one `t("common.loading")` row
   beneath its header.

Consequence, accepted: a stash row's file count is unknown until it has been
expanded once. Until then its header shows the date only, no count. Shelf rows
always show the count because Part A makes it free.

## Part C — The tree

Both tabs replace `<List height/> + <splitter/> + <FilePane flex=1/>` with one
container:

```
<Box role="tree" flex={1} overflowY="auto">      // was role="listbox"
  per entry:
    <EntryRow role="treeitem" aria-expanded aria-level={1} aria-selected>
      <Twisty/> <Name/> <Meta/>
    </EntryRow>
    {expanded ? <Box role="group"> …file tree at depth 1… </Box> : null}
</Box>
```

- Delete from both tabs: the resize handle, `useDragResize` usage,
  `MIN_SHELF_LIST_HEIGHT`, `SHELF_SPLITTER_STEP`,
  `SHELF_LOWER_PANE_RESERVED_HEIGHT`, `MIN_STASH_LIST_HEIGHT`,
  `stashListHeight`/`stashListMaxHeight`, the `height`/`maxHeight` props on
  `ShelfList` and `StashList`, and the `a11y.resizeShelfList` /
  `a11y.resizeStashList` separators.
- `ShelfFilePane` and `StashFilePane` stop being panes. Reuse their file-tree
  rendering as a subtree rendered under one entry row; the `SectionHeader` they
  used to draw is replaced by the entry row itself. `FileRow`, `FolderRow` and
  `SectionHeader` are **not modified** — they carry no `role`, so nesting them
  inside `role="group"` is valid.
- File rows sit one indent level deeper than their entry row.
- Expansion state per tab: `Set<string>` of expanded shelf ids / stash hashes.
  Directory collapse state stays per entry, keyed by entry id/hash plus
  directory path, so expanding two shelves cannot share one directory's state.
- Keyboard: the existing Home/End/ArrowUp/ArrowDown roving-tabindex navigation
  over entry rows is preserved. ArrowRight expands a collapsed row, ArrowLeft
  collapses an expanded one — standard tree keys.
- Selection is preserved and still drives the context menu and every existing
  shelf/stash action. Selecting a row does not expand it; expanding a row does
  select it.

## Part D — The entry row

Shelf (`ShelfRow.tsx`): the trailing `{shelf.metadata.lifecycle}` text is
replaced by the PyCharm meta line:

```
t("common.filesAndDate", {
    files: t("common.fileCount", { count: shelf.files.length }),
    date: formatDateTime(new Date(shelf.metadata.createdAt).toISOString()),
})
```

- `formatDateTime` is `src/webviews/react/shared/date.ts`; its defaults already
  produce PyCharm's `2/22/26, 8:55 AM`. The Stash tab already uses it — the
  Shelf tab must use the same function, not a second formatter.
- `createdAt` is optional. When it is absent, render the file count alone.
- Dropping the lifecycle text loses nothing: ghosts are already conveyed by
  their reduced opacity and the "Already Unshelved" group header.

Stash (`StashList.tsx` row): keeps `parseStashMessage`, the branch label and
`formatDateTime(stash.date)`. It gains the file count in front of the date
**only once that stash's files are cached**, using the same
`common.filesAndDate` composition.

## Part E — Toolbar

`shelf.action.expandAll` / `shelf.action.collapseAll` and their stash
counterparts now operate on the whole tree: expand-all expands every entry row
**and** every directory inside every entry; collapse-all collapses every entry
row and clears the per-entry directory state. They are enabled whenever the tab
has at least one entry.

## Part F — i18n

One new webview key in all 12 `src/webviews/i18n/*.json`:

```
"common.filesAndDate": "{files}, {date}"
```

CJK locales use their own comma (`、` / `，`) where that is the correct
separator. `common.fileCount` already exists with `one`/`other` plural forms in
every locale and must be reused, not duplicated.

Remove any key left orphaned by this change (`shelf.filePane.*`, `stash.files`,
`a11y.resizeShelfList`, `a11y.resizeStashList` are the likely candidates —
verify each is genuinely unreferenced before deleting). Run `bun run l10n:sync`
and `bun run l10n:validate`.

## Out of scope

- Any change to the context menu built in Phase 7, or to `shelfMenu.tsx`.
- Any change to `FileRow`, `FolderRow`, `SectionHeader`, `ContextMenu`.
- Eager loading of stash files, or any new git invocation.
- New protocol messages. Part A removes a field; Part B adds nothing.
- "Recently Deleted" as a distinct node — the existing "Already Unshelved"
  ghost group already covers it and stays as it is.
- Virtualization, new dependencies, drag-and-drop changes.

## Proof

`bun run typecheck && bun run lint && bun run l10n:validate && bun run test`,
plus `bunx prettier --check` on every touched file — `lint` is eslint-only and
does not catch formatting drift.

Tests that assert the old shape must be updated, not deleted: the seven files
that reference `shelf-list`, `shelf-file-pane`, `stash-list`,
`stash-file-pane`, `data-shelf-id` or `data-stash-index` are
`shelf-menu-parity`, `shelf-drag`, `shelf-file-pane.phase6`, `shelf-tab`,
`commit-panel-multi-repo`, `unshelve-remove-default` and `stash-tab`.

New coverage required:
1. A shelf row shows `N files, <date>` from `files.length` and `createdAt`.
2. Two shelves expanded at once each show their own files.
3. Collapsing a shelf hides its files and leaves the other shelf's expanded.
4. Expand-all expands every entry and every directory; collapse-all reverses it.
5. A stash row's files load on first expansion and are served from the cache on
   the second, with no second `stashSelect` post.
6. **The stash cache is keyed by hash:** expand stash A, then push a new stash
   so A's index shifts, and assert A's row still shows A's files.
