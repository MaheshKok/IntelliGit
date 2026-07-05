# TSDoc Rollout Plan

This plan describes how to add high-signal TSDoc documentation across IntelliGit without creating a single risky, noisy documentation rewrite. The rollout uses a tiered lint ratchet: document one area, lock that area with ESLint, then expand the locked scope only after the area is reviewed and validation passes.

## Goals

- Improve readability for maintainers, contributors, and LLM-assisted workflows.
- Capture contracts, side effects, lifecycle assumptions, Git behavior, webview protocol expectations, and security invariants that TypeScript types do not express.
- Avoid low-value comments that restate parameter and return types.
- Keep CI green throughout the rollout by using scoped lint enforcement instead of global warnings.
- Make documentation sustainable by preventing newly added exported APIs from bypassing the documented areas.

## Non-goals

- Do not document every trivial private helper just because it exists.
- Do not require `@param` or `@returns` tags when they only repeat TypeScript types.
- Do not add TypeDoc or a generated API site during the initial rollout.
- Do not add runtime translation behavior or alter localization workflow as part of documentation work.
- Do not combine the entire rollout into one mega-commit or one unreviewable PR.

## Rejected alternatives

- Convention-only documentation enforced by reviewers, with no lint gate. This repo already ratchets coverage and gates knip, dependency-cruiser, and zero-warning lint; an unenforced doc standard would drift exactly like untested code. The lint ratchet is what makes the effort durable.
- TypeDoc or a generated API site during the initial rollout. IntelliGit ships as a `.vsix`, not as an imported library, so a generated API site has no real audience. The payoff (editor hover tooltips and captured contracts) comes from the comments themselves. This is reversible and can be revisited after the ratchet is closed.

## Documentation standard

Use TSDoc-style block comments for exported and boundary-facing symbols:

```ts
/**
 * Short one-sentence summary of the symbol's contract or responsibility.
 *
 * Optional paragraph explaining non-obvious behavior: side effects, fallback behavior,
 * lifecycle assumptions, ordering constraints, security invariants, Git command semantics,
 * VS Code API interactions, or webview messaging contracts.
 *
 * @param name - Include only when the meaning, format, unit, or constraint is not obvious.
 * @returns Include only when the return value has non-obvious semantics or fallback behavior.
 * @throws Include when callers need to understand or handle the failure mode.
 * @remarks Include long-lived design intent, invariants, or maintenance warnings.
 * @example Include only when usage is non-obvious or easy to misuse.
 */
```

### Good documentation explains

- What contract the symbol provides.
- Why the symbol exists.
- What side effects happen.
- What errors are swallowed, transformed, surfaced to users, or thrown.
- What Git command, output format, path format, or VS Code lifecycle is assumed.
- What security or ordering invariant must not be broken.
- What a future maintainer or LLM should know before editing the code.

### Avoid documentation that only says

- "Gets the value."
- "Sets the value."
- "Handles the event."
- "The string path."
- "Returns the result."
- "Component for rendering UI."
- Anything already obvious from the TypeScript signature.

## Enforcement model

The rollout should use two linting layers:

1. `eslint-plugin-tsdoc` for global TSDoc syntax validation.
2. `eslint-plugin-jsdoc` for scoped documentation presence and description requirements.

The repo already uses ESLint flat config. Add documentation rules in the same style as the existing extension, webview, and script file groups. The `scripts/**/*.js` build tooling is out of scope for documentation rules; apply doc rules only to `src` TypeScript and TSX files.

### Required `jsdoc` setting

`eslint-plugin-jsdoc` must run in TypeScript mode, or its rules misbehave on typed code (for example, mishandling type-only constructs or rejecting TSDoc tags). Add this once, alongside the doc rule groups:

```js
settings: { jsdoc: { mode: "typescript" } }
```

### Tag-validation authority

`tsdoc/syntax` and `jsdoc/check-tag-names` are two validators with different tag vocabularies. Running both as `error` double-validates tags and conflicts on TSDoc-only tags such as `@remarks` (valid under `tsdoc/syntax`, rejected by `check-tag-names` unless added to `definedTags`). Make `tsdoc/syntax` the single tag authority and keep `jsdoc/check-tag-names` off.

### Global rule

Enable this for TypeScript and TSX files once the plugin is installed:

```js
"tsdoc/syntax": "error"
```

### Scoped ratchet rules

Enable these only for completed, locked globs:

```js
"jsdoc/require-jsdoc": [
    "error",
    {
        publicOnly: true,
        // `publicOnly` only restricts the built-in `require` node types to
        // exported symbols. It does NOT govern `contexts` selectors, which match
        // regardless of export. Every context selector must therefore encode
        // export itself, or the rule will demand docs on internal types too.
        contexts: [
            "ExportNamedDeclaration > TSInterfaceDeclaration",
            "ExportNamedDeclaration > TSTypeAliasDeclaration",
            "ExportNamedDeclaration > TSEnumDeclaration",
            "ExportNamedDeclaration > VariableDeclaration",
        ],
    },
],
"jsdoc/require-description": "error",
"jsdoc/check-param-names": "error",
"jsdoc/check-tag-names": "off",   // tsdoc/syntax owns tag validation
"jsdoc/no-types": "error",
"jsdoc/require-param": "off",
"jsdoc/require-returns": "off",
```

The `require-param` and `require-returns` rules stay off because they encourage type-restating comments in a strict TypeScript codebase. Authors should add those tags only when they document semantics that types do not capture.

The `contexts` selectors above are the starting point; confirm during the pilot (Phase 3) that they fire only on exported symbols and skip anonymous callbacks and local JSX components.

## Tooling compatibility prerequisite

This repo pins `eslint@^10`. Before installing the doc plugins, verify that the chosen `eslint-plugin-jsdoc` and `eslint-plugin-tsdoc` versions support ESLint 10 flat config. `eslint-plugin-tsdoc` in particular has historically lagged ESLint major versions. If either plugin is incompatible, pin to a compatible plugin release or hold ESLint at a compatible version; do not proceed to enforcement until `bun run lint:strict` passes with the plugins loaded. This check gates Phase 2.

## Validation gates

Each document-and-lock phase below inlines the full gate set that CI enforces; a tier is locked only once all of it passes:

```bash
bun run deps:check:strict   # knip
bun run typecheck           # typecheck:webview for React phases
bun run lint:strict
bun run architecture:check
bun run test:coverage       # enforces the coverage ratchet
```

Phases that touch activation, views, or bundled entry points also run `bun run build`; React phases run `bun run typecheck:webview` and `bun run react-doctor` in place of the extension typecheck. `build` and `test:coverage` cannot be broken by comment-only diffs, but they run anyway so an incidental code edit cannot slip through. Phase 0 has no validation step (baseline only); every phase from Phase 1 onward runs the full gate set, even markdown-only phases, for uniformity.

## Per-phase governance

Per the repo's `.claude/CLAUDE.md`, each phase also runs the mandated gates, which the per-phase blocks do not restate:

- Run the `code-reviewer` agent on the diff after authoring a directory.
- Run the `security-reviewer` agent before committing (Tier 1 boundaries especially).
- Run `gitnexus_detect_changes()` before committing to confirm doc-only edits produced no symbol or execution-flow drift.

## Phase 0: Baseline audit

### Goal

Record the starting point before changing documentation or tooling.

### Tasks

- Count TypeScript and TSX files under `src`.
- Count approximate source lines of code.
- Count current `/** ... */` documentation blocks.
- Count current exported symbols.
- Identify which source areas are largest and which are boundary-heavy.
- Confirm whether documentation lint plugins are installed.
- Confirm validation scripts available in `package.json`.

### Useful commands

```bash
find src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l
find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 wc -l | tail -1
rg -n '/\*\*' src
rg -n '^export (async function|function|class|interface|type|enum|const|let|var)' src
node -e "const p=require('./package.json'); for (const k of ['eslint-plugin-jsdoc','eslint-plugin-tsdoc','typedoc']) console.log(k, p.devDependencies?.[k] ?? p.dependencies?.[k] ?? 'not installed')"
```

### Acceptance criteria

- The team has a measured baseline.
- No enforcement changes have been made.
- The planned phase order is confirmed.

### Suggested commit

No commit is required unless the audit snapshot is stored in the repository.

## Phase 1: Create the house TSDoc standard

### Goal

Define what good documentation means before authors start editing many files.

### Tasks

