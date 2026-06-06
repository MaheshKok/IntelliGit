# Changelog

All notable changes to IntelliGit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.6] - 2026-06-06

### Added

- Added the TSDoc rollout baseline audit under `docs/tsdocs` with source counts, exported-symbol estimates, documentation block counts, boundary-heavy areas, plugin status, validation script availability, and confirmed phase order.
- Added the IntelliGit TSDoc standard under `docs/tsdocs`, including the standard block template, tag guidance, examples for the major extension areas, and the rule against type repetition.
- Added `eslint-plugin-jsdoc` and `eslint-plugin-tsdoc` with TSDoc syntax validation for extension TypeScript and React webview TypeScript/TSX files, without enabling global required-documentation enforcement.
- Added scoped TSDoc ratchet scaffolding and pilot locked globs for Git executor, shared domain types, shared React menu contracts, and commit graph canvas hook documentation.
- Documented Git operation contracts across status parsing, log/history loading, branch/remotes, staging, rollback, stash, and conflict helpers, then locked `src/git/**/*.ts` into the TSDoc ratchet.
- Documented webview protocol contracts for commit graph, commit info, commit panel, merge-conflict session, and undocked messages, then locked `src/webviews/protocol/**/*.ts` into the TSDoc ratchet.

### Changed

- Linked the TSDoc standard and rollout baseline from the README development documentation.

### Fixed

- Pointed the localization CSV tooling, tests, and workflow documentation at `docs/localization/localization_translation_review.csv` so validation uses the current reviewed-translation source path.
- Updated existing comments that mentioned Git upstream refs, credential-bearing URLs, and placeholder examples so they pass TSDoc syntax validation without changing runtime behavior.

### Verification

- Verified the documentation baseline, TSDoc standard placement, release metadata, documentation syntax linting, scoped ratchet pilot enforcement, Git contract ratchet enforcement, protocol contract ratchet enforcement, localization path correction, and repository validation gates for the TSDoc rollout phases.

## [0.9.5] - 2026-06-06

### Fixed

- Reject whitespace-only merge conflict session file paths before accepting either side, while preserving valid filenames that intentionally include leading or trailing spaces.
- Keep the real-Git pathspec magic regression test portable by skipping the invalid filename scenario on Windows.
- Strengthen repository discovery coverage for workspace Git root resolution.
- Exclude local GitNexus code-intelligence metadata from packaged VSIX artifacts.
- Use the checked-out branch name when updating the selected branch, so stale cached branch metadata still takes the current-branch fetch-then-merge path.

### Security

- Replaced machine-specific security scan paths in documentation with placeholders for the repository root, scan directory, scan id, Codex home, plugin directory, and scan artifact root.

### Verification

- Added regression coverage for whitespace-only conflict session paths being ignored without surfacing an error, and preserved coverage for trailing-space conflict filenames.
- Added regression coverage for stale current-branch metadata using the checked-out branch update path.
- Verified platform-safe pathspec behavior, repository discovery resolver expectations, security-doc path cleanup, full project validation, and release package generation.

## [0.9.4] - 2026-06-04

### Changed

- Replaced fictional 90% coverage thresholds with an enforceable coverage floor and wired CI to run `bun run test:coverage` so coverage gates are actually enforced.
- Promoted type-aware async and unsafe-value lint rules to errors, and restored a meaningful cognitive-complexity gate with explicit grandfathered hotspots.
- Split Git history and working-tree parsing into focused helper modules so `GitOps` can delegate pure parsing/planning logic without changing runtime behavior.

### Fixed

- Hardened Git log branch filtering by validating branch refs and passing branch filters after `--end-of-options`.
- Replaced conflict-marker detection with a linear scan so large non-conflicted files avoid regex backtracking risk.
- Excluded local Repowise metadata from packaged VSIX artifacts.

### Security

- Consolidated clone and publish `GIT_ASKPASS` credential plumbing into one shared helper so future credential-handling fixes cannot drift between flows.

### Verification

- Added regression coverage for branch-argument hardening, conflict-marker detection, JetBrains merge service/tool launch paths, diff service file operations, undocked provider protocols, file icon theme resolution, and merge/conflict webview behavior.
- Verified format, lint, strict lint, architecture, React Doctor, typecheck, build, localization validation, localization audit, CSV validation, tests, coverage, production build, package, and VSIX package-content audit.

## [0.9.3] - 2026-06-04

### Added

- Added an `Open in Current Window` action to the clone success prompt so users can open a cloned repository in the existing VS Code window without adding it to a multi-root workspace.

### Localized

- Added localized clone action labels for `Open in Current Window` across the host localization source catalog, locale bundles, and translation review CSV.

### Verification

- Added clone-flow regression coverage for opening a cloned repository in the current window without calling the workspace-folder API.


## [0.9.2] - 2026-06-04

### Added

- Added React Doctor as a repository validation tool with a `bun run react-doctor` script and a non-interactive, offline configuration that fails on error-level diagnostics.
- Added runtime-scoped ESLint quality gates for the extension host, React webviews, Node scripts, and typed TypeScript sources.
- Added React Hooks linting so Rules of Hooks violations fail lint while exhaustive dependency findings start as warnings.
- Added type-aware TypeScript ESLint recommendations with the initial noisy cleanup staged through targeted warning-level rules.
- Added Knip with both report-only and strict validation paths for unused files, exports, dependencies, and devDependencies.
- Added dependency-cruiser with a strict `bun run architecture:check` script for focused architecture validation.
- Added dependency-cruiser rules for unresolved imports, circular dependencies, extension-host/webview boundaries, domain-layer-to-UI boundaries, and webview imports of Node or VS Code runtime APIs.
- Added SonarJS lint rules for selected high-signal code-smell detection, with cognitive complexity starting as a warning at an intentionally high baseline threshold.

