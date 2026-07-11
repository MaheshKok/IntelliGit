# Multi-Repo Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support multiple Git repositories in IntelliGit views while matching VS Code Source Control's mental model: the Commit view lists every repository, graph views render the active repository, and the undocked view uses a left repository selector.

**Architecture:** Keep one docked VS Code `Commit` webview contribution, but make its React app render repository accordions backed by per-repository host snapshots. Keep graph providers single-repository and switch their active root from the selected/active editor repository. Keep one undocked webview, add a far-left repository column, and render branch/graph/details/commit content for the selected repository.

**Tech Stack:** VS Code extension API, TypeScript, React, Chakra UI, Bun, Vitest.

---

## Product Contract

- The VS Code view header remains `Commit`.
- Inside the Commit view, show every discovered Git repository as a collapsible row.
- Expanding a repository shows the existing IntelliGit commit body for that repository.
- The `Commit` and `Stash` tabs remain available; each tab renders the same repository accordion shape.
- Repository-relative file paths and stash indexes remain scoped to the repository row that produced them.
- The docked graph and the center/bottom graph render one active repository at a time.
- The active repository changes when the active editor file belongs to another discovered repository.
- Manual repository selection still works and updates the graph views.
- The undocked view shows repositories in the first column; selecting a repository renders the rest of the undocked content for that repository.
- No cross-repository mixed commit graph in v1.

## Non-Goals

- Do not merge commits from unrelated repositories into one graph.
- Do not add tabs for repositories in the undocked view.
- Do not add new dependencies.
- Do not rewrite Git operations; route existing helpers through repository-specific `GitOps`.
- Do not silently skip repositories during refresh. If a repo refresh fails, keep its row and show a bounded error state for that repo.

## Current Code Map

- `src/services/repositoryDiscovery.ts`
  - Already discovers workspace and nested Git repositories as `{ root, label }`.
- `src/activation/repositoryMode.ts`
  - Owns `repositories`, `activeRepository`, shared `GitExecutor`, shared `GitOps`, graph providers, commit panel provider, merge conflict provider, refresh service, and undocked provider.
- `src/activation/repositoryCommands.ts`
  - Owns `intelligit.selectRepository`, refresh, undock/dock, and repository command registration.
- `src/views/CommitPanelViewProvider.ts`
  - Single-repo host for the docked Commit webview.
  - Owns files, stashes, selected stash, branch status, commit draft key, embedded graph state, and commit-panel message handling.
- `src/views/UndockedViewProvider.ts`
  - Single-repo host for the undocked webview.
  - Multiplexes graph and commit-panel protocols on one webview channel.
- `src/views/commitPanelActions.ts`
  - Existing commit/stash/fetch/pull/push helpers already receive `GitOps` through deps.
- `src/views/panelFileActions.ts`
  - Existing file/diff helpers already receive `GitOps` and a workspace root through deps.
- `src/webviews/protocol/commitPanelMessages.ts`
  - Commit-panel messages do not currently include repository identity.
- `src/webviews/protocol/commitGraphTypes.ts`
  - Graph messages do not currently include repository identity because graph views are single-repo.
- `src/webviews/protocol/undockedMessages.ts`
  - Unified undocked protocol currently assumes one repository per panel.
- `src/webviews/react/commit-panel/CommitPanelApp.tsx`
  - Single-repo docked Commit React app.
- `src/webviews/react/commit-panel/components/TabBar.tsx`
  - Current `Commit`/`Stash` tab shell plus global Git toolbar.
- `src/webviews/react/commit-panel/components/CommitTab.tsx`
  - Existing commit body to reuse inside expanded repository rows.
- `src/webviews/react/commit-panel/components/StashTab.tsx`
  - Existing stash body to reuse inside expanded repository rows.
- `src/webviews/react/UndockedApp.tsx`
  - Single-repo undocked React root.
- `src/webviews/react/undocked/UndockedLayout.tsx`
  - Current undocked columns: optional commit panel, branch column, graph list, details, optional commit panel.

## New Data Shapes