- Create or expand a documentation style guide, such as `docs/TSDOC.md`.
- Include the standard block template.
- Explain when to use `@param`, `@returns`, `@throws`, `@remarks`, `@example`, and `@deprecated`.
- Include examples for Git operations, path validation, VS Code services, webview protocol types, React hooks, and utilities.
- Explicitly warn against type-restating comments.
- Link the style guide from contributor documentation if such a file exists.

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run test:coverage
```

### Acceptance criteria

- The standard is discoverable and specific to IntelliGit.
- The standard prioritizes contracts and invariants over type repetition.
- No required-doc lint rule is enabled yet.

### Suggested commit

```text
docs(tsdoc): define documentation standard
```

## Phase 2: Add syntax validation tooling

### Goal

Install documentation lint tooling and validate existing comment syntax without requiring every export to be documented yet.

### Tasks

- Verify ESLint 10 compatibility first (see Tooling compatibility prerequisite); do not continue if the plugins cannot load under `eslint@^10`.
- Install documentation lint plugins:

```bash
bun add -d eslint-plugin-jsdoc eslint-plugin-tsdoc
```

- Do not install TypeDoc during this phase.
- Import the plugins in `eslint.config.mjs`.
- Add a shared `tsdocSyntaxRules` object with `"tsdoc/syntax": "error"`.
- Add `settings: { jsdoc: { mode: "typescript" } }` to the doc rule groups (required for correct behavior on TypeScript; see Enforcement model).
- Apply syntax validation to extension TypeScript files and React webview files.
- Fix malformed existing TSDoc/JSDoc blocks if the syntax rule reports them.
- Do not enable `jsdoc/require-jsdoc` yet.

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run test:coverage
```

### Acceptance criteria

- `eslint-plugin-jsdoc` and `eslint-plugin-tsdoc` are installed.
- Existing comments are syntactically valid.
- `lint:strict` passes.
- Documentation presence is not required globally.

### Suggested commit

```text
chore(tsdoc): add documentation syntax linting
```

## Phase 3: Add ratchet scaffolding and pilot scope

### Goal

Prove the documentation enforcement mechanism on a tiny scope before locking whole directories.

### Tasks

- Add locked documentation glob constants in `eslint.config.mjs`, for example:

```js
const TSDOC_LOCKED_EXTENSION_FILES = [
    // Expanded phase by phase.
];

const TSDOC_LOCKED_REACT_FILES = [
    // Expanded phase by phase.
];
```

- Add shared `jsdocContractRules` and `requireExportDocsRules` objects.
- Configure `jsdoc/require-jsdoc` for exported/public symbols only, using the export-aware `contexts` selectors from the Enforcement model.
- Keep `jsdoc/require-param` and `jsdoc/require-returns` off; keep `jsdoc/check-tag-names` off.
- Pilot across all three symbol shapes, not just functions, because Tier 1B and Tier 3 depend on the harder selectors:
  - a function/class file, such as `src/git/executor.ts` or `src/git/operationSupport.ts`;
  - a type/interface-heavy file, such as `src/types.ts` or one `src/webviews/protocol/*.ts`, to confirm interface and type-alias contexts fire only on exported declarations (the `publicOnly` option does not restrict `contexts`);
  - one React file under `src/webviews/react/shared/**`, to confirm exported hooks are caught while local JSX components are not.