### Changed

- Updated the pre-commit validation checklist to run React Doctor and dependency-cruiser alongside format, lint, architecture, typecheck, build, localization, and tests.
- Split ESLint configuration by runtime so extension-host TypeScript, React webviews, Node scripts, and typed TypeScript sources use the correct globals, parser projects, and plugin sets.
- Wired the existing React ESLint plugin safely into the React webview lint path with flat config support and a pinned React version.
- Moved shared webview message protocol types into `src/webviews/protocol` so extension-host code no longer imports React UI modules.
- Moved the refresh coordinator into the views layer because it directly orchestrates view provider refreshes.
- Kept SonarJS code-smell checks warning-level for CI adoption while ensuring the local strict lint gate is already clean.

### Removed

- Removed unused files, exports, and dependencies identified during Knip cleanup.

### Fixed

- Fixed React Doctor error-level findings for conditional hook usage in the branch tracking badge.
- Fixed React Hooks exhaustive-dependency findings that were safe to address in the initial cleanup pass.
- Fixed type-aware TypeScript ESLint findings around async handling, unsafe values, unnecessary assertions, and promise usage.
- Fixed architecture boundary violations by moving shared protocols and refresh coordination to layers that match their runtime responsibilities.
- Enforced host/webview architecture boundaries while preserving message-based communication between the extension host and React webviews.

### Verification

- Verified React Doctor reports zero error-level diagnostics.
- Verified dependency-cruiser reports no architecture violations.
- Verified strict ESLint, strict Knip, typecheck, build, localization validation, localization audit, localization CSV validation, and the full test suite pass.

## [0.9.1] - 2026-06-04

### Fixed

- Updated the current-branch Update flow to fetch the tracked remote first, then merge the tracked remote ref with PyCharm-style Git arguments instead of failing on divergent histories with a fast-forward-only pull.
- Replaced raw divergent-branch Git output with a concise localized error message that removes fetch boilerplate, Git hints, and fatal/internal details.
- Open the Conflicts session when an Update merge produces unresolved conflict files, so merge conflicts enter the existing resolution workflow instead of surfacing as a generic failure.

### Preserved

- Non-current local branches still update through the existing fetch-refspec flow without checking out or merging those branches.

### Localized

- Added the new divergent-branch Update message to the localization source catalog, locale bundles, and translation review CSV.
- Applied reviewed translations for updated host locale bundles: `de`, `es`, `fr`, `ja`, `ko`, `pl`, `pt-br`, `pt-pt`, `ru`, `zh-cn`, and `zh-tw`.

### Verification

- Added regression coverage for current-branch fetch + merge behavior, concise divergence error messaging, and preserved non-current branch update behavior.
- Verified with format, lint, typecheck, build, localization validation, localization audit, CSV validation, and the full test suite.

## [0.9.0] - 2026-06-02

### Added

- Added full extension localization infrastructure across the VS Code manifest, extension host, and React webviews.
- Added localized catalogs for German, Spanish, French, Japanese, Korean, Polish, Portuguese (Brazil), Portuguese (Portugal), Russian, Simplified Chinese, and Traditional Chinese.
- Added VS Code manifest localization via `package.nls.*.json`, including command titles, view titles, configuration labels, configuration descriptions, and enum labels.
- Added extension-host localization via `l10n/bundle.l10n.*.json` for notifications, prompts, progress messages, quick-pick labels, validation errors, Git operation messages, merge-conflict actions, clone/publish/setup flows, and activity-bar badge tooltips.
- Added webview localization via `src/webviews/i18n/*.json` for the commit panel, commit graph, branch menus, changed-file UI, commit detail panel, merge editor, conflict session, onboarding, toolbar labels, empty states, status labels, and context menus.
- Added a single translation review CSV at `docs/localization_translation_review.csv` as the source of truth for all manifest, host, and webview translations.
- Added CSV import and validation tooling so reviewed translations can be imported back into generated catalogs instead of editing every locale JSON file by hand.
- Added localization tests that verify required locale coverage, catalog synchronization, placeholder preservation, plural-category shape, manifest entries, host bundles, and webview bundles.
- Added a hardcoded-string audit for user-facing source code so new English UI strings are caught when they are not routed through `vscode.l10n.t(...)` or webview `t(...)`.
- Added a Git terminology glossary for translators and reviewers so terms such as Git, commit, branch, stash, rebase, remote, worktree, VS Code, JetBrains, and Squash remain consistent across languages.

### Changed

