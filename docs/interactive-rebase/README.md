# Interactive Rebase

IntelliGit offers PyCharm-style **Interactively Rebase from Here...** on any commit in the
commit graph. Picking it opens a dialog listing every commit from that point up to `HEAD`,
oldest first, where each commit gets an action (`pick`, `reword`, `squash`, `fixup`, `drop`)
and the whole list can be reordered. Submitting runs one real `git rebase -i` — IntelliGit
does not reimplement the rebase, it drives Git's own sequencer.

This document covers the dialog, the editor helper that Git executes, where session state
lives, and what happens when a rebase stops, is abandoned, or the window reloads.

## The dialog

Rows are shown in Git's todo order (oldest at the top), which is the reverse of the graph.
Beyond the per-row action selector, the dialog:

- Warns when the offered range contains commits that are already pushed, because rewriting
  them means the branch will need a force push.
- Prefills the message editor for `reword`, and for `squash` prefills the folded message of
  the entry it will merge into — the nearest preceding entry that still owns a message
  (`fixup` and `drop` entries are skipped, since a fixup discards its own message and a
  dropped commit produces none). Edits you make by hand are preserved across reorders; an
  untouched prefill is recomputed.
- Refuses to submit while any `reword` or `squash` row has a blank message, and marks every
  offending row rather than only the first.
- Clears an action that would land first in the todo — Git cannot squash or fixup into a
  commit that does not exist — and shows a notice explaining the change.

## The editor helper

Git drives interactive rebase by opening an editor. IntelliGit ships a standalone helper,
`dist/interactive-rebase-editor-helper.cjs`, and points `GIT_SEQUENCE_EDITOR` and
`GIT_EDITOR` at it for the duration of the rebase. It is a separate bundle from the
extension host on purpose: it runs `main()` on import, so the host must never import it.
The pure command builders live in `editorCommand.ts` instead.

The helper is invoked as `<role> <sessionDirectory> <editorPath>` and has two roles:

- **`sequence`** — writes the todo IntelliGit generated over the file Git supplied, then
  writes a session marker into Git's `rebase-merge` directory recording which session owns
  this rebase.
- **`message`** — injects one prepared `reword`/`squash` message. Before it writes anything
  it checks that the live `rebase-merge` marker matches this session, resolves which step
  Git is actually on (from Git's `done` log, falling back to its `msgnum` counter), and
  confirms the step's action matches what was prepared for that commit. Each message is
  consumed exactly once, guarded by an atomic `wx` create of a marker file, so a retried or
  re-entered step cannot silently reuse a message.

Anything uncertain is a refusal, not a guess. The helper writes a single machine-readable
token to stderr (`intelligit-rebase-editor: <reason>`) and exits non-zero, which stops the
rebase — Git alone would only report a generic "editor failed".

## Session state and reconciliation

Each submission gets a directory under the extension's global storage holding the generated
todo, the prepared messages, and a manifest. The manifest's lifecycle moves through
`starting` → `running` → `paused` → `done`.

Because a rebase can outlive the window, IntelliGit reconciles persisted sessions against
the repository on reload. It reads the marker and the live Git state first, then classifies
each manifest as:

- **`owned`** — this session started the rebase currently in progress, so IntelliGit may
  offer continue/abort controls for it.
- **`discard`** — the session is finished or superseded and its directory can be swept.
- **`ambiguous`** — the evidence does not support acting. The reason is recorded rather than
  guessed at: `manifest-missing`, `rebase-directory-present`,
  `rebase-directory-correlation-failed`, `branch-unavailable-or-moved`, `head-unavailable`,
  `head-moved`, or `pending-push-retained`.

Ambiguous is the default when a Git probe fails, so an unreadable repository never turns
into a destructive action.

A rebase IntelliGit did not start is classified `foreign`: the controls stay visible so the
repository state is not hidden, but IntelliGit will not drive someone else's rebase.

## After the rebase

When a completed rebase rewrote commits that were already pushed, IntelliGit offers a force
push for the affected branch. The offer is a retained manifest, not a transient toast — it
survives a reload, and it is only shown while the rewritten `HEAD` is still the one the
rebase produced. Dismissing it marks the manifest `done` and removes it; if removal fails
the manifest is restored, so a dismissal that did not persist does not silently vanish.

Abort and continue are dispatched from a single classification of what Git is actually
doing (`merge`, `cherry-pick`, `revert`, `rebase`, or none), so the button that says "Abort"
runs the abort command for the operation that is really in progress. This matters more than
it sounds: Git leaves `REBASE_HEAD` behind after a rebase completes, and probing for markers
independently made a later, unrelated merge conflict look like a rebase.

## Platform notes

- The helper is a `.cjs` bundle executed by Node, invoked through the command IntelliGit
  builds for `GIT_SEQUENCE_EDITOR` / `GIT_EDITOR`. Quoting of that command is
  platform-sensitive; **Windows editor invocation is the release gate for this feature** and
  must be verified on Windows before shipping.
- Everything else here is covered by the automated suites, including real-Git integration
  tests that run actual rebases in temporary repositories.
