# Branch, File Status, and Refresh Improvements

Date: 2026-06-07
Branch: `codex/branch-status-refresh-plan`
Status: Planning and investigation only. This document does not implement code.

## Goal

Address five requested behavior changes in IntelliGit:

1. Select multiple branches with Command-click and delete them from a single
   context-menu action. When local branches are deleted, the follow-up toast
   offering remote tracked-branch deletion must appear once per deleted branch.
2. Drag files from `Unversioned Files` into `Changes`, matching the PyCharm /
   IntelliJ workflow.
3. Show the blue refresh indicator only for an explicit manual refresh action,
   not for implicit watcher-driven refreshes.
4. When the IntelliGit extension view is opened and changed files already exist,
   show them without requiring a manual refresh or switching to another
   extension and back.
5. Make refresh feel seamless: changed files should not disappear briefly during
   refresh, and the refresh path should be faster and less visually disruptive.

The guiding rule is spec compliance first: preserve the exact requested behavior
before adding hardening or optimization. In particular, do not silently skip
branches, files, or refresh work to improve perceived performance.

## Investigation Method

Code inspected:

- Branch tree UI and menu:
  - `src/webviews/react/BranchColumn.tsx`
  - `src/webviews/react/branch-column/components/BranchTreeNodeRow.tsx`
  - `src/webviews/react/branch-column/menu.ts`
  - `src/webviews/protocol/commitGraphTypes.ts`
  - `src/commands/branchCommands.ts`
  - `src/services/gitHelpers.ts`
- Commit panel files and status:
  - `src/webviews/react/commit-panel/components/FileTree.tsx`
  - `src/webviews/react/commit-panel/components/FileRow.tsx`
  - `src/webviews/react/commit-panel/components/CommitTab.tsx`
  - `src/webviews/protocol/commitPanelMessages.ts`
  - `src/views/panelFileActions.ts`
  - `src/git/operations.ts`
  - `src/git/workingTree.ts`
- Refresh and view lifecycle:
  - `src/views/CommitPanelViewProvider.ts`
  - `src/views/UndockedViewProvider.ts`
  - `src/views/RefreshService.ts`
  - `src/activation/repositoryMode.ts`
  - `src/activation/repositoryCommands.ts`

GitNexus was refreshed before use:

- `npx gitnexus status` initially reported a stale index.
- `npx gitnexus analyze` refreshed the index.
- `npx gitnexus analyze --force` was also run because one query reported
  degraded keyword search.
- Final indexed commit: `7228b79`.
- Final index size: 5,201 nodes, 11,224 edges, 199 clusters, 299 flows.

GitNexus impact summary for future code changes:

| Symbol | Risk | Direct blast radius |
| --- | --- | --- |
| `BranchColumn` | LOW | `CommitGraphPanel`, `UndockedApp` |
| `getBranchMenuItems` | LOW | No callers reported by impact, but source imports it from `BranchColumn` |
| `createBranchCommands` | LOW | `registerBranchCommands` |
| `showDeletedBranchActions` | LOW | single branch delete handler |
| `FileTree` | LOW | `CommitTab`, then docked and undocked commit panels |
| `stageFilesFromPanel` | HIGH | docked and undocked webview message handlers |
| `RefreshService.refreshCommitPanels` | HIGH | light refresh, full refresh, conflict UI refresh |
| `CommitPanelViewProvider.refreshData` | CRITICAL | manual refresh, ready handling, provider refresh, action refresh |
| `GitOps.getStatus` | CRITICAL | docked and undocked status refresh paths |

The HIGH and CRITICAL refresh/status items mean implementation should split
callers and add narrow methods rather than changing shared behavior in place.

## Current Architecture Findings

### Branch tree

The branch UI is single-selection today.

- `BranchColumn` accepts `selectedBranch: string | null`, which is the graph
  branch filter, not a branch-row multi-selection model.
- `BranchTreeNodeRow` computes selection with
  `selectedBranch === node.fullName`.
- Row click calls `onSelectBranch(node.fullName)`, which filters the graph.
- Row right-click passes exactly one `Branch` into `onContextMenu`.
- `getBranchMenuItems(branch, currentBranchName)` builds a context menu for one
  branch. It has only `Delete`, not `Delete Branches`.