Add these shapes to `src/webviews/protocol/commitPanelMessages.ts` or a small shared protocol file if the types become noisy:

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
```

Extend every commit-panel outbound message that performs repository-scoped work:

```ts
interface RepositoryScopedOutbound {
    repositoryRoot: string;
}
```

Examples:

```ts
| ({ type: "refresh" } & RepositoryScopedOutbound)
| ({ type: "saveCommitDraft"; message: string } & RepositoryScopedOutbound)
| ({ type: "commitSelected"; paths: string[]; message: string; amend: boolean; push: boolean } & RepositoryScopedOutbound)
| ({ type: "showDiff"; path: string } & RepositoryScopedOutbound)
| ({ type: "stashSelect"; index: number } & RepositoryScopedOutbound)
```

Host rule: never trust `repositoryRoot` from the webview. Look it up in the current discovered repository map and reject unknown roots before using paths or stash indexes.

## Task 0: Branch And Discovery Baseline

**Files:**
- No source changes.

- [x] **Step 1: Create the feature branch**

Run:

```bash
git switch -c codex/multi-repo-views
```

Expected: current branch is `codex/multi-repo-views`.

- [ ] **Step 2: Run graph/impact checks before implementation**

Use available code intelligence before editing central symbols:

```bash
node .gitnexus/run.cjs analyze
```

If GitNexus MCP tools are available in the implementation session, run upstream impact for these symbols before editing:

```text
CommitPanelViewProvider.handleMessage
CommitPanelViewProvider.refreshData
UndockedViewProvider.handleMessage
activateRepositoryMode
```

Expected: record direct callers, affected flows, and risk level in the implementation notes before the first code edit.

## Task 1: Add Repository Active-Root Resolution

**Files:**
- Modify: `src/activation/repositoryMode.ts`
- Modify: `src/activation/repositoryCommands.ts`
- Test: `tests/unit/activation/repositoryCommands.test.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Add a helper that resolves a repository from a file URI**

Implement the deepest-prefix match in `repositoryMode.ts` near the repository state helpers:

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

- [ ] **Step 2: Register active editor tracking**

In `activateRepositoryMode`, after `setActiveRepository` is defined, register:

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
```

Run it once after activation so an already-open file can set the initial active repo:

```ts
await updateActiveRepositoryFromEditor(vscode.window.activeTextEditor);
```

- [ ] **Step 3: Update repository selection command expectations**

Keep `intelligit.selectRepository` as manual override. When it sets active repo, it should update graph providers and persist `SELECTED_REPOSITORY_KEY` exactly as it does today.

- [ ] **Step 4: Test active file switching**

Add an integration test that creates two discovered repositories, opens a file under repo B, fires the active editor callback, and verifies `setActiveRepository` refreshes graph providers with repo B's `GitOps`.

Run:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "active editor"
```

Expected: the graph providers switch to the deepest matching repo root.

## Task 2: Introduce Per-Repository Commit Panel Runtime

**Files:**
- Create: `src/views/commitPanelRepositoryRuntime.ts`
- Modify: `src/views/CommitPanelViewProvider.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Extract the smallest useful runtime**

Create `CommitPanelRepositoryRuntime` to hold one repository's mutable commit-panel state:

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

Keep this class state-only first. Do not move every provider method into it in the first task.

- [ ] **Step 2: Let `CommitPanelViewProvider` own a runtime map**

Add fields:

```ts
private repositories: DiscoveredRepository[] = [];
private runtimes = new Map<string, CommitPanelRepositoryRuntime>();
private activeRepositoryRoot: string | null = null;
```

Add:

```ts
setRepositories(repositories: DiscoveredRepository[], activeRoot?: string): void
```

Behavior:
- preserve existing runtimes for unchanged roots;
- create runtimes for new roots;
- delete runtimes for removed roots;
- set `activeRepositoryRoot` to `activeRoot` when provided;
- post a repository list to the webview.

- [ ] **Step 3: Keep single-repo compatibility**

`setRepositoryRootUri(repoRootUri)` should keep working for existing tests and activation code during the transition. It can delegate to `setRepositories([{ root, label }], root)` once `repositoryMode.ts` passes labels.

- [ ] **Step 4: Test runtime creation/removal**

Add a provider test:
- call `setRepositories` with repo A and repo B;
- verify two repository summaries are posted;
- call `setRepositories` with only repo B;
- verify repo A runtime is gone and repo B is retained.

Run:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "repository runtimes"
```

