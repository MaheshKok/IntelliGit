# Three-pane merge header and footer comparison

Reviewed 12 September 2026 against PyCharm 2026.2 documentation and IntelliJ
Platform merge-viewer source. This is a comparison of the merge dialog, not every
feature offered by the two-pane diff viewer.

## References

- [PyCharm: Resolve Git conflicts](https://www.jetbrains.com/help/pycharm/resolve-conflicts.html)
- [PyCharm: Diff and Merge viewer controls](https://www.jetbrains.com/help/pycharm/differences-viewer.html)
- [IntelliJ Platform: MergeThreesideViewer](https://github.com/JetBrains/intellij-community/blob/master/platform/diff-impl/src/com/intellij/diff/merge/MergeThreesideViewer.java)
- [IntelliJ Platform: ThreesideTextDiffViewerEx](https://github.com/JetBrains/intellij-community/blob/master/platform/diff-impl/src/com/intellij/diff/tools/simple/ThreesideTextDiffViewerEx.java)

The source links follow the upstream default branch and can change. The official
reference screenshot was inspected during the preceding conflict-count work.
Fresh browser inspection failed with CDP timeouts during this pass; the open
PyCharm window showed a repository diff, not a merge. Exact pixel parity with the
installed PyCharm theme is therefore not claimed.

## Function comparison

| Area | PyCharm | IntelliGit |
| --- | --- | --- |
| Navigation | Previous/next difference and keyboard shortcuts | Previous/next true conflict; N/P and F7/Shift+F7. Automatic changes are not navigation targets. |
| Whitespace | None, trim, ignore in the merge implementation | None and ignore whitespace; explicit selector in this refinement. Trim is missing. |
| Highlighting | Line/word modes in the merge implementation | Word highlighting toggle; turning it off retains line highlighting. |
| Compare Contents | Six comparisons between left, middle/result, right, and base | Missing. Needs accurate base and current edited result plus a host diff-opening contract. |
| Non-conflicting changes | Apply all, left, or right | Automatic inclusion plus an existing all-nonconflicting action. Separate left/right actions are missing. |
| Simple conflicts | Explicit resolution of compatible independent edits | No separate toolbar action. Some changes are already classified as automatically merged. A new action must use a sound merge algorithm. |
| Revert resolution | Restore/revert merge decisions | No equivalent global revert control. |
| Unchanged fragments | Collapse unchanged regions | Missing global collapse control in the three-pane editor. |
| Editor settings | Scrolling, display, and editor options | Synchronized scrolling is built in; no equivalent settings menu. |
| Remaining status | Pending changes/conflicts; success check when none remain | Top-right remaining conflict count and green success check. Non-conflicting changes are included automatically, so pending changes read “No changes”. |
| Pane titles | Side identity, result identity, details | Left/right labels, result filename, and expandable details retained. |
| Whole-file choice | Accept a complete side and finish, with discard confirmation where needed | Existing host commands for Use File Ours/Theirs retained, separate from local hunk-level Accept All. |
| Cancel | Cancel the merge dialog; may confirm discarded edits | Existing close command retained. Do not confuse it with Abort Merge. |
| Apply | Finish merge; can confirm incomplete resolution | Existing all-conflicts-resolved gate retained. Partial apply is not added. |
| Help | Contextual help | No dedicated help button. |
| Multi-file session | Navigation can depend on surrounding merge session | Existing Conflicts button opens IntelliGit's session panel; no previous/next-file toolbar controls. |

## Refinement contract

Use a navigation-first compact toolbar, aligned pane labels, and a quiet footer.
Keep one authoritative pending status visible. Move repeated summary counts into
the existing details expansion, preserving the result filename and access to
details at narrow widths. Icon controls retain translated accessible names.

Group whole-file choices beside Cancel and the primary Apply button. Keep
repository-wide Abort Merge and Conflicts separate, with their existing absence
in shelf sessions. Apply uses its plain translated label and remains associated
with the visible conflict status for assistive technology.

Keep VS Code theme tokens, keyboard focus, localized wrapping, existing host
messages, and merge semantics. Do not add inactive buttons for missing functions.
The advanced gaps above require separate functional work; visual similarity does
not mean those capabilities exist.

## Checks

Verify selector messages in both directions, same-mode no-op, details visibility,
footer command routing, shelf restrictions, and Apply gating. Inspect built
runtime in dark/light themes at wide/narrow widths, including a long translation.
Visual baselines verify stability of the implemented layout, not equivalence to
PyCharm's native controls.

### Verification results

- This header/footer refinement follows badge/count checkpoint `df68198a`.
- Merge integration: 31 passed, including focused-selector keyboard isolation.
  Large-document tests: 3 passed in isolation. An earlier combined run exceeded
  the existing timing ratio; no performance threshold was changed.
- Container pixel comparisons: 8 passed after updating the eight merge/shelf
  baselines. The shared container cache had Playwright 1.63 while this worktree
  locks 1.62.1. An isolated cache with the frozen lockfile resolved the mismatch;
  the repository's image pin and dependencies remain unchanged.
- Built-runtime interaction checks passed for dark 1600px, light 1024px, and
  German 320px layouts, with no clipped toolbar/footer controls or page errors.
- Format, lint, strict lint, architecture, React Doctor, typecheck, localization,
  build, and packaging checks ran successfully. The final SELECT guard was
  simplified to a membership check to satisfy the complexity limit; its focused
  tests and ESLint check passed afterward. Impeccable reported no anti-patterns
  and 14 existing advisory notes.
- Difference-count typography uses the same VS Code UI font as toolbar buttons,
  at 12px. Built-runtime computed styles confirmed the font and size match.
  All eight diff/history pixel comparisons passed after updating their baselines.
- Final VSIX: 7,070,242 bytes uncompressed, below the unchanged 8 MiB budget.
- Final full-suite run: 4,866 passed and 3 failed across 360 files (275.19s).
  One shelf-session test still expected the old Apply label; its expectation was
  updated to the existing plain Apply translation. The other failures were a
  4.15x render ratio against the unchanged 2.9x ceiling and a screenshot-comparator
  timeout. All three files passed a sequential rerun (6 tests, 15.35s).
  This is not a clean full-suite pass; no production code or thresholds changed
  after that run.
