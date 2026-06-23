# IntelliGit

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
  <strong>The best Git features from PyCharm, VS Code, and Visual Studio IDE.</strong><br />
  A focused commit panel, readable branch graph, shelf workflow, and merge tooling for developers who want powerful IDE Git inside VS Code.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="package.json"><img alt="Package version" src="https://img.shields.io/github/package-json/v/MaheshKok/IntelliGit?label=version&color=2ea043" /></a>
  <a href="package.json"><img alt="VS Code 1.96+" src="https://img.shields.io/badge/VS%20Code-1.96%2B-007ACC.svg" /></a>
</p>

<p align="center">
  <img src="image.png" alt="IntelliGit commit panel and graph" />
</p>

IntelliGit brings the best Git workflow ideas from PyCharm, VS Code, and Visual Studio IDE into one VS Code extension: a real commit panel, a readable branch graph, branch actions where the history is, shelf-style parking for unfinished work, and merge-conflict tools that do not make you rebuild context from terminal output.

It does not try to replace Git. It gives the daily Git work a better cockpit.

## Why IntelliGit Exists

VS Code is fast and flexible, but Git work often ends up split across the Source Control view, terminal commands, diff tabs, branch pickers, and third-party graph extensions. That is fine for small changes. It gets tiring when you are shaping commits, checking history, moving branches, or cleaning up before a push.

IntelliGit pulls those workflows into one JetBrains-inspired surface:

- Build clean commits from a focused file tree with staging, rollback, amend, commit, and commit-and-push.
- Browse history in a visual commit graph with branch lanes, search, filters, metadata, and changed files.
- Act on branches and commits from the graph instead of jumping back to the command line.
- Park unfinished work with a shelf-style stash workflow.
- Handle risky history operations with availability rules and confirmations.
- Open conflicts in IntelliGit's native merge flow, VS Code, or an optional JetBrains merge tool.

## Product Highlights

### Commit Without Losing The Thread

The commit panel gives you a file tree, selective staging, diff-on-click, rollback, shelve, amend, commit, and commit-and-push in one place. It is built for making intentional commits, not just dumping everything into `git commit -am`.

### A Graph You Can Work From

The bottom panel combines branch list, commit graph, and commit details. Select a commit to see metadata and changed files. Filter by branch or search by text/hash. Use the same surface to checkout, rebase, merge, update, push, rename, delete, or create branches from commits.

### Safer History Actions

Advanced actions are available where you need them: cherry-pick, create patch, checkout revision, reset current branch, revert, undo commit, edit commit message, drop commit, interactive rebase, new branch, and new tag. Destructive or history-rewriting actions are guarded by context, pushed/merge-commit checks, and confirmations.

### Shelf-Style Parking

Need to switch context before a change is ready? Use the Shelf tab to stash full or partial work, then apply, pop, or delete it later. It feels closer to the JetBrains shelf workflow than raw stash juggling.

### Merge Conflict Flow

IntelliGit detects merge conflicts, lets you open conflict sessions, accept yours/theirs, refresh the conflict tree, and optionally launch a JetBrains IDE merge tool. If no external tool is configured, it falls back to the native editor flow.

### Localized Product Surface

IntelliGit localizes command names, settings, host notifications, prompts, errors, and webview UI strings. Supported languages: English, German, Spanish, French, Japanese, Korean, Polish, Portuguese (Brazil), Portuguese (Portugal), Russian, Simplified Chinese, and Traditional Chinese.

## Core Workflows

### Commit And Shelf

- Stage by section, folder, or file.
- Open diffs from the file tree.
- Roll back selected files.
- Group by directory.
- Show diff previews.
- Expand or collapse the tree.
- Commit, commit and push, or amend.
- Shelve full or partial changes.
- Apply, pop, or delete shelved entries.

### Commit Graph And History

- Three-pane layout: branch column, commit graph/list, and commit details.
- Canvas-based lane graph with pagination for large histories.
- Text/hash search.
- Branch filtering.
- Changed files, file stats, and commit metadata.
- Workspace changed-file badge in the activity bar.

### Branch Actions

| Action                           | Applies To             |
| -------------------------------- | ---------------------- |
| Checkout                         | Local, Remote          |
| New Branch from...               | Current, Local, Remote |
| Checkout and Rebase onto Current | Local, Remote          |
| Rebase Current onto Selected     | Local, Remote          |
| Merge into Current               | Local, Remote          |
| Update                           | Current, Local         |
| Push                             | Current, Local         |
| Rename...                        | Current, Local         |
| Delete                           | Local, Remote          |

### Commit Actions

- Copy Revision Number
- Create Patch
- Cherry-Pick
- Checkout Revision
- Reset Current Branch to Here
- Revert Commit
- Undo Commit
- Edit Commit Message
- Drop Commit
- Interactively Rebase from Here
- New Branch
- New Tag

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
    // JetBrains IDE binary path/command or a macOS .app bundle path.
    // Examples: "", "pycharm", "idea", "webstorm", "/Applications/PyCharm.app",
    // "C:\\Program Files\\JetBrains\\PyCharm 2025.1\\bin\\pycharm64.exe"
    "intelligit.jetbrainsMergeTool.path": "",

    // Prefer JetBrains merge tool for conflicts, falling back to IntelliGit/VS Code if unavailable.
    "intelligit.jetbrainsMergeTool.preferExternal": false,

    // Enable tooltips inside IntelliGit webviews.
    "intelligit.tooltips.enabled": true,

    // Open IntelliGit as a unified editor tab when Show Git Log is invoked.
    "intelligit.undockableWindow": false,

    // Icon style used in IntelliGit panels: "standard" or "color".
    "intelligit.icons": "standard",

    // Commit panel position inside the undocked/tabbed IntelliGit window: "auto", "left", or "right".
    "intelligit.commitWindowPosition": "auto",
}
```

## JetBrains Merge Tool Setup

IntelliGit can open merge conflicts in a JetBrains IDE merge tool such as PyCharm, IntelliJ IDEA, or WebStorm.

1. Open VS Code Settings and search for `IntelliGit: JetBrains Merge Tool Path`.
2. Set `intelligit.jetbrainsMergeTool.path` to your JetBrains app path.
3. On macOS, you can paste the `.app` path directly; IntelliGit resolves the internal executable.
4. Enable `intelligit.jetbrainsMergeTool.preferExternal` if you want IntelliGit to try JetBrains first.

macOS examples:

- `/Applications/PyCharm.app`
- `/Applications/IntelliJ IDEA.app`
- `/Applications/WebStorm.app`
- `/Users/<your-user>/Applications/PyCharm.app`

Windows examples:

- `C:\\Program Files\\JetBrains\\PyCharm 2025.1\\bin\\pycharm64.exe`
- `C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.1\\bin\\idea64.exe`
- `C:\\Program Files\\JetBrains\\WebStorm 2025.1\\bin\\webstorm64.exe`

Helpful command:

- Run `IntelliGit: Detect JetBrains Merge Tool` from the Command Palette to auto-detect installed JetBrains IDEs and save the path.

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