- Converted extension host strings from raw English literals to `vscode.l10n.t(...)`, including user-visible errors, confirmations, progress titles, branch/commit actions, merge conflict commands, and repository setup messages.
- Converted React webview UI strings to the shared webview `t(...)` helper, including placeholder interpolation and plural-aware messages.
- Replaced hardcoded manifest text with `%key%` references backed by `package.nls.json` and locale-specific `package.nls.*.json` files.
- Made the localization workflow reviewable: translators can update one CSV, validate placeholders and required columns, then regenerate all locale catalogs consistently.
- Preserved placeholder tokens such as `{count}`, `{path}`, `{branch}`, `{short}`, `{remote}`, `{remoteBranch}`, and codicon tokens so translated strings do not break runtime interpolation.
- Preserved product and technical terminology where translating it would reduce clarity, including IntelliGit, Git, VS Code, JetBrains product names, command-line flags, URLs, SSH, HTTPS, and common Git operation names.
- Preserved Git jargon intentionally in places where localized VS Code/Git users expect the English term, such as Squash, Rebase, Checkout, commit, branch, and stash.
- Preserved the PyCharm/JetBrains-style UI behavior while only changing string loading and translated display text.
- Preserved the real-time changed-file count refresh work from `main`, including VS Code Git state listeners, background refresh coalescing, activity-bar badge clearing, and the blue refresh indicator during background checks.
- Increased the minimum visible duration of the commit-panel refresh indicator to 600ms so background file-count checks are visible without changing the refresh logic.
- Preserved the branch-scope cherry-pick guard from `main` while keeping the commit context menu localized.

### Fixed

- Fixed the earlier partial-localization state where only manifest metadata was translated while host runtime strings and webview UI still fell back to English.
- Fixed missing non-English host and webview catalogs by generating and validating every supported locale.
- Fixed translation validation gaps so tests now fail when required locale catalogs or CSV rows are missing.
- Fixed machine-translation artifacts that corrupted placeholders or translated placeholder stand-ins instead of preserving the original tokens.
- Fixed several reviewed translation quality issues found during deep scans, including mistranslated Git terms, untranslated Squash labels, Korean hunk/conflict wording, German checkout/rebase wording, French JetBrains merge-tool wording, and merge-session subtitle spacing around branch names.
- Fixed the new changed-files badge view introduced from `main` so its view title and tooltip are localized instead of adding new raw English strings.
- Fixed webview HTML localization payload escaping so translated JSON embedded in webviews cannot break the generated HTML.
- Fixed duplicate or stale catalog drift by making the CSV validation compare generated catalogs against the review CSV.

### Verification

- Verified localization with `bun run l10n:validate`.
- Verified hardcoded UI string coverage with `bun run l10n:audit`.
- Verified focused localization tests with `bun vitest run tests/unit/localization.test.ts`.
- Verified the merged branch with `bun run typecheck`, `bun run build`, and `bun run test`.

## [0.8.18] - 2026-06-02

### Fixed

- Commit panel changed-file counts now refresh from VS Code Git repository state changes, keeping IntelliGit aligned with native Source Control without requiring the user to focus the IntelliGit view.
- Background changed-file/status refreshes now show the blue refresh indicator in docked and undocked commit panels while IntelliGit checks for updated file counts.

## [0.8.17] - 2026-06-01

### Fixed

- Restored a dedicated hidden changed-files badge carrier view so the IntelliGit activity icon count now clears correctly after commit/refresh cycles without double counting the Commit view.
- Removed the Commit view title-bar Refresh action entirely and made the in-panel Refresh button show an immediate, centered blue spin state while also routing refresh through VS Code's native view progress indicator.
- Graph commit context menus now disable `Cherry-Pick` when viewing the current branch or the all-branches graph, and only enable it for other branch scopes where the action is meaningful.

### Tests

- Added regression coverage for activity-bar changed-file badge clearing and branch-scope cherry-pick enablement.

## [0.8.16] - 2026-05-31

### Fixed

- Undocked window columns now use container-aware reflow via `ResizeObserver` and dynamic normalization so they continue to occupy the full available width after window resizing.
- Removed the hidden badge-only IntelliGit view and moved the changed-file count badge onto the real Commit view, preventing a blank panel from appearing in repository workspaces.

## [0.8.15] - 2026-05-31

### Fixed

- Undocked window sections now start with equal widths, preserve the full available width while resizing adjacent sections, and restore cached user widths across close/reopen.
- Legacy undocked width caches missing the Graph column width are migrated instead of being discarded.
- Re-running "Undock in New Window" while IntelliGit is already undocked now only reveals the existing window instead of moving the currently active editor.

## [0.8.14] - 2026-05-30

### Fixed

- Graph view onboarding now stays blank when no workspace or no Git repository is available, while IntelliGit and Changes keep the clone/open/initialize actions.
- Removed duplicate "Changes" display name on the hidden `intelligit.fileCountBadge` tree view that carries the activity bar badge — it no longer shares a name with the real Changes panel.
- Undocked window sections (Commit, Branches, Graph, Changes) now start with equal widths on first open. Resized widths persist across panel close/reopen via extension workspace state.
- `intelligit.commitWindowPosition` now defaults to `auto`, following VS Code's `workbench.sideBar.location` unless explicitly set to `left` or `right`.
- Commit panel now shows "Publish Branch..." instead of "Commit and Push..." when the current branch has no upstream, avoiding `git push` with no configured destination.
- Commit and Push now checks the configured upstream remote before committing, so deleted or inaccessible remote repositories fail preemptively instead of leaving a new local commit behind.
- Undocked window layout changes from sidebar-position settings now preserve graph selection/filter state and clamp restored pane widths to the visible viewport.

## [0.8.13] - 2026-05-30

### Fixed

- Removed duplicate display name from a hidden tree view element
  Fixed undocked window sections to open with equal starting widths and persist user resizing across close/reopen
  Improvements

- Updated onboarding interface based on workspace state
  Simplified repository initialization confirmation with instant feedback

## [0.8.12] - 2026-05-29

