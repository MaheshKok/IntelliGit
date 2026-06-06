# IntelliGit TSDoc Guide

This guide defines the house style for TSDoc comments in IntelliGit. The goal is to document contracts, invariants, and maintenance hazards that TypeScript types do not express. Comments should help a maintainer understand how to safely change code, not restate the code in prose.

## Scope

Use TSDoc-style block comments for exported and boundary-facing TypeScript/TSX symbols in `src`:

- exported functions, classes, interfaces, type aliases, enums, and constants;
- VS Code activation, provider, service, and Git-operation boundaries;
- webview protocol messages and host/webview bridge contracts;
- React hooks and utilities whose behavior depends on lifecycle, persistence, or browser/VS Code APIs;
- security-sensitive helpers, path validation, command construction, credential handling, and file-system operations.

Do not document every private helper by default. Add comments to private helpers only when the behavior is non-obvious, security-sensitive, lifecycle-sensitive, or easy to misuse.

## Standard block template

```ts
/**
 * Short one-sentence summary of the symbol's contract or responsibility.
 *
 * Optional paragraph for non-obvious behavior: side effects, fallback behavior,
 * lifecycle assumptions, ordering constraints, security invariants, Git command
 * semantics, VS Code API interactions, or webview messaging contracts.
 *
 * @param name - Include only when the meaning, format, unit, or constraint is not obvious.
 * @returns Include only when the return value has non-obvious semantics or fallback behavior.
 * @throws Include when callers need to understand or handle the failure mode.
 * @remarks Include long-lived design intent, invariants, or maintenance warnings.
 * @example Include only when usage is non-obvious or easy to misuse.
 * @deprecated Include when callers need a migration path and removal expectations.
 */
```

A good summary states the contract, not the implementation detail. Prefer “Builds a Git argument list that treats branch names as data after `--end-of-options`” over “Builds Git args.”

## Tag guidance

### `@param`

Use `@param` when a parameter has constraints that are not obvious from its TypeScript type.

Good:

```ts
/**
 * Opens a repository-relative file diff from a commit context menu action.
 *
 * @param filePath - Repository-relative path from Git output; must already be
 * validated before this function invokes VS Code file APIs.
 */
```

Avoid:

```ts
/**
 * Opens a file diff.
 *
 * @param filePath - The file path.
 */
```

### `@returns`

Use `@returns` when the return value carries fallback, sentinel, or ordering semantics.

Good:

```ts
/**
 * Finds the active repository root that should back the IntelliGit views.
 *
 * @returns The selected root, or `undefined` when no workspace folder resolves to
 * a Git repository that IntelliGit should manage.
 */
```

Avoid `@returns` when the type already says everything, such as returning `Promise<void>` after a self-explanatory command handler.

### `@throws`

Use `@throws` when callers must know which failures are surfaced instead of swallowed.

Good:

```ts
/**
 * Validates that a path stays inside the selected repository.
 *
 * @throws When the path is absolute, escapes the repository with `..`, or uses a
 * Git path form that cannot be safely mapped to a workspace file.
 */
```

Do not use `@throws` for every possible unexpected runtime error. Document the intentional failure contract.

### `@remarks`

Use `@remarks` for long-lived design intent, sequencing, security invariants, or maintenance warnings.

Good:

```ts
/**
 * Publishes a local branch to a newly created remote repository.
 *
 * @remarks Prefer SecretStorage, askpass, or other transient credential handoff.
 * If a provider flow must temporarily use a credential-bearing remote URL, reset
 * it in a `finally` block so tokens are not left in `.git/config` when cleanup
 * succeeds. Do not move the cleanup behind a success-only branch.
 */
```

### `@example`

Use `@example` only when usage is easy to misuse and a short snippet prevents mistakes.

Good:

```ts
/**
 * Builds the payload sent from the extension host to a merge webview.
 *
 * @example
 * ```ts
 * postToWebview({ type: "update", files, selectedPath });
 * ```
 */
```

Avoid examples that duplicate nearby tests or show obvious one-line function calls.

### `@deprecated`

Use `@deprecated` only when a symbol remains temporarily available and callers need a migration path.

Good:

```ts
/**
 * Reads the legacy persisted panel width value.
 *
 * @deprecated Use `readPersistedColumnWidths` so all three undocked panes restore
 * from one validated workspace-state payload.
 */
```

A `@deprecated` comment must explain what to use instead. Do not mark symbols deprecated without a replacement or removal plan.

## What to document

Good IntelliGit documentation explains at least one of these:

- repository, path, or Git-ref safety constraints;
- Git command ordering or output format assumptions;
- VS Code lifecycle behavior, disposables, or workspace-state persistence;
- host-to-webview or webview-to-host message contracts;
- UI behavior that intentionally follows JetBrains/PyCharm conventions;
- fallback behavior, swallowed errors, or user-visible error transformations;
- security invariants around credentials, filesystem access, and command arguments;
- React lifecycle assumptions, jsdom limitations, or browser API guards;
- why a value is cached, debounced, clamped, or invalidated.