Expected: runtime map tracks discovered repositories without changing the VS Code view title.

## Task 3: Make Commit Panel Messages Repository-Scoped

**Files:**
- Modify: `src/webviews/protocol/commitPanelMessages.ts`
- Modify: `src/views/CommitPanelViewProvider.ts`
- Modify: `src/views/panelFileActions.ts` only if `getWorkspaceRoot` needs a root-specific signature
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Add `repositoryRoot` to scoped outbound messages**

Every webview command that reads or mutates repo state must carry `repositoryRoot`. Include:

```text
refresh
abortMerge
setShowIgnoredFiles
fetch
pull
push
sync
saveCommitDraft
stageFiles
unstageFiles
trackUnversionedFiles
commitSelected
commit
commitAndPush
publishBranch
getLastCommitMessage
getAmendBranchCommits
rollback
showDiff
stashSave
stashPop
stashApply
stashDelete
stashSelect
showStashDiff
openFile
deleteFile
```

- [ ] **Step 2: Add host lookup**

Add:

```ts
private runtimeForMessage(msg: { repositoryRoot?: unknown }): CommitPanelRepositoryRuntime {
    const repositoryRoot = assertString(msg.repositoryRoot, "repositoryRoot");
    const runtime = this.runtimes.get(repositoryRoot);
    if (!runtime) throw new Error("Unknown repository received from webview.");
    return runtime;
}
```

- [ ] **Step 3: Route action deps through the runtime**

Inside `handleMessage`, build deps from the runtime:

```ts
const runtime = this.runtimeForMessage(msg);
const actionDeps = {
    gitOps: runtime.gitOps,
    refreshData: () => this.refreshRepositoryData(runtime, false),
    refreshGraphData: () => this.refreshActiveGraphDataIfNeeded(runtime.repository.root),
    fireWorkingTreeChanged: () => this._onDidChangeWorkingTree.fire(),
    postCommitted: () => this.postToWebview({ type: "committed", repositoryRoot: runtime.repository.root }),
    maybeOfferPublishBranch: () => this.maybeOfferPublishBranch(runtime),
};
```

Messages that are not repo-scoped:
- `ready`
- repository list hydration
- collapsed/expanded UI persistence messages

- [ ] **Step 4: Test unknown repo rejection**

Add a regression test:

```ts
await webview.send({ type: "showDiff", repositoryRoot: "/unknown", path: "src/a.ts" });
expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Unknown repository"));
expect(executeCommand).not.toHaveBeenCalledWith("git.openChange", expect.anything());
```

Run:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "Unknown repository"
```

Expected: unknown roots are rejected before Git or filesystem work.

## Task 4: Refresh All Repository Rows In The Docked Commit View

**Files:**
- Modify: `src/views/CommitPanelViewProvider.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Add per-runtime snapshot posting**

Create:

```ts
private snapshotForRuntime(runtime: CommitPanelRepositoryRuntime): CommitPanelRepositorySnapshot
```

It should include repo identity, files, stashes, selected stash, icon data, branch status, and an optional error string.

- [ ] **Step 2: Add `refreshRepositoryData(runtime, silent)`**

Move the current `refreshData` logic to operate on the runtime instead of provider fields.

Key points:
- use `runtime.gitOps.getStatus({ includeIgnored: runtime.showIgnoredFiles })`;
- preserve `runtime.selectedStashIndex` when still valid;
- count unique non-ignored paths per runtime;
- post only that repository snapshot when a single repository refreshes;
- fire a total file count across all runtimes for the hidden badge.

- [ ] **Step 3: Add `refreshAllRepositories(silent)`**

Use:

```ts
await Promise.all([...this.runtimes.values()].map((runtime) => this.refreshRepositoryData(runtime, silent)));
```

No concurrency limit in v1. If it becomes slow, measure first.

- [ ] **Step 4: Keep initial single-repo behavior passing**

Existing tests for:
- branch-free header;
- file count after commit;
- draft restore per repo;
- malformed payload validation;
- path traversal rejection;

must still pass.

