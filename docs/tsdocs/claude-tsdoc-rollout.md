# TSDoc Documentation Rollout — Finalized Plan

Status: proposed (not started)
Owner: Mahesh Kokare
Scope: `src/**` (133 TS/TSX files, ~23k LOC)

This plan fuses two proposals: a content standard (what each comment should
contain, by function type) and an enforcement mechanism (how the standard is
rolled out and kept true by CI). The content standard answers "what to write";
the enforcement layer answers "how to make it stick" in a repo that already
gates everything machine-checkable (coverage ratchet, knip, dependency-cruiser,
`lint:strict --max-warnings=0`).

## Goal and non-goals

- Goal: every cross-boundary and exported symbol carries an intent-bearing TSDoc
  comment, enforced by CI so it cannot regress.
- Non-goals: type-restating noise, comment-every-line, a published API site, or
  documenting all React presentational components.

## Decisions locked

| Axis | Decision |
|---|---|
| Scope + enforcement | Tiered ratchet: boundaries first, React = headers/hooks only |
| Enforcement plugins | `eslint-plugin-jsdoc` (presence) + `eslint-plugin-tsdoc` (syntax) |
| Content standard | Verbosity matrix (Purpose-only / Balanced / LLM-first) + six rules |
| Rollout | Tier order for locking, feature-area batching within a tier |
| Localization guard | Run `l10n:validate` / `l10n:audit` if a batch touches user-facing strings |
| TypeDoc | No. Revisit in Phase 4 only if a contributor site is wanted |

## Current state (measured)

| Metric | Value |
|---|---|
| TS/TSX files in `src` | 133 (~23,189 LOC) |
| Files with any `/**` block | 20 |
| Files with `@param` / `@returns` / `@throws` | 0 |
| Exported symbols (fn/class/const/interface/type/enum) | ~393 |
| Doc tooling installed | none |

Directory distribution: `webviews/` 82 files / 11.0k LOC (React); `views/`
15 / 3.5k; `services/` 8 / 2.7k; `utils/` 8 / 1.4k; `git/` 6 / 1.2k;
`activation/` 6 / 1.4k; `commands/` 5 / 1.4k; `mergeEditor/` 1 / 0.44k.

## Layer 1 — Content standard (lives in `docs/TSDOC.md`)

Authoring depth by symbol type:

| Symbol | Depth |
|---|---|
| Exported functions / classes / hooks | Balanced: summary plus non-obvious behavior; `@param`/`@returns` only when not obvious from the type |
| Simple private helpers | Purpose-only: one sentence |
| Complex private helpers | Balanced |
| Security / path-validation / Git-command boundaries | LLM-first: intent, invariants, `@throws` |
| React render-only components | Purpose-only or Balanced |
| Algorithms / tree builders / parsers / graph code | Balanced or LLM-first |
| Type aliases / interfaces | Short TSDoc only when meaning is not obvious |

Six rules:

1. Use JSDoc/TSDoc block comments, not Python-style string docstrings.
2. Do not repeat obvious TypeScript types. Explain meaning, constraints, side
   effects, and intent instead.
3. Always document non-obvious behavior: swallowed errors, error-to-fallback
   conversion, state mutation, VS Code API calls, Git command execution, input
   sanitization, repo-relative path assumptions, memoization, performance, and
   localization implications.
4. Keep the first sentence searchable: state plainly what the symbol does.
5. Use `@throws` only when the caller needs to know.
6. Do not document every internal line. The goal is function-level readability,
   not duplicating the implementation.

Default template:

```ts
/**
 * One-sentence summary in present tense.
 *
 * Optional paragraph for non-obvious behavior: side effects, fallbacks,
 * Git/VS Code interactions, memoization, security constraints, invariants.
 *
 * @param name - Meaning, constraints, or expected format (omit if obvious).
 * @returns Meaning when not obvious from the type.
 * @throws Error when callers must handle or understand the failure.
 */
```

Worked example (security boundary, LLM-first depth):

```ts
/**
 * Validates and normalizes a repository-relative Git path.
 *
 * Rejects absolute paths, control characters, empty paths, root paths, and
 * parent-directory traversal so file operations stay scoped to the repository.
 *
 * @param filePath - Path expected to be relative to the repository root.
 * @returns Normalized slash-separated repository-relative path.
 * @throws Error when the path is unsafe or cannot identify a repo-relative file.
 */
function assertRepoRelativeGitPath(filePath: string): string {
    // ...
}
```

This layer is enforced at review time. A linter cannot judge whether a
security-sensitive function received the depth it warrants.

## Layer 2 — Enforcement floor (lint)

Enforced at CI time and `--max-warnings=0`-safe (all rules are `error`,
glob-scoped). Calibration: enforce presence plus a real description, and never
force `@param`/`@returns` (that is what produces type-restating filler). Let
`tsdoc/syntax` own tag validation; disable `jsdoc/check-tag-names` so the two
plugins do not conflict.

