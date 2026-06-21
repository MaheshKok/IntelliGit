# Git Worktrees — Phased Implementation Plan (LLM-Executable)

Status: proposed. Target: IntelliGit VS Code extension (`pycharm-git-for-vscode`).
Goal: add Git worktree support with PyCharm-style UX (Worktrees view, create/open/delete, branch badges), built in independently shippable phases.

## How to use this document

Each phase below is a self-contained prompt. Hand one phase at a time to an implementing LLM, in order. Every phase prompt assumes the LLM has first read **Section A (Shared Context)**, **Section B (Data Model)**, and **Section C (Conventions and Safety)**. Paste those three sections plus the single phase block.

Foundation-first study order: A, B, C, then Phase 0 -> 7.

MVP = Phase 0 through Phase 4. Phase 5+ is post-MVP.

---

## Section A — Shared Context (read first, every phase)

IntelliGit is a VS Code extension that reimplements a JetBrains-style Git UI. Relevant architecture, verified against the codebase:

- **Git is invoked only through `GitExecutor.run(args: string[])`** at `src/git/executor.ts`. It takes an argument array and never a shell string. All Git access in this feature MUST go through an executor. Never build shell command strings.
- **`GitOps`** at `src/git/operations.ts` is the porcelain wrapper class. It is already ~850 lines, which is over the project file-size ceiling. **Do not add worktree commands to this file.** Worktree Git logic goes in a new module `src/git/worktrees.ts` written as pure functions and validated free functions that take an `executor`, mirroring the existing free-function style in `src/services/gitHelpers.ts`.
- **`Branch`** type lives at `src/types.ts`. Shared by host and webview.
- **Branch checkout** happens in `checkoutBranch(branch, currentBranches, executor)` at `src/services/gitHelpers.ts` (lines 353-376). It runs `git checkout <name>` directly. If a branch is already checked out in another worktree, Git fails with "already checked out". This function is the guard point.
- **Repository discovery** at `src/services/repositoryDiscovery.ts` resolves roots via `git rev-parse --show-toplevel`. Opening a worktree directly already resolves correctly. `src/views/RefreshService.ts` (~line 173) already resolves worktree-style `.git` files for watching. No discovery rewrite is required for this feature.
- **Webview message protocol** for the branch/graph UI is at `src/webviews/protocol/commitGraphTypes.ts`. It exports `BRANCH_ACTION_VALUES` (a `const` string-tuple) plus an `isBranchAction` type guard. Adding a value to that tuple automatically flows through validation.
- **Branch context menu** is produced by `getBranchMenuItems(branch, currentBranchName)` at `src/webviews/react/branch-column/menu.ts` (lines 47-97). Menu item `action` fields must be members of the `BranchAction` union.
- **Host-side action routing**: `forwardBranchAction({ action, branchName })` at `src/activation/repositoryViewEvents.ts` (~line 147) maps an action to the VS Code command `intelligit.${action}`.
- **Branch list provider**: `CommitGraphViewProvider.setBranches(branches)` at `src/views/CommitGraphViewProvider.ts` (~line 227) posts branches to the webview.
- **View contributions** are in `package.json` under `contributes.viewsContainers` and `contributes.views`. The activity-bar container id is `intelligit`. The panel container id is `intelligitPanel`.

Project type: TypeScript, React webviews. Tooling: run all commands with **`bun`**, never `npx`. Prefer `make` targets where they exist (`make help`); otherwise use `bun run <script>` from `package.json`. Tests use Vitest.

Test layout (verified): unit tests in `tests/unit/<area>/`, integration in `tests/integration/<area>/`. Use `tests/unit/git/`, `tests/unit/services/`, and `tests/integration/extension/` for this feature.

Localization: user-facing strings are not hardcoded. Command titles and menu labels contributed in `package.json` use `%key%` placeholders defined in `package.nls.json`. Webview strings use the `t(...)` helper backed by `src/webviews/i18n/en.json`. After adding webview strings, regenerate bundles with the project l10n import script (run via `bun run`, check `package.json` scripts for the exact name, e.g. `l10n:import`). Do not hand-edit generated locale JSON.

---

## Section B — Data Model (canonical types)

Add to `src/types.ts`:

```ts
/** Lifecycle state of a Git worktree as reported by `git worktree list --porcelain`. */
export type WorktreeState = "main" | "linked" | "bare" | "detached";

/**
 * One Git worktree parsed from `git worktree list --porcelain -z`.
 *
 * `path` is absolute. `branch` is the short branch name (the `refs/heads/`
 * prefix is stripped) and is null when the worktree is detached or bare.
 */
export interface GitWorktree {
    path: string;
    head: string | null;
    branch: string | null;
    state: WorktreeState;
    /** True for the first record reported by Git, even when that worktree is detached. */
    isMain: boolean;
    isCurrent: boolean;
    isLocked: boolean;
    lockedReason?: string;
    isPrunable: boolean;
    prunableReason?: string;
}
```

Extend the existing `Branch` interface in `src/types.ts` with optional, backward-compatible fields:

```ts
    /** Absolute path of the worktree this branch is checked out in, if any. */
    worktreePath?: string;
    /** True when this branch is currently checked out in some worktree. */
    isCheckedOutInWorktree?: boolean;
    /** True when that worktree is the one the user currently has open. */
    isCurrentWorktree?: boolean;
```

---

## Section C — Conventions and Safety (binding on all phases)

- TDD: write spec-derived tests first (red), implement to green, then refactor. Derive expected values independently; do not mirror the implementation in assertions. Cover boundaries and error paths, not just the happy path.
- Type-hint everything. Prefer built-in generics. Immutable data — return new objects, do not mutate inputs.
- File size: keep new files focused (target 200-400 lines). Split if larger.
- Git arguments are always arrays passed to an executor. No shell strings, ever.
- Safety guards (enforced where relevant):
  - Never `--force` remove a worktree by default. Force only after an explicit user confirmation of a dirty worktree.
  - Never delete a branch as a side effect of removing a worktree.
  - Reject a new/moved worktree path that is nested inside the current repository, or inside any existing worktree, or that points at a non-empty existing directory. Use normalized absolute paths plus realpaths for existing paths so symlinks cannot escape the boundary.
  - The main worktree and the currently open worktree cannot be removed.
  - A branch already checked out in another worktree must not be re-checked-out; offer to open that worktree instead.
  - Validate every branch name (reuse `assertValidBranchName` from `src/services/gitHelpers.ts`) and every filesystem path at the boundary.
- After code edits, run the project's review and verification steps; before any commit, run a security review. Do not commit unless explicitly asked.

Definition of done for every phase: new and existing tests pass via `bun`, type-check and lint pass, no hardcoded user-facing strings, and the acceptance criteria in the phase are demonstrably met.

---

## Phase 0 — Worktree data layer (parser + list), no UI

Role: TypeScript engineer. Read Sections A, B, C first.

Objective: parse `git worktree list --porcelain -z` into `GitWorktree[]`, with exhaustive tests. No UI, no mutations.

Files:
- Create `src/git/worktrees.ts`.
- Modify `src/types.ts` (add `WorktreeState`, `GitWorktree` from Section B).
- Create `tests/unit/git/worktrees.test.ts`.

Implementation spec for `src/git/worktrees.ts`:
- `export function parseWorktreeList(porcelainZ: string, currentRoot: string): GitWorktree[]`
  - Input is the raw stdout of `git worktree list --porcelain -z`.
  - Framing: the `-z` output is a flat sequence of NUL-terminated attribute tokens; worktree records are separated by an empty token (a NUL immediately following a NUL). Split on `\0`, then group tokens into records, starting a new record at each empty token.
  - Per-record attributes (each token is either `key value` split on the first space, or a bare `key`):
    - `worktree <path>` -> `path` (absolute).
    - `HEAD <oid>` -> `head`; absent for a bare worktree -> `head = null`.
    - `branch <refname>` -> `branch` with the `refs/heads/` prefix stripped; absent when detached or bare -> `branch = null`.
    - `detached` (bare key) -> contributes to `state`.
    - `bare` (bare key) -> `state = "bare"`.
    - `locked` or `locked <reason>` -> `isLocked = true`; `lockedReason` set only when a non-empty reason follows. Reasons may contain spaces; keep the full remainder.
    - `prunable` or `prunable <reason>` -> `isPrunable = true`; `prunableReason` likewise.
  - `isMain`: true for the first parsed record. Git documents that the main worktree is listed first.
  - `state`: `"bare"` if `bare`; else `"detached"` if `detached`; else `"main"` when `isMain` is true; else `"linked"`. A detached main worktree therefore has `isMain === true` and `state === "detached"`.
  - `isCurrent`: true when normalized `path` equals normalized `currentRoot`. Do not call `realpath` in the parser because prunable or missing worktree paths can exist; service-layer code may realpath with `try/catch` and fall back to normalized paths.
