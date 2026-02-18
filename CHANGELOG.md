# Changelog

All notable changes to IntelliGit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-02-18

### Added

- IntelliJ-style commit context menu actions in Commit Graph:
    - Copy Revision Number
    - Create Patch
    - Cherry-Pick
    - Checkout main/default branch
    - Checkout Revision
    - Reset Current Branch to Here
    - Revert Commit
    - New Branch
    - New Tag
    - Undo Commit (unpushed only)
    - Edit Commit Message (unpushed only)
    - Drop Commits (unpushed only)
    - Interactively Rebase from Here (unpushed only)
- Commit action enable/disable rules based on commit state (pushed/unpushed/merge) to match IntelliJ behavior.
- Merge-commit-specific handling in commit menus and disabled states.
- Branch panel inline search box with:
    - live case-insensitive substring filtering
    - highlighted match segments in branch names
    - clear (`x`) button
- `react-icons` integration for branch search/clear glyphs.

### Changed

- Major visual parity pass toward IntelliJ/PyCharm across:
    - Commit panel
    - Branch panel
    - Context menus
    - Shelf tab
- Branch context menu layout:
    - tighter left padding and reduced extra gutter
    - improved popup placement near branch row icon/right-click anchor
    - stronger shadow/depth treatment
- Branch panel header:
    - reduced spacing under search/header area
    - `HEAD` label now shows current branch name (`HEAD (<branch>)`)
- Branch panel typography/spacing:
    - reduced row vertical padding and margins for denser tree layout
    - improved indentation for nested branch folders and branch children
- Commit panel typography:
    - standardized Chakra fonts to VS Code font variables for consistent family across panels.
- Commit files tree and shelf list styling aligned closer to IntelliJ row heights, spacing, selection color, and button geometry.
- Toolbar/icon spacing and visual alignment across commit/shelf tabs.

### Removed

- Branch context menu option: `Compare with '<branch>'`.
- Branch context menu option: `Show Diff with Working Tree`.
- Related extension command contributions and handlers for both removed options.
- Extra icons/actions next to `Amend` in commit area (as requested).

### Fixed

- Commit files tree collapse behavior:
    - collapsed folders no longer auto-expand unexpectedly
    - collapse all now preserves expected root visibility behavior
- Checkbox visual/size consistency in commit files tree:
    - reduced size to better match folder icon scale and IntelliJ feel.
- Changed Files interactions:
    - clicking files opens diff reliably
    - context menus restored after regressions (instead of default browser menu)
- Commit files tree indentation:
    - reduced over-indentation for deeper nested paths.
- Branch tree indentation:
    - improved child branch indentation under grouped prefixes.
- Commit panel path wrapping/truncation:
    - long path segments use available width better, with reduced unwanted wrapping.
- Context menu layout regressions:
    - corrected item spacing, ordering, disabled-state styling, and alignment.
- Right-click context behavior on:
    - commit rows
    - changed files
    - branches
- Shelf panel behavior:
    - shelf actions and layout corrected
    - shelf file changes displayed in tree format like Changed Files
    - apply/pop/delete controls and styling aligned.
- Dotfile icon detection:
    - files like `.eslintrc.json` now resolve to correct extension icon (`json`) instead of generic dotfile fallback.
- JSON badge token conflict:
    - JSON label is now distinct from JavaScript badge text.
- Context menu viewport clamping:
    - reposition recalculates when menu item count/content changes.

### Stability and Error Handling

- File context command handlers now have safer async error handling:
    - `fileRollback`
    - `fileShelve`
    - `fileShowHistory`
    - success/info and error feedback are surfaced consistently.
- `fileDelete` error handling now discriminates expected “not tracked/pathspec” cases from unexpected errors.
- Workspace safety guard added for webview file operations:
    - avoids crashes when no workspace folder is open.
- `git rm` behavior made safer:
    - `deleteFile` supports optional `force`
    - default path avoids forced deletion of modified files.

### Architecture and Maintainability

- Continued migration toward reusable React components and shared styling patterns.
- Centralized/shared context menu and tree rendering improvements used across panels.
- Multiple UI consistency passes to reduce raw/one-off styling divergence and improve production readiness.

## [0.1.2] - 2026-02-16

### Added

- Marketplace icon (256x256 PNG with dark blue background and git branch design)

### Fixed

- Extension displayed default placeholder icon on VS Code Marketplace

## [0.1.1] - 2026-02-16

### Fixed

- Triggered first marketplace release (version bump required after adding repository secrets)

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