### Added

- Added `intelligit.commitWindowPosition` to place the undocked/tabbed Commit window on the left or right side, defaulting to `left`.

### Fixed

- Commit window Refresh button now spins only for explicit user-triggered refreshes, not for theme changes or background workspace updates.

## [0.8.11] - 2026-05-29

### Fixed

- Stash Panel now adheres to the color theme rather than a hardcoded color

## [0.8.10] - 2026-05-28

### Added

- `intelligit.icons` setting (`"color"` | `"standard"`, default `"color"`): `standard` renders toolbar icons and status-badge letters using VS Code's monochromatic `--vscode-icon-foreground` token, consistent with native VS Code panels; `color` keeps the existing coloured icon style.

### Fixed

- Activity bar badge showed double the correct file count (e.g. 6 instead of 3) because the commit-panel webview badge and the dedicated `intelligit.fileCountBadge` tree view each contributed the same count to the container. Removed the redundant webview badge so only the dedicated tree view drives the activity bar icon number.
- "Changes N files" section header in the commit panel counted a file twice when it had both staged and unstaged modifications. Count is now deduped by path.

## [0.8.9] - 2026-05-28

### Changed

- PyCharm theme CSS variables now delegate to VS Code's native CSS custom properties so they adapt to the active colour theme; each variable keeps a hardcoded fallback for environments where the VS Code variable is unavailable.
- Checkbox unchecked border and checked background now use centralized `--intelligit-pycharm-checkbox-*` variables with `--vscode-checkbox-*` fallbacks.

### Fixed

- Commit tab drag-handle accent switched from `var(--vscode-descriptionForeground)` to `var(--intelligit-pycharm-muted)` for consistent PyCharm theming.

## [0.8.8] - 2026-05-28

### Changed

- Restyled the Commit tool window to more closely match PyCharm's dark Git UI, including tabs, toolbar chrome, section rows, file tree spacing, status colours, and commit controls.
- Kept commit-panel toolbar actions in one compact, evenly spaced group instead of stretching actions across the full panel width.

### Fixed

- Aligned file and folder selection checkboxes in the Changes tree and increased checkbox border weight for a sharper PyCharm-style appearance.

## [0.8.7] - 2026-05-28

### Changed

- Extracted `CommitGraphPanel` into a reusable component shared by the main graph view and the commit panel's embedded graph area.
- Commit panel now renders a compact native-git-style graph below the commit message — graph lanes and commit message only, with an inline tooltip on hover matching the middle panel's tooltip.
- Added `showSearch`, `showAuthorDate`, and `headerLabel` props to `CommitList` for per-panel customization.
- Added `showAuthorDate` prop to `CommitRow` to conditionally hide the Author and Date columns.
- Left panel graph header shows bold "Graph" label; middle panel retains "Commit | Author | Date".
- Duplicate `intelligit.initializeRepository` command consolidated into a shared `initializeRepository()` handler using `GitOps.init()`.
- `fetchGitHubRepos` in clone service hardened with request timeout and pagination cap.
- New event emitters (`onDidChangeFileCount`, `onDidChangeWorkingTree`) and centralized refresh coordination keep docked and undocked UI instances in sync during repository mutations.

### Fixed

- Commit panel graph rendering: reuse the same proven `CommitList` component instead of custom canvas rendering.
- Synchronization of working-tree and commit state between docked Commit Panel and undocked views: docked panel now refreshes the commit graph when the undocked view modifies the working tree.

## [0.8.6] - 2026-05-27

### Added

- Interactive onboarding webview shown when no workspace folder is open or no Git repository exists, replacing the previous static placeholder text.
- "Initialize Repository" action that runs `git init` in the selected workspace folder and offers to reload the window to activate IntelliGit.
- Custom clone flow with three provider options: GitHub (OAuth via VS Code session, browse repos or enter URL), GitLab (PAT via SecretStorage), and SSH.
- "Open Folder" action that delegates to VS Code's built-in `vscode.openFolder` command.
- `GitOps.init()` method for initializing new Git repositories programmatically.
- New commands `intelligit.cloneRepository`, `intelligit.openFolder`, and `intelligit.initializeRepository` registered in the command palette.
- "Publish Branch" flow after first commit: detects unpublished branches, creates remote repositories on GitHub or GitLab, adds the remote, and pushes with `--set-upstream`.
- `intelligit.publishBranch` command for manually triggering the publish flow from the command palette.
- `GitOps` methods for publish support: `hasAnyCommits`, `getRemotes`, `branchHasUpstream`, `addRemote`, `removeRemote`, `pushWithUpstream`.

### Changed

- The empty-state webview providers now use `OnboardingViewProvider` with contextual actions instead of the static `EmptyIntelliGitWebviewProvider`.
- `intelligit.cloneRepository` now runs the custom IntelliGit clone flow instead of delegating to VS Code's built-in `git.clone`.

### Security

- GitLab personal access tokens are stored in VS Code SecretStorage, not in user settings.
- Clone and publish pushes use transient Git askpass credentials so provider tokens are not written into remote URLs or shell arguments.

### Tests

- Add focused activation, onboarding, Git command construction, clone command, and publish-flow coverage for the onboarding and publish workflows.

## [0.8.5] - 2026-05-26

### Changed

- Open commit Changed Files diffs on double-click instead of single-click, matching standard VS Code and PyCharm tree interactions.

### Fixed

