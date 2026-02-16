# Changelog

All notable changes to IntelliGit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-16

### Added

#### Commit Panel (Sidebar)
- Tabbed interface with Commit and Shelf tabs
- File tree with directory grouping, collapsible folders, and indent guide lines
- Per-file checkboxes for selective staging at section, folder, and individual file level
- Checkbox state persistence across navigation via webview state
- File type icon badges with colored backgrounds for 20+ file types
- Status-colored filenames (modified, added, deleted, renamed, conflicting, untracked)
- Addition/deletion stats per file
- Single-click file to open diff view
- Toolbar with Refresh, Rollback, Group by Directory, Shelve, Show Diff, Expand All, Collapse All
- Amend mode with auto-filled last commit message
- Commit and Commit & Push buttons
- Drag-resizable divider between file list and commit message area

#### Shelf (Stash) System
- Create shelves with custom messages
- Partial shelf support (stash only selected files)
- Apply, Pop (apply + remove), and Delete operations per shelf
- Formatted timestamps and stash count badge on tab

#### Commit Graph (Bottom Panel)
- Two-column resizable layout with branch tree and commit list
- Canvas-rendered lane-based commit graph with bezier merge curves
- Ring-style commit dots with 10 rotating lane colors
- Retina/HiDPI display support
- Ref badges for HEAD, tags, remote branches, and local branches
- Text and hash search with debounced filtering
- Infinite scroll with 500-commit pagination
- Click commit to load changed files and details

#### Branch Column
- Hierarchical branch tree with HEAD, Local, and Remote sections
- Prefix-based folder grouping for branch names
- Current branch highlighted with tracking info (ahead/behind badges)
- Click branch to filter graph; right-click for branch operations
- Custom context menu with full branch management
- Drag-resizable column width

#### Changed Files (Bottom Panel)
- Directory tree with status icons (Added, Modified, Deleted, Renamed, Copied)
- Per-file addition/deletion line counts
- Indent guide lines matching VS Code native tree style
- Drag-resizable divider between file tree and commit details
- Collapsible commit details section with message, hash, author, email, date

#### Branch Management (Sidebar Tree View)
- HEAD indicator with current branch and short hash
- Local and remote branches with tracking info
- Context menu: Checkout, New Branch, Checkout and Rebase, Compare, Show Diff, Rebase, Merge, Update, Push, Rename, Delete

#### General
- Activity bar icon with changed file count badge
- Auto-refresh via debounced file system watcher (300ms)
- Keyboard shortcut Alt+9 to open IntelliGit views
- Content Security Policy enforced in all webviews

#### CI/CD
- GitHub Actions workflow for build validation on PRs
- Dual marketplace publishing (VS Code Marketplace + Open VSX) on version bump to main
- Automatic git tagging and GitHub Release creation with VSIX attachment