- Validate the React selector starting point: require docs on exported hooks (`FunctionDeclaration[id.name=/^use[A-Z]/]`) and exported props interfaces, and exclude inline components. Adjust before locking any React tier.

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run typecheck:webview
bun run react-doctor
bun run test:coverage
```

### Acceptance criteria

- Required-doc rules are scoped, not global.
- The pilot files pass with useful documentation.
- `lint:strict` remains green.
- The rule configuration is understood before expanding to larger directories.

### Suggested commit

```text
chore(tsdoc): scaffold documentation ratchet
```

## Phase 4: Tier 1A: Document and lock `src/git/**`

### Goal

Document the Git execution and operation layer first because it contains high-value contracts, command execution behavior, fallback behavior, and path safety assumptions.

### Scope

- `src/git/executor.ts`
- `src/git/numstat.ts`
- `src/git/operationSupport.ts`
- `src/git/operations.ts`
- `src/git/parsers.ts`
- `src/git/stashFiles.ts`
- `src/git/workingTree.ts`

### Documentation targets

- Exported classes.
- Exported functions.
- Public methods on exported classes.
- Exported types and interfaces.
- Error classes.
- Git command wrappers.
- Parsers and data transformation helpers.
- Private security helpers when behavior is non-obvious.

### Content to capture

- Which Git command or output format is wrapped.
- Whether failures are propagated, swallowed, transformed, or converted to fallback values.
- Whether inputs are repository-relative, workspace-relative, or absolute filesystem paths.
- Whether paths are sanitized.
- Whether command arguments use end-of-options protection.
- Whether behavior differs for empty repositories, staged files, unstaged files, remotes, stash entries, or branches.
- Whether user-facing warnings can be shown.

### Ratchet update

Add:

```js
"src/git/**/*.ts"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run build
bun run test:coverage
```

### Acceptance criteria

- All exported Git APIs have meaningful TSDoc.
- Security-sensitive helpers include contract or invariant docs.
- `src/git/**` is locked by ESLint.
- Validation passes.

### Suggested commit

```text
docs(tsdoc): document git contracts and lock ratchet
```

## Phase 5: Tier 1B: Document and lock protocol and shared type boundaries

### Goal

Document data contracts shared across the extension host and webviews.

### Scope

- `src/types.ts`
- `src/webviews/protocol/commitGraphTypes.ts`
- `src/webviews/protocol/commitInfoTypes.ts`
- `src/webviews/protocol/commitPanelMessages.ts`
- `src/webviews/protocol/mergeConflictSessionTypes.ts`
- `src/webviews/protocol/undockedMessages.ts`

### Documentation targets

- Exported message unions.
- Message discriminants.
- Payload interfaces.
- Shared domain types.
- Fields with special semantics.
- Fields that cross serialization boundaries.

### Content to capture

- Which side sends each message.
- Whether a message is a request, response, event, or command.
- Which fields are optional and why.
- Whether paths are absolute, workspace-relative, or repository-relative.
- Whether IDs are stable across refreshes.
- Whether values are display-only or actionable.
- Whether data originates from Git output.

### Ratchet update

Add:

```js
"src/types.ts",
"src/webviews/protocol/**/*.ts"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run test:coverage
```

### Acceptance criteria

- Cross-boundary message contracts are documented.
- Non-obvious payload fields have semantic docs.
- Protocol and shared type files are locked.

### Suggested commit

```text
docs(tsdoc): document webview protocol contracts
```

## Phase 6: Tier 1C: Document and lock `src/services/**`

### Goal

Document service-level APIs that coordinate Git, VS Code, filesystem, repository discovery, clone, publish, diff, askpass, and merge-tool workflows.

### Scope

- `src/services/cloneService.ts`
- `src/services/cloneUrl.ts`
- `src/services/diffService.ts`
- `src/services/gitAskpass.ts`
- `src/services/gitHelpers.ts`
- `src/services/jetbrainsMergeService.ts`
- `src/services/publishService.ts`
- `src/services/repositoryDiscovery.ts`

### Documentation targets

- Exported service classes.
- Exported functions.
- Constructors and dependency contracts.
- Public methods.
- Methods that show UI.
- Methods that call Git or touch filesystem paths.

### Content to capture

- What user workflow the service supports.
- Whether the method prompts, notifies, or supports cancellation.
- Whether errors are shown to the user or propagated.
- Whether a method mutates repository state.
- Whether the method is safe without an active workspace or repository.
- Which path format callers must provide.

### Ratchet update

Add:

```js
"src/services/**/*.ts"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run test:coverage
```

### Acceptance criteria

- Service contracts, UI side effects, and error behavior are documented.
- Service files are locked by ESLint.
- Validation passes.

### Suggested commit

```text
docs(tsdoc): document service contracts
```

## Phase 7: Tier 2A: Document and lock activation flow

### Goal

Document extension startup modes and command/view registration flows.

### Scope

- `src/extension.ts`
- `src/activation/common.ts`
- `src/activation/noRepositoryMode.ts`
- `src/activation/onboarding.ts`
- `src/activation/repositoryCommands.ts`
- `src/activation/repositoryMode.ts`
- `src/activation/repositoryViewEvents.ts`

### Documentation targets

- Extension activation entry points.
- Mode-specific setup functions.
- Command and provider registration functions.
- Event subscription helpers.
- Functions that create services, providers, and disposables.

### Content to capture

- When the function runs.
- Which VS Code activation mode it supports.
- What disposables it registers and who owns them.
- Whether it requires a repository or workspace.
- What side effects are expected.

### Ratchet update

Add:

```js
"src/extension.ts",
"src/activation/**/*.ts"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run build
bun run test:coverage
```

### Acceptance criteria

- Extension lifecycle behavior is documented.
- Registration side effects and disposable ownership are clear.
- Activation files are locked.

### Suggested commit

```text
docs(tsdoc): document extension activation flow
```

## Phase 8: Tier 2B: Document and lock commands

### Goal

Document command handlers and command context builders.

### Scope

- `src/commands/branchCommands.ts`
- `src/commands/commitActionContext.ts`
- `src/commands/commitBasicActions.ts`
- `src/commands/commitCommands.ts`
- `src/commands/commitHistoryActions.ts`

### Documentation targets

- Command registration functions.
- Command handlers.
- Context-building helpers.
- Functions that mutate Git state.
- Functions that show VS Code UI.

### Content to capture

- Which VS Code command or UI action is wired.
- What context is required.
- Whether the command refreshes views afterward.
- Whether errors are shown or propagated.
- Whether the operation modifies the working tree, index, branch, stash, or history.

### Ratchet update

Add:

```js
"src/commands/**/*.ts"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run test:coverage
```

### Acceptance criteria

- Command behavior, mutation, and refresh semantics are documented.
- Command files are locked.

### Suggested commit

```text
docs(tsdoc): document command handlers
```

## Phase 9: Tier 2C: Document and lock views

### Goal

Document VS Code view providers, panels, webview lifecycle, message validation, refresh behavior, and view-side actions.

### Scope

- `src/views/CommitGraphViewProvider.ts`
- `src/views/CommitInfoViewProvider.ts`
- `src/views/CommitPanelViewProvider.ts`
- `src/views/MergeConflictSessionPanel.ts`
- `src/views/MergeConflictsTreeProvider.ts`
- `src/views/OnboardingViewProvider.ts`
- `src/views/RefreshService.ts`
- `src/views/UndockedViewProvider.ts`
- `src/views/commitPanelActions.ts`
- `src/views/messageValidation.ts`
- `src/views/panelFileActions.ts`
- `src/views/shared/IconThemeService.ts`
- `src/views/shared/index.ts`
- `src/views/shared/themeListeners.ts`
- `src/views/webviewHtml.ts`

### Documentation targets

- View provider classes.
- Webview lifecycle methods.
- Message handlers and validators.
- Refresh and caching helpers.
- HTML generation helpers.
- Panel file action handlers.
- Shared view services.

### Content to capture

- Which VS Code view or panel is owned.
- When the webview is resolved.
- What messages are accepted or rejected.
- What state is cached.
- What refresh behavior is debounced or coalesced.
- How CSP and resource URIs are handled.
- Whether the provider assumes an active repository.

### Ratchet update

Add:

```js
"src/views/**/*.ts"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run build
bun run test:coverage
```

### Acceptance criteria

- View lifecycle and webview message contracts are documented.
- Refresh and caching behavior are clear.
- View files are locked.

### Suggested commit

```text
docs(tsdoc): document view provider contracts
```

## Phase 10: Tier 2D: Document and lock utilities, merge editor, and i18n support

### Goal

Document shared utilities, merge conflict parsing, and any localization helper code without changing localization behavior.

### Scope

- `src/utils/constants.ts`
- `src/utils/errors.ts`
- `src/utils/fileIconTheme.ts`
- `src/utils/fileOps.ts`
- `src/utils/gitRefs.ts`
- `src/utils/jetbrainsMergeTool.ts`
- `src/utils/languageAssociations.ts`
- `src/utils/notifications.ts`
- `src/mergeEditor/conflictParser.ts`
- `src/i18n/**` (currently no TypeScript files; no-op until populated)
- `src/webviews/i18n/**`

### Documentation targets

- Exported utilities.
- Error helpers.
- File operation helpers.
- Git reference helpers.
- Notification helpers.
- Merge conflict parser exports.
- Localization helper exports.

### Content to capture

- Whether helpers are pure or have side effects.
- Whether helpers touch the filesystem or VS Code UI.
- Whether paths are absolute, workspace-relative, or repository-relative.
- What parser input formats are expected.
- How malformed input is handled.
- Whether functions return fallback values.
- Whether static localization catalogs are involved.

### Localization caution

If this phase changes user-facing English strings, also run localization validation. Documentation-only edits should avoid changing runtime strings.

### Ratchet update

Add:

```js
"src/utils/**/*.ts",
"src/mergeEditor/**/*.ts",
// `src/i18n` currently contains no .ts files; include only if/when it does.
"src/webviews/i18n/**/*.ts"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck
bun run test:coverage
```

If user-facing strings changed:

```bash
bun run l10n:validate
bun run l10n:audit
```

### Acceptance criteria

- Utility contracts and parser behavior are documented.
- Localization workflow is not changed.
- Utility and merge editor files are locked.

### Suggested commit

```text
docs(tsdoc): document utilities and merge parser
```

## Phase 11: Tier 3A: Document React shared utilities and data/model code

### Goal

Start React webview documentation with high-signal logic rather than presentational noise.

### Scope

Prioritize:

- `src/webviews/react/shared/**`
- `src/webviews/react/branch-column/**`
- `src/webviews/react/commit-list/**`

### Documentation targets

- Exported hooks.
- Exported model builders.
- Exported utility functions.
- Exported types and interfaces crossing component boundaries.
- Non-obvious props interfaces.
- Canvas or rendering hooks with lifecycle constraints.

### Content to capture

- Whether a hook owns event listeners.
- Whether a hook reads or writes VS Code webview API state.
- Whether a helper mutates or returns new objects.
- Whether ordering is significant.
- Whether IDs are stable across refreshes.
- Whether path or ref parsing assumes Git formats.
- Whether memoization relies on stable object identity.
- Whether rendering depends on device pixel ratio, canvas size, or theme tokens.

### Ratchet update

Add narrow React globs first, for example:

```js
"src/webviews/react/shared/**/*.{ts,tsx}",
"src/webviews/react/branch-column/**/*.{ts,tsx}",
"src/webviews/react/commit-list/**/*.{ts,tsx}"
```

Use the React-specific contexts validated in Phase 3: require docs on exported hooks (`FunctionDeclaration[id.name=/^use[A-Z]/]`) and exported props interfaces/type aliases, and exclude inline JSX components so presentational code is not forced into noisy docs.

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck:webview
bun run react-doctor
bun run test:coverage
```