- Render commit diff sides from read-only virtual documents so historical file snapshots cannot be edited accidentally and closing the diff does not prompt to save.

### Tests

- Add regression coverage for Changed Files single-click suppression, double-click diff opening, and read-only diff URI usage.

## [0.8.4] - 2026-05-26

### Fixed

- Register IntelliGit undock commands in empty VS Code workspaces so clicking Undock shows a no-repository message instead of a command-not-found error.
- Dispose stale restored undocked editor panels on activation to avoid blank hanging windows after reopening VS Code.
- Open the Changed Files diff editor on single-click from the commit detail file tree, matching the PyCharm interaction.

### Tests

- Add regression coverage for empty-workspace undock commands, stale restored undocked panels, and Changed Files single-click diff opening.

## [0.8.3] - 2026-05-25

### Added

- Undock button in the IntelliGit view title bar, next to "Select Repository", launching a command-palette picker with "Undock in Editor Tab" and "Undock in New Window" options.

### Changed

- Restyle all context menus to match the PyCharm New UI: neutral-dark `#2B2D30` background, solid `#43454A` border, flush items without inner radius, `#2E436E` selection highlight, softer shadow, and corrected hint/shortcut typography and colours.
- Extract undocked-panel creation from data loading so the lifecycle is cleanly split into `ensureUndockedPanel` (fast) and `loadUndockedData` (deferred).

### Fixed

- Eliminate the ~2-second editor-tab flicker when choosing "Undock in New Window" by opening the panel immediately, moving it to a floating VS Code window, and only then loading branch and commit data into the already-opened window.

### Removed

- Undock button and context menu from the commit-panel toolbar; these actions are now accessed exclusively from the title bar.

### Tests

- Update commit-panel integration test to remove assertions for the now-removed toolbar undock button.

## [0.8.2] - 2026-05-25

### Changed

- Restyle the stash panel to more closely match the PyCharm Git tool window, including toolbar actions, selected stash rows, branch labels, and bottom apply/pop controls.

### Added

- Add a PyCharm-style stash context menu with apply, pop, drop, and diff actions.

### Tests

- Update commit panel integration coverage for stash apply, pop, and context-menu drop interactions.

## [0.8.1] - 2026-05-25

### Fixed

- Decouple the undocked editor tab lifecycle from `intelligit.undockableWindow`, so the tab opens only from user action and closing it no longer edits settings or reloads VS Code.

### Tests

- Add regression coverage for undocked activation, manual opening, closing, and reopening without settings mutation or window reload.

## [0.8.0] - 2026-05-25

### Added

- Undockable window mode via `intelligit.undockableWindow` setting: renders the commit graph and commit panel as a single unified editor tab instead of sidebar + bottom panel, enabling native VS Code undocking to a second monitor.
- Horizontal-split layout in undocked mode: branch column, commit list, and commit details on the left; file changes, commit message, and shelf on the right, with resizable dividers between all columns.
- `IntelliGit: Toggle Undocked Window` command to switch between docked and undocked layouts without editing settings.json.

## [0.7.3] - 2026-05-25

### Fixed

- Fix commits failing when the selected file list includes paths that were already staged as deleted, avoiding Git pathspec errors during mixed commit flows.
- Restore selected files more completely during rollback by clearing staged index changes, restoring tracked working-tree changes, and removing selected untracked or newly staged files.
- Restore all changes more reliably by using a hard reset followed by cleanup, so staged edits, unstaged edits, staged additions, and untracked files are all returned to a clean repository state.
- Restore staged renames correctly when rolling back selected files by resetting both the destination and original path, restoring the original file, and cleaning the renamed path.
- Allow repo-relative filenames that look like command options, such as `--weird.txt`, when reading historical file content while still rejecting invalid refs and traversal paths.
- Validate commit-panel selected paths before staging or committing so malformed webview payloads cannot bypass repo-relative path checks.
- Validate file context-menu paths before rollback, shelve, and file-history operations to reject traversal payloads before any Git command is run.
- Validate commit graph and changed-files webview command payloads at runtime, including commit hashes, branch/commit action names, and repo-relative file paths.

### Tests

- Add regression coverage for committing selected deleted files, including unstaged deletions and already staged deletions.
- Add real temporary Git repository coverage for file staging, unstaging, deletion, and rollback state transitions across modified, deleted, untracked, newly added, staged-add-then-deleted, renamed, nested, space-containing, and option-like file paths.
- Add webview payload validation coverage for commit-panel selected paths.
- Add webview payload validation coverage for commit graph and changed-files command messages.
- Add extension command validation coverage for file rollback, shelve, and file-history context actions.

## [0.7.2] - 2026-05-25

### Fixed

- Fix commits failing when the selected files include a path that is already staged as deleted.

### Tests

- Add coverage for staging unstaged deletions while skipping already staged deleted paths.

## [0.7.1] - 2026-05-23

### Added

- Add the ability for tooltips in the IntelliGit window to respect the "editor.hover.delay" setting from VS Code's settings.json.
- Add "intelligit.tooltips.enabled" setting to optionally completely disable all tooltips inside the IntelliGit window.

### Changed

- Update the TypeScript toolchain to 6.0, switch the extension compiler configuration to Node16 module resolution, and remove a stale React default import surfaced by stricter compiler checks.

## [0.7.0] - 2026-05-23

### Added

- Discover Git repositories inside non-Git workspace folders and add an IntelliGit repository selector for multi-project workspaces.

## [0.6.8] - 2026-05-23

### Added

