# Complexity Ratchet Implementation Plan

> **Execution note:** Follow this plan phase by phase. Each phase preserves observable behaviour, adds or confirms a focused regression test first, and is independently reviewable. Do not enable a gate until the current source satisfies it.

**Goal:** Reduce the highest-risk TypeScript functions without broad rewrites, then enforce a sustainable complexity baseline through the existing ESLint toolchain.

**Architecture:** Keep public methods and message protocols intact. Extract small, private, behaviour-oriented helpers only where they remove a coherent decision from a high-complexity function. Prefer pure parsing/mapping helpers for Git output and view state; dispatch helpers own one message family each. ESLint provides the local gate, while React Doctor remains React-specific.

**Technology:** TypeScript, Vitest, ESLint core `complexity` rule using the `modified` variant, `eslint-plugin-sonarjs` cognitive complexity rule, existing Bun scripts.

## Baseline and acceptance criteria

The baseline audit covers `src/**/*.{ts,tsx}` and 2,560 function-like scopes. It found 88 classic cyclomatic scores over 10, 33 over 15, and 15 over 20. The existing SonarJS cognitive threshold is 40; 13 functions exceed 20 and none exceed 40. The highest priority functions are:

| Symbol | File | Classic CC | Cognitive |
| --- | --- | ---: | ---: |
| `CommitPanelViewProvider.handleMessage` | `src/views/CommitPanelViewProvider.ts` | 57 | 30 |
| `GitOps.getBranches` | `src/git/operations.ts` | 33 | 40 |
| `UndockedViewProvider.handleMessage` | `src/views/UndockedViewProvider.ts` | 56 | 17 |
| branch deletion command handler | `src/commands/branchCommands.ts` | 25 | 34 |
| `cloneViaGitLab` | `src/services/cloneService.ts` | 19 | 39 |
| `parseThemeSection` | `src/utils/fileIconTheme.ts` | 19 | 29 |
| `deriveConflictView` | `src/webviews/react/merge-editor/segments.tsx` | 30 | 12 |

Final Phase 6 acceptance: `bun run lint` enforces modified cyclomatic complexity and cognitive complexity at 25, all affected tests pass, and no public protocol or Git output interpretation changes.

## Phase 0 – establish the repeatable audit

**Files:**
- Modify: `eslint.config.mjs`
- Modify: `package.json`
- Test: existing lint command and a focused report command

1. Add a `lint:complexity` script that invokes the existing ESLint binary on `src/**/*.{ts,tsx}` without generated reports.
2. Keep the default `bun run lint` unchanged until all functions that would violate the 25 gates have been addressed.
3. Record the before/after function counts in the pull request description; do not commit generated reports.

Validation:

```bash
bun run lint
bun run lint:complexity
```

## Phase 1 – Git branch parsing (start here)

**Files:**
- Modify: `src/git/operations.ts`
- Modify: `tests/unit/git/gitops/status.test.ts`

1. Add a failing test that combines a symbolic remote `HEAD`, an invalid remote mapping, a valid default mapping, and ahead/behind values. Assert that the returned `Branch[]` remains exactly as today.
2. In `operations.ts`, split `getBranches` into private module helpers with explicit inputs and outputs:

```ts
type BranchRow = string[];
type DefaultBranchRefs = {
    defaultRemoteRefs: Set<string>;
    remotesWithDefault: Set<string>;
    defaultLocalNames: Set<string>;
};

function parseBranchRows(result: string): BranchRow[];
function collectDefaultBranchRefs(rows: BranchRow[]): DefaultBranchRefs;
function toBranch(row: BranchRow, defaults: DefaultBranchRefs): Branch | undefined;
```

3. Keep `GitOps.getBranches()` responsible only for the Git invocation, parsing rows, collecting defaults, and dropping `undefined` entries.
4. Preserve the existing `Branch` field meanings, invalid-name filtering, `main`/`master` fallback, and finite-date guard.

Focused validation:

```bash
bun vitest run tests/unit/git/gitops/status.test.ts
bun run lint -- src/git/operations.ts tests/unit/git/gitops/status.test.ts
```

## Phase 2 – core parsing and clone decision functions

**Files:**
- Modify: `src/services/cloneService.ts`
- Modify: `src/utils/fileIconTheme.ts`
- Modify/add: focused tests next to the existing Git and file-theme tests

1. Extract the GitLab token selection and clone-path decisions from `cloneService.cloneViaGitLab` into private helpers; preserve credentials, destination validation, and error behaviour.
2. Convert `parseThemeSection` into a linear parser with narrowly named helpers for contribution filtering and child-section traversal.
3. Add regression tests for malformed values and the currently accepted happy paths before each change.

Focused validation:

```bash
bun vitest run tests/unit/git
bun vitest run tests/unit/utils
```

## Phase 3 – branch command workflow

**Files:**
- Modify: `src/commands/branchCommands.ts`
- Modify/add: `tests/integration/extension/extension.integration.test.ts`

1. Group the branch-delete handler into helpers for branch selection, confirmation, worktree checks, and post-delete refresh.
2. Leave the command identifier, confirmation text, error reporting, and refresh order unchanged.
3. Add tests for the delete/cancel/reject branches that currently share the handler.

Focused validation:

```bash
bun vitest run tests/integration/extension/extension.integration.test.ts
```

## Phase 4 – provider message dispatchers

**Files:**
- Modify: `src/views/CommitPanelViewProvider.ts`
- Modify/add: `tests/integration/extension/view-providers.integration.test.ts`

1. Partition `CommitPanelViewProvider.handleMessage` by existing message domain, with one private handler per domain and a small top-level dispatcher.
2. Keep message type guards at the public dispatch boundary and retain the existing response/error contract.
3. Use table-driven tests only where messages differ solely by payload; keep dedicated tests for side-effectful commands.

Focused validation:

```bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts
```

## Phase 5 – merge editor and webview state derivation

**Files:**
- Modify: `src/webviews/react/merge-editor/segments.tsx`
- Modify/add: merge-editor integration tests

1. Separate conflict segment classification from view-model construction in `deriveConflictView`.
2. Test the resolved/auto-merged and explicit-override paths before refactoring.

Focused validation:

```bash
bun vitest run tests/integration/webviews/merge-webviews.integration.test.tsx
```

## Phase 6 – activate and ratchet quality gates

**Files:**
- Modify: `eslint.config.mjs`
- Modify: `package.json` only if the Phase 0 reporting script is still needed

1. Enable ESLint core `complexity` once, using `{ max: 25, variant: "modified" }` for TypeScript and TSX source.
2. Lower `sonarjs/cognitive-complexity` from 40 to 25.
3. Do not configure SonarJS cyclomatic complexity alongside ESLint’s core rule; that would create duplicate, differently-scored gates.
4. After the 25 gate remains clean for a release cycle, create separate follow-up work to ratchet 25 → 20 → 15. Each reduction must start with a fresh report and a new baseline, not blanket suppressions.

Final validation:

```bash
bun run format:check
bun run lint
bun run architecture:check
bun run react-doctor
bun run typecheck
bun run build
bun run test
```

## Delivery rules

- The first 25-point ratchet deliberately covers only functions that violate those gates. The independently high-scoring `UndockedViewProvider` and merge-editor keyboard handler remain candidates for the later 20-to-15 ratchet, not scope for this behavior-preserving first pass.

- No new dependency is required: ESLint, TypeScript ESLint, SonarJS, Vitest, and React Doctor are already installed.
- Do not alter public command IDs, webview message names, Branch fields, localization strings, or Git command arguments while reducing complexity.
- Run GitNexus impact analysis before each symbol edit when available; in its absence, use codebase-memory inbound traces and report a high-risk blast radius before editing.
- Before any commit, run codebase-memory or GitNexus change detection and inspect the diff to confirm only planned symbols changed.
