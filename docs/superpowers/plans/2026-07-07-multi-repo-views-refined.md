# Multi-Repo Views Implementation Plan (Refined)

> Supersedes the assessment in `2026-07-07-multi-repo-views.md` (kept intact for reference).
> This revision folds in verified architecture facts and three decisions the original left open.
> Steps use checkbox (`- [ ]`) syntax for tracking. Follow TDD: write the spec-derived test first, then implement.

**Goal:** Support multiple Git repositories in IntelliGit while matching VS Code Source Control's mental model:
the Commit view lists every repository as a collapsible row, graph views render the active repository, and the
undocked window gains a left repository selector column.

**Tech stack:** VS Code extension API, TypeScript, React, Chakra UI, Bun, Vitest. No new dependencies.

---

## Decisions locked for this revision

1. **Undocked switching = single-runtime, left-column selector, with a dedicated executor.** The undocked window
   renders one repository at a time. Clicking a repository in a new far-left column switches the single selected root
   and re-renders the other columns. There is **no per-repository runtime map** (this is the main change from the
   original plan's Task 7). **But a URI reset alone is not enough:** `setRepositoryRootUri`
   (`src/views/UndockedViewProvider.ts:243`) only resets caches; today the real Git root moves through
   `executor.setRoot(repoRoot)` in `setActiveRepository` (`src/activation/repositoryMode.ts:239`) on the **shared**
   executor, and the undocked provider is handed that shared `gitOps` (`repositoryMode.ts:353`). So the undocked view
   must get its **own** `GitExecutor`/`GitOps` and a real root switch — independent of the docked active repository —
   otherwise the UI shows repo B while Git calls still hit repo A. Independence is required because the undocked
   selection must **not** be hijacked by active-editor changes (Task 1); it is its own source of truth. Per-repo
   draft/selection restore is free because drafts are already keyed by root.
2. **Docked accordion watchers = active + expanded rows only.** Watch the active repository plus any currently
   expanded accordion row; refresh a row when it is expanded. Avoids N filesystem watchers in workspaces with many
   repositories.
3. **Docked commit panel is Commit/Stash tabs only.** Verified: `webview-commitpanel` builds from
   `react/commit-panel/CommitPanelApp` (`scripts/webviewConfigs.js:4`), which renders only `TabBar` →
   `CommitTab`/`StashTab`. The graph plumbing inside `CommitPanelViewProvider` (`loadInitialGraphCommits`,
   `sendGraphBranches`, `postGraphCommitDetailState`, and the `selectCommit`/`loadMore`/`filterBranch`/`branchAction`
   message cases) is **vestigial** for the current app. The visible "GRAPH" sidebar section is the separate
   `sidebarGraph` view (`CommitGraphViewProvider.sidebarViewType`), which already follows the active repository.
   Therefore the accordion work is scoped to commit/stash only; do not build a per-accordion graph.

---

## Product contract

- The VS Code Commit view header stays `Commit`.
- Inside the Commit view, every discovered Git repository is a collapsible row.
- Expanding a repository shows the existing IntelliGit commit body (`CommitTab`) and, on the Stash tab, `StashTab`
  for that repository.
- All repository rows are visible simultaneously; each operates only on its own repository.
- Repository-relative file paths and stash indexes stay scoped to the row that produced them.
- Graph views (docked GRAPH section and the main graph) render one active repository at a time.
- The active repository changes when the active editor file belongs to another discovered repository (deepest-prefix
  match). Manual `intelligit.selectRepository` remains an override.
- The undocked window shows a far-left column listing repository names; selecting one renders the rest of the
  undocked content (Branch / CommitList / CommitInfo / CommitPanel) for that repository. No repository tabs.
- Single-repository workspaces look and behave like today, except the one repository may render as a single expanded
  row.

## Non-goals

- No cross-repository merged commit graph.
- No repository tabs in the undocked view.
- No new dependencies.
- Do not rewrite Git operations; route existing helpers through repository-specific `GitOps`.
- Do not silently skip a repository on refresh failure; keep its row and show a bounded per-row error.

## Verified current code map

- `src/services/repositoryDiscovery.ts` — `discoverGitRepositories(workspaceRoots)` already returns all
  `DiscoveredRepository { root, label }`. Discovery is done; nothing to add here.
- `src/activation/repositoryMode.ts` — one shared `GitExecutor`/`GitOps`; `setActiveRepository`
  (`:234`) switches the root by mutation and updates every provider; `refreshActiveRepository` (`:201`); manual
  selection persists `SELECTED_REPOSITORY_KEY`. No active-editor tracking today.
- `src/views/CommitPanelViewProvider.ts` — single-repo host (957 lines). `setRepositoryRootUri` (`:136`) resets all
  repo-scoped state, bumps request sequences, reposts the draft. `handleMessage` (`:557`) — messages carry no
  repository id. `getCommitDraftStorageKey` (`:857`) already keys drafts by root. `selectStashFromPanel` call
  (`:730`) closes over provider fields `getFiles`/`getStashes`/`setStashState`.
- `src/views/commitPanelActions.ts` / `src/views/panelFileActions.ts` — commit/stash/file helpers already receive
  `GitOps` (and a workspace root) via deps; reusable per-runtime.
- `src/views/UndockedViewProvider.ts` — single-repo host (1097 lines). `setRepositoryRootUri` (`:243`) already
  performs a full root switch. `refreshCommitPanelData` (`:829`), `sendBranches` (`:895`), `loadInitial` (`:664`).
- `src/webviews/protocol/commitPanelMessages.ts` / `undockedMessages.ts` — no repository identity today.
- `src/webviews/react/commit-panel/CommitPanelApp.tsx` — renders `TabBar` with `CommitTab`/`StashTab` only; single
  `useExtensionMessages` reducer and single `useCheckedFiles(state.files)` (`:28`). `TabBar` holds the global
  sync/fetch/pull/push toolbar.
- `src/webviews/react/commit-panel/hooks/useExtensionMessages.ts` — single `CommitPanelState` reducer.
- `src/webviews/react/UndockedApp.tsx` / `undocked/UndockedLayout.tsx` — single-repo columns:
  `[CommitPanel] | Branch | CommitList | CommitInfo`.

## New data shapes

Add to `src/webviews/protocol/commitPanelMessages.ts` (or a small shared protocol file if noisy):

```ts
export interface RepositoryViewIdentity {
    root: string;
    label: string;
}

export interface CommitPanelRepositorySnapshot extends RepositoryViewIdentity {
    files: WorkingFile[];
    stashes: StashEntry[];
    stashFiles: WorkingFile[];
    selectedStashIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts?: ThemeIconFont[];
    currentBranchHasUpstream?: boolean;
    hasRemotes?: boolean;
    currentBranchAhead?: number;
    currentBranchBehind?: number;
    currentBranchName?: string | null;
    currentBranchUpstream?: string | null;
    error?: string;
    refreshing?: boolean;
}

// Every repository-scoped webview→host message carries this.
interface RepositoryScopedOutbound {
    repositoryRoot: string;
}
```

**Host rule (security):** never trust `repositoryRoot` from the webview. Look it up in the current discovered
repository map and reject unknown roots before touching paths or stash indexes.

---

## Task 0: Baseline and impact check

**Files:** none.

- [x] Feature branch `codex/multi-repo-views` exists.
- [ ] Confirm the docked commit webview renders no graph (grep the built app entry for `CommitList` / `selectCommit`
      / `loadMore`). Record that `CommitPanelViewProvider`'s graph plumbing is vestigial so it is not carried into the
      per-repository refactor.
- [ ] Record direct callers of `CommitPanelViewProvider.handleMessage`, `CommitPanelViewProvider.refreshData`,
      `UndockedViewProvider.handleMessage`, and `activateRepositoryMode` before editing them.

## Task 1: Active repository follows the active editor

**Files:**
- Modify: `src/activation/repositoryMode.ts`
- Modify: `src/activation/repositoryCommands.ts` (keep manual select as override)
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1 — deepest-prefix resolver.** Add near the repository-state helpers:

```ts
function repositoryForFileUri(
    uri: vscode.Uri | undefined,
    knownRepositories: DiscoveredRepository[],
): DiscoveredRepository | undefined {
    if (!uri || uri.scheme !== "file") return undefined;
    const filePath = path.resolve(uri.fsPath);
    return knownRepositories
        .filter((repo) => {
            const root = path.resolve(repo.root);
            return filePath === root || filePath.startsWith(root + path.sep);
        })
        .sort((a, b) => b.root.length - a.root.length)[0];
}
```

- [ ] **Step 2 — track the active editor.** In `activateRepositoryMode`, after `setActiveRepository` is defined:

```ts
const updateActiveRepositoryFromEditor = async (editor?: vscode.TextEditor): Promise<void> => {
    const repository = repositoryForFileUri(editor?.document.uri, repositories);
    if (!repository || repository.root === activeRepository.root) return;
    await setActiveRepository(repository);
};

context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        void updateActiveRepositoryFromEditor(editor).catch((err) => {
            console.error("[IntelliGit] Failed to update active repository from editor:", err);
        });
    }),
);
await updateActiveRepositoryFromEditor(vscode.window.activeTextEditor);
```

- [ ] **Step 3 — keep manual override.** `intelligit.selectRepository` still calls `setActiveRepository` and persists
      `SELECTED_REPOSITORY_KEY` as today.
- [ ] **Step 4 — test.** Two discovered repositories; open a file under repo B; fire the active-editor callback;
      assert graph providers switch to repo B's root (deepest match wins for nested repos).

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "active editor"
```

*This task alone delivers "graph shows whichever file I clicked," because the GRAPH section already follows the
active repository.*

## Task 2: Per-repository commit-panel runtime + repository-scoped messages

**Files:**
- Create: `src/views/commitPanelRepositoryRuntime.ts`
- Modify: `src/views/CommitPanelViewProvider.ts`
- Modify: `src/webviews/protocol/commitPanelMessages.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1 — state-only runtime.** One repository's mutable commit-panel state, its own `GitOps`, and its draft
      key. Keep it state-only first; do not move every provider method in one pass.

```ts
export class CommitPanelRepositoryRuntime {
    readonly repository: DiscoveredRepository;
    readonly repoRootUri: vscode.Uri;
    readonly gitOps: GitOps;

    files: WorkingFile[] = [];
    stashes: StashEntry[] = [];
    stashFiles: WorkingFile[] = [];
    selectedStashIndex: number | null = null;
    folderIconsByName: ThemeFolderIconMap = {};
    showIgnoredFiles = false;
    currentBranchHasUpstream = false;
    hasRemotes = false;
    currentBranchAhead = 0;
    currentBranchBehind = 0;
    currentBranchName: string | null = null;
    currentBranchUpstream: string | null = null;
    refreshSeq = 0;

    constructor(repository: DiscoveredRepository) {
        this.repository = repository;
        this.repoRootUri = vscode.Uri.file(repository.root);
        this.gitOps = new GitOps(new GitExecutor(repository.root));
    }
}
```

- [ ] **Step 2 — runtime map on the provider.**

```ts
private repositories: DiscoveredRepository[] = [];
private runtimes = new Map<string, CommitPanelRepositoryRuntime>();
private activeRepositoryRoot: string | null = null;

setRepositories(repositories: DiscoveredRepository[], activeRoot?: string): void
```

Behavior: preserve runtimes for unchanged roots, create for new roots, delete for removed roots, set
`activeRepositoryRoot` when provided, and post the repository list to the webview. `setRepositoryRootUri` keeps
working (delegates to `setRepositories([{root,label}], root)`) so existing single-repo tests pass during the
transition.

- [ ] **Step 3 — validated lookup.** Reject unknown roots before any Git/file work:

```ts
private runtimeForMessage(msg: { repositoryRoot?: unknown }): CommitPanelRepositoryRuntime {
    const repositoryRoot = assertString(msg.repositoryRoot, "repositoryRoot");
    const runtime = this.runtimes.get(repositoryRoot);
    if (!runtime) throw new Error("Unknown repository received from webview.");
    return runtime;
}
```

- [ ] **Step 4 — route deps through the runtime.** Build `actionDeps`/`fileActionDeps` from the runtime in
      `handleMessage` instead of `this.gitOps`/`this.files`. Convert `commitPanelMessages.ts` scoped outbound messages
      to include `repositoryRoot`:

```
refresh, abortMerge, setShowIgnoredFiles, fetch, pull, push, sync, saveCommitDraft, stageFiles, unstageFiles,
trackUnversionedFiles, commitSelected, commit, commitAndPush, publishBranch, getLastCommitMessage,
getAmendBranchCommits, rollback, showDiff, stashSave, stashPop, stashApply, stashDelete, stashSelect,
showStashDiff, openFile, deleteFile
```

Not repo-scoped: `ready`, repository-list hydration, UI-only persistence.

- [ ] **Step 5 — fix stash-select capture.** The `selectStashFromPanel` deps (`CommitPanelViewProvider.ts:730`) must
      read/write the **target runtime** (`runtime.files`, `runtime.stashes`, `runtime.selectedStashIndex`,
      `runtime.stashFiles`, `runtime.folderIconsByName`), not shared provider fields.
- [ ] **Step 6 — test.** (a) `setRepositories(A,B)` then `setRepositories(B)` retains B, drops A; (b)
      `{ type: "showDiff", repositoryRoot: "/unknown", path: "src/a.ts" }` is rejected before any Git/`git.openChange`
      call.

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "repository runtimes"
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "Unknown repository"
```

## Task 3: Refresh all rows + active/expanded watchers

**Files:**
- Modify: `src/views/CommitPanelViewProvider.ts`
- Modify: `src/views/RefreshService.ts` (or add lightweight per-runtime watchers in the provider)
- Test: `tests/integration/extension/view-providers.integration.test.ts`
- Test: `tests/unit/services/refreshService.test.ts`

- [ ] **Step 1 — per-runtime snapshot + refresh.** `snapshotForRuntime(runtime)` builds a
      `CommitPanelRepositorySnapshot`. `refreshRepositoryData(runtime, silent)` runs the current `refreshData` logic
      against the runtime (`runtime.gitOps.getStatus({ includeIgnored: runtime.showIgnoredFiles })`), preserves a
      still-valid `selectedStashIndex`, and posts only that repository's snapshot.
- [ ] **Step 2 — aggregate refresh + badge + collapsed-row counts.** `refreshAllRepositories(silent)` runs the
      active + expanded runtimes (`Promise.all`). The native file-count badge sums non-ignored unique paths **across
      all runtimes** (`onDidChangeFileCount` currently emits one repo's count — change to the total). Because
      collapsed rows are not live-watched, do a **one-time lightweight `git status` scan per row on initial load** so
      every row shows a correct changed-file count immediately; collapsed rows then keep that last-known count until
      expanded (do not leave them blank). Refresh a collapsed row's count on demand if it becomes active.
- [ ] **Step 3 — active + expanded watchers.** Live-watch the active repository plus expanded rows. On a repo's
      working-tree change, refresh only that runtime. On row expand, refresh that runtime and start watching it; on
      collapse, stop watching (keep the active repo always watched). A webview→host `setExpandedRepositories` message
      (or per-row `expand`/`collapse`) drives which runtimes are watched. Register every watcher/listener through
      `context.subscriptions.push(...)` (or the provider's own disposables array) so nothing leaks on repo removal or
      deactivation.
- [ ] **Step 4 — regression.** Existing single-repo tests still pass: branch-free header, file count after commit,
      per-repo draft restore, malformed-payload rejection, path-traversal rejection.

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "CommitPanelViewProvider"
```

## Task 4: Render repository accordions in the docked React app

**Files:**
- Create: `src/webviews/react/commit-panel/components/RepositoryAccordion.tsx`
- Modify: `CommitPanelApp.tsx`, `hooks/useExtensionMessages.ts`, `types.ts`, `components/TabBar.tsx`,
  `components/CommitTab.tsx`, `components/StashTab.tsx`
- Test: `tests/webview/unit/commit-panel-multi-repo.test.tsx` (new)

- [ ] **Step 1 — keyed state.** Reducer holds a repository map:

```ts
export interface RepositoryCommitPanelState extends CommitPanelState {
    root: string;
    label: string;
    refreshing: boolean;
}
export interface MultiRepositoryCommitPanelState {
    repositories: RepositoryCommitPanelState[];
    activeRepositoryRoot: string | null;
    expandedRepositoryRoots: string[];
}
```

Updating repo B must not overwrite repo A; `committed`/`restoreCommitDraft` apply only to the message's
`repositoryRoot`.

- [ ] **Step 2 — `RepositoryAccordion`.** Chevron, label, current branch/upstream summary, changed-file count,
      optional error text, expanded body. Stable dimensions, no nested cards. Emits expand/collapse to the host.
- [ ] **Step 3 — per-repository checked files.** Replace single `useCheckedFiles(state.files)` with a per-root
      structure (a `useCheckedFilesByRepository(repositories)` hook). Selecting files in repo A never checks repo B;
      checked paths clear when a repo's file list no longer contains them. Group-by-dir and expanded/collapsed tree
      state are per row.
- [ ] **Step 4 — scope every action.** Every `vscode.postMessage` from `CommitTab`/`StashTab`/row handlers includes
      the row's `repositoryRoot`.
- [ ] **Step 5 — move the Git toolbar into the row.** `TabBar` keeps only tab switching and an aggregate stash count.
      The sync/fetch/pull/push actions (currently global, posting `{type:"push"}` with no root) move into the expanded
      row/body so the target repository is unambiguous.
- [ ] **Step 6 — test.** Two snapshots render; updating B leaves A intact; `committed` clears only B; draft restore
      updates only the matching repo.

```bash
bun vitest run tests/webview/unit/commit-panel-multi-repo.test.tsx
```

## Task 5: Wire discovered repositories into the docked panel

**Files:**
- Modify: `src/activation/repositoryMode.ts`, `src/activation/repositoryCommands.ts`,
  `src/views/CommitPanelViewProvider.ts`
- Test: `tests/unit/activation/repositoryCommands.test.ts`,
  `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1 — pass the list.** After activation and on every repository refresh:
      `commitPanel.setRepositories(repositories, activeRepository.root)`.
- [ ] **Step 2 — react to workspace changes (registered for disposal).**

```ts
context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        repositories = await discoverGitRepositories(workspaceRoots());
        commitPanel.setRepositories(repositories, activeRepository.root);
        undocked?.setRepositories?.(repositories); // keep the undocked column in sync too
    }),
);
```

Register through `context.subscriptions.push(...)` so the listener is disposed on deactivation. If the active
repository disappears, select the first discovered repository and call `setActiveRepository`. If the
undocked-selected repository disappears, fall back to the active repository.

- [ ] **Step 3 — preserve graph semantics.** `setActiveRepository` continues to update `executor.setRoot`,
      `commitGraph`, `sidebarGraph`, `mergeConflicts`, `refreshService`, `SELECTED_REPOSITORY_KEY`, and the commit
      panel's active marker only — it must not collapse other accordion rows.
- [ ] **Step 4 — test.** Manual `selectRepository` changes the graph active root while the commit panel still lists
      all repositories and the active marker moves.

```bash
bun vitest run tests/unit/activation/repositoryCommands.test.ts tests/integration/extension/view-providers.integration.test.ts -t "repository"
```

## Task 6: Undocked left repository column (single-runtime switch)

**Files:**
- Modify: `src/webviews/protocol/undockedMessages.ts`, `src/views/UndockedViewProvider.ts`,
  `src/webviews/react/UndockedApp.tsx`, `src/webviews/react/undocked/UndockedLayout.tsx`,
  `undocked/useUnifiedMessages.ts`, `undocked/useUndockedActions.ts`
- Create: `src/webviews/react/undocked/RepositoryColumn.tsx`
- Test: `tests/integration/extension/view-providers.integration.test.ts`,
  `tests/webview/unit/undocked-repositories.test.tsx` (new)

- [ ] **Step 1 — protocol.** Host→webview `{ type: "repositories"; repositories: RepositoryViewIdentity[]; selectedRepositoryRoot: string }`.
      Webview→host `{ type: "selectRepository"; repositoryRoot: string }`.
- [ ] **Step 2 — dedicated executor + single selected root (no runtime map).** Give the undocked view its own Git
      root, independent of the shared executor:
  - In `ensureUndockedPanel` (`repositoryMode.ts:350`), construct a **dedicated** executor/gitOps
    (`const undockedExecutor = new GitExecutor(activeRepository.root); const undockedGitOps = new GitOps(undockedExecutor);`)
    and pass `undockedGitOps` (not the shared `gitOps`) into the provider.
  - `UndockedViewProvider` owns `repositories: DiscoveredRepository[]`, `selectedRepositoryRoot: string`, and a
    `setActiveRepositoryRoot(root: string)` that calls `executor.setRoot(root)` (the provider needs the executor, so
    pass it in or keep a non-readonly gitOps whose executor it can re-root), then does the `setRepositoryRootUri`
    cache reset and reloads branches, the first graph page, the commit-panel snapshot, and the persisted draft.
  - On `selectRepository`: validate the root exists in `repositories`, then call `setActiveRepositoryRoot(root)`.
- [ ] **Step 2b — re-root the undocked host handlers.** The undocked event handlers in `repositoryMode.ts` currently
      use the shared `executor`/`gitOps`/`repoRoot`; they must use the undocked's dedicated executor/gitOps and the
      undocked-selected root instead, or Git calls diverge from the selection:
  - commit-detail load (`repositoryMode.ts:374`, `gitOps.getCommitDetail`)
  - commit action (`repositoryMode.ts:428`, `handleCommitContextAction({ executor, gitOps, repoRoot })`)
  - open-file diff (`repositoryMode.ts:445`, `createOpenCommitFileDiffHandler({ executor, gitOps, getRepoRoot })`)
  - `loadUndockedData` (`repositoryMode.ts:468`, `gitOps.getBranches`)
- [ ] **Step 3 — render the column first.** Layout order:
      `RepositoryColumn | BranchColumn | CommitList | CommitInfoPane | CommitPanelPane`. The repository column stays
      far left regardless of the existing `commitPanelPosition` (which still applies inside the selected-repo content).
- [ ] **Step 4 — persist selection.** Workspace-state key `intelligit.undockedSelectedRepositoryRoot`; fall back to
      the active repository when the persisted root is missing.
- [ ] **Step 5 — test.** Initial `ready` posts repositories + selected root; selecting repo B makes graph/log calls
      use repo B's root; repo A's draft does not appear under repo B; unknown-root selection is rejected.

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "UndockedViewProvider"
bun vitest run tests/webview/unit/undocked-repositories.test.tsx
```