- The webview protocol sends one branch:

```ts
{ type: "branchAction"; action: BranchAction; branchName: string }
```

- `registerRepositoryViewEvents` looks up a single branch by name and forwards
  to `vscode.commands.executeCommand("intelligit.${action}", { branch })`.

The backend delete path is much stronger than the frontend selection model:

- `intelligit.deleteBranch` already protects the current local branch.
- It checks whether a local branch is merged before selecting `git branch -d`
  versus `git branch -D`.
- It deletes remote branch rows with `git push <remote> --delete <branch>`.
- After local deletion, `showDeletedBranchActions` shows a toast with `Restore`
  and, when a tracked remote exists, `Delete Tracked Branch`.

The multi-delete implementation should reuse this safety logic. It should not
build a separate loose path that shells out to `git branch -D` for every name.

### File tree and unversioned files

The commit panel splits status rows by status code:

- `FileTree` treats `status !== "?"` as `Changes`.
- `FileTree` treats `status === "?"` as `Unversioned Files`.
- There is no drag/drop API in `FileTree`, `FileRow`, or `SectionHeader`.
- Existing host messages support `stageFiles` and `unstageFiles`, but no
  "track this unversioned file without staging content" action.

`GitOps.getStatus()` runs:

- `git status --porcelain=v1 -z -uall`
- `git diff --numstat`
- `git diff --cached --numstat`

`parseWorkingTreeStatus` then creates `WorkingFile` rows. Since grouping is
status-driven, moving an unversioned file into `Changes` must change Git status.

Verified Git behavior in a throwaway repo:

```text
before: '?? a.txt\0'
after git add -N -- a.txt: ' A a.txt\0'
```

That means `git add --intent-to-add -- <paths>` is the right primitive for
PyCharm-style drag from `Unversioned Files` to `Changes`: it makes the file a
tracked unstaged add in the UI without staging its contents for commit.

### Refresh behavior

The current refresh code mixes data refresh and visible refresh feedback.

- `CommitPanelViewProvider.refresh()` calls `refreshData(false)`.
- `refreshData(false)` sends `refreshing: true`, sets
  `intelligit.commitPanel.refreshing`, and enforces `MIN_VISIBLE_REFRESH_MS`
  before sending `refreshing: false`.
- `RefreshService.refreshCommitPanels()` is used by filesystem/Git watchers but
  calls `commitPanel.refresh()`, so implicit refreshes currently show the same
  blue refresh state as manual refresh.
- `CommitTab` also turns on local refresh feedback when `isRefreshing` changes.
- Existing tests currently encode the old behavior. For example,
  `tests/unit/view-providers.integration.test.ts` has a test named
  `CommitPanelViewProvider shows refreshing state during background refresh`.
  That test must change because the new requirement is the opposite.

The current lifecycle can also explain the "open IntelliGit and changed files do
not show" bug:

- `resolveWebviewView()` sets the HTML and immediately calls
  `refreshDataWithErrorHandling()`.
- The React app sends `ready` on mount, and `handleMessage("ready")` runs
  another `refreshData()` and `refreshGraphData()`.
- If a provider refresh happens before the React listener is attached, that
  message can be lost from the webview perspective.
- There is cached provider state (`this.files`, `this.stashes`), but there is no
  explicit "replay cached snapshot to a newly ready webview before slow refresh"
  method.
- The docked webview provider is registered without
  `retainContextWhenHidden: true`.
- There is no `onDidChangeVisibility` hook that refreshes or replays data when
  the IntelliGit container becomes visible.
- `refreshData` has no request sequence guard, so overlapping refreshes can post
  results out of order. The commit graph has sequence guards; the commit-panel
  status path does not.

The brief disappearance during manual refresh is not caused by the React reducer
intentionally clearing `files`; it keeps the existing state on `refreshing`.
The more likely causes are duplicate/cold webview startup, overlapping refresh
results, and visible refresh state being tied to every refresh path.

## Proposed Implementation

### 1. Multi-select branch deletion

#### Required behavior

- Command-click on macOS toggles a branch row into or out of the selected set.
- Ctrl-click should do the same on Windows/Linux for keyboard parity, but the
  macOS Command-click requirement is the contract.
