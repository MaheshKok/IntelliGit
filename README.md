<h1 align="center">IntelliGit</h1>

<p align="center">
  <a href="package.nls.json">🇬🇧 English</a> •
  <a href="package.nls.de.json">🇩🇪 Deutsch</a> •
  <a href="package.nls.es.json">🇪🇸 Español</a> •
  <a href="package.nls.fr.json">🇫🇷 Français</a> •
  <a href="package.nls.ja.json">🇯🇵 日本語</a> •
  <a href="package.nls.ko.json">🇰🇷 한국어</a> •
  <a href="package.nls.pl.json">🇵🇱 Polski</a> •
  <a href="package.nls.pt-br.json">🇧🇷 Português</a> •
  <a href="package.nls.pt-pt.json">🇵🇹 Português</a> •
  <a href="package.nls.ru.json">🇷🇺 Русский</a> •
  <a href="package.nls.zh-cn.json">🇨🇳 简体中文</a> •
  <a href="package.nls.zh-tw.json">🇹🇼 繁體中文</a>
</p>

<p align="center">
  <img src="media/intelligit-icon.png" alt="IntelliGit logo" width="96" />
</p>

<p align="center">
  <strong>The best Git features from JetBrains, VS Code, and Visual Studio IDE.</strong><br />
  A focused commit panel, readable branch graph, shelf workflow, and merge tooling for developers who want powerful IDE Git inside VS Code.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="package.json"><img alt="Package version" src="https://img.shields.io/github/package-json/v/MaheshKok/IntelliGit?label=version&color=2ea043" /></a>
  <a href="package.json"><img alt="VS Code 1.96+" src="https://img.shields.io/badge/VS%20Code-1.96%2B-007ACC.svg" /></a>
</p>

<p align="center">
  <img src="media/screenshots/commit-actions.png" alt="IntelliGit commit action menu" />
</p>

IntelliGit brings the best Git workflow ideas from PyCharm, VS Code, and Visual Studio IDE into one VS Code extension: a real commit panel, a readable branch graph, branch actions where the history is, shelf-style parking for unfinished work, and merge-conflict tools that do not make you rebuild context from terminal output.

It does not try to replace Git. It gives the daily Git work a better cockpit.

## Why IntelliGit Exists

VS Code is fast and flexible, but Git work often ends up split across the Source Control view, terminal commands, diff tabs, branch pickers, and third-party graph extensions. That is fine for small changes. It gets tiring when you are shaping commits, checking history, moving branches, or cleaning up before a push.

IntelliGit pulls those workflows into one JetBrains-inspired surface:

- A focused commit panel for staging, rollback, amend, commit, and push.
- An actionable commit graph with branch and history operations.
- Shelf/stash and worktree workflows.
- A three-pane merge-conflict editor — **Yours, editable Result, and Theirs side by side**.
- **CI check status for GitHub, GitLab, and Bitbucket.**
- A unified workbench that can be moved to another monitor.

## Feature Gallery

### Three-Pane Merge Editor

![IntelliGit three-pane merge editor showing Yours, editable Result, and Theirs side by side](media/screenshots/three-pane-merge-editor.png)

Resolve complex conflicts without stacking or switching editors. Yours, the
editable Result, and Theirs stay visible side by side, with aligned conflict
bands, visual connectors, conflict navigation, and explicit apply or abort
controls.

### Commit Panel

<p align="center">
  <img src="media/screenshots/commit-panel.png" alt="IntelliGit commit panel with staged, changed, and unversioned files" width="70%" />
</p>

The commit panel keeps the daily commit loop in one focused view. Stage by file,
folder, or whole section; keep tracked changes and unversioned files separated;
review per-file status and line deltas; then commit, push, or amend without
leaving the Git surface. File context actions cover rollback, jump to source,
delete, shelve changes, show history, and refresh.

### Shelf Workflow

