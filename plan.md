# PyCharm File Git History Parity — Research and Implementation Plan

**Issue:** [IntelliGit #159](https://github.com/MaheshKok/IntelliGit/issues/159)

**Prepared:** 2026-09-12

**Status:** Implementation in progress. Standalone file history and shared diff-viewer integration are implemented in the working tree; acceptance checks and remaining parity phases are tracked below. This is not a claim of complete PyCharm parity.

**Worktree:** `/Users/maheshkokare/PycharmProjects/IntelliGit/.claude/worktrees/issue-159-file-history`

**Branch:** `codex/issue-159-file-history`

**Base:** `027153477ca646bc43fd582fc7ca98ebb3c114eb` (`origin/main`, fetched before creation)

> User authorized implementation, then required reuse of the existing diff viewer. History opens in a separate window using the same command as Undock in New Window. No Log-tab or docked integration. Reuse the existing renderer and controls; do not create a second renderer to reproduce PyCharm's diff modes. Subagents remain restricted to `gpt-6-astra` at low, medium, or high effort.

### Implementation checkpoint — 2026-09-12

- Command: `intelligit.showFileHistory`, available from Command Palette, editor context submenu, inactive editor-tab context, and Explorer file context.
- Window: one instance per canonical repository/file; repeated opening reveals it. Captured repository ownership is independent of the active graph. Symlinked parent directories are normalized without dereferencing the file itself.
- History: immutable ref snapshot, explicit incremental loading, linear rename ancestry, deletion/root/type-change rows, merge-resolution commits with both raw parents. Merge comparisons resolve the filename separately for the selected parent.
- UI: dense author/date/subject list, branch selection, loaded-history search, keyboard and multiple selection, resizable list/preview split, details and read-only inspection actions.
- Diff: original renderer extracted into `DiffViewer.tsx`; old standalone app and History both use it. Existing 92-test viewer integration suite passed after extraction. No new diff engine.
- Correctness checks include real Git rename/deletion/root/merge fixtures, stale query/preview rejection, clicked-URI precedence and read-only embedding. Full/runtime results are recorded below.
- Static translations: 28 new source rows, 308 translated cells across 11 locales. Catalog import and token validation pass. New translations are model-authored drafts, not native-speaker-reviewed.
- Remaining parity work: complete rename ancestry across merged branches, actual graph/refs/signatures, advanced actions (annotation, patch export, file restore), folder/selection history and pixel/interaction parity audit. Existing shared viewer capabilities define this iteration's diff modes.

### Implementation evidence — 2026-09-12

- Native VS Code 1.132.0: `bunx playwright test --config playwright.e2e.config.ts --project=e2e tests/e2e/fileHistory.spec.ts` passed all 3 tests (setup, actual separate-window/shared-viewer test, teardown). Runtime capture: `/tmp/issue159-native-history.png`. This proves the native opening/rendering slice, not every history action or PyCharm parity.
- Pixel baselines: generated four History images through `tests/e2e/docker/run.sh` in the pinned `linux/amd64` image. Repeated `npx playwright test --config playwright.visual.config.ts tests/visual/pixelBaselines.spec.ts --grep "file-history matches"` without update: 4 passed. Root inspected wide dark and narrow light captures. The 320px layout clips desktop controls; narrow-screen parity is not accepted.
- Focused regression recheck: 67 tests passed across the command inventory, outbound coverage, recorder registration/disposal/fixture gate and TypeScript coverage suites. Screenshot comparator proof passed separately (1 test); its initial full-suite run timed out while other runtime work was running.
- Independent Astra/high reviewer rechecked all four original findings: merge-resolution inclusion, second-parent rename path, affected merge files and filtered-refresh selection. Three real-Git assertion groups and eight UI contract tests passed. Evidence: `/tmp/issue159-review-followup.md`.
- `format:check`, `lint`, `lint:strict`, `architecture:check`, `typecheck`, and `l10n:validate` passed. React Doctor exited 0 with 18 optional warnings; its listbox/role suggestions were reviewed against roving option focus and valid `aria-multiselectable`, and async guard suggestions must not remove stale-result checks. No zero-warning claim.
- Localization audit exited 0: 11 candidates, zero missing English catalog strings. Four History candidates are path/hash/subject values and email angle brackets, not untranslated prose. Other candidates are in unchanged files. Model-authored translations still require human terminology review.
- Final integrated `bun run test` (includes build): **358 files, 4,853 tests passed**, 252.53 seconds. Evidence archive: `/Users/maheshkokare/.local/share/lean-ctx/archives/54/543f2fbc1267a953.txt`. This supersedes the first run's 14 failures. Only documentation/comment cleanup followed the tested implementation. No commit, push, installed-extension replacement, or publication has been performed.

**Goal:** Let a developer open a file's Git history from wherever they encounter that file, inspect exactly what changed, navigate its revisions and renames, and perform the applicable PyCharm history actions without leaving IntelliGit.

### Packaging follow-up — 2026-09-12

- User approved excluding this plan from the VSIX and deduplicating the existing highlighter without removing functionality or raising budgets. `.vscodeignore` now excludes lowercase `plan.md`; the repository document remains.
- The original Shiki source builds once as `dist/webview-shiki.js`. History, Diff and Merge consumer bundles load that same API; production shells, the visual harness and standalone merge preview load the shared script first. All 12 languages, both themes, per-window cache isolation and existing CSP remain unchanged.
- `bun run package` passed verification: **7,022,411 uncompressed bytes (6.70 MiB)** versus the unchanged 8,388,608-byte budget; previously 9,544,882 bytes. The 83-entry archive is 1,901,400 bytes compressed. `bun run build:prod` passed; all 19 packaged runtime files match final production dist byte-for-byte. VSIX SHA-256: `c17fbd0ff03b54a5ea09741be4daffc2a486b0b0f8cc7f9101bb43c07bf3ebf1`.
- Full final suite: `bunx vitest run --maxWorkers=4` — **360 files / 4,863 tests passed**. Initial default-concurrency run had one 60-second screenshot-comparator timeout; that test passed independently in 3.5 seconds and in the full four-worker rerun. No assertions or timeouts were relaxed.
- `bun run test:package-smoke` — **1 passed** on VS Code 1.132.0: installed exact `maheshkok.intelligit@0.33.0` into an isolated profile, opened History from the installed extension and verified syntax-colored TypeScript. The user's installed extension was not replaced.
- Pinned Linux pixel comparisons: **16 passed**, covering History, Diff, Merge and Shelf conflict in both light/dark and narrow/wide viewports, without changing existing baselines. Formatting, lint, strict lint, architecture, typecheck and localization validation passed; existing optional React Doctor/localization audit warnings remain as documented above.
- Independent review approved after catching and fixing the standalone preview loader. Writer evidence: `/tmp/issue159-package-writer-evidence.md` and `/tmp/issue159-preview-writer-evidence.md`; review: `/tmp/issue159-package-review.md`. No commit or publication performed.
- Affected-path Impeccable detector ran and exited 2 for the standalone preview's existing `Menlo` font declaration at line 148, absent from DESIGN.md typography. The declaration is unchanged in this packaging diff; no font/style changes were made to silence it.

**Approach:** Add a focused history surface using IntelliGit's existing Git execution, webview lifecycle, revision content, diff rendering, and command infrastructure. Preserve repository/worktree identity and each revision's historical path. File history, folder history, and selection history share entry conventions but have different query and comparison semantics.

**Technology:** Existing TypeScript extension host, Git CLI, React webviews, shared diff implementation, Vitest, and real VS Code runtime validation. No new database or framework is justified by the evidence collected so far.

## 1. What was requested and what counts as done

The issue asks for a context action showing commits that changed the opened file and a command that users can bind to a keyboard shortcut. A comment specifically requests invocation from an editor tab. The request in this task is broader: understand PyCharm deeply and plan its exact functions, appearance, and interaction model.

Issue closure alone is not the full acceptance bar. There are three separate claims:

1. **Entry-point completeness:** Explorer, editor content, editor tab, command palette, keyboard invocation, and IntelliGit file lists resolve the correct target file.
2. **Behavioral parity:** the reference action inventory, selection model, comparisons, filters, revision paths, state transitions, and failure behavior match.
3. **Visual and interaction parity:** actual reference screenshots and interaction traces agree with the implemented layout, density, focus, menus, resizing, keyboard behavior, and diff presentation.

The original planning phase produced this dedicated worktree and document. The user subsequently authorized implementation. The working tree now contains the first file-history implementation and tests, described in the checkpoint above; nothing has been committed or published. Remaining parity phases are explicitly separate from the implemented scope.

## 2. Scope assumptions and decisions needing an answer

The following defaults keep planning moving. They are proposals, not user approvals or verified PyCharm behavior.

| ID | Decision | Proposed default | Why it changes implementation |
| --- | --- | --- | --- |
| D1 | Does full parity include folders and line/selection history? | Include all three as separately testable phases; file history first | Folder queries are path-set log filters; selection history requires line ancestry and a distinct comparison surface |
| D2 | What does exact appearance mean inside VS Code? | PyCharm topology, density, control order, and interactions; VS Code theme colors/fonts | Fixed PyCharm chrome conflicts with existing theme integration and high-contrast support |
| D3 | Include state-changing history actions? | Include applicable reference actions with existing confirmation conventions | Get from Revision changes a file; it must not accidentally checkout a branch or overwrite unrelated work |
| D4 | Which PyCharm reference is authoritative? | Installed PyCharm 2026.2, build `PY-262.8665.309` | Online source at master may differ from this installed build |
| D5 | Does custom installed styling define the reference? | Confirm before freezing visual metrics | Installed UI exposes Material Theme Lite and Atom File Icon Settings; its appearance may not be stock PyCharm |
| D6 | Where should History live? | **User decided: dedicated new History window, using the existing undock mechanism (§4.1)** | Undocked-only delivery; no Log tab, docked integration or host-routing framework |
| D7 | Default keyboard shortcut | Register a bindable command; decide default after conflict audit | PyCharm platform/keymap shortcuts cannot be copied globally into VS Code without checking collisions |
| D8 | First release acceptance | No claim of full parity until the inventory is covered; phases may ship with explicit partial-support notes | Prevents an early file-list delivery being described as an exact clone |

D6 is settled by the user. Questions D1–D3 were sent during research; D4, D5, D7 and D8 remain reference/spec review items. Additional questions should arise from contradictory evidence rather than guesses about CSS values.

Not automatically included: cloning the entire IDE, Local History of uncommitted edits, third-party AI actions, every JetBrains plugin, global project-log redesign, or language-specific semantic class comparison. These are distinct from file Git History. If any appears in the chosen history workflow, record it explicitly and decide whether it is part of the acceptance target.

## 3. Evidence and confidence

### 3.1 Issue and installed application

- `gh issue view 159 --repo MaheshKok/IntelliGit --json number,title,body,comments,url` returned the issue and the editor-tab request on 2026-09-12.
- Computer Use opened PyCharm's welcome screen. It identified version 2026.2 and a plugin compatibility message containing build `PY-262.8665.309`.
- Opening IntelliGit eventually succeeded. Accessibility exposed README.md, Commit and Git tool windows, a project Log table, branch filters, and current custom-plugin controls.
- The file-history view itself was **not** reached reliably. Failures included `elementHasNoFrame`, `cannotClickOffscreenElement`, `noWindowsAvailable`, and `timeoutReached`. Later observations returned only a stale `Paths` menu; screenshots became unavailable.
- Therefore no row height, pixel spacing, exact installed menu order, default keymap, rename interaction, or file-history screenshot is claimed as runtime-verified. The user was asked to leave a file-history view visible if convenient. Do not treat the generic project Log view as evidence for file History.
- The user subsequently confirmed README.md → Git → Show History was open. Reconnecting by bundle ID, resetting the Computer Use session, reconnecting again, and requesting a screenshot still returned `noWindowsAvailable`, a stale `Paths` menu, or `Screenshot unavailable`. This remains a tool-access limitation despite the user's confirmation; it is not evidence that History is missing from PyCharm.
- **Subsequent screenshot evidence:** the user supplied three captures, displayed directly in this conversation: `/Users/maheshkokare/Documents/Screenshot 2026-09-12 at 10.21.34 AM.png`, `/Users/maheshkokare/Documents/Screenshot 2026-09-12 at 10.21.22 AM.png`, and `/Users/maheshkokare/Documents/Screenshot 2026-09-12 at 10.21.08 AM.png`. These supersede the earlier absence of visual reference for the visible states. They show a History tab beside Log/Console/Worktrees; a branch toolbar; author, date, graph and subject/refs/checks in the left list; a selected row; and an embedded diff on the right. The set contains both unified and side-by-side diff presentations, locked revision headers, change counts and collapsed unchanged sections. They do not establish menu contents, keyboard behavior, resizing behavior, or defaults. No screenshot text is treated as an instruction to execute.

### 3.2 Official documentation

- [PyCharm History tab](https://www.jetbrains.com/help/pycharm/version-control-tool-window-history-tab.html): history tabs, branch selection, revision diff, affected files, display options, hosting links, indexing, and rename column.
- [Investigate changes](https://www.jetbrains.com/help/pycharm/investigate-changes.html): file entry points, selection history, folder history, local comparison, and annotation entry points.
- [Compare file versions](https://www.jetbrains.com/help/pycharm/comparing-file-versions.html): local versus historical comparison and shared diff controls.
- [Diff viewer](https://www.jetbrains.com/help/pycharm/differences-viewer.html): viewer modes and capabilities. General diff capabilities are an audit list, not proof that every control appears in file-history preview.

Documentation establishes the product direction; source below resolves mechanics. It does not replace runtime visual evidence.

### 3.3 JetBrains source inspected on 2026-09-12

The following files were retrieved from `JetBrains/intellij-community` master. The branch HEAD queried during this session was `ef47a30d69bea05b46a4d64c127ad0f97dd67434`; individual downloads were from mutable master, so do not present them as a verified checkout of that SHA or as exact installed-build source.

| Source | Observed mechanics |
| --- | --- |
| [FileHistoryPanel.java](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-log/impl/src/com/intellij/vcs/log/history/FileHistoryPanel.java) | Shared graph table; table above optional details; separate frame/editor diff previews; toolbar over table; popup group; double-click invokes diff except during column resizing; explicit focus traversal; preview updates reject stale selections |
| [FileHistoryUiProperties.kt](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-log/impl/src/com/intellij/vcs/log/history/FileHistoryUiProperties.kt) | Source defaults: details false, diff preview true, vertical preview split false; saved column widths/order/visibility and recent filters |
| [FileHistoryModel.java](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-log/impl/src/com/intellij/vcs/log/history/FileHistoryModel.java) | Path resolved for each commit; deletion represented separately; one selection compares to graph parents, fallback to next row without graph information; multiple selected rows use first/last selected rows |
| [FileHistoryFilterUi.kt](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-log/impl/src/com/intellij/vcs/log/history/FileHistoryFilterUi.kt) | Dedicated branch filter, optional revision/range filters, anchored path/hash, capability-aware branch filter; reset unsupported filters |
| [FileHistoryTabsManager.kt](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-log/impl/src/com/intellij/vcs/log/history/FileHistoryTabsManager.kt) | Tabs retain root/path/optional hash; anchored history has short-hash suffix; tabs can be rebuilt when log is recreated |
| [FileHistorySpeedSearch.kt](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-log/impl/src/com/intellij/vcs/log/history/FileHistorySpeedSearch.kt) | Speed search always enabled and uses visible-pack metadata; this is not evidence for a full permanent project-log filter bar |
| [VCS log action registration](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-log/impl/resources/intellij.platform.vcs.log.impl.xml) | History-specific toolbar and context-menu inventory, detailed below |
| [VCS action registration](https://github.com/JetBrains/intellij-community/blob/master/platform/vcs-impl/resources/META-INF/VcsActions.xml) | Get Version and local diff action registrations; history extension groups are separate from the generic commit popup |

Do not copy JetBrains source or image assets into production as part of this plan. Source is used to understand behavior. Preserve source licensing if implementation later deliberately reuses source rather than independently implementing behavior.

## 4. Product and interaction brief

**Mode:** Operate. Developer arrives mid-investigation, with a file already selected, and needs to answer what changed, when, by whom, and how to inspect or recover that revision.

**Primary sequence:** invoke history → see correct file/root and commits → select revision → inspect immediate diff → compare another revision or local content → open, annotate, navigate, export, or restore as needed.

**Focal interaction:** changing the selected revision updates its preview without losing list position or switching the active project context. The preview must never display the previously selected commit beneath a new selected row.

**Visual authority:** installed PyCharm file-history capture, after version/theme confirmation. Existing IntelliGit tokens govern host integration under D2's proposed default. A marketing redesign, large cards, avatars, decorative gradients, or generic timeline would violate the requested interface.

Provisional structural diagram, derived from source rather than measured pixels:

```text
Dedicated new IntelliGit History window
  History: filename
  +--------------------------------+-----------------------------------+
  | Branch | Refresh | Diff | ...   | Diff toolbar / revision headers   |
  +--------------------------------+-----------------------------------+
  | Revision table                 | Old revision | Selected revision |
  | graph/path/subject/author/date  | synchronized diff preview         |
  |                                |                                   |
  +--------------------------------+                                   |
  | Commit details (optional)      |                                   |
  +--------------------------------+-----------------------------------+
```

The supplied captures now establish visible left-to-right ordering: author, date, graph lane, subject with ref labels and check indicators. Column configurability and defaults still need verification. No pixel values in this sketch are acceptance values.

### 4.1 Placement — user-decided standalone window

**Settled scope:** open Git History in a new window using the same window-opening mechanism as IntelliGit's existing Undock in New Window action. IntelliGit currently has no Log tab; do not add one. This delivery has no docked History view, workbench tab strip, host selection, or switching between History and the existing workbench layout.

```text
New window — History: README.md
┌───────────────────────────────┬────────────────────────────────────┐
│ Branch: HEAD · history actions│ Diff actions · count · view mode   │
├───────────────────────────────┼────────────────────────────────────┤
│ Author / Date / Graph / Commit│ Embedded diff                      │
│ Revision list (~40%)          │ Unified / side-by-side (~60%)       │
└───────────────────────────────┴────────────────────────────────────┘
```

All entry points resolve the selected file and repository, then open this dedicated History window. No branch tree, commit form, repository column, or new internal tabs are needed. The existing IntelliGit workspace remains independent.

**Minimal lifecycle proposal:** one file-history surface per window; reveal an already open matching `(root, path, anchor, history kind)` window on repeat invocation. A different file opens its own window. Use only a small keyed panel registry for reveal/disposal, not a tab/session framework. Closing the window disposes its listeners and pending requests. Repository identity remains fixed for that window.

**Layout:** use the screenshots' approximately 40/60 list-to-preview split as a starting proportion, with a draggable divider. Unified/side-by-side changes only the preview region. Both modes and the history functions remain in scope; placement simplification does not remove them. Exact dimensions and interaction defaults still need runtime checks.

**Implementation:** create `FileHistoryPanel` and a dedicated `FileHistoryApp` bundle using existing webview shell, theme, localization and diff primitives. Inspect and reuse the existing Undock in New Window path narrowly. A normal editor webview tab alone does not meet the new-window requirement; verify the actual separate window in VS Code. If moving the panel fails, show an explicit failure rather than claiming the window opened. Avoid changing `CommitGraphPanel`, `UndockedLayout`, or their state models for History integration.

**Acceptance:** command opens a separate History window; inactive editor-tab invocation uses the clicked file; repeat invocation reveals its window; two roots remain isolated; close during loading prevents late updates; unified and side-by-side preview work; resizing leaves both panes usable. Docked placement and a future shared tabbed workbench are deferred entirely.

## 5. Parity inventory

Legend: **I** issue; **D** official docs; **S** inspected source; **P** proposed IntelliGit contract; **R?** needs installed-runtime observation. Each row must receive a test and, for visible behavior, an actual runtime check.

### 5.1 Entry points and tab lifecycle

| ID | Requirement | Evidence | Acceptance example |
| --- | --- | --- | --- |
| E01 | Explorer file context action | I/D | Invoke on B while A is active; history is B |
| E02 | Editor content context action | I/D | Resolve editor document URI correctly |
| E03 | Editor-tab context action | I | Right-click inactive B tab while A is active; history is B |
| E04 | Command Palette action, bindable by keyboard | I | Active tracked file opens history without picker detour |
| E05 | IntelliGit Commit/changed-file menus | D/P | Root and path travel with selected row |
| E06 | Revision-anchored History up to Here | S/P, R? | Window title visibly includes anchor; no descendants of anchor appear |
| E07 | Separate histories coexist in independent windows | P | A/B lists, selections, scroll positions, and filters remain independent |
| E08 | Repeat invocation reveals matching History window | P | Same root/path/anchor reveals existing window; no duplicate instance |
| E09 | Open new window, close, focus and reopen | P | Actual separate window; no duplicate listeners, stale requests, or lost root identity |
| E10 | No active editor / unsupported URI / no repository | P | Clear scoped explanation; no unrelated repository fallback |
| E11 | Deleted-file history from historical changed-file entries | S/P | Open an entry whose path no longer exists locally; retain root, historical path and anchor |

### 5.2 Table, filtering, and navigation

| ID | Requirement | Evidence | Acceptance example |
| --- | --- | --- | --- |
| H01 | Full reachable file history with rename continuity | D/S | Earlier name's commits remain accessible beyond first page |
| H02 | Historical path/rename indication | D/S | Old and new paths agree with actual Git objects |
| H03 | Subject, author, date and configurable columns | S, R? | Long content truncates with accessible full text; ordering/width persist as specified |
| H04 | Branch and revision/range context | D/S | Switching branch changes query and clears incompatible selection/preview |
| H05 | All-branches history | D, R? | Enumerate expected commits on diverging branches; do not equate a current-branch query with all branches |
| H06 | Author-time/committer-time display option | D/S | Fixture uses different timestamps and identities |
| H07 | Speed search | S, R? | Keyboard search selects matching commit; clarify searched fields and unloaded results |
| H08 | Refresh | D/S | New commit appears and valid selection is preserved; amended/pruned selection clears safely |
| H09 | Single, range, and discontiguous selection | S, R? | Preview endpoints follow visual-order semantics; verify >2 selections |
| H10 | Keyboard list navigation and context menu | S/P, R? | Up/down/home/end/page navigation and keyboard menu access work |
| H11 | Progressive loading with visible completion/failure | S/P | >20 and >one-page histories remain accessible; no silent cap |
| H12 | Loading, empty, unsupported filter, Git error states | S/P | Empty and failed queries are distinguishable; reset/retry works |

Do not automatically add project Log's user/date/path toolbar to file History. The inspected file-history filter UI contains a branch filter; capture the installed surface before expanding it.

### 5.3 Revision comparisons and previews

| ID | Requirement | Evidence | Acceptance example |
| --- | --- | --- | --- |
| C01 | Immediate selected-revision preview | D/S | Rapid A→B selection cannot show late A diff beneath B |
| C02 | Selected revision versus appropriate predecessor | S | Intervening unrelated commits and merges cannot make displayed-list adjacency silently wrong |
| C03 | Two selected revisions / selected range endpoints | S | Reversing click order does not invert chronological labels unexpectedly |
| C04 | Compare selected revision with local version | D/S | Decide and test dirty-buffer versus on-disk behavior; label editable side |
| C05 | Dedicated diff and separate-window action | S | Match supported VS Code placement explicitly; unsupported OS-window behavior is a documented deviation |
| C06 | Open historical version read-only | S | Old content opens without checking out repository or altering active file |
| C07 | Added and deleted revisions | S/P | Missing side is explicit empty/absent state; an actual read failure is not displayed as an empty file |
| C08 | Renamed revisions | S/P | Each side loads its own revision path and labels it correctly |
| C09 | Merge parent semantics | S, R? | Parent choice and conflict-resolution changes match reference fixture |
| C10 | Diff preview toggle and layout options | S | Preview hidden/shown without losing selection; split proportions preserved |
| C11 | Side-by-side/unified modes and diff navigation | D/P, R? | Reuse existing viewer capabilities; inventory preview-specific differences |
| C12 | Whitespace, granularity, wrapping, unchanged context, scroll synchronization | D/P, R? | Audit each shared control against reference; do not silently promise unsupported modes |
| C13 | Binary/large/encoding-sensitive content | D/P | Visible explicit result or existing viewer fallback; never hang or show fabricated text |

### 5.4 History toolbar and context actions

Source registration gives this history popup sequence; runtime labels and enablement must still be captured:

1. Copy revision identifier.
2. Create patch from selected change(s).
3. Separator.
4. Get Version / Get from Revision.
5. Open repository version.
6. Compare with local.
7. Show Diff.
8. Show standalone diff.
9. Show all affected files.
10. Annotate revision.
11. Select in Log.
12. VCS/provider-contributed history actions.

Toolbar source order: branch filters → separator → refresh → diff → affected files → separator → presentation settings → separator → contributed actions → indexing action. Select in Log occupies a separate right-corner toolbar group.

| ID | Contract | Key check |
| --- | --- | --- |
| A01 | Copy revision | Full hash; defined multi-selection behavior; no abbreviated-hash ambiguity |
| A02 | Create patch/export/clipboard | Correct selected file/revisions; rename paths and binary restrictions explicit; do not export entire commit unintentionally |
| A03 | Get from Revision | Restore selected file version only; preserve unrelated files, branch and index unless reference and approved contract explicitly say otherwise |
| A04 | Open repository version | Immutable revision URI/provider; no writable historical buffer |
| A05 | Show all affected files | Full selected commit file list, not history file only; selected commit/root remains fixed |
| A06 | Annotate revision | Blame selected historical content/path, not current working tree; navigation leads to correct revision |
| A07 | Select in Log | Open/focus appropriate repository log and selected hash without confusing history filter state |
| A08 | Hosting links | Resolve correct remote/provider and commit; unavailable provider action does not masquerade as working |
| A09 | Presentation settings | Details, preview orientation, date preference, columns; persist at defined scope |
| A10 | Indexing/search capability | Audit functional outcome separately from JetBrains indexing implementation; no fake “Enable indexing” button |

Generic cherry-pick/reset/drop/rebase actions exist elsewhere in IntelliGit but are not present in the inspected core file-history popup. Do not import its entire commit menu just because it is reusable. Provider additions and installed plugins may change the final inventory; capture before finalizing.

### 5.5 Folder and selection history (default expanded scope)

- **F01 Folder history:** commits affecting selected directory paths; expected project-log style filtered history rather than a fictional single-file timeline. Multiple directories must retain their roots; mixed-root behavior needs explicit reference/spec decision.
- Deleted-path invocation is core file history (E11), independent of whether folder or selection history is included. Do not require `existsSync` for historical content.
- **L01 Selection history:** selected line range, or caret line when no range is selected, opens a distinct history surface. Capture PyCharm's range display, parent traversal, and local edits behavior before implementation.
- **L02 Line ancestry:** tests cover inserted/deleted lines, moved blocks, renames, range disappearing, merge history, and binary/unsupported files. `git log -L` is a candidate implementation tool, not proof of equivalent behavior.
- **L03 Selection comparisons:** compare the evolving fragment and provide enough file context to understand it; do not approximate by showing every commit touching the whole file.

## 6. Correctness contracts before UI implementation

### 6.1 Identity and target resolution

A history target is the tuple `(repository/worktree identity, repository-relative path, optional anchor revision, optional selected range)`. A basename or current global repository is insufficient. Two worktrees can contain the same relative path and the same commit hash while having different local content and branch state.

Resolution order: explicit context URI/selected row → active text editor for command-only invocation → explicit no-target result. Never fall back from a supplied invalid target to a different active editor. Historical URI resolution must recover underlying repository/path/ref deliberately; arbitrary URI query strings are not trusted commands.

### 6.2 Data model proposal

This is a proposed boundary contract, not an existing exported API. Final names should follow the inspected code style.

```ts
type HistoryFileSide =
    | { kind: "revision"; commit: string; path: string }
    | { kind: "absent" };

interface FileHistoryEntry {
    hash: string;
    parents: string[];
    subject: string;
    authorName: string;
    authorEmail: string;
    authoredAt: string;
    committerName: string;
    committerEmail: string;
    committedAt: string;
    pathAtRevision: string;
    previousPath?: string;
    status: "added" | "modified" | "deleted" | "renamed" | "type-changed";
}

interface FileHistoryComparisonEdge {
    selectedCommit: string;
    // The previous visible file-history node can skip unrelated Git commits.
    predecessorCommit?: string;
    // Preserve the Git-parent relationship separately when the query knows it.
    gitParentCommit?: string;
    before: HistoryFileSide;
    after: HistoryFileSide;
}
```

The selected comparison needs independent left/right sides. An absent side is a valid historical condition; a failed object read is an error. Do not encode both as `""`. Commit message bodies can load lazily for the details pane. `parents` means raw Git parents; it is not the file-history graph adjacency. The query/selection layer must separately provide file-history comparison edges. A merge can have multiple edges with different before paths; `previousPath` is only a display hint and cannot define those comparisons. Distinguish graph-aware predecessor selection from a graph-unavailable next-row fallback explicitly. Do not silently apply the latter to every history.

### 6.3 Git query rules

- Reuse existing argument-array Git executor. No shell interpolation of file paths, refs, author strings, or message text.
- Use path-safe Git arguments and explicit path separators. Test spaces, tabs/newlines, Unicode, leading dash, and literal pathspec characters. Determine whether executor supports literal-pathspec mode before choosing exact command form.
- Single-path `--follow` is useful, but not a complete all-branches/merge-accurate history model. Prove branch/rename behavior on fixtures before designing pagination around it.
- Preserve rename continuity across page boundaries. Restarting each page against the current name can lose older paths. Choose a cursor/session strategy after the thin-slice experiments.
- Define snapshot semantics when HEAD moves during loading; avoid duplicated/missing rows from offset pagination over changing history.
- A repository refresh invalidates relevant history and local diff content, not another worktree's immutable revision blobs.
- Include shallow-clone and missing-object states. Do not silently fetch network history merely because a user opens a local history view.

### 6.4 Async ownership

Each request carries History-window identity and generation. A response is applied only to its live matching session/generation. Closing a History window invalidates pending work. Changing branch, anchor, file, or selected revisions invalidates dependent preview/details. Cancellation should reuse existing infrastructure where supported; correctness must not depend solely on cancellation succeeding.

### 6.5 State-changing actions

Get from Revision is file restoration, not detached checkout. Before implementing it, freeze dirty-buffer, staged-content, file deletion, file mode, symlink, and renamed-path behavior against the reference and existing IntelliGit policy. Revalidate target and current state at execution time. Report only completed effects. Cancel must leave working tree/index unchanged. A selected deletion revision must not become an empty file by accident.

## 7. Implementation phases and dependency order

Root owns final acceptance. One sequential writer owns each bounded code batch; a writer cannot accept its own work. Any required challenger/verifier uses the user's permitted Astra effort levels. No implementation is authorized by the mere existence of this plan.

### Phase 0 — Freeze reference and resolve decisions

- [ ] Resolve remaining D1–D5/D7–D8 decisions. D6 is settled: standalone new window only.
- [ ] Recover Computer Use or obtain user-visible reference access; open actual file History.
- [ ] Record exact installed build, OS, theme, keymap, scaling, window/panel size and enabled VCS-related plugins.
- [ ] Capture default view, both selection modes, all toolbar menus, table popup, branch filter, rename column, details, preview modes, affected-files dialog, historical editor, annotation view, and restoration confirmation.
- [ ] Repeat selected interactions on a disposable Git fixture; do not test restoration or history rewriting on the user's working project.
- [ ] Pin source references to a commit/build where possible; resolve source/runtime disagreements in favor of chosen installed reference.
- [ ] Acceptance owner approves a traceable action inventory and screenshot manifest. No “exact visual parity” verdict without these assets.

### Phase 1 — Establish data and rename semantics

- [ ] Inspect existing history helper and its current consumer before changing a public return type.
- [ ] Build a temporary real-Git fixture with addition, edits, unrelated commit, rename, post-rename edit, divergent branches, merge, deletion, and recreation.
- [ ] Write focused failing tests for ordered history entries, revision paths, predecessor selection, and all-branch semantics.
- [ ] Run failures and read named assertions; distinguish an incorrect expectation from a real implementation gap.
- [ ] Implement the smallest history query/result layer; preserve old picker compatibility or add a separate richer method.
- [ ] Prove both sides of rename-aware comparisons from Git blob content.
- [ ] Add >one-page history and moving-ref cases before selecting the final cursor design.
- [ ] Mutation checks: remove rename tracking; replace historical path with current path; use adjacent displayed row blindly; omit repository identity. Each relevant test must fail by name.
- [ ] Exit: root reviews actual diff and focused test evidence. The data contract is frozen for the next phase.

### Phase 2 — Thin end-to-end file-history slice

- [ ] Implement §4.1: dedicated FileHistoryPanel and FileHistoryApp, opened in a new window through the existing undock mechanism. No existing graph/workbench layout integration.
- [ ] Register one file-history command and one context entry, with explicit target resolution.
- [ ] Add the history view/provider lifecycle and one focused React history app using existing shell conventions.
- [ ] Render the revision table and load a selected revision's preview through existing diff infrastructure.
- [ ] Include meaningful loading/empty/error states from the start.
- [ ] Verify a real tracked file, an old renamed revision, and a deleted side in VS Code.
- [ ] Exit: command → correct root/file → history → correct immutable blobs → visible diff works in the actual extension host.

### Phase 3 — Complete entry points and lifecycle

- [ ] Add Explorer, editor, editor-tab, palette, and IntelliGit file-row entry points.
- [ ] Add deleted-file invocation from historical changed-file entries using root/path/anchor metadata, without requiring a current filesystem file.
- [ ] Test inactive editor-tab URI precedence and multi-root/worktree identity.
- [ ] Implement independent History windows, matching-window reveal, close/dispose, refresh and anchor titles.
- [ ] Test late responses after window close and branch-filter changes; switching the main workspace repository must not retarget an open History window.
- [ ] Exit: E01–E11 pass their defined checks, including actual native VS Code menu invocation and deleted-file history independent of folder support.

### Phase 4 — Table interaction and presentation

- [ ] Match captured toolbar ordering and table columns; use existing tokens and icons under D2.
- [ ] Add column resizing/options, date preference, details and preview toggles, split orientation and retained proportions.
- [ ] Implement reference single/range/discontiguous selection; separate keyboard focus from selected revision.
- [ ] Implement branch filtering and speed search with explicit whole-history versus loaded-page semantics.
- [ ] Preserve anchors through refresh and progressive loading; clear invalid selection visibly.
- [ ] Test keyboard focus, context-menu positioning, long localized labels, 200% zoom, light/dark/high-contrast themes and narrow panels.
- [ ] Exit: H01–H12 and visible C01/C10 behavior agree with reference traces.

### Phase 5 — Full comparison and inspection actions

- [ ] Implement local comparison, two-revision comparison, historical opening, dedicated/standalone diff placement, affected-files view and Select in Log.
- [ ] Use separate per-side providers for historical paths; avoid changing the shared one-path request protocol unless evidence requires it.
- [ ] Audit shared diff modes and controls against C11–C13; record unsupported behaviors before touching shared code.
- [ ] Add annotation at historical revision only after existing blame capability and required presentation have been verified.
- [ ] Verify added/deleted files, type changes, merge parents, binary files, huge files, CRLF, final newline, and non-UTF8 behavior.
- [ ] Exit: C01–C13 and read-only A01/A04–A10 have explicit pass/deviation records.

### Phase 6 — Patch and restoration actions

- [ ] Freeze A02/A03 selection semantics and reference confirmation behavior.
- [ ] Add file-scoped patch output without routing to a whole-commit patch operation accidentally.
- [ ] Implement restoration using existing safe file-write/operation infrastructure, with dirty document and staged-state handling specified explicitly.
- [ ] Test cancel, intervening edits, restored deletion, renamed path, permissions failure, and index preservation.
- [ ] Verify actual file bytes and Git status after each operation in a disposable repository.
- [ ] Exit: A02/A03 pass; no unrelated repository mutation occurs.

### Phase 7 — Folder and selection history

- [ ] If D1 includes folders, wire directory and multi-directory contexts to root-bound path filters and affected-file comparisons.
- [ ] If D1 includes selection history, capture reference fragment behavior and freeze a separate contract first.
- [ ] Implement line ancestry only after proving the query algorithm against fixture expectations, including dirty editor selection mapping.
- [ ] Keep folder and selection state distinct from single-file history; reuse only true common controls.
- [ ] Exit: F01/L01–L03 have their own runtime evidence. Excluding them must be stated as a scope decision, not a technical success. E11 remains core acceptance.

### Phase 8 — Integrated acceptance and documentation

- [ ] Run localization pipeline before final validation for new English UI strings.
- [ ] Run focused tests, then the full required validation set once on integrated state.
- [ ] Run required affected-path Impeccable detector after UI tests.
- [ ] Capture actual VS Code runtime states using the same fixture, theme class, dimensions and interactions as reference.
- [ ] Compare first, last, and weirdest history entries; every action and disabled state; standalone window in unified and side-by-side modes.
- [ ] Publish a parity ledger: matched, intentionally adapted, not implemented, or unverified for every ID.
- [ ] Update command/settings documentation and changelog only to the implemented scope.
- [ ] Run graph change analysis before any implementation commit and record tree identity with validation evidence.

## 8. Reference fixture and test oracle

Use real Git objects as the data oracle. Avoid snapshots generated solely from the implementation under test.

| Fixture | Expected invariant |
| --- | --- |
| Empty repository | Explicit no-history state, no invented HEAD |
| One addition commit | Exactly one revision; comparison has absent predecessor |
| A → edit → unrelated commit → edit | Only relevant file commits; comparison still matches correct file content |
| `old name.txt` → `new name.txt` | Old revision loads old path; rename visible; history spans rename |
| Rename exactly at page boundary | No lost pre-rename revisions or duplicate rows |
| Delete → recreate same path | Distinguish lineage policy; do not merge histories accidentally without a reference decision |
| Branch edits and merge | Correct reachability and merge comparison semantics |
| Author differs from committer | Correct names, timestamp toggle, any reference marker |
| 250+ relevant revisions | Last entry accessible; page loading preserves selection |
| Two worktrees with same path | Local comparison reads the selected worktree |
| Two roots with same basename | Correct title context, commands and blobs |
| Dirty buffer and staged content | C04/A03 obey approved local-content contract |
| Binary, symlink, mode-only, CRLF, missing newline | Correct explicit representation; no false empty-file result |
| Leading dash, spaces, Unicode, newline, glob-like path | Literal path targeting with no shell execution/pathspec expansion |
| Shallow clone or missing object | Honest partial/error state; no silent network operation |
| Slow A request then fast B | Final visible data belongs only to B |
| View disposed during request | No update, listener leak, or reopened tab |

Representative test assertions to expand with real fixture helpers after source contracts are frozen:

```ts
expect(history.entries.map(entry => entry.hash)).toEqual(expectedFileCommits);
expect(beforeRename.pathAtRevision).toBe("old name.txt");
expect(leftContent).toBe(expectedOldBlob);
expect(rightContent).toBe(expectedNewBlob);
expect(indexAfterRestore).toEqual(indexBeforeRestore);
expect(unrelatedFileAfterRestore).toEqual(unrelatedFileBeforeRestore);
expect(currentPreview.requestId).toBe(latestSelectionRequestId);
```

These snippets describe intended assertions, not runnable tests or proof that named helper APIs already exist. Concrete executable tests belong in each frozen implementation work order.

## 9. Runtime and visual acceptance protocol

Create a screenshot/trace manifest with: requirement ID, app/version, fixture commit, file/path/ref, selected rows, theme, keymap, scale, viewport/panel dimensions, UI actions, expected result, screenshot path, actual result, and deviation rationale.

Required captures:

1. File context menu in Explorer, editor, and inactive tab.
2. Default History with first revision selected.
3. Scrolled last revision and paging boundary.
4. Rename indicator collapsed/expanded and hover text.
5. Two and more-than-two selected revisions, reverse click order.
6. Every toolbar dropdown and row context menu, including disabled actions.
7. Preview hidden; details shown; alternate split; narrow panel.
8. Local diff, historical editor, affected files, annotation and Select in Log.
9. Restore confirmation/cancel/success and patch export.
10. Empty/error/loading and unsupported content states.
11. Folder and selection history if accepted.
12. Light/dark/high contrast, keyboard-only, zoom and long translations.

Measure row height, toolbar height, padding, icon box, column minimum widths, divider behavior and typography from accepted captures. Record numbers after measurement; do not invent them from documentation. Compare structure and interaction separately from host-theme adaptations. A screenshot of a mocked React app cannot prove VS Code native menus, URI dispatch, extension lifecycle or Git effects.

## 10. Required validation at implementation time

Use package scripts actually present in the checked-out branch. If a script is missing, record that fact and run the closest real check; do not fabricate success.

```text
bun run format:check
bun run lint
bun run lint:strict
bun run architecture:check
bun run react-doctor
bun run typecheck
bun run build
bun run test
```

For changed English strings, run before final validation:

```text
bun run l10n:sync
bun run l10n:translate -- --only-missing
bun run l10n:import
bun scripts/localization-csv.js validate
bun run l10n:validate
bun run l10n:audit
```

Read `docs/localization/README.md` first. Static catalogs only; no runtime translation. Preserve tokens, codicons, paths and established terminology. Run production build/package only if delivery scope includes packaging. Never run publish without explicit user authorization.

UI verification additionally requires the real extension host and `npx --yes impeccable detect` on affected paths after tests. Use the detector's installed help for its actual path argument form rather than guessing flags.

## 11. Principal risks and how the plan resolves them

| Risk | Resolution / acceptance gate |
| --- | --- |
| Exact visual promise without actual history screenshot | Phase 0 blocks visual freeze; installed runtime capture remains mandatory |
| Online master differs from installed PyCharm | Pin version/build and reconcile discrepancies, preserving evidence provenance |
| Treating `--follow` as complete rename/merge/all-branch history | Real-Git ancestry experiments before cursor/data design |
| Current-path ref diff breaks renamed history | Independent historical paths per side, tested against blobs |
| Context action uses active editor rather than clicked tab | Explicit-URI precedence tests in real VS Code |
| Async preview shows wrong revision/root | Session identity + generation checks and adversarial delayed responses |
| Whole-commit action used for a file-scoped operation | Separate file action contract and actual Git status/bytes verification |
| Shared graph component drags in unwanted commit operations | Reuse narrow primitives; focused history table where simpler |
| Silent history cap or unloaded search misses | Explicit progressive loading/search scope and last-entry tests |
| Scope grows to every IDE feature | Trace every addition to inventory and chosen D1–D8 answers |

## 12. Exit report template

For this planning deliverable: state worktree/branch/base, document path, evidence examined, open decisions, and unverified runtime facts. No application-test or parity-success claim.

For future implementation: report spec compliance separately from production quality; list integrated tree/commit, personally run versus independently audited checks, exact pass/fail counts, mutation assertions, runtime evidence paths, and remaining parity deviations. “Tests pass” alone is insufficient.

## Appendix A — Verified IntelliGit source map

Source inventory performed by `gpt-6-astra` at high effort against the exact worktree/base above; root reviewed its report. Paths below are relative to this worktree. These are source facts, not test or runtime results. Original report was written to `/tmp/issue159-code-research.md`; decision-relevant findings are preserved here so the plan does not depend on a temporary file.

| File and line | Current behavior | Planned use / constraint |
| --- | --- | --- |
| `package.json:451` | Compare-with-revision/branch command contributions | Add distinct history command; keep compare workflow compatible |
| `package.json:699` | Editor title controls and editor context submenu | Add explicit `editor/title/context` and `explorer/context` entries; title toolbar is not tab context |
| `package.json:897` | Existing Show Git Log default shortcut | Audit new shortcut separately |
| `src/activation/repositoryCommands.ts:97` | Registers repository command groups | Add bounded history registration |
| `src/activation/repositoryCommands.ts:411` | Existing compare handlers use current repository dependencies | Do not reuse mutable root selection for inactive tab targets |
| `src/activation/repositoryMode.ts:89` | Private deepest-containing-repository resolver | Extract/reuse narrowly if needed; capture root before async work |
| `src/services/diffService.ts:722` | Private editor-context URI helper | Model context precedence, but reject supplied invalid targets explicitly |
| `src/services/diffService.ts:243` | Relative-file path helper | Existing `startsWith('..')` behavior can reject valid dot-prefixed names; do not widen unrelated fix scope silently |
| `src/git/operations.ts:1541` | `getFileHistoryEntries` follows renames, default 30, no paging/old-path metadata | Preserve current picker caller or add a richer focused method |
| `src/git/parsers.ts:157` | Simple tab/line history parser | Inadequate canonical rich format; author tabs/whitespace need robust handling |
| `src/git/parsers.ts:22` | NUL-based full commit log format | Reuse metadata conventions where appropriate |
| `src/git/operations.ts:467` | General log with skip, count and optional branch | No file/path ancestry; avoid turning it into a speculative universal history API |
| `src/git/operations.ts:521` | Commit details and all changed files | Reuse for A05; do not load whole tree solely to render metadata |
| `src/git/operations.ts:1565` | Text file content at ref | Use bounded side loader for previews rather than unbounded text reads |
| `src/services/diffService.ts:957` | Sole production history-helper consumer, QuickPick limited to 20 | Existing compare flow is not the requested history UI |
| `src/views/CommitGraphViewProvider.ts:555` | Generation-guarded initial/filter/refresh requests | Reuse behavior, not all global provider state |
| `src/views/CommitGraphViewProvider.ts:604` | Loading-more guard and stale append suppression | Extend semantics to path-aware history paging |
| `src/activation/repositoryViewEvents.ts:170` | Commit detail selection fans out to global views | Keep per-history selection private until explicit Select in Log |
| `src/webviews/react/CommitList.tsx:62` | Single selected hash, graph/checks/branch actions | Focused table likely smaller than forcing range selection and history popup into current component |
| `src/webviews/react/commit-list/CommitRow.tsx:468` | Click and Enter/Space select one row | Not proof of table keyboard/range parity |
| `src/webviews/react/commit-info/CommitInfoPane.tsx:482` | Commit metadata/body renderer is private | Extract only if needed; do not embed all affected files permanently in default History |
| `src/diff/unifiedDiffTypes.ts:32` | Ref/worktree/provider sides, provider labels/loaders/identities | Independent provider sides support historical paths |
| `src/diff/unifiedDiffTypes.ts:44` | One shared request path for both ref sides | Current-path ref/ref requests are wrong across rename |
| `src/diff/sideLoader.ts:72` | Per-side path loading with binary/encoding/symlink/submodule handling | Preferred bounded content seam |
| `src/diff/sideLoader.ts:129` | Object size probe and explicit missing-path handling | Preserve true error versus missing-side distinction |
| `src/views/shelfDiffActions.ts:90` | Provider sides with snapshot identity and shared diff funnel | Concrete reuse example for historical sides |
| `src/services/diffService.ts:811` | Commit file diff prompts for merge parent and uses empty tree for root commit | Useful semantics; same-path assumptions and catch-all native fallback must not be copied |
| `src/views/DiffViewerPanel.ts:140` | Single reusable editor diff panel | Opening it is not an embedded live History preview |
| `src/webviews/react/diff-viewer/DiffViewerApp.tsx:556` | App exported, internal pane renderers private | Narrow shared extraction may be needed for embedded preview; analyze impact first |
| `src/views/webviewHtml.ts:48` | Shared shell, localization payload and CSP | Reuse rather than writing a second HTML/security pipeline |
| `src/views/webviewHtml.ts:130` | Explicit unique multi-instance E2E view identity | Include root/path/session identity for multiple History tabs |
| `scripts/webviewConfigs.js:3` | Authoritative webview bundle inventory | Add history bundle entry; build and watch consume it |

### Proposed file ownership by phase

New filenames are proposals. Verify standing rules and impact analysis before editing existing symbols. D6 fixes placement to a standalone new window; no internal workbench tabs are planned.

| Phase | Proposed files | Responsibility |
| --- | --- | --- |
| 1 | New `src/git/fileHistory.ts`; narrow `src/git/operations.ts` addition | Query, robust parsing, ancestry/path metadata and paging contract |
| 1 | New `tests/unit/git/fileHistory.test.ts`; real-Git fixture tests under existing integration layout | Data oracle and rename/branch/page tests |
| 2–3 | New `src/services/fileHistoryService.ts`; `src/activation/repositoryCommands.ts`; narrow repository resolver seam | URI/root resolution and open/reveal lifecycle |
| 2–3 | New `src/views/FileHistoryPanel.ts`; new `src/webviews/protocol/fileHistory.ts`; narrowly reuse existing undock window-opening helper | Root-bound standalone window lifecycle and validated messages; no graph/workbench tab integration |
| 2–4 | New `src/webviews/react/file-history/FileHistoryApp.tsx` with small local table/preview modules as needed | History-specific view state and interaction model |
| 2 | `scripts/webviewConfigs.js` | Register dedicated FileHistoryApp bundle for standalone History window |
| 3 | `package.json`, `package.nls.json`, reviewed localization CSV and generated catalogs | Native entry points, bindable command and localized labels |
| 4–5 | Existing diff rendering/loader leaf files only where extraction is demonstrated necessary | Share actual primitives without turning DiffViewerPanel into an unrelated multi-tool abstraction |
| 5–6 | Focused history action module beside history service/provider | File-scoped patch/restore/open/annotate/navigation contracts |
| 7 | Separate folder/selection modules only after their contracts are frozen | Distinct ancestry and display semantics |
| 8 | Existing command docs, changelog and appropriate tests | Truthful support documentation and integrated evidence |

Reuse only the existing separate-window opening mechanism. Do not add History state to CommitGraphPanel, UndockedApp or UndockedLayout. Any extraction from UndockedViewProvider must be limited to the proven window-opening seam.

### Existing test anchors and exact focused command

The source reviewer verified these files exist; no test execution is claimed:

- `tests/unit/services/diffService.test.ts`: compare picker, revision/local diff and error behavior.
- `tests/unit/diff/sideLoader.test.ts`: content-loading patterns.
- `tests/unit/activation/repositoryCommands.test.ts`: command registration patterns.
- `tests/unit/views/CommitGraphViewProvider.test.ts`: loading/paging/provider patterns.
- `tests/unit/views/diffViewerPanel.test.ts`: panel lifecycle patterns.
- `tests/unit/git/gitParsers.test.ts` and `tests/unit/git/operations.test.ts`: Git model patterns.
- `tests/unit/scripts/webviewConfigs.test.ts`: bundle registry coverage.
- `tests/webview/unit/commit-list-column-resize.test.tsx`: table-column behavior.
- `tests/webview/unit/commitGraphMessages.test.tsx`: renderer message behavior.
- `tests/integration/extension/extension.integration.test.ts`: extension-level commit diff flow.
- `tests/integration/extension/view-providers.integration.test.ts`: provider load-more flow.

Before implementation, after the normal dependency/build setup, the smallest relevant existing baseline is:

```sh
bun vitest run tests/unit/services/diffService.test.ts tests/unit/diff/sideLoader.test.ts tests/unit/activation/repositoryCommands.test.ts tests/unit/views/CommitGraphViewProvider.test.ts tests/unit/scripts/webviewConfigs.test.ts
```

This is an exact proposed command, not a completed check. `package.json` defines a pretest build for `bun run test`; direct `bun vitest run` bypasses that lifecycle, so build prerequisites must be satisfied first. New history tests must be added to the appropriate phase checks rather than assuming existing mocked picker tests cover rename history.

## Appendix B — Planning tooling notes

- Source discovery used codebase-memory index for this exact worktree and lean-ctx reads. No production symbols were edited; symbol impact analysis and full code validation are therefore deferred to implementation.
- `writing-plans` guided phased planning; `using-git-worktrees` guided isolation. `impeccable shape` supplied the UI brief constraints. This document deliberately remains a research/spec plan while visual authority and several product choices are unresolved; it is not a fabricated code-complete frozen implementation script.
- Project design context prefers VS Code theme inheritance. Impeccable reported a deprecated `PRODUCT.md` Register section and an available skill update. These unrelated maintenance items were not changed; the current request remains history planning.

## Appendix C — Independent challenge and disposition

An independent `gpt-6-astra` high-effort planning review returned three P2 concerns. Root accepted and incorporated each:

1. **Placement:** superseded by the user decision in §4.1. Standalone new History window only; previous workbench-tab proposal and its integration requirements are removed.
2. **Deleted-path scope:** deleted-file invocation was accidentally grouped with optional folder work. It is now E11 and Phase 3 core acceptance.
3. **Predecessor semantics:** raw Git parents and one rename hint cannot represent the file-history graph/merge comparison. Section 6.2 now separates comparison edges and per-side paths from raw parents, with explicit graph-unavailable fallback semantics.

Reviewer found no unsupported parity-success claim. Review was source/document analysis only, not application execution. Final planning state remains a detailed draft pending remaining behavior decisions and interactive reference checks; D6 placement is settled.

## Appendix D — September 12 context-menu and History layout correction

The user rejected the first rendered History UI and requested an IntelliGit submenu before further UI work. Explorer and editor-tab context menus now contribute **IntelliGit → Show File History**; the existing editor context submenu retains its existing comparison actions. The native VS Code menu owns hover and keyboard submenu behavior.

The supplied PyCharm screenshots remain visual authority. The correction uses a 41% history / 59% existing DiffViewer split, a compact toolbar at the top of the left pane, headerless 24px author/date-and-time/graph/subject rows, optional real branch/tag badges, and details hidden initially. The redundant path bar and bottom action-button bank are removed. Existing revision operations move into a shared context menu with keyboard access. VS Code theme colors and the existing shared diff renderer remain in use.

Reference badges come from local Git refs, including peeled annotated tags. Graph lines represent verified adjacent raw-parent relationships only; filtered ancestry and status badges are not fabricated. Full PyCharm graph/status parity remains outside what this correction proves.

Acceptance covers Explorer and editor-tab hover menus, a separate native window containing eight real commits, selection-driven diff changes, details visibility, keyboard resizing, search clearing, and context-menu targeting/toggling. Final acceptance must also rebuild and verify the VSIX against the unchanged 8 MiB uncompressed budget. A source-only or single-row screenshot check is insufficient.

Validation for this correction: 11 History integration tests and 16 Git/host/command tests passed. The annotated-tag mutation removed `release/one` and failed its ref assertion; the row-context mutation targeted the wrong revision and failed its selected-hash assertion. Independent review found and resolved hidden search filtering and pointer-menu toggling defects. The final native production-bundle run passed all assertions plus setup/teardown in 13.3 seconds; earlier native runs encountered a teardown timeout and intermittent launch timeouts. The test now terminates only its isolated host during cleanup.

Full Vitest run completed with 4,866 passes and one 60-second screenshot-comparator timeout; that unchanged comparator passed its isolated rerun in 10.29 seconds. Formatting, lint, strict lint, architecture, React Doctor, all TypeScript configurations, and localization checks passed. Impeccable detection returned no findings. The rebuilt VSIX contains 83 entries, 1,907,477 compressed bytes and 7,040,724 uncompressed bytes. All 19 packaged runtime files match production `dist`; `plan.md` stays excluded. SHA-256: `1be6453ed33397f5628bc61db07de28721d3f29c5f685e87836c68a6c4a0668e`.

Pinned Linux screenshot verification passed all 16 checks across History, diff, merge, and shelf-conflict viewers in dark/light and narrow/wide viewports. Only the four History goldens were updated; the twelve shared-viewer goldens remained unchanged.