- Right-clicking a selected branch keeps the selected set and shows a bulk menu.
- Right-clicking an unselected branch clears the set to that branch and shows the
  existing single-branch menu.
- For two or more selected branches, show `Delete Branches`.
- Current checked-out local branches must not be deleted.
- Deletions should run sequentially, not concurrently, to avoid Git ref lock
  conflicts and overlapping remote prompts.
- After each local branch deletion, show the existing tracked-remote cleanup
  toast for that branch, one by one.

#### UI changes

Keep graph filtering separate from branch-row selection.

Add local UI state to `BranchColumn`:

```ts
const [selectedBranchNames, setSelectedBranchNames] = useState<Set<string>>(new Set());
```

Rename the existing graph-filter concept in local variable names where helpful,
but avoid broad refactors. For example, keep the public prop as
`selectedBranch` for now, but treat it only as the graph filter.

Branch row click behavior:

- Plain click: preserve existing graph filter behavior and clear row
  multi-selection.
- Command/Ctrl click: toggle row multi-selection and do not change the graph
  filter.
- Keyboard: Space/Enter preserve existing activation. A follow-up can add
  keyboard multi-select, but it is not required for this request.

Branch row props should change from:

```ts
selectedBranch: string | null;
onSelectBranch: (name: string | null) => void;
```

to include selection-specific data:

```ts
graphFilteredBranch: string | null;
selectedBranchNames: Set<string>;
onBranchClick: (event: React.MouseEvent, name: string) => void;
```

This prevents the multi-select state from accidentally changing graph filters.

#### Menu changes

Keep `getBranchMenuItems` for single-branch menus.

Add a small bulk menu builder:

```ts
getBranchBulkMenuItems(branches: Branch[]): BranchMenuItem[]
```

For now, bulk mode should expose only deletion. Other actions such as checkout,
merge, rebase, rename, update, and push are ambiguous across multiple branches
and should not be included.

Add webview strings:

- `branch.menu.deleteBranches`: `Delete Branches`
- `branch.bulkDelete.currentBranchBlocked`
- `branch.bulkDelete.confirm`
- `branch.bulkDelete.summary`

Because these are user-facing English strings, the implementation branch must
run the localization validation commands from `AGENTS.md`.

#### Protocol and host changes

Preserve the existing single-action protocol and add a narrow bulk delete
message instead of overloading `branchAction`.

```ts
type CommitGraphOutbound =
  | { type: "branchAction"; action: BranchAction; branchName: string }
  | { type: "deleteBranches"; branchNames: string[] };
```

Add matching event emitters to:

- `CommitGraphViewProvider`
- `CommitPanelViewProvider`
- `UndockedViewProvider`

Forward branch names to a new command or helper after resolving them against
the latest branch snapshot. If any requested branch name is missing, reject with
a clear error instead of silently deleting only the remaining subset.

#### Backend delete flow

Do not duplicate the existing delete logic by copy/paste. Extract reusable
helpers from `createBranchCommands`:

- `validateBranchCanDelete(branch, currentBranchName, branches, executor)`
- `confirmBranchDelete(branch, currentBranchName, executor)`
- `deleteBranch(branch, executor)`
- `deleteBranchesSequentially(branches, deps)`

Batch behavior:

1. Resolve all names to current `Branch` objects.
2. Reject the batch before mutation if any selected local branch is the current
   branch.
3. For local branches, compute merge status up front and show one modal summary.
   If any branch is unmerged, the confirmation must make that explicit and use
   `Delete Anyway`.
4. Delete branches one at a time.
5. For each local branch, show `showDeletedBranchActions` before moving to the
   next branch so tracked remote deletion toasts appear one by one.
6. Refresh once after the batch completes, except when a follow-up tracked
   remote deletion action mutates remote state; that action can still refresh
   after its own Git command.
7. Report partial failure explicitly if a later branch fails after earlier
   branches were deleted. Do not claim the whole batch succeeded.

### 2. Drag unversioned files into Changes

#### Required behavior

Dragging a file from `Unversioned Files` onto `Changes` should make it appear
under `Changes`, like PyCharm/IntelliJ.

The correct Git operation is:

```bash
git add --intent-to-add -- <paths>
```

or equivalently:

```bash
git add -N -- <paths>
```

This marks untracked files as intent-to-add, so `git status --porcelain=v1 -z`
returns `A <path>` and the existing `FileTree` grouping moves the file into
`Changes` without staging file contents.

#### UI changes

Use native HTML drag/drop. Do not add a dependency.

Add drag metadata in `FileTree`:

- Only unversioned file rows are draggable for this operation.
- If the dragged file is checked and other checked files are also unversioned,
  drag all checked unversioned files.
- Otherwise drag only the file under the pointer.
- Folder drag can be added by collecting descendant unversioned files; this is
  useful but not required for the first implementation.

Add a drop target to the `Changes` section header and its empty-area boundary:

- Show a subtle drop-hover state.
- Reject drops if no dragged paths are unversioned.
- Send a host message only on valid drop.

#### Protocol and host changes

Add a narrow webview message:

```ts
{ type: "trackUnversionedFiles"; paths: string[] }
```

Add host action:

```ts
trackUnversionedFilesFromPanel(deps, pathsValue)
```

That action should:

1. Validate paths with `assertRepoPathArray`.
2. Re-check current status and reject any path that is no longer unversioned,
   unless it is already intent-to-add. This avoids silently acting on stale UI.
3. Call `gitOps.intentToAddFiles(paths)`.
4. Run a silent panel refresh.
5. Fire working-tree changed events.

Add `GitOps.intentToAddFiles(paths: string[])`:

```ts
await this.executor.run(withLiteralPathspecs(["add", "--intent-to-add", "--", ...paths]));
```

Use the existing literal pathspec helper pattern from `stageFiles`.

#### Optimistic UI

For the first implementation, prefer correctness over local optimistic mutation:
wait for Git to succeed and then refresh. If refresh still feels slow after the
refresh fixes below, add an optional pending state that visually moves the row
immediately but reconciles from the next host snapshot.

### 3. Blue refresh indicator only for manual refresh

#### Root cause

`refreshData(false)` currently means "visible refresh", but many non-manual
paths call methods that pass `false`:

- `CommitPanelViewProvider.refresh()`
- `RefreshService.refreshCommitPanels()`
- `RefreshService.debouncedLightRefresh()`
- `RefreshService.debouncedFullRefresh()`
- file/action side-effect refreshes through `refreshData()`

That is why watcher-driven or action-driven refreshes can show the blue refresh
icon.

#### Required behavior

Only explicit refresh commands should show refresh affordances:

- Commit panel toolbar refresh button.
- View title refresh command.
- Global `intelligit.refresh` command when invoked by the user.

Implicit refreshes should update data silently:

- filesystem watcher refresh
- Git index/refs watcher refresh
- VS Code Git repository state refresh
- refresh after staging, unstaging, drag/drop, rollback, shelve, commit, branch
  mutation, or repository activation

#### Implementation

Replace the boolean `silent` argument with an explicit mode, or add dedicated
methods to avoid changing every call ambiguously.

Recommended minimal API:

```ts
refreshVisible(): Promise<void>
refreshSilent(): Promise<void>
refreshData(options?: { visible: boolean }): Promise<void>
```

Then route callers:

- `refreshFromUserAction()` -> visible.
- `intelligit.refresh` command -> visible for the view title command, but use
  silent internal provider refreshes where possible after the command has shown
  progress.
- `RefreshService.refreshCommitPanels()` -> silent.
- `debouncedLightRefresh()` and `debouncedFullRefresh()` -> silent.
- action side-effect refresh callbacks -> silent.
- initial activation/ready refresh -> silent, after cached snapshot replay.

Update tests that currently expect background refresh to emit `refreshing`.
Add tests that prove implicit refresh sends `update` without `refreshing`.

### 4. Changed files must show when IntelliGit is opened

#### Root cause hypothesis

This is likely a lifecycle and message timing bug, not a Git status parsing
bug. The provider can refresh before the React listener is ready, and there is
no guaranteed cached-state replay when the webview becomes ready or visible.

#### Implementation

Add a commit-panel snapshot replay path:

```ts
private postCurrentCommitPanelSnapshot(): void
```