<p align="center">
  <img src="media/screenshots/shelf-workflow.png" alt="IntelliGit shelf workflow with apply, pop, drop, and show diff actions" width="70%" />
</p>

The Shelf/Stash tab is built for interrupted work. Park partial or full changes,
preview the files inside a shelved entry, show a diff before restoring it, then
apply, pop, or drop the entry from the same panel. This gives VS Code a workflow
closer to JetBrains shelf handling than raw terminal stash juggling.

### Commit Graph, Changed Files, And CI Checks

![IntelliGit commit graph with branch lanes, changed files, and commit check popover](media/screenshots/commit-checks.png)

The graph view combines branch search, branch lanes, commit search, changed
files, commit metadata, and CI/CD checks. Commit check badges show provider
status directly in history, and the popover exposes individual GitHub, GitLab,
Bitbucket Cloud, or Bitbucket Server checks with links back to the provider.

### Branch Actions

<p align="center">
  <img src="media/screenshots/branch-actions.png" alt="IntelliGit branch action menu in the commit graph" width="70%" />
</p>

Branch actions live where branch decisions happen. The branch tree groups
current, local, remote, and worktree branches, then exposes context-aware actions
such as checkout, new branch, checkout-and-rebase, rebase, merge, update, push,
rename, delete, and worktree creation.

### Commit Actions

![IntelliGit commit action menu with patch, cherry-pick, reset, revert, rebase, branch, and tag actions](media/screenshots/commit-actions.png)

Commit history is actionable, not read-only. Right-click a commit to copy its
hash, create a patch, cherry-pick, checkout the revision, reset the current
branch, revert, push up to that commit, undo, edit the message, squash, drop,
start an interactive rebase, create a branch, or create a tag. Risky actions are
guarded by context and confirmations.

### Unified IntelliGit Workbench

![IntelliGit Undock picker with editor-tab and new-window options](media/screenshots/undock-workflow.png)

![Undocked IntelliGit workbench with commit panel, branch tree, graph, changed files, and details](media/screenshots/intelligit-workbench.png)

When you need room, IntelliGit can run as a unified workbench tab. The `Undock`
feature allows you to undock the Git window and move it to another screen. The
commit panel, branch tree, graph lanes, changed-file tree, and commit details
stay in one layout, with dock/undock support for monitor-heavy workflows.

### Publish Branch

![IntelliGit publish branch provider picker for GitHub, GitLab, Bitbucket Cloud, and Bitbucket Server](media/screenshots/publish-branch.png)

Publishing is not limited to pushing an existing remote. IntelliGit can create a
repository or project on GitHub, GitLab, Bitbucket Cloud, or Bitbucket Server,
add the remote, and push the selected branch through one guided flow.

## Feature Support

| Area              | Supported                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit workflow   | Staging by section, folder, or file; rollback; delete; jump to source; amend; commit; push                                                                         |
| Shelf/Stash       | Shelve changes, preview files, show diff, apply, pop, drop                                                                                                         |
| Graph and history | Branch lanes, branch search, commit search, branch filter, pagination, changed files, commit metadata                                                              |
| Branches          | Checkout, new branch, checkout-and-rebase, rebase, merge, update, push, rename, delete                                                                             |
| Commits           | Copy hash, create patch, cherry-pick, checkout revision, reset, revert, push up to here, undo, edit message, squash, drop, interactive rebase, new branch, new tag |
| Worktrees         | Create, create from branch, delete, lock, unlock, move, prune, repair                                                                                              |
| Merge conflicts   | Conflict tree, conflict sessions, horizontal Yours/Result/Theirs editor, editable result, accept yours/theirs, VS Code native merge editor                         |
| Hosting           | Clone repository, initialize repository, publish branch, create remote repositories/projects                                                                       |
| Commit checks     | GitHub, GitLab, Bitbucket Cloud, Bitbucket Server, self-hosted host mapping, CI/CD status popovers                                                                 |
| Layout            | Activity bar view, bottom graph panel, unified undocked workbench tab                                                                                              |
| Localization      | English, German, Spanish, French, Japanese, Korean, Polish, Portuguese, Russian, Simplified Chinese, Traditional Chinese                                           |

