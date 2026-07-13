# Branch Reset Modes Design

## Goal

Let users reset the current branch to a selected commit with Git's five reset modes: soft, mixed, hard, merge, and keep.

## Scope

- Keep the existing commit context action as the single entry point.
- Show a mode picker, then a mode-specific modal confirmation.
- Execute `git reset --<mode> <validated-hash>`.
- Reuse existing validation, error reporting, and full-view refresh behavior.
- Add localized picker labels, descriptions, confirmation messages, and success feedback.

Out of scope: path-limited reset, recursive-submodule controls, reset options beyond the five modes, and new branch-menu actions.

## User Flow

1. The user selects **Reset Current Branch to Here** for a commit.
2. A Quick Pick presents Soft, Mixed, Hard, Merge, and Keep with concise effects.
3. A modal confirmation names the selected commit and mode.
4. On confirmation, IntelliGit runs the selected reset mode using the already validated hash.
5. IntelliGit shows success or the Git error, then refreshes all repository views.

## Safety Contract

| Mode | Git command | Confirmation emphasis |
| --- | --- | --- |
| Soft | `reset --soft <hash>` | Moves branch and keeps index and working tree. |
| Mixed | `reset --mixed <hash>` | Resets index and keeps working-tree changes. |
| Hard | `reset --hard <hash>` | Discards index and working-tree changes. |
| Merge | `reset --merge <hash>` | Preserves non-overlapping local changes; Git rejects conflicts. |
| Keep | `reset --keep <hash>` | Preserves local changes; Git rejects overwrite risk. |

Hard remains the only mode whose message says uncommitted changes are permanently discarded. Git remains authoritative for merge/keep conflict detection; IntelliGit must surface its error unchanged through the existing safe error formatter.

## Implementation Shape

- Replace the hard-reset-specific command helper with a mode-aware helper in `src/commands/commitBasicActions.ts`.
- Define a closed reset-mode union and picker metadata in the same module; no new abstraction is needed.
- Keep the existing action ID and host/webview protocol unchanged because the picker is entirely host-side.
- Add catalog strings to the localization CSV and regenerate catalogs through `bun run l10n:import`.

## Acceptance Criteria

- Every mode produces the exact corresponding `git reset` arguments.
- Cancelling either picker or confirmation invokes no Git command and performs no refresh.
- A successful reset posts the existing success feedback and refreshes views once.
- A failed reset posts the existing error feedback and still refreshes views once.
- The picker and confirmations are localized and the localization pipeline validates.