## Task 7: Graph views stay active-repository only

**Files:**
- Modify: `src/activation/repositoryMode.ts` (already covered by Task 1)
- Optional: `CommitGraphViewProvider.ts` / `CommitGraphPanel.tsx` / `NativeCommitGraph.tsx` if a repo label needs to
  render in the graph body
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1 — no multi-repo graph state.** Keep one `GitOps` rooted at the active repository. Switching active
      repo refreshes `commitGraph`/`sidebarGraph` branches and content (already the behavior).
- [ ] **Step 2 — optional label.** If clarity is needed, show a small active-repository label near the graph
      branch/search controls. Do not change the VS Code view title.
- [ ] **Step 3 — test.** Active editor A→B clears selected commit detail, loads repo B commits, and does not mutate
      repo A's accordion expanded state.

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "graph active repository"
```

## Task 8: Localization and user-facing strings

**Files:** `package.nls.json`, `l10n/bundle.l10n*.json` (import only),
`docs/localization/localization_translation_review.csv`

- [ ] Add only necessary English keys, e.g. `commit.repository.active`, `commit.repository.changedFiles`,
      `commit.repository.refresh`, `undocked.repositoryColumn`.
- [ ] Run the l10n pipeline: `bun run l10n:import`, `bun run l10n:validate`,
      `bun scripts/localization-csv.js validate` (and `bun run l10n:audit` if it exists).

## Task 9: Verification

- [ ] **Focused tests.**

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts
bun vitest run tests/unit/activation/repositoryCommands.test.ts
bun vitest run tests/unit/views/commitPanelActions.test.ts
bun vitest run tests/webview/unit/commit-panel-multi-repo.test.tsx
bun vitest run tests/webview/unit/undocked-repositories.test.tsx
```

