# IntelliGit - PyCharm Git for VS Code

IntelliGit is an IntelliJ/PyCharm-style Git extension for VS Code. It provides an intelligent Git workflow with commit graph visualization, branch management, file staging, and a Shelf workflow designed to feel familiar to PyCharm Git users.

## Features

### Commit Panel (Sidebar)

A tabbed sidebar panel for staging, committing, and shelving changes.

**Commit Tab**
- File tree with directory grouping, collapsible folders, and indent guide lines
- Per-file checkboxes for selective staging (section, folder, and individual file level)
- Checkbox state persists across navigation via webview state
- File type icon badges with colored backgrounds for 20+ file types (TS, JS, PY, GO, RS, etc.)
- Status-colored filenames (orange for modified, green for added, red with strikethrough for deleted, purple for renamed)
- Addition/deletion stats per file (+X / -X)
- Single-click any file to open its diff
- Toolbar: Refresh, Rollback, Group by Directory, Shelve, Show Diff, Expand All, Collapse All
- Amend mode with auto-filled last commit message
- Commit and Commit & Push buttons
- Drag-resizable divider between file list and commit message area

**Shelf Tab**
- Full stash management with IntelliJ-style "Shelf" naming
- Create shelves with custom messages (supports partial stash of selected files)
- Apply, Pop (apply + remove), or Delete individual shelves
- Formatted timestamps and stash count badge on tab

### Commit Graph (Bottom Panel)

A two-column resizable panel showing the full commit history.

**Branch Column (left)**
- Hierarchical branch tree: HEAD, Local, and Remote sections
- Prefix-based folder grouping (e.g. `feature/auth` and `feature/ui` grouped under `feature/`)
- Current branch highlighted in green with tracking info (ahead/behind badges)
- Click a branch to filter the graph; right-click for branch operations
- Custom context menu with checkout, merge, rebase, push, rename, delete, and more
- Drag-resizable column width (80px - 500px)

**Commit List (right)**
- Canvas-rendered lane-based commit graph with bezier merge curves
- Ring-style commit dots with 10 rotating lane colors
- Retina/HiDPI display support
- Ref badges: HEAD (green), tags (orange), remote branches (blue), local branches (purple)
- Author name and formatted date per row
- Text/hash search with debounced filtering
- Infinite scroll with 500-commit pagination
- Click a commit to load its changed files and details below

### Changed Files (Bottom Panel)

Shows the files changed in the selected commit.

- Directory tree with status icons (Added, Modified, Deleted, Renamed, Copied)
- Per-file addition/deletion line counts
- Indent guide lines matching VS Code's native tree style
- Drag-resizable divider between file tree and commit details
- Collapsible commit details section: message, body, hash, author, email, date, file count

### Branch Management (Sidebar Tree View)

A native VS Code tree view for branch operations.

- HEAD indicator with current branch and short hash
- Local and remote branches with tracking info (ahead/behind)
- Full context menu:

| Action | Available On |
|--------|-------------|
| Checkout | Local, Remote |
| New Branch from... | Current, Local, Remote |
| Checkout and Rebase onto Current | Local, Remote |
| Compare with Current | Local, Remote |
| Show Diff with Working Tree | Current, Local, Remote |
| Rebase Current onto Selected | Local, Remote |
| Merge into Current | Local, Remote |
| Update (fetch + pull) | Current, Local, Remote |
| Push | Current, Local |
| Rename | Current, Local |
| Delete | Local, Remote |

### Activity Bar Badge

The IntelliGit icon in the activity bar shows a badge with the number of changed files in the workspace, updated automatically via a debounced file system watcher.

## Keyboard Shortcuts

| Key | Command |
|-----|---------|
| `Alt+9` | Open IntelliGit (focus branches + commit graph) |

## Requirements

- VS Code 1.96.0 or later
- Git installed and available on PATH

## Installation

### From Marketplace

Search for **IntelliGit** in the VS Code Extensions view, or install from:
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MaheshKok.intelligit)
- [Open VSX Registry](https://open-vsx.org/extension/MaheshKok/intelligit)

### From VSIX

```bash
bun install
bun run package
code --install-extension intelligit-*.vsix
```

## Development

```bash
# Install dependencies
bun install

# Build (development)
bun run build

# Watch mode
bun run watch

# Run linter
bun run lint

# Type check
bun run typecheck

# Run tests
bun run test

# Format code
bun run format
```

### Project Structure

```
src/
  extension.ts              # Activation, command registration, view coordination
  types.ts                  # Shared TypeScript types
  git/
    executor.ts             # simple-git wrapper (max 6 concurrent processes)
    operations.ts           # High-level Git operations
  views/
    CommitPanelViewProvider.ts   # Sidebar commit/shelf webview
    CommitGraphViewProvider.ts   # Bottom panel commit graph webview
    CommitInfoViewProvider.ts    # Bottom panel changed files webview
    BranchTreeProvider.ts        # Sidebar branch tree (native tree view)
  webviews/react/
    CommitGraphApp.tsx      # React app for commit graph
    CommitList.tsx           # Scrollable commit list with canvas graph
    BranchColumn.tsx         # Resizable branch tree column
    graph.ts                 # Lane-based graph layout algorithm
media/
  intelligit.svg            # Extension icon
```

### Architecture

```
GitExecutor (simple-git)
    |
GitOps (operations layer)
    |
View Providers (webview hosts)
    |
Webviews (HTML / React)
```

The extension host coordinates all views. Views never communicate directly — the extension acts as the sole data broker. Events flow through:

1. Commit graph emits `onCommitSelected` -> extension loads commit detail -> Changed Files view updates
2. Branch tree/graph emits `onBranchFilterChanged` -> commit graph filters
3. File system watcher (debounced 300ms) -> commit panel auto-refreshes
4. Commit panel emits `onDidChangeFileCount` -> activity bar badge updates

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension host | TypeScript (strict), ES2022 |
| Git operations | simple-git v3 |
| Commit graph UI | React 18 |
| Graph rendering | HTML5 Canvas |
| Bundler | esbuild |
| Package manager | Bun |
| Testing | Vitest |
| Linting | ESLint |
| Formatting | Prettier |

## CI/CD

GitHub Actions workflow runs on every push to any branch:
- Lint, typecheck, test, build, and package
- On push to `main` with a version bump in `package.json`:
  - Publishes to VS Code Marketplace and Open VSX Registry
  - Creates a git tag and GitHub Release with the VSIX attached

## License

[MIT](LICENSE)