- `export async function listWorktrees(executor: GitExecutor, currentRoot: string): Promise<GitWorktree[]>`
  - Runs `["worktree", "list", "--porcelain", "-z"]` and returns `parseWorktreeList(stdout, currentRoot)`.

Tests (`tests/unit/git/worktrees.test.ts`) — derive from the spec above, adversarial:
- Single-worktree repo: only the main worktree, `state === "main"`, `isCurrent` true.
- Two linked worktrees plus main: correct count, paths, short branch names.
- Detached main worktree fixture: `isMain === true` and `state === "detached"`.
- Detached worktree: `branch === null`, `state === "detached"`.
- Bare repo entry: `head === null`, `state === "bare"`.
- `locked` with no reason -> `isLocked true`, `lockedReason` undefined.
- `locked` with a multi-word reason -> reason preserved verbatim.
- `prunable <reason>` parsed.
- `branch refs/heads/feature/x` -> `branch === "feature/x"`.
- Path containing spaces parsed intact.
- Trailing NUL / empty trailing record ignored (no phantom worktree).
- Record missing `HEAD` does not crash.
- Mutation check: confirm a test fails if the `refs/heads/` strip is removed, if the locked flag is inverted, or if main/linked classification is swapped.

Acceptance criteria: `parseWorktreeList` passes all cases; `listWorktrees` returns a typed list against a real temporary repo created in the test with two added worktrees.

Out of scope: any UI, any mutation command, branch decoration.

---

## Phase 1 — Read-only Worktrees view

Role: VS Code extension engineer. Read Sections A, B, C and confirm Phase 0 is merged.

Objective: show worktrees in a native tree view in the IntelliGit container. No mutations.

Decision note: use a native `vscode.TreeDataProvider` (`vscode.window.createTreeView`), not a webview. It matches the PyCharm Worktrees tab with far less code.

Files:
- Create `src/services/worktreeService.ts` — `WorktreeService` class. Composition over a `GitExecutor` and the current repo root. Methods for this phase: `listWorktrees(): Promise<GitWorktree[]>` (delegates to `listWorktrees` from `src/git/worktrees.ts`), an in-memory cache, and a `refresh()` that re-pulls and fires a change event.
- Create `src/views/WorktreesTreeProvider.ts` — implements `vscode.TreeDataProvider<GitWorktree>`. Each row label: branch name or short HEAD when detached. Description: path basename. Context value / icon badges for `locked`, `prunable`, `detached`, and a marker for the current worktree.
- Modify `package.json` `contributes.views.intelligit` to add `{ "id": "intelligit.worktrees", "name": "%view.worktrees%", "type": "tree" }`. Add `%view.worktrees%` to `package.nls.json`.
- Wire the provider's refresh into `src/views/RefreshService.ts` so the view updates on Git state changes.
- Tests: `tests/unit/services/worktreeService.test.ts` and a provider-mapping unit test.

Implementation spec:
- `WorktreesTreeProvider` maps `GitWorktree[]` to tree items; no children (flat list).
- Badges derive purely from the `GitWorktree` flags. Current worktree visually distinguished.
- `WorktreeService.refresh()` invalidates the cache and triggers both the tree provider and any branch refresh consumers (used in later phases).

Tests:
- Provider maps a list to items with correct labels, descriptions, and badges.
- Empty / single-worktree repo shows only the main worktree.
- `refresh()` re-pulls (assert the executor is called again and the cache is replaced).

Acceptance criteria: opening the IntelliGit activity-bar container shows a Worktrees section listing real worktrees with correct badges and a current-worktree marker; refresh updates it.

Out of scope: create, delete, open, branch badges.

---

## Phase 2 — Branch badges, Open Worktree, checkout guard

Role: full-stack (extension host + React webview) engineer. Read Sections A, B, C; Phases 0-1 merged.

Objective: branch tree shows where each branch is checked out; checking out a branch that lives in another worktree opens that worktree instead of failing.