- Add a commit context menu action to squash an unpushed selected commit range into one commit.
- Add amend commit branch-history context and IntelliJ-style amend actions in the commit panel.

### Fixed

- Use VS Code input theme colors for the commit message box so light themes no longer render a dark textarea.
- Preserve amend commit subjects exactly when parsing branch history, including tabs and surrounding whitespace.
- Restore the original HEAD if squash commit creation fails after the soft reset.

### Tests

- Add coverage for the squash commit menu item and squash command flow.
- Add coverage for amend branch history loading, UI state, and commit subject parsing with separator-safe git log output.
- Add coverage for dismissed rebase prompts and failed push retries after rebase.

## [0.6.6] - 2026-04-30

### Added

- Show an immediate rebase-and-push prompt when a push is rejected because the remote branch contains commits missing locally, matching the IntelliJ IDEA-style recovery flow without requiring a second manual push.

### Tests

- Add coverage for non-fast-forward push rejection detection, the rebase-and-push prompt action, and the `git pull --rebase` GitOps wrapper.

## [0.6.5] - 2026-04-08

### Fixed

- Preserve the last typed commit message text after successful commit flows so reopening the same project restores the draft instead of showing an empty commit message box.

### Tests

- Update commit panel provider coverage to verify successful commit paths keep the persisted commit draft text.

## [0.6.4] - 2026-04-08

### Added

- Persist unsaved commit message drafts per repository so the Commit panel restores the last typed text after closing and reopening the project or restarting VS Code.

### Tests

- Add integration coverage for restoring, saving, and clearing persisted commit drafts in the commit panel provider.

## [0.6.3] - 2026-04-06

### Fixed

- Fix commits failing when VS Code opens a subfolder of a git repository (e.g. opening `/root/client/project2` when the git root is `/root/client`). The extension now discovers the actual git repository root via `git rev-parse --show-toplevel` instead of assuming the workspace folder is the repo root.
- Fix file paths being doubled (e.g. `project2/project2/file.ts`) when opening files, showing diffs, jumping to source, or deleting files from the commit panel in nested workspace scenarios.
- Fix `.git` directory file watchers silently failing to register when the workspace folder differs from the git root, causing auto-refresh to stop working.

## [0.6.2] - 2026-03-16

### Security

- Update `simple-git` to `^3.32.3` to close a remote code execution bypass (GHSA-r275-fr43-pm7q) where a malicious `.git/config` in an opened repository could trigger arbitrary code execution.
- Replace synchronous `spawnSync("git")` branch and tag name validation with a pure JavaScript implementation matching `git check-ref-format` rules, eliminating a 5-second extension host thread block.
- Quote commit hash refs in `terminal.sendText` calls to prevent PowerShell `^` metacharacter injection on Windows.
- Add `--fixed-strings` to `git log --grep` to prevent Regular Expression Denial of Service (ReDoS) via user-supplied search text.
- Add null byte, carriage return, and newline rejection to `assertRepoRelativePath` to close a path injection vector on platforms where null bytes in paths cause ambiguous git behavior.
- Sanitize embedded credentials from URLs in git error messages before displaying them in VS Code notifications, preventing accidental exposure of `https://user:password@host` patterns.
- Use exact equality for full-length (40-character) SHA hash comparison in `isHashMatch` to eliminate prefix collision risk in large repositories.

### Fixed

- Fix infinite loop in the merge editor conflict parser when both sides insert new lines at the same base position, causing the UI to hang permanently.
- Fix in-place mutation of `CommitFile` and `WorkingFile` objects in `getCommitDetail`, `getStatus`, and `getShelvedFiles`, replacing them with immutable spread operations to prevent silent data corruption from any future caching layer.
- Fix `CommitPanelViewProvider.onDidDispose` unconditionally disposing the icon theme even when a newer webview view has already replaced it, which caused the replacement view to lose its icon theme.
- Wrap `vscode.commands.executeCommand("setContext")` calls with `Promise.resolve().catch()` to handle `Thenable` rejection, preventing unhandled rejection crashes during extension host startup.
- Use `vscode.workspace.createFileSystemWatcher` for git refs directory watching on Linux, where `fs.watch` with `recursive: true` silently falls back to non-recursive watching and misses branch/tag changes.
- Fix `buildResultContent` returning a spurious `"\n"` instead of `""` when all merge segments resolve to empty lines with `hasTrailingNewline` enabled.
- Replace unsafe `as CommitFile["status"]` type cast in `getCommitDetail` with validated `mapStatusCode()` to correctly handle unknown git status codes instead of producing invalid runtime values.
- Remove duplicate `EMPTY_TREE_HASH` constant in `diffService.ts` and import from the shared `constants.ts` module.
- Consolidate 14 inline `err instanceof Error ? err.message : String(err)` patterns in `commitCommands.ts` and `CommitGraphViewProvider.ts` to use the centralized `getErrorMessage()` utility.

### Tests

- Add 60 new unit tests covering branch name validation edge cases (git check-ref-format rules), hash comparison with full-length equality, path traversal with control characters, credential URL sanitization, merge editor empty file handling, conflict parser loop safety, and `--fixed-strings` grep behavior.

## [0.6.1] - 2026-03-12

### Fixed

- Release workflow reruns now check whether the current extension version is already published to the VS Code Marketplace or Open VSX and skip that target instead of failing on duplicate publish attempts.
- GitHub release publishing is now idempotent for reruns: existing releases are reused and the VSIX asset is uploaded with overwrite support so partially failed release runs can be resumed safely.