- [ ] **Standard validation.**

```bash
bun run format:check && bun run lint && bun run architecture:check && bun run react-doctor && bun run typecheck && bun run build && bun run test
```

- [ ] **Manual UI checks.** Workspace with three repositories (A: no changes, B: staged+unstaged, C: stashes):
  - Commit header still says `Commit`; every repo is a collapsible row.
  - Expanding B shows the commit body and operates on B only; C's Stash tab shows C's stashes only.
  - Clicking a file in B makes the graph render B; clicking a file in C makes the graph render C.
  - Undocked window shows repository names in the far-left column; selecting a repository updates Branch, CommitList,
    CommitInfo, and CommitPanel without opening a new panel or tab.
- [ ] **Change detection before commit** (if available): `codebase-memory detect_changes` scoped to `working` —
      affected symbols should be limited to repository activation, commit-panel protocol/provider, undocked
      protocol/provider, and related React views/tests.

## Commit strategy (small commits, no co-author trailer)

```
feat: switch active repo from active editor
feat: scope commit panel state by repository
feat: refresh docked rows with active+expanded watchers
feat: render multi-repo commit accordions
feat: wire discovered repositories into docked commit panel
feat: add undocked repository column (single-runtime switch)
```

## Risks

- `CommitPanelViewProvider` (957 lines) and `UndockedViewProvider` (1097 lines) are large central classes — keep each
  change small and test before moving on.
