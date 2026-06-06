# TSDoc Baseline Audit

Snapshot date: 2026-06-06

This audit records the starting point for the TSDoc rollout before any source documentation ratchet or documentation lint enforcement is enabled. The source counts cover `src/**/*.ts` and `src/**/*.tsx` only, so markdown, changelog, and release metadata edits do not affect the baseline.

## Baseline counts

| Measure | Count |
| --- | ---: |
| TypeScript / TSX files under `src` | 134 |
| Total source file lines | 23,458 |
| Approximate non-blank lines | 21,812 |
| Approximate source lines excluding comment-only lines | 21,350 |
| Existing `/** ... */` documentation blocks | 50 |
| Approximate directly exported symbols | 400 |

The exported symbol count includes direct `export` declarations for functions, classes, interfaces, type aliases, enums, variables, and default exported functions/classes. It is intended as a rollout planning baseline, not as a compiler-accurate public API inventory.

## Largest source areas

| Area | Lines |
| --- | ---: |
| `src/webviews/react` | 10,639 |
| `src/services/cloneService.ts` | 715 |
| `src/views/UndockedViewProvider.ts` | 698 |
| `src/git/operations.ts` | 671 |
| `src/views/CommitPanelViewProvider.ts` | 668 |
| `src/utils/fileIconTheme.ts` | 620 |
| `src/commands/branchCommands.ts` | 619 |
| `src/services/publishService.ts` | 604 |
| `src/utils/jetbrainsMergeTool.ts` | 518 |
| `src/activation/repositoryMode.ts` | 481 |
| `src/services/diffService.ts` | 460 |
| `src/mergeEditor/conflictParser.ts` | 441 |

## Boundary-heavy areas

These areas either expose many symbols or sit on extension-host, Git, filesystem, service, view, or webview protocol boundaries.

| Area | Files | Lines | Exported symbols | Doc blocks |
| --- | ---: | ---: | ---: | ---: |
| `src/webviews/react` | 76 | 10,639 | 190 | 10 |
| `src/services/gitHelpers.ts` | 1 | 405 | 20 | 1 |
| `src/webviews/protocol` | 5 | 242 | 17 | 6 |
| `src/git/parsers.ts` | 1 | 190 | 12 | 0 |
| `src/types.ts` | 1 | 99 | 11 | 1 |
| `src/activation/common.ts` | 1 | 139 | 10 | 0 |
| `src/commands/commitBasicActions.ts` | 1 | 336 | 9 | 0 |
| `src/views/panelFileActions.ts` | 1 | 161 | 9 | 0 |
| `src/services/diffService.ts` | 1 | 460 | 8 | 0 |
| `src/git/operationSupport.ts` | 1 | 101 | 8 | 0 |
| `src/utils/jetbrainsMergeTool.ts` | 1 | 518 | 7 | 0 |
| `src/mergeEditor/conflictParser.ts` | 1 | 441 | 6 | 1 |

## Documentation lint plugin status

| Package | Status |
| --- | --- |
| `eslint-plugin-jsdoc` | Not installed |
| `eslint-plugin-tsdoc` | Not installed |
| `typedoc` | Not installed |

No documentation lint enforcement has been added for Phase 0.

## Validation script availability

| Script | Package command |
| --- | --- |
| `deps:check:strict` | `knip` |
| `format:check` | `prettier --check "src/**/*.{ts,tsx}" "scripts/**/*.js"` |
| `lint:strict` | `eslint src scripts --max-warnings=0` |
| `architecture:check` | `depcruise src --include-only "^src" --config .dependency-cruiser.cjs` |
| `typecheck` | `bun run typecheck:ext && bun run typecheck:webview` |
| `test:coverage` | `bun vitest run --coverage` |
| `build` | `bun scripts/build.js` |
| `react-doctor` | `react-doctor -y` |
| `l10n:validate` | `bun scripts/localization-csv.js validate` |
| `l10n:audit` | `bun scripts/audit-localization-strings.js` |

## Confirmed rollout order

1. Phase 0: Baseline audit.
2. Phase 1: Create the house TSDoc standard.
3. Phase 2: Add syntax validation tooling.
4. Phase 3: Add ratchet scaffolding and pilot scope.
5. Phase 4: Tier 1A: Document and lock `src/git/**`.
6. Phase 5: Tier 1B: Document and lock protocol and shared type boundaries.
7. Phase 6: Tier 1C: Document and lock `src/services/**`.
8. Phase 7: Tier 2A: Document and lock activation flow.
9. Phase 8: Tier 2B: Document and lock commands.
10. Phase 9: Tier 2C: Document and lock views.
11. Phase 10: Tier 2D: Document and lock utilities, merge editor, and i18n support.
12. Phase 11: Tier 3A: Document React shared utilities and data/model code.
13. Phase 12: Tier 3B: Document commit panel React logic.
14. Phase 13: Tier 3C: Document remaining React apps and feature areas.
15. Phase 14: Close the ratchet across `src/**`.
16. Phase 15: Long-term governance.

## Phase 0 acceptance status

- Measured baseline recorded.
- No enforcement changes made.
- Planned phase order confirmed.