## Quick Start

1. Install IntelliGit.
2. Open a Git repository in VS Code.
3. Open IntelliGit from the activity bar.
4. Use the `Commit` tab to stage files and commit.
5. Open the bottom IntelliGit panel to inspect history, filter branches, and act on commits.

## Installation

Search for **IntelliGit** in VS Code Extensions, or install from:

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MaheshKok.intelligit)
- [Open VSX Registry](https://open-vsx.org/extension/MaheshKok/intelligit)

## Requirements

- VS Code `1.96.0` or later
- Git installed and available on `PATH`

## Settings

Configure IntelliGit from VS Code Settings or `settings.json`.

```jsonc
{
    // Enable tooltips inside IntelliGit webviews.
    "intelligit.tooltips.enabled": true,

    // Open IntelliGit as a unified editor tab when Show Git Log is invoked.
    "intelligit.undockableWindow": false,

    // Icon style used in IntelliGit panels: "standard" or "color".
    "intelligit.icons": "standard",

    // Commit panel position inside the undocked/tabbed IntelliGit window: "auto", "left", or "right".
    "intelligit.commitWindowPosition": "auto",

    // Automatically hide the successful-commit status bar confirmation after five seconds.
    // Set to false to retain it until the next successful commit.
    "intelligit.keepLastCommitNotification": true,
}
```

## Development

```bash
bun install
bun run build
bun run watch
bun run lint
bun run typecheck
bun run test
bun run format
```

### Documentation Standards

Use the IntelliGit TSDoc standard in [docs/tsdocs/TSDOC.md](docs/tsdocs/TSDOC.md) when documenting exported or boundary-facing TypeScript/TSX symbols. Prefer comments that capture contracts, invariants, side effects, and trust boundaries over comments that repeat TypeScript types. The rollout plan is tracked in [docs/tsdocs/codex-tsdoc-rollout-plan.md](docs/tsdocs/codex-tsdoc-rollout-plan.md).

Contributor and reviewer checklist:

- Update TSDoc in the same change that adds or changes exported/boundary-facing TypeScript or TSX symbols.
- Reject comments that only restate types, use vague verbs such as "handles" or "returns", or describe behavior that is no longer true.
- Keep the source documentation ratchet enabled; do not weaken lint enforcement to land undocumented exports.
- During release maintenance, scan for stale `@todo`, `TODO`, `FIXME`, `@deprecated`, and `@remarks` notes in `src` and `docs`.

### Manual Extension Test

```bash
bun install
bun run build
bun run package
code --install-extension intelligit-*.vsix
```

### Test Suite

```bash
# Run all unit and integration tests.
bun run test

# Watch mode.
bun run test -- --watch

# Run a specific test file.
bun run test -- tests/unit/gitops.test.ts

# Run tests matching a pattern.
bun run test -- -t "CommitPanelApp"
```

## Architecture

```text
GitExecutor (simple-git wrapper)
    |
GitOps (operations layer)
    |
View Providers (extension host orchestration)
    |
Webviews (React apps for commit panel and commit graph)
```

Data flow highlights:

1. Commit selection in the graph requests commit details from the extension host and updates the detail pane.
2. Branch selection filters the graph and clears stale commit detail state.
3. Commit panel file count updates the activity badge.
4. Refresh reloads branch state, history, and commit panel data together.

## Tech Stack

| Component       | Technology         |
| --------------- | ------------------ |
| Extension host  | TypeScript, ES2022 |
| Git operations  | simple-git v3      |
| Webviews        | React 18           |
| Graph rendering | HTML5 Canvas       |
| Bundler         | esbuild            |
| Package manager | Bun                |
| Testing         | Vitest             |
| Linting         | ESLint             |
| Formatting      | Prettier           |

## License

[MIT](LICENSE)