### Acceptance criteria

- React shared utilities and model logic are documented.
- Hooks with lifecycle or event behavior are documented.
- Presentational components are not forced into noisy docs.
- Locked React globs pass lint.

### Suggested commit

```text
docs(tsdoc): document webview shared logic
```

## Phase 12: Tier 3B: Document commit panel React logic

### Goal

Document the largest user-facing React feature area without adding boilerplate comments to every visual component.

### Scope

- `src/webviews/react/commit-panel/**`

### Documentation targets

- Exported hooks.
- File tree and data transformation helpers.
- Exported components with behavioral responsibilities.
- Props interfaces when fields have non-obvious behavior.
- Message-sending helpers.
- Selection, staging, and stash state logic.

### Content to capture

- Whether a component sends messages to the extension.
- Whether it owns keyboard shortcuts.
- Whether it controls staging or unstaging.
- Whether it depends on tree grouping.
- Whether it assumes stable file paths.
- Whether it works with stash state.
- Whether it owns local UI-only state.

### Ratchet update

Add:

```js
"src/webviews/react/commit-panel/**/*.{ts,tsx}"
```

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck:webview
bun run react-doctor
bun run test:coverage
```

### Acceptance criteria

- Commit panel hooks and state/model code are documented.
- Behavioral exported components are documented.
- Presentational-only components are not over-documented.
- Commit panel React files are locked.

### Suggested commit

```text
docs(tsdoc): document commit panel webview logic
```

## Phase 13: Tier 3C: Document remaining React apps and feature areas

### Goal

Finish React documentation for the remaining webview apps and feature directories.

### Scope

- `src/webviews/react/CommitInfoApp.tsx`
- `src/webviews/react/CommitGraphPanel.tsx`
- `src/webviews/react/CompactCommitGraphApp.tsx`
- `src/webviews/react/BranchColumn.tsx`
- `src/webviews/react/graph.ts`
- `src/webviews/react/merge-conflicts-session/**`
- Any remaining React files not covered by earlier phases.

### Documentation targets

- Top-level app components.
- Exported hooks.
- Data transformation helpers.
- Rendering and canvas logic.
- Merge conflict session behavior.
- Props and interfaces that cross component boundaries.

### Content to capture

- What extension messages initialize the app.
- What state is local versus extension-owned.
- What messages are posted back.
- How theme changes are handled.
- How graph or canvas rendering maps commits to visual layout.
- How merge conflict actions map to extension commands.

### Ratchet update

After this phase, React can be mostly locked:

```js
"src/webviews/react/**/*.{ts,tsx}"
```

Keep React-specific exceptions if needed to avoid forcing docs on trivial local JSX internals.

### Validation

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run typecheck:webview
bun run react-doctor
bun run build
bun run test:coverage
```