Files:
- `src/services/worktreeService.ts`: add `decorateBranches(branches: Branch[]): Branch[]` — returns new `Branch` objects (immutability) with `isCheckedOutInWorktree`, `worktreePath`, and `isCurrentWorktree` set by matching each branch name against the worktree list. Only the branch that matches a worktree is flagged.
- Branch refresh path: decorate once in `refreshActiveRepository` immediately after `gitOps.getBranches()`. Assign the decorated array to `currentBranches`, then pass that same array to `commitGraph`, `sidebarGraph`, `commitPanel`, and `undocked`. Do not decorate only inside one provider: host command routing resolves branch actions from `getCurrentBranches()`, so the trusted host branch state must contain `worktreePath`.
- `src/webviews/protocol/commitGraphTypes.ts`: add `"openWorktree"` to `BRANCH_ACTION_VALUES`.
- `src/webviews/react/branch-column/menu.ts`: in `getBranchMenuItems`, when `branch.isCheckedOutInWorktree` and it is not the current worktree, add an `Open Worktree` item (`action: "openWorktree"`). Localize the label via `t(...)`.
- `src/webviews/react/BranchColumn.tsx`: render a small badge beside branches where `isCheckedOutInWorktree` is true.
- `src/activation/repositoryViewEvents.ts`: ensure `forwardBranchAction` routes `openWorktree` to command `intelligit.openWorktree`. Register that command: it opens `branch.worktreePath` via `vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), { forceNewWindow })`. Offer current-window vs new-window (a quick pick, or two commands).
- `src/services/gitHelpers.ts` `checkoutBranch`: before running `git checkout`, if the resolved target branch is checked out in another (non-current) worktree, do not run checkout; return a discriminated signal (for example `{ kind: "openWorktree", path }`) or throw a typed error the caller maps to the Open Worktree flow. Update the return type and all callers accordingly.

Tests:
- `decorateBranches` flags exactly the branch matching a worktree and no others; sets `worktreePath`; marks `isCurrentWorktree` correctly; does not mutate the input array.
- `refreshActiveRepository` stores decorated branches in `currentBranches` and sends the same decorated branch list to every branch-consuming provider.
- `checkoutBranch` returns the open-worktree signal and does NOT call `executor.run(["checkout", ...])` when the branch lives in another worktree; still checks out normally otherwise.
- Menu shows `Open Worktree` only when checked out elsewhere; never for the current worktree's branch.

Acceptance criteria: a branch checked out in another worktree shows a badge; its context menu offers Open Worktree; invoking checkout on it opens the worktree (current or new window) instead of raising Git's "already checked out" error.

Out of scope: creating or deleting worktrees.

---

## Phase 3 — Create worktree from branch

Role: extension engineer. Read Sections A, B, C; Phases 0-2 merged.

Objective: create a worktree from a branch, matching PyCharm (location + name, remote-branch handling, new-branch option).

Files:
- `src/git/worktrees.ts`: add
  - `assertWorktreePathSafe(targetPath: string, repoRoot: string, existing: GitWorktree[]): void` — throws on nesting inside the repo, nesting inside any existing worktree, or a non-empty existing directory. Compare both normalized paths and, where paths already exist, realpaths; if `realpath` fails for a missing target, fall back to normalized absolute paths.
  - `async function addWorktree(executor, opts: { path: string; branch?: string; newBranch?: string; base?: string; detach?: boolean }): Promise<void>`.
- `src/services/worktreeService.ts`: `createWorktree(opts)` — validates via `assertWorktreePathSafe` and `assertValidBranchName`, runs `addWorktree`, refreshes, optionally opens the new worktree.
- `src/webviews/protocol/commitGraphTypes.ts`: add `"createWorktreeFromBranch"` to `BRANCH_ACTION_VALUES`.
- `src/webviews/react/branch-column/menu.ts`: add `Create Worktree` item when the branch is not already checked out in a worktree.
- `package.json`: register command `intelligit.createWorktreeFromBranch` (and a generic `intelligit.worktree.create` for the view title). Add localized titles to `package.nls.json`. The command prompts for a location (`vscode.window.showOpenDialog`, folder pick) and a worktree/branch name (`showInputBox`).
- `src/activation/repositoryViewEvents.ts`: route `createWorktreeFromBranch`.

Git command mapping (argument arrays):
- Existing local branch: `["worktree", "add", path, branch]`.
- New branch: `["worktree", "add", "-b", newBranch, path, base]`.
- Detached at a commit: `["worktree", "add", "--detach", path, commit]`.
- Remote branch: create a local branch from the remote (`-b <local> <path> <remote/branch>`) and then explicitly run `branch --set-upstream-to=<remote>/<remoteBranch> <local>` so tracking does not depend on Git config defaults. If the user supplies a different new-branch name, use that local name but still set the upstream to the selected remote branch.

Tests:
- `assertWorktreePathSafe` rejects: a path inside `repoRoot`, a path inside an existing worktree, and a non-empty existing directory. Adversarial: trailing slash, `..` segments, a path equal to an existing worktree.
- `assertWorktreePathSafe` rejects symlink escapes by comparing realpaths for existing paths.
- `addWorktree` produces the correct argument array per mode (existing vs `-b` vs `--detach`).
- Remote-branch flow creates a local branch and explicitly sets upstream tracking.