Run:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "CommitPanelViewProvider"
```

Expected: existing single-repo tests pass after repo-scoped refactor.

## Task 5: Render Repository Accordions In The Docked Commit React App

**Files:**
- Create: `src/webviews/react/commit-panel/components/RepositoryAccordion.tsx`
- Modify: `src/webviews/react/commit-panel/CommitPanelApp.tsx`
- Modify: `src/webviews/react/commit-panel/hooks/useExtensionMessages.ts`
- Modify: `src/webviews/react/commit-panel/types.ts`
- Modify: `src/webviews/react/commit-panel/components/TabBar.tsx`
- Modify: `src/webviews/react/commit-panel/components/CommitTab.tsx`
- Modify: `src/webviews/react/commit-panel/components/StashTab.tsx`
- Test: `tests/webview/unit/webview-utils.test.ts` or add `tests/webview/unit/commit-panel-multi-repo.test.ts`

- [ ] **Step 1: Change React state to a repository map**

Add:

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

Keep single-repo rendering as one expanded repository.

- [ ] **Step 2: Add `RepositoryAccordion`**

Render:
- chevron;
- repository label;
- current branch/upstream summary;
- changed-file count;
- optional error text;
- expanded body.

Use stable layout dimensions and no nested cards.

- [ ] **Step 3: Scope checked paths by repository**

Replace single `useCheckedFiles(state.files)` with a keyed structure:

```ts
const checkedByRepository = useMemo(() => new Map<string, Set<string>>(), []);
```

or a tiny hook:

```ts
useCheckedFilesByRepository(repositories)
```

Behavior:
- selecting files in repo A never checks files in repo B;
- checked paths are cleared when that repo's file list no longer contains them.

- [ ] **Step 4: Send `repositoryRoot` from every repo body action**

Every `vscode.postMessage` call from `CommitTab`, `StashTab`, and root handlers must include the row's root:

```ts
vscode.postMessage({ type: "showDiff", repositoryRoot, path });
```

- [ ] **Step 5: Move repo-scoped Git action buttons out of global tab toolbar**

`TabBar` should keep only tab switching and stash count. Put refresh/fetch/pull/push actions in the expanded repository row/body so the target repo is visible.

- [ ] **Step 6: Test reducer routing**

Add tests for:
- two repository snapshots render in state;
- updating repo B does not overwrite repo A;
- `committed` clears only repo B when `repositoryRoot` is repo B;
- draft restore updates only the matching repo.

Run:

```bash
bun vitest run tests/webview/unit/commit-panel-multi-repo.test.ts
```

Expected: repository-scoped reducer behavior passes without mounting VS Code.

## Task 6: Wire Repository Lists From Activation Into Docked Commit Panel

**Files:**
- Modify: `src/activation/repositoryMode.ts`
- Modify: `src/activation/repositoryCommands.ts`
- Modify: `src/views/CommitPanelViewProvider.ts`
- Test: `tests/unit/activation/repositoryCommands.test.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Pass all discovered repositories to the commit panel**

After construction and whenever repositories are refreshed:

```ts
commitPanel.setRepositories(repositories, activeRepository.root);
```

- [ ] **Step 2: Refresh repo list when workspace folders change**

Register:

```ts
vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    repositories = await discoverGitRepositories(workspaceRoots());
    commitPanel.setRepositories(repositories, activeRepository.root);
});
```

If the active repo disappears, select the first discovered repo and call `setActiveRepository`.

- [ ] **Step 3: Preserve graph active-repo semantics**

`setActiveRepository` continues to update:
- `executor.setRoot(repoRoot)`;
- `commitGraph`;
- `sidebarGraph`;
- `mergeConflicts`;
- `refreshService`;
- `SELECTED_REPOSITORY_KEY`;
- `commitPanel` active marker only.

It should not collapse other repository rows in the commit panel.

- [ ] **Step 4: Test manual select plus multi-repo commit panel**

Verify:
- `intelligit.selectRepository` changes graph active root;
- commit panel still contains all repositories;
- active repo marker changes.

Run:

```bash
bun vitest run tests/unit/activation/repositoryCommands.test.ts tests/integration/extension/view-providers.integration.test.ts -t "repository"
```

Expected: manual selection and active editor selection agree on the active root.

## Task 7: Add Left Repository Column To Undocked View