### Acceptance criteria

- Meaningful exported React APIs are documented.
- Top-level app responsibilities are clear.
- Graph, canvas, and merge-session logic have contract docs.
- React documentation linting is locked without forcing noisy internals.

### Suggested commit

```text
docs(tsdoc): document remaining webview apps
```

## Phase 14: Close the ratchet across `src/**`

### Goal

Make undocumented new exported APIs fail lint across the full source tree, with explicit exclusions only where justified.

### Tasks

- Replace piecemeal locked globs with full source coverage or keep a documented equivalent set of complete globs.
- Keep separate extension and React globs if plugin behavior requires different contexts.
- Document any intentional exclusions in `eslint.config.mjs` and in the TSDoc standard.
- Confirm React presentational noise remains controlled.

### Validation

Run the full standard validation set:

```bash
bun run deps:check:strict
bun run format:check
bun run lint:strict
bun run architecture:check
bun run react-doctor
bun run typecheck
bun run typecheck:webview
bun run build
bun run test:coverage
```

### Acceptance criteria

- Full source documentation ratchet is active or explicitly and completely scoped.
- New undocumented exported APIs fail lint.
- React presentational components are not over-enforced.
- Full validation passes.

### Suggested commit

```text
chore(tsdoc): close documentation ratchet
```