Acceptance criteria: creating from a branch produces a worktree on disk, the view refreshes to show it, and the path/name guards reject unsafe inputs with clear messages.

Out of scope: delete, copy-ignored-files, advanced ops.

---

## Phase 4 — Safe delete worktree

Role: extension engineer. Read Sections A, B, C; Phases 0-3 merged.

Objective: remove a worktree safely from the view, with guards.

Files:
- `src/git/worktrees.ts`: `async function removeWorktree(executor, path: string, force: boolean): Promise<void>` -> `["worktree", "remove", ...(force ? ["--force"] : []), path]`.
- `src/services/worktreeService.ts`: `removeWorktree(path)` — refuses `isMain` and the current worktree; checks whether the worktree is dirty; if dirty, requires an explicit confirmation before passing `force: true`; never touches the branch.
- `package.json`: command `intelligit.worktree.delete` on the worktree row context menu. Localized title and confirmation strings.

Dirty detection: run `git status --porcelain` scoped to that worktree (a `GitExecutor` rooted at the worktree path), treat any output as dirty.

Tests:
- Removing an `isMain` or current worktree is rejected, including a detached main worktree.
- A clean worktree is removed without `--force`.
- A dirty worktree is blocked unless force is explicitly confirmed (simulate the confirmation).
- The branch still exists after removal.

Acceptance criteria: delete works from the row, refuses main/current, warns on a dirty worktree and only force-removes on explicit confirmation, and never deletes a branch.

Out of scope: everything in Phase 5+.

--- MVP complete here ---

## Phase 5 — Copy ignored files into a new worktree

Role: extension engineer. Read Sections A, B, C; Phase 3 merged.

Objective: optionally seed a new worktree with gitignored local files (for example `.env`, `.vscode/settings.json`).

Files:
- `package.json`: setting `intelligit.worktree.includeFiles` (`string[]`, default `[]`), with description. Localize.
- `src/services/worktreeService.ts`: after `addWorktree` succeeds, copy each configured relative path from the source repo root into the new worktree, preserving subdirectories. Validate each entry stays within the source root (reject `..` and absolute paths). Silently skip entries that do not exist.

Tests: configured files are copied into the new worktree; missing entries are skipped without error; path-traversal entries are rejected and never read or written outside the source root.

Acceptance criteria: creating a worktree with configured include-files copies them; unsafe or absent entries are handled safely.

---

## Phase 6 — Advanced operations (lock, unlock, move, prune, repair)

Role: extension engineer. Read Sections A, B, C; Phases 0-4 merged.

Objective: expose the remaining worktree management commands.

Files:
- `src/git/worktrees.ts`: add free functions ->
  - `lockWorktree(executor, path, reason?)` -> `["worktree", "lock", ...(reason ? ["--reason", reason] : []), path]`.
  - `unlockWorktree(executor, path)` -> `["worktree", "unlock", path]`.
  - `moveWorktree(executor, path, newPath)` -> `["worktree", "move", path, newPath]` (re-validate `newPath` with `assertWorktreePathSafe`).
  - `pruneWorktrees(executor)` -> `["worktree", "prune"]`.
  - `repairWorktrees(executor)` -> `["worktree", "repair"]`.
- `src/services/worktreeService.ts`: corresponding methods.
- `package.json`: row and view-title commands for each, localized.

Tests: each function builds the correct argument array; `move` re-validates the destination; lock with and without a reason.

Acceptance criteria: lock/unlock/move/prune/repair work from the UI and reflect in the refreshed view.

---

## Phase 7 — Later (not yet specified)

Out of scope until Phases 0-4 ship. Candidates: checking out a pull request as a worktree; an AI-agent worktree flow. Specify these as their own plan when prioritized (YAGNI until then).

---

## Recommended study order (foundation-first)

1. Section A — Shared Context
2. Section B — Data Model (`src/types.ts`)
3. Section C — Conventions and Safety
4. `src/git/executor.ts`, `src/services/gitHelpers.ts` (existing idioms)
5. Phase 0 — `src/git/worktrees.ts` (parser)
6. Phase 1 — `src/services/worktreeService.ts`, `src/views/WorktreesTreeProvider.ts`
7. Phase 2 — branch decoration, `src/webviews/protocol/commitGraphTypes.ts`, `src/webviews/react/branch-column/menu.ts`, `checkoutBranch` guard
8. Phases 3-6 — create, delete, copy-files, advanced