## [0.6.0] - 2026-03-09

### Added

- IntelliJ-style stash accordion layout: each stash entry has a chevron toggle that expands its file tree inline directly below that entry, replacing the previous split list/tree layout.
- Draggable file tree height within expanded stash entries for resizing the file list area.
- Bottom "Coming..." placeholder panel below the Commit/Stash tabs with a draggable divider to resize.
- Bottom panel height persists across webview reloads via `vscode.getState()`.
- Loading indicator shown when stash entry is expanded but files are still being fetched from the extension host.
- Branch name validation with strict alphanumeric/dot/dash/underscore/slash rules for new branch and tag operations.
- Strict relative path assertions for all file operations dispatched from webviews to prevent path traversal.
- Stash shelving now supports untracked files (`--include-untracked` flag on `git stash push`).

### Changed

- Stash branch badge icon changed from tag icon to git branch icon, matching the branch panel.
- Stash branch badge color now uses `--vscode-gitDecoration-modifiedResourceForeground` instead of hardcoded `#d8ca64` for theme compatibility.

### Fixed

- Fixed stale branch metadata causing incorrect push-target resolution in "Push All up to Here": now refreshes branch cache on lookup miss instead of fabricating a synthetic branch object.
- Fixed potential leaked document event listeners and stuck body styles when ShelfTab unmounts mid-drag.

### Refactored

- Extracted `extension.ts` (2,021 lines) into focused modules, reducing it to ~520 lines (75% reduction):
    - `commands/branchCommands.ts`: 10 branch action handlers
    - `commands/commitCommands.ts`: 13 commit context actions
    - `services/diffService.ts`: file comparison and patch operations
    - `services/gitHelpers.ts`: shared git utilities (validation, resolution)
    - `services/jetbrainsMergeService.ts`: JetBrains merge tool orchestration
    - `services/refreshService.ts`: debounced refresh and file watchers
- Decomposed `MergeEditorApp.tsx` (1,477 lines) into focused modules:
    - `icons.tsx`: SVG icon components
    - `wordDiff.ts`: pure word-level diff algorithms
    - `mergeState.ts`: reducer and resolution helpers
    - `segments.tsx`: section components, code blocks, overview rail
- Extracted shared theme change listener utility (`themeListeners.ts`) to replace duplicated listener boilerplate across view providers.
- Removed duplicate stash/shelf method aliases (`stashSave`, `stashPop`, etc.) that were pure pass-throughs to canonical `shelve*` methods.

### Tests

- Added 65+ unit tests for extracted modules: `gitHelpers`, `wordDiff`, `mergeState` (increasing the total from ~131 to ~196).

## [0.5.5] - 2026-03-09

### Added