## Phase 15: Long-term governance

### Goal

Keep documentation useful after the rollout is complete.

### Tasks

- Add a contributor or PR checklist if the repo has a contributor workflow file.
- Add a reviewer checklist to the documentation standard.
- Include examples of good and bad comments.
- Periodically search for stale notes or deprecated behavior.

### Reviewer checklist

Reject comments that:

- Restate TypeScript types.
- Describe behavior that is no longer true.
- Say only "handles", "gets", "sets", or "returns" without adding contract value.
- Omit meaningful docs on exported boundary APIs.
- Add `@param` or `@returns` tags with no semantic content.

### Maintenance command examples

```bash
rg -n '@todo|TODO|FIXME|@deprecated|@remarks' src docs
bun run lint:strict
bun run typecheck
```

### Acceptance criteria

- Documentation expectations are visible to contributors and reviewers.
- The lint ratchet enforces minimum coverage.
- The standard keeps documentation high-signal.

### Suggested commit

```text
docs(tsdoc): add documentation review guidance
```

## Suggested PR sequence

| PR | Scope | Primary files |
| --- | --- | --- |
| 1 | House standard | `docs/TSDOC.md` |
| 2 | Syntax tooling | `package.json`, lockfile, `eslint.config.mjs` |
| 3 | Ratchet scaffold and pilot | `eslint.config.mjs`, one or two Git files |
| 4 | Git docs | `src/git/**` |
| 5 | Types and protocol docs | `src/types.ts`, `src/webviews/protocol/**` |
| 6 | Services docs | `src/services/**` |
| 7 | Activation docs | `src/extension.ts`, `src/activation/**` |
| 8 | Commands docs | `src/commands/**` |
| 9 | Views docs | `src/views/**` |
| 10 | Utilities, merge parser, i18n helpers | `src/utils/**`, `src/mergeEditor/**`, i18n helpers |
| 11 | React shared/model logic | `src/webviews/react/shared/**`, branch and commit-list model code |
| 12 | Commit panel React logic | `src/webviews/react/commit-panel/**` |
| 13 | Remaining React apps | remaining `src/webviews/react/**` |
| 14 | Close ratchet | final `eslint.config.mjs` coverage |
| 15 | Governance polish | PR checklist or contributor docs |

## Definition of done for the whole rollout

The rollout is complete when:

- The TSDoc standard is documented and discoverable.
- TSDoc syntax validation runs on TS and TSX files.
- Required documentation linting covers completed source areas.
- Exported boundary APIs have meaningful comments.
- React presentational noise is avoided.
- Full source documentation ratchet is active or explicitly scoped with documented exclusions.
- `bun run deps:check:strict` (knip) passes.
- `bun run typecheck` passes.
- `bun run lint:strict` passes.
- `bun run architecture:check` passes.
- `bun run test:coverage` passes (coverage ratchet held).
- `bun run build` passes.
- Documentation comments explain contracts and invariants rather than repeating types.