**Files:**
- Modify: `src/webviews/protocol/undockedMessages.ts`
- Modify: `src/views/UndockedViewProvider.ts`
- Modify: `src/webviews/react/UndockedApp.tsx`
- Modify: `src/webviews/react/undocked/UndockedLayout.tsx`
- Create: `src/webviews/react/undocked/RepositoryColumn.tsx`
- Modify: `src/webviews/react/undocked/useUnifiedMessages.ts`
- Modify: `src/webviews/react/undocked/useUndockedActions.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`
- Test: `tests/webview/unit/webview-utils.test.ts` or add `tests/webview/unit/undocked-repositories.test.ts`

- [ ] **Step 1: Add undocked repository protocol messages**

Inbound host-to-webview:

```ts
| {
      type: "repositories";
      repositories: RepositoryViewIdentity[];
      selectedRepositoryRoot: string;
  }
```

Outbound webview-to-host:

```ts
| {
      type: "selectRepository";
      repositoryRoot: string;
  }
```

- [ ] **Step 2: Add host selected runtime**

`UndockedViewProvider` should own:

```ts
private repositories: DiscoveredRepository[] = [];
private selectedRepositoryRoot: string;
private runtimes = new Map<string, UndockedRepositoryRuntime>();
```

The selected runtime supplies the existing graph and commit-panel data.

- [ ] **Step 3: Reuse existing render path after selection**

When the webview sends `selectRepository`:
- validate root exists;
- update `selectedRepositoryRoot`;
- clear selected commit/detail;
- send branches for selected repo;
- load first graph page for selected repo;
- refresh commit panel snapshot for selected repo;
- post the selected repo's draft.

- [ ] **Step 4: Render `RepositoryColumn` as the first column**

Layout order:

```text
RepositoryColumn | BranchColumn | CommitList | CommitInfoPane | CommitPanelPane
```

Respect existing `commitPanelPosition` inside the selected-repo content area only if it does not move `RepositoryColumn`. The repository column stays far left.

- [ ] **Step 5: Persist selected undocked repository**

Use workspace state:

```text
intelligit.undockedSelectedRepositoryRoot
```

If the persisted root is missing, use the active repository.

- [ ] **Step 6: Test undocked selection**

Verify:
- initial `ready` posts repositories and selected root;
- selecting repo B causes graph/log calls to use repo B's `GitOps`;
- repo A commit draft does not appear in repo B;
- unknown repo selection is rejected.

Run:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "UndockedViewProvider"
```

Expected: undocked view can switch repositories without creating tabs or multiple panels.

## Task 8: Keep Graph Views Active-Repository Only

**Files:**
- Modify: `src/activation/repositoryMode.ts`
- Modify: `src/views/CommitGraphViewProvider.ts` only if active root needs display metadata
- Modify: `src/webviews/react/CommitGraphPanel.tsx` only if repo label needs rendering
- Modify: `src/webviews/react/NativeCommitGraph.tsx` only if repo label needs rendering
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Do not add multi-repo graph state**

The graph provider keeps one `GitOps` rooted at the active repo. Switching active repo refreshes:

```ts
commitGraph.setBranches(currentBranches, currentWorktrees);
sidebarGraph.setBranches(currentBranches, currentWorktrees);
commitGraph.refresh();
sidebarGraph.refresh();
```

- [ ] **Step 2: Optionally show active repo label in graph body**

If the graph body needs clarity, add a small label near the branch/search controls. Do not change the VS Code view title.

- [ ] **Step 3: Test active repo refresh**

Verify active editor changes from repo A to repo B:
- clears selected commit detail;
- loads repo B commits;
- does not mutate repo A commit-panel expanded state.

Run:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts -t "graph active repository"
```

Expected: graph follows active repo, commit panel remains multi-repo.

## Task 9: Localization And User-Facing Strings

**Files:**
- Modify: `package.nls.json`
- Modify: `l10n/bundle.l10n*.json` through import only
- Modify: `docs/localization/localization_translation_review.csv`

- [ ] **Step 1: Add only necessary English strings**

Likely keys:

```json
{
    "commit.repository.refresh": "Refresh repository",
    "commit.repository.active": "Active repository",
    "commit.repository.changedFiles": "{count} changed files",
    "undocked.repositoryColumn": "Repositories"
}
```

- [ ] **Step 2: Run localization pipeline**

Run only commands that exist:

```bash
bun run l10n:import
bun run l10n:validate
bun scripts/localization-csv.js validate
```

If `bun run l10n:audit` exists, run it too because this changes user-facing strings.

Expected: placeholder and catalog validation passes.

## Task 10: Verification

**Files:**
- No source files unless tests reveal failures.

- [ ] **Step 1: Focused tests first**

Run:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts
bun vitest run tests/unit/activation/repositoryCommands.test.ts
bun vitest run tests/unit/views/commitPanelActions.test.ts
bun vitest run tests/webview/unit/commit-panel-multi-repo.test.ts
bun vitest run tests/webview/unit/undocked-repositories.test.ts
```

Expected: focused multi-repo and regression tests pass.

- [ ] **Step 2: Standard validation**

Run:

```bash
bun run format:check
bun run lint
bun run architecture:check
bun run react-doctor
bun run typecheck
bun run build
bun run test
```

Expected: all validation passes.

- [ ] **Step 3: Manual UI checks**

Use a workspace with at least three repositories:
- repo A has no changes;
- repo B has staged and unstaged changes;
- repo C has stashes.

Verify:
- Commit view header still says `Commit`;
- every repo appears as a collapsible row;
- expanding repo B shows the existing commit body and operates on repo B only;
- expanding repo C's stash tab shows repo C stashes only;
- clicking a file in repo B makes graph views render repo B;
- clicking a file in repo C makes graph views render repo C;
- undocked view shows repository names in the first column;
- selecting a repo in undocked updates branch, graph, details, and commit panel content.

- [ ] **Step 4: GitNexus/codebase change detection before commit**

If GitNexus is available:

```bash
node .gitnexus/run.cjs analyze
```

If codebase-memory is available:

```text
detect_changes(project="Users-maheshkokare-PycharmProjects-pycharm-git-for-vscode", scope="working")
```

Expected: affected symbols are limited to repository activation, commit panel protocol/provider, undocked protocol/provider, and related React views/tests.

## Commit Strategy

Use small commits:

```bash
git add src/activation/repositoryMode.ts tests/integration/extension/view-providers.integration.test.ts
git commit -m "feat: switch active repo from active editor"

git add src/views/commitPanelRepositoryRuntime.ts src/views/CommitPanelViewProvider.ts src/webviews/protocol/commitPanelMessages.ts tests/integration/extension/view-providers.integration.test.ts
git commit -m "feat: scope commit panel state by repository"

git add src/webviews/react/commit-panel tests/webview/unit
git commit -m "feat: render multi-repo commit accordions"

git add src/views/UndockedViewProvider.ts src/webviews/react/UndockedApp.tsx src/webviews/react/undocked src/webviews/protocol/undockedMessages.ts tests
git commit -m "feat: add undocked repository column"
```

Do not add a co-author trailer.

## Risks

- `CommitPanelViewProvider` and `UndockedViewProvider` are large central classes; keep each change small and test before moving to the next task.
- A webview-supplied repository root is untrusted input. Validate against the discovered repo map before any Git/file operation.
- Stash indexes are repository-local and unstable after stash mutation. Always pair them with the selected repository runtime.
- Active editor switching can be noisy. Ignore non-file schemes and files outside discovered repositories.
- Global toolbar actions are unsafe in a multi-repo commit panel. Keep repo-scoped actions visually inside the target repository row/body.

## Acceptance Criteria

- Branch `codex/multi-repo-views` contains the implementation.
- The docked Commit view lists all discovered repositories as collapsible rows under the unchanged `Commit` view header.
- Expanded rows reuse the existing IntelliGit commit/stash body and operate only on that row's repository.
- Graph views render the repository containing the active editor file.
- Manual repository selection still switches graph/merge-conflict active repo.
- Undocked view uses a left repository column, not repository tabs.
- Repository switching in undocked updates the rest of the columns without opening a new panel.
- Single-repo workspaces still look and behave like the current UI, except the single repo may appear as one expanded row.
- Focused and standard validation commands pass.