- Webview-supplied `repositoryRoot` is untrusted — validate against the discovered map before any Git/file op.
- Per-repo watchers add filesystem handles — the active+expanded strategy bounds this; still debounce refreshes.
- Stash indexes are repository-local and unstable after mutation — always pair them with the selected runtime.
- Active-editor changes are noisy — ignore non-`file` schemes and files outside discovered repositories.
- Vestigial graph plumbing in `CommitPanelViewProvider` should not be extended into the runtime refactor; consider a
  separate cleanup commit to delete it.
- **Undocked shared-executor trap:** the undocked provider currently shares the global executor, and several undocked
  host handlers (commit detail, commit action, file diff, branch load) reach through it. A URI-only switch would show
  the selected repo in the UI while Git still queries the previous root. The dedicated-executor + re-rooted-handlers
  work (Task 6, Steps 2/2b) is mandatory, not optional. Add a test that asserts undocked Git calls target the
  selected root after selection.

## Acceptance criteria

- Docked Commit view lists all discovered repositories as collapsible rows under the unchanged `Commit` header.
- Expanded rows reuse the existing commit/stash body and operate only on that row's repository.
- Graph views render the repository containing the active editor file; manual selection still overrides.
- Undocked window uses a far-left repository column (not tabs); selecting a repository re-renders the other columns
  in place.
- Single-repository workspaces behave as today.
- Focused and standard validation commands pass.