- Shared "Group by Directory" toggle across Commit and Stash tabs: the toggle state is now lifted to the top-level app so both tabs respect the same setting. (PR #18 by sivertillia)
- Stash tab label renamed from "Shelf" to "Stash" for consistency with standard Git terminology.

### Fixed

- Fixed duplicate "M" (Modified) status row appearing for newly staged files that were edited after staging. Only unstaged modifications are now suppressed for staged-add files; unstaged deletions (`AD` status) are still shown.
- Fixed `vscode.getState()` TypeError in test environments by using optional chaining (`vscode.getState?.()`) in the state initializer and effect.
- Fixed `useEffect` dependency array for `groupByDir` persistence to include `vscode` for React exhaustive-deps compliance.

### Tests

- Added test case verifying `groupByDir` defaults to `true` when `getState()` returns `undefined`.
- Updated VS Code API mocks to include `getState`/`setState` for `CommitPanelApp` test coverage.
- Narrowed overly broad DOM selectors (`querySelectorAll("*")`) in integration tests to use precise `title` attribute and `role="button"` selectors.
- Updated "Shelf" assertions and selectors to "Stash" across all test files.

## [0.5.4] - 2026-03-04

### Fixed

- Fixed commit graph Changed Files double-click behavior so file rows now open a commit-to-parent diff (`<parent> ↔ <commit>`) as expected.
- Wired commit graph webview `openCommitFileDiff` events through the provider and extension host to reuse the same diff-opening path as the Commit Files view.

### Tests

- Added integration coverage for commit graph Changed Files double-click to assert `openCommitFileDiff` messaging and provider event forwarding.

## [0.5.3] - 2026-03-04

### Fixed

- Fixed "ambiguous argument" error in commit graph when a branch used as filter is deleted. The stale branch reference is now cleared and the graph falls back to showing all branches.

## [0.5.2] - 2026-03-04

### Fixed

- Fixed `groupByDir` setting not persisting across webview reloads. The toggle state is now saved to and restored from `vscode.getState()`. (PR #13 by sivertillia)
- Fixed `useCheckedFiles` overwriting all webview state keys on every update. State writes now merge with existing keys instead of replacing them.

## [0.5.1] - 2026-03-04

### Fixed

- Fixed "Too many revisions specified 'stash@{N}'" error when clicking on a file in the shelf (stash) pane. Replaced `git stash show -p` with `git diff stash@{N}^ stash@{N}` for file-level patch retrieval, which correctly handles pathspec filtering across all git versions.

## [0.5.0] - 2026-02-22

### Added

- External JetBrains merge tool integration for merge conflicts (PyCharm/IntelliJ IDEA/WebStorm and other JetBrains IDEs) using Git conflict stages (`base/ours/theirs`) and the IDE `merge` command.
- macOS `.app` bundle path support for JetBrains merge tool configuration, including automatic executable resolution from `Contents/Info.plist` (`CFBundleExecutable`) with fallback scanning of `Contents/MacOS`.
- JetBrains IDE auto-detection for merge tool setup:
    - macOS: `/Applications`, `~/Applications`, and JetBrains Toolbox installs
    - Windows: standard JetBrains install directories and JetBrains Toolbox installs
- `IntelliGit: Detect JetBrains Merge Tool` command with Quick Pick selection of detected JetBrains IDEs and manual-entry fallback.
- Editor context submenu `IntelliGit` (right-click in file editor) with:
    - `Compare with Revision`
    - `Compare with Branch`
- Git file comparison helpers to load file content at a selected revision/branch and open VS Code diffs against the working tree file.

### Changed

- `Open Merge Conflict` now uses only two merge editor paths:
    - JetBrains merge tool (when `intelligit.jetbrainsMergeTool.preferExternal` is enabled and a JetBrains path is configured)
    - VS Code internal merge editor (default fallback)
- IntelliGit custom merge editor is no longer used in the merge-conflict open flow.
- JetBrains merge tool path prompt now validates the entered path immediately and shows the resolved executable path in the confirmation message for easier setup/debugging.
- `intelligit.jetbrainsMergeTool.preferExternal` setting description updated to document VS Code internal merge editor fallback behavior.

### Fixed

- Fixed macOS JetBrains `.app` path launch failures caused by trying to execute the app bundle directory directly (`EACCES`) by resolving the actual binary before launch.
- Fixed merge-conflict command registration syntax regression introduced while wiring JetBrains merge-tool commands.

## [0.4.0] - 2026-02-20

### Added

- Native VS Code file icon theme support across IntelliGit trees, including file, folder, and expanded-folder icons from the active `workbench.iconTheme`.
- Theme icon font support in webviews so icon themes that render glyph-based icons work correctly (not only SVG path icons).
- Folder name specific icon resolution (`folderNames`, `folderNamesExpanded`, `rootFolderNames`, `rootFolderNamesExpanded`) to match native explorer/source-control icon behavior.

### Changed

- Changed Files, Commit Files, Shelf Files, and Branch folder trees now resolve icons through the same native theme mapping path for consistent visuals.
- Commit panel file tree typography (row height, size, spacing, and weight) was adjusted to align with native Source Control list presentation.
- Commit panel now uses VS Code foreground color for commit file names instead of status-colored file-name text, matching native Source Control behavior.

### Fixed

- Fixed cases where folder icons were missing or mismatched in Changed Files and Commit Files despite icon theme support being enabled.
- Fixed icon mismatches for compact/derived folder labels by normalizing folder-name lookup keys and leaf-segment fallbacks.
- Fixed branch tree folder icons not following the active file icon theme mappings.

## [0.3.1] - 2026-02-19

### Added

- Commit graph action types are now strict literal unions (`BranchAction`, `CommitAction`) with runtime guards for safer webview-to-extension messaging.

### Changed

- Marketplace metadata tuned for discoverability while keeping package name/description genericized for safer trademark posture.
- README project structure updated to reflect current modular React layout (`branch-column`, `commit-list`, `commit-panel`, shared modules).
- Commit list rendering switched from full list rendering to viewport virtualization for large-history performance.
- Branch remote-group header rendering now reuses `BranchSectionHeader` for consistent structure and reduced duplication.
- `useCommitGraphCanvas` now derives size from `rows.length` and uses a named left-padding constant.
- `TabBar` shared tab style object hoisted to module scope to avoid per-render reallocation.
- Commit list canvas rendering now clamps to viewport+overscan and redraws on scroll/resize/theme changes.
- Commit list load-more flow now guards against repeated triggers while a prior load is still in flight.

### Fixed

- Branch remote grouping now strips the exact grouped remote prefix instead of always stripping the first path segment.
- Context menu keyboard focus now has an accessible visible indicator (outline + focus ring) instead of suppressing outline.
- Commit info webview message handler now uses explicit discriminant handling before accessing `detail`.
- Branch section headers are now keyboard-accessible (`role="button"`, `tabIndex`, `Enter/Space`, `aria-expanded`).
- HEAD row now supports keyboard activation and keyboard context-menu invocation.
- Main/master icon detection now uses normalized branch short names (handles `origin/main`, etc.).
- Branch highlight regex no longer uses unnecessary global flag.
- Branch name trimming logic now safely handles small max lengths without negative slicing.
- Branch selected-row background now follows VS Code theme token (`--vscode-list-activeSelectionBackground`).
- `useCheckedFiles` folder/section toggle wrappers consolidated through a shared callback.
- `DragResizeOptions` is now exported for external typing/re-export.
- Commit panel tree types no longer store redundant `fileCount`; callsites now derive from `descendantFiles.length`.
- `collectDirPaths` now uses an accumulator to avoid recursive array spreading overhead.
- Commit/branch/context-menu integration tests were hardened with shared jsdom React test utilities and more realistic interaction assertions.

- Extension branch command handlers and commit selection errors now consistently use shared `getErrorMessage(...)`.
- Git numstat/stash-show warnings now log via a shared IntelliGit output channel (with fallback) instead of silent/console-only catches.
- Status/numstat failures now provide short user-facing warnings when displayed diff statistics may be incomplete.

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