```js
// eslint.config.mjs — new block; the files glob widens each phase.
settings: { jsdoc: { mode: "typescript" } },
rules: {
  "jsdoc/require-jsdoc": ["error", {
    publicOnly: true,
    require: { FunctionDeclaration: true, MethodDefinition: true, ClassDeclaration: true },
    contexts: ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration",
               "ExportNamedDeclaration > VariableDeclaration"],
    enableFixer: false,
  }],
  "jsdoc/require-description": "error",
  "jsdoc/check-param-names": "error",   // catches param-name drift
  "jsdoc/no-types": "error",            // no redundant types in comments
  "jsdoc/require-param": "off",
  "jsdoc/require-returns": "off",
  "jsdoc/check-tag-names": "off",       // tsdoc/syntax owns tag validation
}
```

`tsdoc/syntax: "error"` is applied globally from Phase 0. It is cheap: there are
~50 existing blocks to validate, and none currently use `@param`/`@returns`, so
they are plain descriptions and almost all are already valid TSDoc.

## Layer 3 — The ratchet

The `require-jsdoc` block's `files` glob starts at Tier 1 and widens one
directory at a time. A directory is "done" only when its glob is in the config
and `lint:strict` passes. New undocumented exports in a locked directory fail CI
automatically. No global warnings are ever introduced, so the existing green CI
never breaks during the rollout.

## Tier breakdown and batching

| Tier | Globs (lock order) | Batches within tier | Depth bias |
|---|---|---|---|
| 1 — Boundaries | `src/types.ts`, `src/webviews/protocol/**`, `src/git/**`, `src/services/**` | (1) Git executor + operations, (2) merge/conflict, (3) services | LLM-first on `git/operations.ts` security invariants (end-of-options, ReDoS); Balanced elsewhere |
| 2 — Extension internals | `src/activation/**`, `src/commands/**`, `src/views/**`, `src/utils/**`, `src/mergeEditor/**` | (4) view providers, (5) commands, (6) activation, (7) utils | Balanced |
| 3 — React webview | `src/webviews/react/**` | shared utils, then commit-panel hooks, then commit-graph, then rest | `require-jsdoc` contexts scoped to exported hooks (`FunctionDeclaration[id.name=/^use[A-Z]/]`) plus props interfaces and type aliases only; inline JSX components excluded (file-header plus review, not lint) |
| 4 — Close | glob = `src/**` | — | Ratchet closed; optional TypeDoc revisit |

## Per-phase loop (per directory)

1. Author docs to the Layer 1 standard.
2. Run the `code-reviewer` agent on the diff (per project `.claude/CLAUDE.md`).
3. Widen the `require-jsdoc` glob to include the directory.
4. Run `bun run typecheck && bun run lint:strict`; both must be green.
5. Localization tripwire: doc comments must not alter user-facing strings. If a
   batch incidentally touches them, run `bun run l10n:validate && bun run l10n:audit`.
6. Run `gitnexus_detect_changes()` to confirm no symbol or flow drift. Doc-only
   changes should produce none.
7. Commit: `docs(tsdoc): document <dir> + lock lint`.

## Phases

- Phase 0 — Foundation. Write `docs/TSDOC.md` (Layer 1). Install both plugins and
  verify ESLint 10 compatibility (the main tooling risk: `eslint-plugin-jsdoc`
  and `eslint-plugin-tsdoc` against ESLint `^10`). Add the Layer 2 block with a
  Tier 1 glob and global `tsdoc/syntax`. Fix any existing malformed blocks.
  Confirm CI green.
- Phases 1 to 3 — Author and lock each tier per the loop above.
- Phase 4 — Set glob to `src/**`; ratchet closed. Add TypeDoc only if contributor
  docs are later wanted.

No timeline estimates. The unit of progress is one directory authored and locked.

## Governance and gates

- Project rules: `code-reviewer` after edits, `security-reviewer` before commit
  (Tier 1 triggers it), `gitnexus_detect_changes()` before commit. Doc-only diffs
  are low blast-radius, but the gates run regardless.
- Verification per phase: `bun run typecheck && bun run lint:strict` stay green.

## Risks and edge cases

- ESLint 10 plugin compatibility. Gate in Phase 0 before any authoring.
- jsdoc / tsdoc tag-name conflict. Mitigated by disabling `jsdoc/check-tag-names`
  and letting `tsdoc/syntax` own tag validation.
- Existing `/**` blocks failing `tsdoc/syntax`. Fix in Phase 0.
- React component detection. `require-jsdoc` cannot reliably distinguish a
  component from a plain function by AST, so Tier 3 enforces only exported hooks
  and props types via lint; component-level and file-header coverage is a review
  convention.

## Rejected alternatives

- Convention-only, reviewer-enforced documentation (no lint gate). In a repo that
  already ratchets coverage and gates knip, dependency-cruiser, and zero-warning
  lint, an unenforced doc standard would drift exactly like untested code. It is
  the one element not carried forward; everything else from both proposals is
  folded into the layers above.
- TypeDoc / published API site. This is a VS Code extension consumed as a `.vsix`,
  not an imported library, so a generated API site has no real audience. The
  payoff (editor hover tooltips, captured contracts) comes from the comments
  themselves. Reversible; can be added in Phase 4 if a contributor reference is
  wanted.