## What not to document

Avoid type-restating comments and other type repetition that only repeat names or TypeScript types:

- “Gets the branch.”
- “Handles the event.”
- “The string path.”
- “Returns the result.”
- “Component for rendering UI.”
- `@param count - The count.`
- `@returns A promise.`

If the comment can be generated from the signature alone, delete it or replace it with contract information that a reviewer cannot infer from the type.

## Examples by IntelliGit area

### Git operations

```ts
/**
 * Builds the argument list for reading a commit-scoped file patch.
 *
 * Branches, revisions, and paths must be separated with `--end-of-options` and
 * `--` so a user-controlled ref or filename cannot be interpreted as a Git flag.
 *
 * @param filePath - Repository-relative Git path, including literal pathspec-like
 * names such as `:(glob)*`; do not pre-expand or normalize as a pathspec.
 */
export function buildCommitFilePatchArgs(commitHash: string, filePath: string): string[];
```

This comment documents the Git command invariant and security boundary. It does not restate that `commitHash` and `filePath` are strings.

### Path validation

```ts
/**
 * Converts a webview-provided file path into the repository-relative form used by Git.
 *
 * Whitespace-only values are treated as missing input, but valid paths are returned
 * unchanged so filenames that intentionally contain leading or trailing spaces still work.
 *
 * @throws When the path escapes the repository root or cannot be represented as a
 * safe repository-relative path.
 */
function getFilePath(message: unknown): string | null;
```

Document both the rejection rule and the preservation rule; both matter for future edits.

### VS Code services

```ts
/**
 * Registers repository commands for a workspace that already has an active Git root.
 *
 * Command handlers in this path may use `gitOps`, `repoRoot`, and `context.secrets`.
 * Keep command IDs mirrored with the no-workspace and no-repository registration
 * paths so Command Palette entries never appear without a handler.
 */
function registerRepositoryCommands(...args: unknown[]): void;
```

This comment captures an activation-path invariant that TypeScript cannot enforce.

### Webview protocol types

```ts
/**
 * Message sent by the merge conflict session webview when the user accepts one side.
 *
 * `filePath` is untrusted webview input. The extension host must validate it before
 * invoking Git or filesystem operations, and must ignore missing paths without
 * surfacing a noisy error to the user.
 */
export interface AcceptConflictSideMessage {
    type: "acceptYours" | "acceptTheirs";
    filePath?: string;
}
```

Protocol comments should make trust boundaries explicit.

### React hooks

```ts
/**
 * Persists undocked column widths after drag interactions settle.
 *
 * The debounce avoids writing `workspaceState` for every mousemove. Restored values
 * must be clamped before use because old state can outlive min/max layout changes.
 */
function usePersistedColumnWidths(...args: unknown[]): void;
```

Hook comments should describe lifecycle, cleanup, debounce, and persistence behavior instead of saying the hook “manages state.”

### Utilities

```ts
/**
 * Extracts a concise user-facing message from an unknown error value.
 *
 * Prefer structured provider error messages when present, then fall back to a short
 * string representation so raw Git, HTTP, or stack output does not leak into UI prompts.
 */
export function getErrorMessage(error: unknown): string;
```

Utility comments are useful when they explain normalization, fallback, or user-facing constraints.

## Review checklist

Before adding or approving a TSDoc block, check:

- Does the first sentence state the symbol's contract or responsibility?
- Does the comment explain at least one non-obvious behavior, invariant, side effect, or failure mode?
- Are `@param` and `@returns` omitted when they only repeat TypeScript types?
- Are security boundaries, Git argument ordering, path formats, or webview trust boundaries explicit where relevant?
- Does `@throws` describe intentional failure behavior rather than every possible runtime exception?
- Does `@remarks` capture durable design intent rather than temporary implementation notes?
- Is any example short, realistic, and hard to misuse?
- Would this comment still be useful after a small refactor?

## Rollout rule

Required-documentation linting now covers the documented source tree through two
complete scoped ratchets: extension-host/shared TypeScript uses `src/**/*.ts`
with React webview files excluded from that block, and React webview TS/TSX uses
`src/webviews/react/**/*.{ts,tsx}` with React-specific selectors. Keep those
blocks separate so JSX parser settings remain correct and presentational React
components are not over-enforced; exported React hooks, protocol/model types, and
other meaningful boundary APIs still need high-signal comments.

When adding a new source area, first document its exported boundary APIs, then
confirm the relevant ratchet block already covers it or extend the scoped glob in
the same change. Do not weaken the ratchet to land undocumented exports.