This should post the provider's cached `files`, `stashes`, `shelfFiles`,
`selectedShelfIndex`, icon data, and upstream state if any snapshot has been
loaded.

Change lifecycle:

1. `resolveWebviewView()` should attach the webview and set HTML.
2. It should not start an expensive duplicate refresh that can race the React
   `ready` listener.
3. On `ready`, immediately post the cached snapshot if one exists.
4. Then run a silent refresh to catch any missed filesystem changes.
5. Restore the commit draft after the snapshot so the text area is correct.

Add visibility handling:

```ts
webviewView.onDidChangeVisibility(() => {
    if (webviewView.visible) {
        this.postCurrentCommitPanelSnapshot();
        this.refreshData({ visible: false });
    }
});
```

Also register the commit panel provider with:

```ts
{ webviewOptions: { retainContextWhenHidden: true } }
```

This should be done for the commit panel first, not every webview, because the
changed-file list is the user-visible problem and retaining every webview has
memory cost.

Add a request sequence to `refreshData`:

```ts
const requestId = ++this.refreshSeq;
...
if (requestId !== this.refreshSeq) return;
```

This prevents older refreshes from overwriting newer status snapshots.

### 5. Seamless and faster refresh

#### Current bottlenecks

`refreshData` does more than changed-file status:

1. initializes icon theme data
2. runs `getStatus`
3. decorates working files
4. lists shelves
5. checks current branch upstream by calling `getBranches`
6. loads selected shelf files
7. calculates folder icons
8. updates count badges
9. posts the whole snapshot
10. waits up to `MIN_VISIBLE_REFRESH_MS` for visible refreshes

The slowest user-facing path is therefore not only `git status`; it includes
icons, stashes, upstream metadata, and sometimes graph refresh.

#### Implementation

Keep old file rows visible until a new status snapshot is ready.

Concrete changes:

- Do not clear `files` at refresh start.
- Add request sequencing so stale results cannot overwrite newer ones.
- Use visible refresh delay only for manual refresh.
- Decouple commit-panel toolbar refresh from graph refresh. A user pressing the
  Changes refresh button primarily wants changed files; graph refresh should not
  be in that path unless the command is the global extension refresh.
- Parallelize independent work inside `refreshData`:
  - `getStatus`
  - `listShelved`
  - upstream check
- Avoid full `getBranches` for every status refresh when branch data was already
  loaded by the refresh service. Prefer cached branch metadata or a narrower
  upstream probe.
- Reuse icon theme metadata unless the active theme changed. Theme listeners
  already exist; ordinary status refresh should not pay the full icon-theme cost
  if the theme fingerprint is unchanged.
- Consider a two-phase update only if measurements justify it:
  - phase 1 posts changed files as soon as status and icons are ready
  - phase 2 updates shelves/upstream metadata

Add development-only timing logs behind a setting or existing debug channel:

```text
status: 42 ms
decorateWorkingFiles: 8 ms
listShelved: 14 ms
currentBranchHasUpstream: 35 ms
folderIcons: 6 ms
postMessage: 1 ms
```

Do not add sampling or skip work silently. If a repository is too large or a Git
command fails, show a bounded error or warning as the existing GitOps warning
path does.

## Criteria-to-Tests Mapping

| Requirement | Tests to add or update |
| --- | --- |
| Command-click selects multiple branches | React test for `BranchColumn` toggling selection with `metaKey`; Windows/Linux `ctrlKey` optional but recommended |
| Right-click selected set shows bulk delete | React test that context menu has `Delete Branches` when two selected branches are right-clicked |
| Right-click unselected branch uses single menu | React test preserving existing single-branch menu behavior |
| Bulk delete rejects current branch | Extension integration test for `deleteBranches` with current branch in payload |
| Bulk delete local branches sequentially | Unit/integration test asserting `git branch -d/-D` calls are ordered and no parallel Git calls occur |
| Bulk delete shows remote cleanup toasts one by one | VS Code window mock test asserting one `Deleted: {branch}` information message per local branch, in order |
| Remote branch rows delete with `git push --delete` | Integration test for selected remote branches |
| Drag unversioned into Changes | React drag/drop test emits `trackUnversionedFiles` for unversioned paths only |
| Intent-to-add Git command | `gitops.test.ts` unit test for `GitOps.intentToAddFiles` using literal pathspecs |
| Intent-to-add status appears in Changes | Parser test showing ` A file` becomes `status: "A", staged: false`, and `FileTree` groups it under `Changes` |
| Invalid/stale drag paths are rejected | Provider integration test for malformed path arrays and no-longer-unversioned files |
| Implicit refresh has no blue indicator | Replace existing background-refresh indicator test with a silent-refresh test |
| Manual refresh still shows blue indicator | Keep or adjust visible-refresh minimum-duration test for explicit refresh only |
| Opening IntelliGit shows cached changed files | Provider/webview integration test: refresh while hidden/no listener, resolve webview, send `ready`, expect cached `update` before new refresh completes |
| Overlapping refreshes cannot overwrite fresh data | Provider test with two delayed `getStatus` promises where the older result resolves last and is ignored |
| Refresh does not clear rows while loading | React/provider test asserting no empty `files` update is sent at refresh start |

## Validation Plan

For the implementation branch, run focused tests first:

```bash
bun run test -- tests/unit/webview-utils.test.ts
bun run test -- tests/unit/low-coverage-components.test.tsx
bun run test -- tests/unit/webview-apps.integration.test.tsx
bun run test -- tests/unit/view-providers.integration.test.ts
bun run test -- tests/unit/gitops.test.ts
bun run test -- tests/unit/refreshService.test.ts
```

Then run the standard validation set from `AGENTS.md`:

```bash
bun run format:check
bun run lint
bun run architecture:check
bun run react-doctor
bun run typecheck
bun run build
bun run test
```

If implementation adds or changes user-facing English strings, also run:

```bash
bun run l10n:validate
bun run l10n:audit
```

Do not claim any validation passed unless it was actually run.

## Phased Delivery

Phase 1: Refresh correctness and visual feedback

- Split visible and silent refresh.
- Add cached snapshot replay on `ready`.
- Add refresh request sequencing.
- Add visibility refresh for the commit panel.
- Update tests that currently expect background refresh indicators.

This phase directly addresses issues 3, 4, and 5, and lowers risk before adding
new UI interactions.

Phase 2: Drag unversioned files into Changes

- Add `trackUnversionedFiles` protocol message.
- Add `GitOps.intentToAddFiles`.
- Add native drag/drop for unversioned file rows onto the Changes section.
- Refresh silently after successful intent-to-add.

Phase 3: Multi-branch delete

- Add branch row multi-selection state.
- Add bulk context menu.
- Add `deleteBranches` protocol and host forwarding.
- Extract delete helpers and implement sequential bulk deletion.
- Add one-by-one remote cleanup toasts for locally deleted branches.

## Risks and Constraints

- Refresh/status code has CRITICAL GitNexus impact because it feeds both docked
  and undocked commit panels. Changes must be incremental and heavily tested.
- `stageFilesFromPanel` has HIGH impact. The drag/drop feature should add a new
  intent-to-add path instead of changing staging semantics.
- Branch multi-select must not reuse `selectedBranch` blindly; that value is
  the graph filter today.
- Bulk deletion must not silently skip invalid, missing, or current branches.
  Reject clearly before mutating when possible.
- New user-facing strings require localization pipeline validation.
- `retainContextWhenHidden` improves perceived continuity but has memory cost.
  Apply first to `intelligit.commitPanel` only.

## Open Decisions

1. Should bulk delete allow mixed local and remote branch selections in one
   action? Recommended: yes, but confirmation must summarize local and remote
   counts separately.
2. Should bulk delete stop on first failure or continue? Recommended: stop on
   first failure and report completed branch names plus the failed branch. This
   is safer than continuing after repository state diverges from the original
   confirmation.
3. Should folder drag from `Unversioned Files` be included in the first drag/drop
   implementation? Recommended: add file drag first; folder drag is a small
   follow-up using descendant unversioned files.
4. Should the global `intelligit.refresh` command show a blue icon or only
   progress? Recommended: blue icon only when the command originates from the
   commit panel refresh affordance. Global refresh can show VS Code progress
   without changing the panel refresh icon.
